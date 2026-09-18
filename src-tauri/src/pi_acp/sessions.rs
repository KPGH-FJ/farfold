use super::admission::*;
use super::configure::*;
use super::*;

#[cfg(test)]
pub(crate) fn open_native_session(
    handle: &Arc<Mutex<PiAcpConnection>>,
    router: &RuntimeEventRouter,
    store: &HostStore,
    requested: Option<&PiNativeSession>,
    title: &str,
) -> Result<PiAcpHostSessionResult, String> {
    open_native_session_request(
        handle,
        router,
        store,
        requested.cloned().map(PiNativeSessionRequest::Exact),
        title,
    )
}

pub(crate) enum PiNativeSessionRequest {
    Exact(PiNativeSession),
    Identity(NativeSessionId),
}

impl PiNativeSessionRequest {
    fn session_id(&self) -> &str {
        match self {
            Self::Exact(native) => &native.session_id,
            Self::Identity(native) => native.as_str(),
        }
    }
}

pub(crate) fn open_native_session_request(
    handle: &Arc<Mutex<PiAcpConnection>>,
    router: &RuntimeEventRouter,
    store: &HostStore,
    requested: Option<PiNativeSessionRequest>,
    title: &str,
) -> Result<PiAcpHostSessionResult, String> {
    let (transport, token, cwd) = {
        let mut connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
        let unresolved = connection.transport.has_unresolved_work()?;
        let native = connection
            .native
            .as_ref()
            .map(|native| native.session_id.clone());
        let token = connection.operations.begin(
            if requested.is_some() {
                AcpSessionOperationKind::Load
            } else {
                AcpSessionOperationKind::New
            },
            requested
                .as_ref()
                .map(|native| native.session_id().to_string()),
            native.as_deref(),
            unresolved,
        )?;
        (connection.transport.clone(), token, connection.cwd.clone())
    };
    let mut params = json!({"cwd":cwd,"mcpServers":[]});
    if let Some(native) = requested.as_ref() {
        params["sessionId"] = json!(native.session_id());
    }
    let native_only = handle
        .lock()
        .map_err(|_| "Pi ACP 连接不可用")?
        .managed_provider
        .is_none();
    if requested.is_none() && native_only {
        params["_meta"] = json!({"farfoldPi":{"allowUnauthenticated":true}});
    }
    let response = transport.request_timeout(
        if requested.is_some() {
            "session/load"
        } else {
            "session/new"
        },
        params,
        REQUEST_TIMEOUT,
    );
    let mut connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
    connection.operations.complete(token)?;
    let response = response.map_err(|error| match error {
        AcpDispatchError::Rejected {
            code: -32600,
            data: Some(data),
        } if data["farfoldPiRestoreBlocked"] == true => match data["reason"].as_str() {
            Some("model_mismatch") => {
                "Pi 未恢复原会话模型；未接受默认模型替代，请恢复原模型配置与认证后重试".into()
            }
            Some("parser_unavailable") => "Pi 原生会话模型解析器不可用；未接受默认模型替代".into(),
            _ => "Pi 原生历史模型无法确认；未接受默认模型替代".into(),
        },
        error => error.to_string(),
    })?;
    let native = match requested.as_ref() {
        Some(PiNativeSessionRequest::Exact(expected)) => native_descriptor(
            &response,
            Some(expected),
            &connection.cwd,
            &connection.sessions_root,
        )?,
        Some(PiNativeSessionRequest::Identity(expected)) => {
            // ACP load has no required top-level sessionId; the request supplies it.
            // Keep any returned ID so native_descriptor still rejects a conflicting value.
            let mut identity_response = response.clone();
            if identity_response.get("sessionId").is_none() {
                identity_response["sessionId"] = json!(expected);
            }
            let native = native_descriptor(
                &identity_response,
                None,
                &connection.cwd,
                &connection.sessions_root,
            )?;
            if native.session_id != expected.as_str() {
                return Err("Pi 空会话冷恢复返回了不同 Session 身份".into());
            }
            native
        }
        None => native_descriptor(&response, None, &connection.cwd, &connection.sessions_root)?,
    };
    let options = response.get("configOptions").cloned().unwrap_or(json!([]));
    let source = selected_config(&options, "model")
        .map(|_| observed_model_source(&options, &connection.managed_versions))
        .transpose()?;
    let first_use = response_native_first_use(&response)?;
    if native_only {
        let state = first_use
            .as_ref()
            .ok_or("Pi 原生首次使用状态缺失；未注册 Host Session")?;
        if let Some(expected) = state.ready_source()
            && source.as_ref() != Some(&expected)
        {
            return Err("Pi 原生首次使用恢复的明确模型不匹配；未接受默认模型".into());
        }
        connection
            .profile_integrity
            .as_ref()
            .ok_or("Pi 原生模型恢复需要稳定自有 profile")?
            .verify()?;
    } else {
        let source = source
            .as_ref()
            .ok_or("Pi ACP 原生 configOptions 缺少已绑定 Provider 模型")?;
        if requested.is_none() && source.managed_binding() != connection.managed_provider.as_ref() {
            return Err("Pi ACP 原生 configOptions 未确认绑定的 Provider 模型".into());
        }
        if matches!(requested, Some(PiNativeSessionRequest::Identity(_)))
            && !native.session_file.exists()
        {
            let anchor = connection
                .managed_pre_file
                .as_ref()
                .ok_or("Pi 受管空会话缺少稳定 profile 所有权")?;
            if first_use.is_some()
                || response.pointer("/_meta/farfoldPi/managedPreFile") != Some(anchor)
                || source.managed_binding() != connection.managed_provider.as_ref()
            {
                return Err("Pi 受管空会话原身份或 bootstrap 证明缺失；未接受替代会话".into());
            }
            connection
                .profile_integrity
                .as_ref()
                .ok_or("Pi 受管空会话 profile 不可验证")?
                .verify()?;
        }
        if source.managed_binding().is_none() {
            connection
                .profile_integrity
                .as_ref()
                .ok_or("Pi 原生模型恢复需要稳定自有 profile")?
                .verify()?;
        }
    }
    transport.bind_client_session(Some(&native.session_id))?;
    connection.native = Some(native.clone());
    connection.confirmed_native_selection = if native_only {
        first_use
            .as_ref()
            .and_then(PiNativeFirstUseState::ready_source)
    } else {
        source
            .as_ref()
            .filter(|source| source.managed_binding().is_none())
            .cloned()
    };
    connection.native_first_use = first_use;
    connection.config_options = options;
    connection.update_events(router)?;
    let farfold_session_id = register_observation(store, &connection, title)?;
    if requested.is_none()
        && let Some(provider) = connection.managed_provider.as_ref()
    {
        store.record_provider_target_projection(&ProviderTargetProjectionInput {
            provider_connection_id: provider.provider_connection_id.clone(),
            config_version_id: provider.provider_config_version_id.clone(),
            runtime_product_id: connection.binding.product_id.clone(),
            installation_id: connection.binding.installation_id.clone(),
            runtime_connection_id: connection.binding.connection_id.clone(),
            runtime_provider_id: provider.runtime_provider_id.clone(),
            runtime_model_id: provider.runtime_model_id.clone(),
            save_state: ProviderSaveState::Saved,
            apply_state: ProviderApplyState::Applied,
            request_state: ProviderRequestState::NotRequested,
            request_verified_version_id: None,
            active_task_policy: ProviderActiveTaskPolicy::CurrentTaskKeepsBoundConfig,
            detail: Some("Pi 原生 configOptions 已确认私有配置模型；尚无实际请求验证".into()),
        })?;
    }
    let (opened_at, navigation) = store.mark_session_opened(&farfold_session_id)?;
    Ok(PiAcpHostSessionResult {
        farfold_session_id,
        installation_id: connection.binding.installation_id.to_string(),
        native_session_id: native.session_id,
        runtime_generation: connection.generation,
        runtime_ready_at: connection.initialized_at,
        opened_at,
        navigation,
    })
}

