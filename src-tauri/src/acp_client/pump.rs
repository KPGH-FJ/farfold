//! Per-session runtime: message routing, the session pump task, and the
//! event shapes pushed to the frontend.
//!
//! Each opened session registers its inbox with the original connection router on the
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
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1::{
    CancelNotification, SessionConfigOptionValue, SessionConfigValueId, SessionModeState,
    SetSessionModeRequest,
};
use agent_client_protocol::{
    Agent, ConnectionTo, Dispatch, RequestCancellation, Responder, UntypedMessage,
};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

#[cfg(test)]
#[path = "preparation_mode_tests.rs"]
mod preparation_mode_tests;

#[cfg(test)]
#[path = "pump/restore_tests.rs"]
mod restore_tests;

#[cfg(test)]
#[path = "pump/model_id_retention_tests.rs"]
mod model_id_retention_tests;

#[cfg(test)]
#[path = "pump/media_forwarding_tests.rs"]
mod media_forwarding_tests;

#[path = "config_change.rs"]
mod config_change;
use config_change::{complete_choice_change, save_confirmed_change};

#[path = "pump/load_notifications.rs"]
mod load_notifications;
#[path = "pump/open.rs"]
mod open;
pub(crate) use open::open_session_on_connection;
mod list;
#[path = "pump/restore_config.rs"]
pub(crate) mod restore_config;
pub(crate) use list::list_sessions_on_connection;

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
    pub owner: Value,
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

pub(super) fn model_ids(options: &Value) -> HashSet<String> {
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

pub(crate) use super::elicitation::{PendingElicitations, cancel as cancel_elicitations};

/// Per-connection state shared by session pumps. Admission and idle recycling
/// use one lifecycle owner; unknown operations retain their reservation.
#[derive(Clone)]
pub(crate) struct SessionOps {
    pub(crate) async_tasks_supported: Arc<AtomicBool>,
    pub(crate) opening: Option<super::lifecycle::OpenReservation>,
    pub(crate) connection_id: String,
    pub(crate) verify_identity: super::manager::SessionIdentityCheck,
    pub elicitations: PendingElicitations,
    pub(crate) inquiries: super::elicitation::ConnectionElicitations,
    /// Unanswered permission/elicitation requests plus in-flight prompts —
    /// while >0 the connection is mid-interaction and must not be reaped.
    pub life: Arc<ConnectionLife>,
    pub(super) prompt_escrow: super::process::PromptEscrow,
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

/// Separate IPC control receipt: never synthesized from an Agent Value.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessEndedReceipt {
    pub connection_id: String,
    pub close_reason: super::lifecycle::CloseReason,
}
type ProcessEndedSink = Arc<dyn Fn(ProcessEndedReceipt) + Send + Sync>;

/// Everything needed to reach a live session from the command layer.
pub(crate) struct SessionEntry {
    connection_id: String,
    pub(crate) preview_token: Option<String>,
    /// Parameters accepted by this client's successful new/load, not Agent permissions.
    pub(crate) workspace: Option<Vec<std::path::PathBuf>>,
    pub(crate) browser_unavailable: Option<super::transient_mcp::McpUnavailable>,
    pub control: mpsc::UnboundedSender<SessionControl>,
    pub events: SessionSink,
    process_ended_sink: Option<ProcessEndedSink>,
    pub(super) prompt_snapshot: super::active_prompt::PublicSnapshot,
    pub(super) prompt_store: crate::meta_store::MetaStore,
    /// Keeps this original connection route registered until its owner drops.
    _guard: super::session_routes::Guard,
    _mcp_lease: Option<super::transient_mcp::SessionMcpLease>,
    _retention: super::lifecycle::SessionRetention,
}

impl SessionEntry {
    /// Register under the same map lock used by notify_connection_lost/drain.
    /// An existing read owner is never replaced by a second observer.
    pub(crate) fn observe_process_end(
        &mut self,
        connection_id: &str,
        sink: ProcessEndedSink,
    ) -> Result<(), String> {
        if self.connection_id != connection_id || self.process_ended_sink.is_some() {
            return Err("Agent 连接已变化，请重新打开对话".into());
        }
        self.process_ended_sink = Some(sink);
        Ok(())
    }
    pub(crate) fn abandon(self) {
        let _ = self.control.send(SessionControl::Shutdown);
        self._retention.retain_until_terminated();
    }
}

mod control;
pub(crate) use control::SessionControl;
mod fork;
#[path = "pump/prompt.rs"]
mod prompt;

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
    pub config_options_modern: bool,
    pub config_check: super::model_guard::ConfigCheck,
    pub permission_config_id: Option<String>,
    pub permission_state: &'static str,
    pub permission_effect: Option<super::permission_effect::PermissionEffect>,
    pub warnings: Vec<String>,
}

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);

