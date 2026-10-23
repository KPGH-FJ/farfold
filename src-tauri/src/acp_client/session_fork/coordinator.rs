//! The request owner survives IPC delivery loss. No retry creates another fork.
use super::super::{
    model_guard::ConfigStore,
    operations::Operation,
    pump::{self, PendingPermissions, SessionMap, SessionOps},
    session_index,
};
use super::*;
use agent_client_protocol::schema::v1::{AGENT_METHOD_NAMES, ForkSessionRequest};
use agent_client_protocol::{Agent, ConnectionTo, UntypedMessage};

pub(crate) struct ParentSnapshot {
    config: Value,
    title: Option<String>,
}

pub(crate) async fn preflight(
    request: &ForkRequest,
    mut config: Value,
    store: &ConfigStore,
) -> Result<ParentSnapshot, String> {
    store.validate_service().await?;
    if let Some(service) = &store.service_record {
        config["_farfoldService"] =
            serde_json::to_value(service).map_err(|_| "无法核对对话来源")?;
    }
    let row_id = session_index::session_row_id(
        &request.row.id,
        &request.cwd.to_string_lossy(),
        &request.parent,
    );
    let parent = store
        .store
        .run(move |store| store.get_session(&row_id))
        .await?
        .ok_or("请先保存已有对话后再复制")?;
    if parent.config_options.as_ref() != Some(&config) {
        return Err("原对话的选择尚未确认保存，请重新检查".into());
    }
    Ok(ParentSnapshot {
        config,
        title: parent.title,
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn start(
    request: ForkRequest,
    snapshot: ParentSnapshot,
    cx: ConnectionTo<Agent>,
    ops: SessionOps,
    sessions: SessionMap,
    pending: PendingPermissions,
    store: ConfigStore,
    parent_events: SessionSink,
) -> Result<Arc<SourceFork>, String> {
    if !capabilities(&request.connection, &request.parent).fork_current_context {
        return Err("此对话暂不支持复制当前内容".into());
    }
    let work = ops.life.work()?;
    let lease = ops
        .life
        .operation_with_history(format!("fork:{}", request.parent), request.history.clone())?;
    let result = ForkResult {
        status: "unknown",
        operation_id: request.operation_id.clone(),
        parent_connection_id: request.connection.connection_id.clone(),
        parent_session_id: request.parent.clone(),
        cwd: request.cwd.to_string_lossy().into_owned(),
        child_session_id: None,
        indexed: false,
        source_released: false,
        session: None,
        reason: None,
    };
    let state = Arc::new(SourceFork {
        busy: AtomicBool::new(true),
        result: Mutex::new(result.clone()),
        updated: watch::channel(result).0,
        publishing: Mutex::new(()),
        parent_events,
        child_events: request.events.clone(),
        holds: Mutex::new(Some(Holds {
            _work: work,
            _operation: lease,
            _parent: request.parent_opening.clone(),
            child: None,
        })),
    });
    // Official typed parameters/method; retain the full JSON response envelope.
    let mut params = serde_json::to_value(ForkSessionRequest::new(
        request.parent.clone(),
        request.cwd.clone(),
    ))
    .map_err(|_| "无法准备复制请求")?;
    if request.connection.handshake.get().is_some_and(|h| {
        h.typed
            .agent_capabilities
            .session_capabilities
            .additional_directories
            .is_some()
    }) {
        params["additionalDirectories"] = serde_json::json!([]);
    }
    params["mcpServers"] = serde_json::json!([]);
    let wire = UntypedMessage::new(AGENT_METHOD_NAMES.session_fork, &params)
        .map_err(|_| "无法准备复制请求")?;
    state.publish("running");
    let owned = state.clone();
    state.observe_parent(ops.life.clone());
    super::super::manager::runtime().spawn(async move {
        let outcome = run(
            &request, snapshot, &cx, ops, sessions, pending, store, &owned, wire,
        )
        .await;
        if let Err(reason) = outcome {
            owned.fail(reason);
        }
    });
    Ok(state)
}

#[allow(clippy::too_many_arguments)]
async fn run(
    request: &ForkRequest,
    snapshot: ParentSnapshot,
    cx: &ConnectionTo<Agent>,
    mut ops: SessionOps,
    sessions: SessionMap,
    pending: PendingPermissions,
    store: ConfigStore,
    state: &SourceFork,
    wire: UntypedMessage,
) -> Result<(), &'static str> {
    if ops.life.state.load(Ordering::SeqCst) != super::super::lifecycle::READY {
        return Err("unavailable");
    }
    let operation = Operation::new();
    let operation_id = request.operation_id.clone();
    let opening_events = request.events.clone();
    let fork_events: SessionSink = Arc::new(move |event| {
        opening_events(
            serde_json::json!({"kind":"forkSourceEvent","operationId":operation_id,"childSessionId":null,"event":event}),
        )
    });
    let response = super::super::operations::until_owner_ended(
        &ops.life,
        ops.inquiries.request(
            &operation,
            cx,
            || cx.send_request_to(Agent, wire),
            fork_events,
        ),
    );
    tokio::pin!(response);
    let response = tokio::select! {
        biased;
        result = &mut response => result,
        _ = ops.life.routes.unclaimed_pressure() => {
            // A finite prefix may exceed the unassigned-message watermark
            // before the child ID arrives. Report unknown promptly, retaining
            // this exact request, source reservations and original dispatches.
            state.fail("message_backlog");
            response.await
        }
    }
    .ok_or("unavailable")?
    .map_err(|_| "unavailable")?;
    (request.events)(
        serde_json::json!({"kind":"forkSourceEvent","operationId":request.operation_id,
        "childSessionId":null,"event":{"kind":"forkResponse","response":response}}),
    );
    let id = response
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 4096 && !id.chars().any(char::is_control))
        .ok_or("identity_conflict")?
        .to_owned();
    {
        let mut result = state.result.lock().expect("fork state");
        result.child_session_id = Some(id.clone());
        if result.reason == Some("message_backlog") {
            result.reason = None;
        }
    }
    state.publish("running");
    if id == request.parent {
        return Err("identity_conflict");
    }
    let (opening, exclusive) = request
        .manager
        .opening_sessions
        .claim_fork(&request.row.id, &request.cwd, &id)
        .map_err(|_| "identity_conflict")?;
    if let Some(holds) = state.holds.lock().expect("fork holds").as_mut() {
        holds.child = Some(opening.clone());
    }
    if !exclusive || id == request.parent {
        return Err("identity_conflict");
    }
    // Live identity collision checks also include other projects. The atomic
    // insert below independently excludes all persisted identities for this Agent.
    for (key, owner) in request.manager.lock().map_err(|_| "unavailable")?.iter() {
        if key.agent_id == request.row.id
            && !key.candidate
            && owner
                .sessions
                .lock()
                .map_err(|_| "unavailable")?
                .contains_key(&id)
        {
            return Err("identity_conflict");
        }
    }
    let now = session_index::now_millis();
    let row = crate::meta_store::SessionRow {
        id: session_index::session_row_id(&request.row.id, &request.cwd.to_string_lossy(), &id),
        agent_id: request.row.id.clone(),
        cwd: request.cwd.to_string_lossy().into_owned(),
        native_session_id: Some(id.clone()),
        title: Some(
            snapshot
                .title
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .map_or_else(|| "对话副本".to_owned(), |s| format!("{s}的副本")),
        ),
        config_options: Some(snapshot.config.clone()),
        pinned: false,
        archived: false,
        created_at: now,
        updated_at: now,
    };
    store
        .store
        .run(move |store| store.insert_fork_session(&row))
        .await
        .map_err(|e| {
            if e == "FORK_IDENTITY_CONFLICT" {
                "identity_conflict"
            } else {
                "index_failed"
            }
        })?;
    state.result.lock().expect("fork state").indexed = true;
    state.publish("running");
    if !state.busy.load(Ordering::SeqCst) {
        return Err("owner_ended");
    }
    if ops.life.state.load(Ordering::SeqCst) != super::super::lifecycle::READY {
        return Err("unavailable");
    }
    let operation_id = request.operation_id.clone();
    let child_id = id.clone();
    let opening_events = request.events.clone();
    let source_events: SessionSink = Arc::new(move |event| {
        // Interactive opening requests retain their real owner. Source history
        // is inspectable raw detail and never appended to the final child replay.
        opening_events(
            serde_json::json!({"kind":"forkSourceEvent","operationId":operation_id,
            "childSessionId":child_id,"event":event}),
        );
    });
    ops.opening = Some(opening.clone());
    let mut opened = pump::open_session_on_connection(
        cx,
        &request.cwd,
        Some(id.clone()),
        Some(request.operation_id.clone()),
        None,
        Some(snapshot.config),
        store.clone(),
        vec![],
        source_events,
        &sessions,
        &pending,
        ops.clone(),
        Operation::new().with_history(request.history.clone()),
        None,
        Some(super::super::transient_mcp::McpUnavailable::NotEnabledForConversation),
    )
    .await
    .map_err(|_| "source_load_failed")?;
    opened.identity.delivered();
    if ops.life.state.load(Ordering::SeqCst) != super::super::lifecycle::READY {
        return Err("unavailable");
    }
    let control = sessions
        .lock()
        .map_err(|_| "source_close_failed")?
        .get(&id)
        .ok_or("source_close_failed")?
        .control
        .clone();
    let (reply, receive) = oneshot::channel();
    control
        .send(SessionControl::ForkClose { result: reply })
        .map_err(|_| "source_close_failed")?;
    receive
        .await
        .map_err(|_| "source_close_failed")?
        .map_err(|_| "source_close_failed")?;
    // Only the actual successful close reply releases native child ownership.
    // Route absence or an adapter's finally block is never substituted for it.
    if sessions
        .lock()
        .map_err(|_| "source_close_failed")?
        .contains_key(&id)
    {
        return Err("source_close_failed");
    }
    {
        let mut value = state.result.lock().expect("fork state");
        value.source_released = true;
        if !state.busy.load(Ordering::SeqCst) {
            return Err("owner_ended");
        }
    }
    state.publish("running");
    if ops.life.state.load(Ordering::SeqCst) != super::super::lifecycle::READY {
        return Err("unavailable");
    }
    let opened = request
        .manager
        .open_session_reserved(
            &request.row,
            &request.cwd,
            id.clone(),
            request.events.clone(),
            &store.store,
            opening,
            request.history.clone(),
            Some(request.open_token.clone()),
        )
        .await
        .map_err(|_| "destination_open_failed")?;
    if request.delivery_failed.load(Ordering::SeqCst) {
        return Err("delivery_failed");
    }
    let connection = request
        .manager
        .session_connection(&request.row.id, &request.cwd, &id)
        .map_err(|_| "destination_open_failed")?;
    if connection.connection_id == request.connection.connection_id {
        return Err("destination_open_failed");
    }
    let result = super::opened_result(opened, connection, &request.cwd);
    (request.events)(
        serde_json::json!({"kind":"session_history_complete","openToken":request.open_token}),
    );
    if request.delivery_failed.load(Ordering::SeqCst) {
        return Err("delivery_failed");
    }
    {
        let mut value = state.result.lock().expect("fork state");
        value.status = "ready";
        value.session = Some(result);
        value.reason = None;
        state.holds.lock().expect("fork holds").take();
        state.busy.store(false, Ordering::SeqCst);
    }
    state.publish("finished");
    Ok(())
}
