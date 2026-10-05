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
    native_session_id: Option<String>,
    preview_token: Option<String>,
    recorded_config: Option<Value>,
    config_store: super::super::model_guard::ConfigStore,
    config_options: Vec<(String, Value)>,
    events: SessionSink,
    sessions: &SessionMap,
    pending: &PendingPermissions,
    ops: SessionOps,
    operation: Operation,
    mut mcp: Option<super::super::transient_mcp::TransientMcpOpen>,
    browser_unavailable: Option<super::super::transient_mcp::McpUnavailable>,
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
            super::super::transient_mcp::safe_open_error()
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
    let (session_id, mut response, guard, retention) = match native_session_id {
        None => {
            let params = super::super::transient_mcp::session_params(cwd, None, mcp.as_ref());
            let request =
                UntypedMessage::new("session/new", &params).map_err(describe_open_error)?;
            let response = operation
                .request(cx, cx.send_request_to(Agent, request))
                .await
                .map_err(describe_open_error)?;
            // The remote conversation now exists even if response validation or
            // route registration fails. Preserve that unconfirmed state.
            let retention = ops.life.session()?;
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
            (session_id, response, guard, retention)
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
            let params = super::super::transient_mcp::session_params(cwd, Some(&id), mcp.as_ref());
            let request =
                UntypedMessage::new("session/load", &params).map_err(describe_open_error)?;
            match operation
                .request(cx, cx.send_request_to(Agent, request))
                .await
            {
                Ok(response) => (id, response, guard, ops.life.session()?),
                Err(error) => {
                    drop(guard);
                    return Err(describe_open_error(error));
                }
            }
        }
    };

    let mut warnings = Vec::new();
    let mut config_state = response.get("configOptions").cloned();
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
    let protected_ids = super::super::model_guard::ModelGuard::new(
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

    if !resumed {
        config_store.validate_model(config_state.as_ref().unwrap_or(&Value::Null))?;
    }
    config_store.validate_service().await?;
    let model_guard = super::super::model_guard::ModelGuard::new(
        config_state.as_ref().unwrap_or(&Value::Null),
        recorded_config.as_ref(),
        resumed,
    );
    let (ready_tx, ready_rx) = oneshot::channel();
    let initial_models = model_ids(config_state.as_ref().unwrap_or(&Value::Null));
    let opening = restore_config::Opening {
        reply: Some(ready_tx),
        operation,
        recorded: recorded_config,
        restored: resumed,
        options: config_state,
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
    sessions
        .lock()
        .map_err(|_| "session map lock poisoned")?
        .insert(
            session_id.clone(),
            SessionEntry {
                preview_token,
                browser_unavailable,
                control: control_tx,
                events: events.clone(),
                _guard: guard,
                _mcp_lease: mcp_lease,
                _retention: retention.registered(),
            },
        );
    // Publish ownership before the pump can finish or receive a close request.
    // Removing the route then releases the retention under the admission lock.
    super::super::manager::runtime().spawn(session_pump(
        cx.clone(),
        session_id.clone(),
        inbox_rx,
        control_rx,
        events,
        pending.clone(),
        sessions.clone(),
        ops,
        initial_models,
        model_guard,
        permission_guard,
        config_store,
        opening,
    ));

    let ready = ready_rx
        .await
        .map_err(|_| "会话未能打开，请重试".to_string())??;
    opening_route.delivered = true;
    if let Some(options) = &ready.options {
        response["configOptions"] = options.clone();
    }
    if let Some(mcp) = mcp.take() {
        mcp.finish_opening();
    }
    Ok(OpenedSession {
        session_id,
        response,
        config_options: ready.options,
        config_check: ready.check,
        permission_config_id: ready.permission_config_id,
        permission_state: ready.permission_state,
        warnings: ready.warnings,
    })
}
