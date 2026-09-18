use super::turns::*;
use super::workspace::*;
use super::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PiProviderRequest {
    pub(crate) version: u32,
    pub(crate) host_turn_id: HostTurnId,
    pub(crate) session_id: NativeSessionId,
    pub(crate) runtime_provider_id: String,
    pub(crate) runtime_model_id: String,
    pub(crate) native_model_id: String,
    pub(crate) native_timestamp: u64,
    pub(crate) completed_at: u64,
    pub(crate) native_stop_reason: String,
}

pub(crate) fn provider_request_receipt(
    response: &Result<Value, AcpDispatchError>,
) -> Result<Option<PiProviderRequest>, String> {
    let (value, failed) = match response {
        Ok(value) if value["stopReason"] == "end_turn" => {
            (value.pointer("/_meta/farfoldPiProviderRequest"), false)
        }
        Err(AcpDispatchError::Rejected {
            data: Some(value), ..
        }) if value["farfoldOutcomeUnknown"] == false && value["nativeStopReason"] == "error" => {
            (value.get("farfoldPiProviderRequest"), true)
        }
        _ => return Ok(None),
    };
    let Some(value) = value else { return Ok(None) };
    let receipt: PiProviderRequest =
        serde_json::from_value(value.clone()).map_err(|_| "Pi 原生 Provider 回执格式不匹配")?;
    if receipt.version != 1
        || !matches!(
            (failed, receipt.native_stop_reason.as_str()),
            (true, "error") | (false, "stop" | "length")
        )
        || receipt.runtime_provider_id.is_empty()
        || receipt.native_model_id.is_empty()
        || receipt.runtime_model_id
            != format!(
                "{}/{}",
                receipt.runtime_provider_id, receipt.native_model_id
            )
        || receipt.native_timestamp > receipt.completed_at
        || receipt.completed_at > crate::host_store::now_millis() as u64
    {
        return Err("Pi 原生 Provider 回执身份或结果不一致".into());
    }
    Ok(Some(receipt))
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PiAcpConfigId {
    Model,
    ThoughtLevel,
}

impl PiAcpConfigId {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Model => "model",
            Self::ThoughtLevel => "thought_level",
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PiAcpConfigInput {
    pub(crate) farfold_session_id: FarfoldSessionId,
    pub(crate) native_session_id: NativeSessionId,
    pub(crate) runtime_generation: u64,
    pub(crate) config_id: PiAcpConfigId,
    pub(crate) value: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PiAcpApplyProviderInput {
    pub(crate) farfold_session_id: FarfoldSessionId,
    pub(crate) native_session_id: NativeSessionId,
    pub(crate) runtime_generation: u64,
    pub(crate) provider: ManagedProviderSelection,
}

pub(crate) fn selected_config<'a>(options: &'a Value, id: &str) -> Option<&'a str> {
    options
        .as_array()?
        .iter()
        .find(|option| option["id"] == id && option["type"] == "select")?
        .get("currentValue")?
        .as_str()
}

pub(crate) fn response_native_first_use(
    value: &Value,
) -> Result<Option<PiNativeFirstUseState>, String> {
    let Some(raw) = value.pointer("/_meta/farfoldPi/nativeFirstUse") else {
        return Ok(None);
    };
    let state: PiNativeFirstUseState = serde_json::from_value(raw.clone())
        .map_err(|_| "Pi 原生首次使用状态格式无效".to_string())?;
    state.validate()?;
    Ok(Some(state))
}

pub(crate) fn observed_model_source(
    options: &Value,
    managed: &[ManagedAcpProviderBinding],
) -> Result<PiModelSource, String> {
    let selector =
        selected_config(options, "model").ok_or("Pi 原生模型选择缺失；不能推断配置来源")?;
    let (provider, model) = selector
        .split_once('/')
        .filter(|(provider, model)| {
            !provider.is_empty()
                && !model.is_empty()
                && provider.len() <= 200
                && selector.len() <= 512
        })
        .ok_or("Pi 原生模型身份无效；不能推断配置来源")?;
    if let Some(binding) = managed.iter().find(|binding| {
        selector == binding.runtime_model_id && provider == binding.runtime_provider_id
    }) {
        return Ok(PiModelSource::ManagedVersion {
            binding: binding.clone(),
        });
    }
    if managed
        .iter()
        .any(|binding| provider == binding.runtime_provider_id)
        || provider.starts_with("farfold-managed-")
    {
        return Err("Pi 模型使用未匹配的托管版本；不能将其降格为原生观察".into());
    }
    Ok(PiModelSource::NativeObservation {
        runtime_provider_id: provider.into(),
        runtime_model_id: selector.into(),
        native_model_id: model.into(),
    })
}

pub(crate) fn set_config_option(
    controller: &crate::session_controller::HostSessionController,
    runtime: &PiAcpRuntime,
    store: &HostStore,
    router: &RuntimeEventRouter,
    turns: &crate::turn_coordinator::TurnCoordinator,
    input: PiAcpConfigInput,
) -> Result<PiAcpStatus, String> {
    if input.value.is_empty() || input.value.len() > 1024 {
        return Err("Pi 配置值为空或超过大小限制".into());
    }
    let gate = settlement_gate(runtime)?;
    let _guard = gate.lock().map_err(|_| "Pi 结算锁不可用")?;
    let (target, token, expected_model, expected_source, dispatched) = controller.exclusive(|| {
        let target = store.session_open_target(&input.farfold_session_id)?;
        if target.native_session_id != input.native_session_id {
            return Err("Pi 配置原生会话不匹配".into());
        }
        if turns.has_active_session(&input.farfold_session_id)? {
            return Err("Pi 当前任务未结束；配置不能改变活动任务".into());
        }
        let handle = runtime.connection()?;
        let mut connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
        require_live_target(&connection, &target)?;
        if connection.generation != input.runtime_generation {
            return Err("Pi 配置属于旧连接代次".into());
        }
        connection.update_events(router)?;
        if let Some(integrity) = &connection.profile_integrity {
            integrity.verify()?;
        }
        let expected_model = if matches!(input.config_id, PiAcpConfigId::Model) {
            input.value.clone()
        } else {
            selected_config(&connection.config_options, "model").ok_or("Pi 当前模型缺失")?.to_owned()
        };
        let expected_source = observed_model_source(&json!([{"id":"model","type":"select","currentValue":expected_model}]), &connection.managed_versions)?;
        if expected_source.managed_binding().is_none() && connection.profile_integrity.is_none() {
            return Err("Pi 原生模型需要稳定自有 profile".into());
        }
        if !matches!(input.config_id, PiAcpConfigId::Model) && expected_source.managed_binding().is_none()
            && connection.confirmed_native_selection.as_ref() != Some(&expected_source) {
            return Err("Pi 原生模型尚未通过明确选择与实际状态确认".into());
        }
        let supported = connection.config_options.as_array().is_some_and(|options| {
            options.iter().any(|option| option["id"] == input.config_id.as_str()
                && option["type"] == "select"
                && option["options"].as_array().is_some_and(|choices| choices.iter().any(|choice| choice["value"] == input.value)))
        });
        if !supported {
            return Err("Pi 当前原生配置目录不支持此选项".into());
        }
        let unresolved = connection.transport.has_unresolved_work()?;
        let token = connection.operations.begin(AcpSessionOperationKind::Configure,
            Some(input.native_session_id.to_string()), Some(input.native_session_id.as_str()), unresolved)?;
        let dispatched = connection.transport.begin_request_unbounded("session/set_config_option", json!({
            "sessionId":input.native_session_id, "configId":input.config_id.as_str(), "value":input.value,
        }));
        Ok((target, token, expected_model, expected_source, dispatched))
    })?;
    let response = dispatched.and_then(|pending| pending.wait_timeout(REQUEST_TIMEOUT));
    let native_state = if expected_source.managed_binding().is_none() && response.is_ok() {
        Some(read_workspace_snapshot(
            runtime,
            store,
            router,
            PiAcpWorkspaceInput {
                farfold_session_id: input.farfold_session_id.clone(),
                native_session_id: input.native_session_id.clone(),
                runtime_generation: input.runtime_generation,
                section: PiWorkspaceSection::State,
            },
        ))
    } else {
        None
    };
    controller.exclusive(|| {
        let handle = runtime.connection()?;
        let mut connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
        require_live_target(&connection, &target)?;
        if connection.generation != input.runtime_generation {
            return Err("Pi 配置回执属于旧连接代次；不更新当前配置".into());
        }
        match &response {
            Err(AcpDispatchError::NotSent(_))
            | Err(AcpDispatchError::Rejected {
                code: -32600 | -32601,
                ..
            }) => {
                connection.operations.complete(token)?;
                return Err("Pi 配置未发送或已被明确拒绝".into());
            }
            Err(AcpDispatchError::Rejected { code: -32602, .. }) => {
                connection.operations.complete(token)?;
                return Err("Pi 原生配置参数被拒绝".into());
            }
            _ => {}
        }
        let confirmed = response
            .as_ref()
            .ok()
            .and_then(|result| result.get("configOptions"))
            .filter(|options| {
                selected_config(options, input.config_id.as_str()) == Some(input.value.as_str())
                    && selected_config(options, "model") == Some(expected_model.as_str())
            });
        let Some(options) = confirmed else {
            let error = "Pi 配置是否生效未确认；不能继续任务，请断开原连接后恢复".to_string();
            connection.last_error = Some(error.clone());
            return Err(error);
        };
        if expected_source.managed_binding().is_none() {
            if connection.native_first_use.is_some() {
                let ready = response
                    .as_ref()
                    .ok()
                    .and_then(|value| response_native_first_use(value).ok())
                    .flatten();
                if ready.as_ref().and_then(PiNativeFirstUseState::ready_source)
                    != Some(expected_source.clone())
                {
                    let error =
                        "Pi 原生首次使用的模型选择状态未持久确认；请断开后恢复核对".to_string();
                    connection.last_error = Some(error.clone());
                    return Err(error);
                }
                connection.native_first_use = ready;
            }
            let actual = native_state
                .as_ref()
                .and_then(|state| state.as_ref().ok())
                .and_then(|state| {
                    connection.native.as_ref().and_then(|native| {
                        idle_model_source(state, native, &connection.managed_versions).ok()
                    })
                });
            if actual.as_ref() != Some(&expected_source) {
                let error = "Pi 原生模型应用后的空闲状态未确认；请断开后恢复核对".to_string();
                connection.last_error = Some(error.clone());
                return Err(error);
            }
            if connection
                .profile_integrity
                .as_ref()
                .is_none_or(|integrity| integrity.verify().is_err())
            {
                let error = "Pi 原生模型应用后 profile 校验失败；请断开后恢复核对".to_string();
                connection.last_error = Some(error.clone());
                return Err(error);
            }
            connection.confirmed_native_selection = Some(expected_source.clone());
        } else {
            connection.confirmed_native_selection = None;
        }
        connection.config_options = options.clone();
        connection.operations.complete(token)?;
        Ok(())
    })?;
    current_status(runtime, router)
}

pub(crate) fn apply_provider(
    controller: &crate::session_controller::HostSessionController,
    runtime: &PiAcpRuntime,
    store: &HostStore,
    router: &RuntimeEventRouter,
    turns: &crate::turn_coordinator::TurnCoordinator,
    app_data: &Path,
    input: PiAcpApplyProviderInput,
) -> Result<PiAcpStatus, String> {
    let gate = settlement_gate(runtime)?;
    let _guard = gate.lock().map_err(|_| "Pi 配置锁不可用")?;
    let (target, handle, token, original_source) = controller.exclusive(|| {
        let target = store.session_open_target(&input.farfold_session_id)?;
        crate::session_controller::require_session_target(target.project_blockers())?;
        if target.native_session_id != input.native_session_id
            || turns.has_active_session(&input.farfold_session_id)?
        {
            return Err("Pi Provider 目标不匹配或仍有活动任务".into());
        }
        let handle = runtime.connection()?;
        let mut connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
        connection.update_events(router)?;
        let source = verify_prompt_connection(&connection, &target, input.runtime_generation)?;
        if connection.profile_integrity.is_none() {
            return Err("旧 Pi profile 不能原地添加 Provider 版本".into());
        }
        let unresolved = connection.transport.has_unresolved_work()?;
        let token = connection.operations.begin(
            AcpSessionOperationKind::Configure,
            Some(input.native_session_id.to_string()),
            Some(input.native_session_id.as_str()),
            unresolved,
        )?;
        drop(connection);
        Ok((target, handle, token, source))
    })?;
    let state_input = || PiAcpWorkspaceInput {
        farfold_session_id: input.farfold_session_id.clone(),
        native_session_id: input.native_session_id.clone(),
        runtime_generation: input.runtime_generation,
        section: PiWorkspaceSection::State,
    };
    let mut committed = false;
    let result = (|| -> Result<(), String> {
        let before = read_workspace_snapshot(runtime, store, router, state_input())?;
        let (projection, pending) = controller.exclusive(|| {
            let mut connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
            require_live_target(&connection, &target)?;
            if connection.generation != input.runtime_generation {
                return Err("Pi Provider 操作代次已失效".into());
            }
            let native = connection.native.as_ref().ok_or("Pi 原生会话缺失")?;
            if idle_model_source(&before, native, &connection.managed_versions)? != original_source
            {
                return Err("Pi 配置写入前实际模型已改变".into());
            }
            let projection = connection
                .profile_integrity
                .as_ref()
                .ok_or("Pi 自有配置保护缺失")?
                .project_version(app_data, store, &connection.binding, &input.provider)?;
            committed = true;
            projection.integrity.verify()?;
            let pending = connection
                .transport
                .begin_request_unbounded(
                    "_pi/refresh_profile",
                    json!({"sessionId":input.native_session_id}),
                )
                .map_err(|_| "Pi 配置已写入，但刷新未确认")?;
            connection.update_events(router)?;
            Ok((projection, pending))
        })?;
        let refreshed = pending
            .wait_timeout(REQUEST_TIMEOUT)
            .map_err(|_| "Pi 配置已写入，但刷新结果未确认")?;
        let pending = controller.exclusive(|| {
            let connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
            require_live_target(&connection, &target)?;
            if connection.generation != input.runtime_generation || refreshed["version"] != 1
                || refreshed.get("nativeSession") != Some(&json!(connection.native.as_ref().ok_or("Pi 原生会话缺失")?)) {
                return Err("Pi 刷新未确认原连接和原生会话".into());
            }
            projection.integrity.verify()?;
            connection.transport.begin_request_unbounded("session/set_config_option", json!({"sessionId":input.native_session_id,"configId":"model","value":projection.selected.runtime_model_id}))
                .map_err(|_| "Pi 已刷新，但模型选择未确认".into())
        })?;
        let selected = pending
            .wait_timeout(REQUEST_TIMEOUT)
            .map_err(|_| "Pi 模型选择结果未确认")?;
        let options = selected
            .get("configOptions")
            .ok_or("Pi 模型选择缺少配置回执")?;
        if observed_model_source(options, &projection.managed_versions)?.managed_binding()
            != Some(&projection.selected)
        {
            return Err("Pi 模型选择回执不匹配指定版本".into());
        }
        let after = read_workspace_snapshot(runtime, store, router, state_input())?;
        controller.exclusive(|| {
            let mut connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
            require_live_target(&connection, &target)?;
            if connection.generation != input.runtime_generation {
                return Err("Pi Provider 应用结果属于旧代次".into());
            }
            let native = connection.native.as_ref().ok_or("Pi 原生会话缺失")?;
            if idle_model_source(&after, native, &projection.managed_versions)?.managed_binding()
                != Some(&projection.selected)
            {
                return Err("Pi 实际模型未确认指定 Provider 版本".into());
            }
            projection.integrity.verify()?;
            store
                .authorize_runtime_profile_provider_version(&connection.binding, &input.provider)?;
            let provider = &projection.selected;
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
                detail: Some("同一 Pi 会话已刷新并确认指定版本模型；尚无实际请求验证".into()),
            })?;
            connection.update_events(router)?;
            connection.operations.complete(token)?;
            connection.managed_versions = projection.managed_versions;
            connection.profile_integrity = Some(projection.integrity);
            connection.config_options = options.clone();
            connection.confirmed_native_selection = None;
            Ok(())
        })
    })();
    if let Err(error) = result {
        let mut connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
        if !committed {
            connection.operations.complete(token)?;
        } else {
            connection.last_error = Some(format!(
                "{error}；配置可能已改变，请断开原连接后恢复，不会自动重发"
            ));
        }
        return Err(connection.last_error.clone().unwrap_or(error));
    }
    current_status(runtime, router)
}

