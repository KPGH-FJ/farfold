//! Opening and loading on the existing connection.
use super::*;

/// Own the local route until opening produces a result that OpenDelivery can
/// own. Failed or cancelled readiness has no OpenedSession for its cleanup.
struct OpeningRoute {
    sessions: SessionMap,
    session_id: String,
    control: mpsc::UnboundedSender<SessionControl>,
    delivered: bool,
}

impl Drop for OpeningRoute {
    fn drop(&mut self) {
        if self.delivered {
            return;
        }
        let entry = self.sessions.lock().ok().and_then(|mut entries| {
            let owns_route = entries
                .get(&self.session_id)
                .is_some_and(|entry| entry.control.same_channel(&self.control));
            owns_route
                .then(|| entries.remove(&self.session_id))
                .flatten()
        });
        if let Some(entry) = entry {
            entry.abandon();
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
    purpose: super::super::open_purpose::OpenPurpose,
    native_session_id: Option<String>,
    preview_token: Option<String>,
    opening_token: Option<String>,
    recorded_config: Option<Value>,
    config_store: super::super::model_guard::ConfigStore,
    config_options: Vec<(String, Value)>,
    events: SessionSink,
    sessions: &SessionMap,
    pending: &PendingPermissions,
    mut ops: SessionOps,
    operation: Operation,
    mut mcp: Option<super::super::transient_mcp::TransientMcpOpen>,
    browser_unavailable: Option<super::super::transient_mcp::McpUnavailable>,
) -> Result<OpenedSession, String> {
    // Direct manager commands share the same immutable admission as wrappers.
    purpose.validate(
        native_session_id.as_deref(),
        preview_token.as_deref(),
        config_options.is_empty(),
        mcp.is_some(),
    )?;
    if let Some(id) = &native_session_id {
        super::super::session_tool_recovery::require_ready(&config_store, id).await?;
        let map = sessions.lock().map_err(|_| "session map lock poisoned")?;
        if map.contains_key(id) {
            return Err(format!("session {id} is already open"));
        }
    }

    let has_mcp = mcp.is_some();
    let describe_open_error = |error: agent_client_protocol::Error| {
        if has_mcp {
            super::super::transient_mcp::safe_open_error()
        } else if error.code == agent_client_protocol::schema::v1::ErrorCode::AuthRequired {
            "AUTH_REQUIRED".into()
        } else {
            // Peer text cannot claim an application-owned opening outcome.
            "会话未能打开，请重试".into()
        }
    };

    let downstream = events;
    let history_evidence = super::super::history_empty::Evidence::default();
    let observing_history = history_evidence.clone();
    let interested = operation.observer();
    let events: SessionSink = Arc::new(move |value| {
        observing_history.observe(&value);
        if interested.interested() {
            downstream(value);
        }
    });
    let (inbox_tx, mut inbox_rx) = ops.life.routes.channel();
    let (control_tx, control_rx) = mpsc::unbounded_channel::<SessionControl>();

    // Questions required by load cannot wait in the pump inbox until load
    // itself returns. Their owner exists only for this opening operation.
    let _inquiries = native_session_id.as_ref().map(|id| {
        ops.inquiries
            .opening_session(id, &operation, events.clone())
    });
    let resumed = native_session_id.is_some();
    let mut received =
        load_notifications::Opening::new(native_session_id.as_deref(), &ops, pending);
    let (session_id, mut response, guard, retention, identity) = match native_session_id {
        None => {
            let params = super::super::transient_mcp::session_params(cwd, None, mcp.as_ref());
            let request =
                UntypedMessage::new("session/new", &params).map_err(describe_open_error)?;
            let response = ops
                .inquiries
                .request(
                    &operation,
                    cx,
                    || cx.send_request_to(Agent, request),
                    events.clone(),
                )
                .await
                .map_err(describe_open_error)?;
            // The remote conversation now exists even if response validation or
            // route registration fails. Preserve that unconfirmed state.
            let retention = ops.life.session()?;
            let mut identity =
                super::super::lifecycle::OpenIdentity::new(ops.life.clone(), ops.opening.take())
                    .with_history(operation.history());
            let session_id = response
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or_else(|| "session/new response lacks sessionId".to_string())?
                .to_string();
            ops.verify_session_identity(&session_id, false, &mut identity)?;
            if let Some(token) = &opening_token {
                events(
                    serde_json::json!({"kind":"sessionOpening", "openToken":token,
                    "connectionId":ops.connection_id, "sessionId":session_id, "cwd":cwd.to_string_lossy()}),
                );
            }
            let guard = ops.life.routes.register(
                &session_id,
                inbox_tx,
                operation.abandoned.clone(),
                events.clone(),
            )?;
            (session_id, response, guard, retention, identity)
        }
        Some(id) => {
            // This synchronous original-connection registration precedes load.
            // No queued SDK registration or hidden retry storage is involved.
            let guard = ops.life.routes.register(
                &id,
                inbox_tx,
                operation.abandoned.clone(),
                events.clone(),
            )?;
            if let Some(token) = &opening_token {
                events(
                    serde_json::json!({"kind":"sessionOpening", "openToken":token,
                    "connectionId":ops.connection_id, "sessionId":id, "cwd":cwd.to_string_lossy()}),
                );
            }
            let params = super::super::transient_mcp::session_params(cwd, Some(&id), mcp.as_ref());
            let request =
                UntypedMessage::new("session/load", &params).map_err(describe_open_error)?;
            let load = ops.inquiries.request(
                &operation,
                cx,
                || cx.send_request_to(Agent, request),
                events.clone(),
            );
            let presentation = super::super::live_status::Owner::loading(
                &ops,
                &id,
                purpose,
                preview_token.as_deref(),
                &operation,
            );
            match received
                .as_mut()
                .expect("load owns its dispatch state")
                .while_loading(
                    &id,
                    &mut inbox_rx,
                    &events,
                    pending,
                    (&ops, &presentation),
                    load,
                )
                .await
            {
                Ok(response) => {
                    let retention = ops.life.session()?;
                    let mut identity = super::super::lifecycle::OpenIdentity::new(
                        ops.life.clone(),
                        ops.opening.take(),
                    )
                    .with_history(operation.history());
                    ops.verify_session_identity(&id, true, &mut identity)?;
                    (id, response, guard, retention, identity)
                }
                Err(error) => {
                    drop(guard);
                    return Err(describe_open_error(error));
                }
            }
        }
    };

    let mut history_empty_confirmed = false;
    if resumed
        && purpose == super::super::open_purpose::OpenPurpose::Conversation
        && ops.live_status_enabled
    {
        let source = super::super::live_status::Owner::loading(
            &ops,
            &session_id,
            purpose,
            preview_token.as_deref(),
            &operation,
        );
        let prefix = received.as_mut().expect("restored session owns its prefix");
        prefix.drain(
            &session_id,
            &mut inbox_rx,
            &events,
            pending,
            (&ops, &source),
        );
        if history_evidence.eligible() {
            history_empty_confirmed = prefix
                .while_loading(
                    &session_id,
                    &mut inbox_rx,
                    &events,
                    pending,
                    (&ops, &source),
                    super::super::history_empty::read(cx, &ops, &operation, &session_id, cwd),
                )
                .await;
            prefix.drain(
                &session_id,
                &mut inbox_rx,
                &events,
                pending,
                (&ops, &source),
            );
        }
    }

    // Supplement only an ordinary restored conversation, within this exact
    // opening and before the existing actor/complete-marker handoff.
    if resumed
        && purpose == super::super::open_purpose::OpenPurpose::Conversation
        && preview_token.is_none()
        && let (Some(source), Some(token)) = (&ops.history_supplement_source, &opening_token)
    {
        let presentation =
            super::super::live_status::Owner::loading(&ops, &session_id, purpose, None, &operation);
        let prefix = received.as_mut().expect("restored session owns its prefix");
        prefix.drain(
            &session_id,
            &mut inbox_rx,
            &events,
            pending,
            (&ops, &presentation),
        );
        let result = prefix
            .while_loading(
                &session_id,
                &mut inbox_rx,
                &events,
                pending,
                (&ops, &presentation),
                super::super::history_supplement::read(
                    source.clone(),
                    &config_store,
                    cwd,
                    &session_id,
                    &response,
                    &operation,
                    &ops.life,
                ),
            )
            .await;
        prefix.drain(
            &session_id,
            &mut inbox_rx,
            &events,
            pending,
            (&ops, &presentation),
        );
        if operation.interested()
            && ops.life.state.load(Ordering::SeqCst) == super::super::lifecycle::READY
        {
            events(super::super::history_supplement::event(
                result,
                token,
                &ops.connection_id,
                &session_id,
                &cwd.to_string_lossy(),
            ));
        }
    }

    if !resumed {
        let row_id = super::super::session_index::session_row_id(
            &config_store.agent_id,
            &config_store.cwd,
            &session_id,
        );
        let exists = config_store
            .store
            .run(move |store| Ok(store.get_session(&row_id)?.is_some()))
            .await?;
        if exists {
            return Err("Agent 返回的对话标识已有历史记录，请先断开新连接后检查接入".into());
        }
    }
    let mut warnings = Vec::new();
    let dialect = ops.configuration_dialect;
    let mut configuration =
        super::super::session_config::SessionConfig::from_connection(&response, dialect);
    let mut config_state = configuration.options();
    config_store.validate_goose_provider(configuration.modern_options())?;
    if config_options
        .iter()
        .any(|(id, _)| config_store.protects_provider_option(id))
    {
        return Err("此对话已选择 API 服务，不能更换提供方".into());
    }
    let mut permission_guard = super::super::permission_guard::PermissionGuard::new(
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
    let protected_ids = super::super::model_guard::ModelGuard::for_connection(
        config_state.as_ref().unwrap_or(&Value::Null),
        recorded_config.as_ref(),
        resumed,
        dialect,
    )
    .protected_ids();
    if resumed
        && config_options.iter().any(|(id, _)| {
            matches!(id.as_str(), "model" | "thought_level" | "reasoning_effort")
                || dialect.is_vibe_thinking(id)
                || initial_models.contains(id)
                || protected_ids.contains(id)
        })
    {
        return Err("恢复会话不能修改模型或思考深度".into());
    }
    if resumed
        && synthetic_mode_state(&response, configuration.modern_options()).is_some()
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
            && let Some(modes) = synthetic_mode_state(&response, configuration.modern_options())
        {
            if let Err(error) =
                restore_synthetic_mode(cx, &session_id, &mut response, modes, value, &operation)
                    .await
            {
                warnings.push(format!("{config_id}: {error}"));
            }
            continue;
        }
        match configuration.prepare(config_id, value) {
            Err(error) => {
                if permission_guard.is_permission(config_id) {
                    permission_guard.unknown();
                }
                warnings.push(format!("{config_id}: {error}"));
            }
            Ok(request) => match request.send(cx, &session_id, &operation).await {
                Ok(response) => {
                    let updated = configuration.complete(&request, response);
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
                    warnings.push(format!("{config_id}: {error}"));
                }
            },
        }
    }

    if !resumed || config_store.is_goose_relay() {
        config_store.validate_model(config_state.as_ref().unwrap_or(&Value::Null))?;
    }
    config_store.validate_service().await?;
    let mut model_guard = super::super::model_guard::ModelGuard::for_connection(
        config_state.as_ref().unwrap_or(&Value::Null),
        recorded_config.as_ref(),
        resumed,
        dialect,
    );
    if configuration.has_invalid_options() {
        model_guard.change_unknown();
    }
    let mut deferred_models = model_ids(config_state.as_ref().unwrap_or(&Value::Null));
    if let Some(received) = received.as_mut() {
        if purpose == super::super::open_purpose::OpenPurpose::Conversation
            && recorded_config.is_none()
        {
            let presentation = super::super::live_status::Owner::loading(
                &ops,
                &session_id,
                purpose,
                preview_token.as_deref(),
                &operation,
            );
            received.drain(
                &session_id,
                &mut inbox_rx,
                &events,
                pending,
                (&ops, &presentation),
            );
        }
        let (models, invalid) = std::mem::take(&mut received.deferred).apply(&mut configuration);
        deferred_models.extend(models);
        config_state = configuration.options();
        if let Some(options) = &config_state {
            model_guard.observe(options);
            permission_guard.observe(options);
        }
        if invalid {
            model_guard.change_unknown();
        }
    }
    config_store.validate_goose_provider(configuration.modern_options())?;
    let prompt_snapshot = Arc::new(Mutex::new(model_guard.current_value()));
    let events = super::super::active_prompt::observed_sink(events, prompt_snapshot.clone());
    let (ready_tx, ready_rx) = oneshot::channel();
    let mut initial_models = model_ids(config_state.as_ref().unwrap_or(&Value::Null));
    initial_models.extend(deferred_models);
    let opening = restore_config::Opening {
        purpose,
        reply: Some(ready_tx),
        operation,
        recorded: recorded_config,
        restored: resumed,
        options: config_state,
        config_options_modern: configuration.modern_options().is_some(),
        warnings,
    };
    let mut opening_route = OpeningRoute {
        sessions: sessions.clone(),
        session_id: session_id.clone(),
        control: control_tx.clone(),
        delivered: false,
    };
    let mcp_lease = mcp
        .as_mut()
        .map(|offer| offer.bind_route(&session_id))
        .transpose()?;
    let mcp_requests = mcp_lease
        .as_ref()
        .map(|lease| lease.requests())
        .unwrap_or_default();
    sessions
        .lock()
        .map_err(|_| "session map lock poisoned")?
        .insert(
            session_id.clone(),
            SessionEntry {
                connection_id: ops.connection_id.clone(),
                purpose,
                preview_token,
                // A loaded conversation can resolve to a persisted location
                // different from cwd. The rules response has no location echo.
                permission_rules_scope_verified: !resumed
                    && response.pointer("/_meta/dev.dirac~1worktree").is_none(),
                workspace: Some(Vec::new()),
                browser_unavailable,
                tools_report: Arc::new(super::super::session_tools::Slot::new(
                    &control_tx,
                    &response,
                )),
                control: control_tx,
                events: events.clone(),
                process_ended_sink: None,
                prompt_snapshot,
                prompt_store: config_store.store.clone(),
                _guard: guard,
                _mcp_lease: mcp_lease,
                browser_requests: mcp_requests.clone(),
                _retention: retention.registered(),
            },
        );
    let received = received
        .take()
        .unwrap_or_else(|| load_notifications::State::new(&session_id, &ops));
    // Publish ownership before the pump can finish or receive a close request.
    // Removing the route then releases the retention under the admission lock.
    let connection_id = ops.connection_id.clone();
    super::super::manager::runtime().spawn(session_pump(
        cx.clone(),
        session_id.clone(),
        inbox_rx,
        control_rx,
        events,
        pending.clone(),
        sessions.clone(),
        ops,
        configuration,
        initial_models,
        model_guard,
        permission_guard,
        config_store,
        opening,
        Some(mcp_requests),
        received,
    ));

    let ready = ready_rx
        .await
        .map_err(|_| "会话未能打开，请重试".to_string())??;
    opening_route.delivered = true;
    let declared_thought_mode_mirror = (!resumed)
        .then(|| super::super::session_config::pi::declared_thought_mode_mirror(&response))
        .flatten();
    if !dialect.is_vibe_family()
        && let Some(options) = &ready.options
    {
        response["configOptions"] = options.clone();
    }
    if let Some(mcp) = mcp.take() {
        mcp.finish_opening();
    }
    Ok(OpenedSession {
        history_empty_confirmed: history_empty_confirmed && history_evidence.eligible(),
        identity,
        purpose,
        connection_id,
        session_id,
        response,
        config_options: ready.options,
        config_options_modern: ready.config_options_modern,
        declared_thought_mode_mirror,
        config_check: ready.check,
        permission_config_id: ready.permission_config_id,
        permission_state: ready.permission_state,
        permission_effect: ready.permission_effect,
        warnings: ready.warnings,
    })
}