pub(super) fn next_request_id() -> String {
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

/// A declared modern list supersedes the older modes API, including an empty
/// or invalid declaration. `options` is the actual declaration, not old models.
fn synthetic_mode_state(response: &Value, options: Option<&Value>) -> Option<SessionModeState> {
    if options.is_some() {
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
            if let Some(usage) = response.get("usage") {
                event.insert("usage".to_string(), usage.clone());
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
    compactions: &'a mut super::compaction_activity::CompactionActivity,
    async_tasks: &'a mut super::async_tasks::Tasks,
    prompt_cancelling: bool,
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
                let (_, params) = message.into_parts();
                let activity = ctx.tools.observe(&params);
                let compaction_activity = ctx.compactions.observe(&params);
                let task_activity = ctx.async_tasks.observe(&params);
                let terminal_output = super::terminal_output::output_event(&params);
                // Raw passthrough moves the owned envelope after passive reads.
                // Unknown fields and `_meta` survive untouched.
                (ctx.events)(params);
                if let Some(activity) = compaction_activity {
                    (ctx.events)(activity);
                }
                if let Some(activity) = task_activity {
                    (ctx.events)(activity);
                }
                if let Some(activity) = activity {
                    (ctx.events)(activity);
                }
                if let Some(output) = terminal_output {
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
            // An interaction already in transit can arrive after session/cancel.
            // Resolve it without reopening a decision while the original prompt
            // is still acknowledging cancellation. Updates continue unchanged.
            if ctx.prompt_cancelling {
                let cancelled = match method {
                    "session/request_permission" => {
                        Some(serde_json::json!({"outcome":{"outcome":"cancelled"}}))
                    }
                    "elicitation/create" => Some(serde_json::json!({"action":"cancel"})),
                    _ => None,
                };
                if let Some(cancelled) = cancelled {
                    ctx.ops.inquiries.discard_queued(&params);
                    let _ = responder.respond(cancelled);
                    return;
                }
            }
            match method {
                "session/request_permission" => {
                    let request_id = next_request_id();
                    let owner = serde_json::json!({
                        "connectionId": ctx.ops.connection_id,
                        "sessionId": ctx.session_id,
                        "requestId": request_id,
                    });
                    let publish = match ctx.pending.lock() {
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
                                    owner: owner.clone(),
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
                            true
                        }
                        Err(_) => {
                            let _ = responder.respond_with_error(
                                agent_client_protocol::util::internal_error(
                                    "permission map lock poisoned",
                                ),
                            );
                            false
                        }
                    };
                    // Publication can synchronously serialize/dispatch IPC or
                    // re-enter a responder. Never hold the shared table here.
                    if publish {
                        (ctx.events)(serde_json::json!({
                            "kind": "permissionRequest",
                            "requestId": request_id,
                            "owner": owner,
                            "request": params.clone(),
                            "toolCall": params.get("toolCall").cloned().unwrap_or(Value::Null),
                            "options": params.get("options").cloned().unwrap_or(Value::Null),
                        }));
                    }
                }
                "elicitation/create" => {
                    if let Some(id) = ctx.ops.inquiries.create(
                        params,
                        responder,
                        ctx.session_id,
                        ctx.events.clone(),
                    ) {
                        ctx.elicitation_ids.push(id);
                    }
                }
                _ => {
                    (ctx.events)(
                        serde_json::json!({"kind":"elicitationUnavailable","params":{"method":method,"params":params},"reason":"unknown_method"}),
                    );
                    let _ = responder
                        .respond_with_error(agent_client_protocol::Error::method_not_found());
                }
            }
        }
        Dispatch::Response(..) => {}
    }
}

fn send_session_cancel(
    cx: &ConnectionTo<Agent>,
    ctx: &mut DispatchContext<'_>,
    result: oneshot::Sender<Result<(), String>>,
    prompt_in_flight: bool,
    mcp_requests: Option<&super::transient_mcp::SessionMcpRequests>,
) {
    let sent = cx
        .send_notification_to(Agent, CancelNotification::new(ctx.session_id.to_owned()))
        .map_err(describe_acp_error);
    if sent.is_ok() {
        ctx.prompt_cancelling = prompt_in_flight;
        cancel_permissions(ctx.pending, ctx.permission_ids);
        cancel_elicitations(&ctx.ops.elicitations, ctx.elicitation_ids);
        if let Some(requests) = mcp_requests {
            requests.set_prompt_active(false);
        }
        (ctx.events)(serde_json::json!({"kind":"interactionsCancelled"}));
    }
    let _ = result.send(sent);
}

/// The session pump: owns one session's inbox, control channel, and event
/// sink for the life of the session. Exits when the inbox or control channel
/// closes (session closed or connection dead), then unregisters its pending
/// permission/elicitation requests.
#[allow(clippy::too_many_arguments)]
async fn session_pump(
    cx: ConnectionTo<Agent>,
    session_id: String,
    mut inbox: super::session_routes::Inbox,
    mut control: mpsc::UnboundedReceiver<SessionControl>,
    events: SessionSink,
    pending: PendingPermissions,
    sessions: SessionMap,
    ops: SessionOps,
    mut configuration: super::session_config::SessionConfig,
    mut models: HashSet<String>,
    mut model_guard: super::model_guard::ModelGuard,
    mut permission_guard: super::permission_guard::PermissionGuard,
    mut config_store: super::model_guard::ConfigStore,
    opening: restore_config::Opening,
    mcp_requests: Option<super::transient_mcp::SessionMcpRequests>,
    received: load_notifications::State,
) {
    let mut opening = Some(opening);
    let mut detached = None;
    let mut fork_state: Option<Arc<super::session_fork::SourceFork>> = None;
    let mut stopping = ops.life.stop_receiver();
    let mut mutation: Option<Mutation> = None;
    let mut pending_config_store = None;
    let (turn_tx, mut turn_rx) = mpsc::unbounded_channel::<prompt::Outcome>();
    let load_notifications::State {
        mut permission_ids,
        mut elicitation_ids,
        mut tools,
        mut compactions,
        mut async_tasks,
        mut failures,
        expiry_tx,
        mut expiry_rx,
        deferred: _,
    } = received;
    let mut prompt_in_flight = false;
    // A transport/error receipt cannot establish which context was committed.
    // This guard only gates the new fork action; it does not infer a stop.
    let mut fork_execution_known = true;
    let mut prompt_cancelling = false;
    let mut prompt_owner: Option<prompt::Active> = None;
    let (task_tx, mut task_rx) = mpsc::unbounded_channel();
    let mut buffered_control = None;
    loop {
        if *stopping.borrow() {
            break;
        }
        let task_deadline = async_tasks.deadline();
        let mut ctx = DispatchContext {
            session_id: &session_id,
            events: &events,
            pending: &pending,
            ops: &ops,
            permission_ids: &mut permission_ids,
            elicitation_ids: &mut elicitation_ids,
            expirations: &expiry_tx,
            tools: &mut tools,
            compactions: &mut compactions,
            async_tasks: &mut async_tasks,
            prompt_cancelling,
        };
        // Inspect only the FIFO head: a running prompt's cancellation must
        // not wait for a continuously ready inbox. Never pass an earlier
        // Prompt/config/close command, or change idle/recovery ordering.
        if buffered_control.is_none() {
            buffered_control = control.try_recv().ok();
        }
        if (((prompt_in_flight
            || prompt_owner
                .as_ref()
                .is_some_and(prompt::Active::unresolved))
            && matches!(
                buffered_control,
                Some(SessionControl::Cancel { .. } | SessionControl::CancelPrompt { .. })
            ))
            || (opening.is_none()
                && !fork_state
                    .as_ref()
                    .is_some_and(|fork| fork.busy.load(Ordering::SeqCst))
                && matches!(buffered_control, Some(SessionControl::StopTask { .. }))))
            && let Some(command) = buffered_control.take()
        {
            if command.abandoned() {
                continue;
            }
            ops.life.touch();
            if let SessionControl::StopTask {
                connection_id,
                task_id,
                result,
                ..
            } = command
            {
                events(ctx.async_tasks.start(
                    &cx,
                    &connection_id,
                    &task_id,
                    result,
                    task_tx.clone(),
                ));
            } else if let SessionControl::CancelPrompt { request, .. } = command {
                prompt::cancel(
                    &cx,
                    &mut ctx,
                    prompt_owner.as_ref(),
                    request,
                    mcp_requests.as_ref(),
                );
                prompt_cancelling = ctx.prompt_cancelling;
            } else if let SessionControl::Cancel { result, .. } = command {
                if opening.is_some() {
                    let _ = result.send(Err("对话正在恢复，请稍后重试".into()));
                } else {
                    send_session_cancel(
                        &cx,
                        &mut ctx,
                        result,
                        prompt_in_flight,
                        mcp_requests.as_ref(),
                    );
                    prompt_cancelling = ctx.prompt_cancelling;
                }
            }
            continue;
        }
        tokio::select! {
            // `biased` polls in order: queued session messages are always
            // delivered before a turn result, so `turnEnd` lands after every
            // update the agent sent before the prompt response.
            biased;
            _ = stopping.changed() => break,
            completion = task_rx.recv() => {
                if let Some(completion) = completion
                    && let Some(event) = ctx.async_tasks.complete(completion) { events(event); }
            },
            () = async {
                if let Some(deadline) = task_deadline { tokio::time::sleep_until(deadline).await; }
                else { std::future::pending::<()>().await; }
            } => { events(ctx.async_tasks.expire()); },
            dispatch = inbox.recv() => match dispatch {
                Some(dispatch) => {
                    load_notifications::observe_failure(&dispatch, &mut failures, prompt_in_flight);
                    let options = configuration.observe(&dispatch);
                    if let Some(options) = &options {
                        models.extend(model_ids(options));
                        model_guard.observe(options);
                                if !options.is_array() { model_guard.change_unknown(); }
                        permission_guard.observe(options);
                        restore_config::update(options, configuration.modern_options().is_some(), &mut opening, &mut mutation);
                        if opening.is_none() {
                            events(permission_guard.event());
                            events(serde_json::json!({"kind":"configCheck", "check":model_guard.check()}));
                        }
                    }
                    handle_session_dispatch(dispatch, &mut ctx);
                    if let Some(options) = options { events(super::session_config::projection(options, configuration.modern_options().is_some())); }
                }
                None => break,
            },
            // Publish open completion only after the already received replay
            // prefix has reached the sink. Do not use a timing delay here.
            () = std::future::ready(()), if opening.as_ref().is_some_and(|opening| opening.reply.is_some()) && mutation.is_none() => {
                events(ctx.tools.event());
                events(ctx.compactions.event());
                events(ctx.async_tasks.event());
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
                let future = ctx.compactions.live_request(request.send(&cx, &session_id, &initial.operation));
                mutation = Some(Mutation::new(MutationKind::Restore { plan:Box::new(plan), request },
                    MutationReply::Open(initial.reply.take().unwrap()), initial.operation.clone(), lease,
                    tokio::time::Instant::now()+std::time::Duration::from_secs(60), future));
            },
            outcome = turn_rx.recv() => {
                if let Some(prompt::Outcome { receipt_id, result: outcome }) = outcome {
                    ops.life.touch();
                    fork_execution_known = outcome.as_ref().is_ok_and(|reply|matches!(reply.get("stopReason").and_then(Value::as_str),Some("end_turn"|"max_tokens"|"max_turn_requests"|"refusal"|"cancelled")));
                    if prompt_in_flight {
                        prompt_in_flight = false;
                        prompt_cancelling = false;
                        if prompt_owner.as_ref().is_some_and(|p| !p.unresolved()) {
                            prompt_owner.take();
                        }
                    }
                    cancel_permissions(&pending, &mut permission_ids);
                    cancel_elicitations(&ops.elicitations, &mut elicitation_ids);
                    if let Some(requests) = &mcp_requests { requests.set_prompt_active(false); }
                    let failure = failures.finish(outcome.as_ref().ok());
                    let mut event = turn_end_event(outcome);
                    event["promptReceiptId"] = serde_json::json!(receipt_id);
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
                                if let Some(options) = options { events(super::session_config::projection(options, configuration.modern_options().is_some())); }
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
                            "configOptionsModern": configuration.modern_options().is_some(),
                            "configCheck": model_guard.check(),
                            "permissionConfigId": permission_guard.id(),
                            "permissionState": permission_guard.state(),
                            "permissionEffect": permission_guard.effect(),
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
            command = async {
                match buffered_control.take() {
                    Some(command) => Some(command),
                    None => control.recv().await,
                }
            } => match command {
                None => break,
                Some(command) => {
                    if command.abandoned() { continue; }
                    ops.life.touch();
                    if opening.is_some() {
                        let error="对话正在恢复，请稍后重试".to_string();
                        if matches!(command,SessionControl::Shutdown) { break; }
                        command.reject(error);
                        continue;
                    }
                    if fork_state.as_ref().is_some_and(|fork|fork.busy.load(Ordering::SeqCst)) && !matches!(command,SessionControl::Shutdown) {
                        command.reject("复制结果尚未确认，请等待此操作结束".into());
                        continue;
                    }
                    match command {
                SessionControl::Shutdown => break,
                SessionControl::Fork { request,result,.. } => {
                    let blocked = if request.parent!=session_id || request.connection.connection_id!=ops.connection_id || !fork_execution_known {Some("unavailable")}
                        else if mcp_requests.as_ref().is_some_and(|mcp|!mcp.fork_admissible()) {Some("browser_shared")}
                        else if !permission_guard.admissible() {Some("permission")}
                        else if !model_guard.admissible() {Some("configuration")}
                        else if !fork::idle(&ctx,prompt_in_flight,mutation.is_some(),&model_guard,&permission_guard) {Some("busy")} else {None};
                    if let Some(reason)=blocked {
                        let _=result.send(Err(super::session_fork::AdmissionFailure::rejected(reason)));continue;
                    }
                    let saved=model_guard.record();
                    let snapshot=match super::session_fork::preflight(&request,saved.clone(),&config_store).await {
                        Ok(value)=>value,Err(_)=>{let _=result.send(Err(super::session_fork::AdmissionFailure::rejected("configuration")));continue;}
                    };
                    restore_config::drain(&mut inbox,&mut ctx,&mut configuration,&mut models,&mut model_guard,&mut permission_guard,&mut opening,&mut mutation);
                    if !fork_execution_known || !fork::idle(&ctx,prompt_in_flight,mutation.is_some(),&model_guard,&permission_guard) || model_guard.record()!=saved
                        || mcp_requests.as_ref().is_some_and(|mcp|!mcp.fork_admissible()) {
                        let reason=if mcp_requests.as_ref().is_some_and(|mcp|!mcp.fork_admissible()) {"browser_shared"} else {"configuration"};
                        let _=result.send(Err(super::session_fork::AdmissionFailure::rejected(reason)));continue;
                    }
                    let started=super::session_fork::start(*request,snapshot,cx.clone(),ops.clone(),sessions.clone(),pending.clone(),config_store.clone(),events.clone()).map_err(|_|super::session_fork::AdmissionFailure::rejected("unavailable"));
                    if let Ok(state)=&started { fork_state=Some(state.clone()); }
                    let _=result.send(started);
                }
                SessionControl::Archive { row, canonical_cwd, reservations, admission, result, .. } => {
                    let busy = prompt_in_flight || mutation.is_some() || (ctx.tools.busy() || ctx.async_tasks.busy() || ctx.compactions.busy())
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
                    let busy = prompt_in_flight || mutation.is_some() || (ctx.tools.busy() || ctx.async_tasks.busy() || ctx.compactions.busy())
                        || pending.lock().map(|entries| entries.values().any(|entry| entry.session_id == session_id)).unwrap_or(true)
                        || ops.elicitations.lock().map(|entries| entries.values().any(|entry| entry.session_id == session_id)).unwrap_or(true);
                    if busy {
                        let _ = result.send(Err("请先完成此对话的任务及待处理事项，再关闭或重新连接".into()));
                        continue;
                    }
                    detached = Some(result);
                    break;
                }
                SessionControl::Prompt { blocks, grant, result } => {
                    let unresolved = prompt_owner.as_ref().is_some_and(prompt::Active::unresolved);
                    match prompt::send(prompt::Input {
                        cx: &cx, ctx: &mut ctx, config_store: &config_store,
                        model_guard: &mut model_guard, permission_guard: &mut permission_guard,
                        inbox: &mut inbox, configuration: &mut configuration, models: &mut models,
                        opening: &mut opening, mutation: &mut mutation, mcp: mcp_requests.as_ref(),
                        turn: &turn_tx, in_flight: prompt_in_flight, unresolved,
                    }, blocks, *grant, &result).await {
                        Ok(started) => {
                            prompt_in_flight = started.sent.is_ok();
                            prompt_owner = Some(started.active);
                            let _ = result.send(super::active_prompt::DispatchResult::Offered(started.sent));
                        }
                        Err(error) => { let _ = result.send(super::active_prompt::DispatchResult::Rejected(error)); }
                    }
                }
                SessionControl::CancelPrompt { request, .. } => {
                    prompt::cancel(&cx, &mut ctx, prompt_owner.as_ref(), request, mcp_requests.as_ref());
                    prompt_cancelling = ctx.prompt_cancelling;
                }
                SessionControl::Cancel { result, .. } => {
                    send_session_cancel(&cx, &mut ctx, result, prompt_in_flight, mcp_requests.as_ref());
                    prompt_cancelling = ctx.prompt_cancelling;
                }
                SessionControl::StopTask { connection_id, task_id, result, .. } => {
                    events(ctx.async_tasks.start(&cx, &connection_id, &task_id, result, task_tx.clone()));
                }
                SessionControl::SetConfig { config_id, value, result, deadline } => {
                    let permission = permission_guard.is_permission(&config_id);
                    let awaiting = pending.lock().map(|entries| entries.values().any(|entry| entry.session_id == session_id)).unwrap_or(true)
                        || ops.elicitations.lock().map(|entries| entries.values().any(|entry| entry.session_id == session_id)).unwrap_or(true);
                    if mutation.is_some() || prompt_in_flight || (ctx.tools.busy() || ctx.async_tasks.busy() || ctx.compactions.busy()) || awaiting || !model_guard.may_set(&config_id) {
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
                            if let Some(options) = options { events(super::session_config::projection(options, configuration.modern_options().is_some())); }
                        }
                        let awaiting = pending.lock().map(|entries| entries.values().any(|entry| entry.session_id == session_id)).unwrap_or(true)
                            || ops.elicitations.lock().map(|entries| entries.values().any(|entry| entry.session_id == session_id)).unwrap_or(true);
                        if !model_guard.admissible() || !permission_guard.admissible() || (ctx.tools.busy() || ctx.async_tasks.busy() || ctx.compactions.busy()) || awaiting {
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
                    // Match actual mutation polling, not a merely queued setter.
                    // Previously observed history IDs remain historical.
                    let future = ctx.compactions.live_request(request.send(&cx, &session_id, &operation));
                    if permission { permission_guard.begin(); events(permission_guard.event()); }
                    mutation = Some(Mutation::new(
                        MutationKind::Config { request, permission_value: permission.then_some(value), choice, prior_guard, config_store: candidate_store },
                        MutationReply::Config(result), operation, lease, deadline,
                        future));
                }
                SessionControl::ConfirmConfig { displayed, restore_selection, deadline, result } => {
                    let awaiting = pending.lock().map(|entries| entries.values().any(|entry| entry.session_id == session_id)).unwrap_or(true)
                        || ops.elicitations.lock().map(|entries| entries.values().any(|entry| entry.session_id == session_id)).unwrap_or(true);
                    if let Some(selection) = restore_selection {
                        let before = if mutation.is_some() || prompt_in_flight
                            || prompt_owner.as_ref().is_some_and(prompt::Active::unresolved)
                            || restore_config::busy(&ctx)
                            || !matches!(permission_guard.state(), "ready" | "required")
                            || awaiting || result.is_closed() || tokio::time::Instant::now() >= deadline {
                            Err("当前设置已变化或无法确认，请重新检查".to_string())
                        } else { config_store.validate_service().await };
                        restore_config::drain(&mut inbox, &mut ctx, &mut configuration, &mut models, &mut model_guard,
                            &mut permission_guard, &mut opening, &mut mutation);
                        let candidate = before.and_then(|()| {
                            if mutation.is_some() || prompt_in_flight
                                || prompt_owner.as_ref().is_some_and(prompt::Active::unresolved)
                                || restore_config::busy(&ctx)
                                || !matches!(permission_guard.state(), "ready" | "required")
                                || result.is_closed() || tokio::time::Instant::now() >= deadline {
                                return Err("当前设置已变化或无法确认，请重新检查".into());
                            }
                            let options = configuration.options().unwrap_or(Value::Null);
                            config_store.validate_model(&options)?;
                            model_guard.confirm_restored_selection(&displayed, &selection, &options)
                        });
                        match candidate {
                            Ok(candidate) => {
                                let prior = std::mem::replace(&mut model_guard, candidate);
                                let check = serde_json::to_value(model_guard.check()).unwrap();
                                events(serde_json::json!({"kind":"configCheck", "check":check}));
                                // No Agent or storage side effect occurred. If interest
                                // closes at delivery, do not claim the baseline succeeded.
                                if result.is_closed() || tokio::time::Instant::now() >= deadline {
                                    model_guard = prior;
                                    events(serde_json::json!({"kind":"configCheck", "check":model_guard.check()}));
                                    let _ = result.send(Err("当前设置已变化或无法确认，请重新检查".into()));
                                } else if result.send(Ok(check)).is_err() {
                                    model_guard = prior;
                                    events(serde_json::json!({"kind":"configCheck", "check":model_guard.check()}));
                                }
                            }
                            Err(error) => {
                                events(serde_json::json!({"kind":"configCheck", "check":model_guard.check()}));
                                let _ = result.send(Err(error));
                            }
                        }
                        continue;
                    }
                    let outcome = if mutation.is_some() || prompt_in_flight || (ctx.tools.busy() || ctx.async_tasks.busy() || ctx.compactions.busy()) || awaiting || !model_guard.confirmable(&displayed) {
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
                            if let Some(options) = options { events(super::session_config::projection(options, configuration.modern_options().is_some())); }
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
                command @ (SessionControl::SetMode { .. } | SessionControl::Close { .. } | SessionControl::ForkClose { .. } | SessionControl::Delete { .. }) => {
                    let actual_reply = matches!(&command,SessionControl::ForkClose { .. });
                    let command = match command {
                        SessionControl::ForkClose {result} => SessionControl::Close {result,require_idle_interactions:true,deadline:tokio::time::Instant::now()},
                        other=>other,
                    };
                    let (kind, result, deadline, method, params) = match command {
                        SessionControl::SetMode { result, .. } if configuration.modern_options().is_some() => {
                            let _ = result.send(Err("请通过当前设置选项重新选择并确认".into())); continue;
                        }
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
                    if mutation.is_some() || prompt_in_flight || (ctx.tools.busy() || ctx.async_tasks.busy() || ctx.compactions.busy()) {
                        let _ = result.send(Err("上次请求尚未结束，请先停止或等待".into()));
                        continue;
                    }
                    let lease = match ops.life.operation(format!("open:{session_id}")) {
                        Ok(lease) => lease,
                        Err(error) => { let _ = result.send(Err(error)); continue; }
                    };
                    let operation = Operation::new();
                    let (request_operation, request_cx) = (operation.clone(), cx.clone());
                    let pending = Mutation::new(kind, MutationReply::Unit(result), operation, lease,
                        deadline, async move {
                            let request = UntypedMessage::new(method, &params).map_err(describe_acp_error)?;
                            request_operation.request(&request_cx, request_cx.send_request_to(Agent, request))
                                .await.map_err(describe_acp_error)
                        });
                    mutation = Some(if actual_reply {pending.until_actual_reply()} else {pending});
                }
                    }
                }
            }
        }
    }
    drop(prompt_owner); // Non-owning observer only; process escrow survives.
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
        for (session_id, entry) in map.drain() {
            // The process owner calls this only after the exact child and its
            // process group ended. This does not rewrite any tool outcome.
            (entry.events)(
                serde_json::json!({"kind":"toolActivity", "toolCallIds":[], "reason":"process_ended"}),
            );
            (entry.events)(
                serde_json::json!({"kind":"compactionActivity", "connectionId":entry.connection_id,
                "sessionId":session_id, "compactionIds":[], "uncertain":false, "reason":"process_ended"}),
            );
            (entry.events)(serde_json::json!({"kind": "connectionLost", "closeReason": reason}));
            // Only this actual process-owner closure path has this capability.
            // No JSON marker forwarded through SessionSink can invoke it.
            if let Some(sink) = &entry.process_ended_sink {
                sink(ProcessEndedReceipt {
                    connection_id: entry.connection_id.clone(),
                    close_reason: reason,
                });
            }
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
