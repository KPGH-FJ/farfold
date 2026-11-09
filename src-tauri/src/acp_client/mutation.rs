//! One outstanding session mutation, polled alongside incoming events and stop.
use std::{future::Future, pin::Pin};

use serde_json::Value;
use tokio::sync::oneshot;

use super::{lifecycle::OperationLease, operations::Operation};

pub(crate) enum Kind {
    Restore {
        plan: Box<super::pump::restore_config::Plan>,
        request: super::session_config::ConfigRequest,
    },
    Config {
        request: super::session_config::ConfigRequest,
        permission_value: Option<Value>,
        choice: Option<super::model_guard::Choice>,
        prior_guard: Option<Box<super::model_guard::ModelGuard>>,
        config_store: Option<Box<super::model_guard::ConfigStore>>,
    },
    Mode,
    Close,
    StoppedToolClose(super::pump::StoppedToolCloseReceipt),
    Delete,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DeleteFailure {
    NotDispatched,
    Unconfirmed(String),
}

pub(crate) enum Reply {
    Open(oneshot::Sender<Result<super::pump::restore_config::OpenState, String>>),
    Config(oneshot::Sender<Result<Value, String>>),
    Unit(oneshot::Sender<Result<(), String>>),
    Delete(oneshot::Sender<Result<(), DeleteFailure>>),
    StoppedToolClose(oneshot::Sender<Result<super::pump::StoppedToolCloseReceipt, String>>),
}
impl Reply {
    fn is_closed(&self) -> bool {
        match self {
            Self::Open(reply) => reply.is_closed(),
            Self::Config(reply) => reply.is_closed(),
            Self::Unit(reply) => reply.is_closed(),
            Self::Delete(reply) => reply.is_closed(),
            Self::StoppedToolClose(reply) => reply.is_closed(),
        }
    }
    pub fn send(self, value: Result<Value, String>) {
        match self {
            Self::Open(reply) => {
                let _ = reply.send(Err(value
                    .err()
                    .unwrap_or_else(|| "恢复结果尚未确认，请重新检查此对话".into())));
            }
            Self::Config(reply) => {
                let _ = reply.send(value);
            }
            Self::Unit(reply) => {
                let _ = reply.send(value.map(|_| ()));
            }
            Self::Delete(reply) => {
                let _ = reply.send(value.map(|_| ()).map_err(DeleteFailure::Unconfirmed));
            }
            Self::StoppedToolClose(reply) => {
                let _ = reply.send(Err(value
                    .err()
                    .unwrap_or_else(|| "关闭结果尚未确认，请等待".into())));
            }
        }
    }
    pub(super) fn reject_before_dispatch(self, error: String) {
        match self {
            Self::Delete(reply) => {
                let _ = reply.send(Err(DeleteFailure::NotDispatched));
            }
            other => other.send(Err(error)),
        }
    }
    async fn closed(&mut self) {
        match self {
            Self::Open(reply) => reply.closed().await,
            Self::Config(reply) => reply.closed().await,
            Self::Unit(reply) => reply.closed().await,
            Self::Delete(reply) => reply.closed().await,
            Self::StoppedToolClose(reply) => reply.closed().await,
        }
    }
}

pub(crate) struct Mutation {
    pub kind: Kind,
    pub reply: Option<Reply>,
    request: Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>,
    operation: Operation,
    deadline: tokio::time::Instant,
    _lease: OperationLease,
    started: bool,
    actual_reply: bool,
}
impl Mutation {
    pub(crate) fn awaiting_reply(&self) -> bool {
        self.operation.interested()
            && tokio::time::Instant::now() < self.deadline
            && self.reply.as_ref().is_some_and(|reply| !reply.is_closed())
    }
    pub(crate) fn started(&self) -> bool {
        self.started
    }
    pub(crate) fn finish(mut self, outcome: Result<Value, String>) {
        let reply = self.reply.take();
        let started = self.started;
        // A waiting caller may immediately request an account operation.
        // Release the actual mutation lease before waking that caller.
        drop(self);
        if let Some(reply) = reply {
            match outcome {
                Err(error) if !started => reply.reject_before_dispatch(error),
                outcome => reply.send(outcome),
            }
        }
    }
    pub(crate) fn finish_stopped_tool_close(
        mut self,
        outcome: Result<super::pump::StoppedToolCloseReceipt, String>,
    ) -> bool {
        let reply = self.reply.take();
        let deadline = self.deadline;
        drop(self);
        let Some(Reply::StoppedToolClose(reply)) = reply else {
            return false;
        };
        if outcome.is_ok() && tokio::time::Instant::now() >= deadline {
            let _ = reply.send(Err("关闭结果尚未确认，请等待".into()));
            return false;
        }
        reply.send(outcome).is_ok()
    }
    pub(crate) fn finish_open(
        mut self,
        outcome: Result<super::pump::restore_config::OpenState, String>,
    ) {
        let reply = self.reply.take();
        drop(self);
        if let Some(Reply::Open(reply)) = reply {
            let _ = reply.send(outcome);
        }
    }
    pub(crate) fn continue_request(
        mut self,
        request: impl Future<Output = Result<Value, String>> + Send + 'static,
    ) -> Self {
        self.request = Box::pin(request);
        self.started = false;
        self
    }
    pub fn new(
        kind: Kind,
        reply: Reply,
        operation: Operation,
        lease: OperationLease,
        deadline: tokio::time::Instant,
        request: impl Future<Output = Result<Value, String>> + Send + 'static,
    ) -> Self {
        Self {
            kind,
            reply: Some(reply),
            operation,
            _lease: lease,
            started: false,
            actual_reply: false,
            deadline,
            request: Box::pin(request),
        }
    }
    /// The fork handoff owns delivery beyond the public IPC wait. Ordinary
    /// close/configuration callers retain their existing bounded delivery.
    pub(crate) fn until_actual_reply(mut self) -> Self {
        self.actual_reply = true;
        self
    }
    /// None means only delivery ended. Keep polling the same wire request; its
    /// reservation remains held until the actual response or connection shutdown.
    async fn poll(&mut self) -> Option<Result<Value, String>> {
        if self.actual_reply {
            self.started = true;
            return Some(self.request.as_mut().await);
        }
        let Some(reply) = &mut self.reply else {
            return Some(self.request.as_mut().await);
        };
        let operation = self.operation.clone();
        // A newly registered timer can initially return Pending even when its
        // deadline has passed. Never give a fresh request its first poll then.
        if !reply.is_closed()
            && operation.interested()
            && tokio::time::Instant::now() < self.deadline
        {
            tokio::select! {
                biased;
                _ = reply.closed() => {}
                _ = operation.cancelled() => {}
                _ = tokio::time::sleep_until(self.deadline) => {}
                result = std::future::poll_fn(|cx| { self.started = true; self.request.as_mut().poll(cx) }) => return Some(result),
            }
        }
        if !self.started {
            return Some(Err("操作未发送，请重试".into()));
        }
        self.operation.abandon();
        if let Some(reply) = self.reply.take() {
            let error = if matches!(self.kind, Kind::StoppedToolClose(_)) {
                "关闭结果尚未确认，请等待"
            } else {
                "Agent 无响应，设置结果尚未确认，请等待或断开后重试"
            };
            reply.send(Err(error.into()));
        }
        None
    }
}

#[cfg(test)]
mod restore_tests;
#[cfg(test)]
mod tests;

pub(crate) async fn next(pending: &mut Option<Mutation>) -> Option<Result<Value, String>> {
    match pending {
        Some(mutation) => mutation.poll().await,
        None => std::future::pending().await,
    }
}
