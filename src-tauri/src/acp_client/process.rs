//! Exact Child ownership around the official SDK byte-stream transport.
use super::{
    lifecycle::ConnectionLife,
    startup_diagnostics::{Diagnostics, Phase},
};
use crate::supervisor;
use agent_client_protocol::{AcpAgent, Agent, ByteStreams, Channel, Client, ConnectTo};
use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
    time::Duration,
};
use tokio::sync::watch;

#[cfg(test)]
#[path = "process_mcp_tests.rs"]
mod mcp_tests;

/// Effective launch facts only. Values never enter process diagnostics or status.
/// Absence of this cell means the actual OS spawn has not been confirmed.
#[derive(Clone, Copy)]
pub(crate) struct McpSpawnFacts {
    pub logs_safe: bool,
    pub inline_mcp_safe: Option<bool>,
}

fn freeze_launch_env(
    command: &mut std::process::Command,
    name: &str,
    inherited: impl FnOnce() -> Option<OsString>,
) -> Option<OsString> {
    let explicit = command
        .get_envs()
        .find(|(key, _)| *key == OsStr::new(name))
        .map(|(_, value)| value.map(OsStr::to_owned));
    let effective = explicit.unwrap_or_else(inherited);
    // Preserve precisely the observed value (including empty) or its absence.
    // Freezing just these keys prevents a concurrent parent-environment change
    // between observation and spawn from invalidating the fact. No env_clear,
    // log switch rewrite, secret logging or parent-environment mutation.
    match &effective {
        Some(value) => {
            command.env(name, value);
        }
        None => {
            command.env_remove(name);
        }
    }
    effective
}

fn inline_mcp_safe(config: Option<&OsStr>) -> Option<bool> {
    let Some(config) = config.filter(|value| !value.is_empty()) else {
        return Some(true);
    };
    let object: serde_json::Value = serde_json::from_str(config.to_str()?).ok()?;
    Some(
        !object
            .as_object()?
            .keys()
            .any(|key| key == "mcp_servers" || key.starts_with("mcp_servers.")),
    )
}

fn capture_mcp_spawn_facts(
    command: &mut std::process::Command,
    inherited: impl Fn(&str) -> Option<OsString>,
) -> McpSpawnFacts {
    let logs = freeze_launch_env(command, "APP_SERVER_LOGS", || inherited("APP_SERVER_LOGS"));
    let config = freeze_launch_env(command, "CODEX_CONFIG", || inherited("CODEX_CONFIG"));
    McpSpawnFacts {
        logs_safe: logs.is_none_or(|value| value.is_empty()),
        inline_mcp_safe: inline_mcp_safe(config.as_deref()),
    }
}

#[derive(Clone)]
pub(crate) struct ProcessControl {
    pub pid: Arc<AtomicU32>,
    started: Arc<AtomicBool>,
    start_failed: Arc<AtomicBool>,
    stop: watch::Sender<bool>,
    done: watch::Sender<Option<Result<(), String>>>,
    diagnostics: Arc<Diagnostics>,
    pub(crate) mcp_spawn_facts: Arc<OnceLock<McpSpawnFacts>>,
    capture_mcp_facts: bool,
}
impl ProcessControl {
    pub fn new(diagnostics: Arc<Diagnostics>) -> Self {
        Self {
            diagnostics,
            mcp_spawn_facts: Arc::new(OnceLock::new()),
            capture_mcp_facts: false,
            pid: Arc::new(AtomicU32::new(0)),
            started: Arc::new(AtomicBool::new(false)),
            start_failed: Arc::new(AtomicBool::new(false)),
            stop: watch::channel(false).0,
            done: watch::channel(None).0,
        }
    }
    pub(crate) fn review_mcp_launch(mut self, reviewed: bool) -> Self {
        self.capture_mcp_facts = reviewed;
        self
    }
    pub fn stop(&self) {
        self.stop.send_replace(true);
    }
    pub fn start_failed(&self) -> bool {
        self.start_failed.load(Ordering::SeqCst)
    }
    pub async fn closed(&self) -> Result<(), String> {
        if !self.started.load(Ordering::SeqCst) {
            return Ok(());
        }
        let mut done = self.done.subscribe();
        loop {
            if let Some(result) = done.borrow().clone() {
                return result;
            }
            done.changed()
                .await
                .map_err(|_| "无法确认连接进程已结束".to_string())?;
        }
    }
}
struct StopOnDrop(ProcessControl);
impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.stop();
    }
}

fn observe_exit(
    status: std::io::Result<std::process::ExitStatus>,
    stop: &watch::Receiver<bool>,
    connection_stop: &watch::Receiver<bool>,
) -> (std::io::Result<std::process::ExitStatus>, bool) {
    // select! may choose a ready exit after a stop request is already visible.
    // Freeze intent at observation, not after cleanup: later cancellation must
    // never erase an unexpected exit we have already observed.
    let unexpected = !*stop.borrow() && !*connection_stop.borrow();
    (status, unexpected)
}

