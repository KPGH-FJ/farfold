//! One explicit official trust decision on the current connection. AccountScope
//! owns the effect; no account identity, event ledger or second Agent loop.
use super::super::{lifecycle::ConnectionLife, model_guard::ConfigCheck, pump::SessionControl};
use super::*;
use agent_client_protocol::{Dispatch, Role, schema::v1::RequestId};
use std::sync::Mutex;

const DECISION_BUDGET: Duration = Duration::from_secs(20);
type Wire = Pin<Box<dyn Future<Output = agent_client_protocol::Result<Value>> + Send>>;
pub(crate) type Reply = Result<WorkspaceAccessStatus, DecisionError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Code {
    Unavailable,
    Changed,
    Busy,
    NotOffered,
    ScopeChanged,
    Timeout,
    InvalidResponse,
    QueryFailed,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Effect {
    NotDispatched,
    Unconfirmed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DecisionError {
    pub code: Code,
    pub message: &'static str,
    pub effect: Effect,
}
impl DecisionError {
    pub(crate) fn new(code: Code, effect: Effect) -> Self {
        let message = match code {
            Code::Unavailable => "当前连接不支持修改文件夹信任状态",
            Code::Changed => "对话连接或文件夹已变化，请重新检查",
            Code::Busy => "请先完成当前任务及待处理事项，再检查文件夹信任状态",
            Code::NotOffered => "当前未提供此信任选项，请重新检查",
            Code::ScopeChanged => "文件夹信任范围已变化，请重新检查",
            Code::Timeout => "信任操作尚未确认，请等待结果后再检查",
            Code::InvalidResponse => "未能核对返回的文件夹信任状态",
            Code::QueryFailed => "暂时无法确认文件夹信任操作的结果",
        };
        Self {
            code,
            message,
            effect,
        }
    }
    pub(crate) fn rejected(code: Code) -> Self {
        Self::new(code, Effect::NotDispatched)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpectedScope {
    pub cwd: String,
    pub repo_root: Option<String>,
    pub repo_scope_verified: bool,
    pub offered_decisions: Vec<OfferedDecision>,
}
impl ExpectedScope {
    fn validate(&self, request: &Request, decision: OfferedDecision) -> Result<(), DecisionError> {
        if self.cwd != request.cwd.to_string_lossy()
            || self.offered_decisions.len() > 3
            || self
                .offered_decisions
                .iter()
                .enumerate()
                .any(|(i, d)| self.offered_decisions[..i].contains(d))
        {
            return Err(DecisionError::rejected(Code::ScopeChanged));
        }
        if !self.offered_decisions.contains(&decision) {
            return Err(DecisionError::rejected(Code::NotOffered));
        }
        let repo = self
            .repo_root
            .as_ref()
            .map(|s| absolute_directory(&json!(s)))
            .transpose()
            .map_err(|_| DecisionError::rejected(Code::ScopeChanged))?;
        if self.repo_scope_verified != repo.is_some()
            || repo.as_ref().is_some_and(|r| !request.cwd.starts_with(r))
            || (decision == OfferedDecision::TrustRepo && !self.repo_scope_verified)
        {
            return Err(DecisionError::rejected(Code::ScopeChanged));
        }
        Ok(())
    }
    fn matches(&self, status: &WorkspaceAccessStatus) -> bool {
        status.details.as_ref().is_some_and(|d| {
            d.cwd == self.cwd
                && d.repo_root == self.repo_root
                && d.repo_scope_verified == self.repo_scope_verified
                && d.offered_decisions.as_ref() == Some(&self.offered_decisions)
        })
    }
}

struct WitnessEntry {
    id: RequestId,
    observed: Arc<AtomicBool>,
}
#[derive(Default)]
pub(crate) struct Witness(Mutex<Option<WitnessEntry>>);
pub(crate) struct Sent {
    future: Wire,
    observed: Arc<AtomicBool>,
}
impl Availability {
    /// Observe without consuming or changing the original SDK dispatch.
    pub(crate) fn observe_decision(&self, dispatch: &Dispatch<UntypedMessage, UntypedMessage>) {
        if let Dispatch::Response(_, router) = dispatch
            && router.method() == "_trust/decision"
            && router.role_id() == Agent.role_id()
            && let Ok(slot) = self.2.0.lock()
            && let Some(entry) = slot.as_ref()
            && router.id() == &entry.id
        {
            entry.observed.store(true, Ordering::SeqCst);
        }
    }
    fn send_decision(
        &self,
        cx: &ConnectionTo<Agent>,
        request: &Request,
        decision: OfferedDecision,
        before_send: impl FnOnce(),
    ) -> Result<Sent, DecisionError> {
        let message = UntypedMessage::new(
            "_trust/decision",
            json!({"sessionId":request.session_id,"cwd":request.cwd,"decision":decision}),
        )
        .map_err(|_| DecisionError::rejected(Code::QueryFailed))?;
        // SDK enqueue is synchronous and precedes SentRequest's return. The
        // incoming hook takes this same short lock, so an immediate response
        // cannot pass between send and registration. No await under this lock.
        let mut slot = self
            .2
            .0
            .lock()
            .map_err(|_| DecisionError::rejected(Code::Busy))?;
        if slot.is_some() {
            return Err(DecisionError::rejected(Code::Busy));
        }
        before_send();
        let sent = cx.send_request_to(Agent, message);
        let observed = Arc::new(AtomicBool::new(false));
        *slot = Some(WitnessEntry {
            id: sent.id().clone(),
            observed: observed.clone(),
        });
        Ok(Sent {
            future: Box::pin(sent.block_task()),
            observed,
        })
    }
    fn clear(&self, observed: &Arc<AtomicBool>) {
        if let Ok(mut slot) = self.2.0.lock()
            && slot
                .as_ref()
                .is_some_and(|e| Arc::ptr_eq(&e.observed, observed))
        {
            *slot = None;
        }
    }
}

#[derive(Clone, PartialEq)]
pub(crate) struct Snapshot {
    pub model: ConfigCheck,
    pub permission: Value,
}
pub(crate) struct Admission {
    pub snapshot: Snapshot,
    pub cx: ConnectionTo<Agent>,
}
pub(crate) struct Commit {
    pub request: Request,
    pub decision: OfferedDecision,
    pub snapshot: Snapshot,
    pub interested: Arc<AtomicBool>,
}
impl Commit {
    pub(crate) fn dispatch(
        self,
        cx: &ConnectionTo<Agent>,
        before_send: impl FnOnce(),
    ) -> Result<Sent, DecisionError> {
        self.request
            .availability
            .send_decision(cx, &self.request, self.decision, before_send)
    }
}

#[cfg(test)]
#[path = "workspace_access_decision_tests.rs"]
mod tests;
fn map_read(error: AccessError) -> DecisionError {
    DecisionError::rejected(match error.code {
        ErrorKind::Unavailable => Code::Unavailable,
        ErrorKind::Changed => Code::Changed,
        ErrorKind::Busy => Code::Busy,
        ErrorKind::Timeout => Code::Timeout,
        ErrorKind::InvalidResponse => Code::InvalidResponse,
        ErrorKind::QueryFailed => Code::QueryFailed,
    })
}
fn deliver(reply: &mut Option<oneshot::Sender<Reply>>, value: Reply) {
    if let Some(reply) = reply.take() {
        let _ = reply.send(value);
    }
}
fn complete(
    scope: &mut Option<super::super::manager::AccountScope>,
    reply: &mut Option<oneshot::Sender<Reply>>,
    value: Reply,
) {
    drop(scope.take());
    deliver(reply, value);
}

/// Ownership is independent of the caller and actor. Only a witnessed response
/// or actual original process reap ends an effectful operation's AccountScope.
async fn run(
    request: Request,
    decision: OfferedDecision,
    expected: ExpectedScope,
    control: tokio::sync::mpsc::UnboundedSender<SessionControl>,
    life: Arc<ConnectionLife>,
    scope: super::super::manager::AccountScope,
    reply: oneshot::Sender<Reply>,
) {
    let mut scope = Some(scope);
    let mut reply = Some(reply);
    if reply.as_ref().is_some_and(oneshot::Sender::is_closed) {
        return;
    }
    let deadline = tokio::time::Instant::now() + DECISION_BUDGET;
    let (tx, rx) = oneshot::channel();
    if control
        .send(SessionControl::WorkspaceAccessDecision {
            request: Box::new(request.clone()),
            result: tx,
            deadline,
        })
        .is_err()
    {
        complete(
            &mut scope,
            &mut reply,
            Err(DecisionError::rejected(Code::Changed)),
        );
        return;
    }
    let admission = match tokio::time::timeout_at(deadline, rx).await {
        Ok(Ok(Ok(value))) => value,
        Ok(Ok(Err(error))) => {
            complete(&mut scope, &mut reply, Err(error));
            return;
        }
        Err(_) => {
            complete(
                &mut scope,
                &mut reply,
                Err(DecisionError::rejected(Code::Timeout)),
            );
            return;
        }
        Ok(Err(_)) => {
            complete(
                &mut scope,
                &mut reply,
                Err(DecisionError::rejected(Code::Changed)),
            );
            return;
        }
    };
    if reply.as_ref().is_some_and(oneshot::Sender::is_closed) {
        return;
    }
    let mut read = Box::pin(super::super::operations::until_owner_ended(
        &life,
        request.clone().read(admission.cx),
    ));
    let status = tokio::select! {biased;
        value=&mut read=>value,
        // These exits cannot reach Commit. Keep observing this read without
        // retaining account-wide protection for an effect that will not occur.
        _=reply.as_mut().unwrap().closed()=>{drop(scope.take());let _=read.await;return;},
        _=tokio::time::sleep_until(deadline)=>{
            drop(scope.take());deliver(&mut reply,Err(DecisionError::rejected(Code::Timeout)));let _=read.await;return;
        }
    };
    let status = match status {
        Some(Ok(value)) => value,
        Some(Err(error)) => {
            complete(&mut scope, &mut reply, Err(map_read(error)));
            return;
        }
        None => {
            complete(
                &mut scope,
                &mut reply,
                Err(DecisionError::rejected(Code::Changed)),
            );
            return;
        }
    };
    if !expected.matches(&status) {
        complete(
            &mut scope,
            &mut reply,
            Err(DecisionError::rejected(Code::ScopeChanged)),
        );
        return;
    }
    if reply.as_ref().is_none_or(oneshot::Sender::is_closed) {
        return;
    }
    if !(request.current_owner)() {
        complete(
            &mut scope,
            &mut reply,
            Err(DecisionError::rejected(Code::Changed)),
        );
        return;
    }
    let interested = Arc::new(AtomicBool::new(true));
    let (tx, rx) = oneshot::channel();
    let commit = Commit {
        request: request.clone(),
        decision,
        snapshot: admission.snapshot,
        interested: interested.clone(),
    };
    if control
        .send(SessionControl::WorkspaceAccessDecisionCommit {
            request: Box::new(commit),
            result: tx,
            deadline,
        })
        .is_err()
    {
        complete(
            &mut scope,
            &mut reply,
            Err(DecisionError::rejected(Code::Changed)),
        );
        return;
    }
    let mut rx = Box::pin(rx);
    let sent = tokio::select! {biased;
        value=&mut rx=>value,
        _=reply.as_mut().unwrap().closed()=>{interested.store(false,Ordering::SeqCst);rx.await},
        _=tokio::time::sleep_until(deadline)=>{
            interested.store(false,Ordering::SeqCst);
            // Actor may have dispatched immediately before this deadline.
            deliver(&mut reply,Err(DecisionError::new(Code::Timeout,Effect::Unconfirmed)));rx.await
        }
    };
    let mut sent = match sent {
        Ok(Ok(sent)) => sent,
        Ok(Err(error)) => {
            complete(&mut scope, &mut reply, Err(error));
            return;
        }
        Err(_) => {
            deliver(
                &mut reply,
                Err(DecisionError::new(Code::Changed, Effect::Unconfirmed)),
            );
            life.terminated().await;
            return;
        }
    };
    let mut actual = Box::pin(super::super::operations::until_owner_ended(
        &life,
        sent.future.as_mut(),
    ));
    let result = if reply.is_some() {
        tokio::select! {biased;
            value=&mut actual=>value,
            _=reply.as_mut().unwrap().closed()=>actual.await,
            _=tokio::time::sleep_until(deadline)=>{
                deliver(&mut reply,Err(DecisionError::new(Code::Timeout,Effect::Unconfirmed)));actual.await
            }
        }
    } else {
        actual.await
    };
    let witnessed = sent.observed.load(Ordering::SeqCst);
    let outcome = match result {
        Some(Ok(value)) if witnessed && (request.current_owner)() => parse(&value, &request)
            .map_err(|_| DecisionError::new(Code::InvalidResponse, Effect::Unconfirmed)),
        Some(Err(error)) if witnessed && error.code == ErrorCode::MethodNotFound => {
            request.availability.1.store(false, Ordering::SeqCst);
            Err(DecisionError::new(Code::Unavailable, Effect::Unconfirmed))
        }
        _ => Err(DecisionError::new(Code::QueryFailed, Effect::Unconfirmed)),
    };
    if witnessed {
        request.availability.clear(&sent.observed);
        drop(scope.take());
    }
    deliver(&mut reply, outcome);
    // SDK errors also represent local/decode/EOF failures. A false witness is
    // not an error response and cannot establish whether a write happened.
    if !witnessed {
        life.terminated().await;
    }
    request.availability.clear(&sent.observed);
}

impl AcpManager {
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn workspace_access_decide(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        connection_id: &str,
        decision: OfferedDecision,
        expected: ExpectedScope,
    ) -> Reply {
        let connection = self
            .session_connection(agent_id, cwd, session_id)
            .map_err(|_| DecisionError::rejected(Code::Changed))?;
        if connection.connection_id != connection_id {
            return Err(DecisionError::rejected(Code::Changed));
        }
        if !connection
            .workspace_access
            .capability()
            .is_some_and(|c| c.decision_management)
        {
            return Err(DecisionError::rejected(Code::Unavailable));
        }
        let control = connection
            .sessions
            .lock()
            .map_err(|_| DecisionError::rejected(Code::Changed))?
            .get(session_id)
            .filter(|e| e.preview_token.is_none())
            .ok_or_else(|| DecisionError::rejected(Code::Changed))?
            .control
            .clone();
        let (manager, agent, directory, session, owner) = (
            self.clone(),
            agent_id.to_owned(),
            cwd.to_path_buf(),
            session_id.to_owned(),
            connection.clone(),
        );
        let owner_control = control.clone();
        let current_owner = Arc::new(move || {
            !owner_control.is_closed()
                && manager
                    .session_connection(&agent, &directory, &session)
                    .is_ok_and(|c| {
                        c.connection_id == owner.connection_id
                            && Arc::ptr_eq(&c.state, &owner.state)
                    })
        });
        let request = Request {
            connection_id: connection_id.into(),
            session_id: session_id.into(),
            cwd: cwd.into(),
            availability: connection.workspace_access.clone(),
            current_owner,
        };
        expected.validate(&request, decision)?;
        let scope = self
            .workspace_access_configuration_scope(agent_id, &connection)
            .map_err(|_| DecisionError::rejected(Code::Busy))?;
        let (tx, rx) = oneshot::channel();
        super::super::manager::runtime().spawn(run(
            request,
            decision,
            expected,
            control,
            connection.life.clone(),
            scope,
            tx,
        ));
        rx.await
            .unwrap_or_else(|_| Err(DecisionError::new(Code::QueryFailed, Effect::Unconfirmed)))
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn session_workspace_access_decide(
    app: tauri::AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
    connection_id: String,
    decision: OfferedDecision,
    expected_scope: ExpectedScope,
) -> Reply {
    use tauri::Manager;
    let cwd = super::super::manager::validate_cwd_async(&cwd)
        .await
        .map_err(|_| DecisionError::rejected(Code::Changed))?;
    app.state::<AcpManager>()
        .workspace_access_decide(
            &agent_id,
            &cwd,
            &session_id,
            &connection_id,
            decision,
            expected_scope,
        )
        .await
}
