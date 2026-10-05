//! Per-session runtime: message routing, the session pump task, and the
//! event shapes pushed to the frontend.
//!
//! Each opened session registers a [`SessionRoute`] dynamic handler on the
//! connection. Every agent→client message carrying that `sessionId` is
//! forwarded into the session's inbox; the pump task owns the inbox, the
//! control channel (prompt/cancel/set-config/close), and the per-session
//! event sink that reaches the frontend `Channel`.
//!
//! Event JSON pushed to the sink:
//! - session/update params verbatim: `{"sessionId": ..., "update": {...}}`
//!   (raw passthrough — unknown `sessionUpdate` kinds and `_meta` survive).
//! - `{"kind": "permissionRequest", "requestId", "request", "toolCall", "options"}`
//! - `{"kind": "elicitation", "requestId", "message", "schema", "toolCallId"?}`
//! - `{"kind": "turnEnd", "stopReason"}` or `{"kind": "turnEnd", "error"}`
//! - `{"kind": "notification", "method", "params"}` for other session-scoped
//!   notifications (extension methods).
//! - `{"kind": "connectionLost"}` when the process dies or disconnects.

use super::lifecycle::{ConnectionLife, WorkLease};
use super::mutation::{self, Kind as MutationKind, Mutation, Reply as MutationReply};
use super::operations::Operation;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, PromptRequest, SessionConfigOptionValue,
    SessionConfigValueId, SessionModeState, SetSessionModeRequest,
};
use agent_client_protocol::{
    Agent, ConnectionTo, Dispatch, DynamicHandlerGuard, HandleDispatchFrom, Handled,
    RequestCancellation, Responder, UntypedMessage,
};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

#[cfg(test)]
#[path = "preparation_mode_tests.rs"]
mod preparation_mode_tests;

#[cfg(test)]
#[path = "pump/restore_tests.rs"]
mod restore_tests;

#[path = "config_change.rs"]
mod config_change;
use config_change::{complete_choice_change, save_confirmed_change};

#[path = "pump/open.rs"]
mod open;
pub(crate) use open::open_session_on_connection;
#[path = "pump/restore_config.rs"]
pub(crate) mod restore_config;

/// Frontend event sink: wraps `tauri::ipc::Channel`; tests pass a collector.
pub(crate) type SessionSink = Arc<dyn Fn(Value) + Send + Sync>;

/// requestId → responder for pending `session/request_permission` calls.
/// Owned by [`crate::acp_client::manager::AcpManager`], shared with every
/// session pump.
pub(crate) struct PendingPermission {
    pub responder: Option<Responder<Value>>,
    pub cancelled: RequestCancellation,
    _completed: oneshot::Sender<()>,
    pub session_id: String,
    pub options: Vec<String>,
    /// The owning connection's open-request gauge — every removal path
    /// (answer, cancel, pump exit) decrements it.
    pub lease: WorkLease,
}
pub(crate) type PendingPermissions = Arc<Mutex<HashMap<String, PendingPermission>>>;

fn cancel_permissions(pending: &PendingPermissions, ids: &mut Vec<String>) {
    if let Ok(mut map) = pending.lock() {
        for id in ids.drain(..) {
            if let Some(request) = map.remove(&id)
                && let Some(responder) = request.responder
            {
                let _ = responder.respond(serde_json::json!({"outcome":{"outcome":"cancelled"}}));
            }
        }
    }
}

fn model_ids(options: &Value) -> Vec<String> {
    options
        .as_array()
        .into_iter()
        .flatten()
        .filter(|o| {
            o.get("category").and_then(Value::as_str) == Some("model")
                || o.get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|v| v.to_ascii_lowercase().contains("model"))
                || o.get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|v| v.to_ascii_lowercase().contains("model"))
        })
        .filter_map(|o| o.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect()
}

/// requestId → responder for pending `elicitation/create` calls. Same
/// lifecycle as [`PendingPermissions`].
pub(crate) struct PendingElicitation {
    pub responder: Option<Responder<Value>>,
    pub cancelled: RequestCancellation,
    _completed: oneshot::Sender<()>,
    pub session_id: String,
    /// The owning connection's open-request gauge (see PendingPermission).
    pub lease: WorkLease,
}
pub(crate) type PendingElicitations = Arc<Mutex<HashMap<String, PendingElicitation>>>;

fn cancel_elicitations(pending: &PendingElicitations, ids: &mut Vec<String>) {
    if let Ok(mut map) = pending.lock() {
        for id in ids.drain(..) {
            if let Some(request) = map.remove(&id)
                && let Some(responder) = request.responder
            {
                let _ = responder.respond(serde_json::json!({"action":"cancel"}));
            }
        }
    }
}

/// Per-connection state shared by session pumps. Admission and idle recycling
/// use one lifecycle owner; unknown operations retain their reservation.
#[derive(Clone)]
pub(crate) struct SessionOps {
    pub(crate) opening: Option<super::lifecycle::OpenReservation>,
    pub(crate) connection_id: String,
    pub(crate) verify_identity: super::manager::SessionIdentityCheck,
    pub elicitations: PendingElicitations,
    /// Unanswered permission/elicitation requests plus in-flight prompts —
    /// while >0 the connection is mid-interaction and must not be reaped.
    pub life: Arc<ConnectionLife>,
}

impl SessionOps {
    pub(crate) fn verify_session_identity(
        &self,
        session_id: &str,
        resumed: bool,
        identity: &mut super::lifecycle::OpenIdentity,
    ) -> Result<(), String> {
        if let Some(opening) = (self.verify_identity)(session_id, resumed)? {
            identity.replace(opening);
        }
        Ok(())
    }
}

/// session_id → live session handle, one map per `(agent_id, cwd)` connection.
pub(crate) type SessionMap = Arc<Mutex<HashMap<String, SessionEntry>>>;

/// Everything needed to reach a live session from the command layer.
pub(crate) struct SessionEntry {
    pub(crate) preview_token: Option<String>,
    pub(crate) browser_unavailable: Option<super::transient_mcp::McpUnavailable>,
    pub control: mpsc::UnboundedSender<SessionControl>,
    pub events: SessionSink,
    /// Keeps the dynamic session handler registered; dropping unregisters it.
    _guard: DynamicHandlerGuard<Agent>,
    _mcp_lease: Option<super::transient_mcp::SessionMcpLease>,
    _retention: super::lifecycle::SessionRetention,
}

impl SessionEntry {
    pub(crate) fn abandon(self) {
        let _ = self.control.send(SessionControl::Shutdown);
        self._retention.retain_until_terminated();
    }
}

