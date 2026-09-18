use super::admission::*;
use super::turns::*;
use super::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiAcpStatus {
    pub(crate) native_admission_ready: bool,
    pub(crate) native_first_use: Option<PiNativeFirstUseState>,
    pub(crate) running: bool,
    pub(crate) generation: u64,
    pub(crate) runtime: Option<RuntimeIdentity>,
    pub(crate) runtime_build_id: Option<String>,
    pub(crate) runtime_connection_id: Option<String>,
    pub(crate) cwd: Option<PathBuf>,
    pub(crate) native_session: Option<PiNativeSession>,
    pub(crate) config_options: Value,
    pub(crate) managed_provider: Option<ManagedAcpProviderBinding>,
    pub(crate) model_source: Option<PiModelSource>,
    pub(crate) last_confirmed_model_source: Option<PiModelSource>,
    pub(crate) configuration_state: PiConfigurationState,
    pub(crate) last_error: Option<String>,
    pub(crate) dropped_events: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PiConfigurationState {
    Confirmed,
    Changing,
    Unknown,
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
    pub(crate) farfold_session_id: FarfoldSessionId,
    pub(crate) native_session_id: NativeSessionId,
    pub(crate) runtime_generation: u64,
    pub(crate) section: PiWorkspaceSection,
}

pub(crate) fn current_status(
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

pub(crate) fn read_workspace(
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
pub(crate) fn read_workspace_snapshot(
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
