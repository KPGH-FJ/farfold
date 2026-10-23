//! Ownership of the existing connection commands, including abandoned callers.
use super::{
    lifecycle::{ConnectionLife, OperationLease},
    manager::ManagerCommand,
    pump::{self, PendingPermissions, SessionMap, SessionOps},
};
use agent_client_protocol::schema::v1::{AuthenticateRequest, DeleteSessionRequest};
use agent_client_protocol::{Agent, ConnectionTo, SentRequest};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{oneshot, watch};

#[cfg(test)]
mod auth_result_tests;
#[cfg(test)]
mod list_result_tests;
mod open_result;
pub(crate) use open_result::OpenDelivery;
mod owned_reply;
pub(crate) use owned_reply::until_owner_ended;

#[derive(Clone)]
pub(crate) struct Operation {
    pub abandoned: Arc<AtomicBool>,
    cancel: watch::Sender<bool>,
    events: Option<pump::SessionSink>,
    history: Option<super::history_admission::Permit>,
}

impl Operation {
    pub fn new() -> Self {
        Self {
            abandoned: Arc::new(AtomicBool::new(false)),
            cancel: watch::channel(false).0,
            events: None,
            history: None,
        }
    }
    pub(super) fn with_history(
        mut self,
        history: Option<super::history_admission::Permit>,
    ) -> Self {
        self.history = history;
        self
    }
    pub(super) fn history(&self) -> Option<super::history_admission::Permit> {
        self.history.clone()
    }
    /// A live route observes interest after opening ends. It must not retain
    /// the opening's admission; only the real operation/delivery owners do.
    pub(super) fn observer(&self) -> Self {
        Self {
            abandoned: self.abandoned.clone(),
            cancel: self.cancel.clone(),
            events: self.events.clone(),
            history: None,
        }
    }
    pub(crate) fn with_events(mut self, events: pump::SessionSink) -> Self {
        self.events = Some(events);
        self
    }
    pub fn abandon(&self) {
        self.abandoned.store(true, Ordering::SeqCst);
        self.cancel.send_replace(true);
    }
    pub fn interested(&self) -> bool {
        !self.abandoned.load(Ordering::SeqCst)
    }
    /// Existing command abandonment also bounds local setup waits before send.
    pub async fn cancelled(&self) {
        let mut cancellation = self.cancel.subscribe();
        if !*cancellation.borrow() {
            let _ = cancellation.changed().await;
        }
    }

    pub async fn request<T>(
        &self,
        cx: &ConnectionTo<Agent>,
        request: SentRequest<T>,
    ) -> Result<T, agent_client_protocol::Error> {
        let id = request.id().clone();
        let mut cancellation = self.cancel.subscribe();
        if *cancellation.borrow() {
            request.cancel()?;
        }
        let response = request.block_task();
        tokio::pin!(response);
        tokio::select! {
            result = &mut response => result,
            _ = cancellation.changed() => { let _ = cx.send_cancel_request_to(Agent, id); response.await }
        }
    }
}

pub(crate) struct QueuedCommand {
    pub command: ManagerCommand,
    pub deadline: tokio::time::Instant,
    pub _lease: OperationLease,
}

impl super::manager::ManagedConnection {
    pub fn send(&self, command: ManagerCommand) -> Result<(), String> {
        self.send_reserved(command, None)
    }
    pub fn send_reserved(
        &self,
        command: ManagerCommand,
        opening: Option<super::lifecycle::OpenReservation>,
    ) -> Result<(), String> {
        self.send_reserved_with_history(command, opening, None)
    }
    pub(super) fn send_reserved_with_history(
        &self,
        command: ManagerCommand,
        opening: Option<super::lifecycle::OpenReservation>,
        history: Option<super::history_admission::Permit>,
    ) -> Result<(), String> {
        let lease = self
            .life
            .operation_with_history(command.operation_key(), history)?
            .with_opening(opening);
        let deadline = tokio::time::Instant::now() + command.budget();
        self.command_tx
            .send(QueuedCommand {
                command,
                deadline,
                _lease: lease,
            })
            .map_err(|_| "连接已结束，请重新连接".to_string())
    }
}