/// Commands delivered to the session pump task.
pub(crate) enum SessionControl {
    Prompt {
        blocks: Vec<ContentBlock>,
        deadline: tokio::time::Instant,
        result: oneshot::Sender<Result<(), String>>,
    },
    Cancel {
        deadline: tokio::time::Instant,
        result: oneshot::Sender<Result<(), String>>,
    },
    SetConfig {
        config_id: String,
        value: Value,
        deadline: tokio::time::Instant,
        result: oneshot::Sender<Result<Value, String>>,
    },
    ConfirmConfig {
        displayed: Value,
        deadline: tokio::time::Instant,
        result: oneshot::Sender<Result<Value, String>>,
    },
    /// `session/set_mode` — agents that expose `modes` outside
    /// `configOptions` (the synthetic `mode` option in the UI calls this).
    SetMode {
        mode_id: String,
        deadline: tokio::time::Instant,
        result: oneshot::Sender<Result<(), String>>,
    },
    Close {
        /// Automatic read cleanup must preserve newly arrived interactions.
        require_idle_interactions: bool,
        deadline: tokio::time::Instant,
        result: oneshot::Sender<Result<(), String>>,
    },
    /// `session/delete` — removes the session agent-side, then ends the pump.
    Delete {
        deadline: tokio::time::Instant,
        result: oneshot::Sender<Result<(), String>>,
    },
    /// Detach a live local route only after this pump confirms it is idle.
    Detach {
        deadline: tokio::time::Instant,
        result: oneshot::Sender<Result<(), String>>,
    },
    /// Metadata mutation serialized with this session's prompt/config admission.
    Archive {
        row: Box<crate::meta_store::SessionRow>,
        canonical_cwd: String,
        reservations: Vec<super::lifecycle::OpenReservation>,
        admission: crate::managed_update::ActivityPermit,
        deadline: tokio::time::Instant,
        result: oneshot::Sender<Result<crate::meta_store::SessionRow, String>>,
    },
    /// Local teardown without a protocol call (connection already dead).
    Shutdown,
}

impl SessionControl {
    fn abandoned(&self) -> bool {
        let (deadline, closed) = match self {
            Self::Prompt {
                deadline, result, ..
            }
            | Self::Cancel { deadline, result }
            | Self::SetMode {
                deadline, result, ..
            }
            | Self::Close {
                deadline, result, ..
            }
            | Self::Detach { deadline, result }
            | Self::Delete { deadline, result } => (*deadline, result.is_closed()),
            Self::SetConfig {
                deadline, result, ..
            }
            | Self::ConfirmConfig {
                deadline, result, ..
            } => (*deadline, result.is_closed()),
            Self::Archive {
                deadline, result, ..
            } => (*deadline, result.is_closed()),
            Self::Shutdown => return false,
        };
        closed || tokio::time::Instant::now() >= deadline
    }
}

/// Result of opening a session inside the connection task.
pub(crate) struct OpenedSession {
    pub(crate) identity: super::lifecycle::OpenIdentity,
    pub connection_id: String,
    pub session_id: String,
    /// Raw `session/new`/`session/load` response JSON. Raw passthrough keeps
    /// extension fields the typed schema drops (e.g. `models`).
    pub response: Value,
    /// Latest `configOptions` array after applying requested overrides.
    pub config_options: Option<Value>,
    pub config_check: super::model_guard::ConfigCheck,
    pub permission_config_id: Option<String>,
    pub permission_state: &'static str,
    pub warnings: Vec<String>,
}

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);

fn next_request_id() -> String {
    format!(
        "req-{}-{}",
        super::tap::now_millis(),
        REQUEST_COUNTER.fetch_add(1, Ordering::SeqCst)
    )
}

pub(crate) fn describe_acp_error(error: agent_client_protocol::Error) -> String {
    if error.code == agent_client_protocol::schema::v1::ErrorCode::AuthRequired {
        return "AUTH_REQUIRED".into();
    }
    match &error.data {
        Some(data) => format!("{error} | data={data}"),
        None => error.to_string(),
    }
}

/// `sessionId` carried by a dispatch's params, if any.
fn session_id_of(dispatch: &Dispatch) -> Option<&str> {
    dispatch
        .message()
        .and_then(|message| message.params().get("sessionId"))
        .and_then(Value::as_str)
}

/// Dynamic handler that claims every dispatch carrying `session_id` and
/// forwards it into the session pump's inbox.
struct SessionRoute {
    session_id: String,
    inbox: mpsc::UnboundedSender<Dispatch>,
    abandoned: Arc<AtomicBool>,
}

impl SessionRoute {
    fn new(
        session_id: &str,
        inbox: mpsc::UnboundedSender<Dispatch>,
        abandoned: Arc<AtomicBool>,
    ) -> Self {
        Self {
            session_id: session_id.to_string(),
            inbox,
            abandoned,
        }
    }
}

impl HandleDispatchFrom<Agent> for SessionRoute {
    async fn handle_dispatch_from(
        &mut self,
        message: Dispatch,
        _cx: ConnectionTo<Agent>,
    ) -> Result<Handled<Dispatch>, agent_client_protocol::Error> {
        if session_id_of(&message) == Some(self.session_id.as_str()) {
            if self.abandoned.load(Ordering::SeqCst) {
                if let Dispatch::Request(_, responder) = message {
                    let _ = responder
                        .respond_with_error(agent_client_protocol::Error::request_cancelled());
                }
                return Ok(Handled::Yes);
            }
            return match self.inbox.send(message) {
                Ok(()) => Ok(Handled::Yes),
                // Pump is gone: decline so requests still get an error
                // response instead of hanging forever.
                Err(error) => Ok(Handled::No {
                    message: error.0,
                    retry: false,
                }),
            };
        }
        Ok(Handled::No {
            message,
            retry: false,
        })
    }

    fn describe_chain(&self) -> impl std::fmt::Debug {
        format!("farfold-session({})", self.session_id)
    }
}

/// A public dynamic-handler guard queues removal on drop. The handler itself
/// is dropped by the incoming actor when it processes that removal (or when
/// the connection is torn down), after earlier route registrations were handled.
/// It claims no protocol messages and never sends a request to the Agent.
struct RouteRegistrationFence(Option<oneshot::Sender<()>>);

impl Drop for RouteRegistrationFence {
    fn drop(&mut self) {
        if let Some(ready) = self.0.take() {
            let _ = ready.send(());
        }
    }
}

impl HandleDispatchFrom<Agent> for RouteRegistrationFence {
    async fn handle_dispatch_from(
        &mut self,
        message: Dispatch,
        _cx: ConnectionTo<Agent>,
    ) -> Result<Handled<Dispatch>, agent_client_protocol::Error> {
        Ok(Handled::No {
            message,
            retry: false,
        })
    }

    fn describe_chain(&self) -> impl std::fmt::Debug {
        "farfold-route-registration"
    }
}

pub(super) async fn await_route_registration(
    cx: &ConnectionTo<Agent>,
    operation: &Operation,
) -> Result<(), String> {
    let (ready, receive) = oneshot::channel();
    let fence = cx
        .add_dynamic_handler(RouteRegistrationFence(Some(ready)))
        .map_err(describe_acp_error)?;
    drop(fence);
    tokio::select! {
        biased;
        _ = operation.cancelled() => Err("对话打开已取消，请重试".into()),
        result = receive => result.map_err(|_| "对话连接已结束，请重试".into()),
    }
}

