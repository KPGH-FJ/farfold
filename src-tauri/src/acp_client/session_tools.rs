//! One bounded report from an already-open official session. No reconnect,
//! extension mutation, tool execution, model request or durable report store.
use super::{
    lifecycle::{ConnectionLife, OperationLease},
    manager::{AcpManager, ManagedConnection},
    pump::SessionControl,
};
use agent_client_protocol::{Agent, ConnectionTo, ErrorCode, UntypedMessage};
use std::{
    collections::HashSet,
    future::Future,
    path::Path,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Notify, oneshot};

mod types;
use types::Query;
pub use types::{Capability, Code, Operation, Reply, Report, State, ToolsError};
mod availability;
mod configuration;
pub(crate) use availability::Availability;
mod actor;
pub(crate) use actor::{Request, start};

const METHOD: &str = "_goose/unstable/tools/list";
const BUDGET: Duration = Duration::from_secs(10);
const MAX_OPERATIONS: usize = 4_096;
pub(crate) type Wire =
    Pin<Box<dyn Future<Output = agent_client_protocol::Result<serde_json::Value>> + Send>>;

enum ReadReport {
    Tools(Report),
    Configuration(configuration::Report),
}

/// One current in-memory request/result per actual SessionEntry. Used IDs
/// cannot be replayed on this actor; no previous request or result is stored.
pub(crate) struct Slot {
    pub(crate) changes: Arc<super::session_tool_changes::Slot>,
    control: tokio::sync::mpsc::WeakUnboundedSender<SessionControl>,
    extensions: Vec<String>,
    reads: Mutex<Reads>,
    changed: Notify,
}
#[derive(Default)]
struct Reads {
    current: Option<Operation>,
    admitted_ids: HashSet<String>,
}
impl Slot {
    pub(crate) fn new(
        control: &tokio::sync::mpsc::UnboundedSender<SessionControl>,
        response: &serde_json::Value,
    ) -> Self {
        Self {
            changes: Arc::new(super::session_tool_changes::Slot::default()),
            control: control.downgrade(),
            extensions: types::startup_extensions(response),
            reads: Mutex::new(Reads::default()),
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
        self.reads
            .lock()
            .map_err(|_| Code::Changed)?
            .current
            .as_ref()
            .filter(|o| o.operation_id == id)
            .cloned()
            .ok_or_else(|| Code::Changed.into())
    }
    fn existing(&self, request: &Operation) -> Result<Option<Operation>, ToolsError> {
        let reads = self.reads.lock().map_err(|_| Code::Changed)?;
        if let Some(operation) = reads.current.as_ref()
            && operation.operation_id == request.operation_id
        {
            if operation.query() != request.query() {
                return Err(Code::Changed.into());
            }
            return Ok(Some(operation.clone()));
        }
        if reads.admitted_ids.contains(&request.operation_id) {
            return Err(Code::Changed.into());
        }
        if reads
            .current
            .as_ref()
            .is_some_and(|operation| !operation.settled)
        {
            return Err(Code::Busy.into());
        }
        Ok(None)
    }
    fn admit(&self, operation: &Operation) -> Result<(), ToolsError> {
        let mut reads = self.reads.lock().map_err(|_| Code::Changed)?;
        if reads.admitted_ids.len() >= MAX_OPERATIONS {
            return Err(Code::ReadLimit.into());
        }
        if !reads.admitted_ids.insert(operation.operation_id.clone()) {
            return Err(Code::Changed.into());
        }
        reads.current = Some(operation.clone());
        Ok(())
    }
    fn finish(&self, id: &str, value: Result<ReadReport, ToolsError>, settled: bool) {
        if let Ok(mut reads) = self.reads.lock()
            && let Some(operation) = reads.current.as_mut().filter(|o| o.operation_id == id)
        {
            operation.state = if value.is_ok() {
                State::Ready
            } else {
                State::Failed
            };
            operation.settled = settled;
            match value {
                Ok(ReadReport::Tools(report)) => {
                    operation.report = Some(report);
                    operation.error = None;
                }
                Ok(ReadReport::Configuration(report)) => {
                    operation.configuration_report = Some(report);
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
        query: Query<'_>,
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
        if let Query::Tools(Some(name)) = query
            && !slot.extensions.iter().any(|item| item == name)
        {
            return Err(Code::Changed.into());
        }
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
                    extension_name: match query {
                        Query::Tools(name) => name.map(str::to_owned),
                        Query::Configuration => None,
                    },
                    configuration: (query == Query::Configuration).then_some(true),
                    state: State::Pending,
                    settled: false,
                    report: None,
                    configuration_report: None,
                    error: None,
                },
                slot,
                availability: connection.session_tools.clone(),
                current_owner,
            },
            control,
        })
    }
    #[cfg(test)]
    pub(crate) async fn tools_read(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        connection_id: &str,
        operation_id: &str,
        extension_name: Option<&str>,
    ) -> Reply {
        self.tools_read_until(
            agent_id,
            cwd,
            session_id,
            connection_id,
            operation_id,
            Query::Tools(extension_name),
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
        query: Query<'_>,
        deadline: tokio::time::Instant,
    ) -> Reply {
        let Owner { request, control } = self.tools_owner(
            agent_id,
            cwd,
            session_id,
            connection_id,
            operation_id,
            query,
        )?;
        if request.slot.existing(&request.operation)?.is_none() {
            if !request.availability.supports(query) {
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
        if value.query() != query || !(request.current_owner)() {
            return Err(Code::Changed.into());
        }
        Ok(value)
    }
    #[cfg(test)]
    pub(crate) fn tools_status(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        connection_id: &str,
        operation_id: &str,
        extension_name: Option<&str>,
    ) -> Reply {
        self.tools_status_query(
            agent_id,
            cwd,
            session_id,
            connection_id,
            operation_id,
            Query::Tools(extension_name),
        )
    }
    fn tools_status_query(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        connection_id: &str,
        operation_id: &str,
        query: Query<'_>,
    ) -> Reply {
        let owner = self.tools_owner(
            agent_id,
            cwd,
            session_id,
            connection_id,
            operation_id,
            query,
        )?;
        let value = owner.request.slot.snapshot(operation_id)?;
        if value.query() != query || !(owner.request.current_owner)() {
            return Err(Code::Changed.into());
        }
        Ok(value)
    }
}
fn select_query(
    extension: Option<&str>,
    configuration: Option<bool>,
) -> Result<Query<'_>, ToolsError> {
    match (extension, configuration) {
        (None, Some(true)) => Ok(Query::Configuration),
        (extension, None) => Ok(Query::Tools(extension)),
        _ => Err(Code::Changed.into()),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportScope {
    extension_name: Option<String>,
    configuration: Option<bool>,
}

pub(crate) fn capability(connection: &ManagedConnection) -> Option<Capability> {
    let mut capability = connection.session_tools.capability()?;
    capability.management = super::session_tool_changes::supported(connection).then_some(true);
    Some(capability)
}

pub(crate) fn opened_capability(
    connection: &ManagedConnection,
    session_id: &str,
    response: &serde_json::Value,
) -> Option<Capability> {
    let mut capability = capability(connection)?;
    capability.startup = types::startup_report(response);
    if capability.tools_unavailable.is_none()
        && let Ok(entries) = connection.sessions.lock()
        && let Some(entry) = entries.get(session_id)
        && entry.purpose == super::open_purpose::OpenPurpose::Conversation
        && entry.preview_token.is_none()
        && entry.connection_is(&connection.connection_id)
    {
        capability
            .extensions
            .clone_from(&entry.tools_report.extensions);
    }
    Some(capability)
}

#[tauri::command]
pub async fn session_tools_read(
    app: tauri::AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
    connection_id: String,
    operation_id: String,
    scope: ReportScope,
) -> Reply {
    use tauri::Manager;
    let cwd = super::manager::validate_cwd_async(&cwd)
        .await
        .map_err(|_| Code::Changed)?;
    app.state::<AcpManager>()
        .tools_read_until(
            &agent_id,
            &cwd,
            &session_id,
            &connection_id,
            &operation_id,
            select_query(scope.extension_name.as_deref(), scope.configuration)?,
            tokio::time::Instant::now() + BUDGET,
        )
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
    scope: ReportScope,
) -> Reply {
    use tauri::Manager;
    let cwd = super::manager::validate_cwd_async(&cwd)
        .await
        .map_err(|_| Code::Changed)?;
    app.state::<AcpManager>().tools_status_query(
        &agent_id,
        &cwd,
        &session_id,
        &connection_id,
        &operation_id,
        select_query(scope.extension_name.as_deref(), scope.configuration)?,
    )
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod wire_tests;
