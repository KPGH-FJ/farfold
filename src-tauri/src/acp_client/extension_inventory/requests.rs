//! Bounded, transient one-shot query ownership. No persisted inventory or jobs.
use super::{super::operations::Operation, types::*};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::watch;

const CAPACITY: usize = 64;
const RETENTION: Duration = Duration::from_secs(300);
#[derive(Default)]
pub(in crate::acp_client) struct Requests(Mutex<HashMap<String, Arc<Request>>>);
pub(in crate::acp_client) struct Request {
    pub agent: String,
    pub cwd: Option<String>,
    pub kind: Option<Kind>,
    selection_id: Option<String>,
    pub operation: Operation,
    pub deadline: Instant,
    pub changed: watch::Sender<Option<InventoryOperation>>,
    touched: Mutex<Instant>,
    pub targets: Mutex<Option<Arc<super::targets::TargetSet>>>,
    pub mcp_targets: Mutex<Option<Arc<super::mcp_targets::TargetSet>>>,
}
impl Request {
    pub fn snapshot(&self) -> Option<InventoryOperation> {
        self.changed.borrow().clone()
    }
    fn active(&self) -> bool {
        self.snapshot().is_some_and(|value| !value.settled)
    }
    pub fn progress(&self, state: State, code: Option<Code>) {
        self.changed.send_if_modified(|value| {
            let Some(value) = value.as_mut().filter(|v| !v.settled) else {
                return false;
            };
            value.state = state;
            value.code = code;
            true
        });
    }
    pub fn finish(&self, outcome: Result<InventorySnapshot>) {
        let outcome = outcome.and_then(|snapshot| {
            if matches!(
                (self.kind, &snapshot),
                (Some(Kind::Mcp), InventorySnapshot::Mcp(_))
                    | (Some(Kind::Skills), InventorySnapshot::Skills(_))
            ) {
                Ok(snapshot)
            } else {
                Err(Code::InvalidOutput.into())
            }
        });
        self.changed.send_modify(|value| {
            let Some(value) = value.as_mut() else {
                return;
            };
            value.settled = true;
            match outcome {
                Ok(snapshot) if self.operation.interested() => {
                    value.state = State::Ready;
                    value.snapshot = Some(snapshot);
                    value.code = None;
                }
                Ok(_) => {
                    value.state = State::Cancelled;
                    value.code = Some(Code::Cancelled);
                }
                Err(error) => {
                    value.state = if error.code == Code::Cancelled {
                        State::Cancelled
                    } else {
                        State::Failed
                    };
                    value.code = Some(error.code);
                    value.snapshot = None;
                }
            }
        });
        *self.touched.lock().unwrap_or_else(|p| p.into_inner()) = Instant::now();
    }
}
pub(in crate::acp_client) fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, byte)| {
            if [8, 13, 18, 23].contains(&i) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}
fn validate(agent: &str, id: &str) -> Result<()> {
    if agent.is_empty() || agent.len() > 256 || agent.chars().any(char::is_control) || !valid_id(id)
    {
        Err(Code::InvalidRequest.into())
    } else {
        Ok(())
    }
}
pub(in crate::acp_client) fn shared() -> Arc<Requests> {
    static REQUESTS: OnceLock<Arc<Requests>> = OnceLock::new();
    REQUESTS.get_or_init(Default::default).clone()
}
impl Requests {
    fn entries(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Request>>> {
        let mut entries = self.0.lock().unwrap_or_else(|p| p.into_inner());
        entries.retain(|_, r| {
            let retained = r.active()
                || r.touched
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .elapsed()
                    < RETENTION;
            if !retained {
                // Reviews may still hold this Arc. Retire its authority, not only
                // the registry key, before making room for a later tombstone.
                r.operation.abandon();
                r.targets.lock().unwrap_or_else(|p| p.into_inner()).take();
                r.mcp_targets
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .take();
            }
            retained
        });
        entries
    }
    pub fn begin(
        &self,
        agent: &str,
        cwd: &str,
        id: &str,
        selection_id: &str,
        kind: Kind,
    ) -> Result<(Arc<Request>, bool)> {
        validate(agent, id)?;
        if !valid_id(selection_id) {
            return Err(Code::SelectionChanged.into());
        }
        if cwd.is_empty() || cwd.len() > 4096 || cwd.chars().any(char::is_control) {
            return Err(Code::CwdUnavailable.into());
        }
        let mut entries = self.entries();
        if let Some(request) = entries.get(id) {
            if request.agent != agent {
                return Err(Code::RequestConflict.into());
            }
            if request.cwd.is_none() {
                return Err(Code::Cancelled.into());
            }
            if request.cwd.as_deref() != Some(cwd)
                || request.selection_id.as_deref() != Some(selection_id)
                || request.kind != Some(kind)
            {
                return Err(Code::RequestConflict.into());
            }
            return Ok((request.clone(), false));
        }
        if entries.len() >= CAPACITY
            || entries.values().filter(|r| r.active()).count() >= 2
            || entries.values().any(|r| r.agent == agent && r.active())
        {
            return Err(Code::Busy.into());
        }
        let request = Arc::new(Request {
            agent: agent.into(),
            cwd: Some(cwd.into()),
            kind: Some(kind),
            selection_id: Some(selection_id.into()),
            operation: Operation::new(),
            deadline: Instant::now() + Duration::from_secs(10),
            touched: Mutex::new(Instant::now()),
            targets: Mutex::new(None),
            mcp_targets: Mutex::new(None),
            changed: watch::channel(Some(InventoryOperation {
                request_id: id.into(),
                agent_id: agent.into(),
                cwd: cwd.into(),
                kind,
                state: State::Running,
                settled: false,
                code: None,
                snapshot: None,
            }))
            .0,
        });
        entries.insert(id.into(), request.clone());
        Ok((request, true))
    }
    pub fn get(&self, agent: &str, id: &str) -> Result<Arc<Request>> {
        validate(agent, id)?;
        self.entries()
            .get(id)
            .filter(|r| r.agent == agent && r.cwd.is_some())
            .cloned()
            .ok_or_else(|| Code::UnknownRequest.into())
    }
    pub fn cancel(&self, agent: &str, id: &str) -> Result<Cancellation> {
        validate(agent, id)?;
        let mut entries = self.entries();
        let request = if let Some(request) = entries.get(id) {
            if request.agent != agent {
                return Err(Code::RequestConflict.into());
            }
            request.clone()
        } else {
            if entries.len() >= CAPACITY {
                return Err(Code::Busy.into());
            }
            let request = Arc::new(Request {
                agent: agent.into(),
                cwd: None,
                kind: None,
                selection_id: None,
                operation: Operation::new(),
                deadline: Instant::now(),
                touched: Mutex::new(Instant::now()),
                targets: Mutex::new(None),
                mcp_targets: Mutex::new(None),
                changed: watch::channel(None).0,
            });
            entries.insert(id.into(), request.clone());
            request
        };
        request.operation.abandon();
        request
            .targets
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        request
            .mcp_targets
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        request.progress(State::Cancelling, Some(Code::Cancelled));
        Ok(Cancellation {
            request_id: id.into(),
            agent_id: agent.into(),
            cancel_requested: true,
            operation: request.snapshot(),
        })
    }
}

#[cfg(test)]
#[path = "requests_tests.rs"]
mod test_support;