struct KillOnDrop {
    _group: crate::process_platform::OwnedGroup,
    pid: u32,
    drain_stop: Arc<AtomicBool>,
    armed: bool,
    diagnostics: Arc<Diagnostics>,
}
impl Drop for KillOnDrop {
    fn drop(&mut self) {
        self.drain_stop.store(true, Ordering::SeqCst);
        if self.armed {
            self.diagnostics.signal_requested(true, false);
            supervisor::signal_owned_group(self.pid, supervisor::KILL);
        }
    }
}

pub(crate) struct ProcessTransport {
    pub agent: AcpAgent,
    pub control: ProcessControl,
    pub life: Arc<ConnectionLife>,
    pub data_dir: PathBuf,
    pub agent_id: String,
    pub cwd: String,
    pub diagnostics: Arc<Diagnostics>,
}

type SpawnedProcess = (
    async_process::ChildStdin,
    async_process::ChildStdout,
    async_process::ChildStderr,
    async_process::Child,
    crate::process_platform::OwnedGroup,
);

fn spawn_process_in(
    agent: &AcpAgent,
    cwd: &Path,
    control: &ProcessControl,
) -> Result<SpawnedProcess, agent_client_protocol::Error> {
    // Mirror the locked SDK's process construction, adding only this connection's
    // actual cwd. The SDK config has no cwd setter; ByteStreams and the existing
    // exact Child owner below still handle the protocol and process lifetime.
    let config = agent.config();
    let mut command = std::process::Command::new(config.command());
    command
        .args(config.arguments())
        .envs(config.environment())
        .current_dir(cwd);
    let mcp_spawn_facts = control
        .capture_mcp_facts
        .then(|| capture_mcp_spawn_facts(&mut command, |name| std::env::var_os(name)));
    let pending_group = crate::process_platform::prepare_command(&mut command)
        .map_err(agent_client_protocol::Error::into_internal_error)?;
    let mut command = async_process::Command::from(command);
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        // This fact is set only at the actual OS spawn failure, before any
        // child exists; missing PID or SDK error codes cannot imply it.
        control.start_failed.store(true, Ordering::SeqCst);
        agent_client_protocol::Error::into_internal_error(error)
    })?;
    let group = pending_group
        .attach(child.id())
        .map_err(agent_client_protocol::Error::into_internal_error)?;
    if let Some(facts) = mcp_spawn_facts {
        let _ = control.mcp_spawn_facts.set(facts);
    }
    control.diagnostics.started();
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| agent_client_protocol::util::internal_error("无法打开程序输入"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| agent_client_protocol::util::internal_error("无法打开程序输出"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| agent_client_protocol::util::internal_error("无法打开程序错误输出"))?;
    Ok((stdin, stdout, stderr, child, group))
}

