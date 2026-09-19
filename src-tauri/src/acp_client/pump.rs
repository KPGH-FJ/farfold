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
//! - `{"kind": "terminalOutput", "terminalId", "data"}` or `{...,"exit"}`
//! - `{"kind": "artifact", "artifact"}` (`fileDiff`/`terminal` artifacts).
//! - `{"kind": "turnEnd", "stopReason"}` or `{"kind": "turnEnd", "error"}`
//! - `{"kind": "notification", "method", "params"}` for other session-scoped
//!   notifications (extension methods).
//! - `{"kind": "connectionLost"}` when the process dies or disconnects.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1::{
    CancelNotification, CloseSessionRequest, ContentBlock, PromptRequest, SessionConfigOptionValue,
    SessionConfigValueId, SetSessionConfigOptionRequest,
};
use agent_client_protocol::{
    Agent, ConnectionTo, Dispatch, DynamicHandlerGuard, HandleDispatchFrom, Handled, Responder,
    UntypedMessage,
};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use super::terminal_ops::SessionOps;

/// Frontend event sink: wraps `tauri::ipc::Channel`; tests pass a collector.
pub(crate) type SessionSink = Arc<dyn Fn(Value) + Send + Sync>;

/// requestId → responder for pending `session/request_permission` calls.
/// Owned by [`crate::acp_client::manager::AcpManager`], shared with every
/// session pump.
pub(crate) type PendingPermissions = Arc<Mutex<HashMap<String, Responder<Value>>>>;

/// requestId → responder for pending `elicitation/create` calls. Same
/// lifecycle as [`PendingPermissions`].
pub(crate) type PendingElicitations = Arc<Mutex<HashMap<String, Responder<Value>>>>;

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
    Close {
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
/// workspace root, client-capability state, and the id registries cleaned
/// up when the pump exits.
struct DispatchContext<'a> {
    session_id: &'a str,
    cwd: &'a Path,
    events: &'a SessionSink,
    pending: &'a PendingPermissions,
    ops: &'a SessionOps,
    permission_ids: &'a mut Vec<String>,
    elicitation_ids: &'a mut Vec<String>,
}

/// Record an artifact on the connection's session list and stream it to
/// the frontend in the same step.
fn record_artifact(ctx: &DispatchContext<'_>, artifact: Value) {
    if let Ok(mut map) = ctx.ops.artifacts.lock() {
        map.entry(ctx.session_id.to_string())
            .or_default()
            .push(artifact.clone());
    }
    (ctx.events)(serde_json::json!({"kind": "artifact", "artifact": artifact}));
}

