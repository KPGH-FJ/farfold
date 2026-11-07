//! One bounded report from an already-open official session. No reconnect,
//! extension mutation, tool execution, model request or durable report store.
use super::{
    lifecycle::{ConnectionLife, OperationLease},
    manager::{AcpManager, ManagedConnection},
    pump::SessionControl,
};
use agent_client_protocol::{Agent, ConnectionTo, ErrorCode, UntypedMessage};
use std::{
    future::Future,
    path::Path,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Notify, oneshot};

mod types;
pub use types::{Capability, Code, Operation, Reply, Report, State, ToolsError};
mod availability;
pub(crate) use availability::Availability;
mod actor;
pub(crate) use actor::{Request, start};

const METHOD: &str = "_goose/unstable/tools/list";
const BUDGET: Duration = Duration::from_secs(10);
type Wire = Pin<Box<dyn Future<Output = agent_client_protocol::Result<serde_json::Value>> + Send>>;

/// One current in-memory request/result per actual SessionEntry. It is not
/// an index, generation system, operation history or a persistent ledger.
pub(crate) struct Slot {
    control: tokio::sync::mpsc::WeakUnboundedSender<SessionControl>,
    current: Mutex<Option<Operation>>,
    changed: Notify,
}
impl Slot {
    pub(crate) fn new(control: &tokio::sync::mpsc::UnboundedSender<SessionControl>) -> Self {
        Self {
            control: control.downgrade(),
            current: Mutex::new(None),
            changed: Notify::new(),
        }
    }
    fn matches_control(
        &self,
        control: &tokio::sync::mpsc::UnboundedSender<SessionControl>,
    ) -> bool {
        self.control
            .upgrade()
            .is_some_and(|original| !original.is_closed() && original.same_channel(control))
    }
    fn snapshot(&self, id: &str) -> Reply {
        self.current
            .lock()
            .map_err(|_| Code::Changed)?
            .as_ref()
            .filter(|o| o.operation_id == id)
            .cloned()
            .ok_or_else(|| Code::Changed.into())
    }
    fn existing(&self, id: &str) -> Result<Option<Operation>, ToolsError> {
        let current = self.current.lock().map_err(|_| Code::Changed)?;
        if let Some(operation) = current.as_ref() {
            if operation.operation_id == id {
                return Ok(Some(operation.clone()));
            }
            if !operation.settled {
                return Err(Code::Busy.into());
            }
        }
        Ok(None)
    }
    fn finish(&self, id: &str, value: Result<Report, ToolsError>, settled: bool) {
        if let Ok(mut current) = self.current.lock()
            && let Some(operation) = current.as_mut().filter(|o| o.operation_id == id)
        {
            operation.state = if value.is_ok() {
                State::Ready
            } else {
                State::Failed
            };
            operation.settled = settled;
            match value {
                Ok(report) => {
                    operation.report = Some(report);
                    operation.error = None;
                }
                Err(error) => {
                    operation.report = None;
                    operation.error = Some(error);
                }
            }
        }
        self.changed.notify_waiters();
    }
    async fn wait(&self, id: &str, deadline: tokio::time::Instant) -> Reply {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let value = self.snapshot(id)?;
            if value.state != State::Pending || tokio::time::Instant::now() >= deadline {
                return Ok(value);
            }
            if tokio::time::timeout_at(deadline, changed).await.is_err() {
                return self.snapshot(id);
            }
        }
    }
}

