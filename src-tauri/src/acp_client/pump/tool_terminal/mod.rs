//! Client-owned ACP terminals. Agent-owned processes never enter this path.
mod command;
mod process;

use self::{command::ReviewedCommand, process::Process};
use super::*;
use agent_client_protocol::{Error, schema::v1 as wire};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::json;
use std::path::PathBuf;

const MAX_ENTRIES: usize = 8;
pub(super) const CREATE: &str = "terminal/create";
pub(super) const OUTPUT: &str = "terminal/output";
pub(super) const KILL: &str = "terminal/kill";
pub(super) const RELEASE: &str = "terminal/release";
pub(super) const WAIT: &str = "terminal/wait_for_exit";
const ALLOW: &str = "allow_once";
const DENY: &str = "reject_once";
const STOP_UNKNOWN: &str = "无法确认所运行的命令已经结束";

#[derive(Default)]
pub(crate) struct Connection {
    state: Mutex<ConnectionTerminals>,
    pub(crate) enabled: AtomicBool,
    recovery_dir: std::sync::OnceLock<PathBuf>,
}

#[derive(Default)]
struct ConnectionTerminals {
    closed: bool,
    processes: Vec<Arc<Process>>,
}

impl Connection {
    pub(crate) fn enable(&self, recovery_dir: PathBuf) {
        if self.recovery_dir.set(recovery_dir).is_ok() {
            self.enabled.store(true, Ordering::SeqCst);
        }
    }

    fn launch(&self, command: std::process::Command, limit: usize) -> Result<Arc<Process>, Error> {
        let mut state = self.state.lock().map_err(|_| Error::internal_error())?;
        if state.closed {
            return Err(Error::request_cancelled());
        }
        state.processes.retain(|process| !process.finished());
        let process = Arc::new(
            Process::spawn(command, limit, self.recovery_dir.get().cloned())
                .map_err(|_| Error::internal_error())?,
        );
        state.processes.push(process.clone());
        Ok(process)
    }

    pub(crate) async fn close(&self) -> Result<(), String> {
        let processes = {
            let mut state = self.state.lock().map_err(|_| STOP_UNKNOWN.to_string())?;
            state.closed = true;
            for process in &state.processes {
                process.request_stop();
            }
            state.processes.clone()
        };
        let mut unconfirmed = false;
        for process in processes {
            unconfirmed |= process.wait_for_group().await.is_err();
        }
        if unconfirmed {
            Err(STOP_UNKNOWN.to_string())
        } else {
            Ok(())
        }
    }
}

struct Terminal {
    receipt: u64,
    process: Arc<Process>,
}

#[derive(Default)]
struct Gate {
    active: Option<(u64, super::super::process::PromptObservation)>,
    pending: Option<u64>,
    uncertain: bool,
    terminals: HashMap<String, Terminal>,
}

pub(super) struct Session {
    cwd: PathBuf,
    gate: Arc<Mutex<Gate>>,
    callbacks: Arc<tokio::sync::Semaphore>,
}

pub(super) struct HeldTurn {
    outcome: prompt::Outcome,
    processes: Vec<Arc<Process>>,
}

impl Session {
    pub(super) fn new(cwd: &str) -> Self {
        Self {
            cwd: cwd.into(),
            gate: Arc::default(),
            callbacks: Arc::new(tokio::sync::Semaphore::new(16)),
        }
    }

    pub(super) fn blocked(&self) -> bool {
        self.gate.lock().map_or(true, |gate| gate.uncertain)
    }

    pub(super) fn begin(
        &self,
        receipt: u64,
        observation: super::super::process::PromptObservation,
    ) {
        if let Ok(mut gate) = self.gate.lock() {
            gate.active = Some((receipt, observation));
        }
    }

    pub(super) fn stopping_possible(&self, receipt: u64) -> bool {
        self.gate.lock().is_ok_and(|gate| {
            gate.active
                .as_ref()
                .is_some_and(|active| active.0 == receipt)
                || gate
                    .terminals
                    .values()
                    .any(|terminal| terminal.receipt == receipt && !terminal.process.finished())
        })
    }

    fn seal(&self) {
        if let Ok(mut gate) = self.gate.lock() {
            gate.active = None;
            gate.pending = None;
        }
    }

    pub(super) fn stop(&self) {
        if let Ok(mut gate) = self.gate.lock() {
            gate.active = None;
            gate.pending = None;
            for terminal in gate.terminals.values() {
                terminal.process.request_stop();
            }
        }
    }

