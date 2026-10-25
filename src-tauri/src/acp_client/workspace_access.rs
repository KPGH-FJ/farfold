//! A reviewed, read-only supplement on the current session actor. It never
//! changes trust, opens a session, reconnects, or changes prompt admission.
use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use agent_client_protocol::{Agent, ConnectionTo, ErrorCode, UntypedMessage};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::oneshot;

use super::{
    lifecycle::OperationLease,
    manager::{AcpManager, ManagedConnection},
};

const BUDGET: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    Unavailable,
    Changed,
    Busy,
    Timeout,
    InvalidResponse,
    QueryFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AccessError {
    pub code: ErrorKind,
    pub message: &'static str,
}
impl From<ErrorKind> for AccessError {
    fn from(code: ErrorKind) -> Self {
        let message = match code {
            ErrorKind::Unavailable => "当前连接不支持查询文件夹信任状态",
            ErrorKind::Changed => "对话连接或文件夹已变化，请重新打开后检查",
            ErrorKind::Busy => "当前正在处理其他操作，请稍后检查文件夹信任状态",
            ErrorKind::Timeout => "文件夹信任状态尚未读取完成，请稍后查看",
            ErrorKind::InvalidResponse => "未能核对返回的文件夹信任状态",
            ErrorKind::QueryFailed => "暂时无法读取文件夹信任状态",
        };
        Self { code, message }
    }
}
type Reply = Result<WorkspaceAccessStatus, AccessError>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub status_query: bool,
    pub provenance: &'static str,
}

