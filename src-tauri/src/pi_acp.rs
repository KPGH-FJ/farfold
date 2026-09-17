use crate::{
    acp_provider_profile::{
        ManagedAcpProviderBinding, PreparedAcpProfile, PreparedPiProfile, protect_directory,
    },
    acp_runtime::{AcpEventConnection, AcpLifecycle, AcpRuntime},
    acp_session_operations::{AcpSessionOperationKind, AcpSessionOperations},
    acp_transport::{AcpDispatchError, AcpTransport},
    host_ids::{
        ConnectionId, FarfoldSessionId, HostTurnId, NativeSessionId, RuntimeProfileId,
        derived_host_id,
    },
    host_store::{
        HostStore,
        provider_projection::{
            ProviderActiveTaskPolicy, ProviderApplyState, ProviderConnectionSource,
            ProviderRequestState, ProviderSaveState, ProviderTargetProjectionInput,
        },
        records::{
            NativeSessionLocatorKind, RuntimeConnectionKind, RuntimeDistribution,
            RuntimeRegistration,
        },
        runtime_owned_profile::{OwnedProfileLayout, RuntimeOwnedProfile},
        session_binding_index::{
            HostNavigationSnapshot, NativeSessionLocator, NativeSessionRegistrationInput,
            register_native_session, register_native_session_with_locator,
        },
        session_open::SessionOpenTarget,
    },
    managed_provider::ManagedProviderSelection,
    runtime_event_router::RuntimeEventRouter,
    runtime_registry::{
        PI_ACP_RUNTIME, RuntimeBinding, RuntimeIdentity, file_sha256, verify_managed_installation,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::{AppHandle, Manager, State};

const ADAPTER_VERSION: &str = "0.0.33-farfold.1";
const NODE_SHA256: &str = "5d9d3872911e2340a43b707962e68143de8a4e8d54628845c0c4f2de1fb7cd5c";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

pub mod native_auth;

pub type PiAcpRuntime = AcpRuntime<PiAcpConnection>;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum PiModelSource {
    ManagedVersion {
        binding: ManagedAcpProviderBinding,
    },
    NativeObservation {
        #[serde(rename = "runtimeProviderId")]
        runtime_provider_id: String,
        #[serde(rename = "runtimeModelId")]
        runtime_model_id: String,
        #[serde(rename = "nativeModelId")]
        native_model_id: String,
    },
}

impl PiModelSource {
    pub(crate) fn managed_binding(&self) -> Option<&ManagedAcpProviderBinding> {
        match self {
            Self::ManagedVersion { binding } => Some(binding),
            Self::NativeObservation { .. } => None,
        }
    }
}

pub(crate) struct PiPromptModelObservation {
    source: PiModelSource,
    binding: RuntimeBinding,
    farfold_session_id: FarfoldSessionId,
    native: PiNativeSession,
    generation: u64,
    observed_at: u64,
}

impl PiPromptModelObservation {
    pub(crate) fn source(&self) -> &PiModelSource {
        &self.source
    }

    pub(crate) fn observed_at(&self) -> u64 {
        self.observed_at
    }

    fn prompt_expectation(&self) -> Value {
        let (provider, model) = match &self.source {
            PiModelSource::ManagedVersion { binding } => binding
                .runtime_model_id
                .split_once('/')
                .expect("validated native selector"),
            PiModelSource::NativeObservation {
                runtime_provider_id,
                native_model_id,
                ..
            } => (runtime_provider_id.as_str(), native_model_id.as_str()),
        };
        json!({"version":1,"sessionId":self.native.session_id,"sessionFile":self.native.session_file,
            "provider":provider,"modelId":model})
    }

    pub(crate) fn verify_target(
        &self,
        target: &SessionOpenTarget,
        generation: u64,
    ) -> Result<(), String> {
        if self.binding != target.binding()
            || self.farfold_session_id != target.farfold_session_id
            || self.native.session_id != target.native_session_id.as_str()
            || self.generation != generation
            || self.observed_at > crate::host_store::now_millis() as u64
        {
            return Err("Pi 模型观察不属于本轮原会话、连接或代次".into());
        }
        Ok(())
    }
}

pub struct PiAcpConnection {
    transport: Arc<AcpTransport>,
    binding: RuntimeBinding,
    generation: u64,
    cwd: PathBuf,
    sessions_root: PathBuf,
    native: Option<PiNativeSession>,
    config_options: Value,
    managed_provider: Option<ManagedAcpProviderBinding>,
    managed_versions: Vec<ManagedAcpProviderBinding>,
    profile_integrity: Option<crate::acp_provider_profile::PiManagedProfileIntegrity>,
    managed_pre_file: Option<Value>,
    initialized_at: i64,
    last_error: Option<String>,
    dropped_events: u64,
    operations: AcpSessionOperations,
    auth_flow: Option<native_auth::AuthFlowBinding>,
    confirmed_native_selection: Option<PiModelSource>,
    native_first_use: Option<PiNativeFirstUseState>,
    settlement_gate: Arc<Mutex<()>>,
    event_pump_stop: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PiNativeSession {
    version: u64,
    session_id: String,
    session_file: PathBuf,
    cwd: PathBuf,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "phase",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum PiNativeFirstUseState {
    AuthenticationRequired {
        version: u64,
    },
    ModelSelectionRequired {
        version: u64,
    },
    Ready {
        version: u64,
        provider: String,
        model_id: String,
    },
}

impl PiNativeFirstUseState {
    fn validate(&self) -> Result<(), String> {
        let (version, model) = match self {
            Self::AuthenticationRequired { version } | Self::ModelSelectionRequired { version } => {
                (*version, None)
            }
            Self::Ready {
                version,
                provider,
                model_id,
            } => (*version, Some((provider.as_str(), model_id.as_str()))),
        };
        if version != 1
            || model.is_some_and(|(provider, model)| {
                provider.is_empty()
                    || provider.len() > 200
                    || provider.contains('/')
                    || model.is_empty()
                    || format!("{provider}/{model}").len() > 512
                    || provider.chars().chain(model.chars()).any(char::is_control)
            })
        {
            return Err("Pi 原生首次使用状态无效".into());
        }
        Ok(())
    }

    fn ready_source(&self) -> Option<PiModelSource> {
        match self {
            Self::Ready {
                provider, model_id, ..
            } => Some(PiModelSource::NativeObservation {
                runtime_provider_id: provider.clone(),
                runtime_model_id: format!("{provider}/{model_id}"),
                native_model_id: model_id.clone(),
            }),
            _ => None,
        }
    }
}

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiAcpStatus {
    native_admission_ready: bool,
    native_first_use: Option<PiNativeFirstUseState>,
    running: bool,
    pub(crate) generation: u64,
    runtime: Option<RuntimeIdentity>,
    runtime_build_id: Option<String>,
    runtime_connection_id: Option<String>,
    cwd: Option<PathBuf>,
    native_session: Option<PiNativeSession>,
    config_options: Value,
    managed_provider: Option<ManagedAcpProviderBinding>,
    model_source: Option<PiModelSource>,
    last_confirmed_model_source: Option<PiModelSource>,
    configuration_state: PiConfigurationState,
    last_error: Option<String>,
    dropped_events: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PiConfigurationState {
    Confirmed,
    Changing,
    Unknown,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PiAcpDialogResponseInput {
    farfold_session_id: FarfoldSessionId,
    native_session_id: NativeSessionId,
    runtime_generation: u64,
    request_id: String,
    native_request_id: String,
    answer: crate::pi_acp_interactions::PiAcpDialogAnswer,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PiAcpConfigId {
    Model,
    ThoughtLevel,
}

impl PiAcpConfigId {
    fn as_str(self) -> &'static str {
        match self {
            Self::Model => "model",
            Self::ThoughtLevel => "thought_level",
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PiAcpConfigInput {
    farfold_session_id: FarfoldSessionId,
    native_session_id: NativeSessionId,
    runtime_generation: u64,
    config_id: PiAcpConfigId,
    value: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PiAcpApplyProviderInput {
    farfold_session_id: FarfoldSessionId,
    native_session_id: NativeSessionId,
    runtime_generation: u64,
    provider: ManagedProviderSelection,
}

fn selected_config<'a>(options: &'a Value, id: &str) -> Option<&'a str> {
    options
        .as_array()?
        .iter()
        .find(|option| option["id"] == id && option["type"] == "select")?
        .get("currentValue")?
        .as_str()
}

fn response_native_first_use(value: &Value) -> Result<Option<PiNativeFirstUseState>, String> {
    let Some(raw) = value.pointer("/_meta/farfoldPi/nativeFirstUse") else {
        return Ok(None);
    };
    let state: PiNativeFirstUseState = serde_json::from_value(raw.clone())
        .map_err(|_| "Pi 原生首次使用状态格式无效".to_string())?;
    state.validate()?;
    Ok(Some(state))
}

fn observed_model_source(
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

fn set_config_option(
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

fn apply_provider(
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

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PiAcpInterventionKind {
    Steer,
    FollowUp,
}

impl PiAcpInterventionKind {
    pub(crate) fn delivery(self) -> &'static str {
        match self {
            Self::Steer => "steer",
            Self::FollowUp => "follow_up",
        }
    }

    fn method(self) -> &'static str {
        match self {
            Self::Steer => "_pi/steer",
            Self::FollowUp => "_pi/follow_up",
        }
    }
}

pub(crate) fn begin_intervention(
    runtime: &PiAcpRuntime,
    target: &SessionOpenTarget,
    generation: u64,
    kind: PiAcpInterventionKind,
    message: &str,
) -> Result<crate::acp_transport::AcpPendingResponse, AcpDispatchError> {
    let handle = runtime
        .connection()
        .map_err(|_| AcpDispatchError::NotSent("Pi ACP 未连接"))?;
    let connection = handle
        .lock()
        .map_err(|_| AcpDispatchError::NotSent("Pi ACP 连接不可用"))?;
    require_live_target(&connection, target)
        .map_err(|_| AcpDispatchError::NotSent("Pi 插话目标已失效"))?;
    if connection.generation != generation || connection.operations.is_pending() {
        return Err(AcpDispatchError::NotSent(
            "Pi 插话属于旧连接代次或切换中的会话",
        ));
    }
    connection.transport.begin_request_unbounded(
        kind.method(),
        json!({"sessionId":target.native_session_id,"message":message}),
    )
}

fn respond_dialog(
    controller: &crate::session_controller::HostSessionController,
    runtime: &PiAcpRuntime,
    store: &HostStore,
    router: &RuntimeEventRouter,
    interactions: &crate::interaction_registry::InteractionRegistry,
    input: PiAcpDialogResponseInput,
) -> Result<(), String> {
    controller.exclusive(|| {
        let target = store.session_open_target(&input.farfold_session_id)?;
        if target.native_session_id != input.native_session_id {
            return Err("Pi 对话回答不属于此原生会话".into());
        }
        let handle = runtime.connection()?;
        let mut connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
        require_live_target(&connection, &target)?;
        if connection.generation != input.runtime_generation || connection.operations.is_pending() {
            return Err("Pi 对话回答属于旧连接代次或切换中的会话".into());
        }
        connection.update_events(router)?;
        let dialog = interactions
            .pi_acp_dialog_by_native_id(
                &connection.binding,
                connection.generation,
                input.native_session_id.as_str(),
                &input.native_request_id,
            )?
            .filter(|dialog| dialog.request_key == input.request_id)
            .ok_or("Pi 原生对话已撤销、已回复或请求身份不匹配")?;
        let answer = dialog.answer(&input.answer)?;
        interactions.begin_response(
            connection.binding.clone(),
            connection.generation,
            &input.request_id,
            Some(input.native_session_id.as_str()),
        )?;
        let result = connection
            .transport
            .respond_client_request(&input.request_id, answer);
        interactions.finish_response(
            connection.binding.clone(),
            connection.generation,
            &input.request_id,
            !matches!(result, Err(AcpDispatchError::NotSent(_))),
        )?;
        result.map_err(|error| error.to_string())
    })
}

#[tauri::command]
pub async fn pi_acp_respond_dialog(
    app: AppHandle,
    input: PiAcpDialogResponseInput,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        respond_dialog(
            &app.state::<crate::session_controller::HostSessionController>(),
            &app.state::<PiAcpRuntime>(),
            &app.state::<HostStore>(),
            &app.state::<RuntimeEventRouter>(),
            &app.state::<crate::interaction_registry::InteractionRegistry>(),
            input,
        )
    })
    .await
    .map_err(|_| "Pi 原生对话回答被中断".to_string())?
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PiWorkspaceSection {
    AuthCatalog,
    Configuration,
    State,
    Messages,
    Entries,
    Models,
    ThinkingLevels,
    Commands,
    Stats,
    SessionCommand,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PiAcpWorkspaceInput {
    farfold_session_id: FarfoldSessionId,
    native_session_id: NativeSessionId,
    runtime_generation: u64,
    section: PiWorkspaceSection,
}

pub(crate) struct PiAcpHostSessionResult {
    pub farfold_session_id: FarfoldSessionId,
    pub installation_id: String,
    pub native_session_id: String,
    pub runtime_generation: u64,
    pub runtime_ready_at: i64,
    pub opened_at: i64,
    pub navigation: HostNavigationSnapshot,
}

pub(crate) fn is_acp_binding(binding: &RuntimeBinding) -> bool {
    binding.product_id.as_str() == PI_ACP_RUNTIME.product_id
        && binding.adapter_id.as_str() == PI_ACP_RUNTIME.adapter_id
}

pub(crate) fn is_current_managed_binding(binding: &RuntimeBinding) -> bool {
    is_acp_binding(binding)
        && binding.installation_id.as_str() == PI_ACP_RUNTIME.installation_id
        && binding.runtime_build_id.as_str() == PI_ACP_RUNTIME.runtime_build_id
}

fn managed_binding(selection: &ManagedProviderSelection) -> Result<RuntimeBinding, String> {
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

fn saved_provider(
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

fn new_owned_profile(
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

fn stable_profile_connection(
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

fn saved_owned_profile(
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

impl AcpEventConnection for PiAcpConnection {
    fn transport(&self) -> Arc<AcpTransport> {
        self.transport.clone()
    }

    fn record_event_error(&mut self, error: String) {
        self.last_error.get_or_insert(error);
    }

    fn update_events(&mut self, router: &RuntimeEventRouter) -> Result<(), String> {
        if let Some(error) = self.transport.failure() {
            self.last_error.get_or_insert(error);
        }
        let (events, dropped) = self.transport.drain_events()?;
        self.dropped_events = self.dropped_events.saturating_add(dropped);
        for event in events {
            if event.get("method").and_then(Value::as_str) == Some("session/update")
                && self.native.as_ref().is_some_and(|native| {
                    event.pointer("/params/sessionId").and_then(Value::as_str)
                        == Some(&native.session_id)
                })
                && event
                    .pointer("/params/update/sessionUpdate")
                    .and_then(Value::as_str)
                    == Some("config_option_update")
                && let Some(options) = event.pointer("/params/update/configOptions")
                && !self.operations.is_config_pending()
            {
                self.config_options = options.clone();
            }
            router.route_acp(
                self.binding.clone(),
                self.generation,
                &self.transport,
                event,
            )?;
        }
        Ok(())
    }
}

impl PiAcpRuntime {
    pub(crate) fn stop_for_recovery(
        &self,
        router: &RuntimeEventRouter,
        target: &SessionOpenTarget,
        generation: u64,
    ) -> Result<PiAcpStatus, String> {
        let _guard = self.start_lock.lock().map_err(|_| "Pi ACP 启停锁不可用")?;
        {
            let handle = self.connection()?;
            let connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
            require_connection_target(&connection, target)?;
            if connection.generation != generation {
                return Err("Pi ACP 恢复代次已失效".into());
            }
        }
        let stopped = self.stop_locked(Some(router));
        if !self.is_stopped()? {
            return Err(stopped
                .err()
                .unwrap_or_else(|| "Pi ACP 进程退出未确认".into()));
        }
        let mut status = current_status(self, router)?;
        status.last_error = stopped.err();
        Ok(status)
    }

    pub(crate) fn stop_idle_session(
        &self,
        router: &RuntimeEventRouter,
        target: &SessionOpenTarget,
        generation: u64,
    ) -> Result<PiAcpStatus, String> {
        let _guard = self.start_lock.lock().map_err(|_| "Pi ACP 启停锁不可用")?;
        let configuration_error = {
            let handle = self.connection()?;
            let connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
            require_connection_target(&connection, target)?;
            // The controller already requires no active Host turn. An explicit
            // disconnect may terminate a pending/unknown configuration operation.
            let configuring = connection.operations.is_config_pending();
            if connection.generation != generation
                || (!configuring
                    && (connection.operations.is_pending()
                        || connection.transport.has_unresolved_work()?))
            {
                return Err("Pi ACP 停止目标已失效或仍有未确认操作".into());
            }
            configuring.then(|| connection.last_error.clone()).flatten()
        };
        let stopped = self.stop_locked(Some(router));
        if !self.is_stopped()? {
            return Err(stopped
                .err()
                .unwrap_or_else(|| "Pi ACP 进程退出未确认".into()));
        }
        let mut status = current_status(self, router)?;
        status.last_error = match (configuration_error, stopped.err()) {
            (Some(configuration), Some(exit)) => Some(format!("{configuration}; {exit}")),
            (configuration, exit) => configuration.or(exit),
        };
        Ok(status)
    }

    pub(crate) fn is_stopped(&self) -> Result<bool, String> {
        Ok(matches!(
            *self.state.lock().map_err(|_| "Pi ACP 生命周期不可用")?,
            AcpLifecycle::Stopped
        ))
    }

    fn connection(&self) -> Result<Arc<Mutex<PiAcpConnection>>, String> {
        match &*self.state.lock().map_err(|_| "Pi ACP 生命周期不可用")? {
            AcpLifecycle::Stopped => Err("Pi ACP 未连接".into()),
            AcpLifecycle::Running(connection) => Ok(connection.clone()),
        }
    }

    /// Current connection generation, read authoritatively from the runtime so
    /// unified Host commands never trust a client-supplied generation.
    pub(crate) fn current_generation(&self) -> Result<u64, String> {
        Ok(self
            .connection()?
            .lock()
            .map_err(|_| "Pi ACP 连接不可用")?
            .generation)
    }

    // Keep identity and occupancy until exit is confirmed, including failed startup.
    pub(crate) fn stop_for_shutdown(&self) -> Result<(), String> {
        let _guard = self.start_lock.lock().map_err(|_| "Pi ACP 启停锁不可用")?;
        self.stop_locked(None)
    }

    fn stop_locked(&self, router: Option<&RuntimeEventRouter>) -> Result<(), String> {
        if self.is_stopped()? {
            return Ok(());
        }
        let handle = self.connection()?;
        let mut connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
        let stopped = connection.transport.stop();
        if stopped.is_err() && connection.transport.is_running()? {
            return stopped;
        }
        connection.event_pump_stop.store(true, Ordering::Release);
        let publication = if let Some(router) = router {
            let drained = connection.update_events(router);
            let terminated = router.route(
                connection.binding.clone(),
                json!({"generation":connection.generation,
                "kind":"lifecycle","payload":{"state":"terminated"}}),
            );
            drained.and(terminated.map(|_| ()))
        } else {
            Ok(())
        };
        *self.state.lock().map_err(|_| "Pi ACP 生命周期不可用")? = AcpLifecycle::Stopped;
        stopped
            .and(publication)
            .map_err(|error| format!("Pi ACP 进程已确认退出，但结果或终态发布仍需核对：{error}"))
    }
}

fn adapter_assets(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let resources = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let packaged = std::env::current_exe()
        .map_err(|error| error.to_string())?
        .ancestors()
        .any(|path| path.extension().is_some_and(|extension| extension == "app"));
    let node = resources.join("pi-capability-runtime/runtime/node");
    let adapter = resources.join("pi-acp-adapter/index.js");
    let (node, adapter) = if packaged || (node.is_file() && adapter.is_file()) {
        (node, adapter)
    } else {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        (
            manifest.join("capability-bridge/runtime/node"),
            manifest.join("pi-acp-adapter/dist/index.js"),
        )
    };
    if file_sha256(&node)? != NODE_SHA256 {
        return Err("Pi ACP Node 与固定发行摘要不符".into());
    }
    let expected: String = Sha256::digest(include_bytes!("../pi-acp-adapter/dist/index.js"))
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if file_sha256(&adapter)? != expected {
        return Err("Pi ACP 适配器与本应用构建不符".into());
    }
    Ok((node, adapter))
}

fn launch_command<Bootstrap>(
    node: &Path,
    adapter: &Path,
    pi: &Path,
    cwd: &Path,
    prepared: &PreparedAcpProfile<Bootstrap>,
    trust: Option<&str>,
) -> Result<Command, String> {
    if trust.is_some_and(|value| !matches!(value, "saved" | "approve" | "ignore")) {
        return Err("Unknown Pi project resource choice".into());
    }
    let home = prepared.profile_root.join("home");
    for path in [&home, &prepared.profile_root.join("tmp")] {
        protect_directory(path)?;
    }
    let mut command = Command::new(node);
    command
        .arg(adapter)
        .current_dir(cwd)
        .env_clear()
        .env("HOME", &home)
        .env(
            "PATH",
            launch_path(node, std::env::var_os("PATH").as_deref())?,
        )
        .env("TMPDIR", prepared.profile_root.join("tmp"))
        .env("XDG_CONFIG_HOME", home.join("config"))
        .env("XDG_DATA_HOME", home.join("data"))
        .env("XDG_CACHE_HOME", home.join("cache"))
        .env("XDG_STATE_HOME", home.join("state"))
        .env("PI_CODING_AGENT_DIR", &prepared.config_root)
        .env(
            "PI_CODING_AGENT_SESSION_DIR",
            prepared.profile_root.join("sessions"),
        )
        .env("PI_ACP_PI_COMMAND", pi)
        .env("FARFOLD_PI_PROJECT_TRUST", trust.unwrap_or("saved"))
        .envs(&prepared.environment);
    Ok(command)
}

fn launch_path(
    node: &Path,
    inherited: Option<&std::ffi::OsStr>,
) -> Result<std::ffi::OsString, String> {
    let mut paths = vec![
        node.parent()
            .ok_or("Pi ACP Node has no parent")?
            .to_path_buf(),
    ];
    for path in inherited.into_iter().flat_map(std::env::split_paths).chain(
        [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
        .map(PathBuf::from),
    ) {
        if path.is_absolute() && !paths.contains(&path) {
            paths.push(path);
        }
    }
    std::env::join_paths(paths).map_err(|error| error.to_string())
}

// This is ownership evidence for an empty managed Session only, never model-request verification.
fn managed_pre_file_anchor(
    binding: &RuntimeBinding,
    provider: &ManagedAcpProviderBinding,
    profile_root: &Path,
    cwd: &Path,
) -> Result<Value, String> {
    let model = provider
        .runtime_model_id
        .strip_prefix(&format!("{}/", provider.runtime_provider_id))
        .filter(|model| !model.is_empty())
        .ok_or("Pi 空会话 bootstrap 模型身份无效")?;
    let ownership = json!({
        "version":1, "product":binding.product_id, "installation":binding.installation_id,
        "build":binding.runtime_build_id, "adapter":binding.adapter_id,
        "connection":binding.connection_id, "profile":profile_root, "cwd":cwd,
        "bootstrap":provider
    });
    Ok(json!({"version":1,
        "binding":Sha256::digest(ownership.to_string().as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
        "provider":provider.runtime_provider_id,"modelId":model}))
}

fn start_connection(
    runtime: &PiAcpRuntime,
    router: &RuntimeEventRouter,
    binding: RuntimeBinding,
    cwd: &Path,
    prepared: &PreparedPiProfile,
    command: &mut Command,
) -> Result<Arc<Mutex<PiAcpConnection>>, String> {
    if !runtime.is_stopped()? {
        return Err("Pi ACP 已连接；请先断开当前会话".into());
    }
    // Explicit removal prevents an inherited environment variable granting a legacy/native profile this path.
    command.env_remove("FARFOLD_PI_MANAGED_PRE_FILE");
    let managed_pre_file = if prepared.integrity.is_some() {
        prepared
            .binding
            .as_ref()
            .map(|provider| {
                managed_pre_file_anchor(&binding, provider, &prepared.profile_root, cwd)
            })
            .transpose()?
    } else {
        None
    };
    if let Some(anchor) = &managed_pre_file {
        command.env("FARFOLD_PI_MANAGED_PRE_FILE", anchor.to_string());
    }
    let (transport, initialized) = crate::acp_runtime::initialize_transport_with_read_limit(
        command,
        cwd,
        json!({
            "fs":{"readTextFile":true,"writeTextFile":true},"terminal":true,
            "elicitation":{"form":{}},"_meta":{"farfoldPi":{"version":1}}
        }),
        ADAPTER_VERSION,
        REQUEST_TIMEOUT,
        crate::acp_transport::AcpReadLimit::NativeHistory,
    )?;
    let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let stop = Arc::new(AtomicBool::new(false));
    let handle = Arc::new(Mutex::new(PiAcpConnection {
        transport: transport.clone(),
        binding: binding.clone(),
        generation,
        cwd: cwd.into(),
        sessions_root: prepared.profile_root.join("sessions"),
        native: None,
        config_options: json!([]),
        managed_provider: prepared.binding.clone(),
        managed_versions: prepared.managed_versions.clone(),
        profile_integrity: prepared.integrity.clone(),
        managed_pre_file,
        initialized_at: crate::host_store::now_millis(),
        last_error: None,
        dropped_events: 0,
        operations: AcpSessionOperations::default(),
        auth_flow: None,
        confirmed_native_selection: None,
        native_first_use: None,
        settlement_gate: Arc::new(Mutex::new(())),
        event_pump_stop: stop.clone(),
    }));
    *runtime.state.lock().map_err(|_| "Pi ACP 生命周期不可用")? =
        AcpLifecycle::Running(handle.clone());
    let activate = (|| {
        if initialized
            .pointer("/agentCapabilities/_meta/farfoldPi/ui")
            .and_then(Value::as_bool)
            != Some(true)
            || initialized
                .pointer("/agentCapabilities/_meta/farfoldPi/promptModel")
                .and_then(Value::as_bool)
                != Some(true)
            || initialized
                .pointer("/agentCapabilities/loadSession")
                .and_then(Value::as_bool)
                != Some(true)
        {
            return Err("Pi ACP 必需交互、模型派发校验或续接能力未协商成功".into());
        }
        router.activate_connection(binding.clone(), generation)?;
        router.route(
            binding,
            json!({"generation":generation,"kind":"lifecycle","payload":{"state":"running"}}),
        )?;
        crate::acp_runtime::start_event_pump(handle.clone(), router.clone(), stop)
    })();
    if let Err(error) = activate {
        runtime
            .stop_locked(Some(router))
            .map_err(|stop| format!("{error}；清理未确认：{stop}"))?;
        return Err(error);
    }
    Ok(handle)
}

fn native_descriptor(
    response: &Value,
    requested: Option<&PiNativeSession>,
    cwd: &Path,
    root: &Path,
) -> Result<PiNativeSession, String> {
    let native: PiNativeSession = serde_json::from_value(
        response
            .pointer("/_meta/farfoldPi/nativeSession")
            .cloned()
            .ok_or("Pi ACP 缺少原生 Session 身份")?,
    )
    .map_err(|error| format!("Pi ACP Session 身份无效：{error}"))?;
    NativeSessionId::parse(&native.session_id).map_err(|error| error.to_string())?;
    if native.version != 1
        || native.cwd != cwd
        || !native.session_file.is_absolute()
        || native
            .session_file
            .extension()
            .is_none_or(|extension| extension != "jsonl")
        || response
            .get("sessionId")
            .and_then(Value::as_str)
            .is_some_and(|id| id != native.session_id)
        || (requested.is_none()
            && response.get("sessionId").and_then(Value::as_str) != Some(&native.session_id))
        || requested.is_some_and(|expected| expected != &native)
    {
        return Err("Pi ACP 返回了不同的原生会话或 Working Copy；不会替换绑定".into());
    }
    let parent = native
        .session_file
        .parent()
        .ok_or("Pi Session 路径缺少父目录")?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    if !parent.starts_with(&root) || native.session_file.is_symlink() {
        return Err("Pi Session 文件不在原 Provider profile 内".into());
    }
    if native.session_file.exists() {
        validate_native_file(&native)?;
    } else if requested.is_some() {
        return Err("Pi 原生 Session 文件尚未落盘或已丢失，不能冷恢复".into());
    }
    Ok(native)
}

fn validate_native_file(native: &PiNativeSession) -> Result<(), String> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&native.session_file)
        .map_err(|_| "Pi 原生 Session 文件不可读")?;
    if !file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("Pi Session 不是普通文件".into());
    }
    let mut head = String::new();
    BufReader::new(file.take(65537))
        .read_line(&mut head)
        .map_err(|error| error.to_string())?;
    if head.len() > 65536 {
        return Err("Pi Session 头超出限制".into());
    }
    let value: Value = serde_json::from_str(&head).map_err(|_| "Pi Session 头无效")?;
    if value.get("type").and_then(Value::as_str) != Some("session")
        || value.get("id").and_then(Value::as_str) != Some(&native.session_id)
        || value.get("cwd").and_then(Value::as_str).map(Path::new) != Some(native.cwd.as_path())
    {
        return Err("Pi Session 文件身份与原绑定不符".into());
    }
    Ok(())
}

fn register_observation(
    store: &HostStore,
    connection: &PiAcpConnection,
    title: &str,
) -> Result<FarfoldSessionId, String> {
    let native = connection
        .native
        .as_ref()
        .ok_or("Pi ACP 未绑定原生 Session")?;
    native_descriptor(
        &json!({"sessionId":native.session_id,"_meta":{"farfoldPi":{"nativeSession":native}}}),
        None,
        &connection.cwd,
        &connection.sessions_root,
    )?;
    let now = crate::host_store::now_millis();
    let binding = &connection.binding;
    store.register_runtime(&runtime_registration(binding, now))?;
    let input = NativeSessionRegistrationInput {
        native_session_id: &native.session_id,
        working_copy_path: &connection.cwd,
        title,
        created_at: now as u64,
        updated_at: now as u64,
    };
    if native.session_file.is_file() {
        validate_native_file(native)?;
        register_native_session_with_locator(
            store,
            binding.clone(),
            input,
            NativeSessionLocator {
                kind: NativeSessionLocatorKind::PiSessionFile,
                path: &native.session_file,
                allowed_root: &connection.sessions_root,
            },
        )
        .map(|(id, _)| id)
    } else {
        register_native_session(store, binding.clone(), input).map(|(id, _)| id)
    }
}

fn runtime_registration(binding: &RuntimeBinding, now: i64) -> RuntimeRegistration {
    RuntimeRegistration {
        runtime_product_id: binding.product_id.clone(),
        display_name: "Pi".into(),
        installation_id: binding.installation_id.clone(),
        runtime_build_id: binding.runtime_build_id.clone(),
        adapter_id: binding.adapter_id.clone(),
        distribution: RuntimeDistribution::Managed,
        observed_version: PI_ACP_RUNTIME.version.into(),
        artifact_sha256: PI_ACP_RUNTIME.binary_sha256.into(),
        connection_id: binding.connection_id.clone(),
        connection_label: "Pi ACP managed profile".into(),
        connection_kind: RuntimeConnectionKind::ManagedLocal,
        created_at: now,
        verified_at: now,
    }
}

#[cfg(test)]
fn open_native_session(
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

enum PiNativeSessionRequest {
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

fn open_native_session_request(
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

fn start_host_session(
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
    if !crate::pi_runtime::is_stopped(&app.state::<crate::pi_runtime::PiRuntime>())? {
        return Err("请先断开当前 Pi 原生连接".into());
    }
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

fn require_live_target(
    connection: &PiAcpConnection,
    target: &SessionOpenTarget,
) -> Result<(), String> {
    require_connection_target(connection, target)?;
    if !connection.transport.is_running()? || connection.transport.failure().is_some() {
        return Err("Pi ACP 原连接已断开；需先确认停止后续接".into());
    }
    Ok(())
}

pub(crate) fn verify_task_target(
    runtime: &PiAcpRuntime,
    target: &SessionOpenTarget,
    generation: u64,
) -> Result<(), String> {
    let handle = runtime.connection()?;
    let connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
    require_live_target(&connection, target)?;
    if connection.generation != generation || connection.operations.is_pending() {
        return Err("Pi ACP 任务目标的代次已失效或仍在切换会话".into());
    }
    Ok(())
}

pub(crate) fn verify_prompt_target(
    runtime: &PiAcpRuntime,
    target: &SessionOpenTarget,
    generation: u64,
) -> Result<PiModelSource, String> {
    let handle = runtime.connection()?;
    let connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
    verify_prompt_connection(&connection, target, generation)
}

pub(crate) fn capture_prompt_model(
    runtime: &PiAcpRuntime,
    store: &HostStore,
    router: &RuntimeEventRouter,
    target: &SessionOpenTarget,
    generation: u64,
) -> Result<PiPromptModelObservation, String> {
    verify_prompt_target(runtime, target, generation)?;
    // Admission reads must not queue behind a held history read or terminal settlement.
    let state = read_workspace_snapshot(
        runtime,
        store,
        router,
        PiAcpWorkspaceInput {
            farfold_session_id: target.farfold_session_id.clone(),
            native_session_id: target.native_session_id.clone(),
            runtime_generation: generation,
            section: PiWorkspaceSection::State,
        },
    )?;
    // This is receipt time of a real native read, not the later Host admission time.
    let observed_at = crate::host_store::now_millis() as u64;
    let handle = runtime.connection()?;
    let connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
    prompt_model_observation(&connection, target, generation, &state, observed_at)
}

fn prompt_model_observation(
    connection: &PiAcpConnection,
    target: &SessionOpenTarget,
    generation: u64,
    state: &Value,
    observed_at: u64,
) -> Result<PiPromptModelObservation, String> {
    let expected = verify_prompt_connection(connection, target, generation)?;
    let native = connection.native.as_ref().ok_or("Pi 原生会话身份缺失")?;
    let source = idle_model_source(state, native, &connection.managed_versions)?;
    if source != expected {
        return Err("Pi 实际当前模型与 Host 配置观察不一致；未接纳任务".into());
    }
    let observation = PiPromptModelObservation {
        source,
        binding: connection.binding.clone(),
        farfold_session_id: target.farfold_session_id.clone(),
        native: native.clone(),
        generation,
        observed_at,
    };
    observation.verify_target(target, generation)?;
    Ok(observation)
}

fn idle_model_source(
    state: &Value,
    native: &PiNativeSession,
    managed_versions: &[ManagedAcpProviderBinding],
) -> Result<PiModelSource, String> {
    verify_idle_native_session(state, native)?;
    let provider = state["model"]["provider"]
        .as_str()
        .ok_or("Pi 当前模型缺少原生 Provider 身份")?;
    let model = state["model"]["id"]
        .as_str()
        .ok_or("Pi 当前模型缺少原生模型身份")?;
    if provider.is_empty() || provider.contains('/') || model.is_empty() {
        return Err("Pi 当前模型身份无效".into());
    }
    observed_model_source(
        &json!([{"id":"model","type":"select","currentValue":format!("{provider}/{model}")}]),
        managed_versions,
    )
}

fn verify_idle_native_session(state: &Value, native: &PiNativeSession) -> Result<(), String> {
    if state["sessionId"].as_str() != Some(native.session_id.as_str())
        || state["sessionFile"].as_str() != native.session_file.to_str()
        || state["isStreaming"].as_bool() != Some(false)
        || state["isCompacting"].as_bool() != Some(false)
        || state["pendingMessageCount"].as_u64() != Some(0)
    {
        return Err("Pi 当前模型读取缺少原会话的完整空闲状态".into());
    }
    Ok(())
}

fn verify_prompt_connection(
    connection: &PiAcpConnection,
    target: &SessionOpenTarget,
    generation: u64,
) -> Result<PiModelSource, String> {
    require_live_target(connection, target)?;
    if connection.generation != generation || connection.operations.is_pending() {
        return Err("Pi ACP 任务目标的代次已失效或仍在切换会话".into());
    }
    let source = observed_model_source(&connection.config_options, &connection.managed_versions)?;
    if let Some(first_use) = &connection.native_first_use
        && first_use.ready_source().as_ref() != Some(&source)
    {
        return Err("Pi 原生首次使用尚未完成认证与明确模型选择；不能提交任务".into());
    }
    if source.managed_binding().is_none()
        && connection.confirmed_native_selection.as_ref() != Some(&source)
    {
        return Err("Pi 原生模型已有观察，但明确选择与实际模型尚未共同确认；不能提交任务".into());
    }
    if let Some(integrity) = &connection.profile_integrity {
        integrity.verify()?;
    }
    Ok(source)
}

pub(crate) fn verify_provider_receipt_target(
    runtime: &PiAcpRuntime,
    target: &SessionOpenTarget,
    generation: u64,
) -> Result<(), String> {
    verify_task_target(runtime, target, generation)?;
    let handle = runtime.connection()?;
    let connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
    if let Some(integrity) = &connection.profile_integrity {
        integrity.verify()?;
    }
    Ok(())
}

pub(crate) fn begin_prompt_text(
    runtime: &PiAcpRuntime,
    target: &SessionOpenTarget,
    generation: u64,
    text: &str,
    turn_id: &HostTurnId,
    observation: &PiPromptModelObservation,
) -> Result<crate::acp_transport::AcpPendingResponse, AcpDispatchError> {
    let handle = runtime
        .connection()
        .map_err(|_| AcpDispatchError::NotSent("Pi ACP 未连接"))?;
    let connection = handle
        .lock()
        .map_err(|_| AcpDispatchError::NotSent("Pi ACP 连接不可用"))?;
    let current = verify_prompt_connection(&connection, target, generation)
        .map_err(|_| AcpDispatchError::NotSent("Pi ACP 任务目标或 Provider 配置已失效"))?;
    observation
        .verify_target(target, generation)
        .map_err(|_| AcpDispatchError::NotSent("Pi 当前来源观察身份已失效"))?;
    if current != observation.source || connection.native.as_ref() != Some(&observation.native) {
        return Err(AcpDispatchError::NotSent(
            "Pi ACP Provider 不再是本轮接纳的版本与模型",
        ));
    }
    // Keep the connection lock through dispatch so config events cannot replace the admitted binding between validation and send.
    connection.transport.begin_request_unbounded(
        "session/prompt",
        json!({"sessionId":target.native_session_id,
        "prompt":[{"type":"text","text":text}],"_meta":{"farfoldPi":{"hostTurnId":turn_id,"expectedModel":observation.prompt_expectation()}}}),
    )
}

pub(crate) fn cancel_task(
    runtime: &PiAcpRuntime,
    target: &SessionOpenTarget,
    generation: u64,
    router: &RuntimeEventRouter,
) -> Result<crate::acp_transport::AcpPendingResponse, String> {
    let handle = runtime.connection()?;
    let mut connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
    require_live_target(&connection, target)?;
    if connection.generation != generation || connection.operations.is_pending() {
        return Err("Pi ACP 停止目标代次已失效或仍在切换会话".into());
    }
    connection.update_events(router)?;
    // The adapter atomically rejects cancellation of manual compaction. It owns
    // withdrawal of exact native forms after an accepted cancel; do not cancel
    // forms speculatively before that native capability decision.
    connection
        .transport
        .begin_request_unbounded("_pi/cancel", json!({"sessionId":target.native_session_id}))
        .map_err(|error| error.to_string())
}

pub(crate) fn verify_task_settled(
    runtime: &PiAcpRuntime,
    store: &HostStore,
    router: &RuntimeEventRouter,
    target: &SessionOpenTarget,
    generation: u64,
    interactions: &crate::interaction_registry::InteractionRegistry,
    finalize: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let gate = settlement_gate(runtime)?;
    let _read_guard = gate.lock().map_err(|_| "Pi 工作台读取锁不可用")?;
    let state = read_workspace_snapshot(
        runtime,
        store,
        router,
        PiAcpWorkspaceInput {
            farfold_session_id: target.farfold_session_id.clone(),
            native_session_id: target.native_session_id.clone(),
            runtime_generation: generation,
            section: PiWorkspaceSection::State,
        },
    )?;
    if state.get("isStreaming").and_then(Value::as_bool) != Some(false)
        || state.get("isCompacting").and_then(Value::as_bool) != Some(false)
        || state.get("pendingMessageCount").and_then(Value::as_u64) != Some(0)
    {
        return Err("Pi ACP 返回终态但原生状态仍未确认空闲；不自动重发".into());
    }
    verify_task_target(runtime, target, generation)?;
    if runtime
        .connection()?
        .lock()
        .map_err(|_| "Pi ACP 连接不可用")?
        .transport
        .has_unresolved_work()?
        || interactions.has_pending_for_session(
            &target.binding(),
            generation,
            target.native_session_id.as_str(),
        )?
    {
        return Err("Pi ACP 仍有未结清的请求或 Host 资源；结果未确认".into());
    }
    finalize()
}

fn require_connection_target(
    connection: &PiAcpConnection,
    target: &SessionOpenTarget,
) -> Result<(), String> {
    if connection.binding != target.binding()
        || connection.cwd != target.working_copy_path
        || connection
            .native
            .as_ref()
            .is_none_or(|native| native.session_id != target.native_session_id.as_str())
    {
        return Err("Pi ACP 当前连接与所选原生 Session 不一致；不会新建替代会话".into());
    }
    Ok(())
}

fn current_status(
    runtime: &PiAcpRuntime,
    router: &RuntimeEventRouter,
) -> Result<PiAcpStatus, String> {
    if runtime.is_stopped()? {
        return Ok(PiAcpStatus {
            running: false,
            generation: runtime.generation.load(Ordering::SeqCst),
            runtime: None,
            runtime_build_id: None,
            runtime_connection_id: None,
            cwd: None,
            native_session: None,
            config_options: json!([]),
            managed_provider: None,
            model_source: None,
            native_admission_ready: false,
            native_first_use: None,
            last_confirmed_model_source: None,
            configuration_state: PiConfigurationState::Unknown,
            last_error: None,
            dropped_events: 0,
        });
    }
    let handle = runtime.connection()?;
    let mut connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
    connection.update_events(router)?;
    let observed_model_source =
        observed_model_source(&connection.config_options, &connection.managed_versions).ok();
    let running = connection.transport.is_running()?;
    let pending_first_use = connection
        .native_first_use
        .as_ref()
        .is_some_and(|state| state.ready_source().is_none());
    let configuration_state = if !running || connection.transport.failure().is_some() {
        PiConfigurationState::Unknown
    } else if connection.operations.is_config_pending() {
        if connection.last_error.is_some() {
            PiConfigurationState::Unknown
        } else {
            PiConfigurationState::Changing
        }
    } else if pending_first_use || observed_model_source.is_some() {
        PiConfigurationState::Confirmed
    } else {
        PiConfigurationState::Unknown
    };
    let model_source = (configuration_state == PiConfigurationState::Confirmed
        && !pending_first_use)
        .then(|| observed_model_source.clone())
        .flatten();
    let last_confirmed_model_source = (!pending_first_use)
        .then(|| observed_model_source.clone())
        .flatten();
    Ok(PiAcpStatus {
        running,
        generation: connection.generation,
        runtime: Some(connection.binding.identity()),
        runtime_build_id: Some(connection.binding.runtime_build_id.to_string()),
        runtime_connection_id: Some(connection.binding.connection_id.to_string()),
        cwd: Some(connection.cwd.clone()),
        native_session: connection.native.clone(),
        config_options: connection.config_options.clone(),
        managed_provider: model_source
            .as_ref()
            .and_then(PiModelSource::managed_binding)
            .cloned(),
        model_source,
        native_admission_ready: configuration_state == PiConfigurationState::Confirmed
            && observed_model_source.as_ref().is_some_and(|source| {
                source.managed_binding().is_none()
                    && connection.confirmed_native_selection.as_ref() == Some(source)
                    && connection
                        .native_first_use
                        .as_ref()
                        .is_none_or(|state| state.ready_source().as_ref() == Some(source))
            }),
        native_first_use: connection.native_first_use.clone(),
        last_confirmed_model_source,
        configuration_state,
        last_error: connection.last_error.clone(),
        dropped_events: connection.dropped_events,
    })
}

#[tauri::command]
pub async fn pi_acp_status(
    runtime: State<'_, PiAcpRuntime>,
    router: State<'_, RuntimeEventRouter>,
) -> Result<PiAcpStatus, String> {
    let runtime = runtime.inner().clone();
    let router = router.inner().clone();
    tauri::async_runtime::spawn_blocking(move || current_status(&runtime, &router))
        .await
        .map_err(|_| "Pi ACP 状态读取被中断".to_string())?
}

pub(crate) fn settlement_gate(runtime: &PiAcpRuntime) -> Result<Arc<Mutex<()>>, String> {
    Ok(runtime
        .connection()?
        .lock()
        .map_err(|_| "Pi ACP 连接不可用")?
        .settlement_gate
        .clone())
}

fn read_workspace(
    runtime: &PiAcpRuntime,
    store: &HostStore,
    router: &RuntimeEventRouter,
    input: PiAcpWorkspaceInput,
) -> Result<Value, String> {
    let gate = settlement_gate(runtime)?;
    let _read_guard = gate.lock().map_err(|_| "Pi 工作台读取锁不可用")?;
    read_workspace_snapshot(runtime, store, router, input)
}

// The read gate also covers terminal verification, without holding the event-pump
// connection lock while awaiting RPC. Observations cannot masquerade as pending work.
fn read_workspace_snapshot(
    runtime: &PiAcpRuntime,
    store: &HostStore,
    router: &RuntimeEventRouter,
    input: PiAcpWorkspaceInput,
) -> Result<Value, String> {
    let target = store.session_open_target(&input.farfold_session_id)?;
    crate::session_controller::require_session_target(target.project_blockers())?;
    if target.native_session_id != input.native_session_id {
        return Err("Pi 工作台读取目标不匹配".into());
    }
    let transport = {
        let handle = runtime.connection()?;
        let connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
        require_live_target(&connection, &target)?;
        if connection.generation != input.runtime_generation {
            return Err("Pi 工作台读取代次已失效".into());
        }
        connection.transport.clone()
    };
    let response = transport
        .request_timeout(
            "_pi/workspace",
            json!({"sessionId":input.native_session_id,
        "section":input.section}),
            REQUEST_TIMEOUT,
        )
        .map_err(|error| error.to_string())?;
    let handle = runtime.connection()?;
    let mut connection = handle.lock().map_err(|_| "Pi ACP 连接不可用")?;
    require_live_target(&connection, &target)?;
    if connection.generation != input.runtime_generation
        || response.get("version").and_then(Value::as_u64) != Some(1)
        || response.get("section") != Some(&json!(input.section))
    {
        return Err("Pi 工作台读取响应属于其他代次或内容类型".into());
    }
    let native = native_descriptor(
        &json!({"sessionId":response["nativeSession"]["sessionId"],
        "_meta":{"farfoldPi":{"nativeSession":response["nativeSession"]}}}),
        None,
        &connection.cwd,
        &connection.sessions_root,
    )?;
    if connection.native.as_ref() != Some(&native) {
        return Err("Pi 工作台读取时原生身份发生变化".into());
    }
    let data = response
        .get("data")
        .cloned()
        .ok_or("Pi 工作台响应缺少原生数据")?;
    connection.update_events(router)?;
    register_observation(store, &connection, &target.title)?;
    Ok(data)
}

#[tauri::command]
pub async fn pi_acp_workspace(app: AppHandle, input: PiAcpWorkspaceInput) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_workspace(
            &app.state::<PiAcpRuntime>(),
            &app.state::<HostStore>(),
            &app.state::<RuntimeEventRouter>(),
            input,
        )
    })
    .await
    .map_err(|_| "Pi 工作台读取被中断".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_store::session_open::SessionOpenBlocker;

    struct Fixture {
        temp: tempfile::TempDir,
        cwd: PathBuf,
        store: HostStore,
        selection: ManagedProviderSelection,
        prepared: PreparedPiProfile,
        binding: RuntimeBinding,
    }

    impl Fixture {
        fn stable(endpoint: &str) -> Self {
            let mut fixture = Self::new(endpoint);
            let profile = new_owned_profile(fixture.selection.clone()).unwrap();
            let root = fixture.temp.path().canonicalize().unwrap();
            fixture.prepared = crate::acp_provider_profile::prepare_owned(
                &root,
                &root.join("pi-acp"),
                &fixture.store,
                &profile,
                true,
            )
            .unwrap();
            fixture
                .store
                .register_runtime_owned_profile(
                    &runtime_registration(&profile.binding, 1),
                    &profile,
                )
                .unwrap();
            fixture.binding = profile.binding;
            fixture
        }

        fn new(endpoint: &str) -> Self {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().canonicalize().unwrap();
            let cwd = root.join("project");
            fs::create_dir(&cwd).unwrap();
            let store = HostStore::open(root.join("host.sqlite3"));
            let selection = crate::acp_provider_profile::tests::save_fixture(
                &root,
                &store,
                endpoint,
                "openai-chat-completions",
                "fixture-not-a-credential",
            );
            let binding = managed_binding(&selection).unwrap();
            let prepared = crate::acp_provider_profile::prepare(
                &root,
                &root.join("pi-acp"),
                "fixture",
                &binding,
                &store,
                &selection,
                true,
            )
            .unwrap()
            .into_optional_bootstrap();
            Self {
                temp,
                cwd,
                store,
                selection,
                prepared,
                binding,
            }
        }

        fn native(&self) -> PiNativeSession {
            PiNativeSession {
                version: 1,
                session_id: "native-fixture".into(),
                cwd: self.cwd.clone(),
                session_file: self
                    .prepared
                    .profile_root
                    .join("sessions/native-fixture.jsonl"),
            }
        }

        fn response(&self) -> Value {
            json!({"sessionId":"native-fixture", "configOptions":[{"id":"model","type":"select",
                "currentValue":self.prepared.binding.clone().unwrap().runtime_model_id,
                "options":[{"value":self.prepared.binding.clone().unwrap().runtime_model_id,"name":"Fixture"}]},
                {"id":"thought_level","type":"select","currentValue":"off","options":[{"value":"off"},{"value":"high"}]}],
                "_meta":{"farfoldPi":{"nativeSession":self.native()}}})
        }

        fn start(
            &self,
            runtime: &PiAcpRuntime,
            router: &RuntimeEventRouter,
            response: Value,
        ) -> Arc<Mutex<PiAcpConnection>> {
            let mut command = Command::new("/usr/bin/python3");
            command.args(["-u", "-c", r#"
import json,sys,time
response=json.loads(sys.argv[1])
pending=None
cancel_waiting=False
form_cancelled=False
turn_count=0
prompt_calls=0
held_read=None
state_reads=0
held_intervention=None
interventions=[]
held_config=None
config_count=0
refresh_count=0
auth=None
auth_calls=0
manual_form_count=0
expected_answer={'action':'cancel'}
form_answer=None
for line in sys.stdin:
    request=json.loads(line)
    if request.get('method')=='fixture/auth_calls':
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':auth_calls}),flush=True)
        continue
    if request.get('method')=='_pi/auth':
        auth_calls+=1
        params=request['params']
        if params['action']=='start':
            auth={'version':1,'sessionId':params['sessionId'],'flowId':'flow-fixture','providerId':params['providerId'],'authType':params['authType'],'state':'running','credentialState':'unknown','refreshState':'not_attempted','prompt':{'id':'prompt-fixture','value':{'type':'secret','message':'Synthetic key'}},'notice':None}
            auth['operation']=params['operation']
        elif params['action']=='reply':
            assert params['value']=='synthetic-auth-secret'
            auth.update({'prompt':None,'state':'unknown' if response.get('authMode')=='unknown' else 'succeeded','credentialState':'committed','refreshState':'unknown' if response.get('authMode')=='unknown' else 'confirmed'})
        elif params['action']=='cancel':
            auth.update({'prompt':None,'state':'unknown','credentialState':'unknown'})
        result=json.loads(json.dumps(auth))
        if response.get('authMode')=='wrong': result['sessionId']='wrong-native'
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}),flush=True)
        continue
    if request.get('method')=='fixture/prompt_calls':
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':prompt_calls}),flush=True)
        continue
    if request.get('method')=='fixture/idle_crash':
        sys.exit(1)
    if request.get('method')=='fixture/show_form':
        manual_form_count+=1
        form=json.loads(json.dumps(response['form']))
        form['id']=100+manual_form_count
        form['params']['_meta']['farfoldPi']['event']['id']=f'manual-dialog-{manual_form_count}'
        expected_answer=request['params'].get('expectedAnswer',{'action':'cancel'})
        print(json.dumps(form),flush=True)
    if request.get('method')=='fixture/withdraw_form':
        print(json.dumps({'jsonrpc':'2.0','method':'_pi/ui_withdrawn','params':{'version':1,'sessionId':response['sessionId'],'nativeRequestId':f'manual-dialog-{manual_form_count}','reason':'timeout'}}),flush=True)
    if request.get('method')=='fixture/last_form_answer':
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':form_answer}),flush=True)
        continue
    if request.get('method')=='fixture/read_pending':
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':{'pending':held_read is not None}}),flush=True)
        continue
    if request.get('method')=='fixture/intervention_status':
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':{'held':held_intervention is not None,'interventions':interventions,'prompts':turn_count}}),flush=True)
        continue
    if request.get('method')=='fixture/config_status':
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':{'held':held_config is not None,'configs':config_count,'prompts':turn_count,'refreshes':refresh_count}}),flush=True)
        continue
    if request.get('method')=='_pi/refresh_profile':
        refresh_count+=1
        native=json.loads(json.dumps(response['_meta']['farfoldPi']['nativeSession']))
        if response.get('refreshMode')=='wrong': native['sessionId']='wrong-session'
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':{'version':1,'nativeSession':native}}),flush=True)
        continue
    if request.get('method')=='session/set_config_option':
        config_count+=1
        options=json.loads(json.dumps(response['configOptions']))
        for option in options:
            if option['id']==request['params']['configId']:
                option['currentValue']='malformed' if response.get('configMode')=='malformed' else request['params']['value']
        result={'configOptions':options}
        if response.get('nativeFirstUse'):
            provider,_,model=options[0]['currentValue'].partition('/')
            result['_meta']={'farfoldPi':{'nativeFirstUse':{'version':1,'phase':'ready','provider':provider,'modelId':model}}}
        held_config={'id':request['id'],'result':result}
        if response.get('configMode')=='reject':
            held_config={'id':request['id'],'error':{'code':-32602,'message':'native rejected'}}
        else: response['configOptions']=options
        if response.get('emitConfigUpdate'):
            print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':response['sessionId'],'update':{'sessionUpdate':'config_option_update','configOptions':options}}}),flush=True)
        if response.get('autoConfig'):
            print(json.dumps({'jsonrpc':'2.0',**held_config}),flush=True)
            held_config=None
        continue
    if request.get('method')=='fixture/release_config':
        assert held_config is not None
        print(json.dumps({'jsonrpc':'2.0',**held_config}),flush=True)
        held_config=None
    if request.get('method') in ('_pi/steer','_pi/follow_up'):
        assert pending is not None
        interventions.append(request['method'])
        result={'accepted':True,'sessionId':response['sessionId'],'delivery':request['method'][4:]}
        if response.get('holdIntervention'):
            held_intervention={'id':request['id'],'result':result}
            continue
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}),flush=True)
        continue
    if request.get('method')=='fixture/release_intervention':
        assert held_intervention is not None
        if request['params'].get('malformed'): held_intervention['result']['sessionId']='wrong'
        print(json.dumps({'jsonrpc':'2.0',**held_intervention}),flush=True)
        held_intervention=None
    if request.get('method')=='fixture/finish_prompt':
        assert pending is not None
        print(json.dumps({'jsonrpc':'2.0','id':pending['id'],'result':{'stopReason':'end_turn'}}),flush=True)
        pending=None
    if request.get('method')=='fixture/release_read':
        assert held_read is not None
        print(json.dumps({'jsonrpc':'2.0','id':held_read['id'],'result':held_read['result']}),flush=True)
        held_read=None
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':{'ok':True}}),flush=True)
        continue
    if isinstance(request.get('id'),int) and 'method' not in request:
        assert request['result']==expected_answer
        form_answer=request['result']
        form_cancelled=True
        if cancel_waiting and pending:
            print(json.dumps({'jsonrpc':'2.0','id':pending['id'],'result':{'stopReason':'cancelled'}}),flush=True)
            pending=None
            cancel_waiting=False
        continue
    if request.get('method')=='session/prompt':
        prompt_calls+=1
        receipt=None
        if response.get('promptMode') in ('preflight_not_sent','preflight_unknown'):
            provider,model=response['configOptions'][0]['currentValue'].split('/',1)
            assert request['params']['_meta']['farfoldPi']['expectedModel']=={'version':1,'sessionId':response['sessionId'],'sessionFile':response['_meta']['farfoldPi']['nativeSession']['sessionFile'],'provider':provider,'modelId':model}
            code=-32600 if response['promptMode']=='preflight_not_sent' else -32603
            print(json.dumps({'jsonrpc':'2.0','id':request['id'],'error':{'code':code,'message':'fixture preflight','data':{'farfoldPiPromptNotSent':True}}}),flush=True)
            continue
        if response.get('emitReceipt'):
            provider,model=response['configOptions'][0]['currentValue'].split('/',1)
            now=int(time.time()*1000)
            receipt={'version':1,'hostTurnId':request['params']['_meta']['farfoldPi']['hostTurnId'],'sessionId':response['sessionId'],'runtimeProviderId':provider,'runtimeModelId':f'{provider}/{model}','nativeModelId':model,'nativeTimestamp':now,'completedAt':now,'nativeStopReason':'error' if response.get('promptMode')=='error' else 'stop'}
        if response.get('promptMode')=='exit': sys.exit(7)
        if response.get('promptMode')=='wait':
            pending=request
            turn_count+=1
            if 'form' in response:
                form_cancelled=False
                form=json.loads(json.dumps(response['form']))
                form['id']=6+turn_count
                form['params']['_meta']['farfoldPi']['event']['id']=f'native-dialog-{turn_count}'
                print(json.dumps(form),flush=True)
            continue
        if response.get('promptMode')=='error':
            data={'farfoldOutcomeUnknown':False,'nativeStopReason':'error'}
            if receipt: data['farfoldPiProviderRequest']=receipt
            print(json.dumps({'jsonrpc':'2.0','id':request['id'],'error':{'code':-32603,'message':'fixture error','data':data}}),flush=True)
            continue
    if request.get('method')=='_pi/cancel':
        outcome='unsupported' if response.get('cancelUnsupported') else 'accepted'
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':{'version':1,'sessionId':response['sessionId'],'outcome':outcome}}),flush=True)
        if outcome=='accepted' and pending:
            if 'form' in response:
                cancel_waiting=True
                print(json.dumps({'jsonrpc':'2.0','method':'_pi/ui_withdrawn','params':{'version':1,'sessionId':response['sessionId'],'nativeRequestId':form['params']['_meta']['farfoldPi']['event']['id'],'reason':'cancelled'}}),flush=True)
            else:
                print(json.dumps({'jsonrpc':'2.0','id':pending['id'],'result':{'stopReason':'cancelled'}}),flush=True)
                pending=None
        continue
    if request.get('method')=='fixture/malformed':
        print(json.dumps({'jsonrpc':'2.0','method':'_pi/ui_withdrawn','params':{}}),flush=True)
    if request.get('method')=='initialize':
        result={'protocolVersion':1,'agentInfo':{'version':'0.0.33-farfold.1'},'agentCapabilities':{'loadSession':True,'_meta':{'farfoldPi':{'ui':True,'promptModel':True}}}}
    elif request.get('method')=='_pi/workspace':
        data={'entries':[{'type':'future','id':'entry'}]}
        if request['params']['section']=='configuration': data=response['configOptions']
        if request['params']['section']=='state':
            state_reads+=1
            provider,_,model=response['configOptions'][0]['currentValue'].partition('/')
            data={'sessionId':response['sessionId'],'sessionFile':response['_meta']['farfoldPi']['nativeSession']['sessionFile'],'model':{'provider':provider,'id':model},'isStreaming':False,'isCompacting':False,'pendingMessageCount':0}
            data.update(response.get('stateOverride',{}))
        result={'version':1,'nativeSession':response['_meta']['farfoldPi']['nativeSession'],'section':request['params']['section'],'data':data}
        if response.get('holdEntries') and request['params']['section']=='entries':
            held_read={'id':request['id'],'result':result}
            continue
        if response.get('holdFirstState') and request['params']['section']=='state' and state_reads==1:
            held_read={'id':request['id'],'result':result}
            continue
    elif request.get('method')=='session/prompt':
        result=response.get('promptResult',{'stopReason':'end_turn'})
        if receipt: result['_meta']={'farfoldPiProviderRequest':receipt}
    else: result=response
    if 'id' in request: print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}),flush=True)
"#]).arg(response.to_string());
            start_connection(
                runtime,
                router,
                self.binding.clone(),
                &self.cwd,
                &self.prepared,
                &mut command,
            )
            .unwrap()
        }
    }

    #[test]
    fn native_auth_is_ephemeral_targeted_and_never_managed_request_verification() {
        for mode in ["success", "unknown", "wrong"] {
            let fixture = Fixture::stable("http://127.0.0.1:1/v1");
            let runtime = PiAcpRuntime::default();
            let router = RuntimeEventRouter::default();
            let controller = crate::session_controller::HostSessionController::default();
            let turns = crate::turn_coordinator::TurnCoordinator::default();
            let mut response = fixture.response();
            response["authMode"] = json!(mode);
            let handle = fixture.start(&runtime, &router, response);
            let opened =
                open_native_session(&handle, &router, &fixture.store, None, "Native auth").unwrap();
            let original = serde_json::to_value(
                fixture
                    .store
                    .provider_projection_snapshot(&fixture.selection.provider_connection_id)
                    .unwrap(),
            )
            .unwrap();
            let call = |command: Value, generation: u64| {
                native_auth::authenticate(&controller, &runtime, &fixture.store, &router, &turns,
                    serde_json::from_value(json!({"farfoldSessionId":opened.farfold_session_id,
                        "nativeSessionId":opened.native_session_id,"runtimeGeneration":generation,"command":command})).unwrap())
            };
            let start = || json!({"action":"start","providerId":"anthropic","authType":"api_key"});
            assert!(call(start(), opened.runtime_generation + 1).is_err());
            assert!(call(json!({"action":"start","providerId":"farfold-managed-shadow","authType":"api_key"}), opened.runtime_generation).is_err());
            let first = call(start(), opened.runtime_generation);
            if mode == "wrong" {
                assert!(first.is_err());
            } else {
                let first = serde_json::to_value(first.unwrap()).unwrap();
                assert_eq!(first["flowId"], "flow-fixture");
                assert_eq!(first["state"], "running");
                assert!(handle.lock().unwrap().operations.is_config_pending());
                assert!(
                    current_status(&runtime, &router)
                        .unwrap()
                        .model_source
                        .is_none()
                );
                assert!(call(start(), opened.runtime_generation).is_err());
                assert!(call(json!({"action":"reply","flowId":"other-flow","promptId":"prompt-fixture","value":"synthetic-auth-secret"}), opened.runtime_generation).is_err());
                let last = serde_json::to_value(call(json!({"action":"reply","flowId":"flow-fixture","promptId":"prompt-fixture","value":"synthetic-auth-secret"}), opened.runtime_generation).unwrap()).unwrap();
                assert_eq!(last["credentialState"], "committed");
                assert!(!last.to_string().contains("synthetic-auth-secret"));
                assert_eq!(
                    handle.lock().unwrap().operations.is_config_pending(),
                    mode == "unknown"
                );
                assert_eq!(
                    current_status(&runtime, &router)
                        .unwrap()
                        .model_source
                        .is_some(),
                    mode == "success"
                );
            }
            let target = fixture
                .store
                .session_open_target(&opened.farfold_session_id)
                .unwrap();
            assert_eq!(
                verify_prompt_connection(
                    &handle.lock().unwrap(),
                    &target,
                    opened.runtime_generation
                )
                .is_ok(),
                mode == "success"
            );
            assert_eq!(
                serde_json::to_value(
                    fixture
                        .store
                        .provider_projection_snapshot(&fixture.selection.provider_connection_id)
                        .unwrap()
                )
                .unwrap(),
                original
            );
            let transport = handle.lock().unwrap().transport.clone();
            assert_eq!(
                transport.request("fixture/auth_calls", json!({})).unwrap(),
                json!(if mode == "wrong" { 1 } else { 2 })
            );
            assert_eq!(
                transport
                    .request("fixture/prompt_calls", json!({}))
                    .unwrap(),
                json!(0)
            );
            assert!(transport.drain_events().unwrap().0.is_empty());
            runtime.stop_for_shutdown().unwrap();
        }
    }

    #[test]
    fn native_first_use_auth_selection_and_cold_pending_restore_stay_on_the_original_session() {
        use crate::turn_coordinator::{
            HostNativeTurnSubmission, HostPiAcpTurnSubmitInput, TurnCoordinator,
            host_pi_acp_turn_submit_blocking,
        };
        let fixture = Fixture::stable("http://127.0.0.1:1/v1");
        let runtime = PiAcpRuntime::default();
        let router = RuntimeEventRouter::default();
        let controller = crate::session_controller::HostSessionController::default();
        let turns = TurnCoordinator::default();
        turns.attach_host_store(fixture.store.clone()).unwrap();
        let mut response = fixture.response();
        response["configOptions"][0]["currentValue"] = json!("native/model");
        response["configOptions"][0]["options"] = json!([{"value":"native/model","name":"Native"}]);
        response["_meta"]["farfoldPi"]["nativeFirstUse"] =
            json!({"version":1,"phase":"authentication_required"});
        response["nativeFirstUse"] = json!(true);
        response["autoConfig"] = json!(true);
        let handle = fixture.start(&runtime, &router, response.clone());
        {
            let mut connection = handle.lock().unwrap();
            connection.managed_provider = None;
            connection.managed_versions.clear();
        }
        let opened =
            open_native_session(&handle, &router, &fixture.store, None, "Native first use")
                .unwrap();
        let target = fixture
            .store
            .session_open_target(&opened.farfold_session_id)
            .unwrap();
        let pending = current_status(&runtime, &router).unwrap();
        assert_eq!(pending.configuration_state, PiConfigurationState::Confirmed);
        assert!(pending.model_source.is_none());
        assert!(!pending.native_admission_ready);
        assert!(
            verify_prompt_connection(&handle.lock().unwrap(), &target, opened.runtime_generation)
                .is_err()
        );

        let call = |command: Value| {
            native_auth::authenticate(
                &controller,
                &runtime,
                &fixture.store,
                &router,
                &turns,
                serde_json::from_value(json!({
                    "farfoldSessionId":opened.farfold_session_id,
                    "nativeSessionId":opened.native_session_id,
                    "runtimeGeneration":opened.runtime_generation,
                    "command":command
                }))
                .unwrap(),
            )
        };
        let started = serde_json::to_value(
            call(json!({"action":"start","providerId":"anthropic","authType":"api_key"})).unwrap(),
        )
        .unwrap();
        assert_eq!(started["state"], "running");
        let logged_in = serde_json::to_value(
            call(json!({"action":"reply","flowId":"flow-fixture","promptId":"prompt-fixture","value":"synthetic-auth-secret"})).unwrap(),
        )
        .unwrap();
        assert_eq!(logged_in["state"], "succeeded");
        assert!(matches!(
            handle.lock().unwrap().native_first_use,
            Some(PiNativeFirstUseState::ModelSelectionRequired { .. })
        ));
        assert!(
            verify_prompt_connection(&handle.lock().unwrap(), &target, opened.runtime_generation)
                .is_err()
        );

        let selected = set_config_option(
            &controller,
            &runtime,
            &fixture.store,
            &router,
            &turns,
            PiAcpConfigInput {
                farfold_session_id: opened.farfold_session_id.clone(),
                native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
                runtime_generation: opened.runtime_generation,
                config_id: PiAcpConfigId::Model,
                value: "native/model".into(),
            },
        )
        .unwrap();
        assert!(selected.native_admission_ready);
        assert!(matches!(
            selected.native_first_use,
            Some(PiNativeFirstUseState::Ready { .. })
        ));
        assert!(
            verify_prompt_connection(&handle.lock().unwrap(), &target, opened.runtime_generation)
                .is_ok()
        );
        assert!(matches!(
            host_pi_acp_turn_submit_blocking(
                &controller,
                &fixture.store,
                &runtime,
                &router,
                &turns,
                &crate::interaction_registry::InteractionRegistry::default(),
                HostPiAcpTurnSubmitInput {
                    farfold_session_id: opened.farfold_session_id.clone(),
                    native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
                    runtime_generation: opened.runtime_generation,
                    text: "native first-use task".into(),
                },
            )
            .unwrap(),
            HostNativeTurnSubmission::Accepted { .. }
        ));

        assert!(target.locator_value.is_none());
        runtime.stop_for_shutdown().unwrap();
        response["_meta"]["farfoldPi"]["nativeFirstUse"] =
            json!({"version":1,"phase":"model_selection_required"});
        let restored_handle = fixture.start(&runtime, &router, response);
        {
            let mut connection = restored_handle.lock().unwrap();
            connection.managed_provider = None;
            connection.managed_versions.clear();
        }
        let restored = open_native_session_request(
            &restored_handle,
            &router,
            &fixture.store,
            Some(PiNativeSessionRequest::Identity(
                target.native_session_id.clone(),
            )),
            "Native first use",
        )
        .unwrap();
        assert_eq!(restored.farfold_session_id, opened.farfold_session_id);
        let cold = current_status(&runtime, &router).unwrap();
        assert!(matches!(
            cold.native_first_use,
            Some(PiNativeFirstUseState::ModelSelectionRequired { .. })
        ));
        assert!(!cold.native_admission_ready);
        runtime.stop_for_shutdown().unwrap();
    }

    #[test]
    fn native_descriptor_rejects_identity_path_header_and_missing_restore_without_writing() {
        let fixture = Fixture::new("http://127.0.0.1:1/v1");
        let native = fixture.native();
        let root = fixture.prepared.profile_root.join("sessions");
        let response = fixture.response();
        assert_eq!(
            native_descriptor(&response, None, &fixture.cwd, &root).unwrap(),
            native
        );
        assert!(native_descriptor(&response, Some(&native), &fixture.cwd, &root).is_err());
        assert!(!native.session_file.exists());
        for pointer in [
            "/sessionId",
            "/_meta/farfoldPi/nativeSession/sessionId",
            "/_meta/farfoldPi/nativeSession/cwd",
        ] {
            let mut bad = response.clone();
            *bad.pointer_mut(pointer).unwrap() = json!("different");
            assert!(native_descriptor(&bad, Some(&native), &fixture.cwd, &root).is_err());
        }
        fs::write(
            &native.session_file,
            json!({"type":"session","id":"wrong","cwd":fixture.cwd}).to_string(),
        )
        .unwrap();
        assert!(native_descriptor(&response, None, &fixture.cwd, &root).is_err());
        let original = fs::read(&native.session_file).unwrap();
        assert!(native_descriptor(&response, Some(&native), &fixture.cwd, &root).is_err());
        assert_eq!(fs::read(&native.session_file).unwrap(), original);
        fs::remove_file(&native.session_file).unwrap();
        let outside = fixture.temp.path().join("outside.jsonl");
        fs::write(&outside, "{}\n").unwrap();
        std::os::unix::fs::symlink(&outside, &native.session_file).unwrap();
        assert!(native_descriptor(&response, None, &fixture.cwd, &root).is_err());
    }

    #[test]
    fn confirmed_exit_releases_lifecycle_even_if_pending_event_publication_fails() {
        let fixture = Fixture::new("http://127.0.0.1:1/v1");
        let runtime = PiAcpRuntime::default();
        let router = RuntimeEventRouter::default();
        let handle = fixture.start(&runtime, &router, fixture.response());
        let transport = {
            let connection = handle.lock().unwrap();
            connection.event_pump_stop.store(true, Ordering::Release);
            connection.transport.clone()
        };
        transport.request("fixture/malformed", json!({})).unwrap();
        let result = runtime.stop_locked(Some(&router));
        assert!(result.unwrap_err().contains("进程已确认退出"));
        assert!(runtime.is_stopped().unwrap());
        assert!(!transport.is_running().unwrap());
        runtime.stop_locked(Some(&router)).unwrap();
        fixture.start(&runtime, &router, fixture.response());
        runtime.stop_for_shutdown().unwrap();
    }

    #[test]
    fn isolated_launch_keeps_tool_paths_without_inheriting_other_environment() {
        let fixture = Fixture::new("http://127.0.0.1:1/v1");
        let paths = launch_path(
            Path::new("/owned/node/bin/node"),
            Some(std::ffi::OsStr::new("/custom/bin::relative:/usr/bin")),
        )
        .unwrap();
        let paths: Vec<_> = std::env::split_paths(&paths).collect();
        assert_eq!(paths[0], Path::new("/owned/node/bin"));
        assert!(paths.contains(&PathBuf::from("/custom/bin")));
        assert!(paths.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(paths.iter().all(|path| path.is_absolute()));
        let command = launch_command(
            Path::new("/owned/node"),
            Path::new("/owned/adapter.js"),
            Path::new("/owned/pi"),
            &fixture.cwd,
            &fixture.prepared,
            Some("ignore"),
        )
        .unwrap();
        let environment: std::collections::BTreeMap<_, _> = command.get_envs().collect();
        assert_eq!(
            environment
                .get(std::ffi::OsStr::new("FARFOLD_PI_PROJECT_TRUST"))
                .copied()
                .flatten(),
            Some(std::ffi::OsStr::new("ignore"))
        );
        assert!(!environment.contains_key(std::ffi::OsStr::new("OPENAI_API_KEY")));
        assert!(
            launch_command(
                Path::new("/owned/node"),
                Path::new("/owned/adapter.js"),
                Path::new("/owned/pi"),
                &fixture.cwd,
                &fixture.prepared,
                Some("invalid")
            )
            .is_err()
        );
    }

    #[test]
    fn workspace_reads_are_scoped_and_refresh_only_the_same_persisted_native_locator() {
        let fixture = Fixture::new("http://127.0.0.1:1/v1");
        let runtime = PiAcpRuntime::default();
        let router = RuntimeEventRouter::default();
        let handle = fixture.start(&runtime, &router, fixture.response());
        let opened =
            open_native_session(&handle, &router, &fixture.store, None, "Pi fixture").unwrap();
        let input = || PiAcpWorkspaceInput {
            farfold_session_id: opened.farfold_session_id.clone(),
            native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
            runtime_generation: opened.runtime_generation,
            section: PiWorkspaceSection::Entries,
        };
        let mut stale = input();
        stale.runtime_generation += 1;
        assert!(read_workspace(&runtime, &fixture.store, &router, stale).is_err());
        let first = read_workspace(&runtime, &fixture.store, &router, input()).unwrap();
        assert_eq!(first["entries"][0]["type"], "future");
        assert!(
            fixture
                .store
                .session_open_target(&opened.farfold_session_id)
                .unwrap()
                .locator_value
                .is_none()
        );
        let native = fixture.native();
        fs::write(
            &native.session_file,
            format!(
                "{}\n",
                json!({"type":"session","id":native.session_id,"cwd":native.cwd})
            ),
        )
        .unwrap();
        read_workspace(&runtime, &fixture.store, &router, input()).unwrap();
        assert_eq!(
            fixture
                .store
                .session_open_target(&opened.farfold_session_id)
                .unwrap()
                .pi_session_file(),
            Some(native.session_file.as_path())
        );
        assert!(serde_json::from_value::<PiAcpWorkspaceInput>(json!({"farfoldSessionId":opened.farfold_session_id,
            "nativeSessionId":opened.native_session_id,"runtimeGeneration":opened.runtime_generation,"section":"prompt"})).is_err());
        runtime.stop_for_shutdown().unwrap();
    }

    #[test]
    fn host_pi_acp_tasks_bind_current_connection_and_keep_terminal_and_provider_evidence_separate()
    {
        use crate::turn_coordinator::{
            HostNativeTurnSubmission, HostPiAcpTurnSubmitInput, TurnCoordinator,
            host_pi_acp_turn_submit_blocking,
        };
        for (mode, emit_receipt, newer_config) in [
            ("success", false, false),
            ("cancelled", false, false),
            ("error", false, false),
            ("success", true, false),
            ("error", true, false),
            ("success", true, true),
        ] {
            let fixture = Fixture::new("http://127.0.0.1:1/v1");
            let runtime = PiAcpRuntime::default();
            let coordinator = TurnCoordinator::default();
            coordinator
                .attach_host_store(fixture.store.clone())
                .unwrap();
            let router = RuntimeEventRouter::with_capacity_and_all_observers(
                128,
                None,
                None,
                Some(coordinator.clone()),
            );
            let controller = crate::session_controller::HostSessionController::default();
            let mut response = fixture.response();
            response["promptMode"] = json!(mode);
            response["emitReceipt"] = json!(emit_receipt);
            if mode == "cancelled" {
                response["promptResult"] = json!({"stopReason":"cancelled"});
            }
            let handle = fixture.start(&runtime, &router, response);
            let opened =
                open_native_session(&handle, &router, &fixture.store, None, "Pi task fixture")
                    .unwrap();
            if newer_config {
                let newer = crate::acp_provider_profile::tests::save_fixture(
                    fixture.temp.path(),
                    &fixture.store,
                    "http://127.0.0.1:1/v1",
                    "openai-chat-completions",
                    "changed-fixture-key",
                );
                assert_eq!(
                    newer.provider_connection_id,
                    fixture.selection.provider_connection_id
                );
                assert_ne!(
                    newer.provider_config_version_id,
                    fixture.selection.provider_config_version_id
                );
            }
            let input = || HostPiAcpTurnSubmitInput {
                farfold_session_id: opened.farfold_session_id.clone(),
                native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
                runtime_generation: opened.runtime_generation,
                text: "fixture task".into(),
            };
            let mut stale = input();
            stale.runtime_generation += 1;
            assert!(
                host_pi_acp_turn_submit_blocking(
                    &controller,
                    &fixture.store,
                    &runtime,
                    &router,
                    &coordinator,
                    &crate::interaction_registry::InteractionRegistry::default(),
                    stale
                )
                .is_err()
            );
            assert!(
                !coordinator
                    .has_active_session(&opened.farfold_session_id)
                    .unwrap()
            );
            let result = host_pi_acp_turn_submit_blocking(
                &controller,
                &fixture.store,
                &runtime,
                &router,
                &coordinator,
                &crate::interaction_registry::InteractionRegistry::default(),
                input(),
            )
            .unwrap();
            match (mode, result) {
                ("success", HostNativeTurnSubmission::Accepted { submission }) => {
                    let bound = fixture
                        .store
                        .test_turn_provider_binding(&submission.turn_id)
                        .unwrap()
                        .unwrap();
                    assert_eq!(bound.0, fixture.selection.provider_config_version_id);
                    assert_eq!(bound.2, fixture.binding.connection_id);
                }
                ("cancelled", HostNativeTurnSubmission::Cancelled { .. })
                | ("error", HostNativeTurnSubmission::Failed { .. }) => {}
                (_, unexpected) => panic!("wrong terminal outcome: {unexpected:?}"),
            }
            assert!(
                !coordinator
                    .has_active_session(&opened.farfold_session_id)
                    .unwrap()
            );
            assert_eq!(
                fixture
                    .store
                    .provider_projection_snapshot(&fixture.selection.provider_connection_id)
                    .unwrap()
                    .projections[0]
                    .request_state,
                if emit_receipt && !newer_config {
                    if mode == "error" {
                        ProviderRequestState::VerifiedFailure
                    } else {
                        ProviderRequestState::VerifiedSuccess
                    }
                } else {
                    ProviderRequestState::NotRequested
                }
            );
            runtime.stop_for_shutdown().unwrap();
        }
    }

    #[test]
    fn disconnected_pi_task_keeps_occupancy_until_exact_explicit_recovery_without_resend() {
        use crate::turn_coordinator::{
            HostNativeTurnSubmission, HostPiAcpTurnSubmitInput, TurnCoordinator,
            host_pi_acp_turn_submit_blocking,
        };
        let fixture = Fixture::new("http://127.0.0.1:1/v1");
        let runtime = PiAcpRuntime::default();
        let coordinator = TurnCoordinator::default();
        coordinator
            .attach_host_store(fixture.store.clone())
            .unwrap();
        let router = RuntimeEventRouter::with_capacity_and_all_observers(
            128,
            None,
            None,
            Some(coordinator.clone()),
        );
        let controller = crate::session_controller::HostSessionController::default();
        let mut response = fixture.response();
        response["promptMode"] = json!("exit");
        let handle = fixture.start(&runtime, &router, response);
        let opened =
            open_native_session(&handle, &router, &fixture.store, None, "Pi task fixture").unwrap();
        let input = HostPiAcpTurnSubmitInput {
            farfold_session_id: opened.farfold_session_id.clone(),
            native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
            runtime_generation: opened.runtime_generation,
            text: "fixture task".into(),
        };
        assert!(matches!(
            host_pi_acp_turn_submit_blocking(
                &controller,
                &fixture.store,
                &runtime,
                &router,
                &coordinator,
                &crate::interaction_registry::InteractionRegistry::default(),
                input
            )
            .unwrap(),
            HostNativeTurnSubmission::Unknown { .. }
        ));
        let target = fixture
            .store
            .session_open_target(&opened.farfold_session_id)
            .unwrap();
        assert!(
            coordinator
                .has_active_session(&opened.farfold_session_id)
                .unwrap()
        );
        let snapshot = serde_json::to_value(coordinator.snapshot().unwrap()).unwrap();
        let turn_id = crate::host_ids::HostTurnId::parse(
            snapshot["activeTurns"][0]["turnId"].as_str().unwrap(),
        )
        .unwrap();
        assert!(
            coordinator
                .require_bound_recovery(&target, opened.runtime_generation + 1, &turn_id)
                .is_err()
        );
        let turn = coordinator
            .require_bound_recovery(&target, opened.runtime_generation, &turn_id)
            .unwrap();
        assert!(
            runtime
                .stop_for_recovery(&router, &target, opened.runtime_generation + 1)
                .is_err()
        );
        let stopped = runtime
            .stop_for_recovery(&router, &target, opened.runtime_generation)
            .unwrap();
        assert!(!stopped.running);
        assert!(stopped.last_error.is_some());
        assert!(
            coordinator
                .has_active_session(&opened.farfold_session_id)
                .unwrap()
        );
        coordinator.finish_bound_recovery(&turn).unwrap();
        assert!(
            !coordinator
                .has_active_session(&opened.farfold_session_id)
                .unwrap()
        );
        assert!(runtime.is_stopped().unwrap());
    }

    #[test]
    fn host_cancel_is_ordered_after_prompt_dispatch_and_waits_for_native_terminal() {
        host_cancel_fixture(false);
    }

    #[test]
    fn ordinary_dialog_reply_requires_native_and_acp_identity_and_rejects_late_answers() {
        use crate::pi_acp_interactions::PiAcpDialogAnswer;
        let fixture = Fixture::new("http://127.0.0.1:1/v1");
        let runtime = PiAcpRuntime::default();
        let interactions = crate::interaction_registry::InteractionRegistry::default();
        let router =
            RuntimeEventRouter::with_capacity_and_observers(128, None, Some(interactions.clone()));
        let controller = crate::session_controller::HostSessionController::default();
        let mut response = fixture.response();
        let mut form = crate::pi_acp_interactions::form_fixture();
        form["params"]["sessionId"] = json!("native-fixture");
        form["params"]["_meta"]["sessionId"] = json!("native-fixture");
        response["form"] = form;
        let handle = fixture.start(&runtime, &router, response);
        let opened =
            open_native_session(&handle, &router, &fixture.store, None, "Pi dialog fixture")
                .unwrap();
        let transport = handle.lock().unwrap().transport.clone();
        let accepted = json!({"action":"accept","content":{"value":false}});
        transport
            .request("fixture/show_form", json!({"expectedAnswer":accepted}))
            .unwrap();
        handle.lock().unwrap().update_events(&router).unwrap();
        assert_eq!(interactions.snapshots().unwrap().len(), 1);
        let input = PiAcpDialogResponseInput {
            farfold_session_id: opened.farfold_session_id,
            native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
            runtime_generation: opened.runtime_generation,
            request_id: "101".into(),
            native_request_id: "manual-dialog-1".into(),
            answer: PiAcpDialogAnswer::Confirm { confirmed: false },
        };
        for mistake in 0..5 {
            let mut wrong = input.clone();
            match mistake {
                0 => wrong.native_session_id = NativeSessionId::parse("other-native").unwrap(),
                1 => wrong.runtime_generation += 1,
                2 => wrong.request_id = "other-rpc-id".into(),
                3 => wrong.native_request_id = "other-native-dialog".into(),
                _ => {
                    wrong.answer = PiAcpDialogAnswer::Text {
                        value: "false".into(),
                    }
                }
            }
            assert!(
                respond_dialog(
                    &controller,
                    &runtime,
                    &fixture.store,
                    &router,
                    &interactions,
                    wrong
                )
                .is_err()
            );
            assert_eq!(interactions.snapshots().unwrap().len(), 1);
        }
        respond_dialog(
            &controller,
            &runtime,
            &fixture.store,
            &router,
            &interactions,
            input.clone(),
        )
        .unwrap();
        assert_eq!(
            transport
                .request("fixture/last_form_answer", json!({}))
                .unwrap(),
            accepted
        );
        assert!(interactions.snapshots().unwrap().is_empty());
        assert!(
            respond_dialog(
                &controller,
                &runtime,
                &fixture.store,
                &router,
                &interactions,
                input.clone()
            )
            .is_err()
        );
        transport.request("fixture/show_form", json!({})).unwrap();
        handle.lock().unwrap().update_events(&router).unwrap();
        assert!(
            respond_dialog(
                &controller,
                &runtime,
                &fixture.store,
                &router,
                &interactions,
                input.clone()
            )
            .is_err()
        );
        assert_eq!(interactions.snapshots().unwrap().len(), 1);
        transport
            .request("fixture/withdraw_form", json!({}))
            .unwrap();
        handle.lock().unwrap().update_events(&router).unwrap();
        assert!(interactions.snapshots().unwrap().is_empty());
        let mut withdrawn = input;
        withdrawn.request_id = "102".into();
        withdrawn.native_request_id = "manual-dialog-2".into();
        assert!(
            respond_dialog(
                &controller,
                &runtime,
                &fixture.store,
                &router,
                &interactions,
                withdrawn
            )
            .is_err()
        );
        assert_eq!(
            transport
                .request("fixture/last_form_answer", json!({}))
                .unwrap(),
            json!({"action":"cancel"})
        );
        runtime.stop_for_shutdown().unwrap();
    }

    #[test]
    fn concurrent_workspace_read_does_not_make_a_confirmed_task_unknown() {
        concurrent_workspace_fixture(false);
    }

    #[test]
    fn pending_workspace_read_does_not_block_native_cancel_dispatch() {
        concurrent_workspace_fixture(true);
    }

    fn concurrent_workspace_fixture(cancel: bool) {
        use crate::turn_coordinator::{
            HostNativeTurnSubmission, HostPiAcpTurnAbortInput, HostPiAcpTurnSubmitInput,
            TurnCoordinator, host_pi_acp_turn_abort_blocking, host_pi_acp_turn_submit_blocking,
        };
        let fixture = Fixture::new("http://127.0.0.1:1/v1");
        let runtime = PiAcpRuntime::default();
        let coordinator = TurnCoordinator::default();
        coordinator
            .attach_host_store(fixture.store.clone())
            .unwrap();
        let interactions = crate::interaction_registry::InteractionRegistry::default();
        let router = RuntimeEventRouter::with_capacity_and_all_observers(
            128,
            None,
            Some(interactions.clone()),
            Some(coordinator.clone()),
        );
        let mut response = fixture.response();
        response["holdEntries"] = json!(true);
        if cancel {
            response["promptMode"] = json!("wait");
        }
        let handle = fixture.start(&runtime, &router, response);
        let opened = open_native_session(
            &handle,
            &router,
            &fixture.store,
            None,
            "Pi concurrent read fixture",
        )
        .unwrap();
        let read_input = PiAcpWorkspaceInput {
            farfold_session_id: opened.farfold_session_id.clone(),
            native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
            runtime_generation: opened.runtime_generation,
            section: PiWorkspaceSection::Entries,
        };
        let reader = {
            let runtime = runtime.clone();
            let store = fixture.store.clone();
            let router = router.clone();
            std::thread::spawn(move || read_workspace(&runtime, &store, &router, read_input))
        };
        let transport = handle.lock().unwrap().transport.clone();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while transport
            .request("fixture/read_pending", json!({}))
            .unwrap()["pending"]
            != true
        {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        }
        let input = HostPiAcpTurnSubmitInput {
            farfold_session_id: opened.farfold_session_id.clone(),
            native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
            runtime_generation: opened.runtime_generation,
            text: "fixture task during held history read".into(),
        };
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let controller = Arc::new(crate::session_controller::HostSessionController::default());
        let worker = {
            let runtime = runtime.clone();
            let store = fixture.store.clone();
            let router = router.clone();
            let coordinator = coordinator.clone();
            let controller = controller.clone();
            let interactions = interactions.clone();
            std::thread::spawn(move || {
                sender
                    .send(host_pi_acp_turn_submit_blocking(
                        &controller,
                        &store,
                        &runtime,
                        &router,
                        &coordinator,
                        &interactions,
                        input,
                    ))
                    .unwrap();
            })
        };
        if cancel {
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            while !coordinator
                .has_active_session(&opened.farfold_session_id)
                .unwrap()
            {
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(1));
            }
            let turn = coordinator
                .active_for_session(&opened.farfold_session_id)
                .unwrap()
                .unwrap();
            assert!(
                host_pi_acp_turn_abort_blocking(
                    &controller,
                    &fixture.store,
                    &runtime,
                    &coordinator,
                    &router,
                    &interactions,
                    HostPiAcpTurnAbortInput {
                        farfold_session_id: opened.farfold_session_id.clone(),
                        native_session_id: NativeSessionId::parse(&opened.native_session_id)
                            .unwrap(),
                        runtime_generation: opened.runtime_generation,
                        turn_id: turn.id().clone(),
                    }
                )
                .unwrap()
            );
        }
        let early = receiver.recv_timeout(Duration::from_millis(300));
        transport
            .request("fixture/release_read", json!({}))
            .unwrap();
        assert!(reader.join().unwrap().is_ok());
        let result =
            early.unwrap_or_else(|_| receiver.recv_timeout(Duration::from_secs(3)).unwrap());
        worker.join().unwrap();
        runtime.stop_for_shutdown().unwrap();
        assert!(
            matches!(
                (&result, cancel),
                (Ok(HostNativeTurnSubmission::Accepted { .. }), false)
                    | (Ok(HostNativeTurnSubmission::Cancelled { .. }), true)
            ),
            "confirmed task became {result:?}"
        );
        assert!(
            !coordinator
                .has_active_session(&opened.farfold_session_id)
                .unwrap()
        );
    }

    #[test]
    fn native_configuration_blocks_new_tasks_and_preserves_unknown_or_explicit_rejection() {
        use crate::turn_coordinator::{
            HostPiAcpTurnSubmitInput, TurnCoordinator, host_pi_acp_turn_submit_blocking,
        };
        for mode in ["accepted", "reject", "malformed", "disconnect"] {
            let fixture = Fixture::new("http://127.0.0.1:1/v1");
            let runtime = PiAcpRuntime::default();
            let controller = crate::session_controller::HostSessionController::default();
            let turns = TurnCoordinator::default();
            let interactions = crate::interaction_registry::InteractionRegistry::default();
            let router = RuntimeEventRouter::default();
            let mut response = fixture.response();
            response["configMode"] = json!(mode);
            let handle = fixture.start(&runtime, &router, response);
            let opened = open_native_session(
                &handle,
                &router,
                &fixture.store,
                None,
                "Pi configuration fixture",
            )
            .unwrap();
            let transport = handle.lock().unwrap().transport.clone();
            let target = fixture
                .store
                .session_open_target(&opened.farfold_session_id)
                .unwrap();
            let input = PiAcpConfigInput {
                farfold_session_id: opened.farfold_session_id.clone(),
                native_session_id: target.native_session_id.clone(),
                runtime_generation: opened.runtime_generation,
                config_id: PiAcpConfigId::ThoughtLevel,
                value: "high".into(),
            };
            for field in ["generation", "native", "choice", "model"] {
                let mut wrong = input.clone();
                match field {
                    "generation" => wrong.runtime_generation += 1,
                    "native" => {
                        wrong.native_session_id = NativeSessionId::parse("wrong-native").unwrap()
                    }
                    "choice" => wrong.value = "xhigh".into(),
                    _ => {
                        wrong.config_id = PiAcpConfigId::Model;
                        wrong.value = "other/model".into();
                    }
                }
                assert!(
                    set_config_option(
                        &controller,
                        &runtime,
                        &fixture.store,
                        &router,
                        &turns,
                        wrong
                    )
                    .is_err()
                );
            }
            std::thread::scope(|scope| {
                let worker = scope.spawn(|| {
                    set_config_option(
                        &controller,
                        &runtime,
                        &fixture.store,
                        &router,
                        &turns,
                        input.clone(),
                    )
                });
                let deadline = std::time::Instant::now() + Duration::from_secs(3);
                while !handle.lock().unwrap().operations.is_pending() {
                    if worker.is_finished() {
                        panic!(
                            "configuration returned before fixture dispatch: {:?}",
                            worker.join().unwrap()
                        );
                    }
                    assert!(std::time::Instant::now() < deadline);
                    std::thread::sleep(Duration::from_millis(1));
                }
                assert_eq!(
                    transport
                        .request("fixture/config_status", json!({}))
                        .unwrap()["held"],
                    true
                );
                assert!(
                    host_pi_acp_turn_submit_blocking(
                        &controller,
                        &fixture.store,
                        &runtime,
                        &router,
                        &turns,
                        &interactions,
                        HostPiAcpTurnSubmitInput {
                            farfold_session_id: input.farfold_session_id.clone(),
                            native_session_id: input.native_session_id.clone(),
                            runtime_generation: input.runtime_generation,
                            text: "Must not dispatch".into()
                        }
                    )
                    .is_err()
                );
                assert!(
                    !turns
                        .has_active_session(&opened.farfold_session_id)
                        .unwrap()
                );
                if mode == "disconnect" {
                    assert!(
                        runtime
                            .stop_idle_session(&router, &target, input.runtime_generation + 1)
                            .is_err()
                    );
                    runtime
                        .stop_idle_session(&router, &target, input.runtime_generation)
                        .unwrap();
                    assert!(worker.join().unwrap().is_err());
                    assert!(runtime.is_stopped().unwrap());
                    return;
                }
                transport
                    .request("fixture/release_config", json!({}))
                    .unwrap();
                let result = worker.join().unwrap();
                assert_eq!(result.is_ok(), mode == "accepted", "{result:?}");
                assert_eq!(
                    handle.lock().unwrap().operations.is_pending(),
                    mode == "malformed"
                );
                assert_eq!(
                    verify_task_target(&runtime, &target, input.runtime_generation).is_ok(),
                    mode != "malformed"
                );
                if let Ok(status) = result {
                    assert_eq!(
                        selected_config(&status.config_options, "thought_level"),
                        Some("high")
                    );
                }
                let status = transport
                    .request("fixture/config_status", json!({}))
                    .unwrap();
                assert_eq!(status["configs"], 1);
                assert_eq!(status["prompts"], 0);
            });
            if mode == "disconnect" {
                continue;
            }
            let mut connection = handle.lock().unwrap();
            connection.config_options[0]["currentValue"] = json!("other/model");
            drop(connection);
            assert!(verify_prompt_target(&runtime, &target, input.runtime_generation).is_err());
            assert_eq!(
                verify_task_target(&runtime, &target, input.runtime_generation).is_ok(),
                mode != "malformed"
            );
            assert!(
                runtime
                    .stop_idle_session(&router, &target, input.runtime_generation + 1)
                    .is_err()
            );
            let stopped = runtime
                .stop_idle_session(&router, &target, input.runtime_generation)
                .unwrap();
            assert_eq!(stopped.last_error.is_some(), mode == "malformed");
            assert!(runtime.is_stopped().unwrap());
        }
    }

    #[test]
    fn intervention_ack_is_ordered_with_terminal_and_does_not_block_stop() {
        use crate::turn_coordinator::{
            HostNativeTurnSubmission, HostPiAcpInterventionInput, HostPiAcpInterventionOutcome,
            HostPiAcpTurnAbortInput, HostPiAcpTurnSubmitInput, TurnCoordinator,
            host_pi_acp_intervene_blocking, host_pi_acp_turn_abort_blocking,
            host_pi_acp_turn_submit_blocking,
        };
        for mode in ["complete", "malformed", "cancel"] {
            let fixture = Fixture::new("http://127.0.0.1:1/v1");
            let runtime = PiAcpRuntime::default();
            let coordinator = TurnCoordinator::default();
            coordinator
                .attach_host_store(fixture.store.clone())
                .unwrap();
            let interactions = crate::interaction_registry::InteractionRegistry::default();
            let router = RuntimeEventRouter::with_capacity_and_all_observers(
                128,
                None,
                Some(interactions.clone()),
                Some(coordinator.clone()),
            );
            let controller = crate::session_controller::HostSessionController::default();
            let mut response = fixture.response();
            response["promptMode"] = json!("wait");
            response["holdIntervention"] = json!(true);
            let handle = fixture.start(&runtime, &router, response);
            let opened = open_native_session(
                &handle,
                &router,
                &fixture.store,
                None,
                "Pi intervention fixture",
            )
            .unwrap();
            let transport = handle.lock().unwrap().transport.clone();
            let native = NativeSessionId::parse(&opened.native_session_id).unwrap();
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            std::thread::scope(|scope| {
                let worker = scope.spawn(|| {
                    sender
                        .send(host_pi_acp_turn_submit_blocking(
                            &controller,
                            &fixture.store,
                            &runtime,
                            &router,
                            &coordinator,
                            &interactions,
                            HostPiAcpTurnSubmitInput {
                                farfold_session_id: opened.farfold_session_id.clone(),
                                native_session_id: native.clone(),
                                runtime_generation: opened.runtime_generation,
                                text: "Original fixture prompt".into(),
                            },
                        ))
                        .unwrap();
                });
                let deadline = std::time::Instant::now() + Duration::from_secs(3);
                while transport
                    .request("fixture/intervention_status", json!({}))
                    .unwrap()["prompts"]
                    != 1
                {
                    assert!(std::time::Instant::now() < deadline);
                    std::thread::sleep(Duration::from_millis(1));
                }
                let active = coordinator
                    .active_for_session(&opened.farfold_session_id)
                    .unwrap()
                    .unwrap();
                assert!(
                    set_config_option(
                        &controller,
                        &runtime,
                        &fixture.store,
                        &router,
                        &coordinator,
                        PiAcpConfigInput {
                            farfold_session_id: opened.farfold_session_id.clone(),
                            native_session_id: native.clone(),
                            runtime_generation: opened.runtime_generation,
                            config_id: PiAcpConfigId::ThoughtLevel,
                            value: "high".into()
                        }
                    )
                    .is_err()
                );
                let input = HostPiAcpInterventionInput {
                    farfold_session_id: opened.farfold_session_id.clone(),
                    native_session_id: native.clone(),
                    runtime_generation: opened.runtime_generation,
                    turn_id: active.id().clone(),
                    kind: if mode == "cancel" {
                        PiAcpInterventionKind::FollowUp
                    } else {
                        PiAcpInterventionKind::Steer
                    },
                    message: "Native intervention".into(),
                };
                for field in ["generation", "native", "turn", "empty"] {
                    let mut wrong = input.clone();
                    match field {
                        "generation" => wrong.runtime_generation += 1,
                        "native" => {
                            wrong.native_session_id =
                                NativeSessionId::parse("other-native").unwrap()
                        }
                        "turn" => {
                            wrong.turn_id = crate::host_ids::HostTurnId::parse("old-turn").unwrap()
                        }
                        _ => wrong.message.clear(),
                    }
                    assert!(
                        host_pi_acp_intervene_blocking(
                            &controller,
                            &fixture.store,
                            &runtime,
                            &coordinator,
                            wrong
                        )
                        .is_err()
                    );
                }
                let intervention = {
                    let input = input.clone();
                    let controller = &controller;
                    let store = &fixture.store;
                    let runtime = &runtime;
                    let coordinator = &coordinator;
                    scope.spawn(move || {
                        host_pi_acp_intervene_blocking(
                            controller,
                            store,
                            runtime,
                            coordinator,
                            input,
                        )
                    })
                };
                let deadline = std::time::Instant::now() + Duration::from_secs(3);
                while transport
                    .request("fixture/intervention_status", json!({}))
                    .unwrap()["held"]
                    != true
                {
                    assert!(std::time::Instant::now() < deadline);
                    std::thread::sleep(Duration::from_millis(1));
                }
                if mode == "cancel" {
                    assert!(
                        host_pi_acp_turn_abort_blocking(
                            &controller,
                            &fixture.store,
                            &runtime,
                            &coordinator,
                            &router,
                            &interactions,
                            HostPiAcpTurnAbortInput {
                                farfold_session_id: input.farfold_session_id.clone(),
                                native_session_id: native.clone(),
                                runtime_generation: opened.runtime_generation,
                                turn_id: input.turn_id.clone(),
                            },
                        )
                        .unwrap()
                    );
                } else {
                    transport
                        .request("fixture/finish_prompt", json!({}))
                        .unwrap();
                }
                let early = receiver.recv_timeout(Duration::from_millis(100));
                transport
                    .request(
                        "fixture/release_intervention",
                        json!({"malformed":mode=="malformed"}),
                    )
                    .unwrap();
                let reply = intervention.join().unwrap().unwrap();
                let settled_early = early.is_ok();
                let terminal = early
                    .unwrap_or_else(|_| receiver.recv_timeout(Duration::from_secs(3)).unwrap())
                    .unwrap();
                worker.join().unwrap();
                assert!(
                    !settled_early,
                    "terminal settled before intervention ACK validation"
                );
                assert!(
                    matches!(
                        (&reply, mode),
                        (HostPiAcpInterventionOutcome::Unknown { .. }, "malformed")
                            | (
                                HostPiAcpInterventionOutcome::Queued { .. },
                                "complete" | "cancel"
                            )
                    ),
                    "{reply:?}"
                );
                assert!(
                    matches!(
                        (&terminal, mode),
                        (HostNativeTurnSubmission::Unknown { .. }, "malformed")
                            | (HostNativeTurnSubmission::Accepted { .. }, "complete")
                            | (HostNativeTurnSubmission::Cancelled { .. }, "cancel")
                    ),
                    "{terminal:?}"
                );
                let remaining = coordinator
                    .active_for_session(&opened.farfold_session_id)
                    .unwrap();
                assert_eq!(remaining.is_some(), mode == "malformed");
                assert!(
                    host_pi_acp_intervene_blocking(
                        &controller,
                        &fixture.store,
                        &runtime,
                        &coordinator,
                        input
                    )
                    .is_err()
                );
                let status = transport
                    .request("fixture/intervention_status", json!({}))
                    .unwrap();
                assert_eq!(status["prompts"], 1);
                assert_eq!(status["interventions"].as_array().unwrap().len(), 1);
            });
            runtime.stop_for_shutdown().unwrap();
        }
    }

    #[test]
    fn host_cancel_closes_exact_form_registry_after_native_withdrawal() {
        host_cancel_fixture(true);
    }

    fn host_cancel_fixture(with_form: bool) {
        host_cancel_capability_fixture(with_form, false);
    }

    #[test]
    fn unsupported_compaction_cancel_preserves_active_task_and_normal_completion() {
        host_cancel_capability_fixture(false, true);
    }

    fn host_cancel_capability_fixture(with_form: bool, unsupported: bool) {
        use crate::turn_coordinator::{
            HostNativeTurnSubmission, HostPiAcpTurnAbortInput, HostPiAcpTurnSubmitInput,
            TurnCoordinator, host_pi_acp_turn_abort_blocking, host_pi_acp_turn_submit_blocking,
        };
        let fixture = Fixture::new("http://127.0.0.1:1/v1");
        let runtime = PiAcpRuntime::default();
        let coordinator = TurnCoordinator::default();
        coordinator
            .attach_host_store(fixture.store.clone())
            .unwrap();
        let interactions = crate::interaction_registry::InteractionRegistry::default();
        let router = RuntimeEventRouter::with_capacity_and_all_observers(
            128,
            None,
            Some(interactions.clone()),
            Some(coordinator.clone()),
        );
        let controller = Arc::new(crate::session_controller::HostSessionController::default());
        let mut response = fixture.response();
        response["promptMode"] = json!("wait");
        response["cancelUnsupported"] = json!(unsupported);
        if with_form {
            let mut form = crate::pi_acp_interactions::form_fixture();
            form["params"]["sessionId"] = json!("native-fixture");
            form["params"]["_meta"]["sessionId"] = json!("native-fixture");
            response["form"] = form;
        }
        let handle = fixture.start(&runtime, &router, response);
        let opened =
            open_native_session(&handle, &router, &fixture.store, None, "Pi cancel fixture")
                .unwrap();
        let mut previous_abort: Option<HostPiAcpTurnAbortInput> = None;
        for round in 0..2 {
            let input = HostPiAcpTurnSubmitInput {
                farfold_session_id: opened.farfold_session_id.clone(),
                native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
                runtime_generation: opened.runtime_generation,
                text: "fixture pending task".into(),
            };
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            let worker = {
                let runtime = runtime.clone();
                let router = router.clone();
                let coordinator = coordinator.clone();
                let controller = controller.clone();
                let store = fixture.store.clone();
                let interactions = interactions.clone();
                std::thread::spawn(move || {
                    sender
                        .send(host_pi_acp_turn_submit_blocking(
                            &controller,
                            &store,
                            &runtime,
                            &router,
                            &coordinator,
                            &interactions,
                            input,
                        ))
                        .unwrap()
                })
            };
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            while !coordinator
                .has_active_session(&opened.farfold_session_id)
                .unwrap()
                || (with_form && interactions.snapshots().unwrap().is_empty())
            {
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(1));
            }
            let abort = HostPiAcpTurnAbortInput {
                farfold_session_id: opened.farfold_session_id.clone(),
                native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
                runtime_generation: opened.runtime_generation,
                turn_id: coordinator
                    .active_for_session(&opened.farfold_session_id)
                    .unwrap()
                    .unwrap()
                    .id()
                    .clone(),
            };
            let mut stale_abort = abort.clone();
            stale_abort.turn_id = crate::host_ids::HostTurnId::parse("stale-turn").unwrap();
            if let Some(previous) = &previous_abort {
                stale_abort = previous.clone();
            }
            if with_form && round == 1 {
                assert!(
                    interactions
                        .begin_response(
                            fixture.binding.clone(),
                            opened.runtime_generation,
                            "7",
                            Some("native-fixture")
                        )
                        .is_err()
                );
                assert!(
                    handle
                        .lock()
                        .unwrap()
                        .transport
                        .respond_client_request(
                            "7",
                            json!({"action":"accept","content":{"value":true}})
                        )
                        .is_err()
                );
                assert_eq!(interactions.snapshots().unwrap().len(), 1);
            }
            assert!(
                host_pi_acp_turn_abort_blocking(
                    &controller,
                    &fixture.store,
                    &runtime,
                    &coordinator,
                    &router,
                    &interactions,
                    stale_abort
                )
                .unwrap_err()
                .contains("旧任务")
            );
            assert!(receiver.try_recv().is_err());
            let cancel_result = host_pi_acp_turn_abort_blocking(
                &controller,
                &fixture.store,
                &runtime,
                &coordinator,
                &router,
                &interactions,
                abort.clone(),
            );
            if unsupported {
                assert!(cancel_result.unwrap_err().contains("不支持停止手动压缩"));
                assert!(
                    coordinator
                        .has_active_session(&opened.farfold_session_id)
                        .unwrap()
                );
                assert!(receiver.try_recv().is_err());
                handle
                    .lock()
                    .unwrap()
                    .transport
                    .request("fixture/finish_prompt", json!({}))
                    .unwrap();
            } else {
                assert!(cancel_result.unwrap());
            }
            let result = receiver.recv_timeout(Duration::from_secs(3));
            if result.is_err() {
                let _ = runtime.stop_for_shutdown();
            }
            worker.join().unwrap();
            let result = result.unwrap().unwrap();
            assert!(matches!(
                (&result, unsupported),
                (HostNativeTurnSubmission::Accepted { .. }, true)
                    | (HostNativeTurnSubmission::Cancelled { .. }, false)
            ));
            assert!(
                !coordinator
                    .has_active_session(&opened.farfold_session_id)
                    .unwrap()
            );
            let pending_forms = interactions.snapshots().unwrap();
            assert!(
                pending_forms.is_empty(),
                "registry pending after confirmed cancel: {pending_forms:?}"
            );
            if with_form {
                assert!(
                    interactions
                        .begin_response(
                            fixture.binding.clone(),
                            opened.runtime_generation,
                            &(7 + round).to_string(),
                            Some("native-fixture")
                        )
                        .is_err()
                );
            }
            previous_abort = Some(abort);
        }
        runtime.stop_for_shutdown().unwrap();
    }

    #[test]
    fn idle_exited_connection_can_be_cleaned_then_restore_the_original_session() {
        let fixture = Fixture::new("http://127.0.0.1:1/v1");
        let runtime = PiAcpRuntime::default();
        let router = RuntimeEventRouter::default();
        let handle = fixture.start(&runtime, &router, fixture.response());
        let first =
            open_native_session(&handle, &router, &fixture.store, None, "Pi fixture").unwrap();
        let native = fixture.native();
        fs::write(
            &native.session_file,
            format!(
                "{}\n",
                json!({"type":"session","id":native.session_id,"cwd":native.cwd})
            ),
        )
        .unwrap();
        register_observation(&fixture.store, &handle.lock().unwrap(), "Pi fixture").unwrap();
        let target = fixture
            .store
            .session_open_target(&first.farfold_session_id)
            .unwrap();
        let transport = handle.lock().unwrap().transport.clone();
        transport
            .notify_timeout("fixture/idle_crash", json!({}), Duration::from_secs(1))
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while transport.is_running().unwrap() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!transport.is_running().unwrap());
        assert!(!runtime.is_stopped().unwrap());
        let disconnected = current_status(&runtime, &router).unwrap();
        assert!(!disconnected.running);
        assert!(disconnected.runtime.is_some());
        assert_eq!(
            disconnected.native_session.as_ref().unwrap().session_id,
            native.session_id
        );
        assert!(require_live_target(&handle.lock().unwrap(), &target).is_err());
        assert!(
            runtime
                .stop_idle_session(&router, &target, first.runtime_generation + 1)
                .is_err()
        );
        let stopped = runtime
            .stop_idle_session(&router, &target, first.runtime_generation)
            .unwrap();
        assert!(!stopped.running);
        assert!(stopped.last_error.is_some());
        assert!(runtime.is_stopped().unwrap());
        let restored_handle = fixture.start(&runtime, &router, fixture.response());
        let restored = open_native_session(
            &restored_handle,
            &router,
            &fixture.store,
            Some(&native),
            &target.title,
        )
        .unwrap();
        assert_eq!(restored.farfold_session_id, first.farfold_session_id);
        assert_eq!(restored.native_session_id, first.native_session_id);
        assert!(restored.runtime_generation > first.runtime_generation);
        runtime.stop_for_shutdown().unwrap();
    }

    #[test]
    fn shared_registration_keeps_empty_session_nonrestorable_and_stop_is_exact() {
        let fixture = Fixture::new("http://127.0.0.1:1/v1");
        let runtime = PiAcpRuntime::default();
        let router = RuntimeEventRouter::default();
        let handle = fixture.start(&runtime, &router, fixture.response());
        let opened =
            open_native_session(&handle, &router, &fixture.store, None, "Pi fixture").unwrap();
        let target = fixture
            .store
            .session_open_target(&opened.farfold_session_id)
            .unwrap();
        assert_eq!(target.binding(), fixture.binding);
        assert_eq!(target.native_session_id.as_str(), "native-fixture");
        assert_eq!(
            target.blockers(),
            vec![SessionOpenBlocker::NativeLocatorUnavailable]
        );
        assert!(!fixture.native().session_file.exists());
        let projection = fixture
            .store
            .provider_projection_snapshot(&fixture.selection.provider_connection_id)
            .unwrap();
        assert_eq!(
            projection.projections[0].apply_state,
            ProviderApplyState::Applied
        );
        assert_eq!(
            projection.projections[0].request_state,
            ProviderRequestState::NotRequested
        );
        assert_eq!(projection.projections[0].request_verified_version_id, None);
        assert!(
            runtime
                .stop_idle_session(&router, &target, opened.runtime_generation + 1)
                .is_err()
        );
        assert!(!runtime.is_stopped().unwrap());
        require_live_target(&handle.lock().unwrap(), &target).unwrap();
        assert_eq!(
            register_observation(&fixture.store, &handle.lock().unwrap(), "Pi fixture").unwrap(),
            opened.farfold_session_id
        );
        assert!(
            !runtime
                .stop_idle_session(&router, &target, opened.runtime_generation)
                .unwrap()
                .running
        );
        assert!(runtime.is_stopped().unwrap());
        assert!(
            fixture
                .store
                .session_open_target(&opened.farfold_session_id)
                .is_ok()
        );
    }

    #[test]
    fn managed_empty_load_requires_original_receipt_and_never_creates_native_first_use() {
        for valid in [true, false] {
            let fixture = Fixture::stable("http://127.0.0.1:1/v1");
            let runtime = PiAcpRuntime::default();
            let router = RuntimeEventRouter::default();
            let mut response = fixture.response();
            let anchor = managed_pre_file_anchor(
                &fixture.binding,
                fixture.prepared.binding.as_ref().unwrap(),
                &fixture.prepared.profile_root,
                &fixture.cwd,
            )
            .unwrap();
            if valid {
                response["_meta"]["farfoldPi"]["managedPreFile"] = anchor.clone();
            }
            let handle = fixture.start(&runtime, &router, response);
            let result = open_native_session_request(
                &handle,
                &router,
                &fixture.store,
                Some(PiNativeSessionRequest::Identity(
                    NativeSessionId::parse("native-fixture").unwrap(),
                )),
                "Empty managed",
            );
            assert_eq!(result.is_ok(), valid, "{:?}", result.as_ref().err());
            assert!(handle.lock().unwrap().native_first_use.is_none());
            assert!(!fixture.native().session_file.exists());
            let mut changed = fixture.binding.clone();
            changed.connection_id = ConnectionId::parse("other-connection").unwrap();
            assert_ne!(
                anchor,
                managed_pre_file_anchor(
                    &changed,
                    fixture.prepared.binding.as_ref().unwrap(),
                    &fixture.prepared.profile_root,
                    &fixture.cwd
                )
                .unwrap()
            );
            assert_ne!(
                anchor,
                managed_pre_file_anchor(
                    &fixture.binding,
                    fixture.prepared.binding.as_ref().unwrap(),
                    &fixture.prepared.profile_root.join("other"),
                    &fixture.cwd
                )
                .unwrap()
            );
            runtime.stop_for_shutdown().unwrap();
        }
    }

    #[test]
    #[ignore = "fixed Pi/Node, isolated empty managed session, trust restart and control read; zero model requests"]
    fn fixed_pi_managed_empty_trust_restart_and_session_control_are_model_free() {
        let server = crate::opencode_acp::tests::ChatFixtureServer::start();
        let fixture = Fixture::stable(&format!("http://127.0.0.1:{}/v1", server.port));
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let node = manifest.join("capability-bridge/runtime/node");
        let pi = manifest.join("resources/pi-runtime/pi");
        assert_eq!(file_sha256(&node).unwrap(), NODE_SHA256);
        crate::runtime_registry::verify_managed_binary_path(pi.clone(), PI_ACP_RUNTIME).unwrap();
        let runtime = PiAcpRuntime::default();
        let router = RuntimeEventRouter::default();
        let start = |trust| {
            let mut command = launch_command(
                &node,
                &manifest.join("pi-acp-adapter/dist/index.js"),
                &pi,
                &fixture.cwd,
                &fixture.prepared,
                Some(trust),
            )
            .unwrap();
            start_connection(
                &runtime,
                &router,
                fixture.binding.clone(),
                &fixture.cwd,
                &fixture.prepared,
                &mut command,
            )
            .unwrap()
        };
        let handle = start("ignore");
        let first =
            open_native_session(&handle, &router, &fixture.store, None, "Empty managed").unwrap();
        let native = handle.lock().unwrap().native.clone().unwrap();
        assert!(!native.session_file.exists());
        runtime.stop_for_shutdown().unwrap();
        let handle = start("approve");
        let restored = open_native_session_request(
            &handle,
            &router,
            &fixture.store,
            Some(PiNativeSessionRequest::Identity(
                NativeSessionId::parse(&first.native_session_id).unwrap(),
            )),
            "Empty managed",
        )
        .unwrap();
        assert_eq!(restored.farfold_session_id, first.farfold_session_id);
        assert_eq!(restored.native_session_id, first.native_session_id);
        assert!(restored.runtime_generation > first.runtime_generation);
        assert!(
            !handle
                .lock()
                .unwrap()
                .native
                .as_ref()
                .unwrap()
                .session_file
                .exists()
        );
        read_workspace(
            &runtime,
            &fixture.store,
            &router,
            PiAcpWorkspaceInput {
                farfold_session_id: first.farfold_session_id.clone(),
                native_session_id: NativeSessionId::parse(&first.native_session_id).unwrap(),
                runtime_generation: restored.runtime_generation,
                section: PiWorkspaceSection::SessionCommand,
            },
        )
        .unwrap();
        let projection = fixture
            .store
            .provider_projection_snapshot(&fixture.selection.provider_connection_id)
            .unwrap();
        assert_eq!(
            projection.projections[0].request_state,
            ProviderRequestState::NotRequested
        );
        assert!(server.captured.lock().unwrap().is_empty());
        runtime.stop_for_shutdown().unwrap();
    }

    #[test]
    fn wrong_native_identity_or_model_never_registers_or_marks_provider_applied() {
        let fixture = Fixture::new("http://127.0.0.1:1/v1");
        for pointer in [
            "/sessionId",
            "/_meta/farfoldPi/nativeSession/cwd",
            "/configOptions/0/currentValue",
        ] {
            let runtime = PiAcpRuntime::default();
            let router = RuntimeEventRouter::default();
            let mut response = fixture.response();
            *response.pointer_mut(pointer).unwrap() = json!("wrong");
            let handle = fixture.start(&runtime, &router, response);
            assert!(
                open_native_session(&handle, &router, &fixture.store, None, "Pi fixture").is_err()
            );
            runtime.stop_locked(Some(&router)).unwrap();
            assert!(
                fixture
                    .store
                    .provider_projection_snapshot(&fixture.selection.provider_connection_id)
                    .unwrap()
                    .projections
                    .is_empty()
            );
            assert!(serde_json::to_value(fixture.store.navigation_snapshot().unwrap()).unwrap()["sessionIndex"]["sessions"].as_array().unwrap().is_empty());
        }
    }

    #[test]
    fn native_owned_profile_persists_without_a_managed_provider_or_implicit_grant() {
        let temp = tempfile::tempdir().unwrap();
        let store = HostStore::open(temp.path().join("host.sqlite3"));
        let profile = new_owned_profile(None).unwrap();
        store
            .register_runtime_owned_profile(&runtime_registration(&profile.binding, 1), &profile)
            .unwrap();
        let restored = saved_owned_profile(&store, &profile.binding).unwrap();
        assert_eq!(restored.profile_id, profile.profile_id);
        assert_eq!(restored.binding, profile.binding);
        assert!(restored.bootstrap_managed_provider.is_none());
        assert!(
            store
                .runtime_profile_provider_versions(&profile.binding)
                .unwrap()
                .is_empty()
        );
        let db = rusqlite::Connection::open(temp.path().join("host.sqlite3")).unwrap();
        db.pragma_update(None, "foreign_keys", true).unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM provider_connections", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        );
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM runtime_profile_provider_versions",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert!(
            db.execute(
                "UPDATE runtime_owned_profiles SET bootstrap_provider_connection_id = 'incomplete'",
                []
            )
            .is_err()
        );
        assert!(
            db.execute(
                "UPDATE runtime_owned_profiles SET layout = 'legacy_provider_bound_v1'",
                []
            )
            .is_err()
        );
        let mut invalid = profile.clone();
        invalid.layout = OwnedProfileLayout::LegacyProviderBoundV1;
        assert!(invalid.validate().is_err());
        assert!(
            store
                .register_runtime_owned_profile(
                    &runtime_registration(&profile.binding, 2),
                    &invalid
                )
                .is_err()
        );
        assert!(store.discard_unbound_owned_profile(&profile).unwrap());
        assert!(
            store
                .runtime_owned_profile(&profile.binding)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn unfinished_native_first_use_never_registers_or_restores_a_session() {
        let fixture = Fixture::new("http://127.0.0.1:1/v1");
        let runtime = PiAcpRuntime::default();
        let router = RuntimeEventRouter::default();
        let handle = fixture.start(&runtime, &router, fixture.response());
        handle.lock().unwrap().managed_provider = None;
        for requested in [None, Some(fixture.native())] {
            assert!(
                open_native_session(
                    &handle,
                    &router,
                    &fixture.store,
                    requested.as_ref(),
                    "Unfinished native first use"
                )
                .is_err()
            );
            assert!(handle.lock().unwrap().native.is_none());
        }
        assert!(serde_json::to_value(fixture.store.navigation_snapshot().unwrap()).unwrap()["sessionIndex"]["sessions"].as_array().unwrap().is_empty());
        runtime.stop_for_shutdown().unwrap();
    }

    #[test]
    fn owned_profile_authorization_is_exact_and_does_not_apply_or_verify_a_version() {
        let fixture = Fixture::new("http://127.0.0.1:1/v1");
        let profile = new_owned_profile(fixture.selection.clone()).unwrap();
        let prepared = crate::acp_provider_profile::prepare_owned(
            fixture.temp.path(),
            &fixture.temp.path().join("pi-acp"),
            &fixture.store,
            &profile,
            true,
        )
        .unwrap();
        let original_file = fs::read(prepared.config_root.join("models.json")).unwrap();
        fixture
            .store
            .register_runtime_owned_profile(&runtime_registration(&profile.binding, 1), &profile)
            .unwrap();
        let versions = || {
            fixture
                .store
                .runtime_profile_provider_versions(&profile.binding)
                .unwrap()
        };
        assert_eq!(versions().len(), 1);
        assert_eq!(
            versions()[0].provider_config_version_id,
            fixture.selection.provider_config_version_id
        );
        let second = crate::acp_provider_profile::tests::save_fixture(
            fixture.temp.path(),
            &fixture.store,
            "http://127.0.0.1:1/v1",
            "openai-chat-completions",
            "changed-synthetic-key",
        );
        assert_eq!(
            versions().len(),
            1,
            "global Provider edits cannot silently authorize another profile version"
        );
        let mut wrong = profile.binding.clone();
        wrong.runtime_build_id = crate::host_ids::RuntimeBuildId::parse("wrong-build").unwrap();
        assert!(
            fixture
                .store
                .authorize_runtime_profile_provider_version(&wrong, &second)
                .is_err()
        );
        assert!(
            fixture
                .store
                .authorize_runtime_profile_provider_version(&profile.binding, &fixture.selection)
                .is_err(),
            "stale explicit selection is rejected without removing its existing grant"
        );
        fixture
            .store
            .authorize_runtime_profile_provider_version(&profile.binding, &second)
            .unwrap();
        fixture
            .store
            .authorize_runtime_profile_provider_version(&profile.binding, &second)
            .unwrap();
        assert_eq!(versions().len(), 2);
        assert_eq!(
            fs::read(prepared.config_root.join("models.json")).unwrap(),
            original_file
        );
        assert!(
            fixture
                .store
                .provider_projection_snapshot(&second.provider_connection_id)
                .unwrap()
                .projections
                .is_empty()
        );
        let restored = saved_owned_profile(&fixture.store, &profile.binding).unwrap();
        assert_eq!(
            restored
                .bootstrap_managed_provider
                .as_ref()
                .unwrap()
                .provider_config_version_id,
            fixture.selection.provider_config_version_id
        );
        rusqlite::Connection::open(fixture.temp.path().join("host.sqlite3")).unwrap()
            .execute("DELETE FROM runtime_profile_provider_versions WHERE profile_id = ?1 AND provider_config_version_id = ?2", rusqlite::params![profile.profile_id.as_str(), fixture.selection.provider_config_version_id.as_str()]).unwrap();
        assert!(saved_owned_profile(&fixture.store, &profile.binding).is_err());
        assert!(
            fixture
                .store
                .register_runtime_owned_profile(
                    &runtime_registration(&profile.binding, 2),
                    &profile
                )
                .is_err(),
            "a missing bootstrap grant must not be silently recreated"
        );
    }

    #[test]
    fn owned_profile_creation_and_restore_keep_launch_identity_separate_from_provider_version() {
        let fixture = Fixture::new("http://127.0.0.1:1/v1");
        let profile = new_owned_profile(fixture.selection.clone()).unwrap();
        let other = new_owned_profile(fixture.selection.clone()).unwrap();
        assert_ne!(profile.profile_id, other.profile_id);
        assert_ne!(profile.binding, other.binding);
        assert_ne!(profile.binding, fixture.binding);
        assert!(
            saved_owned_profile(&fixture.store, &profile.binding)
                .unwrap_err()
                .contains("reference is missing")
        );
        let prepared = crate::acp_provider_profile::prepare_owned(
            fixture.temp.path(),
            &fixture.temp.path().join("pi-acp"),
            &fixture.store,
            &profile,
            true,
        )
        .unwrap();
        assert_eq!(
            prepared.profile_root.file_name().unwrap(),
            profile.profile_id.as_str()
        );
        fixture
            .store
            .register_runtime_owned_profile(&runtime_registration(&profile.binding, 1), &profile)
            .unwrap();
        let second = crate::acp_provider_profile::tests::save_fixture(
            fixture.temp.path(),
            &fixture.store,
            "http://127.0.0.1:2/v1",
            "openai-chat-completions",
            "changed-fixture-key",
        );
        assert_ne!(
            second.provider_config_version_id,
            fixture.selection.provider_config_version_id
        );
        let reopened_store = HostStore::open(fixture.temp.path().join("host.sqlite3"));
        let restored = saved_owned_profile(&reopened_store, &profile.binding).unwrap();
        assert_eq!(
            restored
                .bootstrap_managed_provider
                .as_ref()
                .unwrap()
                .provider_config_version_id,
            fixture.selection.provider_config_version_id
        );
        let restored_files = crate::acp_provider_profile::prepare_owned(
            fixture.temp.path(),
            &fixture.temp.path().join("pi-acp"),
            &reopened_store,
            &restored,
            false,
        )
        .unwrap();
        assert_eq!(restored_files.profile_root, prepared.profile_root);
        assert_eq!(restored_files.binding, prepared.binding);
        assert!(serde_json::to_value(reopened_store.navigation_snapshot().unwrap()).unwrap()["sessionIndex"]["sessions"].as_array().unwrap().is_empty());
        let mut changed = profile.clone();
        changed.bootstrap_managed_provider = Some(second);
        assert!(
            reopened_store
                .register_runtime_owned_profile(
                    &runtime_registration(&profile.binding, 2),
                    &changed
                )
                .is_err()
        );
        assert_eq!(
            saved_owned_profile(&reopened_store, &profile.binding)
                .unwrap()
                .bootstrap_managed_provider
                .as_ref()
                .unwrap()
                .provider_config_version_id,
            fixture.selection.provider_config_version_id
        );
        assert!(
            reopened_store
                .discard_unbound_owned_profile(&profile)
                .unwrap()
        );
        assert!(saved_owned_profile(&reopened_store, &profile.binding).is_err());
    }

    #[test]
    fn prompt_dispatch_rejects_provider_changed_since_admission_even_when_model_text_is_identical()
    {
        let fixture = Fixture::new("http://127.0.0.1:1/v1");
        let runtime = PiAcpRuntime::default();
        let router = RuntimeEventRouter::default();
        let handle = fixture.start(&runtime, &router, fixture.response());
        let opened =
            open_native_session(&handle, &router, &fixture.store, None, "Admission fixture")
                .unwrap();
        let target = fixture
            .store
            .session_open_target(&opened.farfold_session_id)
            .unwrap();
        let admitted = capture_prompt_model(
            &runtime,
            &fixture.store,
            &router,
            &target,
            opened.runtime_generation,
        )
        .unwrap();
        let turn_id = HostTurnId::parse("admission-fixture-turn").unwrap();
        {
            let mut connection = handle.lock().unwrap();
            connection.managed_versions[0].provider_config_version_id =
                crate::host_ids::ProviderConfigVersionId::parse("another-config-version").unwrap();
        }
        let rejected = begin_prompt_text(
            &runtime,
            &target,
            opened.runtime_generation,
            "Must not send",
            &turn_id,
            &admitted,
        );
        assert!(matches!(rejected, Err(AcpDispatchError::NotSent(_))));
        assert!(
            !handle
                .lock()
                .unwrap()
                .transport
                .has_unresolved_work()
                .unwrap()
        );
        handle.lock().unwrap().managed_versions =
            vec![admitted.source().managed_binding().unwrap().clone()];
        let response = begin_prompt_text(
            &runtime,
            &target,
            opened.runtime_generation,
            "Accepted fixture",
            &turn_id,
            &admitted,
        )
        .unwrap()
        .wait_timeout(REQUEST_TIMEOUT)
        .unwrap();
        assert_eq!(response["stopReason"], "end_turn");
        runtime.stop_for_shutdown().unwrap();
    }

    #[test]
    fn adapter_preflight_rejection_releases_only_confirmed_not_sent_turns_without_provider_verification()
     {
        use crate::turn_coordinator::{
            HostNativeTurnSubmission, HostPiAcpTurnSubmitInput, TurnCoordinator,
            host_pi_acp_turn_submit_blocking,
        };
        for mode in ["preflight_not_sent", "preflight_unknown"] {
            let fixture = Fixture::new("http://127.0.0.1:1/v1");
            let runtime = PiAcpRuntime::default();
            let router = RuntimeEventRouter::default();
            let controller = crate::session_controller::HostSessionController::default();
            let turns = TurnCoordinator::default();
            let interactions = crate::interaction_registry::InteractionRegistry::default();
            let mut response = fixture.response();
            response["promptMode"] = json!(mode);
            let handle = fixture.start(&runtime, &router, response);
            let opened =
                open_native_session(&handle, &router, &fixture.store, None, "Preflight outcome")
                    .unwrap();
            let result = host_pi_acp_turn_submit_blocking(
                &controller,
                &fixture.store,
                &runtime,
                &router,
                &turns,
                &interactions,
                HostPiAcpTurnSubmitInput {
                    farfold_session_id: opened.farfold_session_id.clone(),
                    native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
                    runtime_generation: opened.runtime_generation,
                    text: "Preflight test".into(),
                },
            );
            if mode == "preflight_not_sent" {
                assert!(result.unwrap_err().contains("未发送"));
            } else {
                assert!(matches!(
                    result,
                    Ok(HostNativeTurnSubmission::Unknown { .. })
                ));
            }
            assert_eq!(
                turns
                    .has_active_session(&opened.farfold_session_id)
                    .unwrap(),
                mode == "preflight_unknown"
            );
            let db = rusqlite::Connection::open_with_flags(
                fixture.temp.path().join("host.sqlite3"),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            assert_eq!(
                db.query_row("SELECT COUNT(*) FROM turn_provider_bindings", [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert_eq!(db.query_row("SELECT COUNT(*) FROM provider_target_projections WHERE request_verified_version_id IS NOT NULL", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
            runtime.stop_for_shutdown().unwrap();
        }
    }

    #[test]
    fn prompt_capture_rejects_actual_model_or_idle_identity_drift_before_admission() {
        use crate::turn_coordinator::{
            HostPiAcpTurnSubmitInput, TurnCoordinator, host_pi_acp_turn_submit_blocking,
        };
        for state_override in [
            json!({"model":null}),
            json!({"model":{"provider":"native-provider","id":"native-model"}}),
            json!({"model":{"provider":"farfold-managed-unmatched","id":"model"}}),
            json!({"model":{"provider":"ambiguous/provider","id":"model"}}),
            json!({"model":{"provider":"provider","id":""}}),
            json!({"sessionId":"other"}),
            json!({"sessionFile":"/other/native.jsonl"}),
            json!({"sessionFile":null}),
            json!({"isStreaming":true}),
            json!({"isCompacting":true}),
            json!({"pendingMessageCount":1}),
            json!({"isStreaming":null}),
        ] {
            let fixture = Fixture::new("http://127.0.0.1:1/v1");
            let runtime = PiAcpRuntime::default();
            let router = RuntimeEventRouter::default();
            let controller = crate::session_controller::HostSessionController::default();
            let turns = TurnCoordinator::default();
            let interactions = crate::interaction_registry::InteractionRegistry::default();
            let mut response = fixture.response();
            response["stateOverride"] = state_override.clone();
            let handle = fixture.start(&runtime, &router, response);
            let opened =
                open_native_session(&handle, &router, &fixture.store, None, "Capture rejection")
                    .unwrap();
            let result = host_pi_acp_turn_submit_blocking(
                &controller,
                &fixture.store,
                &runtime,
                &router,
                &turns,
                &interactions,
                HostPiAcpTurnSubmitInput {
                    farfold_session_id: opened.farfold_session_id.clone(),
                    native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
                    runtime_generation: opened.runtime_generation,
                    text: "Must not reach native prompt".into(),
                },
            );
            assert!(result.is_err(), "accepted {state_override}");
            assert!(
                !turns
                    .has_active_session(&opened.farfold_session_id)
                    .unwrap()
            );
            let transport = handle.lock().unwrap().transport.clone();
            assert_eq!(
                transport
                    .request("fixture/prompt_calls", json!({}))
                    .unwrap(),
                json!(0)
            );
            let db = rusqlite::Connection::open_with_flags(
                fixture.temp.path().join("host.sqlite3"),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            assert_eq!(
                db.query_row("SELECT COUNT(*) FROM turn_provider_bindings", [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            runtime.stop_for_shutdown().unwrap();
        }
    }

    #[test]
    fn prompt_observation_carries_real_read_time_and_rejects_other_identity_or_generation() {
        let fixture = Fixture::new("http://127.0.0.1:1/v1");
        let runtime = PiAcpRuntime::default();
        let router = RuntimeEventRouter::default();
        let handle = fixture.start(&runtime, &router, fixture.response());
        let opened =
            open_native_session(&handle, &router, &fixture.store, None, "Capture identity")
                .unwrap();
        let target = fixture
            .store
            .session_open_target(&opened.farfold_session_id)
            .unwrap();
        let before = crate::host_store::now_millis() as u64;
        let mut observation = capture_prompt_model(
            &runtime,
            &fixture.store,
            &router,
            &target,
            opened.runtime_generation,
        )
        .unwrap();
        assert!(observation.observed_at() >= before);
        assert!(observation.observed_at() <= crate::host_store::now_millis() as u64);
        assert_eq!(
            observation.source().managed_binding(),
            Some(&fixture.prepared.binding.clone().unwrap())
        );
        observation
            .verify_target(&target, opened.runtime_generation)
            .unwrap();
        assert!(
            observation
                .verify_target(&target, opened.runtime_generation + 1)
                .is_err()
        );
        for field in [
            "session",
            "native",
            "connection",
            "build",
            "adapter",
            "installation",
        ] {
            let mut other = target.clone();
            match field {
                "session" => other.farfold_session_id = FarfoldSessionId::parse("other").unwrap(),
                "native" => other.native_session_id = NativeSessionId::parse("other").unwrap(),
                "connection" => other.connection_id = ConnectionId::parse("other").unwrap(),
                "build" => {
                    other.runtime_build_id =
                        crate::host_ids::RuntimeBuildId::parse("other").unwrap()
                }
                "adapter" => other.adapter_id = crate::host_ids::AdapterId::parse("other").unwrap(),
                _ => {
                    other.installation_id = crate::host_ids::InstallationId::parse("other").unwrap()
                }
            }
            assert!(
                observation
                    .verify_target(&other, opened.runtime_generation)
                    .is_err(),
                "{field}"
            );
        }
        observation.observed_at = u64::MAX;
        assert!(matches!(
            begin_prompt_text(
                &runtime,
                &target,
                opened.runtime_generation,
                "No future read",
                &HostTurnId::parse("future-read").unwrap(),
                &observation
            ),
            Err(AcpDispatchError::NotSent(_))
        ));
        runtime.stop_for_shutdown().unwrap();
    }

    #[test]
    fn held_prompt_capture_does_not_hold_controller_or_admit_a_late_generation() {
        use crate::turn_coordinator::{
            HostPiAcpTurnSubmitInput, TurnCoordinator, host_pi_acp_turn_submit_blocking,
        };
        let fixture = Fixture::new("http://127.0.0.1:1/v1");
        let runtime = PiAcpRuntime::default();
        let router = RuntimeEventRouter::default();
        let controller = crate::session_controller::HostSessionController::default();
        let turns = TurnCoordinator::default();
        let interactions = crate::interaction_registry::InteractionRegistry::default();
        let mut response = fixture.response();
        response["holdFirstState"] = json!(true);
        let handle = fixture.start(&runtime, &router, response);
        let opened =
            open_native_session(&handle, &router, &fixture.store, None, "Held capture").unwrap();
        let transport = handle.lock().unwrap().transport.clone();
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                host_pi_acp_turn_submit_blocking(
                    &controller,
                    &fixture.store,
                    &runtime,
                    &router,
                    &turns,
                    &interactions,
                    HostPiAcpTurnSubmitInput {
                        farfold_session_id: opened.farfold_session_id.clone(),
                        native_session_id: NativeSessionId::parse(&opened.native_session_id)
                            .unwrap(),
                        runtime_generation: opened.runtime_generation,
                        text: "Late capture must not send".into(),
                    },
                )
            });
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            while transport
                .request("fixture/read_pending", json!({}))
                .unwrap()["pending"]
                != true
            {
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(1));
            }
            assert!(
                !turns
                    .has_active_session(&opened.farfold_session_id)
                    .unwrap()
            );
            controller
                .exclusive(|| {
                    handle.lock().unwrap().generation += 1;
                    Ok(())
                })
                .unwrap();
            transport
                .request("fixture/release_read", json!({}))
                .unwrap();
            assert!(worker.join().unwrap().is_err());
        });
        assert_eq!(
            transport
                .request("fixture/prompt_calls", json!({}))
                .unwrap(),
            json!(0)
        );
        assert!(
            !turns
                .has_active_session(&opened.farfold_session_id)
                .unwrap()
        );
        runtime.stop_for_shutdown().unwrap();
    }

    #[test]
    fn managed_version_apply_refreshes_and_selects_without_replacing_session_or_verifying_request()
    {
        let mut fixture = Fixture::stable("http://127.0.0.1:1/v1");
        let runtime = PiAcpRuntime::default();
        let router = RuntimeEventRouter::default();
        let controller = crate::session_controller::HostSessionController::default();
        let turns = crate::turn_coordinator::TurnCoordinator::default();
        let mut response = fixture.response();
        response["autoConfig"] = json!(true);
        response["emitConfigUpdate"] = json!(true);
        let handle = fixture.start(&runtime, &router, response);
        let opened =
            open_native_session(&handle, &router, &fixture.store, None, "Version apply").unwrap();
        let root = fixture.temp.path().canonicalize().unwrap();
        let selected = crate::acp_provider_profile::tests::save_fixture(
            &root,
            &fixture.store,
            "http://127.0.0.1:1/v1",
            "openai-chat-completions",
            "second-synthetic-key",
        );
        let input = PiAcpApplyProviderInput {
            farfold_session_id: opened.farfold_session_id.clone(),
            native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
            runtime_generation: opened.runtime_generation,
            provider: selected.clone(),
        };
        let original_config = fs::read(fixture.prepared.config_root.join("models.json")).unwrap();
        for mismatch in ["generation", "session"] {
            let mut stale = input.clone();
            if mismatch == "generation" {
                stale.runtime_generation += 1;
            } else {
                stale.native_session_id = NativeSessionId::parse("wrong-native").unwrap();
            }
            assert!(
                apply_provider(
                    &controller,
                    &runtime,
                    &fixture.store,
                    &router,
                    &turns,
                    &root,
                    stale
                )
                .is_err()
            );
            assert_eq!(
                fs::read(fixture.prepared.config_root.join("models.json")).unwrap(),
                original_config
            );
            assert_eq!(
                fixture
                    .store
                    .runtime_profile_provider_versions(&fixture.binding)
                    .unwrap()
                    .len(),
                1
            );
        }
        let status = apply_provider(
            &controller,
            &runtime,
            &fixture.store,
            &router,
            &turns,
            &root,
            input,
        )
        .unwrap();
        let actual = status.managed_provider.as_ref().unwrap();
        assert_eq!(
            actual.provider_config_version_id,
            selected.provider_config_version_id
        );
        assert_ne!(
            actual.runtime_provider_id,
            fixture
                .prepared
                .binding
                .clone()
                .unwrap()
                .runtime_provider_id
        );
        assert_eq!(status.native_session, Some(fixture.native()));
        assert_eq!(status.generation, opened.runtime_generation);
        assert_eq!(
            handle.lock().unwrap().managed_provider,
            fixture.prepared.binding
        );
        assert_eq!(handle.lock().unwrap().managed_versions.len(), 2);
        let snapshot = fixture
            .store
            .provider_projection_snapshot(&selected.provider_connection_id)
            .unwrap();
        let applied = snapshot
            .projections
            .iter()
            .find(|projection| projection.config_version_id == selected.provider_config_version_id)
            .unwrap();
        assert_eq!(applied.apply_state, ProviderApplyState::Applied);
        assert_eq!(applied.request_state, ProviderRequestState::NotRequested);
        assert!(applied.request_verified_version_id.is_none());
        let target = fixture
            .store
            .session_open_target(&opened.farfold_session_id)
            .unwrap();
        let observation = capture_prompt_model(
            &runtime,
            &fixture.store,
            &router,
            &target,
            opened.runtime_generation,
        )
        .unwrap();
        assert_eq!(observation.source().managed_binding(), Some(actual));
        let transport = handle.lock().unwrap().transport.clone();
        let counts = transport
            .request("fixture/config_status", json!({}))
            .unwrap();
        assert_eq!(counts["refreshes"], 1);
        assert_eq!(counts["configs"], 1);
        assert_eq!(
            transport
                .request("fixture/prompt_calls", json!({}))
                .unwrap(),
            0
        );
        runtime.stop_for_shutdown().unwrap();

        let native = fixture.native();
        fs::write(
            &native.session_file,
            json!({"type":"session","id":native.session_id,"cwd":native.cwd}).to_string(),
        )
        .unwrap();
        let profile = fixture
            .store
            .runtime_owned_profile(&fixture.binding)
            .unwrap()
            .unwrap();
        fixture.prepared = crate::acp_provider_profile::prepare_owned(
            &root,
            &root.join("pi-acp"),
            &fixture.store,
            &profile,
            false,
        )
        .unwrap();
        let mut response = fixture.response();
        response["configOptions"][0]["currentValue"] = json!(actual.runtime_model_id);
        let handle = fixture.start(&runtime, &router, response);
        let restored = open_native_session(
            &handle,
            &router,
            &fixture.store,
            Some(&native),
            "Version apply",
        )
        .unwrap();
        assert_eq!(restored.farfold_session_id, opened.farfold_session_id);
        assert_eq!(
            current_status(&runtime, &router)
                .unwrap()
                .managed_provider
                .as_ref(),
            Some(actual)
        );
        runtime.stop_for_shutdown().unwrap();
    }

    #[test]
    fn managed_version_apply_unknown_keeps_original_source_and_blocks_tasks_without_resend() {
        for mode in ["wrong-refresh", "malformed", "reject"] {
            let fixture = Fixture::stable("http://127.0.0.1:1/v1");
            let runtime = PiAcpRuntime::default();
            let router = RuntimeEventRouter::default();
            let controller = crate::session_controller::HostSessionController::default();
            let turns = crate::turn_coordinator::TurnCoordinator::default();
            let mut response = fixture.response();
            response["autoConfig"] = json!(true);
            response["emitConfigUpdate"] = json!(true);
            if mode == "wrong-refresh" {
                response["refreshMode"] = json!("wrong");
            } else {
                response["configMode"] = json!(mode);
            }
            let handle = fixture.start(&runtime, &router, response);
            let opened =
                open_native_session(&handle, &router, &fixture.store, None, "Unknown apply")
                    .unwrap();
            let original = &fixture.prepared.binding.clone().unwrap();
            fixture
                .store
                .record_provider_target_projection(&ProviderTargetProjectionInput {
                    provider_connection_id: original.provider_connection_id.clone(),
                    config_version_id: original.provider_config_version_id.clone(),
                    runtime_product_id: fixture.binding.product_id.clone(),
                    installation_id: fixture.binding.installation_id.clone(),
                    runtime_connection_id: fixture.binding.connection_id.clone(),
                    runtime_provider_id: original.runtime_provider_id.clone(),
                    runtime_model_id: original.runtime_model_id.clone(),
                    save_state: ProviderSaveState::Saved,
                    apply_state: ProviderApplyState::Applied,
                    request_state: ProviderRequestState::VerifiedSuccess,
                    request_verified_version_id: Some(original.provider_config_version_id.clone()),
                    active_task_policy: ProviderActiveTaskPolicy::CurrentTaskKeepsBoundConfig,
                    detail: None,
                })
                .unwrap();
            let verified_original = serde_json::to_value(
                fixture
                    .store
                    .provider_projection_snapshot(&original.provider_connection_id)
                    .unwrap(),
            )
            .unwrap();
            let root = fixture.temp.path().canonicalize().unwrap();
            let selected = crate::acp_provider_profile::tests::save_fixture(
                &root,
                &fixture.store,
                "http://127.0.0.1:2/v1",
                "openai-chat-completions",
                "second-synthetic-key",
            );
            assert_ne!(
                selected.provider_connection_id,
                original.provider_connection_id
            );
            let input = PiAcpApplyProviderInput {
                farfold_session_id: opened.farfold_session_id.clone(),
                native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
                runtime_generation: opened.runtime_generation,
                provider: selected.clone(),
            };
            let projection_before = serde_json::to_value(
                fixture
                    .store
                    .provider_projection_snapshot(&selected.provider_connection_id)
                    .unwrap(),
            )
            .unwrap();
            assert!(
                apply_provider(
                    &controller,
                    &runtime,
                    &fixture.store,
                    &router,
                    &turns,
                    &root,
                    input.clone()
                )
                .is_err()
            );
            assert!(handle.lock().unwrap().operations.is_config_pending());
            let status = current_status(&runtime, &router).unwrap();
            assert_eq!(status.configuration_state, PiConfigurationState::Unknown);
            assert!(status.managed_provider.is_none());
            assert!(status.model_source.is_none());
            assert_eq!(
                status
                    .last_confirmed_model_source
                    .as_ref()
                    .and_then(PiModelSource::managed_binding),
                Some(&fixture.prepared.binding.clone().unwrap())
            );
            assert!(status.last_error.is_some());
            assert_eq!(
                serde_json::to_value(
                    fixture
                        .store
                        .provider_projection_snapshot(&original.provider_connection_id)
                        .unwrap()
                )
                .unwrap(),
                verified_original
            );
            let target = fixture
                .store
                .session_open_target(&opened.farfold_session_id)
                .unwrap();
            assert!(
                capture_prompt_model(
                    &runtime,
                    &fixture.store,
                    &router,
                    &target,
                    opened.runtime_generation
                )
                .is_err()
            );
            assert!(
                apply_provider(
                    &controller,
                    &runtime,
                    &fixture.store,
                    &router,
                    &turns,
                    &root,
                    input
                )
                .is_err()
            );
            let transport = handle.lock().unwrap().transport.clone();
            let counts = transport
                .request("fixture/config_status", json!({}))
                .unwrap();
            assert_eq!(counts["refreshes"], 1);
            assert_eq!(
                counts["configs"],
                if mode == "wrong-refresh" { 0 } else { 1 }
            );
            assert_eq!(
                transport
                    .request("fixture/prompt_calls", json!({}))
                    .unwrap(),
                0
            );
            assert_eq!(
                serde_json::to_value(
                    fixture
                        .store
                        .provider_projection_snapshot(&selected.provider_connection_id)
                        .unwrap()
                )
                .unwrap(),
                projection_before
            );
            runtime
                .stop_idle_session(&router, &target, opened.runtime_generation)
                .unwrap();
        }
    }

    #[test]
    fn managed_version_apply_can_be_disconnected_while_select_is_pending() {
        let fixture = Fixture::stable("http://127.0.0.1:1/v1");
        let runtime = PiAcpRuntime::default();
        let router = RuntimeEventRouter::default();
        let controller = crate::session_controller::HostSessionController::default();
        let turns = crate::turn_coordinator::TurnCoordinator::default();
        let mut response = fixture.response();
        response["emitConfigUpdate"] = json!(true);
        response["holdFirstState"] = json!(true);
        let handle = fixture.start(&runtime, &router, response);
        let opened =
            open_native_session(&handle, &router, &fixture.store, None, "Held apply").unwrap();
        let root = fixture.temp.path().canonicalize().unwrap();
        let selected = crate::acp_provider_profile::tests::save_fixture(
            &root,
            &fixture.store,
            "http://127.0.0.1:2/v1",
            "openai-chat-completions",
            "second-synthetic-key",
        );
        let input = PiAcpApplyProviderInput {
            farfold_session_id: opened.farfold_session_id.clone(),
            native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
            runtime_generation: opened.runtime_generation,
            provider: selected,
        };
        let target = fixture
            .store
            .session_open_target(&opened.farfold_session_id)
            .unwrap();
        let transport = handle.lock().unwrap().transport.clone();
        let held_read = transport
            .begin_request_unbounded(
                "_pi/workspace",
                json!({"sessionId":opened.native_session_id,"section":"state"}),
            )
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while transport
            .request("fixture/read_pending", json!({}))
            .unwrap()["pending"]
            != true
        {
            assert!(std::time::Instant::now() < deadline);
        }
        let rejected = apply_provider(
            &controller,
            &runtime,
            &fixture.store,
            &router,
            &turns,
            &root,
            input.clone(),
        )
        .unwrap_err();
        assert!(rejected.contains("ACP 仍有活动或未确认请求"));
        assert!(!handle.lock().unwrap().operations.is_pending());
        transport
            .request("fixture/release_read", json!({}))
            .unwrap();
        held_read.wait_timeout(REQUEST_TIMEOUT).unwrap();
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                apply_provider(
                    &controller,
                    &runtime,
                    &fixture.store,
                    &router,
                    &turns,
                    &root,
                    input,
                )
            });
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            // Do not let fixture polling create unresolved work before admission.
            while !handle.lock().unwrap().operations.is_config_pending() {
                if worker.is_finished() {
                    panic!(
                        "apply returned before configuration admission: {:?}",
                        worker.join().unwrap()
                    );
                }
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(1));
            }
            while transport
                .request("fixture/config_status", json!({}))
                .unwrap()["held"]
                != true
            {
                assert!(
                    !worker.is_finished(),
                    "apply must reach held native selection"
                );
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(1));
            }
            let status = current_status(&runtime, &router).unwrap();
            assert_eq!(status.configuration_state, PiConfigurationState::Changing);
            assert!(status.model_source.is_none());
            assert_eq!(
                status
                    .last_confirmed_model_source
                    .as_ref()
                    .and_then(PiModelSource::managed_binding),
                Some(&fixture.prepared.binding.clone().unwrap())
            );
            assert!(verify_prompt_target(&runtime, &target, opened.runtime_generation).is_err());
            controller
                .exclusive(|| {
                    runtime.stop_idle_session(&router, &target, opened.runtime_generation)
                })
                .unwrap();
            assert!(worker.join().unwrap().is_err());
        });
        assert!(runtime.is_stopped().unwrap());
        assert!(!transport.is_running().unwrap());
        assert!(
            !turns
                .has_active_session(&opened.farfold_session_id)
                .unwrap()
        );
    }

    #[test]
    fn model_source_distinguishes_exact_managed_version_from_native_observation() {
        let fixture = Fixture::new("http://127.0.0.1:1/v1");
        let managed = &fixture.prepared.binding.clone().unwrap();
        let options =
            |selector: &str| json!([{"id":"model","type":"select","currentValue":selector}]);
        let bindings = std::slice::from_ref(managed);
        let source = observed_model_source(&options(&managed.runtime_model_id), bindings).unwrap();
        assert_eq!(source.managed_binding(), Some(managed));
        let mut second = managed.clone();
        second.provider_config_version_id =
            crate::host_ids::ProviderConfigVersionId::parse("second-version").unwrap();
        second.runtime_provider_id = "farfold-managed-second".into();
        second.runtime_model_id = format!("{}/fixture-only", second.runtime_provider_id);
        let versions = vec![managed.clone(), second.clone()];
        let second_source =
            observed_model_source(&options(&second.runtime_model_id), &versions).unwrap();
        assert_eq!(second_source.managed_binding(), Some(&second));
        assert!(observed_model_source(&options(&second.runtime_model_id), bindings).is_err());
        assert!(
            observed_model_source(&options("farfold-managed-second/unbound"), &versions).is_err()
        );
        let native =
            observed_model_source(&options("native-provider/native-model"), bindings).unwrap();
        assert!(native.managed_binding().is_none());
        assert_eq!(
            serde_json::to_value(&native).unwrap(),
            json!({
            "kind":"native_observation", "runtimeProviderId":"native-provider", "runtimeModelId":"native-provider/native-model", "nativeModelId":"native-model"
            })
        );
        for selector in [
            String::new(),
            "missing-provider".into(),
            "/missing-provider".into(),
            "missing-model/".into(),
            format!("{}/unbound-model", managed.runtime_provider_id),
            "farfold-managed-unknown/unbound-model".into(),
            format!("{}/model", "p".repeat(201)),
            format!("provider/{}", "m".repeat(513)),
        ] {
            assert!(observed_model_source(&options(&selector), bindings).is_err());
        }
        assert!(observed_model_source(&json!([]), bindings).is_err());
    }

    #[test]
    fn explicit_native_selection_binds_turn_source_without_managed_verification() {
        use crate::turn_coordinator::{
            HostNativeTurnSubmission, HostPiAcpTurnSubmitInput, TurnCoordinator,
            host_pi_acp_turn_submit_blocking,
        };
        for mode in ["success", "mismatch", "malformed", "reject"] {
            let fixture = Fixture::stable("http://127.0.0.1:1/v1");
            let runtime = PiAcpRuntime::default();
            let turns = TurnCoordinator::default();
            turns.attach_host_store(fixture.store.clone()).unwrap();
            let router = RuntimeEventRouter::with_capacity_and_all_observers(
                128,
                None,
                None,
                Some(turns.clone()),
            );
            let controller = crate::session_controller::HostSessionController::default();
            let mut response = fixture.response();
            response["autoConfig"] = json!(true);
            response["emitReceipt"] = json!(true);
            response["configMode"] = json!(mode);
            response["configOptions"][0]["options"]
                .as_array_mut()
                .unwrap()
                .push(json!({"value":"native-provider/native-model","name":"Native model"}));
            if mode == "mismatch" {
                response["stateOverride"] =
                    json!({"model":{"provider":"different-provider","id":"native-model"}});
            }
            let handle = fixture.start(&runtime, &router, response);
            let opened =
                open_native_session(&handle, &router, &fixture.store, None, "Native selection")
                    .unwrap();
            let original = serde_json::to_value(
                fixture
                    .store
                    .provider_projection_snapshot(&fixture.selection.provider_connection_id)
                    .unwrap(),
            )
            .unwrap();
            let selected = set_config_option(
                &controller,
                &runtime,
                &fixture.store,
                &router,
                &turns,
                PiAcpConfigInput {
                    farfold_session_id: opened.farfold_session_id.clone(),
                    native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
                    runtime_generation: opened.runtime_generation,
                    config_id: PiAcpConfigId::Model,
                    value: "native-provider/native-model".into(),
                },
            );
            let target = fixture
                .store
                .session_open_target(&opened.farfold_session_id)
                .unwrap();
            let db = rusqlite::Connection::open_with_flags(
                fixture.temp.path().join("host.sqlite3"),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            if mode == "success" {
                let selected = selected.unwrap();
                assert!(selected.native_admission_ready);
                assert!(selected.managed_provider.is_none());
                let task = host_pi_acp_turn_submit_blocking(
                    &controller,
                    &fixture.store,
                    &runtime,
                    &router,
                    &turns,
                    &crate::interaction_registry::InteractionRegistry::default(),
                    HostPiAcpTurnSubmitInput {
                        farfold_session_id: opened.farfold_session_id.clone(),
                        native_session_id: target.native_session_id.clone(),
                        runtime_generation: opened.runtime_generation,
                        text: "Native source fixture".into(),
                    },
                )
                .unwrap();
                let HostNativeTurnSubmission::Accepted { submission } = task else {
                    panic!("native task was not accepted")
                };
                let observed: Value = db.query_row("SELECT source_kind, provider_connection_id, provider_config_version_id,
                    farfold_session_id, native_session_id, runtime_product_id, installation_id, runtime_connection_id,
                    runtime_build_id, adapter_id, runtime_generation, runtime_provider_id, runtime_model_id, native_model_id,
                    observed_at, bound_at FROM turn_provider_bindings WHERE host_turn_id = ?1", [submission.turn_id.as_str()], |row| {
                    Ok(json!({"kind":row.get::<_,String>(0)?,"provider":row.get::<_,Option<String>>(1)?,"version":row.get::<_,Option<String>>(2)?,
                        "host":row.get::<_,String>(3)?,"native":row.get::<_,String>(4)?,"product":row.get::<_,String>(5)?,
                        "installation":row.get::<_,String>(6)?,"connection":row.get::<_,String>(7)?,"build":row.get::<_,String>(8)?,
                        "adapter":row.get::<_,String>(9)?,"generation":row.get::<_,i64>(10)?,"runtimeProvider":row.get::<_,String>(11)?,
                        "runtimeModel":row.get::<_,String>(12)?,"nativeModel":row.get::<_,String>(13)?,
                        "observedAt":row.get::<_,i64>(14)?,"boundAt":row.get::<_,i64>(15)?}))
                }).unwrap();
                assert_eq!(observed["kind"], "native_observation");
                assert_eq!(observed["provider"], Value::Null);
                assert_eq!(observed["version"], Value::Null);
                assert_eq!(observed["host"], opened.farfold_session_id.as_str());
                assert_eq!(observed["native"], opened.native_session_id);
                assert_eq!(observed["product"], fixture.binding.product_id.as_str());
                assert_eq!(
                    observed["installation"],
                    fixture.binding.installation_id.as_str()
                );
                assert_eq!(
                    observed["connection"],
                    fixture.binding.connection_id.as_str()
                );
                assert_eq!(observed["build"], fixture.binding.runtime_build_id.as_str());
                assert_eq!(observed["adapter"], fixture.binding.adapter_id.as_str());
                assert_eq!(observed["generation"], opened.runtime_generation);
                assert_eq!(observed["runtimeProvider"], "native-provider");
                assert_eq!(observed["runtimeModel"], "native-provider/native-model");
                assert_eq!(observed["nativeModel"], "native-model");
                assert!(
                    observed["observedAt"].as_u64().unwrap()
                        <= observed["boundAt"].as_u64().unwrap()
                );
            } else {
                assert!(selected.is_err());
                let status = current_status(&runtime, &router).unwrap();
                assert!(!status.native_admission_ready);
                if mode != "reject" {
                    assert_eq!(status.configuration_state, PiConfigurationState::Unknown);
                    assert!(
                        verify_prompt_target(&runtime, &target, opened.runtime_generation).is_err()
                    );
                }
                assert_eq!(
                    db.query_row("SELECT COUNT(*) FROM turn_provider_bindings", [], |row| row
                        .get::<_, i64>(0))
                        .unwrap(),
                    0
                );
                assert_eq!(
                    handle
                        .lock()
                        .unwrap()
                        .transport
                        .request("fixture/prompt_calls", json!({}))
                        .unwrap(),
                    0
                );
            }
            assert_eq!(
                serde_json::to_value(
                    fixture
                        .store
                        .provider_projection_snapshot(&fixture.selection.provider_connection_id)
                        .unwrap()
                )
                .unwrap(),
                original
            );
            assert!(
                !turns
                    .has_active_session(&opened.farfold_session_id)
                    .unwrap()
            );
            runtime.stop_for_shutdown().unwrap();
        }
    }

    #[test]
    fn native_model_observation_cannot_reuse_bootstrap_provider_or_admit_a_source_less_turn() {
        let fixture = Fixture::new("http://127.0.0.1:1/v1");
        let runtime = PiAcpRuntime::default();
        let router = RuntimeEventRouter::default();
        let handle = fixture.start(&runtime, &router, fixture.response());
        let opened = open_native_session(
            &handle,
            &router,
            &fixture.store,
            None,
            "Model source fixture",
        )
        .unwrap();
        let target = fixture
            .store
            .session_open_target(&opened.farfold_session_id)
            .unwrap();
        let admitted = capture_prompt_model(
            &runtime,
            &fixture.store,
            &router,
            &target,
            opened.runtime_generation,
        )
        .unwrap();
        assert!(
            current_status(&runtime, &router)
                .unwrap()
                .managed_provider
                .is_some()
        );
        {
            let mut connection = handle.lock().unwrap();
            let option = connection
                .config_options
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|option| option["id"] == "model")
                .unwrap();
            option["currentValue"] = json!("native-provider/native-model");
        }
        let status = current_status(&runtime, &router).unwrap();
        assert!(status.managed_provider.is_none());
        assert!(matches!(
            status.model_source,
            Some(PiModelSource::NativeObservation { .. })
        ));
        assert!(verify_prompt_target(&runtime, &target, opened.runtime_generation).is_err());
        assert!(matches!(
            begin_prompt_text(
                &runtime,
                &target,
                opened.runtime_generation,
                "Must not send",
                &HostTurnId::parse("unbound-native-turn").unwrap(),
                &admitted
            ),
            Err(AcpDispatchError::NotSent(_))
        ));
        assert!(
            !handle
                .lock()
                .unwrap()
                .transport
                .has_unresolved_work()
                .unwrap()
        );
        verify_task_target(&runtime, &target, opened.runtime_generation).unwrap();
        runtime
            .stop_idle_session(&router, &target, opened.runtime_generation)
            .unwrap();
    }

    #[test]
    fn managed_profile_drift_blocks_prompt_and_provider_verification_but_not_stop() {
        let mut fixture = Fixture::new("http://127.0.0.1:1/v1");
        let profile = new_owned_profile(fixture.selection.clone()).unwrap();
        fixture.binding = profile.binding.clone();
        fixture.prepared = crate::acp_provider_profile::prepare_owned(
            fixture.temp.path(),
            &fixture.temp.path().join("pi-acp"),
            &fixture.store,
            &profile,
            true,
        )
        .unwrap();
        fixture
            .store
            .register_runtime_owned_profile(&runtime_registration(&fixture.binding, 1), &profile)
            .unwrap();
        let runtime = PiAcpRuntime::default();
        let router = RuntimeEventRouter::default();
        let handle = fixture.start(&runtime, &router, fixture.response());
        let opened =
            open_native_session(&handle, &router, &fixture.store, None, "Stable fixture").unwrap();
        let target = fixture
            .store
            .session_open_target(&opened.farfold_session_id)
            .unwrap();
        verify_prompt_target(&runtime, &target, opened.runtime_generation).unwrap();
        verify_provider_receipt_target(&runtime, &target, opened.runtime_generation).unwrap();
        let path = fixture.prepared.config_root.join("models.json");
        let original = fs::read(&path).unwrap();
        let mut config: Value = serde_json::from_slice(&original).unwrap();
        config["providers"][&fixture
            .prepared
            .binding
            .clone()
            .unwrap()
            .runtime_provider_id]["apiKey"] = json!("changed-fixture-secret");
        fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
        assert!(verify_prompt_target(&runtime, &target, opened.runtime_generation).is_err());
        assert!(
            verify_provider_receipt_target(&runtime, &target, opened.runtime_generation).is_err()
        );
        verify_task_target(&runtime, &target, opened.runtime_generation).unwrap();
        fs::write(&path, &original).unwrap();
        let auth = fixture.prepared.config_root.join("auth.json");
        fs::write(auth, serde_json::to_vec(&json!({fixture.prepared.binding.clone().unwrap().runtime_provider_id.clone():{"type":"api_key","key":"shadow-fixture-secret"}})).unwrap()).unwrap();
        assert!(verify_prompt_target(&runtime, &target, opened.runtime_generation).is_err());
        assert!(
            verify_provider_receipt_target(&runtime, &target, opened.runtime_generation).is_err()
        );
        assert!(
            !runtime
                .stop_idle_session(&router, &target, opened.runtime_generation)
                .unwrap()
                .running
        );
    }

    #[test]
    fn owned_profile_cleanup_preserves_registered_session_even_after_later_failure() {
        let mut fixture = Fixture::new("http://127.0.0.1:1/v1");
        let profile = new_owned_profile(fixture.selection.clone()).unwrap();
        fixture.binding = profile.binding.clone();
        fixture.prepared = crate::acp_provider_profile::prepare_owned(
            fixture.temp.path(),
            &fixture.temp.path().join("pi-acp"),
            &fixture.store,
            &profile,
            true,
        )
        .unwrap();
        fixture
            .store
            .register_runtime_owned_profile(&runtime_registration(&fixture.binding, 1), &profile)
            .unwrap();
        let runtime = PiAcpRuntime::default();
        let router = RuntimeEventRouter::default();
        let handle = fixture.start(&runtime, &router, fixture.response());
        let opened =
            open_native_session(&handle, &router, &fixture.store, None, "Stable fixture").unwrap();
        runtime.stop_for_shutdown().unwrap();
        assert!(
            !fixture
                .store
                .discard_unbound_owned_profile(&profile)
                .unwrap()
        );
        assert_eq!(
            fixture
                .store
                .session_open_target(&opened.farfold_session_id)
                .unwrap()
                .binding(),
            profile.binding
        );
        assert_eq!(
            saved_owned_profile(&fixture.store, &profile.binding)
                .unwrap()
                .profile_id,
            profile.profile_id
        );
    }

    #[test]
    fn owned_profile_missing_or_symlinked_directory_is_not_recreated_or_followed() {
        let fixture = Fixture::new("http://127.0.0.1:1/v1");
        let profile = new_owned_profile(fixture.selection.clone()).unwrap();
        let acp_root = fixture.temp.path().join("pi-acp");
        let root = acp_root.join("profiles").join(profile.profile_id.as_str());
        assert!(
            crate::acp_provider_profile::prepare_owned(
                fixture.temp.path(),
                &acp_root,
                &fixture.store,
                &profile,
                false
            )
            .is_err()
        );
        assert!(!root.exists());
        std::os::unix::fs::symlink(&fixture.prepared.profile_root, &root).unwrap();
        assert!(
            crate::acp_provider_profile::prepare_owned(
                fixture.temp.path(),
                &acp_root,
                &fixture.store,
                &profile,
                false
            )
            .is_err()
        );
        assert!(
            crate::acp_provider_profile::prepare_owned(
                fixture.temp.path(),
                &acp_root,
                &fixture.store,
                &profile,
                true
            )
            .is_err()
        );
    }

    #[test]
    fn owned_profile_corrupt_existing_reference_never_falls_back_to_provider_search() {
        let fixture = Fixture::new("http://127.0.0.1:1/v1");
        let legacy = saved_owned_profile(&fixture.store, &fixture.binding).unwrap();
        fixture
            .store
            .register_runtime_owned_profile(&runtime_registration(&fixture.binding, 1), &legacy)
            .unwrap();
        let db = rusqlite::Connection::open(fixture.temp.path().join("host.sqlite3")).unwrap();
        db.execute(
            "UPDATE runtime_owned_profiles SET layout = 'stable_v1' WHERE connection_id = ?1",
            [fixture.binding.connection_id.as_str()],
        )
        .unwrap();
        assert!(
            saved_owned_profile(&fixture.store, &fixture.binding)
                .unwrap_err()
                .contains("bootstrap authorization is missing")
        );
        db.execute(
            "UPDATE runtime_owned_profiles SET profile_id = '../outside' WHERE connection_id = ?1",
            [fixture.binding.connection_id.as_str()],
        )
        .unwrap();
        assert!(saved_owned_profile(&fixture.store, &fixture.binding).is_err());
        let mut wrong_build = fixture.binding.clone();
        wrong_build.runtime_build_id =
            crate::host_ids::RuntimeBuildId::parse("wrong-build").unwrap();
        assert!(fixture.store.runtime_owned_profile(&wrong_build).is_err());
    }

    #[test]
    fn fixture_cold_load_keeps_registered_identity_and_exact_historical_provider_version() {
        let fixture = Fixture::new("http://127.0.0.1:1/v1");
        let runtime = PiAcpRuntime::default();
        let router = RuntimeEventRouter::default();
        let handle = fixture.start(&runtime, &router, fixture.response());
        let first =
            open_native_session(&handle, &router, &fixture.store, None, "Pi fixture").unwrap();
        let native = fixture.native();
        // A protocol fixture header, not evidence of real Agent history persistence.
        fs::write(
            &native.session_file,
            format!(
                "{}\n",
                json!({"type":"session","id":native.session_id,"cwd":native.cwd})
            ),
        )
        .unwrap();
        assert_eq!(
            register_observation(&fixture.store, &handle.lock().unwrap(), "Pi fixture").unwrap(),
            first.farfold_session_id
        );
        let target = fixture
            .store
            .session_open_target(&first.farfold_session_id)
            .unwrap();
        assert!(target.blockers().is_empty());
        runtime
            .stop_idle_session(&router, &target, first.runtime_generation)
            .unwrap();
        let second_selection = crate::acp_provider_profile::tests::save_fixture(
            fixture.temp.path(),
            &fixture.store,
            "http://127.0.0.1:2/v1",
            "openai-chat-completions",
            "changed-fixture-key",
        );
        assert_ne!(managed_binding(&second_selection).unwrap(), fixture.binding);
        let saved = saved_provider(&fixture.store, &target.binding()).unwrap();
        assert_eq!(
            saved.provider_config_version_id,
            fixture.selection.provider_config_version_id
        );
        let imported = saved_owned_profile(&fixture.store, &target.binding()).unwrap();
        assert_eq!(imported.layout, OwnedProfileLayout::LegacyProviderBoundV1);
        let files = crate::acp_provider_profile::prepare_owned(
            fixture.temp.path(),
            &fixture.temp.path().join("pi-acp"),
            &fixture.store,
            &imported,
            false,
        )
        .unwrap();
        assert_eq!(
            files.profile_root.canonicalize().unwrap(),
            fixture.prepared.profile_root.canonicalize().unwrap()
        );
        native_descriptor(
            &fixture.response(),
            Some(&native),
            &fixture.cwd,
            &files.profile_root.join("sessions"),
        )
        .unwrap();
        fixture
            .store
            .register_runtime_owned_profile(
                &runtime_registration(&fixture.binding, crate::host_store::now_millis()),
                &imported,
            )
            .unwrap();
        assert_eq!(
            saved_owned_profile(&fixture.store, &target.binding())
                .unwrap()
                .profile_id,
            imported.profile_id
        );
        let handle = fixture.start(&runtime, &router, fixture.response());
        let restored = open_native_session(
            &handle,
            &router,
            &fixture.store,
            Some(&native),
            &target.title,
        )
        .unwrap();
        assert_eq!(first.farfold_session_id, restored.farfold_session_id);
        assert_eq!(first.native_session_id, restored.native_session_id);
        assert!(restored.runtime_generation > first.runtime_generation);
        runtime.stop_for_shutdown().unwrap();
    }

    #[test]
    #[ignore = "fixed Pi/Node, isolated multi-version profile and one local simulated model request; no accounts"]
    fn fixed_pi_managed_version_apply_request_and_cold_restore() {
        use crate::turn_coordinator::{
            HostNativeTurnSubmission, HostPiAcpTurnSubmitInput, TurnCoordinator,
            host_pi_acp_turn_submit_blocking,
        };
        let server = crate::opencode_acp::tests::ChatFixtureServer::start();
        let endpoint = format!("http://127.0.0.1:{}/v1", server.port);
        let mut fixture = Fixture::stable(&endpoint);
        let root = fixture.temp.path().canonicalize().unwrap();
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let node = manifest.join("capability-bridge/runtime/node");
        let pi = manifest.join("resources/pi-runtime/pi");
        assert_eq!(file_sha256(&node).unwrap(), NODE_SHA256);
        crate::runtime_registry::verify_managed_binary_path(pi.clone(), PI_ACP_RUNTIME).unwrap();
        let runtime = PiAcpRuntime::default();
        let turns = TurnCoordinator::default();
        turns.attach_host_store(fixture.store.clone()).unwrap();
        let interactions = crate::interaction_registry::InteractionRegistry::default();
        let router = RuntimeEventRouter::with_capacity_and_all_observers(
            256,
            None,
            Some(interactions.clone()),
            Some(turns.clone()),
        );
        let controller = crate::session_controller::HostSessionController::default();
        let start = |prepared: &PreparedPiProfile| {
            let mut command = launch_command(
                &node,
                &manifest.join("pi-acp-adapter/dist/index.js"),
                &pi,
                &fixture.cwd,
                prepared,
                Some("ignore"),
            )
            .unwrap();
            start_connection(
                &runtime,
                &router,
                fixture.binding.clone(),
                &fixture.cwd,
                prepared,
                &mut command,
            )
            .unwrap()
        };
        let handle = start(&fixture.prepared);
        let opened = open_native_session(
            &handle,
            &router,
            &fixture.store,
            None,
            "Multi-version local fixture",
        )
        .unwrap();
        let original_native = handle.lock().unwrap().native.clone().unwrap();
        let selected = crate::acp_provider_profile::tests::save_fixture(
            &root,
            &fixture.store,
            &endpoint,
            "openai-chat-completions",
            "second-version-synthetic-key",
        );
        let outcome = apply_provider(
            &controller,
            &runtime,
            &fixture.store,
            &router,
            &turns,
            &root,
            PiAcpApplyProviderInput {
                farfold_session_id: opened.farfold_session_id.clone(),
                native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
                runtime_generation: opened.runtime_generation,
                provider: selected.clone(),
            },
        );
        if let Err(error) = &outcome {
            runtime.stop_for_shutdown().unwrap();
            panic!("fixed Pi managed apply: {error}");
        }
        let applied = outcome.unwrap();
        assert_eq!(applied.native_session.as_ref(), Some(&original_native));
        assert_eq!(applied.generation, opened.runtime_generation);
        assert_eq!(
            applied
                .managed_provider
                .as_ref()
                .unwrap()
                .provider_config_version_id,
            selected.provider_config_version_id
        );
        assert!(server.captured.lock().unwrap().is_empty());
        assert_eq!(
            fixture
                .store
                .provider_projection_snapshot(&selected.provider_connection_id)
                .unwrap()
                .projections[0]
                .request_state,
            ProviderRequestState::NotRequested
        );
        let task = host_pi_acp_turn_submit_blocking(
            &controller,
            &fixture.store,
            &runtime,
            &router,
            &turns,
            &interactions,
            HostPiAcpTurnSubmitInput {
                farfold_session_id: opened.farfold_session_id.clone(),
                native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
                runtime_generation: opened.runtime_generation,
                text: "Reply with ok only. Isolated local protocol test.".into(),
            },
        );
        if !matches!(task, Ok(HostNativeTurnSubmission::Accepted { .. })) {
            runtime.stop_for_shutdown().unwrap();
            panic!("fixed Pi version task: {task:?}");
        }
        let snapshot = fixture
            .store
            .provider_projection_snapshot(&selected.provider_connection_id)
            .unwrap();
        assert_eq!(
            snapshot.projections[0].request_verified_version_id.as_ref(),
            Some(&selected.provider_config_version_id)
        );
        let history = fs::read(&original_native.session_file).unwrap();
        {
            let requests = server.captured.lock().unwrap();
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].1, "Bearer second-version-synthetic-key");
            let roles = requests[0].2["messages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|message| message["role"].as_str().unwrap())
                .collect::<Vec<_>>();
            assert_eq!(roles, ["system", "user"]);
            assert!(!roles.contains(&"developer"));
        }
        runtime.stop_for_shutdown().unwrap();
        let profile = saved_owned_profile(&fixture.store, &fixture.binding).unwrap();
        fixture.prepared = crate::acp_provider_profile::prepare_owned(
            &root,
            &root.join("pi-acp"),
            &fixture.store,
            &profile,
            false,
        )
        .unwrap();
        let handle = start(&fixture.prepared);
        let restored = open_native_session(
            &handle,
            &router,
            &fixture.store,
            Some(&original_native),
            "Multi-version local fixture",
        );
        let status = current_status(&runtime, &router).unwrap();
        runtime.stop_for_shutdown().unwrap();
        let restored = restored.unwrap();
        assert_eq!(restored.farfold_session_id, opened.farfold_session_id);
        assert_eq!(status.managed_provider, applied.managed_provider);
        assert!(
            fs::read(&original_native.session_file)
                .unwrap()
                .starts_with(&history)
        );
        assert_eq!(server.captured.lock().unwrap().len(), 1);
    }

    #[test]
    #[ignore = "fixed Pi/SDK, isolated native model selection, one local simulated request and original cold restore"]
    fn fixed_pi_explicit_native_model_request_and_original_cold_restore() {
        use crate::turn_coordinator::{
            HostNativeTurnSubmission, HostPiAcpTurnSubmitInput, TurnCoordinator,
            host_pi_acp_turn_submit_blocking,
        };
        let server = crate::opencode_acp::tests::ChatFixtureServer::start();
        let mut fixture = Fixture::stable(&format!("http://127.0.0.1:{}/v1", server.port));
        let root = fixture.temp.path().canonicalize().unwrap();
        let profile = saved_owned_profile(&fixture.store, &fixture.binding).unwrap();
        let models_path = fixture.prepared.config_root.join("models.json");
        let mut models: Value = serde_json::from_slice(&fs::read(&models_path).unwrap()).unwrap();
        let mut native = models["providers"][&fixture
            .prepared
            .binding
            .clone()
            .unwrap()
            .runtime_provider_id]
            .clone();
        native["apiKey"] = json!("synthetic-native-model-key");
        models["providers"]["native-local-fixture"] = native;
        fs::write(&models_path, serde_json::to_vec(&models).unwrap()).unwrap();
        fixture.prepared = crate::acp_provider_profile::prepare_owned(
            &root,
            &root.join("pi-acp"),
            &fixture.store,
            &profile,
            false,
        )
        .unwrap();
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let node = manifest.join("resources/pi-capabilities/runtime/node");
        let pi = manifest.join("resources/pi-runtime/pi");
        let adapter = root.join("isolated-adapter/index.mjs");
        fs::create_dir_all(adapter.parent().unwrap()).unwrap();
        fs::copy(manifest.join("pi-acp-adapter/dist/index.js"), &adapter).unwrap();
        assert_eq!(file_sha256(&node).unwrap(), NODE_SHA256);
        crate::runtime_registry::verify_managed_binary_path(pi.clone(), PI_ACP_RUNTIME).unwrap();
        let runtime = PiAcpRuntime::default();
        let turns = TurnCoordinator::default();
        turns.attach_host_store(fixture.store.clone()).unwrap();
        let router = RuntimeEventRouter::with_capacity_and_all_observers(
            256,
            None,
            None,
            Some(turns.clone()),
        );
        let controller = crate::session_controller::HostSessionController::default();
        let start = |prepared: &PreparedPiProfile| {
            let mut command =
                launch_command(&node, &adapter, &pi, &fixture.cwd, prepared, Some("ignore"))?;
            start_connection(
                &runtime,
                &router,
                fixture.binding.clone(),
                &fixture.cwd,
                prepared,
                &mut command,
            )
        };
        let result = (|| -> Result<(), String> {
            let handle = start(&fixture.prepared)?;
            let opened = open_native_session(
                &handle,
                &router,
                &fixture.store,
                None,
                "Native model local fixture",
            )?;
            let original = handle.lock().unwrap().native.clone().unwrap();
            let projection = serde_json::to_value(
                fixture
                    .store
                    .provider_projection_snapshot(&fixture.selection.provider_connection_id)?,
            )
            .unwrap();
            let native_id = fixture
                .prepared
                .binding
                .as_ref()
                .unwrap()
                .runtime_model_id
                .split_once('/')
                .unwrap()
                .1;
            let selector = format!("native-local-fixture/{native_id}");
            let selected = set_config_option(
                &controller,
                &runtime,
                &fixture.store,
                &router,
                &turns,
                PiAcpConfigInput {
                    farfold_session_id: opened.farfold_session_id.clone(),
                    native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
                    runtime_generation: opened.runtime_generation,
                    config_id: PiAcpConfigId::Model,
                    value: selector.clone(),
                },
            )?;
            assert!(selected.native_admission_ready);
            assert!(selected.managed_provider.is_none());
            assert_eq!(selected.native_session.as_ref(), Some(&original));
            assert!(server.captured.lock().unwrap().is_empty());
            let task = host_pi_acp_turn_submit_blocking(
                &controller,
                &fixture.store,
                &runtime,
                &router,
                &turns,
                &crate::interaction_registry::InteractionRegistry::default(),
                HostPiAcpTurnSubmitInput {
                    farfold_session_id: opened.farfold_session_id.clone(),
                    native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
                    runtime_generation: opened.runtime_generation,
                    text: "Reply with ok only. Isolated local native source test.".into(),
                },
            )?;
            let HostNativeTurnSubmission::Accepted { submission } = task else {
                return Err(format!("native task outcome: {task:?}"));
            };
            let db = rusqlite::Connection::open_with_flags(
                root.join("host.sqlite3"),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            let source: (String, String, Option<String>) = db.query_row("SELECT source_kind, runtime_model_id, provider_config_version_id FROM turn_provider_bindings WHERE host_turn_id = ?1",
                [submission.turn_id.as_str()], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
            assert_eq!(source, ("native_observation".into(), selector, None));
            assert_eq!(
                serde_json::to_value(
                    fixture
                        .store
                        .provider_projection_snapshot(&fixture.selection.provider_connection_id)?
                )
                .unwrap(),
                projection
            );
            {
                let requests = server.captured.lock().unwrap();
                assert_eq!(requests.len(), 1);
                assert_eq!(requests[0].1, "Bearer synthetic-native-model-key");
            }
            let history = fs::read(&original.session_file).unwrap();
            runtime.stop_for_shutdown()?;
            let prepared = crate::acp_provider_profile::prepare_owned(
                &root,
                &root.join("pi-acp"),
                &fixture.store,
                &profile,
                false,
            )?;
            let handle = start(&prepared)?;
            let restored = open_native_session(
                &handle,
                &router,
                &fixture.store,
                Some(&original),
                "Native model local fixture",
            )?;
            let status = current_status(&runtime, &router)?;
            assert_eq!(restored.farfold_session_id, opened.farfold_session_id);
            assert_eq!(restored.native_session_id, opened.native_session_id);
            assert!(restored.runtime_generation > opened.runtime_generation);
            assert_eq!(status.model_source, selected.model_source);
            assert!(status.native_admission_ready);
            let target = fixture
                .store
                .session_open_target(&opened.farfold_session_id)?;
            let observation = capture_prompt_model(
                &runtime,
                &fixture.store,
                &router,
                &target,
                restored.runtime_generation,
            )?;
            assert_eq!(Some(observation.source()), status.model_source.as_ref());
            assert!(
                fs::read(&original.session_file)
                    .unwrap()
                    .starts_with(&history)
            );
            assert_eq!(server.captured.lock().unwrap().len(), 1);
            Ok(())
        })();
        runtime.stop_for_shutdown().unwrap();
        result.unwrap();
    }

    #[test]
    #[ignore = "fixed Pi/Node, isolated managed profile and local simulated HTTP model only; no account access"]
    fn fixed_pi_native_request_verifies_bound_provider_and_restores_persisted_history() {
        use crate::turn_coordinator::{
            HostNativeTurnSubmission, HostPiAcpTurnSubmitInput, TurnCoordinator,
            host_pi_acp_turn_submit_blocking,
        };
        let server = crate::opencode_acp::tests::ChatFixtureServer::start();
        let mut fixture = Fixture::new(&format!("http://127.0.0.1:{}/v1", server.port));
        let profile = new_owned_profile(fixture.selection.clone()).unwrap();
        fixture.binding = profile.binding.clone();
        fixture.prepared = crate::acp_provider_profile::prepare_owned(
            fixture.temp.path(),
            &fixture.temp.path().join("pi-acp"),
            &fixture.store,
            &profile,
            true,
        )
        .unwrap();
        fixture
            .store
            .register_runtime_owned_profile(
                &runtime_registration(&fixture.binding, crate::host_store::now_millis()),
                &profile,
            )
            .unwrap();
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let node = manifest.join("capability-bridge/runtime/node");
        let pi = manifest.join("resources/pi-runtime/pi");
        assert_eq!(file_sha256(&node).unwrap(), NODE_SHA256);
        crate::runtime_registry::verify_managed_binary_path(pi.clone(), PI_ACP_RUNTIME).unwrap();
        let runtime = PiAcpRuntime::default();
        let coordinator = TurnCoordinator::default();
        coordinator
            .attach_host_store(fixture.store.clone())
            .unwrap();
        let interactions = crate::interaction_registry::InteractionRegistry::default();
        let router = RuntimeEventRouter::with_capacity_and_all_observers(
            256,
            None,
            Some(interactions.clone()),
            Some(coordinator.clone()),
        );
        let start = || {
            let mut command = launch_command(
                &node,
                &manifest.join("pi-acp-adapter/dist/index.js"),
                &pi,
                &fixture.cwd,
                &fixture.prepared,
                Some("ignore"),
            )
            .unwrap();
            start_connection(
                &runtime,
                &router,
                fixture.binding.clone(),
                &fixture.cwd,
                &fixture.prepared,
                &mut command,
            )
            .unwrap()
        };
        let handle = start();
        let opened = open_native_session(
            &handle,
            &router,
            &fixture.store,
            None,
            "Pi local HTTP contract",
        )
        .unwrap();
        let native = handle.lock().unwrap().native.clone().unwrap();
        let wire = handle.lock().unwrap().transport.clone();
        let entries = || {
            wire.request_timeout(
                "_pi/workspace",
                json!({"sessionId":opened.native_session_id,"section":"entries"}),
                REQUEST_TIMEOUT,
            )
            .unwrap()["data"]
                .clone()
        };
        let before_rejected_prompt = entries();
        let rejected = wire.request_timeout(
            "session/prompt",
            json!({"sessionId":opened.native_session_id,"prompt":[{"type":"text","text":"This mismatched model must never run"}],
                "_meta":{"farfoldPi":{"hostTurnId":"fixed-native-preflight-rejection","expectedModel":{
                    "version":1,"sessionId":native.session_id,"sessionFile":native.session_file,
                    "provider":fixture.prepared.binding.clone().unwrap().runtime_provider_id,"modelId":"intentionally-different-model"}}}}),
            REQUEST_TIMEOUT,
        );
        assert!(
            matches!(rejected, Err(AcpDispatchError::Rejected {code:-32600, data:Some(ref data)}) if data["farfoldPiPromptNotSent"] == true)
        );
        assert_eq!(
            entries(),
            before_rejected_prompt,
            "rejected preflight must not add native history"
        );
        assert!(
            server.captured.lock().unwrap().is_empty(),
            "rejected preflight must not call the local model service"
        );
        let input = HostPiAcpTurnSubmitInput {
            farfold_session_id: opened.farfold_session_id.clone(),
            native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
            runtime_generation: opened.runtime_generation,
            text: "Reply with ok only. This is an isolated local protocol test.".into(),
        };
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let worker = {
            let runtime = runtime.clone();
            let store = fixture.store.clone();
            let router = router.clone();
            let coordinator = coordinator.clone();
            std::thread::spawn(move || {
                let result = host_pi_acp_turn_submit_blocking(
                    &crate::session_controller::HostSessionController::default(),
                    &store,
                    &runtime,
                    &router,
                    &coordinator,
                    &interactions,
                    input,
                );
                let _ = sender.send(result);
            })
        };
        let result = receiver.recv_timeout(Duration::from_secs(30));
        if result.is_err() {
            let _ = runtime.stop_for_shutdown();
        }
        worker.join().unwrap();
        let result = result.unwrap();
        if !matches!(result, Ok(HostNativeTurnSubmission::Accepted { .. })) {
            let _ = runtime.stop_for_shutdown();
            panic!("fixed Pi local HTTP task: {result:?}");
        }
        let projection = fixture
            .store
            .provider_projection_snapshot(&fixture.selection.provider_connection_id)
            .unwrap();
        assert_eq!(
            projection.projections[0].request_state,
            ProviderRequestState::VerifiedSuccess
        );
        assert_eq!(
            projection.projections[0].request_verified_version_id,
            Some(fixture.selection.provider_config_version_id.clone())
        );
        {
            let requests = server.captured.lock().unwrap();
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].0, "/v1/chat/completions");
            assert_eq!(requests[0].1, "Bearer fixture-not-a-credential");
            assert_eq!(requests[0].2["model"], "fixture-only");
        }
        let target = fixture
            .store
            .session_open_target(&opened.farfold_session_id)
            .unwrap();
        assert!(target.blockers().is_empty());
        assert!(native.session_file.is_file());
        let persisted_before_refresh = fs::read(&native.session_file).unwrap();
        let wire = handle.lock().unwrap().transport.clone();
        let refresh = wire
            .request(
                "_pi/refresh_profile",
                json!({"sessionId": opened.native_session_id}),
            )
            .unwrap();
        assert_eq!(refresh["version"], 1);
        assert_eq!(refresh["nativeSession"]["sessionId"], native.session_id);
        assert_eq!(
            fs::read(&native.session_file).unwrap(),
            persisted_before_refresh,
            "profile refresh must preserve persisted user and assistant history byte-for-byte"
        );
        assert_eq!(server.captured.lock().unwrap().len(), 1);
        runtime
            .stop_idle_session(&router, &target, opened.runtime_generation)
            .unwrap();
        let handle = start();
        let restored = open_native_session(
            &handle,
            &router,
            &fixture.store,
            Some(&native),
            &target.title,
        )
        .unwrap();
        let messages = read_workspace(
            &runtime,
            &fixture.store,
            &router,
            PiAcpWorkspaceInput {
                farfold_session_id: restored.farfold_session_id.clone(),
                native_session_id: NativeSessionId::parse(&restored.native_session_id).unwrap(),
                runtime_generation: restored.runtime_generation,
                section: PiWorkspaceSection::Messages,
            },
        )
        .unwrap();
        runtime.stop_for_shutdown().unwrap();
        assert_eq!(restored.farfold_session_id, opened.farfold_session_id);
        assert_eq!(restored.native_session_id, opened.native_session_id);
        assert!(restored.runtime_generation > opened.runtime_generation);
        assert!(
            messages["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|message| message["role"] == "assistant"
                    && message["content"]
                        .as_array()
                        .is_some_and(|content| content.iter().any(|block| block["text"] == "ok")))
        );
        assert_eq!(
            server.captured.lock().unwrap().len(),
            1,
            "cold load must not resend the task"
        );
        let original_history = fs::read(&native.session_file).unwrap();
        let mut changed_history = String::new();
        for line in std::str::from_utf8(&original_history).unwrap().lines() {
            let mut entry: Value = serde_json::from_str(line).unwrap();
            if entry["type"] == "model_change" {
                entry["provider"] = json!("missing-original-provider");
                entry["modelId"] = json!("missing-original-model");
            }
            if entry["type"] == "message" && entry["message"]["role"] == "assistant" {
                entry["message"]["provider"] = json!("missing-original-provider");
                entry["message"]["model"] = json!("missing-original-model");
            }
            changed_history.push_str(&serde_json::to_string(&entry).unwrap());
            changed_history.push('\n');
        }
        // Isolated synthetic history only: make the original model unavailable while a configured default remains.
        fs::write(&native.session_file, changed_history.as_bytes()).unwrap();
        let blocked = start();
        let failure = open_native_session(
            &blocked,
            &router,
            &fixture.store,
            Some(&native),
            &target.title,
        );
        assert!(
            failure
                .err()
                .is_some_and(|detail| detail.contains("未恢复原会话模型"))
        );
        assert_eq!(
            fs::read(&native.session_file).unwrap(),
            changed_history.as_bytes()
        );
        assert_eq!(server.captured.lock().unwrap().len(), 1);
        assert_eq!(
            fixture
                .store
                .session_open_target(&opened.farfold_session_id)
                .unwrap()
                .binding(),
            target.binding()
        );
        runtime.stop_for_shutdown().unwrap();
        fs::write(&native.session_file, &original_history).unwrap();
        let repaired = start();
        let recovered = open_native_session(
            &repaired,
            &router,
            &fixture.store,
            Some(&native),
            &target.title,
        )
        .unwrap();
        runtime.stop_for_shutdown().unwrap();
        assert_eq!(recovered.farfold_session_id, opened.farfold_session_id);
        assert_eq!(recovered.native_session_id, opened.native_session_id);
        assert_eq!(fs::read(&native.session_file).unwrap(), original_history);
        assert_eq!(
            server.captured.lock().unwrap().len(),
            1,
            "model recovery must not replay a task"
        );
    }

    #[test]
    #[ignore = "fixed Pi/SDK, isolated synthetic credentials and rejecting local endpoint; no model calls"]
    fn fixed_pi_empty_message_branch_cannot_replace_its_original_model_on_restore() {
        let server = crate::pi_acp_contract_tests::RejectModelServer::start();
        let fixture = Fixture::new(&server.endpoint);
        let native = fixture.native();
        let timestamp = "2026-09-13T00:00:00.000Z";
        let entries = [
            json!({"type":"session","version":3,"id":native.session_id,"cwd":fixture.cwd,"timestamp":timestamp}),
            json!({"type":"model_change","id":"root","parentId":null,"timestamp":timestamp,"provider":"missing-original-provider","modelId":"missing-original-model"}),
            json!({"type":"message","id":"other-branch","parentId":"root","timestamp":timestamp,"message":{"role":"assistant","provider":"missing-original-provider","model":"missing-original-model","api":"openai-completions","content":[{"type":"text","text":"Isolated fixture on a different branch"}],"stopReason":"stop","timestamp":0,"usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}}),
            json!({"type":"model_change","id":"empty-branch","parentId":"root","timestamp":timestamp,"provider":"missing-original-provider","modelId":"missing-original-model"}),
        ];
        let original = entries
            .iter()
            .map(|entry| serde_json::to_string(entry).unwrap() + "\n")
            .collect::<String>();
        fs::create_dir_all(native.session_file.parent().unwrap()).unwrap();
        fs::write(&native.session_file, original.as_bytes()).unwrap();
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let node = manifest.join("resources/pi-capabilities/runtime/node");
        let adapter = fixture.temp.path().join("isolated-adapter/index.mjs");
        fs::create_dir_all(adapter.parent().unwrap()).unwrap();
        fs::copy(manifest.join("pi-acp-adapter/dist/index.js"), &adapter).unwrap();
        let pi = manifest.join("resources/pi-runtime/pi");
        assert_eq!(file_sha256(&node).unwrap(), NODE_SHA256);
        crate::runtime_registry::verify_managed_binary_path(pi.clone(), PI_ACP_RUNTIME).unwrap();
        let runtime = PiAcpRuntime::default();
        let router = RuntimeEventRouter::default();
        let mut command = launch_command(
            &node,
            &adapter,
            &pi,
            &fixture.cwd,
            &fixture.prepared,
            Some("ignore"),
        )
        .unwrap();
        let handle = start_connection(
            &runtime,
            &router,
            fixture.binding.clone(),
            &fixture.cwd,
            &fixture.prepared,
            &mut command,
        )
        .unwrap();
        let result = open_native_session(
            &handle,
            &router,
            &fixture.store,
            Some(&native),
            "Empty branch restoration",
        );
        runtime.stop_for_shutdown().unwrap();
        assert!(
            result.is_err(),
            "empty-message branch was incorrectly accepted after native default-model replacement"
        );
        assert_eq!(
            fs::read(&native.session_file).unwrap(),
            original.as_bytes(),
            "failed restore must preserve the pre-launch native branch bytes"
        );
        assert_eq!(server.requests.load(Ordering::SeqCst), 0);

        // Recover the same synthetic empty branch after its original model is available.
        // No task is sent; the native runtime may append its normal startup settings.
        let managed = &fixture.prepared.binding.clone().unwrap();
        let (_, native_model_id) = managed.runtime_model_id.split_once('/').unwrap();
        let repaired = original
            .replace("missing-original-provider", &managed.runtime_provider_id)
            .replace("missing-original-model", native_model_id);
        fs::write(&native.session_file, repaired.as_bytes()).unwrap();
        let mut command = launch_command(
            &node,
            &adapter,
            &pi,
            &fixture.cwd,
            &fixture.prepared,
            Some("ignore"),
        )
        .unwrap();
        let handle = start_connection(
            &runtime,
            &router,
            fixture.binding.clone(),
            &fixture.cwd,
            &fixture.prepared,
            &mut command,
        )
        .unwrap();
        let recovered = open_native_session(
            &handle,
            &router,
            &fixture.store,
            Some(&native),
            "Recovered empty branch",
        );
        runtime.stop_for_shutdown().unwrap();
        assert_eq!(recovered.unwrap().native_session_id, native.session_id);
        assert!(
            fs::read(&native.session_file)
                .unwrap()
                .starts_with(repaired.as_bytes())
        );
        assert_eq!(server.requests.load(Ordering::SeqCst), 0);
    }

    #[test]
    #[ignore = "fixed Pi/SDK, empty owned profile, synthetic native login, local simulated request and cold recovery"]
    fn fixed_pi_empty_profile_authentication_does_not_require_managed_bootstrap() {
        let server = crate::opencode_acp::tests::ChatFixtureServer::start();
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let node = manifest.join("resources/pi-capabilities/runtime/node");
        let pi = manifest.join("resources/pi-runtime/pi");
        assert_eq!(file_sha256(&node).unwrap(), NODE_SHA256);
        crate::runtime_registry::verify_managed_binary_path(pi.clone(), PI_ACP_RUNTIME).unwrap();
        for path in [
            &root,
            &root.join("agent"),
            &root.join("sessions"),
            &root.join("home"),
            &root.join("tmp"),
            &root.join("project"),
        ] {
            protect_directory(path).unwrap();
        }
        let launch = || {
            let mut command = Command::new(&node);
            command
                .arg(manifest.join("pi-acp-adapter/dist/index.js"))
                .current_dir(root.join("project"))
                .env_clear()
                .env("HOME", root.join("home"))
                .env("PATH", launch_path(&node, None).unwrap())
                .env("TMPDIR", root.join("tmp"))
                .env("PI_CODING_AGENT_DIR", root.join("agent"))
                .env("PI_CODING_AGENT_SESSION_DIR", root.join("sessions"))
                .env("PI_ACP_PI_COMMAND", &pi)
                .env("FARFOLD_PI_PROJECT_TRUST", "ignore");
            crate::acp_runtime::initialize_transport(
                &mut command,
                &root.join("project"),
                json!({"elicitation":{"form":{}},"_meta":{"farfoldPi":{"version":1}}}),
                ADAPTER_VERSION,
                REQUEST_TIMEOUT,
            )
            .unwrap()
            .0
        };
        let wire = launch();
        let result = (|| -> Result<(String, PathBuf), String> {
            let session = wire
                .request_timeout(
                    "session/new",
                    json!({"cwd":root.join("project"),"mcpServers":[],
                "_meta":{"farfoldPi":{"allowUnauthenticated":true}}}),
                    REQUEST_TIMEOUT,
                )
                .map_err(|error| error.to_string())?;
            let id = session["sessionId"]
                .as_str()
                .ok_or("empty profile lost native identity")?;
            wire.bind_client_session(Some(id))?;
            assert_eq!(
                session["_meta"]["farfoldPi"]["modelSelectionRequired"],
                true
            );
            assert_eq!(
                session["_meta"]["farfoldPi"]["nativeFirstUse"]["phase"],
                "authentication_required"
            );
            assert!(selected_config(&session["configOptions"], "model").is_none());
            let workspace = |section: &str| {
                wire.request_timeout(
                    "_pi/workspace",
                    json!({"sessionId":id,"section":section}),
                    REQUEST_TIMEOUT,
                )
                .map_err(|error| format!("empty profile workspace {section}: {error}"))
            };
            let before = workspace("state")?;
            assert_eq!(before["data"]["isStreaming"], false);
            assert_eq!(before["data"]["pendingMessageCount"], 0);
            assert_eq!(workspace("models")?["data"]["models"], json!([]));
            let call = |mut value: Value| {
                value["sessionId"] = json!(id);
                wire.request_timeout("_pi/auth", value, REQUEST_TIMEOUT)
                    .map_err(|error| format!("empty profile authentication: {error}"))
            };
            let mut auth =
                call(json!({"action":"start","providerId":"anthropic","authType":"api_key"}))?;
            let flow = auth["flowId"].clone();
            let deadline = std::time::Instant::now() + REQUEST_TIMEOUT;
            while auth["prompt"].is_null()
                && auth["state"] == "running"
                && std::time::Instant::now() < deadline
            {
                std::thread::sleep(Duration::from_millis(20));
                auth = call(json!({"action":"status","flowId":flow}))?;
            }
            assert_eq!(auth["prompt"]["value"]["type"], "secret");
            auth = call(
                json!({"action":"reply","flowId":flow,"promptId":auth["prompt"]["id"],"value":"empty-profile-synthetic-key"}),
            )?;
            while auth["state"] == "running" && std::time::Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
                auth = call(json!({"action":"status","flowId":flow}))?;
            }
            assert_eq!(auth["state"], "succeeded");
            assert_eq!(
                workspace("state")?["nativeSession"],
                before["nativeSession"]
            );
            let pending_entries = workspace("entries")?;
            assert_eq!(
                pending_entries["data"]["entries"]
                    .as_array()
                    .and_then(|entries| entries.last())
                    .and_then(|entry| entry.pointer("/data/phase"))
                    .and_then(Value::as_str),
                Some("model_selection_required")
            );
            let available = workspace("models")?;
            let model = available["data"]["models"]
                .as_array()
                .ok_or("native models missing")?
                .iter()
                .find(|model| model["provider"] == "anthropic")
                .ok_or("native login did not refresh catalog")?;
            assert!(model["id"].is_string());
            let auth_file: Value =
                serde_json::from_slice(&fs::read(root.join("agent/auth.json")).unwrap()).unwrap();
            assert_eq!(auth_file.as_object().unwrap().len(), 1);
            assert_eq!(auth_file["anthropic"]["key"], "empty-profile-synthetic-key");
            assert!(!root.join("host.sqlite3").exists());
            assert!(!root.join("agent/models.json").exists());
            let (events, _) = wire.drain_events()?;
            assert!(!events.iter().any(|event| {
                event.pointer("/params/event/type").and_then(Value::as_str) == Some("agent_start")
            }));
            let session_file = PathBuf::from(
                session["_meta"]["farfoldPi"]["nativeSession"]["sessionFile"]
                    .as_str()
                    .ok_or("empty profile lost native session file")?,
            );
            Ok((id.to_string(), session_file))
        })();
        let stopped = wire.stop();
        let (id, session_file) = result.unwrap();
        stopped.unwrap();
        assert!(!session_file.exists());

        let selector = "native-local-first-use/fixture-only";
        fs::write(
            root.join("agent/models.json"),
            serde_json::to_vec(&json!({"providers":{"native-local-first-use":{
                "baseUrl":format!("http://127.0.0.1:{}/v1",server.port),
                "api":"openai-completions","apiKey":"native-first-use-synthetic-key",
                "compat":{"supportsDeveloperRole":true,"supportsReasoningEffort":false},
                "models":[{"id":"fixture-only","name":"Fixture only","contextWindow":8192,
                    "maxTokens":1024,"reasoning":false,"input":["text"]}]
            }}}))
            .unwrap(),
        )
        .unwrap();

        let wire = launch();
        let pending = wire
            .request_timeout(
                "session/load",
                json!({"sessionId":id,"cwd":root.join("project"),"mcpServers":[]}),
                REQUEST_TIMEOUT,
            )
            .unwrap();
        wire.bind_client_session(Some(&id)).unwrap();
        assert_eq!(
            pending["_meta"]["farfoldPi"]["nativeFirstUse"]["phase"],
            "model_selection_required"
        );
        assert!(
            wire.request_timeout(
                "session/prompt",
                json!({"sessionId":id,"prompt":[{"type":"text","text":"must not call a model"}]}),
                REQUEST_TIMEOUT,
            )
            .is_err()
        );
        let selected = wire
            .request_timeout(
                "session/set_config_option",
                json!({"sessionId":id,"configId":"model","value":selector}),
                REQUEST_TIMEOUT,
            )
            .unwrap();
        assert_eq!(
            selected_config(&selected["configOptions"], "model"),
            Some(selector)
        );
        assert_eq!(
            selected["_meta"]["farfoldPi"]["nativeFirstUse"]["phase"],
            "ready"
        );
        let task = wire
            .request_timeout(
                "session/prompt",
                json!({"sessionId":id,"prompt":[{"type":"text","text":"Reply with ok only. Local native first-use test."}]}),
                REQUEST_TIMEOUT,
            )
            .unwrap();
        assert_eq!(task["stopReason"], "end_turn");
        {
            let requests = server.captured.lock().unwrap();
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].0, "/v1/chat/completions");
            assert_eq!(requests[0].1, "Bearer native-first-use-synthetic-key");
            assert_eq!(requests[0].2["model"], "fixture-only");
        }
        wire.stop().unwrap();

        let wire = launch();
        let restored = wire
            .request_timeout(
                "session/load",
                json!({"sessionId":id,"cwd":root.join("project"),"mcpServers":[]}),
                REQUEST_TIMEOUT,
            )
            .unwrap();
        assert_eq!(
            restored["_meta"]["farfoldPi"]["nativeSession"]["sessionId"],
            id
        );
        assert_eq!(
            restored["_meta"]["farfoldPi"]["nativeFirstUse"]["phase"],
            "ready"
        );
        assert_eq!(
            selected_config(&restored["configOptions"], "model"),
            Some(selector)
        );
        wire.stop().unwrap();
        assert!(!root.join("host.sqlite3").exists());
        assert_eq!(server.captured.lock().unwrap().len(), 1);
    }

    #[test]
    #[ignore = "fixed Pi/SDK with isolated synthetic native credential, same-process refresh and zero model calls"]
    fn fixed_pi_native_authentication_preserves_session_model_and_provider_evidence() {
        let server = crate::pi_acp_contract_tests::RejectModelServer::start();
        let fixture = Fixture::stable(&server.endpoint);
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let node = manifest.join("capability-bridge/runtime/node");
        let pi = manifest.join("resources/pi-runtime/pi");
        assert_eq!(file_sha256(&node).unwrap(), NODE_SHA256);
        crate::runtime_registry::verify_managed_binary_path(pi.clone(), PI_ACP_RUNTIME).unwrap();
        let runtime = PiAcpRuntime::default();
        let router = RuntimeEventRouter::default();
        let controller = crate::session_controller::HostSessionController::default();
        let turns = crate::turn_coordinator::TurnCoordinator::default();
        let mut command = launch_command(
            &node,
            &manifest.join("pi-acp-adapter/dist/index.js"),
            &pi,
            &fixture.cwd,
            &fixture.prepared,
            Some("ignore"),
        )
        .unwrap();
        let handle = start_connection(
            &runtime,
            &router,
            fixture.binding.clone(),
            &fixture.cwd,
            &fixture.prepared,
            &mut command,
        )
        .unwrap();
        let result = (|| -> Result<(), String> {
            let opened = open_native_session(
                &handle,
                &router,
                &fixture.store,
                None,
                "Synthetic native auth",
            )?;
            let target = fixture
                .store
                .session_open_target(&opened.farfold_session_id)?;
            let before = current_status(&runtime, &router)?;
            let projection = serde_json::to_value(
                fixture
                    .store
                    .provider_projection_snapshot(&fixture.selection.provider_connection_id)?,
            )
            .unwrap();
            let workspace = |section| {
                read_workspace_snapshot(
                    &runtime,
                    &fixture.store,
                    &router,
                    PiAcpWorkspaceInput {
                        farfold_session_id: opened.farfold_session_id.clone(),
                        native_session_id: target.native_session_id.clone(),
                        runtime_generation: opened.runtime_generation,
                        section,
                    },
                )
            };
            let entries = workspace(PiWorkspaceSection::Entries)?;
            let catalog = workspace(PiWorkspaceSection::AuthCatalog)?;
            assert!(
                catalog["providers"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|provider| provider["id"] == "anthropic")
            );
            assert!(!catalog.to_string().contains("farfold-managed-"));
            let call = |command: Value| -> Result<Value, String> {
                let snapshot = native_auth::authenticate(&controller, &runtime, &fixture.store, &router, &turns,
                    serde_json::from_value(json!({"farfoldSessionId":opened.farfold_session_id,"nativeSessionId":opened.native_session_id,
                        "runtimeGeneration":opened.runtime_generation,"command":command})).unwrap())?;
                Ok(serde_json::to_value(snapshot).unwrap())
            };
            let mut auth =
                call(json!({"action":"start","providerId":"anthropic","authType":"api_key"}))?;
            let flow_id = auth["flowId"].clone();
            let deadline = std::time::Instant::now() + REQUEST_TIMEOUT;
            while auth["prompt"].is_null()
                && auth["state"] == "running"
                && std::time::Instant::now() < deadline
            {
                std::thread::sleep(Duration::from_millis(20));
                auth = call(json!({"action":"status","flowId":flow_id}))?;
            }
            if auth["prompt"]["value"]["type"] != "secret" {
                return Err("fixed Pi did not expose its native key prompt".into());
            }
            assert!(
                verify_prompt_connection(
                    &handle.lock().unwrap(),
                    &target,
                    opened.runtime_generation
                )
                .is_err()
            );
            auth = call(
                json!({"action":"reply","flowId":flow_id,"promptId":auth["prompt"]["id"],"value":"synthetic-native-auth-key"}),
            )?;
            while auth["state"] == "running" && std::time::Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
                auth = call(json!({"action":"status","flowId":flow_id}))?;
            }
            if auth["state"] != "succeeded" {
                return Err(format!(
                    "fixed Pi native auth state: {} / {} / {}",
                    auth["state"], auth["credentialState"], auth["refreshState"]
                ));
            }
            assert_eq!(auth["credentialState"], "committed");
            assert_eq!(auth["refreshState"], "confirmed");
            assert!(!auth.to_string().contains("synthetic-native-auth-key"));
            let stored: Value = serde_json::from_slice(
                &fs::read(fixture.prepared.config_root.join("auth.json")).unwrap(),
            )
            .unwrap();
            assert_eq!(stored["anthropic"]["key"], "synthetic-native-auth-key");
            assert_eq!(stored.as_object().unwrap().len(), 1);
            let available = current_status(&runtime, &router)?.config_options;
            assert!(
                available
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|option| option["id"] == "model"
                        && option["options"].as_array().unwrap().iter().any(|model| {
                            model["value"]
                                .as_str()
                                .is_some_and(|id| id.starts_with("anthropic/"))
                        }))
            );
            let mut logout = call(
                json!({"action":"start","operation":"logout","providerId":"anthropic","authType":"api_key"}),
            )?;
            let logout_id = logout["flowId"].clone();
            let deadline = std::time::Instant::now() + REQUEST_TIMEOUT;
            while logout["state"] == "running" && std::time::Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
                logout = call(json!({"action":"status","flowId":logout_id}))?;
            }
            if logout["state"] != "succeeded" || logout["operation"] != "logout" {
                return Err("fixed Pi native logout was not confirmed".into());
            }
            let stored: Value = serde_json::from_slice(
                &fs::read(fixture.prepared.config_root.join("auth.json")).unwrap(),
            )
            .unwrap();
            assert!(stored.get("anthropic").is_none());
            assert_eq!(workspace(PiWorkspaceSection::Entries)?, entries);
            let after = current_status(&runtime, &router)?;
            assert_eq!(after.native_session, before.native_session);
            assert_eq!(after.model_source, before.model_source);
            assert_eq!(after.generation, before.generation);
            assert_eq!(
                serde_json::to_value(
                    fixture
                        .store
                        .provider_projection_snapshot(&fixture.selection.provider_connection_id)?
                )
                .unwrap(),
                projection
            );
            Ok(())
        })();
        runtime.stop_for_shutdown().unwrap();
        assert_eq!(server.requests.load(Ordering::SeqCst), 0);
        result.unwrap();
    }

    #[test]
    #[ignore = "fixed Pi/SDK, isolated synthetic credentials and rejecting local endpoint; no model calls"]
    fn fixed_pi_profile_refresh_keeps_native_process_session_and_history() {
        let server = crate::pi_acp_contract_tests::RejectModelServer::start();
        let fixture = Fixture::new(&server.endpoint);
        let root = fixture.temp.path().canonicalize().unwrap();
        let profile = new_owned_profile(fixture.selection.clone()).unwrap();
        let prepared = crate::acp_provider_profile::prepare_owned(
            &root,
            &root.join("pi-acp"),
            &fixture.store,
            &profile,
            true,
        )
        .unwrap();
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let node = manifest.join("capability-bridge/runtime/node");
        let pi = manifest.join("resources/pi-runtime/pi");
        assert_eq!(file_sha256(&node).unwrap(), NODE_SHA256);
        crate::runtime_registry::verify_managed_binary_path(pi.clone(), PI_ACP_RUNTIME).unwrap();
        fs::create_dir(prepared.config_root.join("extensions")).unwrap();
        fs::copy(
            manifest.join("../scripts/fixtures/pi-profile-refresh-probe.ts"),
            prepared.config_root.join("extensions/profile-probe.ts"),
        )
        .unwrap();
        let mut command = launch_command(
            &node,
            &manifest.join("pi-acp-adapter/dist/index.js"),
            &pi,
            &fixture.cwd,
            &prepared,
            Some("ignore"),
        )
        .unwrap();
        let (wire, _) = crate::acp_runtime::initialize_transport(
            &mut command,
            &fixture.cwd,
            json!({"elicitation":{"form":{}},"_meta":{"farfoldPi":{"version":1}}}),
            ADAPTER_VERSION,
            REQUEST_TIMEOUT,
        )
        .unwrap();
        let result = (|| -> Result<(), String> {
            let session = wire
                .request("session/new", json!({"cwd":fixture.cwd,"mcpServers":[]}))
                .map_err(|error| error.to_string())?;
            let session_id = session["sessionId"].as_str().ok_or("missing session")?;
            wire.bind_client_session(Some(session_id))?;
            let workspace = |section: &str| {
                wire.request(
                    "_pi/workspace",
                    json!({"sessionId":session_id,"section":section}),
                )
                .map_err(|error| error.to_string())
            };
            let probe = |refresh: bool| -> Result<Value, String> {
                let response = wire.request_timeout("session/prompt", json!({"sessionId":session_id,"prompt":[{"type":"text","text":if refresh {"/farfold-profile-probe refresh"} else {"/farfold-profile-probe"}}]}), REQUEST_TIMEOUT).map_err(|error| error.to_string())?;
                if response["stopReason"] != "end_turn" {
                    return Err("profile probe did not settle".into());
                }
                let deadline = std::time::Instant::now() + REQUEST_TIMEOUT;
                while std::time::Instant::now() < deadline {
                    let (events, dropped) = wire.wait_events(Duration::from_millis(25))?;
                    if dropped != 0 {
                        return Err("profile probe lost events".into());
                    }
                    for event in events {
                        if event["method"] == "_pi/ui"
                            && event["params"]["sessionId"] == session_id
                            && let Some(value) = event
                                .pointer("/params/event/message")
                                .and_then(Value::as_str)
                                .and_then(|value| value.strip_prefix("D-PROFILE-PROBE:"))
                        {
                            return serde_json::from_str(value).map_err(|error| error.to_string());
                        }
                    }
                }
                Err("native profile refresh acknowledgement missing".into())
            };
            let before = probe(false)?;
            let entries = workspace("entries")?;
            let initial = workspace("models")?;
            let models_path = prepared.config_root.join("models.json");
            let mut config: Value =
                serde_json::from_slice(&fs::read(&models_path).unwrap()).unwrap();
            let models = config["providers"]
                [&prepared.binding.clone().unwrap().runtime_provider_id]["models"]
                .as_array_mut()
                .unwrap();
            let mut added = models[0].clone();
            added["id"] = json!("profile-refresh-second");
            models.push(added);
            fs::write(&models_path, serde_json::to_vec(&config).unwrap()).unwrap();
            let helper = Command::new(&node)
                .arg(manifest.join("../scripts/fixtures/pi-profile-catalog-probe.mjs"))
                .arg(&prepared.config_root)
                .arg(&prepared.binding.clone().unwrap().runtime_provider_id)
                .current_dir(&fixture.cwd)
                .env_clear()
                .env("HOME", prepared.profile_root.join("home"))
                .env("TMPDIR", &root)
                .env("PI_CODING_AGENT_DIR", &prepared.config_root)
                .env("PATH", "/usr/bin:/bin")
                .envs(&prepared.environment)
                .output()
                .map_err(|error| error.to_string())?;
            if !helper.status.success() {
                return Err(format!(
                    "isolated SDK catalog helper failed: {}",
                    String::from_utf8_lossy(&helper.stderr)
                ));
            }
            let catalog: Value =
                serde_json::from_slice(&helper.stdout).map_err(|error| error.to_string())?;
            assert_eq!(catalog["version"], "0.84.3");
            assert_ne!(catalog["pid"], before["pid"]);
            assert!(
                catalog["models"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|model| model == "profile-refresh-second")
            );
            assert_eq!(
                workspace("models")?,
                initial,
                "external SDK refresh must not be mistaken for native-process refresh"
            );
            let refreshed_identity = wire
                .request("_pi/refresh_profile", json!({"sessionId": session_id}))
                .map_err(|error| error.to_string())?;
            assert_eq!(refreshed_identity["version"], 1);
            assert_eq!(
                refreshed_identity["nativeSession"],
                initial["nativeSession"]
            );
            let after = probe(false)?;
            assert_eq!(
                after, before,
                "refresh changed PID or native Session identity"
            );
            assert_eq!(after["sessionId"], session_id);
            assert_eq!(
                after["sessionFile"],
                session["_meta"]["farfoldPi"]["nativeSession"]["sessionFile"]
            );
            assert_eq!(
                workspace("entries")?,
                entries,
                "catalog refresh must not append a user/Agent turn"
            );
            let refreshed = workspace("models")?;
            assert!(
                refreshed["data"]["models"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|model| model["id"] == "profile-refresh-second")
            );
            let selector = format!(
                "{}/profile-refresh-second",
                prepared.binding.clone().unwrap().runtime_provider_id
            );
            let changed = wire
                .request(
                    "session/set_config_option",
                    json!({"sessionId":session_id,"configId":"model","value":selector}),
                )
                .map_err(|error| error.to_string())?;
            assert_eq!(
                selected_config(&changed["configOptions"], "model"),
                Some(selector.as_str())
            );
            let state = workspace("state")?;
            assert_eq!(state["data"]["model"]["id"], "profile-refresh-second");
            assert_eq!(state["nativeSession"], initial["nativeSession"]);
            assert_eq!(server.requests.load(Ordering::Acquire), 0);
            Ok(())
        })();
        let stopped = wire.stop();
        result.unwrap();
        stopped.unwrap();
    }

    #[test]
    #[ignore = "fixed Pi/Node binaries, isolated managed profile, rejecting model endpoint; no account access"]
    fn fixed_pi_ordinary_startup_registers_native_session_without_model_request() {
        let server = crate::pi_acp_contract_tests::RejectModelServer::start();
        let mut fixture = Fixture::new(&server.endpoint);
        let profile = new_owned_profile(fixture.selection.clone()).unwrap();
        fixture.prepared = crate::acp_provider_profile::prepare_owned(
            fixture.temp.path(),
            &fixture.temp.path().join("pi-acp"),
            &fixture.store,
            &profile,
            true,
        )
        .unwrap();
        fixture.binding = profile.binding.clone();
        fixture
            .store
            .register_runtime_owned_profile(
                &runtime_registration(&fixture.binding, crate::host_store::now_millis()),
                &profile,
            )
            .unwrap();
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let node = manifest.join("capability-bridge/runtime/node");
        let pi = manifest.join("resources/pi-runtime/pi");
        assert_eq!(file_sha256(&node).unwrap(), NODE_SHA256);
        crate::runtime_registry::verify_managed_binary_path(pi.clone(), PI_ACP_RUNTIME).unwrap();
        let runtime = PiAcpRuntime::default();
        let router = RuntimeEventRouter::default();
        let mut command = launch_command(
            &node,
            &manifest.join("pi-acp-adapter/dist/index.js"),
            &pi,
            &fixture.cwd,
            &fixture.prepared,
            Some("ignore"),
        )
        .unwrap();
        let handle = start_connection(
            &runtime,
            &router,
            fixture.binding.clone(),
            &fixture.cwd,
            &fixture.prepared,
            &mut command,
        )
        .unwrap();
        let result = (|| {
            let result =
                open_native_session(&handle, &router, &fixture.store, None, "Pi native start")?;
            let controller = crate::session_controller::HostSessionController::default();
            let turns = crate::turn_coordinator::TurnCoordinator::default();
            for (config_id, value) in [
                (
                    PiAcpConfigId::Model,
                    fixture
                        .prepared
                        .binding
                        .clone()
                        .unwrap()
                        .runtime_model_id
                        .clone(),
                ),
                (PiAcpConfigId::ThoughtLevel, "off".into()),
            ] {
                let status = set_config_option(
                    &controller,
                    &runtime,
                    &fixture.store,
                    &router,
                    &turns,
                    PiAcpConfigInput {
                        farfold_session_id: result.farfold_session_id.clone(),
                        native_session_id: NativeSessionId::parse(&result.native_session_id)
                            .unwrap(),
                        runtime_generation: result.runtime_generation,
                        config_id,
                        value: value.clone(),
                    },
                )?;
                assert_eq!(
                    selected_config(&status.config_options, config_id.as_str()),
                    Some(value.as_str())
                );
            }
            for section in [
                PiWorkspaceSection::State,
                PiWorkspaceSection::Messages,
                PiWorkspaceSection::Entries,
                PiWorkspaceSection::Models,
                PiWorkspaceSection::ThinkingLevels,
                PiWorkspaceSection::Commands,
                PiWorkspaceSection::Stats,
            ] {
                let data = read_workspace(
                    &runtime,
                    &fixture.store,
                    &router,
                    PiAcpWorkspaceInput {
                        farfold_session_id: result.farfold_session_id.clone(),
                        native_session_id: NativeSessionId::parse(&result.native_session_id)
                            .unwrap(),
                        runtime_generation: result.runtime_generation,
                        section,
                    },
                )?;
                if section == PiWorkspaceSection::State {
                    assert_eq!(data["sessionId"], result.native_session_id);
                }
                if section == PiWorkspaceSection::Entries {
                    assert!(data["entries"].is_array());
                }
            }
            Ok::<_, String>(result)
        })();
        let stopped = runtime.stop_for_shutdown();
        let result = result.unwrap();
        stopped.unwrap();
        let target = fixture
            .store
            .session_open_target(&result.farfold_session_id)
            .unwrap();
        assert_eq!(target.binding(), fixture.binding);
        assert_eq!(target.native_session_id.as_str(), result.native_session_id);
        assert_eq!(
            saved_owned_profile(&fixture.store, &target.binding())
                .unwrap()
                .profile_id,
            profile.profile_id
        );
        assert!(
            !fixture
                .store
                .discard_unbound_owned_profile(&profile)
                .unwrap()
        );
        assert_eq!(
            target.blockers(),
            vec![SessionOpenBlocker::NativeLocatorUnavailable]
        );
        assert_eq!(server.requests.load(Ordering::Acquire), 0);
    }
}
