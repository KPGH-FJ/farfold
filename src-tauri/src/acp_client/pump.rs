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
//! - `{"kind": "permissionRequest", "requestId", "toolCall", "options"}`
//! - `{"kind": "elicitation", "requestId", "message", "schema", "toolCallId"?}`
//! - `{"kind": "turnEnd", "stopReason"}` or `{"kind": "turnEnd", "error"}`
//! - `{"kind": "notification", "method", "params"}` for other session-scoped
//!   notifications (extension methods).
//! - `{"kind": "connectionLost"}` when the process dies or disconnects.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1::{
    CancelNotification, CloseSessionRequest, ContentBlock, DeleteSessionRequest, PromptRequest,
    SessionConfigOptionValue, SessionConfigValueId, SetSessionConfigOptionRequest,
    SetSessionModeRequest,
};
use agent_client_protocol::{
    Agent, ConnectionTo, Dispatch, DynamicHandlerGuard, HandleDispatchFrom, Handled, Responder,
    UntypedMessage,
};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

/// Frontend event sink: wraps `tauri::ipc::Channel`; tests pass a collector.
pub(crate) type SessionSink = Arc<dyn Fn(Value) + Send + Sync>;

/// requestId → responder for pending `session/request_permission` calls.
/// Owned by [`crate::acp_client::manager::AcpManager`], shared with every
/// session pump.
pub(crate) struct PendingPermission {
    pub responder: Responder<Value>,
    pub session_id: String,
    pub options: Vec<String>,
    /// The owning connection's open-request gauge — every removal path
    /// (answer, cancel, pump exit) decrements it.
    pub open_requests: Arc<AtomicU64>,
}
pub(crate) type PendingPermissions = Arc<Mutex<HashMap<String, PendingPermission>>>;

