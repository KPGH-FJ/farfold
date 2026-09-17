use std::{path::PathBuf, sync::Arc};

use serde_json::Value;

use crate::acp_transport::{AcpDispatchError, AcpTransport};
use crate::runtime_registry::RuntimeIdentity;

pub(crate) type AcpResult<T> = Result<T, AcpAdapterError>;

/// Adapter-boundary failure. The Host needs the delivery status, not only a
/// message: a request that never reached the Runtime is safe to retry, while an
/// unknown result keeps its Host occupancy until it is reconciled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AcpAdapterError {
    /// The Runtime or its verified protocol has no such operation, or this
    /// Adapter does not implement it yet. Retrying cannot help.
    Unsupported(String),
    /// The request never reached the Runtime.
    NotSent(String),
    /// The Runtime received the request and rejected it. `code` and `data`
    /// preserve the native JSON-RPC rejection so the Host can branch on the
    /// structured reason instead of parsing a formatted message.
    Rejected { code: i64, data: Option<Value> },
    /// The request may or may not have been applied; the Host must re-check.
    Unknown(String),
}

impl AcpAdapterError {
    /// Message safe to surface to the user; never carries native error bodies.
    pub(crate) fn message(&self) -> String {
        match self {
            Self::Unsupported(message) | Self::NotSent(message) | Self::Unknown(message) => {
                message.clone()
            }
            Self::Rejected { code, data } => {
                let detail = data
                    .as_ref()
                    .and_then(|value| value.get("message"))
                    .and_then(Value::as_str);
                match detail {
                    Some(detail) => format!("ACP 请求失败（错误码 {code}）：{detail}"),
                    None => format!("ACP 请求失败（错误码 {code}）"),
                }
            }
        }
    }
}

impl std::fmt::Display for AcpAdapterError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message())
    }
}

impl From<AcpDispatchError> for AcpAdapterError {
    fn from(error: AcpDispatchError) -> Self {
        match error {
            AcpDispatchError::NotSent(message) => Self::NotSent(message.to_string()),
            AcpDispatchError::Rejected { code, data } => Self::Rejected { code, data },
            AcpDispatchError::Unknown(message) => Self::Unknown(message),
        }
    }
}

/// The Host-side contract every ACP Runtime Adapter implements.
///
/// The Adapter owns protocol translation only. It never owns an Agent loop, and
/// it never normalizes a Runtime-specific capability into shared Host semantics.
/// Responses stay `Value` where the verified ACP surface differs between
/// Runtimes, so an Adapter can preserve its native envelope.
///
/// Methods are synchronous: `AcpTransport` dispatch is a blocking primitive and
/// every production call site already runs inside `spawn_blocking`. Callers
/// must never poll these on an executor thread that may not block.
pub(crate) trait AcpRuntimeAdapter: Send + 'static {
    /// Runtime product, installation and adapter identity of this connection.
    /// Derived from the bound `RuntimeBinding`; never a fixed placeholder.
    /// Reserved for adapter-level diagnostics once Codex/Pi ACP join.
    #[allow(dead_code)]
    fn identity(&self) -> RuntimeIdentity;

    /// The pinned Runtime distribution version this Adapter accepts.
    #[allow(dead_code)]
    fn expected_adapter_version(&self) -> &str;

    /// Spawn the pinned Runtime binary and run `initialize`. The Adapter uses
    /// its own bound `RuntimeBinding` so connection identity stays single
    /// source; `cwd` is the Working Copy the Runtime process opens.
    fn spawn_and_initialize(&self, cwd: PathBuf) -> AcpResult<Arc<AcpTransport>>;

    /// `session/new`. The response carries at least `sessionId`, and for
    /// Runtimes that expose selection it also carries `configOptions`.
    fn new_session(&self, transport: &AcpTransport, working_copy: PathBuf) -> AcpResult<Value>;

    /// `session/load`. The response carries `configOptions` for Runtimes that
    /// expose selection; the native Session ID is the caller's input.
    fn load_session(
        &self,
        transport: &AcpTransport,
        native_session_id: String,
        working_copy: PathBuf,
    ) -> AcpResult<Value>;

    /// `session/close`. Production close is exercised through Host session
    /// teardown today; the method stays for adapters that need it.
    #[allow(dead_code)]
    fn close_session(
        &self,
        transport: &AcpTransport,
        native_session_id: String,
    ) -> AcpResult<Value>;

    /// `session/set_config_option`. Returns the native `configOptions` so the
    /// Host can confirm the applied value before writing any projection.
    fn set_config_option(
        &self,
        transport: &AcpTransport,
        native_session_id: String,
        option_id: String,
        value: Value,
        value_type: Option<String>,
    ) -> AcpResult<Value>;

    /// `session/prompt`. Returns the native terminal response, such as
    /// `{"stopReason": ...}`; it is not a Host Turn identifier.
    fn send_prompt(
        &self,
        transport: &AcpTransport,
        native_session_id: String,
        text: String,
    ) -> AcpResult<Value>;

    /// Runtime-native stop. `native_request` carries whatever extra identity a
    /// Runtime requires; OpenCode `session/cancel` needs only the Session.
    /// An accepted stop is an ACK, never a settled Turn.
    fn stop_turn(
        &self,
        transport: &AcpTransport,
        native_session_id: String,
        native_request: Value,
    ) -> AcpResult<Value>;

    /// Reply to an inbound Runtime request such as permission or elicitation.
    fn respond_client_request(
        &self,
        transport: &AcpTransport,
        request_id: &str,
        response: Value,
    ) -> AcpResult<()>;

    /// Pass the native event envelope through unchanged for the Host event
    /// router. Adapters preserve verified envelopes; shared presentation
    /// normalization happens in the router/UI, not here. Adapters must not
    /// drop or reshape Runtime events in this hook. Currently every verified
    /// adapter passes envelopes through unchanged.
    #[allow(dead_code)]
    fn map_event(&self, event: Value) -> AcpResult<Value>;
}