/// Coerce a JSON value into a `session/set_config_option` value: bare strings
/// become select-style value ids, bare booleans become boolean options, and
/// objects are decoded as the protocol shape (`{type, value}`).
pub(crate) fn parse_config_value(value: &Value) -> Result<SessionConfigOptionValue, String> {
    match value {
        Value::Bool(flag) => Ok(SessionConfigOptionValue::boolean(*flag)),
        Value::String(id) => Ok(SessionConfigOptionValue::value_id(
            SessionConfigValueId::new(id.as_str()),
        )),
        Value::Object(_) => serde_json::from_value::<SessionConfigOptionValue>(value.clone())
            .map_err(|error| format!("invalid config option value: {error}")),
        _ => Err("config option value must be a string, boolean, or object".to_string()),
    }
}

/// Only top-level declarations without a real mode config option produce the
/// synthetic `mode` choice. A real id or category always keeps its config route.
fn synthetic_mode_state(response: &Value, options: Option<&Value>) -> Option<SessionModeState> {
    if options.and_then(Value::as_array).is_some_and(|options| {
        options
            .iter()
            .any(|option| option["id"] == "mode" || option["category"] == "mode")
    }) {
        return None;
    }
    serde_json::from_value::<SessionModeState>(response.get("modes")?.clone())
        .ok()
        .filter(|modes| !modes.available_modes.is_empty())
}

async fn restore_synthetic_mode(
    cx: &ConnectionTo<Agent>,
    session_id: &str,
    response: &mut Value,
    modes: SessionModeState,
    value: &Value,
    operation: &Operation,
) -> Result<(), String> {
    let mode_id = value.as_str().ok_or("使用模式必须是字符串")?;
    if !modes
        .available_modes
        .iter()
        .any(|mode| mode.id.0.as_ref() == mode_id)
    {
        return Err("Agent 未提供所选使用模式，请重新读取后选择".into());
    }
    if !operation.interested() {
        return Err("设置已取消，结果尚未确认".into());
    }
    operation
        .request(
            cx,
            cx.send_request_to(
                Agent,
                SetSessionModeRequest::new(session_id.to_owned(), mode_id.to_owned()),
            ),
        )
        .await
        .map_err(describe_acp_error)?;
    if !operation.interested() {
        return Err("设置已取消，结果尚未确认".into());
    }
    // The official response has no state payload: its successful receipt admits
    // this declared choice. Preserve the raw mode metadata and other options.
    response["modes"]["currentModeId"] = Value::String(mode_id.to_owned());
    Ok(())
}

/// `{kind:"turnEnd"}` event for a finished prompt request.
fn turn_end_event(outcome: Result<Value, String>) -> Value {
    match outcome {
        Ok(response) => {
            let mut event = serde_json::Map::new();
            event.insert("kind".to_string(), Value::String("turnEnd".to_string()));
            if let Some(stop_reason) = response.get("stopReason") {
                event.insert("stopReason".to_string(), stop_reason.clone());
            }
            if let Some(meta) = response.get("_meta") {
                event.insert("meta".to_string(), meta.clone());
            }
            Value::Object(event)
        }
        Err(error) => serde_json::json!({"kind": "turnEnd", "error": error}),
    }
}

/// Per-session context the dispatch handler needs beyond the dispatch:
/// the event sink, the shared pending-request registries, and the ids
/// cleaned up when the pump exits.
struct DispatchContext<'a> {
    session_id: &'a str,
    events: &'a SessionSink,
    pending: &'a PendingPermissions,
    ops: &'a SessionOps,
    permission_ids: &'a mut Vec<String>,
    elicitation_ids: &'a mut Vec<String>,
    expirations: &'a mpsc::UnboundedSender<String>,
    tools: &'a mut super::tool_activity::ToolActivity,
}

fn observe_cancellation(
    responder: &Responder<Value>,
    id: &str,
    expirations: &mpsc::UnboundedSender<String>,
) -> (RequestCancellation, oneshot::Sender<()>) {
    let marker = responder.cancellation();
    let cancellation = marker.clone();
    let (completed, done) = oneshot::channel();
    let (id, expirations) = (id.to_owned(), expirations.clone());
    super::manager::runtime().spawn(async move {
        tokio::select! {
            _ = done => {}
            _ = cancellation.cancelled() => { let _ = expirations.send(id); }
        }
    });
    (marker, completed)
}

/// Handle one session-scoped dispatch: forward notifications to the frontend
/// and serve agent→client requests (permission, elicitation).
fn handle_session_dispatch(dispatch: Dispatch, ctx: &mut DispatchContext<'_>) {
    ctx.ops.life.touch();
    match dispatch {
        Dispatch::Notification(message) => {
            if message.method() == "session/update" {
                let activity = ctx.tools.observe(message.params());
                // Raw passthrough: the params object is the update envelope,
                // unknown fields and `_meta` survive untouched.
                (ctx.events)(message.params().clone());
                if let Some(activity) = activity {
                    (ctx.events)(activity);
                }
                if let Some(output) = super::terminal_output::output_event(message.params()) {
                    (ctx.events)(output);
                }
            } else {
                (ctx.events)(serde_json::json!({
                    "kind": "notification",
                    "method": message.method(),
                    "params": message.params(),
                }));
            }
        }
        Dispatch::Request(message, responder) => {
            let method = message.method();
            let params = message.params().clone();
            match method {
                "session/request_permission" => {
                    let request_id = next_request_id();
                    match ctx.pending.lock() {
                        Ok(mut map) => {
                            let Ok(lease) = ctx.ops.life.work() else {
                                let _ = responder.respond_with_error(
                                    agent_client_protocol::Error::request_cancelled(),
                                );
                                return;
                            };
                            let (cancelled, completed) =
                                observe_cancellation(&responder, &request_id, ctx.expirations);
                            map.insert(
                                request_id.clone(),
                                PendingPermission {
                                    responder: Some(responder),
                                    cancelled,
                                    _completed: completed,
                                    lease,
                                    session_id: ctx.session_id.to_string(),
                                    options: params
                                        .get("options")
                                        .and_then(Value::as_array)
                                        .into_iter()
                                        .flatten()
                                        .filter_map(|o| {
                                            o.get("optionId")
                                                .and_then(Value::as_str)
                                                .map(str::to_owned)
                                        })
                                        .collect(),
                                },
                            );
                            ctx.permission_ids.push(request_id.clone());
                            (ctx.events)(serde_json::json!({
                                "kind": "permissionRequest",
                                "requestId": request_id,
                                "request": params.clone(),
                                "toolCall": params.get("toolCall").cloned().unwrap_or(Value::Null),
                                "options": params.get("options").cloned().unwrap_or(Value::Null),
                            }));
                        }
                        Err(_) => {
                            let _ = responder.respond_with_error(
                                agent_client_protocol::util::internal_error(
                                    "permission map lock poisoned",
                                ),
                            );
                        }
                    }
                }
                "elicitation/create" => {
                    let mode = params.get("mode").and_then(Value::as_str);
                    if mode != Some("form") {
                        (ctx.events)(
                            serde_json::json!({"kind":"elicitationUnavailable","params":params}),
                        );
                        let _ = responder.respond(serde_json::json!({"action":"cancel"}));
                        return;
                    }
                    let request_id = next_request_id();
                    match ctx.ops.elicitations.lock() {
                        Ok(mut map) => {
                            let Ok(lease) = ctx.ops.life.work() else {
                                let _ = responder.respond_with_error(
                                    agent_client_protocol::Error::request_cancelled(),
                                );
                                return;
                            };
                            let (cancelled, completed) =
                                observe_cancellation(&responder, &request_id, ctx.expirations);
                            map.insert(
                                request_id.clone(),
                                PendingElicitation {
                                    responder: Some(responder),
                                    cancelled,
                                    _completed: completed,
                                    session_id: ctx.session_id.to_owned(),
                                    lease,
                                },
                            );
                            ctx.elicitation_ids.push(request_id.clone());
                            (ctx.events)(serde_json::json!({
                                "kind": "elicitation",
                                "requestId": request_id,
                                "message": params.get("message").cloned().unwrap_or(Value::Null),
                                "schema": params.get("requestedSchema").cloned().unwrap_or(Value::Null),
                                "toolCallId": params.get("toolCallId").cloned().unwrap_or(Value::Null),
                            }));
                        }
                        Err(_) => {
                            let _ = responder.respond_with_error(
                                agent_client_protocol::util::internal_error(
                                    "elicitation map lock poisoned",
                                ),
                            );
                        }
                    }
                }
                _ => {
                    let _ =
                        responder.respond_with_error(agent_client_protocol::util::internal_error(
                            format!("farfold does not implement {method}"),
                        ));
                }
            }
        }
        Dispatch::Response(..) => {}
    }
}