impl ManagerCommand {
    fn budget(&self) -> Duration {
        Duration::from_secs(match self {
            Self::Authenticate { .. } | Self::Logout { .. } => 60,
            Self::OpenSession { .. } => 120,
            Self::ListSessions { .. } | Self::DeleteSession { .. } => 30,
            Self::AccountStatus { .. } => 5,
        })
    }
    pub(crate) fn operation_key(&self) -> String {
        match self {
            Self::Authenticate { .. } | Self::Logout { .. } | Self::AccountStatus { .. } => {
                "authentication".into()
            }
            Self::ListSessions { .. } => "list".into(),
            Self::OpenSession {
                native_session_id, ..
            } => format!("open:{}", native_session_id.as_deref().unwrap_or("new")),
            Self::DeleteSession { session_id, .. } => format!("open:{session_id}"),
        }
    }
}

/// A caller deadline ends delivery, never ownership. Effectful operations retain
/// their one reservation until the peer responds or the connection actually ends.
pub(crate) async fn execute<T>(
    mut reply: oneshot::Sender<Result<T, String>>,
    life: Arc<ConnectionLife>,
    operation: Operation,
    deadline: tokio::time::Instant,
    retain: bool,
    future: impl std::future::Future<Output = Result<T, String>>,
) -> Option<T> {
    if reply.is_closed()
        || tokio::time::Instant::now() >= deadline
        || *life.stop_receiver().borrow()
    {
        operation.abandon();
        return None;
    }
    let mut stop = life.stop_receiver();
    tokio::pin!(future);
    let mut started = false;
    let mut unclaimed = false;
    let outcome = tokio::select! {
        biased;
        _ = stop.changed() => { operation.abandon(); let _ = reply.send(Err("连接已结束".into())); return None; }
        _ = reply.closed() => None,
        _ = tokio::time::sleep_until(deadline) => None,
        value = std::future::poll_fn(|cx| { started = true; future.as_mut().poll(cx) }) => Some(value),
        _ = life.routes.unclaimed_pressure() => { unclaimed = true; None },
    };
    if let Some(outcome) = outcome {
        return reply.send(outcome).err().and_then(Result::ok);
    }
    operation.abandon();
    if !started {
        let _ = reply.send(Err("操作未发送，请重试".into()));
        return None;
    }
    let message = if unclaimed {
        "Agent 在确认对话前发送了过多消息，操作结果尚未确认；请检查此连接，不要重复创建"
    } else {
        "Agent 无响应，操作结果尚未确认"
    };
    let _ = reply.send(Err(message.into()));
    if !retain {
        return None;
    }
    tokio::select! {
        _ = stop.changed() => None,
        outcome = &mut future => outcome.ok(),
    }
}

async fn execute_list<T>(
    reply: oneshot::Sender<Result<T, String>>,
    life: Arc<ConnectionLife>,
    operation: Operation,
    deadline: tokio::time::Instant,
    lease: OperationLease,
    future: impl std::future::Future<Output = Result<T, String>>,
) -> Option<T> {
    let settled = async move {
        let outcome = future.await;
        // A real list result can wake a caller on another executor immediately.
        // Finish this read reservation before admitting its next page or retry.
        drop(lease);
        outcome
    };
    // If execute exits early or abandons this read, dropping the unpolled/pending
    // future also releases its lease. Effectful command ownership is unchanged.
    execute(reply, life, operation, deadline, false, settled).await
}

pub(crate) fn authentication_error(error: agent_client_protocol::Error) -> String {
    // Keep arbitrary provider data and possible credentials out of the auth UI.
    if error.code == agent_client_protocol::schema::v1::ErrorCode::AuthRequired {
        "AUTH_REQUIRED".into()
    } else if error.code == agent_client_protocol::Error::request_cancelled().code {
        "AUTH_CANCELLED".into()
    } else {
        "账号操作未完成，请检查后重试".into()
    }
}

