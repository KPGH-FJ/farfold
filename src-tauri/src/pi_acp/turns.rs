use super::admission::*;
use super::workspace::*;
use super::*;

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
    pub(crate) source: PiModelSource,
    pub(crate) binding: RuntimeBinding,
    pub(crate) farfold_session_id: FarfoldSessionId,
    pub(crate) native: PiNativeSession,
    pub(crate) generation: u64,
    pub(crate) observed_at: u64,
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

pub(crate) fn prompt_model_observation(
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

pub(crate) fn idle_model_source(
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

pub(crate) fn verify_idle_native_session(
    state: &Value,
    native: &PiNativeSession,
) -> Result<(), String> {
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

pub(crate) fn verify_prompt_connection(
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