#[tauri::command]
pub async fn pi_acp_apply_provider(
    app: AppHandle,
    input: PiAcpApplyProviderInput,
) -> Result<PiAcpStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|_| "Pi 应用数据目录不可用")?;
        apply_provider(
            &app.state::<crate::session_controller::HostSessionController>(),
            &app.state::<PiAcpRuntime>(),
            &app.state::<HostStore>(),
            &app.state::<RuntimeEventRouter>(),
            &app.state::<crate::turn_coordinator::TurnCoordinator>(),
            &app_data,
            input,
        )
    })
    .await
    .map_err(|_| "Pi Provider 应用操作被中断".to_string())?
}

#[tauri::command]
pub async fn pi_acp_set_config_option(
    app: AppHandle,
    input: PiAcpConfigInput,
) -> Result<PiAcpStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        set_config_option(
            &app.state::<crate::session_controller::HostSessionController>(),
            &app.state::<PiAcpRuntime>(),
            &app.state::<HostStore>(),
            &app.state::<RuntimeEventRouter>(),
            &app.state::<crate::turn_coordinator::TurnCoordinator>(),
            input,
        )
    })
    .await
    .map_err(|_| "Pi 配置请求被中断".to_string())?
}

pub(crate) fn managed_binding(
    selection: &ManagedProviderSelection,
) -> Result<RuntimeBinding, String> {
    let mut binding: RuntimeBinding = PI_ACP_RUNTIME.into();
    binding.connection_id = ConnectionId::parse(derived_host_id(
        "connection",
        &[
            binding.product_id.as_str(),
            binding.installation_id.as_str(),
            binding.runtime_build_id.as_str(),
            binding.adapter_id.as_str(),
            selection.provider_connection_id.as_str(),
            selection.provider_config_version_id.as_str(),
        ],
    ))
    .map_err(|error| error.to_string())?;
    Ok(binding)
}