    pub(super) async fn next_turn(
        &self,
        inbox: &mut mpsc::UnboundedReceiver<prompt::Outcome>,
        held: &mut Option<HeldTurn>,
    ) -> Option<prompt::Outcome> {
        if held.is_none() {
            let outcome = inbox.recv().await?;
            self.seal();
            let processes = self
                .gate
                .lock()
                .ok()?
                .terminals
                .values()
                .filter(|terminal| terminal.receipt == outcome.receipt_id)
                .map(|terminal| terminal.process.clone())
                .collect();
            *held = Some(HeldTurn { outcome, processes });
        }
        let mut uncertain = false;
        for process in &held.as_ref()?.processes {
            uncertain |= process.wait_for_group().await.is_err();
        }
        let HeldTurn { mut outcome, .. } = held.take()?;
        if uncertain {
            if let Ok(mut gate) = self.gate.lock() {
                gate.uncertain = true;
            }
            outcome.result = Err(STOP_UNKNOWN.into());
        }
        Some(outcome)
    }

    fn create(&self, ctx: &mut DispatchContext<'_>, raw: Value, responder: Responder<Value>) {
        let Some(command) = ReviewedCommand::from_request(raw, ctx.session_id, &self.cwd) else {
            let _ = responder.respond_with_error(Error::invalid_params());
            return;
        };
        let Some(receipt) = self.gate.lock().ok().and_then(|mut gate| {
            let (receipt, observation) = gate.active.as_ref()?;
            if gate.pending.is_some()
                || gate.terminals.len() >= MAX_ENTRIES
                || !observation.unresolved()
            {
                return None;
            }
            let receipt = *receipt;
            gate.pending = Some(receipt);
            Some(receipt)
        }) else {
            let _ = responder.respond_with_error(Error::request_cancelled());
            return;
        };
        let request_id = next_request_id();
        let owner = json!({
            "connectionId": ctx.ops.connection_id, "sessionId": ctx.session_id, "requestId": request_id,
        });
        let (send, receive) = oneshot::channel();
        let lease = ctx.ops.life.work();
        let (cancelled, completed) = observe_cancellation(&responder, &request_id, ctx.expirations);
        let pending = PendingPermission {
            responder: None,
            local_decision: Some(send),
            cancelled: cancelled.clone(),
            _completed: completed,
            session_id: ctx.session_id.into(),
            owner: owner.clone(),
            options: vec![ALLOW.into(), DENY.into()],
            lease: match lease {
                Ok(lease) => lease,
                Err(_) => {
                    if let Ok(mut gate) = self.gate.lock()
                        && gate.pending == Some(receipt)
                    {
                        gate.pending = None;
                    }
                    let _ = responder.respond_with_error(Error::request_cancelled());
                    return;
                }
            },
        };
        if let Ok(mut map) = ctx.pending.lock() {
            map.insert(request_id.clone(), pending);
        } else {
            if let Ok(mut gate) = self.gate.lock()
                && gate.pending == Some(receipt)
            {
                gate.pending = None;
            }
            let _ = responder.respond_with_error(Error::internal_error());
            return;
        }
        ctx.permission_ids.push(request_id.clone());
        let review = command.review();
        let gate = self.gate.clone();
        let life = ctx.ops.life.clone();
        let terminal_id = request_id.clone();
        super::super::manager::runtime().spawn(async move {
            let allowed = receive.await.unwrap_or(false);
            let receipt_gate = gate.clone();
            let launch_cancelled = cancelled.clone();
            let launch = tokio::task::spawn_blocking(move || {
                let limit = command.output_limit;
                let prepared = allowed.then(|| command.into_process_command()).flatten();
                let mut gate = gate.lock().map_err(|_| Error::internal_error())?;
                if gate.pending == Some(receipt) {
                    gate.pending = None;
                }
                if !allowed
                    || launch_cancelled.is_cancelled()
                    || !gate.active.as_ref().is_some_and(|(active, observation)| {
                        *active == receipt && observation.unresolved()
                    })
                {
                    return Err(Error::request_cancelled());
                }
                let command = prepared.ok_or_else(Error::invalid_params)?;
                let lease = life.work().map_err(|_| Error::request_cancelled())?;
                let process = life.tool_terminals.launch(command, limit)?;
                gate.terminals.insert(
                    terminal_id.clone(),
                    Terminal {
                        receipt,
                        process: process.clone(),
                    },
                );
                let worker = process.clone();
                super::super::manager::runtime().spawn(async move {
                    let _ = worker.wait_for_group().await;
                    drop(lease);
                });
                Ok((terminal_id, process))
            })
            .await;
            let (terminal_id, process) = match launch {
                Ok(Ok(result)) => result,
                Ok(Err(error)) => {
                    let _ = responder.respond_with_error(error);
                    return;
                }
                Err(_) => {
                    let _ = responder.respond_with_error(Error::internal_error());
                    return;
                }
            };
            let result = tokio::select! {
                biased;
                _ = cancelled.cancelled() => Err(Error::request_cancelled()),
                started = process.started() => {
                    let active = receipt_gate.lock().is_ok_and(|gate| {
                        gate.active.as_ref().is_some_and(|active| active.0 == receipt)
                    });
                    if active {
                        started.map(|_| wire::CreateTerminalResponse::new(terminal_id))
                            .map_err(|_| Error::internal_error())
                    } else {
                        Err(Error::request_cancelled())
                    }
                }
            };
            if !answer(responder, result) {
                process.request_stop();
            }
        });
        (ctx.events)(json!({
            "kind":"permissionRequest", "requestId":request_id, "owner":owner, "terminalCommand":review,
            "options":[
                {"optionId":ALLOW,"kind":ALLOW,"name":"批准一次"},
                {"optionId":DENY,"kind":DENY,"name":"拒绝"}
            ],
        }));
    }

