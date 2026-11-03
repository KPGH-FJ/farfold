//! Explicit identity on an existing conversation. A reviewed supplement, not
//! authentication, entitlement, a handshake declaration or durable account data.
use super::manager::{AccountScope, AcpManager, ManagedConnection};
use agent_client_protocol::{
    Agent, ConnectionTo, Dispatch, ErrorCode, Role, UntypedMessage, schema::v1::RequestId,
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    future::Future,
    path::Path,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::oneshot;

const BUDGET: Duration = Duration::from_secs(10);
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Code {
    Unavailable,
    Changed,
    Busy,
    Timeout,
    InvalidResponse,
    QueryFailed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReadError {
    pub code: Code,
    pub message: &'static str,
}
impl From<Code> for ReadError {
    fn from(code: Code) -> Self {
        let message = match code {
            Code::Unavailable => "当前对话未提供身份读取方式",
            Code::Changed => "对话或设置已变化，请重新读取身份信息",
            Code::Busy => "当前正在处理其他操作，请稍后读取身份信息",
            Code::Timeout => "身份信息尚未读取完成，请稍后查看",
            Code::InvalidResponse => "未能核对返回的身份信息",
            Code::QueryFailed => "暂时无法读取身份信息",
        };
        Self { code, message }
    }
}
pub(crate) type Reply = Result<IdentityReply, ReadError>;
#[derive(Debug, Clone, Serialize)]
pub struct Capability {
    pub provenance: &'static str,
}
struct Witness {
    id: RequestId,
    observed: Arc<AtomicBool>,
}
pub(crate) struct Availability(AtomicBool, Mutex<Option<Witness>>);
impl Availability {
    pub(crate) fn new(reviewed: Option<super::account_query::AccountQuery>) -> Arc<Self> {
        Arc::new(Self(
            AtomicBool::new(matches!(
                reviewed,
                Some(super::account_query::AccountQuery::Vibe)
            )),
            Mutex::new(None),
        ))
    }
    pub(crate) fn capability(&self) -> Option<Capability> {
        self.0.load(Ordering::SeqCst).then_some(Capability {
            provenance: "reviewed-official-supplement",
        })
    }
    pub(crate) fn observe(&self, dispatch: &Dispatch<UntypedMessage, UntypedMessage>) {
        if let Dispatch::Response(_, router) = dispatch
            && router.method() == "_identity/read"
            && router.role_id() == Agent.role_id()
            && let Ok(slot) = self.1.lock()
            && let Some(witness) = slot.as_ref()
            && router.id() == &witness.id
        {
            witness.observed.store(true, Ordering::SeqCst);
        }
    }
    fn clear(&self, observed: &Arc<AtomicBool>) {
        if let Ok(mut slot) = self.1.lock()
            && slot
                .as_ref()
                .is_some_and(|w| Arc::ptr_eq(&w.observed, observed))
        {
            *slot = None;
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub workspace_name: Option<String>,
    pub organization_name: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityReply {
    pub connection_id: String,
    pub native_session_id: String,
    pub cwd: String,
    pub identity: Option<Identity>,
}
fn field(value: Option<&Value>, limit: usize) -> Result<Option<String>, ReadError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.len() <= limit && !s.chars().any(char::is_control) => {
            Ok((!s.trim().is_empty()).then(|| s.clone()))
        }
        _ => Err(Code::InvalidResponse.into()),
    }
}
fn entity(value: Option<&Value>) -> Result<Option<String>, ReadError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(object)) => field(object.get("name"), 256),
        _ => Err(Code::InvalidResponse.into()),
    }
}
fn parse(value: &Value) -> Result<Option<Identity>, ReadError> {
    // This is a post-SDK projection budget, not a transport allocation bound.
    if serde_json::to_vec(value)
        .map_err(|_| Code::InvalidResponse)?
        .len()
        > 16 * 1024
    {
        return Err(Code::InvalidResponse.into());
    }
    let object = value.as_object().ok_or(Code::InvalidResponse)?;
    let email = field(object.get("email"), 254)?;
    if email.as_ref().is_some_and(|s| {
        s.matches('@').count() != 1
            || s.starts_with('@')
            || s.ends_with('@')
            || s.chars().any(char::is_whitespace)
    }) {
        return Err(Code::InvalidResponse.into());
    }
    let first = field(object.get("firstName"), 256)?;
    let last = field(object.get("lastName"), 256)?;
    // Match the documented IdentityView.name fallback; no arbitrary displayName.
    let display_name = match (first, last) {
        (Some(first), Some(last)) => Some(format!("{first} {last}")),
        (Some(first), None) => Some(first),
        (None, _) => email.clone(),
    };
    if display_name.as_ref().is_some_and(|s| s.len() > 256) {
        return Err(Code::InvalidResponse.into());
    }
    let identity = Identity {
        email,
        display_name,
        workspace_name: entity(object.get("workspace"))?,
        organization_name: entity(object.get("organization"))?,
    };
    Ok((identity.email.is_some()
        || identity.display_name.is_some()
        || identity.workspace_name.is_some()
        || identity.organization_name.is_some())
    .then_some(identity))
}