/// The session pump: owns one session's inbox, control channel, and event
/// sink for the life of the session. Exits when the inbox or control channel
/// closes (session closed or connection dead), then unregisters its pending
/// permission/elicitation requests.
#[allow(clippy::too_many_arguments)]
async fn session_pump(
    cx: ConnectionTo<Agent>,
    session_id: String,
    mut inbox: mpsc::UnboundedReceiver<Dispatch>,
    mut control: mpsc::UnboundedReceiver<SessionControl>,
    events: SessionSink,
    pending: PendingPermissions,
    sessions: SessionMap,
    ops: SessionOps,
    mut configuration: super::session_config::SessionConfig,
    mut models: Vec<String>,
    mut model_guard: super::model_guard::ModelGuard,
    mut permission_guard: super::permission_guard::PermissionGuard,
    mut config_store: super::model_guard::ConfigStore,
    opening: restore_config::Opening,
) {
    let mut opening = Some(opening);
    let mut detached = None;
    let mut stopping = ops.life.stop_receiver();
    let mut mutation: Option<Mutation> = None;
    let mut pending_config_store = None;
    let (turn_tx, mut turn_rx) = mpsc::unbounded_channel::<Result<Value, String>>();
    let mut permission_ids: Vec<String> = Vec::new();
    let mut prompt_in_flight = false;
    let mut prompt_lease = None;
    let mut tools = super::tool_activity::ToolActivity::new(ops.life.clone());
    let mut failures = super::failures::FailureTracker::default();
    let mut elicitation_ids: Vec<String> = Vec::new();
    let (expiry_tx, mut expiry_rx) = mpsc::unbounded_channel::<String>();
    loop {
        let mut ctx = DispatchContext {
            session_id: &session_id,
            events: &events,
            pending: &pending,
            ops: &ops,
            permission_ids: &mut permission_ids,
            elicitation_ids: &mut elicitation_ids,
            expirations: &expiry_tx,
            tools: &mut tools,
        };
        tokio::select! {
            // `biased` polls in order: queued session messages are always
            // delivered before a turn result, so `turnEnd` lands after every
            // update the agent sent before the prompt response.
            biased;
            _ = stopping.changed() => break,
            dispatch = inbox.recv() => match dispatch {
                Some(dispatch) => {
                    if let Dispatch::Notification(message) = &dispatch
                        && message.method() == "session/update"
                        && message.params().pointer("/update/sessionUpdate").and_then(Value::as_str) == Some("session_info_update")
                        && let Some(meta) = message.params().pointer("/update/_meta") {
                        failures.observe(meta, prompt_in_flight);
                    }
                    let options = configuration.observe(&dispatch);
                    if let Some(options) = &options {
                        models.extend(model_ids(options));
                        model_guard.observe(options);
                                if !options.is_array() { model_guard.change_unknown(); }
                        permission_guard.observe(options);
                        restore_config::update(options, &mut opening, &mut mutation);
                        if opening.is_none() {
                            events(permission_guard.event());
                            events(serde_json::json!({"kind":"configCheck", "check":model_guard.check()}));
                        }
                    }
                    handle_session_dispatch(dispatch, &mut ctx);
                    if let Some(options) = options { events(super::session_config::projection(options)); }
                }
                None => break,
            },
            // Publish open completion only after the already received replay
            // prefix has reached the sink. Do not use a timing delay here.
            () = std::future::ready(()), if opening.as_ref().is_some_and(|opening| opening.reply.is_some()) && mutation.is_none() => {
                events(ctx.tools.event());
                let source = config_store.validate_service().await;
                restore_config::drain(&mut inbox, &mut ctx, &mut configuration, &mut models, &mut model_guard,
                    &mut permission_guard, &mut opening, &mut mutation);
                let initial = opening.as_ref().expect("opening exists");
                let plan = if !initial.operation.interested()
                    || initial.reply.as_ref().is_none_or(|reply| reply.is_closed()) {
                    Err("恢复结果尚未确认，请重新检查此对话".to_string())
                } else if let Err(error) = source { Err(error) }
                else { restore_config::Plan::new(initial, &config_store) };
                let plan = match plan {
                    Ok(plan) => plan,
                    Err(error) => {
                        model_guard.change_unknown();
                        opening.as_mut().unwrap().warnings.push(error);
                        restore_config::finish(&mut opening, None, &mut model_guard, &permission_guard, &events);
                        continue;
                    }
                };
                let Some(mut plan) = plan else {
                    if let Err(error) = config_store.validate_model(opening.as_ref().unwrap().options.as_ref().unwrap_or(&Value::Null)) {
                        model_guard.change_unknown();
                        opening.as_mut().unwrap().warnings.push(error);
                    }
                    restore_config::finish(&mut opening, None, &mut model_guard, &permission_guard, &events);
                    continue;
                };
                let next = if restore_config::busy(&ctx) || !matches!(permission_guard.state(), "ready" | "required") {
                    Err("请先完成此对话的待处理事项，再恢复已保存的选择".to_string())
                } else { plan.next(opening.as_ref().unwrap().options.as_ref().unwrap_or(&Value::Null)) };
                let next = match next {
                    Ok(Some(next)) => next,
                    Ok(None) => {
                        if let Err(error) = config_store.validate_model(opening.as_ref().unwrap().options.as_ref().unwrap_or(&Value::Null)) {
                            model_guard.change_unknown(); opening.as_mut().unwrap().warnings.push(error);
                        }
                        restore_config::finish(&mut opening, None, &mut model_guard, &permission_guard, &events);
                        continue;
                    }
                    Err(error) => {
                        model_guard.change_unknown(); opening.as_mut().unwrap().warnings.push(error);
                        restore_config::finish(&mut opening, None, &mut model_guard, &permission_guard, &events);
                        continue;
                    }
                };
                let lease = match ops.life.operation(format!("restore:{session_id}")) {
                    Ok(lease) => lease,
                    Err(error) => {
                        model_guard.change_unknown(); opening.as_mut().unwrap().warnings.push(error);
                        restore_config::finish(&mut opening, None, &mut model_guard, &permission_guard, &events);
                        continue;
                    }
                };
                let request = match configuration.prepare(&next.id, &Value::String(next.value)) {
                    Ok(request) => request,
                    Err(error) => {
                        model_guard.change_unknown(); opening.as_mut().unwrap().warnings.push(error);
                        restore_config::finish(&mut opening, None, &mut model_guard, &permission_guard, &events);
                        continue;
                    }
                };
                let initial = opening.as_mut().unwrap();
                // The received load prefix was handled as history. This
                // locally admitted setter owns any following reported work.
                ctx.tools.begin_live();
                let future = request.send(&cx, &session_id, &initial.operation);
                mutation = Some(Mutation::new(MutationKind::Restore { plan:Box::new(plan), request },
                    MutationReply::Open(initial.reply.take().unwrap()), initial.operation.clone(), lease,
                    tokio::time::Instant::now()+std::time::Duration::from_secs(60), future));
            },
            outcome = turn_rx.recv() => {
                if let Some(outcome) = outcome {
                    ops.life.touch();
                    if prompt_in_flight {
                        prompt_in_flight = false;
                        prompt_lease.take();
                    }
                    cancel_permissions(&pending, &mut permission_ids);
                    cancel_elicitations(&ops.elicitations, &mut elicitation_ids);
                    let failure = failures.finish(outcome.as_ref().ok());
                    let mut event = turn_end_event(outcome);
                    if let Some(failure) = failure { event["failure"] = failure; }
                    events(event);
                }
            }
            expired = expiry_rx.recv() => {
                if let Some(request_id) = expired {
                    cancel_permissions(&pending, &mut vec![request_id.clone()]);
                    cancel_elicitations(&ops.elicitations, &mut vec![request_id.clone()]);
                    events(serde_json::json!({"kind":"interactionExpired", "requestId":request_id}));
                }
            }
            outcome = mutation::next(&mut mutation) => {
                if let Some(outcome) = outcome {
                    let mut completed = mutation.take().expect("completed mutation exists");
                    let mut outcome = match &completed.kind {
                        MutationKind::Restore { request, .. } | MutationKind::Config { request, .. } =>
                            outcome.and_then(|reply| configuration.complete(request, reply)),
                        _ => outcome,
                    };
                    if matches!(&completed.kind, MutationKind::Restore { .. }) {
                        let delivered = completed.awaiting_reply();
                        let accepted = match (&mut completed.kind, outcome) {
                            (MutationKind::Restore { plan, .. }, Ok(reply)) if delivered => plan.complete(&reply),
                            (_, Err(error)) => Err(error),
                            _ => Err("恢复结果尚未确认，请重新检查此对话".into()),
                        };
                        let mut failure = None;
                        match accepted {
                            Ok(options) => {
                                model_guard.observe(&options); permission_guard.observe(&options);
                                opening.as_mut().unwrap().options = Some(options);
                            }
                            Err(error) => { model_guard.change_unknown(); failure=Some(error); }
                        }
                        restore_config::drain(&mut inbox, &mut ctx, &mut configuration, &mut models, &mut model_guard,
                            &mut permission_guard, &mut opening, &mut mutation);
                        if failure.is_none() {
                            if let Err(error) = config_store.validate_service().await { failure=Some(error); }
                            restore_config::drain(&mut inbox, &mut ctx, &mut configuration, &mut models, &mut model_guard,
                                &mut permission_guard, &mut opening, &mut mutation);
                            if !completed.awaiting_reply() || restore_config::busy(&ctx)
                                || !matches!(permission_guard.state(), "ready" | "required") {
                                failure=Some("恢复结果尚未确认，请完成待处理事项后重试".into());
                            }
                        }
                        let next = if failure.is_none() {
                            if let MutationKind::Restore { plan, .. } = &mut completed.kind {
                                match plan.next(opening.as_ref().unwrap().options.as_ref().unwrap_or(&Value::Null)) {
                                    Ok(next) => next,
                                    Err(error) => { failure=Some(error); None }
                                }
                            } else { None }
                        } else { None };
                        if let Some(next) = next {
                            let request = match configuration.prepare(&next.id, &Value::String(next.value)) {
                                Ok(request) => request,
                                Err(error) => {
                                    model_guard.change_unknown(); opening.as_mut().unwrap().warnings.push(error);
                                    restore_config::finish(&mut opening, Some(completed), &mut model_guard, &permission_guard, &events);
                                    continue;
                                }
                            };
                            let future = request.send(&cx, &session_id, &opening.as_ref().unwrap().operation);
                            if let MutationKind::Restore { request: previous, .. } = &mut completed.kind { *previous = request; }
                            mutation=Some(completed.continue_request(future));
                            continue;
                        }
                        if failure.is_none() {
                            let options=opening.as_ref().unwrap().options.as_ref().unwrap_or(&Value::Null);
                            if !model_guard.admissible() { failure=Some("Agent 未确认此对话已保存的全部选择，请重新检查".into()); }
                            else if let Err(error)=config_store.validate_model(options) { failure=Some(error); }
                        }
                        if failure.is_none() {
                            let record = match &completed.kind { MutationKind::Restore { plan, .. } => plan.record.clone(), _=>unreachable!() };
                            if config_store.save(&session_id, record).await.is_err() {
                                model_guard.record_failed();
                                failure=Some("Agent 已恢复原选择，但未能确认保存，请检查后重试".into());
                            }
                            if failure.is_none()
                                && let Err(error)=config_store.validate_service().await {
                                failure=Some(error);
                            }
                            restore_config::drain(&mut inbox, &mut ctx, &mut configuration, &mut models, &mut model_guard,
                                &mut permission_guard, &mut opening, &mut mutation);
                            if failure.is_none() && (!completed.awaiting_reply() || !model_guard.admissible()
                                || restore_config::busy(&ctx) || !matches!(permission_guard.state(), "ready" | "required")
                                || config_store.validate_model(opening.as_ref().unwrap().options.as_ref().unwrap_or(&Value::Null)).is_err()) {
                                failure=Some("Agent 设置在恢复确认后又发生变化，请重新检查此对话".into());
                            }
                        }
                        if let Some(error)=failure {
                            if model_guard.check().status != "record_failed" { model_guard.change_unknown(); }
                            opening.as_mut().unwrap().warnings.push(error);
                        }
                        restore_config::finish(&mut opening, Some(completed), &mut model_guard, &permission_guard, &events);
                        continue;
                    }
                    if let MutationKind::Config { choice, prior_guard, config_store: candidate_store, .. } = &completed.kind {
                        if let Ok(options) = &outcome {
                            models.extend(model_ids(options));
                            if let (Some(choice), Some(prior_guard), Some(candidate_store)) = (choice, prior_guard, candidate_store) {
                                permission_guard.observe(options);
                                if let Err(error) = complete_choice_change(&session_id, &mut model_guard,
                                    &mut config_store, &mut pending_config_store, choice, prior_guard, candidate_store,
                                    options, completed.awaiting_reply()).await {
                                    outcome = Err(error);
                                }
                            } else { model_guard.observe(options); }
                        } else if choice.is_some() && completed.started() {
                            model_guard.change_unknown();
                        }
                        if choice.is_some() && outcome.is_ok() {
                            // Storage can yield. Observe queued changes before publishing
                            // a confirmed result; a later value never confirms itself.
                            while let Ok(dispatch) = inbox.try_recv() {
                                let options = configuration.observe(&dispatch);
                                if let Some(options) = &options {
                                    models.extend(model_ids(options));
                                    model_guard.observe(options);
                                if !options.is_array() { model_guard.change_unknown(); }
                                    permission_guard.observe(options);
                                    if model_guard.admissible() { outcome = Ok(options.clone()); }
                                }
                                handle_session_dispatch(dispatch, &mut ctx);
                                if let Some(options) = options { events(super::session_config::projection(options)); }
                            }
                            if !completed.awaiting_reply() {
                                model_guard.change_unknown();
                                outcome = Err("设置结果尚未确认，请重新检查此对话".into());
                            } else if !model_guard.admissible() {
                                outcome = Err("Agent 设置在确认后又发生变化，请重新检查此对话".into());
                            }
                        }
                        events(serde_json::json!({"kind":"configCheck", "check":model_guard.check()}));
                    }
                    if let MutationKind::Config { permission_value, .. } = &completed.kind {
                        if let Some(requested) = permission_value {
                            if !permission_guard.complete(requested, &outcome, completed.awaiting_reply()) && outcome.is_ok() {
                                outcome = Err("权限结果尚未确认，请重新选择并确认".into());
                            }
                        } else if let Ok(options) = &outcome { permission_guard.observe(options); }
                        events(permission_guard.event());
                    }
                    let closed = matches!(completed.kind, MutationKind::Close | MutationKind::Delete) && outcome.is_ok();
                    if closed && let Ok(mut entries) = sessions.lock() { entries.remove(&session_id); }
                    if matches!(&completed.kind, MutationKind::Config { .. }) {
                        outcome = outcome.map(|options| serde_json::json!({
                            "configOptions": options,
                            "configCheck": model_guard.check(),
                            "permissionConfigId": permission_guard.id(),
                            "permissionState": permission_guard.state(),
                            "service": match &config_store.service_record {
                                Some(super::service_connection::ServiceRecord::Configured { identity }) => Some(identity),
                                _ => None,
                            },
                        }));
                    }
                    completed.finish(outcome);
                    if closed { break; }
                } else if let Some(current) = &mutation {
                    if matches!(&current.kind, MutationKind::Config { permission_value: Some(_), .. }) {
                        permission_guard.unknown();
                        events(permission_guard.event());
                    }
                    if matches!(&current.kind, MutationKind::Config { choice: Some(_), .. } | MutationKind::Restore { .. }) {
                        model_guard.change_unknown();
                        events(serde_json::json!({"kind":"configCheck", "check":model_guard.check()}));
                    }
                }
            }
            command = control.recv() => match command {
                None => break,
                Some(command) => {
                    if command.abandoned() { continue; }
                    ops.life.touch();
                    if opening.is_some() {
                        let error="对话正在恢复，请稍后重试".to_string();
                        match command {
                            SessionControl::Prompt { result,.. } | SessionControl::Cancel { result,.. }
                            | SessionControl::SetMode { result,.. } | SessionControl::Close { result,.. }
                            | SessionControl::Delete { result,.. } | SessionControl::Detach { result,.. } => { let _=result.send(Err(error)); }
                            SessionControl::SetConfig { result,.. } | SessionControl::ConfirmConfig { result,.. } => { let _=result.send(Err(error)); }
                            SessionControl::Archive { result,.. } => { let _=result.send(Err(error)); }
                            SessionControl::Shutdown => break,
                        }
                        continue;
                    }
                    match command {
                SessionControl::Shutdown => break,
                SessionControl::Archive { row, canonical_cwd, reservations, admission, result, .. } => {
                    let busy = prompt_in_flight || mutation.is_some() || ctx.tools.busy()
                        || !permission_guard.admissible() || !model_guard.admissible()
                        || pending.lock().map(|entries| entries.values().any(|entry| entry.session_id == session_id && entry.lease.belongs_to(&ops.life))).unwrap_or(true)
                        || ops.elicitations.lock().map(|entries| entries.values().any(|entry| entry.session_id == session_id && entry.lease.belongs_to(&ops.life))).unwrap_or(true);
                    if busy {
                        let _ = result.send(Err("请先完成此对话的任务及待处理事项，再归档".into()));
                        continue;
                    }
                    let lease = match ops.life.operation(format!("archive:{session_id}")) {
                        Ok(lease) => lease,
                        Err(error) => { let _ = result.send(Err(error)); continue; }
                    };
                    let outcome = config_store.store.run(move |store| {
                        let (_reservations, _lease, _admission) = (reservations, lease, admission);
                        store.archive_session_row_in_directory(&row, &canonical_cwd)
                    }).await;
                    let _ = result.send(outcome);
                }
                SessionControl::Detach { result, .. } => {
                    let busy = prompt_in_flight || mutation.is_some() || ctx.tools.busy()
                        || pending.lock().map(|entries| entries.values().any(|entry| entry.session_id == session_id)).unwrap_or(true)
                        || ops.elicitations.lock().map(|entries| entries.values().any(|entry| entry.session_id == session_id)).unwrap_or(true);
                    if busy {
                        let _ = result.send(Err("请先完成此对话的任务及待处理事项，再关闭或重新连接".into()));
                        continue;
                    }
                    detached = Some(result);
                    break;
                }
                SessionControl::Prompt { blocks, result, deadline } => {
                    if !permission_guard.admissible() {
                        events(permission_guard.event());
                        let _ = result.send(Err("请重新确认权限后再发送".into()));
                        continue;
                    }
                    let source_model_ok = config_store.expected_model.as_ref().is_none_or(|expected| {
                        model_guard.single_model_value() == Some(expected)
                    });
                    let source_check = if source_model_ok { config_store.validate_service().await } else {
                        Err("Agent 的模型与所选 API 不一致，请重新选择后重试".into())
                    };
                    if let Err(error) = source_check {
                        events(serde_json::json!({"kind":"serviceUnavailable", "message":error}));
                        let _ = result.send(Err("SERVICE_UNAVAILABLE".into()));
                        continue;
                    }
                    if !model_guard.admissible() {
                        events(serde_json::json!({"kind":"configCheck", "check":model_guard.check()}));
                        let _ = result.send(Err(format!("CONFIG_{}", model_guard.check().status.to_uppercase())));
                        continue;
                    }
                    if prompt_in_flight || mutation.is_some() {
                        let _ = result.send(Err("上次请求尚未结束，请先停止或等待".into()));
                        continue;
                    }
                    let lease = match ops.life.work() {
                        Ok(lease) => lease,
                        Err(error) => { let _ = result.send(Err(error)); continue; }
                    };
                    // Source/model identity must survive a crash once the Agent has
                    // seen this message. A failed local write is provably unsent.
                    if config_store.save(&session_id, model_guard.record()).await.is_err() {
                        model_guard.record_failed();
                        events(serde_json::json!({"kind":"configCheck", "check":model_guard.check()}));
                        let _ = result.send(Err("CONFIG_RECORD_FAILED".into()));
                        continue;
                    }
                    if result.is_closed() || tokio::time::Instant::now() >= deadline {
                        let _ = result.send(Err("请求等待已结束，消息尚未发送".into()));
                        continue;
                    }
                    let sent = cx
                        .send_request_to(Agent, PromptRequest::new(session_id.clone(), blocks))
                        .on_receiving_result({
                            let turn_tx = turn_tx.clone();
                            async move |outcome| {
                                let _ = turn_tx.send(
                                    outcome
                                        .and_then(|response| {
                                            serde_json::to_value(&response)
                                                .map_err(agent_client_protocol::Error::into_internal_error)
                                        })
                                        .map_err(describe_acp_error),
                                );
                                Ok(())
                            }
                        })
                        .map_err(describe_acp_error);
                    if sent.is_ok() {
                        ctx.tools.begin_live();
                        model_guard.lock();
                        events(serde_json::json!({"kind":"configCheck", "check":model_guard.check()}));
                        prompt_lease = Some(lease);
                        prompt_in_flight = true;
                    }
                    let _ = result.send(sent);
                }
                SessionControl::Cancel { result, .. } => {
                    let sent = cx
                        .send_notification_to(
                            Agent,
                            CancelNotification::new(session_id.clone()),
                        )
                        .map_err(describe_acp_error);
                    if sent.is_ok() {
                        cancel_permissions(&pending, &mut permission_ids);
                        cancel_elicitations(&ops.elicitations, &mut elicitation_ids);
                        events(serde_json::json!({"kind":"interactionsCancelled"}));
                    }
                    let _ = result.send(sent);
                }
                SessionControl::SetConfig { config_id, value, result, deadline } => {
                    let permission = permission_guard.is_permission(&config_id);
                    let awaiting = pending.lock().map(|entries| entries.values().any(|entry| entry.session_id == session_id)).unwrap_or(true)
                        || ops.elicitations.lock().map(|entries| entries.values().any(|entry| entry.session_id == session_id)).unwrap_or(true);
                    if mutation.is_some() || prompt_in_flight || ctx.tools.busy() || awaiting || !model_guard.may_set(&config_id) {
                        let _ = result.send(Err("当前无法修改此设置，请等待已发出的请求结束".into()));
                        continue;
                    }
                    let choice = match model_guard.choice_request(&config_id, &value) {
                        Ok(choice) => choice,
                        Err(error) => { let _ = result.send(Err(error)); continue; }
                    };
                    if (choice.is_some() && !permission_guard.admissible()) || (models.contains(&config_id) && choice.is_none()) {
                        let _ = result.send(Err("当前设置尚未确认，请重新检查此对话".into()));
                        continue;
                    }
                    let lease = match ops.life.operation(format!("open:{session_id}")) {
                        Ok(lease) => lease,
                        Err(error) => { let _ = result.send(Err(error)); continue; }
                    };
                    let candidate_store = if choice.is_some() {
                        match config_store.for_choice(choice.as_ref()).await {
                            Ok(store) => Some(Box::new(store)),
                            Err(error) => { let _ = result.send(Err(error)); continue; }
                        }
                    } else { None };
                    if choice.is_some() {
                        while let Ok(dispatch) = inbox.try_recv() {
                            let options = configuration.observe(&dispatch);
                            if let Some(options) = &options {
                                models.extend(model_ids(options));
                                model_guard.observe(options);
                                if !options.is_array() { model_guard.change_unknown(); }
                                permission_guard.observe(options);
                                events(permission_guard.event());
                                events(serde_json::json!({"kind":"configCheck", "check":model_guard.check()}));
                            }
                            handle_session_dispatch(dispatch, &mut ctx);
                            if let Some(options) = options { events(super::session_config::projection(options)); }
                        }
                        let awaiting = pending.lock().map(|entries| entries.values().any(|entry| entry.session_id == session_id)).unwrap_or(true)
                            || ops.elicitations.lock().map(|entries| entries.values().any(|entry| entry.session_id == session_id)).unwrap_or(true);
                        if !model_guard.admissible() || !permission_guard.admissible() || ctx.tools.busy() || awaiting {
                            let _ = result.send(Err("当前设置或待处理事项已变化，请重新检查此对话".into()));
                            continue;
                        }
                    }
                    if result.is_closed() || tokio::time::Instant::now() >= deadline {
                        let _ = result.send(Err("操作未发送，请重试".into()));
                        continue;
                    }
                    let prior_guard = choice.as_ref().map(|_| Box::new(model_guard.clone()));
                    let request = match configuration.prepare(&config_id, &value) {
                        Ok(request) => request,
                        Err(error) => { let _ = result.send(Err(error)); continue; }
                    };
                    let operation = Operation::new();
                    let future = request.send(&cx, &session_id, &operation);
                    if permission { permission_guard.begin(); events(permission_guard.event()); }
                    mutation = Some(Mutation::new(
                        MutationKind::Config { request, permission_value: permission.then_some(value), choice, prior_guard, config_store: candidate_store },
                        MutationReply::Config(result), operation, lease, deadline,
                        future));
                }
                SessionControl::ConfirmConfig { displayed, result, .. } => {
                    let awaiting = pending.lock().map(|entries| entries.values().any(|entry| entry.session_id == session_id)).unwrap_or(true)
                        || ops.elicitations.lock().map(|entries| entries.values().any(|entry| entry.session_id == session_id)).unwrap_or(true);
                    let outcome = if mutation.is_some() || prompt_in_flight || ctx.tools.busy() || awaiting || !model_guard.confirmable(&displayed) {
                        Err("当前设置已变化或无法确认，请重新检查".to_string())
                    } else if let Err(error) = save_confirmed_change(&session_id, &mut model_guard,
                        &mut config_store, &mut pending_config_store).await {
                        Err(error)
                    } else {
                        // Saving yields; a newly arrived value must not be accepted as
                        // the value the user just reviewed. Keep that saved value as
                        // expected and expose any subsequent change as drift.
                        while let Ok(dispatch) = inbox.try_recv() {
                            let options = configuration.observe(&dispatch);
                            if let Some(options) = &options {
                                models.extend(model_ids(options));
                                model_guard.observe(options);
                                if !options.is_array() { model_guard.change_unknown(); }
                                permission_guard.observe(options);
                                events(permission_guard.event());
                            }
                            handle_session_dispatch(dispatch, &mut ctx);
                            if let Some(options) = options { events(super::session_config::projection(options)); }
                        }
                        if displayed != model_guard.current_value() || !model_guard.admissible() {
                            Err("当前设置已变化，请重新检查".to_string())
                        } else {
                            Ok(serde_json::to_value(model_guard.check()).unwrap())
                        }
                    };
                    events(serde_json::json!({"kind":"configCheck", "check":model_guard.check()}));
                    let _ = result.send(outcome);
                }
                command @ (SessionControl::SetMode { .. } | SessionControl::Close { .. } | SessionControl::Delete { .. }) => {
                    let (kind, result, deadline, method, params) = match command {
                        SessionControl::SetMode { result, .. } if permission_guard.id().is_some() => {
                            let _ = result.send(Err("请通过权限选项重新选择并确认".into())); continue;
                        }
                        SessionControl::SetMode { mode_id, result, deadline } => (MutationKind::Mode, result, deadline,
                            "session/set_mode", serde_json::json!({"sessionId":session_id, "modeId":mode_id})),
                        SessionControl::Close { result, deadline, require_idle_interactions } => {
                            if require_idle_interactions
                                && (pending.lock().map(|entries| entries.values().any(|entry|
                                    entry.session_id == session_id && entry.lease.belongs_to(&ops.life))).unwrap_or(true)
                                    || ops.elicitations.lock().map(|entries| entries.values().any(|entry|
                                        entry.session_id == session_id && entry.lease.belongs_to(&ops.life))).unwrap_or(true))
                            {
                                let _ = result.send(Err("请先完成此对话的任务及待处理事项，再关闭或重新连接".into()));
                                continue;
                            }
                            (MutationKind::Close, result, deadline, "session/close", serde_json::json!({"sessionId":session_id}))
                        }
                        SessionControl::Delete { result, deadline } => (MutationKind::Delete, result, deadline,
                            "session/delete", serde_json::json!({"sessionId":session_id})),
                        _ => unreachable!(),
                    };
                    if mutation.is_some() || prompt_in_flight || ctx.tools.busy() {
                        let _ = result.send(Err("上次请求尚未结束，请先停止或等待".into()));
                        continue;
                    }
                    let lease = match ops.life.operation(format!("open:{session_id}")) {
                        Ok(lease) => lease,
                        Err(error) => { let _ = result.send(Err(error)); continue; }
                    };
                    let operation = Operation::new();
                    let (request_operation, request_cx) = (operation.clone(), cx.clone());
                    mutation = Some(Mutation::new(kind, MutationReply::Unit(result), operation, lease,
                        deadline, async move {
                            let request = UntypedMessage::new(method, &params).map_err(describe_acp_error)?;
                            request_operation.request(&request_cx, request_cx.send_request_to(Agent, request))
                                .await.map_err(describe_acp_error)
                        }));
                }
                    }
                }
            }
        }
    }
    drop(prompt_lease);
    cancel_permissions(&pending, &mut permission_ids);
    cancel_elicitations(&ops.elicitations, &mut elicitation_ids);
    if let Some(reply) = detached {
        let outcome = sessions
            .lock()
            .map(|mut entries| {
                entries.remove(&session_id);
            })
            .map_err(|_| "无法完成对话关闭，请重试".to_string());
        let _ = reply.send(outcome);
    }
}