/// Shared by the actual connection and its actors. This is an official-entry
/// supplement, not a capability invented inside the Agent's handshake.
pub(crate) struct Availability(AtomicBool);
impl Availability {
    pub(crate) fn new(supplement: Option<super::account_query::AccountQuery>) -> Arc<Self> {
        Arc::new(Self(AtomicBool::new(matches!(
            supplement,
            Some(super::account_query::AccountQuery::Vibe)
        ))))
    }
    pub(crate) fn capability(&self) -> Option<Capability> {
        self.0.load(Ordering::SeqCst).then_some(Capability {
            status_query: true,
            provenance: "reviewed-official-supplement",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustStatus {
    Trusted,
    Session,
    Untrusted,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OfferedDecision {
    TrustCwd,
    TrustRepo,
    Decline,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    pub cwd: String,
    pub repo_root: Option<String>,
    pub repo_scope_verified: bool,
    pub offered_decisions: Option<Vec<OfferedDecision>>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAccessStatus {
    pub connection_id: String,
    pub native_session_id: String,
    pub cwd: String,
    pub status: TrustStatus,
    pub details: Option<Details>,
}

fn absolute_directory(value: &Value) -> Result<PathBuf, AccessError> {
    let text = value
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 8192 && !s.chars().any(char::is_control))
        .ok_or(ErrorKind::InvalidResponse)?;
    let path = Path::new(text);
    if !path.is_absolute() {
        return Err(ErrorKind::InvalidResponse.into());
    }
    let path = path
        .canonicalize()
        .map_err(|_| ErrorKind::InvalidResponse)?;
    if !path.is_dir() {
        return Err(ErrorKind::InvalidResponse.into());
    }
    Ok(path)
}

fn optional_detail<'a>(
    object: &'a serde_json::Map<String, Value>,
    camel: &str,
    snake: &str,
) -> Result<Option<&'a Value>, AccessError> {
    // Official details serialize camelCase. Retain the controlled snake_case
    // compatibility, but never choose one side of contradictory aliases.
    let (camel, snake) = (object.get(camel), object.get(snake));
    if camel.zip(snake).is_some_and(|(a, b)| a != b) {
        return Err(ErrorKind::InvalidResponse.into());
    }
    Ok(camel.or(snake).filter(|value| !value.is_null()))
}

fn parse(value: &Value, request: &Request) -> Reply {
    // The SDK has already parsed the response. This is a projection budget,
    // not a claim of a pre-allocation transport/RSS bound.
    if serde_json::to_vec(value)
        .map_err(|_| ErrorKind::InvalidResponse)?
        .len()
        > 64 * 1024
    {
        return Err(ErrorKind::InvalidResponse.into());
    }
    let status = match value.get("trust_status").and_then(Value::as_str) {
        Some("trusted") => TrustStatus::Trusted,
        Some("session") => TrustStatus::Session,
        Some("untrusted") => TrustStatus::Untrusted,
        _ => return Err(ErrorKind::InvalidResponse.into()),
    };
    let details = match value.get("details").filter(|v| !v.is_null()) {
        None => None,
        Some(details) => {
            let object = details.as_object().ok_or(ErrorKind::InvalidResponse)?;
            if absolute_directory(object.get("cwd").ok_or(ErrorKind::InvalidResponse)?)?
                != request.cwd
            {
                return Err(ErrorKind::InvalidResponse.into());
            }
            let repo = optional_detail(object, "repoRoot", "repo_root")?
                .map(absolute_directory)
                .transpose()?;
            if repo
                .as_ref()
                .is_some_and(|root| !request.cwd.starts_with(root))
            {
                return Err(ErrorKind::InvalidResponse.into());
            }
            let decisions = optional_detail(object, "availableDecisions", "available_decisions")?
                .map(|v| {
                    let list = v
                        .as_array()
                        .filter(|a| a.len() <= 3)
                        .ok_or(ErrorKind::InvalidResponse)?;
                    let mut offered = Vec::new();
                    for v in list {
                        let decision = match v.as_str() {
                            Some("trust_cwd") => OfferedDecision::TrustCwd,
                            Some("trust_repo") => OfferedDecision::TrustRepo,
                            Some("decline") => OfferedDecision::Decline,
                            _ => return Err(AccessError::from(ErrorKind::InvalidResponse)),
                        };
                        if offered.contains(&decision) {
                            return Err(ErrorKind::InvalidResponse.into());
                        }
                        offered.push(decision);
                    }
                    Ok(offered)
                })
                .transpose()?;
            Some(Details {
                cwd: request.cwd.to_string_lossy().into(),
                repo_scope_verified: repo.is_some(),
                repo_root: repo.map(|p| p.to_string_lossy().into()),
                offered_decisions: decisions,
            })
        }
    };
    Ok(WorkspaceAccessStatus {
        connection_id: request.connection_id.clone(),
        native_session_id: request.session_id.clone(),
        cwd: request.cwd.to_string_lossy().into(),
        status,
        details,
    })
}

pub(crate) struct Request {
    pub(crate) connection_id: String,
    pub(crate) session_id: String,
    cwd: PathBuf,
    availability: Arc<Availability>,
    current_owner: Arc<dyn Fn() -> bool + Send + Sync>,
}
impl Request {
    pub(crate) fn matches(&self, connection_id: &str, session_id: &str) -> bool {
        self.connection_id == connection_id
            && self.session_id == session_id
            && (self.current_owner)()
    }
    async fn read(self, cx: ConnectionTo<Agent>) -> Reply {
        if !(self.current_owner)() {
            return Err(ErrorKind::Changed.into());
        }
        if self.availability.capability().is_none() {
            return Err(ErrorKind::Unavailable.into());
        }
        let message = UntypedMessage::new(
            "_trust/status",
            json!({"sessionId":self.session_id,"cwd":self.cwd}),
        )
        .map_err(|_| ErrorKind::QueryFailed)?;
        let value = match cx.send_request_to(Agent, message).block_task().await {
            Ok(value) => value,
            Err(error) if error.code == ErrorCode::MethodNotFound => {
                self.availability.0.store(false, Ordering::SeqCst);
                return Err(ErrorKind::Unavailable.into());
            }
            Err(_) => return Err(ErrorKind::QueryFailed.into()),
        };
        if !(self.current_owner)() {
            return Err(ErrorKind::Changed.into());
        }
        parse(&value, &self)
    }
}

/// Caller expiry ends delivery, not the actual outstanding read. The existing
/// lifecycle lease remains until the actual response or owning session actor termination.
/// No prompt unknown flag or persistent account-wide mutation scope is created.
pub(crate) struct Pending {
    reply: Option<oneshot::Sender<Reply>>,
    future: Pin<Box<dyn Future<Output = Reply> + Send>>,
    deadline: tokio::time::Instant,
    _lease: OperationLease,
    started: bool,
}
impl Pending {
    pub(crate) fn start(
        request: Request,
        cx: ConnectionTo<Agent>,
        reply: oneshot::Sender<Reply>,
        deadline: tokio::time::Instant,
        lease: OperationLease,
    ) -> Self {
        Self {
            reply: Some(reply),
            future: Box::pin(request.read(cx)),
            deadline,
            _lease: lease,
            started: false,
        }
    }
    async fn poll(&mut self) -> Option<Reply> {
        if let Some(reply) = &mut self.reply {
            if reply.is_closed() || tokio::time::Instant::now() >= self.deadline {
                if !self.started {
                    return Some(Err(ErrorKind::Timeout.into()));
                }
                if let Some(reply) = self.reply.take() {
                    let _ = reply.send(Err(ErrorKind::Timeout.into()));
                }
                return None;
            }
            tokio::select! {
                biased;
                _ = reply.closed() => {},
                _ = tokio::time::sleep_until(self.deadline) => {},
                value = std::future::poll_fn(|cx| { self.started = true; self.future.as_mut().poll(cx) }) => return Some(value),
            }
            if !self.started {
                return Some(Err(ErrorKind::Timeout.into()));
            }
            if let Some(reply) = self.reply.take() {
                let _ = reply.send(Err(ErrorKind::Timeout.into()));
            }
            None
        } else {
            Some(self.future.as_mut().await)
        }
    }
    pub(crate) fn complete(mut self, value: Reply) {
        let reply = self.reply.take();
        drop(self);
        if let Some(reply) = reply {
            let _ = reply.send(value);
        }
    }
}
pub(crate) async fn next(pending: &mut Option<Pending>) -> Option<Reply> {
    match pending {
        Some(pending) => pending.poll().await,
        None => std::future::pending().await,
    }
}

impl AcpManager {
    pub(crate) async fn workspace_access_status(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        connection_id: &str,
    ) -> Reply {
        let connection = self
            .session_connection(agent_id, cwd, session_id)
            .map_err(|_| ErrorKind::Changed)?;
        if connection.connection_id != connection_id {
            return Err(ErrorKind::Changed.into());
        }
        if connection.workspace_access.capability().is_none() {
            return Err(ErrorKind::Unavailable.into());
        }
        let control = {
            let entries = connection.sessions.lock().map_err(|_| ErrorKind::Changed)?;
            let entry = entries
                .get(session_id)
                .filter(|e| e.preview_token.is_none())
                .ok_or(ErrorKind::Changed)?;
            entry.control.clone()
        };
        let (manager, agent, directory, session, owner) = (
            self.clone(),
            agent_id.to_owned(),
            cwd.to_path_buf(),
            session_id.to_owned(),
            connection.clone(),
        );
        let current_owner = Arc::new(move || {
            manager
                .session_connection(&agent, &directory, &session)
                .is_ok_and(|c| {
                    c.connection_id == owner.connection_id && Arc::ptr_eq(&c.state, &owner.state)
                })
        });
        let request = Request {
            connection_id: connection_id.into(),
            session_id: session_id.into(),
            cwd: cwd.into(),
            availability: connection.workspace_access.clone(),
            current_owner,
        };
        let (result, receive) = oneshot::channel();
        control
            .send(super::pump::SessionControl::WorkspaceAccessStatus {
                request: Box::new(request),
                result,
                deadline: tokio::time::Instant::now() + BUDGET,
            })
            .map_err(|_| ErrorKind::Changed)?;
        let value = tokio::time::timeout(BUDGET + Duration::from_secs(1), receive)
            .await
            .map_err(|_| ErrorKind::Timeout)?
            .map_err(|_| ErrorKind::Changed)??;
        let current = self
            .session_connection(agent_id, cwd, session_id)
            .map_err(|_| ErrorKind::Changed)?;
        if current.connection_id != connection_id || !Arc::ptr_eq(&current.state, &connection.state)
        {
            return Err(ErrorKind::Changed.into());
        }
        Ok(value)
    }
}

pub(crate) fn capability(connection: &ManagedConnection) -> Option<Capability> {
    connection.workspace_access.capability()
}

#[tauri::command]
pub async fn session_workspace_access_status(
    app: tauri::AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
    connection_id: String,
) -> Reply {
    use tauri::Manager;
    let cwd = super::manager::validate_cwd_async(&cwd)
        .await
        .map_err(|_| ErrorKind::Changed)?;
    app.state::<AcpManager>()
        .workspace_access_status(&agent_id, &cwd, &session_id, &connection_id)
        .await
}

#[cfg(test)]
#[path = "workspace_access_tests.rs"]
mod tests;