async fn authentication_result(
    reply: oneshot::Sender<Result<(), String>>,
    life: Arc<ConnectionLife>,
    deadline: tokio::time::Instant,
    on_unknown: Arc<dyn Fn() + Send + Sync>,
    lease: OperationLease,
    future: impl std::future::Future<Output = Result<(), String>>,
) {
    let mut stop = life.stop_receiver();
    if *stop.borrow() || tokio::time::Instant::now() >= deadline {
        drop(lease);
        let _ = reply.send(Err("账号操作未开始，请重试".into()));
        return;
    }
    tokio::pin!(future);
    let outcome = tokio::select! {
        outcome = &mut future => outcome,
        _ = stop.changed() => Err("AUTH_CONNECTION_CLOSED".into()),
        _ = tokio::time::sleep_until(deadline) => {
            on_unknown();
            // A timeout only ends the initial wait. Do not abandon the only
            // result receiver or release account scope before a real outcome.
            tokio::select! {
                outcome = &mut future => outcome,
                _ = stop.changed() => Err("AUTH_CONNECTION_CLOSED".into()),
            }
        }
    };
    // The receiver may immediately retry on another executor. Unknown outcomes
    // keep this lease through the final wait; closing transfers it to process reap.
    drop(lease);
    let _ = reply.send(outcome);
}