/// Push `{kind:"connectionLost"}` to every session on the connection and drop
/// the registrations (pumps exit as their channels close).
pub(crate) fn notify_connection_lost(sessions: &SessionMap, reason: super::lifecycle::CloseReason) {
    if let Ok(mut map) = sessions.lock() {
        for (_, entry) in map.drain() {
            // The process owner calls this only after the exact child and its
            // process group ended. This does not rewrite any tool outcome.
            (entry.events)(
                serde_json::json!({"kind":"toolActivity", "toolCallIds":[], "reason":"process_ended"}),
            );
            (entry.events)(serde_json::json!({"kind": "connectionLost", "closeReason": reason}));
        }
    }
}

pub(crate) fn clear_connection_interactions(
    pending: &PendingPermissions,
    forms: &PendingElicitations,
    life: &Arc<ConnectionLife>,
) {
    if let Ok(map) = pending.lock() {
        let mut ids = map
            .iter()
            .filter(|(_, item)| item.lease.belongs_to(life))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        drop(map);
        cancel_permissions(pending, &mut ids);
    }
    if let Ok(map) = forms.lock() {
        let mut ids = map
            .iter()
            .filter(|(_, item)| item.lease.belongs_to(life))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        drop(map);
        cancel_elicitations(forms, &mut ids);
    }
}