impl ConnectTo<Client> for ProcessTransport {
    async fn connect_to(
        self,
        client: impl ConnectTo<Agent>,
    ) -> Result<(), agent_client_protocol::Error> {
        let (stdin, stdout, mut stderr, mut child, group) =
            spawn_process_in(&self.agent, Path::new(&self.cwd), &self.control)?;
        let pid = child.id();
        let drain_stop = Arc::new(AtomicBool::new(false));
        let mut guard = KillOnDrop {
            _group: group,
            pid,
            drain_stop: drain_stop.clone(),
            armed: true,
            diagnostics: self.diagnostics.clone(),
        };
        self.control.pid.store(pid, Ordering::SeqCst);
        self.control.started.store(true, Ordering::SeqCst);
        let process = self.control.clone();
        let _stop_on_drop = StopOnDrop(process.clone());
        let mut stop = process.stop.subscribe();
        let mut connection_stop = self.life.stop_receiver();
        let data_dir = self.data_dir;
        let diagnostics = self.diagnostics;
        let stderr_records = diagnostics.clone();
        // Async process pipes own any blocking Windows IO internally. The
        // observer checks stop independently; stderr content is never retained.
        let drain = super::manager::runtime().spawn(async move {
            use futures_lite::AsyncReadExt;
            let mut buffer = [0u8; 8192];
            while !drain_stop.load(Ordering::SeqCst) {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(50)) => {},
                    result = stderr.read(&mut buffer) => match result {
                        Ok(0) | Err(_) => break,
                        Ok(count) => stderr_records.record(serde_json::json!({"version":1,"ts":super::tap::now_millis(),"dir":"err","event":"other","bytes":count,"error":"stderr"})),
                    }
                }
            }
        });
        // This one task owns the exact Child until wait/reap completes. Dropping
        // protocol futures only requests shutdown; it never abandons the Child.
        let done = process.done.clone();
        let (registered, registration_result) = tokio::sync::oneshot::channel();
        let command = self.agent.config().command().to_string_lossy().into_owned();
        let owner_diagnostics = diagnostics.clone();
        super::manager::runtime().spawn(async move {
            let registration_dir = data_dir.clone();
            let mut registration_task = tauri::async_runtime::spawn_blocking(move || {
                supervisor::register_pid(&registration_dir, &self.agent_id, &self.cwd, &command, pid)
            });
            let mut exit = None;
            let mut unexpected_exit = false;
            let registration = if *stop.borrow() || *connection_stop.borrow() { None } else {
                tokio::select! {
                    result = &mut registration_task => Some(result.map_err(|_| "无法保存连接进程".to_string()).and_then(|result| result)),
                    value = child.status() => {
                        let (status, unexpected) = observe_exit(value, &stop, &connection_stop);
                        exit = Some(status); unexpected_exit = unexpected; None
                    },
                    _ = stop.changed() => None,
                    _ = connection_stop.changed() => None,
                }
            };
            let registered_ok = matches!(registration, Some(Ok(_)));
            let _ = registered.send(match &registration {
                Some(result) => result.as_ref().map(|_| ()).map_err(Clone::clone),
                None => Err("连接已结束".to_string()),
            });
            if registered_ok && !*stop.borrow() && !*connection_stop.borrow() {
                tokio::select! {
                    value = child.status() => {
                        let (status, unexpected) = observe_exit(value, &stop, &connection_stop);
                        exit = Some(status); unexpected_exit = unexpected;
                    }
                    _ = stop.changed() => {}
                    _ = connection_stop.changed() => {}
                }
            }
            if let Some(status) = &exit { owner_diagnostics.exit(status); }
            owner_diagnostics.phase(Phase::Cleanup);
            owner_diagnostics.signal_requested(false, exit.as_ref().is_some_and(Result::is_ok));
            supervisor::signal_owned_group(pid, supervisor::TERM);
            guard.drain_stop.store(true, Ordering::SeqCst);
            // The drain performs only poll/read and bounded try_send. It owns
            // stderr until this bounded join; diagnostic writes are independent.
            let draining = drain;
            let started = tokio::time::Instant::now();
            let mut killed = false;
            loop {
                if exit.is_none() {
                    exit = child.try_status().transpose();
                    if let Some(status) = &exit { owner_diagnostics.exit(status); }
                }
                if exit.is_some() && !supervisor::owned_group_alive(pid) {
                    owner_diagnostics.group_ended();
                    break;
                }
                if !killed && started.elapsed() >= Duration::from_secs(2) {
                    owner_diagnostics.signal_requested(true, false);
                    supervisor::signal_owned_group(pid, supervisor::KILL);
                    killed = true;
                }
                // The caller stops waiting after five seconds, while this exact
                // owner stays alive until reap and group termination are facts.
                tokio::time::sleep(Duration::from_millis(
                    if started.elapsed() < Duration::from_secs(5) {
                        25
                    } else {
                        250
                    },
                ))
                .await;
            }
            guard.armed = false;
            let _ = tokio::time::timeout(Duration::from_millis(100), draining).await;
            let outcome = if unexpected_exit
                && !exit
                    .as_ref()
                    .is_some_and(|r| r.as_ref().is_ok_and(|s| s.success()))
            {
                Err("Agent 已意外退出".to_string())
            } else {
                Ok(())
            };
            // Completion is an OS fact. A slow registry filesystem must not
            // keep a reaped process alive in the manager's state.
            drop(guard);
            done.send_replace(Some(outcome));
            let registration = match registration {
                Some(result) => result,
                None => registration_task.await.map_err(|_| "无法保存连接进程".to_string()).and_then(|result| result),
            };
            if let Ok(registration) = registration {
                let _ = tauri::async_runtime::spawn_blocking(move || supervisor::unregister_pid(&data_dir, &registration)).await;
            }

        });
        registration_result
            .await
            .map_err(|_| agent_client_protocol::util::internal_error("无法确认连接进程"))?
            .map_err(agent_client_protocol::util::internal_error)?;
        let transport = ByteStreams::new(stdin, stdout);
        let (wire, wire_future) = ConnectTo::<Client>::into_channel_and_future(transport);
        let (endpoint, endpoint_future) = client.into_channel_and_future();
        let outgoing_records = diagnostics.clone();
        let incoming_records = diagnostics;
        let bridge = Channel::bridge_with_inspection(
            endpoint,
            wire,
            move |message| {
                outgoing_records.inspect(message, true);
                if let Ok(line) = serde_json::to_string(message) {
                    let mut record = super::tap::diagnostic_record(&line, "out");
                    outgoing_records.annotate_outgoing_error(message, &mut record);
                    outgoing_records.record(record);
                }
                Ok(())
            },
            move |message| {
                incoming_records.inspect(message, false);
                if let Ok(line) = serde_json::to_string(message) {
                    let mut record = super::tap::diagnostic_record(&line, "in");
                    incoming_records.annotate_incoming_error(message, &mut record);
                    incoming_records.record(record);
                }
                Ok(())
            },
        );
        tokio::select! {
            outcome = async { tokio::try_join!(wire_future, endpoint_future, bridge).map(|_| ()) } => outcome,
            outcome = process.closed() => outcome.map_err(agent_client_protocol::util::internal_error),
        }
    }
}

#[cfg(test)]
#[path = "process_cwd_tests.rs"]
mod cwd_tests;

#[cfg(test)]
#[path = "process_startup_tests.rs"]
mod startup_tests;