    fn terminal(&self, raw: Value, session: &str) -> Result<(String, Arc<Process>), Error> {
        let request: wire::TerminalOutputRequest = parse(raw)?;
        if request.session_id.0.as_ref() != session {
            return Err(Error::invalid_params());
        }
        let id = request.terminal_id.0.to_string();
        let gate = self.gate.lock().map_err(|_| Error::internal_error())?;
        let process = gate
            .terminals
            .get(&id)
            .ok_or_else(Error::invalid_params)?
            .process
            .clone();
        Ok((id, process))
    }

    pub(super) fn dispatch(
        &self,
        ctx: &mut DispatchContext<'_>,
        method: &str,
        raw: Value,
        responder: Responder<Value>,
    ) {
        if method == CREATE {
            self.create(ctx, raw, responder);
            return;
        }
        let (id, process) = match self.terminal(raw, ctx.session_id) {
            Ok(terminal) => terminal,
            Err(error) => {
                let _ = responder.respond_with_error(error);
                return;
            }
        };
        if method == OUTPUT {
            let output = process.output();
            let _ = answer(
                responder,
                Ok(
                    wire::TerminalOutputResponse::new(output.text, output.truncated)
                        .exit_status(output.exit.map(exit_status)),
                ),
            );
            return;
        }
        let Ok(callback) = self.callbacks.clone().try_acquire_owned() else {
            let _ = responder.respond_with_error(Error::request_cancelled());
            return;
        };
        let cancellation = responder.cancellation();
        let gate = self.gate.clone();
        let operation = match method {
            KILL | RELEASE => {
                process.request_stop();
                method.to_owned()
            }
            WAIT => method.to_owned(),
            _ => {
                let _ = responder.respond_with_error(Error::method_not_found());
                return;
            }
        };
        super::super::manager::runtime().spawn(async move {
            let _callback = callback;
            let result = async {
                let status = tokio::select! {
                    status = process.wait() => status.map_err(|_| Error::internal_error())?,
                    _ = cancellation.cancelled() => return Err(Error::request_cancelled()),
                };
                match operation.as_str() {
                    KILL => to_value(wire::KillTerminalResponse::new()),
                    RELEASE => {
                        let mut gate = gate.lock().map_err(|_| Error::internal_error())?;
                        gate.terminals.remove(&id);
                        to_value(wire::ReleaseTerminalResponse::new())
                    }
                    _ => to_value(wire::WaitForTerminalExitResponse::new(exit_status(status))),
                }
            }
            .await;
            let _ = answer(responder, result);
        });
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stop();
    }
}

fn exit_status(status: std::process::ExitStatus) -> wire::TerminalExitStatus {
    let result = wire::TerminalExitStatus::new()
        .exit_code(status.code().and_then(|code| u32::try_from(code).ok()));
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        result.signal(status.signal().map(|signal| signal.to_string()))
    }
    #[cfg(not(unix))]
    result
}

fn parse<T: DeserializeOwned>(raw: Value) -> Result<T, Error> {
    serde_json::from_value(raw).map_err(|_| Error::invalid_params())
}

fn to_value<T: Serialize>(value: T) -> Result<Value, Error> {
    serde_json::to_value(value).map_err(|_| Error::internal_error())
}

fn answer<T: Serialize>(responder: Responder<Value>, result: Result<T, Error>) -> bool {
    match result.and_then(to_value) {
        Ok(result) => responder.respond(result).is_ok(),
        Err(error) => {
            let _ = responder.respond_with_error(error);
            false
        }
    }
}