pub(crate) async fn run(
    queued: QueuedCommand,
    cx: ConnectionTo<Agent>,
    cwd: PathBuf,
    sessions: SessionMap,
    pending: PendingPermissions,
    ops: SessionOps,
) {
    let QueuedCommand {
        command,
        deadline,
        _lease,
    } = queued;
    let operation = Operation::new().with_history(_lease.history());
    match command {
        ManagerCommand::AccountStatus { query, result } => {
            execute(
                result,
                ops.life.clone(),
                operation,
                deadline,
                false,
                async { Ok(query.read(&cx).await) },
            )
            .await;
        }
        ManagerCommand::Authenticate {
            method_id,
            key,
            operation,
            on_unknown,
            result,
        } => {
            if !operation.interested() {
                drop(_lease);
                let _ = result.send(Err("AUTH_CANCELLED".into()));
                return;
            }
            authentication_result(
                result,
                ops.life.clone(),
                deadline,
                on_unknown,
                _lease,
                async move {
                    let request = match key {
                        Some(key) => key.into_request(method_id),
                        None => AuthenticateRequest::new(method_id),
                    };
                    let events = operation.events.clone().unwrap_or_else(|| Arc::new(|_| {}));
                    ops.inquiries
                        .request(&operation, &cx, || cx.send_request(request), events)
                        .await
                        .map(|_| ())
                        .map_err(authentication_error)
                },
            )
            .await;
        }
        ManagerCommand::Logout {
            route,
            account,
            effect_sent,
            operation,
            on_unknown,
            result,
        } => {
            if !operation.interested() {
                drop(_lease);
                let _ = result.send(Err("AUTH_CANCELLED".into()));
                return;
            }
            authentication_result(
                result,
                ops.life.clone(),
                deadline,
                on_unknown,
                _lease,
                route.execute(&cx, &operation, &account, &effect_sent),
            )
            .await;
        }
        ManagerCommand::ListSessions {
            cwd,
            cursor,
            all_pages,
            result,
        } => {
            execute_list(
                result,
                ops.life.clone(),
                operation,
                deadline,
                _lease,
                pump::list_sessions_on_connection(
                    &cx,
                    cwd.as_deref(),
                    cursor.as_deref(),
                    all_pages,
                ),
            )
            .await;
        }
        ManagerCommand::DeleteSession { session_id, result } => {
            execute(
                result,
                ops.life.clone(),
                operation.clone(),
                deadline,
                true,
                async {
                    operation
                        .request(
                            &cx,
                            cx.send_request_to(Agent, DeleteSessionRequest::new(session_id)),
                        )
                        .await
                        .map(|_| ())
                        .map_err(pump::describe_acp_error)
                },
            )
            .await;
        }
        ManagerCommand::OpenSession {
            fork_owned,
            native_session_id,
            preview_token,
            opening_token,
            recorded_config,
            config_store,
            config_options,
            mcp,
            browser_unavailable,
            events,
            result,
        } => {
            let mut ops = ops;
            ops.opening = _lease.opening();
            let life = ops.life.clone();
            let future = pump::open_session_on_connection(
                &cx,
                &cwd,
                native_session_id,
                preview_token,
                opening_token,
                recorded_config,
                *config_store,
                config_options,
                events,
                &sessions,
                &pending,
                ops,
                operation.clone(),
                mcp,
                browser_unavailable,
            );
            if fork_owned {
                open_result::execute_owned_open(
                    result,
                    life,
                    operation,
                    _lease,
                    sessions.clone(),
                    future,
                )
                .await;
                return;
            }
            open_result::execute_open(
                result,
                life,
                operation.clone(),
                deadline,
                _lease,
                sessions.clone(),
                future,
            )
            .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn authentication_timeout_keeps_final_response_and_ownership() {
        let life = ConnectionLife::new();
        life.ready().unwrap();
        let account = life.operation("account_change".into()).unwrap();
        let (reply, mut receive) = oneshot::channel();
        let (finish, result) = oneshot::channel();
        let (unknown, mut observed) = tokio::sync::mpsc::unbounded_channel();
        let task_life = life.clone();
        let task = tokio::spawn(async move {
            let _account = account;
            let lease = task_life.operation("authentication".into()).unwrap();
            authentication_result(
                reply,
                task_life,
                tokio::time::Instant::now() + Duration::from_millis(5),
                Arc::new(move || {
                    let _ = unknown.send(());
                }),
                lease,
                async { result.await.map_err(|_| "fixture".into()) },
            )
            .await;
        });
        tokio::time::timeout(Duration::from_secs(1), observed.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(receive.try_recv().is_err());
        assert!(life.work().is_err());
        assert!(life.operation("authentication".into()).is_err());
        finish.send(()).unwrap();
        receive.await.unwrap().unwrap();
        task.await.unwrap();
        assert!(life.work().is_ok());
    }

    #[tokio::test]
    async fn deadline_retains_effectful_ownership_until_terminal_response() {
        let life = ConnectionLife::new();
        life.ready().unwrap();
        let lease = life.operation("authentication".into()).unwrap();
        let (reply, receive) = oneshot::channel();
        let (terminal, done) = oneshot::channel();
        let task_life = life.clone();
        let task = tokio::spawn(async move {
            let _lease = lease;
            execute(
                reply,
                task_life,
                Operation::new(),
                tokio::time::Instant::now() + Duration::from_millis(5),
                true,
                async { done.await.map_err(|_| "fixture closed".into()) },
            )
            .await
        });
        assert!(receive.await.unwrap().unwrap_err().contains("尚未确认"));
        assert!(!life.close(false, Some(Duration::ZERO)).unwrap());
        assert!(life.operation("authentication".into()).is_err());
        terminal.send(7).unwrap();
        assert_eq!(task.await.unwrap(), Some(7));
        assert!(life.close(false, Some(Duration::ZERO)).unwrap());
    }

    #[tokio::test]
    async fn already_expired_queued_request_never_starts() {
        let life = ConnectionLife::new();
        life.ready().unwrap();
        let (reply, receive) = oneshot::channel::<Result<(), String>>();
        let dispatched = AtomicBool::new(false);
        execute(
            reply,
            life,
            Operation::new(),
            tokio::time::Instant::now(),
            true,
            async {
                dispatched.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .await;
        assert!(!dispatched.load(Ordering::SeqCst));
        assert!(receive.await.is_err());
    }
}