pub(crate) fn create_host_session(
    app: &AppHandle,
    cwd: &Path,
    selection: Option<ManagedProviderSelection>,
    trust: Option<&str>,
) -> Result<PiAcpHostSessionResult, String> {
    start_host_session(app, cwd, new_owned_profile(selection)?, trust, None)
}

pub(crate) fn open_host_session(
    app: &AppHandle,
    target: &SessionOpenTarget,
    trust: Option<&str>,
) -> Result<PiAcpHostSessionResult, String> {
    crate::session_controller::require_session_target(target.project_blockers())?;
    let store = app.state::<HostStore>();
    let profile = saved_owned_profile(&store, &target.binding())?;
    start_host_session(app, &target.working_copy_path, profile, trust, Some(target))
}

pub(crate) fn start_host_session(
    app: &AppHandle,
    cwd: &Path,
    profile: RuntimeOwnedProfile,
    trust: Option<&str>,
    target: Option<&SessionOpenTarget>,
) -> Result<PiAcpHostSessionResult, String> {
    let runtime = app.state::<PiAcpRuntime>();
    let store = app.state::<HostStore>();
    let router = app.state::<RuntimeEventRouter>();
    let _guard = runtime
        .start_lock
        .lock()
        .map_err(|_| "Pi ACP 启停锁不可用")?;
    let binding = profile.binding.clone();
    let working_copy = crate::host_store::working_copy_manager::registration_preview(cwd)?;
    let cwd = PathBuf::from(working_copy.working_copy_path);
    let turns = app.state::<crate::turn_coordinator::TurnCoordinator>();
    turns.require_runtime_idle(
        binding.product_id.as_str(),
        binding.installation_id.as_str(),
    )?;
    turns.require_working_copy_idle(&working_copy.working_copy_id)?;
    if !runtime.is_stopped()? {
        if let Some(target) = target {
            let handle = runtime.connection()?;
            let mut connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
            require_live_target(&connection, target)?;
            connection.update_events(&router)?;
            let id = register_observation(&store, &connection, &target.title)?;
            if id != target.farfold_session_id {
                return Err("Pi ACP Host Session 身份不一致".into());
            }
            let (opened_at, navigation) = store.mark_session_opened(&id)?;
            return Ok(PiAcpHostSessionResult {
                farfold_session_id: id,
                installation_id: connection.binding.installation_id.to_string(),
                native_session_id: target.native_session_id.to_string(),
                runtime_generation: connection.generation,
                runtime_ready_at: connection.initialized_at,
                opened_at,
                navigation,
            });
        }
        return Err("请先断开当前 Pi ACP 连接；不会替换活动会话".into());
    }
    crate::performance_trace::pi_start_boundary(app, target.is_some());
    let observed = verify_managed_installation(app, PI_ACP_RUNTIME)?;
    let (node, adapter) = adapter_assets(app)?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let prepared = crate::acp_provider_profile::prepare_owned(
        &app_data,
        &app_data.join("pi-acp"),
        &store,
        &profile,
        target.is_none(),
    )?;
    let requested = target
        .map(|target| {
            if target.binding() != binding {
                return Err("Pi ACP 原绑定或原生文件位置不可用".to_string());
            }
            match (&target.locator_kind, target.locator_value.as_deref()) {
                (Some(NativeSessionLocatorKind::PiSessionFile), Some(path)) => {
                    let native = PiNativeSession {
                        version: 1,
                        session_id: target.native_session_id.to_string(),
                        session_file: std::path::PathBuf::from(path),
                        cwd: cwd.clone(),
                    };
                    native_descriptor(
                        &json!({"_meta":{"farfoldPi":{"nativeSession":native}}}),
                        Some(&native),
                        &cwd,
                        &prepared.profile_root.join("sessions"),
                    )
                    .map(PiNativeSessionRequest::Exact)
                }
                (None, None) if profile.layout == OwnedProfileLayout::StableV1 => Ok(
                    PiNativeSessionRequest::Identity(target.native_session_id.clone()),
                ),
                _ => Err("Pi ACP 原绑定或原生文件位置不可用".into()),
            }
        })
        .transpose()?;
    let mut launch_attempted = false;
    let mut connection_started = false;
    let result = (|| {
        // Persist launch ownership before any native Session can be registered.
        store.register_runtime_owned_profile(
            &runtime_registration(&binding, crate::host_store::now_millis()),
            &profile,
        )?;
        if target.is_none()
            && profile.layout == OwnedProfileLayout::StableV1
            && let Some(bootstrap) = profile.bootstrap_managed_provider.as_ref()
        {
            store.authorize_runtime_profile_provider_version(&binding, bootstrap)?;
        }
        let mut command = launch_command(
            &node,
            &adapter,
            &observed.binary_path,
            &cwd,
            &prepared,
            trust,
        )?;
        launch_attempted = true;
        let handle = start_connection(&runtime, &router, binding, &cwd, &prepared, &mut command)?;
        connection_started = true;
        open_native_session_request(
            &handle,
            &router,
            &store,
            requested,
            target.map_or("Pi", |target| &target.title),
        )
    })();
    match result {
        Ok(result) => Ok(result),
        Err(error) => {
            runtime
                .stop_locked(Some(&router))
                .map_err(|stop| format!("{error}；Pi ACP 清理未确认：{stop}"))?;
            // Initialize failures expose no transport handle here, so retain their profile rather than infer confirmed exit from Stopped.
            if target.is_none()
                && (!launch_attempted || connection_started)
                && store.discard_unbound_owned_profile(&profile)?
            {
                fs::remove_dir_all(&prepared.profile_root).map_err(|_| {
                    format!("{error}；新建未绑定 profile 清理失败；未改动已登记会话")
                })?;
            }
            Err(error)
        }
    }
}