pub(crate) fn saved_provider(
    store: &HostStore,
    binding: &RuntimeBinding,
) -> Result<ManagedProviderSelection, String> {
    for provider in
        store.provider_connections_by_source(ProviderConnectionSource::FarfoldManaged)?
    {
        for version in store.provider_connection_versions(&provider.provider_connection_id)? {
            let selection = ManagedProviderSelection {
                provider_connection_id: provider.provider_connection_id.clone(),
                provider_config_version_id: version.config_version_id,
            };
            if managed_binding(&selection)? == *binding {
                return Ok(selection);
            }
        }
    }
    Err("Pi ACP 原绑定的 Provider 配置版本不可用；不会改用当前版本或新建会话".into())
}

pub(crate) fn new_owned_profile(
    selection: impl Into<Option<ManagedProviderSelection>>,
) -> Result<RuntimeOwnedProfile, String> {
    let mut entropy = [0_u8; 32];
    getrandom::fill(&mut entropy).map_err(|_| "Cannot allocate a Runtime profile identity")?;
    let profile_id =
        RuntimeProfileId::parse(derived_host_id("profile", &[&format!("{entropy:x?}")]))
            .map_err(|error| error.to_string())?;
    let mut binding: RuntimeBinding = PI_ACP_RUNTIME.into();
    binding.connection_id = stable_profile_connection(&binding, &profile_id)?;
    Ok(RuntimeOwnedProfile {
        profile_id,
        binding,
        layout: OwnedProfileLayout::StableV1,
        bootstrap_managed_provider: selection.into(),
    })
}