fn cancel_permissions(pending: &PendingPermissions, ids: &mut Vec<String>) {
    if let Ok(mut map) = pending.lock() {
        for id in ids.drain(..) {
            if let Some(request) = map.remove(&id) {
                request.open_requests.fetch_sub(1, Ordering::Relaxed);
                let _ = request
                    .responder
                    .respond(serde_json::json!({"outcome":{"outcome":"cancelled"}}));
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
    pub responder: Responder<Value>,
    /// The owning connection's open-request gauge (see PendingPermission).
    pub open_requests: Arc<AtomicU64>,
}
pub(crate) type PendingElicitations = Arc<Mutex<HashMap<String, PendingElicitation>>>;

/// Per-connection state a session pump needs beyond its own channels:
/// pending elicitation responders, the last-activity stamp, and the
/// open-request gauge the manager's idle reaper reads before recycling
/// the connection.
#[derive(Clone)]
pub(crate) struct SessionOps {
    pub elicitations: PendingElicitations,
    /// Last wire-activity timestamp (epoch millis) on this connection.
    pub activity: Arc<AtomicU64>,
    /// Unanswered permission/elicitation requests plus in-flight prompts —
    /// while >0 the connection is mid-interaction and must not be reaped.
    pub open_requests: Arc<AtomicU64>,
}

/// session_id → live session handle, one map per `(agent_id, cwd)` connection.
pub(crate) type SessionMap = Arc<Mutex<HashMap<String, SessionEntry>>>;

/// Everything needed to reach a live session from the command layer.
pub(crate) struct SessionEntry {
    pub control: mpsc::UnboundedSender<SessionControl>,
    pub events: SessionSink,
    /// Keeps the dynamic session handler registered; dropping unregisters it.
    _guard: DynamicHandlerGuard<Agent>,
}

/// Commands delivered to the session pump task.
pub(crate) enum SessionControl {
    Prompt {
        blocks: Vec<ContentBlock>,
        result: oneshot::Sender<Result<(), String>>,
    },
    Cancel {
        result: oneshot::Sender<Result<(), String>>,
    },
    SetConfig {
        config_id: String,
        value: Value,
        result: oneshot::Sender<Result<Value, String>>,
    },
    /// `session/set_mode` — agents that expose `modes` outside
    /// `configOptions` (the synthetic `mode` option in the UI calls this).
    SetMode {
        mode_id: String,
        result: oneshot::Sender<Result<(), String>>,
    },
    Close {
        result: oneshot::Sender<Result<(), String>>,
    },
    /// `session/delete` — removes the session agent-side, then ends the pump.
    Delete {
        result: oneshot::Sender<Result<(), String>>,
    },
    /// Local teardown without a protocol call (connection already dead).
    Shutdown,
}

/// Result of opening a session inside the connection task.
pub(crate) struct OpenedSession {
    pub session_id: String,
    /// Raw `session/new`/`session/load` response JSON. Raw passthrough keeps
    /// extension fields the typed schema drops (e.g. `models`).
    pub response: Value,
    /// Latest `configOptions` array after applying requested overrides.
    pub config_options: Option<Value>,
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
}

impl SessionRoute {
    fn new(session_id: &str, inbox: mpsc::UnboundedSender<Dispatch>) -> Self {
        Self {
            session_id: session_id.to_string(),
            inbox,
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
}

/// Handle one session-scoped dispatch: forward notifications to the frontend
/// and serve agent→client requests (permission, elicitation).
fn handle_session_dispatch(dispatch: Dispatch, ctx: &mut DispatchContext<'_>) {
    ctx.ops
        .activity
        .store(super::session_index::now_millis() as u64, Ordering::Relaxed);
    match dispatch {
        Dispatch::Notification(message) => {
            if message.method() == "session/update" {
                // Raw passthrough: the params object is the update envelope,
                // unknown fields and `_meta` survive untouched.
                (ctx.events)(message.params().clone());
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
                            ctx.ops.open_requests.fetch_add(1, Ordering::Relaxed);
                            map.insert(
                                request_id.clone(),
                                PendingPermission {
                                    responder,
                                    open_requests: ctx.ops.open_requests.clone(),
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
                            ctx.ops.open_requests.fetch_add(1, Ordering::Relaxed);
                            map.insert(
                                request_id.clone(),
                                PendingElicitation {
                                    responder,
                                    open_requests: ctx.ops.open_requests.clone(),
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
    ops: SessionOps,
    mut model_locked: bool,
    mut models: Vec<String>,
    mut model_guard: super::model_guard::ModelGuard,
    ready: oneshot::Sender<()>,
) {
    let mut ready = Some(ready);
    let (turn_tx, mut turn_rx) = mpsc::unbounded_channel::<Result<Value, String>>();
    let mut permission_ids: Vec<String> = Vec::new();
    let mut prompt_in_flight = false;
    let mut failures = super::failures::FailureTracker::default();
    let mut elicitation_ids: Vec<String> = Vec::new();
    loop {
        let mut ctx = DispatchContext {
            session_id: &session_id,
            events: &events,
            pending: &pending,
            ops: &ops,
            permission_ids: &mut permission_ids,
            elicitation_ids: &mut elicitation_ids,
        };
        tokio::select! {
            // `biased` polls in order: queued session messages are always
            // delivered before a turn result, so `turnEnd` lands after every
            // update the agent sent before the prompt response.
            biased;
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
                    }
                    handle_session_dispatch(dispatch, &mut ctx)
                }
                None => break,
            },
            // Publish open completion only after the already received replay
            // prefix has reached the sink. Do not use a timing delay here.
            () = std::future::ready(()), if ready.is_some() => {
                if let Some(ready) = ready.take() { let _ = ready.send(()); }
            },
            outcome = turn_rx.recv() => {
                if let Some(outcome) = outcome {
                    ops.activity.store(
                        super::session_index::now_millis() as u64,
                        Ordering::Relaxed,
                    );
                    if prompt_in_flight {
                        prompt_in_flight = false;
                        ops.open_requests.fetch_sub(1, Ordering::Relaxed);
                    }
                    cancel_permissions(&pending, &mut permission_ids);
                    let failure = failures.finish(outcome.as_ref().ok());
                    let mut event = turn_end_event(outcome);
                    if let Some(failure) = failure { event["failure"] = failure; }
                    events(event);
                }
            }
            command = control.recv() => match command {
                None => break,
                Some(command) => {
                    ops.activity.store(
                        super::session_index::now_millis() as u64,
                        Ordering::Relaxed,
                    );
                    match command {
                SessionControl::Shutdown => break,
                SessionControl::Prompt { blocks, result } => {
                    if !model_guard.admissible() {
                        let _ = result.send(Err("恢复的模型与创建时不同，已暂停发送".into()));
                        continue;
                    }
                    if prompt_in_flight {
                        let _ = result.send(Err("上次请求尚未结束，请先停止或等待".into()));
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
                        model_locked = true;
                        model_guard.lock();
                        ops.open_requests.fetch_add(1, Ordering::Relaxed);
                        prompt_in_flight = true;
                    }
                    let _ = result.send(sent);
                }
                SessionControl::Cancel { result } => {
                    let sent = cx
                        .send_notification_to(
                            Agent,
                            CancelNotification::new(session_id.clone()),
                        )
                        .map_err(describe_acp_error);
                    if sent.is_ok() {
                        cancel_permissions(&pending, &mut permission_ids);
                        events(serde_json::json!({"kind":"permissionsCancelled"}));
                    }
                    let _ = result.send(sent);
                }
                SessionControl::SetConfig { config_id, value, result } => {
                    if model_locked && (config_id == "model" || models.contains(&config_id)) {
                        let _ = result.send(Err("已有会话不能修改模型".into()));
                        continue;
                    }
                    let outcome = match parse_config_value(&value) {
                        Err(error) => Err(error),
                        Ok(option_value) => cx
                            .send_request_to(
                                Agent,
                                SetSessionConfigOptionRequest::new(
                                    session_id.clone(),
                                    config_id,
                                    option_value,
                                ),
                            )
                            .block_task()
                            .await
                            .map_err(describe_acp_error)
                            .and_then(|response| {
                                serde_json::to_value(&response.config_options)
                                    .map_err(|error| format!("cannot encode config options: {error}"))
                            }),
                    };
                    if let Ok(options) = &outcome { models.extend(model_ids(options)); model_guard.observe(options); }
                    let _ = result.send(outcome);
                }
                SessionControl::SetMode { mode_id, result } => {
                    let outcome = cx
                        .send_request_to(
                            Agent,
                            SetSessionModeRequest::new(session_id.clone(), mode_id),
                        )
                        .block_task()
                        .await
                        .map(|_| ())
                        .map_err(describe_acp_error);
                    let _ = result.send(outcome);
                }
                SessionControl::Close { result } => {
                    let outcome = cx
                        .send_request_to(Agent, CloseSessionRequest::new(session_id.clone()))
                        .block_task()
                        .await
                        .map(|_| ())
                        .map_err(describe_acp_error);
                    let _ = result.send(outcome);
                    break;
                }
                SessionControl::Delete { result } => {
                    let outcome = cx
                        .send_request_to(Agent, DeleteSessionRequest::new(session_id.clone()))
                        .block_task()
                        .await
                        .map(|_| ())
                        .map_err(describe_acp_error);
                    let _ = result.send(outcome);
                    break;
                }
                    }
                }
            }
        }
    }
    if prompt_in_flight {
        ops.open_requests.fetch_sub(1, Ordering::Relaxed);
    }
    cancel_permissions(&pending, &mut permission_ids);
    // Pending elicitations get an explicit cancel rather than a silent
    // drop so the agent's request resolves instead of hanging.
    if let Ok(mut map) = ops.elicitations.lock() {
        for request_id in elicitation_ids {
            if let Some(entry) = map.remove(&request_id) {
                entry.open_requests.fetch_sub(1, Ordering::Relaxed);
                let _ = entry
                    .responder
                    .respond(serde_json::json!({"action": "cancel"}));
            }
        }
    }
}

/// Push `{kind:"connectionLost"}` to every session on the connection and drop
/// the registrations (pumps exit as their channels close).
pub(crate) fn notify_connection_lost(sessions: &SessionMap) {
    if let Ok(mut map) = sessions.lock() {
        for (_, entry) in map.drain() {
            (entry.events)(serde_json::json!({"kind": "connectionLost"}));
        }
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
    recorded_config: Option<Value>,
    config_options: Vec<(String, Value)>,
    events: SessionSink,
    sessions: &SessionMap,
    pending: &PendingPermissions,
    ops: SessionOps,
) -> Result<OpenedSession, String> {
    if let Some(id) = &native_session_id {
        let map = sessions.lock().map_err(|_| "session map lock poisoned")?;
        if map.contains_key(id) {
            return Err(format!("session {id} is already open"));
        }
    }

    let (inbox_tx, inbox_rx) = mpsc::unbounded_channel::<Dispatch>();
    let (control_tx, control_rx) = mpsc::unbounded_channel::<SessionControl>();

    let resumed = native_session_id.is_some();
    let (session_id, response, guard) = match native_session_id {
        None => {
            let params = serde_json::json!({"cwd": cwd, "mcpServers": []});
            let request =
                UntypedMessage::new("session/new", &params).map_err(describe_acp_error)?;
            let response = cx
                .send_request_to(Agent, request)
                .block_task()
                .await
                .map_err(describe_acp_error)?;
            let session_id = response
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or_else(|| "session/new response lacks sessionId".to_string())?
                .to_string();
            let guard = cx
                .add_dynamic_handler(SessionRoute::new(&session_id, inbox_tx))
                .map_err(describe_acp_error)?;
            (session_id, response, guard)
        }
        Some(id) => {
            // Register before `session/load` so replay notifications are
            // claimed; anything arriving earlier was queued by the
            // retry-on-sessionId fallback in the connection dispatcher.
            let guard = cx
                .add_dynamic_handler(SessionRoute::new(&id, inbox_tx))
                .map_err(describe_acp_error)?;
            let params = serde_json::json!({
                "sessionId": id,
                "cwd": cwd,
                "mcpServers": [],
            });
            let request =
                UntypedMessage::new("session/load", &params).map_err(describe_acp_error)?;
            match cx.send_request_to(Agent, request).block_task().await {
                Ok(response) => (id, response, guard),
                Err(error) => {
                    drop(guard);
                    return Err(describe_acp_error(error));
                }
            }
        }
    };

    let mut warnings = Vec::new();
    let mut config_state = response.get("configOptions").cloned();
    let initial_models = model_ids(config_state.as_ref().unwrap_or(&Value::Null));
    if resumed
        && config_options
            .iter()
            .any(|(id, _)| id == "model" || initial_models.contains(id))
    {
        return Err("恢复会话不能修改模型".into());
    }
    for (config_id, value) in &config_options {
        match parse_config_value(value) {
            Err(error) => warnings.push(format!("{config_id}: {error}")),
            Ok(option_value) => match cx
                .send_request_to(
                    Agent,
                    SetSessionConfigOptionRequest::new(
                        session_id.clone(),
                        config_id.clone(),
                        option_value,
                    ),
                )
                .block_task()
                .await
            {
                Ok(response) => {
                    config_state = serde_json::to_value(&response.config_options)
                        .ok()
                        .or(config_state);
                }
                Err(error) => warnings.push(format!("{config_id}: {}", describe_acp_error(error))),
            },
        }
    }

    let (ready_tx, ready_rx) = oneshot::channel();
    super::manager::runtime().spawn(session_pump(
        cx.clone(),
        session_id.clone(),
        inbox_rx,
        control_rx,
        events.clone(),
        pending.clone(),
        ops,
        resumed,
        model_ids(config_state.as_ref().unwrap_or(&Value::Null)),
        super::model_guard::ModelGuard::new(
            config_state.as_ref().unwrap_or(&Value::Null),
            recorded_config.as_ref(),
            resumed,
        ),
        ready_tx,
    ));
    sessions
        .lock()
        .map_err(|_| "session map lock poisoned")?
        .insert(
            session_id.clone(),
            SessionEntry {
                control: control_tx,
                events,
                _guard: guard,
            },
        );

    ready_rx
        .await
        .map_err(|_| "会话未能打开，请重试".to_string())?;
    Ok(OpenedSession {
        session_id,
        response,
        config_options: config_state,
        warnings,
    })
}

/// `session/list` over the live connection: raw response, cursor pagination
/// unrolled into a single array. Call only when the agent advertises the
/// capability.
pub(crate) async fn list_sessions_on_connection(
    cx: &ConnectionTo<Agent>,
    cwd: &Path,
) -> Result<Value, String> {
    let mut sessions: Vec<Value> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut params = serde_json::json!({"cwd": cwd});
        if let Some(cursor) = &cursor {
            params["cursor"] = Value::String(cursor.clone());
        }
        let request = UntypedMessage::new("session/list", &params).map_err(describe_acp_error)?;
        let response = cx
            .send_request_to(Agent, request)
            .block_task()
            .await
            .map_err(describe_acp_error)?;
        if let Some(list) = response.get("sessions").and_then(Value::as_array) {
            sessions.extend(list.iter().cloned());
        }
        match response.get("nextCursor").and_then(Value::as_str) {
            Some(next) if !next.is_empty() && sessions.len() < 10_000 => {
                cursor = Some(next.to_string());
            }
            _ => return Ok(Value::Array(sessions)),
        }
    }
}
