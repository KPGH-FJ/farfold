//! One outstanding session mutation, polled alongside incoming events and stop.
use std::{future::Future, pin::Pin};

use serde_json::Value;
use tokio::sync::oneshot;

use super::{lifecycle::OperationLease, operations::Operation};

pub(crate) enum Kind {
    Config { permission_value: Option<Value> },
    Mode,
    Close,
    Delete,
}

pub(crate) enum Reply {
    Config(oneshot::Sender<Result<Value, String>>),
    Unit(oneshot::Sender<Result<(), String>>),
}
impl Reply {
    pub fn send(self, value: Result<Value, String>) {
        match self {
            Self::Config(reply) => {
                let _ = reply.send(value);
            }
            Self::Unit(reply) => {
                let _ = reply.send(value.map(|_| ()));
            }
        }
    }
    async fn closed(&mut self) {
        match self {
            Self::Config(reply) => reply.closed().await,
            Self::Unit(reply) => reply.closed().await,
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
}
impl Mutation {
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
            deadline,
            request: Box::pin(request),
        }
    }
    /// None means only delivery ended. Keep polling the same wire request; its
    /// reservation remains held until the actual response or connection shutdown.
    async fn poll(&mut self) -> Option<Result<Value, String>> {
        let Some(reply) = &mut self.reply else {
            return Some(self.request.as_mut().await);
        };
        tokio::select! {
            biased;
            _ = reply.closed() => {}
            _ = tokio::time::sleep_until(self.deadline) => {}
            result = std::future::poll_fn(|cx| { self.started = true; self.request.as_mut().poll(cx) }) => return Some(result),
        }
        if !self.started {
            return Some(Err("操作未发送，请重试".into()));
        }
        self.operation.abandon();
        if let Some(reply) = self.reply.take() {
            reply.send(Err(
                "Agent 无响应，设置结果尚未确认，请等待或断开后重试".into()
            ));
        }
        None
    }
}

pub(crate) async fn next(pending: &mut Option<Mutation>) -> Option<Result<Value, String>> {
    match pending {
        Some(mutation) => mutation.poll().await,
        None => std::future::pending().await,
    }
}