pub(crate) fn stable_profile_connection(
    binding: &RuntimeBinding,
    profile_id: &RuntimeProfileId,
) -> Result<ConnectionId, String> {
    ConnectionId::parse(derived_host_id(
        "profile-connection",
        &[
            binding.product_id.as_str(),
            binding.installation_id.as_str(),
            binding.runtime_build_id.as_str(),
            binding.adapter_id.as_str(),
            profile_id.as_str(),
        ],
    ))
    .map_err(|error| error.to_string())
}

pub(crate) fn saved_owned_profile(
    store: &HostStore,
    binding: &RuntimeBinding,
) -> Result<RuntimeOwnedProfile, String> {
    if !is_current_managed_binding(binding) {
        return Err("Pi ACP saved profile requires its original verified Runtime build".into());
    }
    if let Some(profile) = store.runtime_owned_profile(binding)? {
        let valid = match profile.layout {
            OwnedProfileLayout::StableV1 => {
                stable_profile_connection(binding, &profile.profile_id)? == binding.connection_id
            }
            OwnedProfileLayout::LegacyProviderBoundV1 => {
                managed_binding(profile.managed_bootstrap()?)? == *binding
                    && profile.profile_id.as_str()
                        == crate::acp_provider_profile::legacy_pi_profile_id(
                            binding,
                            profile.managed_bootstrap()?,
                        )
            }
        };
        return if valid {
            Ok(profile)
        } else {
            Err(
                "Pi ACP saved profile layout or identity does not match; refusing to repair it"
                    .into(),
            )
        };
    }
    // Only the old deterministic binding can be imported. A missing stable reference is not recoverable by Provider search.
    if !binding.connection_id.as_str().starts_with("connection-") {
        return Err("Pi ACP original owned profile reference is missing; refusing to substitute a Provider profile".into());
    }
    let selection = saved_provider(store, binding)?;
    Ok(RuntimeOwnedProfile {
        profile_id: RuntimeProfileId::parse(crate::acp_provider_profile::legacy_pi_profile_id(
            binding, &selection,
        ))
        .map_err(|error| error.to_string())?,
        binding: binding.clone(),
        layout: OwnedProfileLayout::LegacyProviderBoundV1,
        bootstrap_managed_provider: Some(selection),
    })
}