/// `session/list` over the live connection: raw response, cursor pagination
/// unrolled into a single array. Call only when the agent advertises the
/// capability.
pub(crate) async fn list_sessions_on_connection(
    cx: &ConnectionTo<Agent>,
    cwd: Option<&Path>,
    initial_cursor: Option<&str>,
    all_pages: bool,
) -> Result<Value, String> {
    let mut sessions: Vec<Value> = Vec::new();
    let mut cursor = initial_cursor.map(str::to_string);
    let mut seen = std::collections::HashSet::new();
    loop {
        let mut params = serde_json::json!({});
        if let Some(cwd) = cwd {
            params["cwd"] = serde_json::json!(cwd);
        }
        if let Some(cursor) = &cursor {
            if !seen.insert(cursor.clone()) {
                return Err("Agent 返回了重复的翻页结果，请重新查找".into());
            }
            params["cursor"] = Value::String(cursor.clone());
        }
        let request = UntypedMessage::new("session/list", &params).map_err(describe_acp_error)?;
        let response = cx
            .send_request_to(Agent, request)
            .block_task()
            .await
            .map_err(describe_acp_error)?;
        let list = response
            .get("sessions")
            .and_then(Value::as_array)
            .ok_or("Agent 未返回有效的对话列表，请重试")?;
        if !all_pages {
            return Ok(response);
        }
        sessions.extend(list.iter().cloned());
        match response.get("nextCursor").and_then(Value::as_str) {
            Some(next) if !next.is_empty() => {
                if sessions.len() >= 10_000 || seen.len() >= 100 {
                    return Err("对话较多，请使用带入已有对话逐页查看".into());
                }
                cursor = Some(next.to_string());
            }
            _ => return Ok(Value::Array(sessions)),
        }
    }
}
