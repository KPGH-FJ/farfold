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
    SessionConfigValueId, SessionModeState, SetSessionConfigOptionRequest, SetSessionModeRequest,
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
    pub elicitations: PendingElicitations,
    /// Unanswered permission/elicitation requests plus in-flight prompts —
    /// while >0 the connection is mid-interaction and must not be reaped.
    pub life: Arc<ConnectionLife>,
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
            | Self::Close { deadline, result }
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
    mut model_locked: bool,
    mut models: Vec<String>,
    mut model_guard: super::model_guard::ModelGuard,
    mut permission_guard: super::permission_guard::PermissionGuard,
    config_store: super::model_guard::ConfigStore,
    ready: oneshot::Sender<()>,
) {
    let mut ready = Some(ready);
    let mut detached = None;
    let mut stopping = ops.life.stop_receiver();
    let mut mutation: Option<Mutation> = None;
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
                    if let Dispatch::Notification(message) = &dispatch
                        && message.method() == "session/update"
                        && let Some(options) = message.params().pointer("/update/configOptions") {
                        models.extend(model_ids(options));
                        model_guard.observe(options);
                        permission_guard.observe(options);
                        events(permission_guard.event());
                        events(serde_json::json!({"kind":"configCheck", "check":model_guard.check()}));
                    }
                    handle_session_dispatch(dispatch, &mut ctx)
                }
                None => break,
            },
            // Publish open completion only after the already received replay
            // prefix has reached the sink. Do not use a timing delay here.
            () = std::future::ready(()), if ready.is_some() => {
                events(ctx.tools.event());
                if let Some(ready) = ready.take() { let _ = ready.send(()); }
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
                    let completed = mutation.take().expect("completed mutation exists");
                    let mut outcome = outcome;
                    if let MutationKind::Config { .. } = &completed.kind
                        && let Ok(options) = &outcome {
                        models.extend(model_ids(options));
                        model_guard.observe(options);
                        events(serde_json::json!({"kind":"configCheck", "check":model_guard.check()}));
                    }
                    if let MutationKind::Config { permission_value } = &completed.kind {
                        if let Some(requested) = permission_value {
                            if !permission_guard.complete(requested, &outcome, completed.reply.is_some()) && outcome.is_ok() {
                                outcome = Err("权限结果尚未确认，请重新选择并确认".into());
                            }
                        } else if let Ok(options) = &outcome { permission_guard.observe(options); }
                        events(permission_guard.event());
                    }
                    let closed = matches!(completed.kind, MutationKind::Close | MutationKind::Delete) && outcome.is_ok();
                    if closed && let Ok(mut entries) = sessions.lock() { entries.remove(&session_id); }
                    completed.finish(outcome);
                    if closed { break; }
                } else if mutation.as_ref().is_some_and(|m| matches!(&m.kind, MutationKind::Config { permission_value: Some(_) })) {
                    permission_guard.unknown();
                    events(permission_guard.event());
                }
            }
            command = control.recv() => match command {
                None => break,
                Some(command) => {
                    if command.abandoned() { continue; }
                    ops.life.touch();
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
                        model_locked = true;
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
                    if models.contains(&config_id) && config_store.expected_model.as_ref().is_some_and(|expected| value.as_str() != Some(expected)) {
                        let _ = result.send(Err("请在新对话中重新选择 API 和模型".into()));
                        continue;
                    }
                    let permission = permission_guard.is_permission(&config_id);
                    let awaiting = permission && (
                        pending.lock().map(|entries| entries.values().any(|entry| entry.session_id == session_id)).unwrap_or(true)
                        || ops.elicitations.lock().map(|entries| entries.values().any(|entry| entry.session_id == session_id)).unwrap_or(true));
                    if mutation.is_some() || prompt_in_flight || ctx.tools.busy() || awaiting || !model_guard.may_set(&config_id) || (model_locked && models.contains(&config_id)) {
                        let _ = result.send(Err("当前无法修改此设置，请等待已发出的请求结束".into()));
                        continue;
                    }
                    let option_value = match parse_config_value(&value) {
                        Ok(value) => value,
                        Err(error) => { let _ = result.send(Err(error)); continue; }
                    };
                    let lease = match ops.life.operation(format!("open:{session_id}")) {
                        Ok(lease) => lease,
                        Err(error) => { let _ = result.send(Err(error)); continue; }
                    };
                    let operation = Operation::new();
                    let (request_operation, request_cx, request_session, request_id) =
                        (operation.clone(), cx.clone(), session_id.clone(), config_id.clone());
                    if permission { permission_guard.begin(); events(permission_guard.event()); }
                    mutation = Some(Mutation::new(
                        MutationKind::Config { permission_value: permission.then_some(value) },
                        MutationReply::Config(result), operation, lease, deadline,
                        async move {
                            request_operation.request(&request_cx, request_cx.send_request_to(Agent,
                                SetSessionConfigOptionRequest::new(request_session, request_id, option_value)))
                                .await.map_err(describe_acp_error).and_then(|response|
                                    serde_json::to_value(response.config_options).map_err(|_| "无法读取设置结果".into()))
                        }));
                }
                SessionControl::ConfirmConfig { displayed, result, .. } => {
                    let outcome = if mutation.is_some() || prompt_in_flight || ctx.tools.busy() || !model_guard.confirmable(&displayed) {
                        Err("当前设置已变化或无法确认，请重新检查".to_string())
                    } else if config_store.save(&session_id, model_guard.record()).await.is_err() {
                        model_guard.record_failed();
                        Err("未能保存确认值，请重试".to_string())
                    } else {
                        model_guard.confirm_saved();
                        // Saving yields; a newly arrived value must not be accepted as
                        // the value the user just reviewed. Keep that saved value as
                        // expected and expose any subsequent change as drift.
                        while let Ok(dispatch) = inbox.try_recv() {
                            if let Dispatch::Notification(message) = &dispatch
                                && let Some(options) = message.params().pointer("/update/configOptions") {
                                models.extend(model_ids(options));
                                model_guard.observe(options);
                                permission_guard.observe(options);
                                events(permission_guard.event());
                            }
                            handle_session_dispatch(dispatch, &mut ctx);
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
                        SessionControl::Close { result, deadline } => (MutationKind::Close, result, deadline,
                            "session/close", serde_json::json!({"sessionId":session_id})),
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
pub(crate) fn notify_connection_lost(sessions: &SessionMap) {
    if let Ok(mut map) = sessions.lock() {
        for (_, entry) in map.drain() {
            // The process owner calls this only after the exact child and its
            // process group ended. This does not rewrite any tool outcome.
            (entry.events)(
                serde_json::json!({"kind":"toolActivity", "toolCallIds":[], "reason":"process_ended"}),
            );
            (entry.events)(serde_json::json!({"kind": "connectionLost"}));
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

/// Open a session inside the connection task: send `session/new` (or
/// `session/load` for a known id), install the session route, spawn the
/// pump, register the handle, then apply requested config options.
///
/// Raw `UntypedMessage` requests keep the full response JSON, including
/// extension fields the typed schema would drop.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn open_session_on_connection(
    cx: &ConnectionTo<Agent>,
    cwd: &Path,
    native_session_id: Option<String>,
    preview_token: Option<String>,
    recorded_config: Option<Value>,
    config_store: super::model_guard::ConfigStore,
    config_options: Vec<(String, Value)>,
    events: SessionSink,
    sessions: &SessionMap,
    pending: &PendingPermissions,
    ops: SessionOps,
    operation: Operation,
    mut mcp: Option<super::transient_mcp::TransientMcpOpen>,
    browser_unavailable: Option<super::transient_mcp::McpUnavailable>,
) -> Result<OpenedSession, String> {
    if let Some(id) = &native_session_id {
        let map = sessions.lock().map_err(|_| "session map lock poisoned")?;
        if map.contains_key(id) {
            return Err(format!("session {id} is already open"));
        }
    }

    let has_mcp = mcp.is_some();
    let describe_open_error = |error| {
        if has_mcp {
            super::transient_mcp::safe_open_error()
        } else {
            describe_acp_error(error)
        }
    };

    let downstream = events;
    let interested = operation.clone();
    let events: SessionSink = Arc::new(move |value| {
        if interested.interested() {
            downstream(value);
        }
    });
    let (inbox_tx, inbox_rx) = mpsc::unbounded_channel::<Dispatch>();
    let (control_tx, control_rx) = mpsc::unbounded_channel::<SessionControl>();

    let resumed = native_session_id.is_some();
    let (session_id, mut response, guard) = match native_session_id {
        None => {
            let params = super::transient_mcp::session_params(cwd, None, mcp.as_ref());
            let request =
                UntypedMessage::new("session/new", &params).map_err(describe_open_error)?;
            let response = operation
                .request(cx, cx.send_request_to(Agent, request))
                .await
                .map_err(describe_open_error)?;
            let session_id = response
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or_else(|| "session/new response lacks sessionId".to_string())?
                .to_string();
            let guard = cx
                .add_dynamic_handler(SessionRoute::new(
                    &session_id,
                    inbox_tx,
                    operation.abandoned.clone(),
                ))
                .map_err(describe_open_error)?;
            // New-session events may already be waiting in the fallback queue.
            // Settle registration before allowing the first prompt to follow.
            await_route_registration(cx, &operation).await?;
            (session_id, response, guard)
        }
        Some(id) => {
            // Register before `session/load` so replay notifications are
            // claimed; anything arriving earlier was queued by the
            // retry-on-sessionId fallback in the connection dispatcher.
            let guard = cx
                .add_dynamic_handler(SessionRoute::new(
                    &id,
                    inbox_tx,
                    operation.abandoned.clone(),
                ))
                .map_err(describe_open_error)?;
            // Registration itself is queued by the protocol library. Wait for
            // its incoming actor before publishing load, so replay cannot remain
            // in the fallback queue while an empty pump announces readiness.
            await_route_registration(cx, &operation).await?;
            let params = super::transient_mcp::session_params(cwd, Some(&id), mcp.as_ref());
            let request =
                UntypedMessage::new("session/load", &params).map_err(describe_open_error)?;
            match operation
                .request(cx, cx.send_request_to(Agent, request))
                .await
            {
                Ok(response) => (id, response, guard),
                Err(error) => {
                    drop(guard);
                    return Err(describe_open_error(error));
                }
            }
        }
    };

    let mut warnings = Vec::new();
    let mut config_state = response.get("configOptions").cloned();
    let mut permission_guard = super::permission_guard::PermissionGuard::new(
        config_store.verified_permission_option,
        config_state.as_ref().unwrap_or(&Value::Null),
        resumed,
    );
    if config_store.verified_permission_option && permission_guard.id().is_none() {
        return Err("Agent 未返回可核对的权限选项，请检查接入后重试".into());
    }
    if resumed
        && config_options
            .iter()
            .any(|(id, _)| permission_guard.is_permission(id))
    {
        return Err("恢复后请重新选择并确认权限".into());
    }
    let initial_models = model_ids(config_state.as_ref().unwrap_or(&Value::Null));
    let protected_ids = super::model_guard::ModelGuard::new(
        config_state.as_ref().unwrap_or(&Value::Null),
        recorded_config.as_ref(),
        resumed,
    )
    .protected_ids();
    if resumed
        && config_options.iter().any(|(id, _)| {
            matches!(id.as_str(), "model" | "thought_level" | "reasoning_effort")
                || initial_models.contains(id)
                || protected_ids.contains(id)
        })
    {
        return Err("恢复会话不能修改模型或思考深度".into());
    }
    if resumed
        && synthetic_mode_state(&response, config_state.as_ref()).is_some()
        && config_options.iter().any(|(id, _)| id == "mode")
    {
        // A top-level mode may change thinking or permissions. Its semantics
        // are not declared, so this new route never changes restored sessions.
        // A recorded historical mode alone is not a new modification request.
        return Err("恢复对话不能修改已有使用模式".into());
    }
    for (config_id, value) in &config_options {
        if !operation.interested() {
            break;
        }
        if !resumed
            && config_id == "mode"
            && let Some(modes) = synthetic_mode_state(&response, config_state.as_ref())
        {
            if let Err(error) =
                restore_synthetic_mode(cx, &session_id, &mut response, modes, value, &operation)
                    .await
            {
                warnings.push(format!("{config_id}: {error}"));
            }
            continue;
        }
        match parse_config_value(value) {
            Err(error) => {
                if permission_guard.is_permission(config_id) {
                    permission_guard.unknown();
                }
                warnings.push(format!("{config_id}: {error}"));
            }
            Ok(option_value) => match operation
                .request(
                    cx,
                    cx.send_request_to(
                        Agent,
                        SetSessionConfigOptionRequest::new(
                            session_id.clone(),
                            config_id.clone(),
                            option_value,
                        ),
                    ),
                )
                .await
            {
                Ok(response) => {
                    let updated = serde_json::to_value(&response.config_options)
                        .map_err(|_| "无法读取设置结果".to_string());
                    if permission_guard.is_permission(config_id) {
                        permission_guard.complete(value, &updated, operation.interested());
                    } else if let Ok(options) = &updated {
                        permission_guard.observe(options);
                    }
                    config_state = updated.ok().or(config_state);
                }
                Err(error) => {
                    if permission_guard.is_permission(config_id) {
                        permission_guard.unknown();
                    }
                    warnings.push(format!("{config_id}: {}", describe_open_error(error)));
                }
            },
        }
    }

    config_store.validate_model(config_state.as_ref().unwrap_or(&Value::Null))?;
    config_store.validate_service().await?;
    let model_guard = super::model_guard::ModelGuard::new(
        config_state.as_ref().unwrap_or(&Value::Null),
        recorded_config.as_ref(),
        resumed,
    );
    let config_check = model_guard.check();
    let permission_config_id = permission_guard.id();
    let permission_state = permission_guard.state();
    let (ready_tx, ready_rx) = oneshot::channel();
    super::manager::runtime().spawn(session_pump(
        cx.clone(),
        session_id.clone(),
        inbox_rx,
        control_rx,
        events.clone(),
        pending.clone(),
        sessions.clone(),
        ops,
        resumed,
        model_ids(config_state.as_ref().unwrap_or(&Value::Null)),
        model_guard,
        permission_guard,
        config_store,
        ready_tx,
    ));
    let mcp_lease = mcp
        .as_mut()
        .map(|offer| offer.bind_route(&session_id))
        .transpose()?;
    sessions
        .lock()
        .map_err(|_| "session map lock poisoned")?
        .insert(
            session_id.clone(),
            SessionEntry {
                preview_token,
                browser_unavailable,
                control: control_tx,
                events,
                _guard: guard,
                _mcp_lease: mcp_lease,
            },
        );

    ready_rx
        .await
        .map_err(|_| "会话未能打开，请重试".to_string())?;
    if let Some(mcp) = mcp.take() {
        mcp.finish_opening();
    }
    Ok(OpenedSession {
        session_id,
        response,
        config_options: config_state,
        config_check,
        permission_config_id,
        permission_state,
        warnings,
    })
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