/// Handle one session-scoped dispatch: forward notifications to the frontend
/// and serve agent→client requests (permission, fs, terminal, elicitation).
fn handle_session_dispatch(dispatch: Dispatch, ctx: &mut DispatchContext<'_>) {
    match dispatch {
        Dispatch::Notification(message) => {
            if message.method() == "session/update" {
                // Raw passthrough: the params object is the update envelope,
                // unknown fields and `_meta` survive untouched.
                (ctx.events)(message.params().clone());
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
                            map.insert(request_id.clone(), responder);
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
                "fs/read_text_file" | "fs/write_text_file" => {
                    match super::fs_ops::handle(ctx.cwd, method, &params) {
                        Ok((response, artifact)) => {
                            if let Some(artifact) = artifact {
                                record_artifact(ctx, artifact);
                            }
                            let _ = responder.respond(response);
                        }
                        Err(error) => {
                            let _ = responder.respond_with_error(
                                agent_client_protocol::util::internal_error(error),
                            );
                        }
                    }
                }
                "terminal/create"
                | "terminal/output"
                | "terminal/wait_for_exit"
                | "terminal/kill"
                | "terminal/release" => {
                    match super::terminal_ops::handle_request(
                        ctx.ops,
                        ctx.session_id,
                        ctx.cwd,
                        ctx.events,
                        method,
                        &params,
                    ) {
                        super::terminal_ops::RequestPlan::Respond(Ok(response), artifact) => {
                            if let Some(artifact) = artifact {
                                record_artifact(ctx, artifact);
                            }
                            let _ = responder.respond(response);
                        }
                        super::terminal_ops::RequestPlan::Respond(Err(error), _) => {
                            let _ = responder.respond_with_error(
                                agent_client_protocol::util::internal_error(error),
                            );
                        }
                        super::terminal_ops::RequestPlan::ParkWaiter { terminal_id } => {
                            super::terminal_ops::park_waiter(
                                &ctx.ops.terminals,
                                &terminal_id,
                                responder,
                            );
                        }
                    }
                }
                "elicitation/create" => {
                    let mode = params.get("mode").and_then(Value::as_str);
                    if mode != Some("form") {
                        let _ = responder.respond_with_error(
                            agent_client_protocol::util::internal_error(
                                "farfold supports form elicitations only",
                            ),
                        );
                        return;
                    }
                    let request_id = next_request_id();
                    match ctx.ops.elicitations.lock() {
                        Ok(mut map) => {
                            map.insert(request_id.clone(), responder);
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
/// permission/elicitation requests and kills its terminals.
#[allow(clippy::too_many_arguments)]
async fn session_pump(
    cx: ConnectionTo<Agent>,
    session_id: String,
    cwd: PathBuf,
    mut inbox: mpsc::UnboundedReceiver<Dispatch>,
    mut control: mpsc::UnboundedReceiver<SessionControl>,
    events: SessionSink,
    pending: PendingPermissions,
    ops: SessionOps,
) {
    let (turn_tx, mut turn_rx) = mpsc::unbounded_channel::<Result<Value, String>>();
    let mut permission_ids: Vec<String> = Vec::new();
    let mut elicitation_ids: Vec<String> = Vec::new();
    loop {
        let mut ctx = DispatchContext {
            session_id: &session_id,
            cwd: &cwd,
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
                    handle_session_dispatch(dispatch, &mut ctx)
                }
                None => break,
            },
            outcome = turn_rx.recv() => {
                if let Some(outcome) = outcome {
                    events(turn_end_event(outcome));
                }
            }
            command = control.recv() => match command {
                None | Some(SessionControl::Shutdown) => break,
                Some(SessionControl::Prompt { blocks, result }) => {
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
                    let _ = result.send(sent);
                }
                Some(SessionControl::Cancel { result }) => {
                    let sent = cx
                        .send_notification_to(
                            Agent,
                            CancelNotification::new(session_id.clone()),
                        )
                        .map_err(describe_acp_error);
                    let _ = result.send(sent);
                }
                Some(SessionControl::SetConfig { config_id, value, result }) => {
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
                    let _ = result.send(outcome);
                }
                Some(SessionControl::Close { result }) => {
                    let outcome = cx
                        .send_request_to(Agent, CloseSessionRequest::new(session_id.clone()))
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
    if let Ok(mut map) = pending.lock() {
        for request_id in permission_ids {
            map.remove(&request_id);
        }
    }
    // Pending elicitations get an explicit cancel rather than a silent
    // drop so the agent's request resolves instead of hanging.
    if let Ok(mut map) = ops.elicitations.lock() {
        for request_id in elicitation_ids {
            if let Some(responder) = map.remove(&request_id) {
                let _ = responder.respond(serde_json::json!({"action": "cancel"}));
            }
        }
    }
    super::terminal_ops::release_session(&ops.terminals, &ops.pty, &session_id);
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

    super::manager::runtime().spawn(session_pump(
        cx.clone(),
        session_id.clone(),
        cwd.to_path_buf(),
        inbox_rx,
        control_rx,
        events.clone(),
        pending.clone(),
        ops,
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

    let mut warnings = Vec::new();
    let mut config_state = response.get("configOptions").cloned();
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