struct Owner {
    request: Request,
    control: tokio::sync::mpsc::UnboundedSender<SessionControl>,
}
impl AcpManager {
    fn tools_owner(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        connection_id: &str,
        operation_id: &str,
    ) -> Result<Owner, ToolsError> {
        if !types::valid_operation_id(operation_id) {
            return Err(Code::Changed.into());
        }
        let connection = self
            .session_connection(agent_id, cwd, session_id)
            .map_err(|_| Code::Changed)?;
        if connection.connection_id != connection_id {
            return Err(Code::Changed.into());
        }
        let (control, slot) = {
            let entries = connection.sessions.lock().map_err(|_| Code::Changed)?;
            let entry = entries
                .get(session_id)
                .filter(|e| {
                    e.preview_token.is_none()
                        && e.purpose == super::open_purpose::OpenPurpose::Conversation
                        && !e.control.is_closed()
                        && e.tools_report.matches_control(&e.control)
                })
                .ok_or(Code::Changed)?;
            (entry.control.clone(), entry.tools_report.clone())
        };
        let (manager, agent, directory, session, owner, original_control, original_slot) = (
            self.clone(),
            agent_id.to_owned(),
            cwd.to_path_buf(),
            session_id.to_owned(),
            connection.clone(),
            control.clone(),
            slot.clone(),
        );
        let current_owner = Arc::new(move || {
            manager
                .session_connection(&agent, &directory, &session)
                .is_ok_and(|c| {
                    c.connection_id == owner.connection_id
                        && Arc::ptr_eq(&c.state, &owner.state)
                        && c.sessions.lock().is_ok_and(|entries| {
                            entries.get(&session).is_some_and(|e| {
                                e.preview_token.is_none()
                                    && e.purpose == super::open_purpose::OpenPurpose::Conversation
                                    && !e.control.is_closed()
                                    && e.control.same_channel(&original_control)
                                    && Arc::ptr_eq(&e.tools_report, &original_slot)
                            })
                        })
                })
        });
        Ok(Owner {
            request: Request {
                operation: Operation {
                    operation_id: operation_id.into(),
                    agent_id: agent_id.into(),
                    cwd: cwd.to_string_lossy().into(),
                    native_session_id: session_id.into(),
                    connection_id: connection_id.into(),
                    state: State::Pending,
                    settled: false,
                    report: None,
                    error: None,
                },
                slot,
                availability: connection.session_tools.clone(),
                current_owner,
            },
            control,
        })
    }
    pub(crate) async fn tools_read(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        connection_id: &str,
        operation_id: &str,
    ) -> Reply {
        self.tools_read_until(
            agent_id,
            cwd,
            session_id,
            connection_id,
            operation_id,
            tokio::time::Instant::now() + BUDGET,
        )
        .await
    }
    #[allow(clippy::too_many_arguments)]
    async fn tools_read_until(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        connection_id: &str,
        operation_id: &str,
        deadline: tokio::time::Instant,
    ) -> Reply {
        let Owner { request, control } =
            self.tools_owner(agent_id, cwd, session_id, connection_id, operation_id)?;
        if request.slot.existing(operation_id)?.is_none() {
            if request.availability.capability().is_none() {
                return Err(Code::Unavailable.into());
            }
            let (result, receive) = oneshot::channel();
            control
                .send(SessionControl::ToolsRead {
                    request: Box::new(request.clone()),
                    result,
                    deadline,
                })
                .map_err(|_| Code::Changed)?;
            tokio::time::timeout_at(deadline, receive)
                .await
                .map_err(|_| Code::Timeout)?
                .map_err(|_| Code::Changed)??;
        }
        let value = request.slot.wait(operation_id, deadline).await?;
        if !(request.current_owner)() {
            return Err(Code::Changed.into());
        }
        Ok(value)
    }
    pub(crate) fn tools_status(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        connection_id: &str,
        operation_id: &str,
    ) -> Reply {
        let owner = self.tools_owner(agent_id, cwd, session_id, connection_id, operation_id)?;
        let value = owner.request.slot.snapshot(operation_id)?;
        if !(owner.request.current_owner)() {
            return Err(Code::Changed.into());
        }
        Ok(value)
    }
}
pub(crate) fn capability(connection: &ManagedConnection) -> Option<Capability> {
    connection.session_tools.capability()
}

#[tauri::command]
pub async fn session_tools_read(
    app: tauri::AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
    connection_id: String,
    operation_id: String,
) -> Reply {
    use tauri::Manager;
    let cwd = super::manager::validate_cwd_async(&cwd)
        .await
        .map_err(|_| Code::Changed)?;
    app.state::<AcpManager>()
        .tools_read(&agent_id, &cwd, &session_id, &connection_id, &operation_id)
        .await
}
#[tauri::command]
pub async fn session_tools_status(
    app: tauri::AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
    connection_id: String,
    operation_id: String,
) -> Reply {
    use tauri::Manager;
    let cwd = super::manager::validate_cwd_async(&cwd)
        .await
        .map_err(|_| Code::Changed)?;
    app.state::<AcpManager>().tools_status(
        &agent_id,
        &cwd,
        &session_id,
        &connection_id,
        &operation_id,
    )
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod wire_tests;