pub(crate) struct Request {
    connection_id: String,
    session_id: String,
    cwd: String,
    availability: Arc<Availability>,
    current_owner: Arc<dyn Fn() -> bool + Send + Sync>,
}
impl Request {
    pub(crate) fn matches(&self, connection: &str, session: &str) -> bool {
        self.connection_id == connection && self.session_id == session && (self.current_owner)()
    }
    async fn run(
        self,
        cx: ConnectionTo<Agent>,
        life: Arc<super::lifecycle::ConnectionLife>,
        scope: AccountScope,
        result: oneshot::Sender<Reply>,
        deadline: tokio::time::Instant,
    ) {
        let gate = if tokio::time::Instant::now() >= deadline {
            Some(Code::Timeout)
        } else if !(self.current_owner)() {
            Some(Code::Changed)
        } else if self.availability.capability().is_none() {
            Some(Code::Unavailable)
        } else {
            None
        };
        if let Some(code) = gate {
            let _ = result.send(Err(code.into()));
            return;
        }
        let message =
            match UntypedMessage::new("_identity/read", json!({"sessionId":self.session_id})) {
                Ok(m) => m,
                Err(_) => {
                    let _ = result.send(Err(Code::QueryFailed.into()));
                    return;
                }
            };
        // Synchronous SDK send plus arm under the same short incoming lock.
        let sent = (|| {
            let mut slot = self.availability.1.lock().map_err(|_| Code::Busy)?;
            if slot.is_some() {
                return Err(Code::Busy);
            }
            let sent = cx.send_request_to(Agent, message);
            let observed = Arc::new(AtomicBool::new(false));
            *slot = Some(Witness {
                id: sent.id().clone(),
                observed: observed.clone(),
            });
            Ok((Box::pin(sent.block_task()), observed))
        })();
        let (future, observed) = match sent {
            Ok(v) => v,
            Err(code) => {
                let _ = result.send(Err(code.into()));
                return;
            }
        };
        let outcome = super::operations::until_owner_ended(&life, future).await;
        let witnessed = observed.load(Ordering::SeqCst);
        let reply = match outcome {
            Some(Ok(value)) if witnessed && (self.current_owner)() => {
                parse(&value).map(|identity| IdentityReply {
                    connection_id: self.connection_id,
                    native_session_id: self.session_id,
                    cwd: self.cwd,
                    identity,
                })
            }
            Some(Err(error)) if witnessed && error.code == ErrorCode::MethodNotFound => {
                self.availability.0.store(false, Ordering::SeqCst);
                Err(Code::Unavailable.into())
            }
            Some(Ok(_)) if witnessed => Err(Code::Changed.into()),
            _ => Err(Code::QueryFailed.into()),
        };
        if witnessed {
            self.availability.clear(&observed);
            drop(scope);
            let _ = result.send(reply);
        } else {
            let _ = result.send(reply);
            // SDK local/decode/EOF failure is not a response. This independent
            // owner survives actor/UI drop and retains admission to real reap.
            life.terminated().await;
            self.availability.clear(&observed);
            drop(scope);
        }
    }
}
pub(crate) struct Pending {
    reply: Option<oneshot::Sender<Reply>>,
    future: Pin<Box<dyn Future<Output = Reply> + Send>>,
    deadline: tokio::time::Instant,
    started: bool,
    invalidated: bool,
}
impl Pending {
    pub(crate) fn start(
        request: Request,
        cx: ConnectionTo<Agent>,
        reply: oneshot::Sender<Reply>,
        deadline: tokio::time::Instant,
        scope: AccountScope,
        life: Arc<super::lifecycle::ConnectionLife>,
    ) -> Self {
        let (start, started) = oneshot::channel();
        let (done, receive) = oneshot::channel();
        super::manager::runtime().spawn(async move {
            if started.await.is_ok() {
                request.run(cx, life, scope, done, deadline).await;
            }
        });
        Self {
            reply: Some(reply),
            future: Box::pin(async move {
                start.send(()).map_err(|_| ReadError::from(Code::Changed))?;
                receive.await.map_err(|_| ReadError::from(Code::Changed))?
            }),
            deadline,
            started: false,
            invalidated: false,
        }
    }
    pub(crate) fn observe(&mut self, dispatch: &agent_client_protocol::Dispatch) {
        if let agent_client_protocol::Dispatch::Notification(message) = dispatch
            && message.method() == "session/update"
            && matches!(
                message
                    .params()
                    .pointer("/update/sessionUpdate")
                    .and_then(Value::as_str),
                Some("config_option_update" | "current_model_update" | "current_mode_update")
            )
        {
            self.invalidated = true;
        }
    }
    async fn poll(&mut self) -> Option<Reply> {
        if let Some(reply) = &mut self.reply {
            if reply.is_closed() || tokio::time::Instant::now() >= self.deadline {
                if !self.started {
                    return Some(Err(Code::Timeout.into()));
                }
                if let Some(reply) = self.reply.take() {
                    let _ = reply.send(Err(Code::Timeout.into()));
                }
                return None;
            }
            tokio::select! {
                biased;
                _=reply.closed()=>{},
                _=tokio::time::sleep_until(self.deadline)=>{},
                result=std::future::poll_fn(|cx|{self.started=true;self.future.as_mut().poll(cx)})=>return Some(result),
            }
            if !self.started {
                return Some(Err(Code::Timeout.into()));
            }
            if let Some(reply) = self.reply.take() {
                let _ = reply.send(Err(Code::Timeout.into()));
            }
            None
        } else {
            Some(self.future.as_mut().await)
        }
    }
    pub(crate) fn complete(mut self, mut value: Reply) {
        if self.invalidated {
            value = Err(Code::Changed.into());
        }
        let reply = self.reply.take();
        drop(self);
        if let Some(reply) = reply {
            let _ = reply.send(value);
        }
    }
}
pub(crate) async fn next(pending: &mut Option<Pending>) -> Option<Reply> {
    match pending {
        Some(p) => p.poll().await,
        None => std::future::pending().await,
    }
}
pub(crate) fn capability(connection: &ManagedConnection) -> Option<Capability> {
    connection.identity_read.capability()
}
impl AcpManager {
    pub(crate) async fn identity_read(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        connection_id: &str,
    ) -> Reply {
        self.identity_read_until(
            agent_id,
            cwd,
            session_id,
            connection_id,
            tokio::time::Instant::now() + BUDGET,
        )
        .await
    }
    async fn identity_read_until(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        connection_id: &str,
        deadline: tokio::time::Instant,
    ) -> Reply {
        let connection = self
            .session_connection(agent_id, cwd, session_id)
            .map_err(|_| Code::Unavailable)?;
        if connection.connection_id != connection_id {
            return Err(Code::Changed.into());
        }
        let control = {
            let entries = connection.sessions.lock().map_err(|_| Code::Changed)?;
            entries
                .get(session_id)
                .filter(|e| e.preview_token.is_none())
                .ok_or(Code::Unavailable)?
                .control
                .clone()
        };
        if capability(&connection).is_none() {
            return Err(Code::Unavailable.into());
        }
        let (manager, agent, directory, session, owner, original_control) = (
            self.clone(),
            agent_id.to_owned(),
            cwd.to_path_buf(),
            session_id.to_owned(),
            connection.clone(),
            control.clone(),
        );
        let current_owner: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || {
            manager
                .session_connection(&agent, &directory, &session)
                .is_ok_and(|c| {
                    c.connection_id == owner.connection_id
                        && Arc::ptr_eq(&c.state, &owner.state)
                        && c.sessions.lock().is_ok_and(|entries| {
                            entries.get(&session).is_some_and(|e| {
                                e.preview_token.is_none()
                                    && e.control.same_channel(&original_control)
                            })
                        })
                })
        });
        let scope = self
            .workspace_access_configuration_scope(agent_id, &connection)
            .map_err(|_| Code::Busy)?;
        // An expired admission has no request to wait for. Letting it enter
        // the actor would race the manager timeout against the actor's reply.
        if tokio::time::Instant::now() >= deadline {
            return Err(Code::Changed.into());
        }
        let request = Request {
            connection_id: connection_id.into(),
            session_id: session_id.into(),
            cwd: cwd.to_string_lossy().into(),
            availability: connection.identity_read.clone(),
            current_owner: current_owner.clone(),
        };
        let (result, receive) = oneshot::channel();
        control
            .send(super::pump::SessionControl::IdentityRead {
                request: Box::new(request),
                scope,
                result,
                deadline,
            })
            .map_err(|_| Code::Changed)?;
        let value = tokio::time::timeout_at(deadline + Duration::from_secs(1), receive)
            .await
            .map_err(|_| Code::Timeout)?
            .map_err(|_| Code::Changed)??;
        if !current_owner() {
            return Err(Code::Changed.into());
        }
        Ok(value)
    }
}
#[tauri::command]
pub async fn session_identity_read(
    app: tauri::AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
    connection_id: String,
) -> Reply {
    use tauri::Manager;
    let cwd = super::manager::validate_cwd_async(&cwd)
        .await
        .map_err(|_| Code::Changed)?;
    app.state::<AcpManager>()
        .identity_read(&agent_id, &cwd, &session_id, &connection_id)
        .await
}
#[cfg(test)]
#[path = "identity_read_tests.rs"]
mod tests;
