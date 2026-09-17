use serde_json::{Value, json};
#[cfg(test)]
use std::thread;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex, atomic::Ordering},
    time::Duration,
};
use tauri::{AppHandle, Manager, State};

use crate::acp_provider_profile::{protect_directory, safe_path_segment};

use crate::{
    acp_adapter::{AcpAdapterError, AcpFuture, AcpResult, AcpRuntimeAdapter},
    acp_runtime::{AcpEventConnection, AcpLifecycle, AcpRuntime, start_event_pump},
    acp_session_operations::{AcpSessionOperationKind, AcpSessionOperations},
    acp_transport::{AcpDispatchError, AcpTransport},
    host_ids::{
        AdapterId, ConnectionId, FarfoldSessionId, InstallationId, NativeSessionId, RuntimeBuildId,
        RuntimeProductId, derived_host_id,
    },
    host_store::{
        HostStore,
        provider_projection::{
            ProviderActiveTaskPolicy, ProviderApplyState, ProviderRequestState, ProviderSaveState,
            ProviderTargetProjectionInput,
        },
        records::{RuntimeConnectionKind, RuntimeDistribution, RuntimeRegistration},
        session_binding_index::{
            HostNavigationSnapshot, NativeSessionRegistrationInput, register_native_session,
        },
    },
    runtime_event_router::RuntimeEventRouter,
    runtime_registry::{RuntimeBinding, RuntimeIdentity},
};

pub mod identity;
pub mod status;
pub(crate) use identity::{
    OPENCODE_ACP_ADAPTER_ID, OPENCODE_ACP_BINARY_SHA256, OPENCODE_ACP_VERSION,
    OPENCODE_ACP_VERSION_FOR_ADAPTER, acp_binding, acp_launch_record, is_acp_binding,
    managed_acp_registered_binding, managed_provider_for_runtime_target, now_millis,
    verified_acp_creation_target, verified_saved_acp_binding, verify_acp_binary,
};
pub use status::*;

const ACP_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const ACP_NOTIFICATION_TIMEOUT: Duration = Duration::from_secs(2);

pub type OpenCodeAcpRuntime = AcpRuntime<OpenCodeAcpConnection>;
type OpenCodeAcpLifecycle = AcpLifecycle<OpenCodeAcpConnection>;

impl OpenCodeAcpRuntime {
    pub(crate) fn stop_for_shutdown(&self) -> Result<(), String> {
        let Some(connection) = self.take_connection()? else {
            return Ok(());
        };
        let transport = connection
            .lock()
            .map_err(|_| "OpenCode ACP 状态不可用".to_string())?
            .transport
            .clone();
        if let Ok(connection) = connection.lock() {
            connection.event_pump_stop.store(true, Ordering::Release);
        }
        transport.stop().map(|_| ())
    }
}

pub struct OpenCodeAcpConnection {
    transport: Arc<AcpTransport>,
    binding: RuntimeBinding,
    generation: u64,
    cwd: PathBuf,
    binary_path: PathBuf,
    session_id: Option<String>,
    agent_name: Option<String>,
    agent_version: String,
    protocol_version: u64,
    question_bridge: bool,
    load_session: bool,
    config_options: Value,
    managed_provider: Option<OpenCodeAcpManagedProviderBinding>,
    private_launch_dir: Option<PathBuf>,
    last_error: Option<String>,
    dropped_events: u64,
    initialized_at_ms: u64,
    operations: AcpSessionOperations,
    event_pump_stop: Arc<std::sync::atomic::AtomicBool>,
}

fn prepare_managed_acp_provider(
    app_data_dir: &Path,
    acp_root: &Path,
    operation_id: &str,
    binding: &RuntimeBinding,
    store: &HostStore,
    input: &OpenCodeAcpManagedSessionInput,
    require_current_version: bool,
) -> Result<PreparedManagedAcpProvider, String> {
    if input.operation_id != operation_id || binding.product_id.as_str() != "opencode" {
        return Err("OpenCode ACP Provider operation or target mismatch".into());
    }
    let prepared = crate::acp_provider_profile::prepare(
        app_data_dir,
        acp_root,
        operation_id,
        binding,
        store,
        &crate::managed_provider::ManagedProviderSelection {
            provider_connection_id: input.provider_connection_id.clone(),
            provider_config_version_id: input.provider_config_version_id.clone(),
        },
        require_current_version,
    )?;
    if !prepared.environment.is_empty() {
        return Err("OpenCode ACP received a different adapter's launch profile".into());
    }
    Ok(PreparedManagedAcpProvider {
        binding: prepared.binding,
        profile_root: prepared.profile_root,
        config_root: prepared.config_root,
    })
}

fn status_from_connection(connection: &OpenCodeAcpConnection) -> OpenCodeAcpStatus {
    OpenCodeAcpStatus {
        state: "running",
        running: true,
        generation: connection.generation,
        runtime: connection.binding.identity(),
        runtime_build_id: connection.binding.runtime_build_id.as_str().to_string(),
        runtime_connection_id: connection.binding.connection_id.as_str().to_string(),
        cwd: Some(connection.cwd.clone()),
        binary_path: Some(connection.binary_path.clone()),
        agent_name: connection.agent_name.clone(),
        agent_version: Some(connection.agent_version.clone()),
        protocol_version: Some(connection.protocol_version),
        question_bridge: connection.question_bridge,
        load_session: connection.load_session,
        config_options: connection.config_options.clone(),
        managed_provider: connection.managed_provider.clone(),
        session_id: connection.session_id.clone(),
        last_error: connection.last_error.clone(),
        dropped_events: connection.dropped_events,
        initialized_at_ms: Some(connection.initialized_at_ms),
    }
}

fn stopped_status(generation: u64) -> OpenCodeAcpStatus {
    let binding = RuntimeBinding {
        product_id: RuntimeProductId::parse("opencode").expect("fixed product"),
        installation_id: InstallationId::parse("opencode-acp-unselected").expect("fixed install"),
        runtime_build_id: RuntimeBuildId::parse(format!(
            "opencode@{OPENCODE_ACP_VERSION}+sha256:{OPENCODE_ACP_BINARY_SHA256}"
        ))
        .expect("fixed build"),
        adapter_id: AdapterId::parse(OPENCODE_ACP_ADAPTER_ID).expect("fixed adapter"),
        connection_id: ConnectionId::parse("opencode-acp-stdio-unselected").expect("fixed conn"),
    };
    OpenCodeAcpStatus {
        state: "stopped",
        running: false,
        generation,
        runtime: binding.identity(),
        runtime_build_id: binding.runtime_build_id.as_str().to_string(),
        runtime_connection_id: binding.connection_id.as_str().to_string(),
        cwd: None,
        binary_path: None,
        agent_name: None,
        agent_version: None,
        protocol_version: None,
        question_bridge: false,
        load_session: false,
        config_options: json!([]),
        managed_provider: None,
        session_id: None,
        last_error: None,
        dropped_events: 0,
        initialized_at_ms: None,
    }
}

fn update_events(
    connection: &mut OpenCodeAcpConnection,
    router: &RuntimeEventRouter,
) -> Result<(), String> {
    if let Some(error) = connection.transport.failure() {
        connection.last_error.get_or_insert(error);
    }
    let (events, dropped) = connection.transport.drain_events()?;
    connection.dropped_events = connection.dropped_events.saturating_add(dropped);
    for event in events {
        if event.get("method").and_then(Value::as_str) == Some("session/update")
            && event.pointer("/params/sessionId").and_then(Value::as_str)
                == connection.session_id.as_deref()
            && event
                .pointer("/params/update/sessionUpdate")
                .and_then(Value::as_str)
                == Some("config_option_update")
            && let Some(config_options) = event.pointer("/params/update/configOptions")
        {
            connection.config_options = config_options.clone();
        }
        router.route_acp(
            connection.binding.clone(),
            connection.generation,
            &connection.transport,
            event,
        )?;
    }
    Ok(())
}

fn acp_config_options_select_target(config_options: &Value, runtime_model_id: &str) -> bool {
    let Some(options) = config_options.as_array() else {
        return false;
    };
    options.iter().any(|item| {
        item.get("type").and_then(Value::as_str) == Some("select")
            && item.get("currentValue").and_then(Value::as_str) == Some(runtime_model_id)
            && item
                .get("options")
                .and_then(Value::as_array)
                .is_some_and(|values| {
                    values.iter().any(|value| {
                        value.get("value").and_then(Value::as_str) == Some(runtime_model_id)
                    })
                })
    })
}

impl AcpEventConnection for OpenCodeAcpConnection {
    fn transport(&self) -> Arc<AcpTransport> {
        self.transport.clone()
    }

    fn update_events(&mut self, router: &RuntimeEventRouter) -> Result<(), String> {
        update_events(self, router)
    }

    fn record_event_error(&mut self, error: String) {
        self.last_error.get_or_insert(error);
    }
}

fn register_acp_runtime_and_session(
    store: &HostStore,
    binding: &RuntimeBinding,
    cwd: &Path,
    binary_path: &Path,
    native_session_id: &str,
) -> Result<(FarfoldSessionId, i64, HostNavigationSnapshot), String> {
    let now = i64::try_from(now_millis()).map_err(|_| "Host timestamp out of range".to_string())?;
    let registration = RuntimeRegistration {
        runtime_product_id: binding.product_id.clone(),
        display_name: "OpenCode".to_string(),
        installation_id: binding.installation_id.clone(),
        runtime_build_id: binding.runtime_build_id.clone(),
        adapter_id: binding.adapter_id.clone(),
        distribution: RuntimeDistribution::System,
        observed_version: OPENCODE_ACP_VERSION.to_string(),
        artifact_sha256: OPENCODE_ACP_BINARY_SHA256.to_string(),
        connection_id: binding.connection_id.clone(),
        connection_label: "OpenCode ACP system local".to_string(),
        connection_kind: RuntimeConnectionKind::SystemLocal,
        created_at: now,
        verified_at: now,
    };
    let saved_record_exists = store
        .runtime_system_installations(&binding.product_id)?
        .into_iter()
        .any(|record| {
            record.installation_id == binding.installation_id
                && record.runtime_build_id == binding.runtime_build_id
        });
    if saved_record_exists {
        verified_saved_acp_binding(store, binding)?;
        store.register_runtime(&registration)?;
    } else {
        let launch_json = serde_json::to_string(&acp_launch_record(binary_path))
            .map_err(|error| error.to_string())?;
        store.accept_runtime_system_installation(&registration, binary_path, &launch_json, now)?;
    }
    let (farfold_session_id, _) = register_native_session(
        store,
        binding.clone(),
        NativeSessionRegistrationInput {
            native_session_id,
            working_copy_path: cwd,
            title: "OpenCode ACP",
            created_at: u64::try_from(now)
                .map_err(|_| "Host timestamp out of range".to_string())?,
            updated_at: u64::try_from(now)
                .map_err(|_| "Host timestamp out of range".to_string())?,
        },
    )?;
    let (opened_at, navigation) = store.mark_session_opened(&farfold_session_id)?;
    Ok((farfold_session_id, opened_at, navigation))
}

fn current_status(
    runtime: &OpenCodeAcpRuntime,
    router: Option<&RuntimeEventRouter>,
) -> Result<OpenCodeAcpStatus, String> {
    let handle = {
        let state = runtime
            .state
            .lock()
            .map_err(|_| "OpenCode ACP 状态不可用".to_string())?;
        match &*state {
            OpenCodeAcpLifecycle::Stopped => {
                return Ok(stopped_status(runtime.generation.load(Ordering::SeqCst)));
            }
            OpenCodeAcpLifecycle::Running(connection) => connection.clone(),
        }
    };
    let mut connection = handle
        .lock()
        .map_err(|_| "OpenCode ACP 状态不可用".to_string())?;
    if let Some(router) = router {
        update_events(&mut connection, router)?;
    }
    let running = connection.transport.is_running()?;
    if running {
        Ok(status_from_connection(&connection))
    } else {
        let mut status = status_from_connection(&connection);
        status.running = false;
        status.state = "stopped";
        status.last_error.get_or_insert_with(|| {
            "OpenCode ACP 进程已退出；未确认操作结果需要重新核对".to_string()
        });
        // Retain the dead connection's identity until explicit Host recovery.
        // A status read cannot discard the only authority that validates exit.
        connection.last_error = status.last_error.clone();
        connection.event_pump_stop.store(true, Ordering::Release);
        Ok(status)
    }
}

fn running_connection(
    runtime: &OpenCodeAcpRuntime,
) -> Result<Arc<Mutex<OpenCodeAcpConnection>>, String> {
    let state = runtime
        .state
        .lock()
        .map_err(|_| "OpenCode ACP 状态不可用".to_string())?;
    match &*state {
        OpenCodeAcpLifecycle::Stopped => Err("OpenCode ACP 连接未启动".to_string()),
        OpenCodeAcpLifecycle::Running(connection) => Ok(connection.clone()),
    }
}

fn opencode_acp_status_blocking(
    runtime: OpenCodeAcpRuntime,
    router: RuntimeEventRouter,
) -> Result<OpenCodeAcpStatus, String> {
    current_status(&runtime, Some(&router))
}

fn opencode_acp_start_blocking_with_app_data(
    app_data_root: &Path,
    runtime: OpenCodeAcpRuntime,
    router: RuntimeEventRouter,
    input: OpenCodeAcpStartInput,
    managed: Option<(HostStore, OpenCodeAcpManagedSessionInput, bool)>,
    binding_override: Option<RuntimeBinding>,
) -> Result<OpenCodeAcpStatus, String> {
    let _start_guard = runtime
        .start_lock
        .lock()
        .map_err(|_| "OpenCode ACP 启动状态不可用".to_string())?;
    {
        let state = runtime
            .state
            .lock()
            .map_err(|_| "OpenCode ACP 状态不可用".to_string())?;
        if matches!(*state, OpenCodeAcpLifecycle::Running(_)) {
            return Err("OpenCode ACP 连接已启动".to_string());
        }
    }
    let cwd = input
        .cwd
        .canonicalize()
        .map_err(|error| format!("无法解析 ACP 工作目录：{error}"))?;
    if !cwd.is_dir() {
        return Err("ACP 工作目录不是目录".to_string());
    }
    let binary_path = verify_acp_binary(&input.binary_path)?;
    let app_data_dir = app_data_root.join("opencode-acp-experiment");
    protect_directory(&app_data_dir)?;
    let (binding, profile_root, config_root, managed_provider) =
        if let Some((store, managed_input, require_current_version)) = managed {
            let binding = managed_acp_registered_binding(
                &store,
                &binary_path,
                &managed_input.provider_connection_id,
                &managed_input.provider_config_version_id,
            )?;
            let segment = safe_path_segment(&managed_input.operation_id);
            if segment.is_empty() {
                return Err("OpenCode ACP managed operation id is invalid".to_string());
            }
            match prepare_managed_acp_provider(
                app_data_root,
                &app_data_dir,
                &managed_input.operation_id,
                &binding,
                &store,
                &managed_input,
                require_current_version,
            ) {
                Ok(prepared) => (
                    binding,
                    prepared.profile_root,
                    prepared.config_root,
                    Some(prepared.binding),
                ),
                Err(error) => {
                    return Err(error);
                }
            }
        } else {
            let binding = binding_override.unwrap_or(acp_binding(&binary_path)?);
            (binding, app_data_dir.clone(), app_data_dir.clone(), None)
        };
    let home = profile_root.join("home");
    protect_directory(&home)?;
    let executable = {
        #[cfg(test)]
        let override_path = std::env::var_os("FARFOLD_OPENCODE_ACP_ADAPTER_BINARY");
        #[cfg(not(test))]
        let override_path: Option<std::ffi::OsString> = None;
        override_path
            .map(PathBuf::from)
            .map(Ok)
            .unwrap_or_else(|| {
                std::env::current_exe()
                    .map_err(|error| format!("无法定位 Farfold adapter 程序：{error}"))
            })?
    };
    let mut command = Command::new(executable);
    command
        .arg(crate::OPENCODE_QUESTION_ACP_ADAPTER_ARGUMENT)
        .current_dir(&cwd)
        .env_clear()
        .env("HOME", home)
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("OPENCODE_CONFIG_DIR", config_root.join("config"))
        .env("XDG_CONFIG_HOME", config_root.join("xdg-config"))
        .env("XDG_DATA_HOME", profile_root.join("xdg-data"))
        .env("XDG_CACHE_HOME", profile_root.join("xdg-cache"))
        .env("XDG_STATE_HOME", profile_root.join("xdg-state"))
        .env("FARFOLD_OPENCODE_BINARY", &binary_path)
        .env("FARFOLD_OPENCODE_CWD", &cwd);
    let (transport, initialized) = match crate::acp_runtime::initialize_transport(
        &mut command,
        &cwd,
        json!({
            "fs":{"readTextFile":true,"writeTextFile":true}, "terminal":true,
            "elicitation":{"form":{}}
        }),
        OPENCODE_ACP_VERSION,
        ACP_REQUEST_TIMEOUT,
    ) {
        Ok(initialized) => initialized,
        Err(error) => {
            if managed_provider.is_some() {
                let _ = fs::remove_dir_all(&config_root);
            }
            return Err(error);
        }
    };
    let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let protocol_version = initialized
        .get("protocolVersion")
        .and_then(Value::as_u64)
        .ok_or("OpenCode ACP initialize 缺少 protocolVersion")?;
    let agent_version = initialized
        .pointer("/agentInfo/version")
        .and_then(Value::as_str)
        .ok_or("OpenCode ACP initialize 缺少 agentInfo.version")?;
    let agent_name = initialized
        .pointer("/agentInfo/name")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let load_session = initialized
        .pointer("/agentCapabilities/loadSession")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let question_bridge = initialized
        .pointer("/agentCapabilities/farfoldOpenCodeQuestionBridge")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut state = runtime
        .state
        .lock()
        .map_err(|_| "OpenCode ACP 状态不可用".to_string())?;
    if matches!(*state, OpenCodeAcpLifecycle::Running(_)) {
        let _ = transport.stop();
        if managed_provider.is_some() {
            let _ = fs::remove_dir_all(&config_root);
        }
        return Err("OpenCode ACP 连接已启动".to_string());
    }
    if let Err(error) = router.activate_connection(binding.clone(), generation) {
        let _ = transport.stop();
        if managed_provider.is_some() {
            let _ = fs::remove_dir_all(&config_root);
        }
        return Err(error);
    }
    let event_pump_stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut connection = OpenCodeAcpConnection {
        transport,
        binding,
        generation,
        cwd,
        binary_path,
        session_id: None,
        agent_name,
        agent_version: agent_version.to_string(),
        protocol_version,
        question_bridge,
        load_session,
        config_options: json!([]),
        private_launch_dir: managed_provider.as_ref().map(|_| config_root),
        managed_provider,
        last_error: None,
        dropped_events: 0,
        initialized_at_ms: now_millis(),
        operations: AcpSessionOperations::default(),
        event_pump_stop: event_pump_stop.clone(),
    };
    update_events(&mut connection, &router)?;
    let status = status_from_connection(&connection);
    let handle = Arc::new(Mutex::new(connection));
    start_event_pump(handle.clone(), router, event_pump_stop)?;
    *state = OpenCodeAcpLifecycle::Running(handle);
    Ok(status)
}

fn begin_session_operation(
    handle: &Arc<Mutex<OpenCodeAcpConnection>>,
    kind: AcpSessionOperationKind,
    requested_session_id: Option<String>,
) -> Result<(u64, Arc<AcpTransport>, PathBuf), String> {
    let mut connection = handle
        .lock()
        .map_err(|_| "OpenCode ACP 状态不可用".to_string())?;
    let bound_session_id = connection.session_id.clone();
    let unresolved = connection.transport.has_unresolved_work()?;
    let id = connection.operations.begin(
        kind,
        requested_session_id,
        bound_session_id.as_deref(),
        unresolved,
    )?;
    Ok((id, connection.transport.clone(), connection.cwd.clone()))
}

fn complete_session_operation(
    handle: &Arc<Mutex<OpenCodeAcpConnection>>,
    operation_id: u64,
    router: &RuntimeEventRouter,
    store: Option<&HostStore>,
    result: Result<Value, AcpDispatchError>,
    requested_session_id: Option<String>,
    clear_session_on_success: bool,
) -> Result<OpenCodeAcpSessionResult, String> {
    let mut connection = handle
        .lock()
        .map_err(|_| "OpenCode ACP 状态不可用".to_string())?;
    let operation_kind = connection.operations.complete(operation_id)?;
    match result {
        Ok(response) => {
            if clear_session_on_success {
                connection.transport.bind_client_session(None)?;
                connection.session_id = None;
                update_events(&mut connection, router)?;
                let status = status_from_connection(&connection);
                Ok(OpenCodeAcpSessionResult {
                    session_id: requested_session_id.unwrap_or_default(),
                    farfold_session_id: None,
                    opened_at: None,
                    config_options: json!({}),
                    navigation: None,
                    status,
                })
            } else {
                session_result_from_response(
                    &mut connection,
                    response,
                    requested_session_id,
                    router,
                    store,
                    operation_kind == AcpSessionOperationKind::New,
                )
            }
        }
        Err(error) => {
            connection.last_error = Some(match error {
                AcpDispatchError::Unknown(message) => message,
                other => other.to_string(),
            });
            update_events(&mut connection, router)?;
            Err(connection
                .last_error
                .clone()
                .unwrap_or_else(|| "OpenCode ACP 操作失败".to_string()))
        }
    }
}

fn session_result_from_response(
    connection: &mut OpenCodeAcpConnection,
    response: Value,
    requested_session_id: Option<String>,
    router: &RuntimeEventRouter,
    store: Option<&HostStore>,
    record_managed_projection: bool,
) -> Result<OpenCodeAcpSessionResult, String> {
    update_events(connection, router)?;
    let session_id = requested_session_id
        .or_else(|| {
            response
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .ok_or("OpenCode ACP Session 响应缺少 sessionId")?;
    connection.session_id = Some(session_id.clone());
    connection
        .transport
        .bind_client_session(Some(&session_id))?;
    connection.config_options = response
        .get("configOptions")
        .cloned()
        .unwrap_or_else(|| json!([]));
    if let Some(managed_provider) = &connection.managed_provider
        && !acp_config_options_select_target(
            &connection.config_options,
            &managed_provider.runtime_model_id,
        )
    {
        return Err(
            "OpenCode ACP configOptions did not confirm the managed Provider model".to_string(),
        );
    }
    let registered = store
        .map(|store| {
            register_acp_runtime_and_session(
                store,
                &connection.binding,
                &connection.cwd,
                &connection.binary_path,
                &session_id,
            )
        })
        .transpose()?;
    if record_managed_projection
        && let Some(managed_provider) = &connection.managed_provider
        && let Some(store) = store
    {
        store.record_provider_target_projection(&ProviderTargetProjectionInput {
            provider_connection_id: managed_provider.provider_connection_id.clone(),
            config_version_id: managed_provider.provider_config_version_id.clone(),
            runtime_product_id: connection.binding.product_id.clone(),
            installation_id: connection.binding.installation_id.clone(),
            runtime_connection_id: connection.binding.connection_id.clone(),
            runtime_provider_id: managed_provider.runtime_provider_id.clone(),
            runtime_model_id: managed_provider.runtime_model_id.clone(),
            save_state: ProviderSaveState::Saved,
            apply_state: ProviderApplyState::Applied,
            request_state: ProviderRequestState::NotRequested,
            request_verified_version_id: None,
            active_task_policy: ProviderActiveTaskPolicy::CurrentTaskKeepsBoundConfig,
            detail: Some(
                "OpenCode ACP private launch config was confirmed by native configOptions; request not yet verified"
                    .to_string(),
            ),
        })?;
    }
    Ok(OpenCodeAcpSessionResult {
        session_id,
        farfold_session_id: registered
            .as_ref()
            .map(|(farfold_session_id, _, _)| farfold_session_id.clone()),
        opened_at: registered.as_ref().map(|(_, opened_at, _)| *opened_at),
        config_options: connection.config_options.clone(),
        navigation: registered.map(|(_, _, navigation)| navigation),
        status: status_from_connection(connection),
    })
}

pub(crate) fn open_registered_host_session(
    app: AppHandle,
    runtime: OpenCodeAcpRuntime,
    router: RuntimeEventRouter,
    store: HostStore,
    input: OpenCodeAcpHostOpenInput,
) -> Result<OpenCodeAcpHostOpenResult, String> {
    let app_data_root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    open_registered_host_session_with_app_data(&app_data_root, runtime, router, store, input)
}

pub(crate) fn create_registered_host_session(
    app: AppHandle,
    runtime: OpenCodeAcpRuntime,
    router: RuntimeEventRouter,
    store: HostStore,
    input: OpenCodeAcpHostCreateInput,
) -> Result<OpenCodeAcpHostCreateResult, String> {
    let app_data_root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    create_registered_host_session_with_app_data(&app_data_root, runtime, router, store, input)
}

fn create_registered_host_session_with_app_data(
    app_data_root: &Path,
    runtime: OpenCodeAcpRuntime,
    router: RuntimeEventRouter,
    store: HostStore,
    input: OpenCodeAcpHostCreateInput,
) -> Result<OpenCodeAcpHostCreateResult, String> {
    if !input.working_copy_path.is_absolute() {
        return Err("请选择绝对工作目录".into());
    }
    let binary_path = verified_acp_creation_target(
        &store,
        input.binding.installation_id.as_str(),
        input.binding.connection_id.as_str(),
    )
    .and_then(|(binding, path)| {
        if binding != input.binding {
            Err("OpenCode ACP registry binding does not match the Host request".to_string())
        } else {
            Ok(path)
        }
    })?;
    if binary_path != input.binary_path {
        return Err("OpenCode ACP registry path does not match the Host request".to_string());
    }
    let explicit_provider = input.managed_provider.is_some();
    let provider = match input.managed_provider {
        Some(provider) => Some(provider),
        None => managed_provider_for_runtime_target(&store, &input.binding)?.map(|provider| {
            crate::managed_provider::ManagedProviderSelection {
                provider_connection_id: provider.provider_connection_id,
                provider_config_version_id: provider.provider_config_version_id,
            }
        }),
    };
    let managed = provider.map(|provider| {
        (
            store.clone(),
            OpenCodeAcpManagedSessionInput {
                #[cfg(test)]
                binary_path: binary_path.clone(),
                #[cfg(test)]
                cwd: input.working_copy_path.clone(),
                provider_connection_id: provider.provider_connection_id,
                provider_config_version_id: provider.provider_config_version_id,
                operation_id: format!("host-create-{}", now_millis()),
            },
            explicit_provider,
        )
    });
    stop_idle_connection_for_host_switch(&runtime)?;
    let started = opencode_acp_start_blocking_with_app_data(
        app_data_root,
        runtime.clone(),
        router.clone(),
        OpenCodeAcpStartInput {
            binary_path,
            cwd: input.working_copy_path,
        },
        managed,
        Some(input.binding.clone()),
    )?;
    let runtime_ready_at =
        i64::try_from(started.initialized_at_ms.unwrap_or_default()).unwrap_or_default();
    let created = match opencode_acp_new_session_blocking(runtime.clone(), router, Some(store)) {
        Ok(created) => created,
        Err(error) => {
            let _ = opencode_acp_stop_blocking(runtime);
            return Err(error);
        }
    };
    let farfold_session_id = created
        .farfold_session_id
        .ok_or_else(|| "Host did not register the new OpenCode ACP Session".to_string())?;
    let opened_at = created
        .opened_at
        .ok_or_else(|| "Host did not mark the new OpenCode ACP Session opened".to_string())?;
    let navigation = created
        .navigation
        .ok_or_else(|| "Host navigation omitted the new OpenCode ACP Session".to_string())?;
    Ok(OpenCodeAcpHostCreateResult {
        farfold_session_id,
        installation_id: input.binding.installation_id.into_inner(),
        native_session_id: created.session_id,
        runtime_generation: created.status.generation,
        runtime_ready_at,
        opened_at,
        navigation,
    })
}

fn open_registered_host_session_with_app_data(
    app_data_root: &Path,
    runtime: OpenCodeAcpRuntime,
    router: RuntimeEventRouter,
    store: HostStore,
    input: OpenCodeAcpHostOpenInput,
) -> Result<OpenCodeAcpHostOpenResult, String> {
    let binary_path = verified_saved_acp_binding(&store, &input.binding)?;
    stop_idle_connection_for_host_switch(&runtime)?;
    let managed_provider = managed_provider_for_runtime_target(&store, &input.binding)?;
    let managed = managed_provider.as_ref().map(|provider| {
        (
            store.clone(),
            OpenCodeAcpManagedSessionInput {
                #[cfg(test)]
                binary_path: binary_path.clone(),
                #[cfg(test)]
                cwd: input.working_copy_path.clone(),
                provider_connection_id: provider.provider_connection_id.clone(),
                provider_config_version_id: provider.provider_config_version_id.clone(),
                operation_id: format!(
                    "restore-{}-{}",
                    safe_path_segment(&derived_host_id(
                        "opencode-acp-restore",
                        &[
                            provider.provider_connection_id.as_str(),
                            provider.provider_config_version_id.as_str()
                        ],
                    )),
                    now_millis()
                ),
            },
            false,
        )
    });
    let started = opencode_acp_start_blocking_with_app_data(
        app_data_root,
        runtime.clone(),
        router.clone(),
        OpenCodeAcpStartInput {
            binary_path,
            cwd: input.working_copy_path,
        },
        managed,
        Some(input.binding),
    )?;
    let runtime_ready_at =
        i64::try_from(started.initialized_at_ms.unwrap_or_default()).unwrap_or_default();
    let loaded = match opencode_acp_load_session_blocking(
        runtime.clone(),
        router,
        Some(store),
        OpenCodeAcpLoadInput {
            session_id: input.native_session_id,
        },
    ) {
        Ok(loaded) => loaded,
        Err(error) => {
            let _ = opencode_acp_stop_blocking(runtime.clone());
            return Err(error);
        }
    };
    if loaded.farfold_session_id.as_ref() != Some(&input.farfold_session_id) {
        let _ = opencode_acp_stop_blocking(runtime);
        return Err("OpenCode ACP loaded Session does not match the Host binding".to_string());
    }
    Ok(OpenCodeAcpHostOpenResult {
        runtime_generation: loaded.status.generation,
        runtime_ready_at,
        opened_at: loaded.opened_at.unwrap_or(runtime_ready_at),
        navigation: loaded
            .navigation
            .ok_or("OpenCode ACP Host navigation was not returned")?,
    })
}

pub(crate) fn verify_active_session(
    runtime: &OpenCodeAcpRuntime,
    binding: &RuntimeBinding,
    cwd: &Path,
    native_session_id: &NativeSessionId,
) -> Result<u64, String> {
    verify_active_session_with_managed_provider(runtime, binding, cwd, native_session_id)
        .map(|(generation, _)| generation)
}

pub(crate) fn verify_completed_session(
    runtime: &OpenCodeAcpRuntime,
    binding: &RuntimeBinding,
    cwd: &Path,
    native_session_id: &NativeSessionId,
) -> Result<u64, String> {
    let generation = verify_active_session(runtime, binding, cwd, native_session_id)?;
    let handle = running_connection(runtime)?;
    let connection = handle.lock().map_err(|_| "OpenCode ACP 状态不可用")?;
    if connection.transport.has_unresolved_work()? {
        return Err("ACP prompt 已返回，但 Host 资源或操作仍未结束".into());
    }
    Ok(generation)
}

pub(crate) fn verify_active_session_with_managed_provider(
    runtime: &OpenCodeAcpRuntime,
    binding: &RuntimeBinding,
    cwd: &Path,
    native_session_id: &NativeSessionId,
) -> Result<(u64, Option<OpenCodeAcpManagedProviderBinding>), String> {
    let handle = running_connection(runtime)?;
    let connection = handle
        .lock()
        .map_err(|_| "OpenCode ACP 状态不可用".to_string())?;
    if connection.binding != *binding {
        return Err("OpenCode ACP 连接身份与 Host Session 不一致".to_string());
    }
    if connection.cwd != cwd {
        return Err("OpenCode ACP Working Copy changed before Turn".to_string());
    }
    if connection.session_id.as_deref() != Some(native_session_id.as_str()) {
        return Err("OpenCode ACP native Session does not match the Host binding".to_string());
    }
    Ok((connection.generation, connection.managed_provider.clone()))
}

pub(crate) fn prompt_text(
    runtime: &OpenCodeAcpRuntime,
    native_session_id: &NativeSessionId,
    text: &str,
) -> Result<Value, AcpDispatchError> {
    let handle = running_connection(runtime)
        .map_err(|_| AcpDispatchError::NotSent("OpenCode ACP 未启动"))?;
    let transport = handle
        .lock()
        .map_err(|_| AcpDispatchError::NotSent("OpenCode ACP 状态不可用"))?
        .transport
        .clone();
    transport.request_unbounded(
        "session/prompt",
        json!({
            "sessionId": native_session_id.as_str(),
            "prompt": [{"type": "text", "text": text}]
        }),
    )
}

pub(crate) fn cancel_session(
    runtime: &OpenCodeAcpRuntime,
    native_session_id: &NativeSessionId,
) -> Result<Vec<String>, AcpDispatchError> {
    let handle = running_connection(runtime)
        .map_err(|_| AcpDispatchError::NotSent("OpenCode ACP 未启动"))?;
    let transport = handle
        .lock()
        .map_err(|_| AcpDispatchError::NotSent("OpenCode ACP 状态不可用"))?
        .transport
        .clone();
    let cancelled_permissions =
        transport.cancel_pending_client_requests(native_session_id.as_str())?;
    transport.notify_timeout(
        "session/cancel",
        json!({"sessionId": native_session_id.as_str()}),
        ACP_NOTIFICATION_TIMEOUT,
    )?;
    Ok(cancelled_permissions)
}

fn respond_permission_blocking(
    runtime: OpenCodeAcpRuntime,
    store: HostStore,
    interactions: crate::interaction_registry::InteractionRegistry,
    input: OpenCodeAcpPermissionResponseInput,
) -> Result<Value, String> {
    let target = store.session_open_target(&input.farfold_session_id)?;
    if !is_acp_binding(&target.binding()) {
        return Err("Farfold Session is not bound to the OpenCode ACP Adapter".to_string());
    }
    if target.native_session_id != input.native_session_id {
        return Err("OpenCode ACP native Session does not match the Host binding".to_string());
    }
    let generation = verify_active_session(
        &runtime,
        &target.binding(),
        &target.working_copy_path,
        &target.native_session_id,
    )?;
    if generation != input.runtime_generation {
        return Err("OpenCode ACP permission belongs to a stale Runtime generation".to_string());
    }
    let transport = running_connection(&runtime)?
        .lock()
        .map_err(|_| "OpenCode ACP 状态不可用".to_string())?
        .transport
        .clone();
    interactions.begin_response(
        target.binding(),
        generation,
        &input.request_id,
        Some(input.native_session_id.as_str()),
    )?;
    let result = transport.respond_client_request(
        &input.request_id,
        json!({"outcome": "selected", "optionId": input.option_id}),
    );
    interactions.finish_response(
        target.binding(),
        generation,
        &input.request_id,
        !matches!(result, Err(AcpDispatchError::NotSent(_))),
    )?;
    result
        .map(|_| json!({ "ok": true }))
        .map_err(|error| error.to_string())
}

fn respond_question_blocking(
    runtime: OpenCodeAcpRuntime,
    store: HostStore,
    interactions: crate::interaction_registry::InteractionRegistry,
    input: OpenCodeAcpQuestionResponseInput,
) -> Result<Value, String> {
    let target = store.session_open_target(&input.farfold_session_id)?;
    if !is_acp_binding(&target.binding()) {
        return Err("Farfold Session is not bound to the OpenCode ACP Adapter".to_string());
    }
    if target.native_session_id != input.native_session_id {
        return Err("OpenCode ACP native Session does not match the Host binding".to_string());
    }
    let generation = verify_active_session(
        &runtime,
        &target.binding(),
        &target.working_copy_path,
        &target.native_session_id,
    )?;
    if generation != input.runtime_generation {
        return Err("OpenCode ACP question belongs to a stale Runtime generation".to_string());
    }
    let transport = running_connection(&runtime)?
        .lock()
        .map_err(|_| "OpenCode ACP 状态不可用".to_string())?
        .transport
        .clone();
    let action = match input.action.as_str() {
        "accept" => "accept",
        "decline" => "decline",
        "cancel" => "cancel",
        _ => return Err("OpenCode ACP question response action is unsupported".to_string()),
    };
    let response = if action == "accept" {
        let content = input
            .content
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "OpenCode ACP question accept response missing content".to_string())?;
        json!({"action":"accept","content":content})
    } else {
        json!({"action":action})
    };
    interactions.begin_response(
        target.binding(),
        generation,
        &input.request_id,
        Some(input.native_session_id.as_str()),
    )?;
    let result = transport.respond_client_request(&input.request_id, response);
    interactions.finish_response(
        target.binding(),
        generation,
        &input.request_id,
        !matches!(result, Err(AcpDispatchError::NotSent(_))),
    )?;
    result
        .map(|_| json!({ "ok": true }))
        .map_err(|error| error.to_string())
}

fn set_config_option_blocking(
    runtime: OpenCodeAcpRuntime,
    store: HostStore,
    turns: crate::turn_coordinator::TurnCoordinator,
    input: OpenCodeAcpSetConfigOptionInput,
) -> Result<OpenCodeAcpStatus, String> {
    if input.config_id.trim().is_empty() || input.config_id.len() > 128 {
        return Err("OpenCode ACP config id is invalid".to_string());
    }
    if let Some(value_type) = &input.value_type
        && value_type != "boolean"
    {
        return Err("OpenCode ACP config value type is unsupported".to_string());
    }
    let target = store.session_open_target(&input.farfold_session_id)?;
    if !is_acp_binding(&target.binding()) {
        return Err("Farfold Session is not bound to the OpenCode ACP Adapter".to_string());
    }
    if target.native_session_id != input.native_session_id {
        return Err("OpenCode ACP native Session does not match the Host binding".to_string());
    }
    if turns.has_active_session(&input.farfold_session_id)? {
        return Err(
            "OpenCode ACP 模型配置只能在当前会话空闲时变更；当前任务继续使用启动时配置。"
                .to_string(),
        );
    }
    let generation = verify_active_session(
        &runtime,
        &target.binding(),
        &target.working_copy_path,
        &target.native_session_id,
    )?;
    let handle = running_connection(&runtime)?;
    let (transport, operation_id) = {
        let mut connection = handle
            .lock()
            .map_err(|_| "OpenCode ACP 状态不可用".to_string())?;
        if connection.generation != generation
            || connection.binding != target.binding()
            || connection.session_id.as_deref() != Some(input.native_session_id.as_str())
        {
            return Err("OpenCode ACP 配置目标已变化；请重新选择会话".to_string());
        }
        let id = connection.operations.begin_config()?;
        (connection.transport.clone(), id)
    };
    let mut params = json!({
        "sessionId": input.native_session_id.as_str(),
        "configId": input.config_id,
        "value": input.value
    });
    if let Some(value_type) = input.value_type
        && let Some(object) = params.as_object_mut()
    {
        object.insert("type".to_string(), Value::String(value_type));
    }
    let response = transport
        .request_timeout("session/set_config_option", params, ACP_REQUEST_TIMEOUT)
        .map_err(|error| error.to_string())?;
    let mut connection = handle
        .lock()
        .map_err(|_| "OpenCode ACP 状态不可用".to_string())?;
    if connection.generation != generation
        || connection.binding != target.binding()
        || connection.session_id.as_deref() != Some(input.native_session_id.as_str())
        || !connection.operations.is_current_config(operation_id)
    {
        return Err("OpenCode ACP 配置响应已被新的连接或配置操作取代；晚到结果已丢弃".to_string());
    }
    if let Some(config_options) = response.get("configOptions") {
        connection.config_options = config_options.clone();
    } else {
        return Err("OpenCode ACP config response missing configOptions".to_string());
    }
    Ok(status_from_connection(&connection))
}

fn opencode_acp_new_session_blocking(
    runtime: OpenCodeAcpRuntime,
    router: RuntimeEventRouter,
    store: Option<HostStore>,
) -> Result<OpenCodeAcpSessionResult, String> {
    let handle = running_connection(&runtime)?;
    let (operation_id, transport, cwd) =
        begin_session_operation(&handle, AcpSessionOperationKind::New, None)?;
    let response = transport.request_timeout(
        "session/new",
        json!({"cwd": cwd, "mcpServers": []}),
        ACP_REQUEST_TIMEOUT,
    );
    complete_session_operation(
        &handle,
        operation_id,
        &router,
        store.as_ref(),
        response,
        None,
        false,
    )
}

#[cfg(test)]
fn opencode_acp_new_managed_session_blocking_with_app_data(
    app_data_root: &Path,
    runtime: OpenCodeAcpRuntime,
    router: RuntimeEventRouter,
    store: HostStore,
    input: OpenCodeAcpManagedSessionInput,
) -> Result<OpenCodeAcpSessionResult, String> {
    opencode_acp_start_blocking_with_app_data(
        app_data_root,
        runtime.clone(),
        router.clone(),
        OpenCodeAcpStartInput {
            binary_path: input.binary_path.clone(),
            cwd: input.cwd.clone(),
        },
        Some((store.clone(), input, true)),
        None,
    )?;
    match opencode_acp_new_session_blocking(runtime.clone(), router, Some(store)) {
        Ok(result) => Ok(result),
        Err(error) => {
            let _ = opencode_acp_stop_blocking(runtime);
            Err(error)
        }
    }
}

fn opencode_acp_load_session_blocking(
    runtime: OpenCodeAcpRuntime,
    router: RuntimeEventRouter,
    store: Option<HostStore>,
    input: OpenCodeAcpLoadInput,
) -> Result<OpenCodeAcpSessionResult, String> {
    let handle = running_connection(&runtime)?;
    let (operation_id, transport, cwd) = begin_session_operation(
        &handle,
        AcpSessionOperationKind::Load,
        Some(input.session_id.clone()),
    )?;
    let response = transport.request_timeout(
        "session/load",
        json!({"cwd": cwd, "sessionId": input.session_id.clone(), "mcpServers": []}),
        ACP_REQUEST_TIMEOUT,
    );
    complete_session_operation(
        &handle,
        operation_id,
        &router,
        store.as_ref(),
        response,
        Some(input.session_id),
        false,
    )
}

#[cfg(test)]
fn opencode_acp_close_session_blocking(
    runtime: OpenCodeAcpRuntime,
    router: RuntimeEventRouter,
) -> Result<OpenCodeAcpStatus, String> {
    let handle = running_connection(&runtime)?;
    let session_id = {
        let connection = handle
            .lock()
            .map_err(|_| "OpenCode ACP 状态不可用".to_string())?;
        connection.session_id.clone()
    };
    let Some(session_id) = session_id else {
        return current_status(&runtime, Some(&router));
    };
    let (operation_id, transport, _) = begin_session_operation(
        &handle,
        AcpSessionOperationKind::Close,
        Some(session_id.clone()),
    )?;
    let response = transport.request_timeout(
        "session/close",
        json!({"sessionId": session_id.clone()}),
        ACP_REQUEST_TIMEOUT,
    );
    complete_session_operation(
        &handle,
        operation_id,
        &router,
        None,
        response,
        Some(session_id),
        true,
    )
    .map(|result| result.status)
}

fn stop_idle_connection_for_host_switch(runtime: &OpenCodeAcpRuntime) -> Result<(), String> {
    {
        let state = runtime
            .state
            .lock()
            .map_err(|_| "OpenCode ACP 状态不可用")?;
        let OpenCodeAcpLifecycle::Running(handle) = &*state else {
            return Ok(());
        };
        let connection = handle.lock().map_err(|_| "OpenCode ACP 状态不可用")?;
        if connection.operations.is_pending() || connection.last_error.is_some() {
            return Err("OpenCode ACP 会话操作尚未确认，不能切换连接".into());
        }
        connection.transport.begin_idle_stop()?;
        connection.event_pump_stop.store(true, Ordering::Release);
    }
    let stopped = opencode_acp_stop_blocking(runtime.clone())?;
    if let Some(error) = stopped.last_error {
        return Err(error);
    }
    Ok(())
}

pub(crate) fn stop_idle_host_session(
    runtime: &OpenCodeAcpRuntime,
    binding: &RuntimeBinding,
    cwd: &Path,
    native_session_id: &NativeSessionId,
    generation: u64,
) -> Result<OpenCodeAcpStatus, String> {
    let _launch_guard = runtime
        .start_lock
        .lock()
        .map_err(|_| "OpenCode ACP 启动状态不可用")?;
    if verify_active_session(runtime, binding, cwd, native_session_id)? != generation {
        return Err("停止请求所属的 OpenCode ACP 进程已经变化".into());
    }
    stop_idle_connection_for_host_switch(runtime)?;
    let mut stopped = current_status(runtime, None)?;
    stopped.generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
    Ok(stopped)
}

pub(crate) fn stop_session_for_host_recovery(
    runtime: &OpenCodeAcpRuntime,
    binding: &RuntimeBinding,
    cwd: &Path,
    native_session_id: &NativeSessionId,
    generation: u64,
) -> Result<OpenCodeAcpStatus, String> {
    let _launch_guard = runtime
        .start_lock
        .lock()
        .map_err(|_| "OpenCode ACP 启动状态不可用")?;
    if verify_active_session(runtime, binding, cwd, native_session_id)? != generation {
        return Err("恢复请求所属的 OpenCode ACP 进程已经变化。".into());
    }
    let handle = running_connection(runtime)?;
    let transport = handle
        .lock()
        .map_err(|_| "OpenCode ACP 状态不可用")?
        .transport
        .clone();
    let mut stopped = opencode_acp_stop_blocking(runtime.clone())?;
    if transport.is_running()? {
        return Err("OpenCode ACP 自有进程尚未确认退出，任务占用仍保留。".into());
    }
    // Process exit permits releasing occupancy, never claiming task success.
    stopped.generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
    Ok(stopped)
}

fn opencode_acp_stop_blocking(runtime: OpenCodeAcpRuntime) -> Result<OpenCodeAcpStatus, String> {
    let mut state = runtime
        .state
        .lock()
        .map_err(|_| "OpenCode ACP 状态不可用".to_string())?;
    let generation = runtime.generation.load(Ordering::SeqCst);
    let OpenCodeAcpLifecycle::Running(connection) =
        std::mem::replace(&mut *state, OpenCodeAcpLifecycle::Stopped)
    else {
        return Ok(stopped_status(generation));
    };
    let (transport, mut status, private_launch_dir) = {
        let connection = connection
            .lock()
            .map_err(|_| "OpenCode ACP 状态不可用".to_string())?;
        connection.event_pump_stop.store(true, Ordering::Release);
        (
            connection.transport.clone(),
            status_from_connection(&connection),
            connection.private_launch_dir.clone(),
        )
    };
    drop(state);
    status.running = false;
    status.state = "stopped";
    let stopped = match transport.stop() {
        Ok(()) => true,
        Err(error) => {
            status.last_error = Some(error);
            false
        }
    };
    if stopped && let Some(private_launch_dir) = private_launch_dir {
        let _ = fs::remove_dir_all(private_launch_dir);
    }
    Ok(status)
}

#[tauri::command]
pub async fn opencode_acp_status(
    runtime: State<'_, OpenCodeAcpRuntime>,
    router: State<'_, RuntimeEventRouter>,
) -> Result<OpenCodeAcpStatus, String> {
    let runtime = runtime.inner().clone();
    let router = router.inner().clone();
    tauri::async_runtime::spawn_blocking(move || opencode_acp_status_blocking(runtime, router))
        .await
        .map_err(|_| "读取 OpenCode ACP 状态被中断".to_string())?
}

#[tauri::command]
pub async fn opencode_acp_permission_respond(
    runtime: State<'_, OpenCodeAcpRuntime>,
    store: State<'_, HostStore>,
    interactions: State<'_, crate::interaction_registry::InteractionRegistry>,
    input: OpenCodeAcpPermissionResponseInput,
) -> Result<Value, String> {
    let runtime = runtime.inner().clone();
    let store = store.inner().clone();
    let interactions = interactions.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        respond_permission_blocking(runtime, store, interactions, input)
    })
    .await
    .map_err(|_| "OpenCode ACP 权限回复被中断".to_string())?
}

#[tauri::command]
pub async fn opencode_acp_question_respond(
    runtime: State<'_, OpenCodeAcpRuntime>,
    store: State<'_, HostStore>,
    interactions: State<'_, crate::interaction_registry::InteractionRegistry>,
    input: OpenCodeAcpQuestionResponseInput,
) -> Result<Value, String> {
    let runtime = runtime.inner().clone();
    let store = store.inner().clone();
    let interactions = interactions.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        respond_question_blocking(runtime, store, interactions, input)
    })
    .await
    .map_err(|_| "OpenCode ACP 提问回复被中断".to_string())?
}

#[tauri::command]
pub async fn opencode_acp_set_config_option(
    runtime: State<'_, OpenCodeAcpRuntime>,
    store: State<'_, HostStore>,
    turns: State<'_, crate::turn_coordinator::TurnCoordinator>,
    input: OpenCodeAcpSetConfigOptionInput,
) -> Result<OpenCodeAcpStatus, String> {
    let runtime = runtime.inner().clone();
    let store = store.inner().clone();
    let turns = turns.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        set_config_option_blocking(runtime, store, turns, input)
    })
    .await
    .map_err(|_| "OpenCode ACP 配置更新被中断".to_string())?
}

// Slice B boundary only: the Adapter carries the real bound identity, but the
// production paths above still drive the Runtime directly. Wiring happens in the
// authentication/model-selection and send/stop slices.
#[allow(dead_code)]
pub(crate) struct OpenCodeAcpAdapter {
    binding: RuntimeBinding,
}

#[allow(dead_code)]
impl OpenCodeAcpAdapter {
    pub(crate) fn new(binding: RuntimeBinding) -> AcpResult<Self> {
        if !is_acp_binding(&binding) {
            return Err(AcpAdapterError::Unsupported(
                "OpenCode ACP adapter requires an OpenCode ACP binding".to_string(),
            ));
        }
        Ok(Self { binding })
    }

    fn not_wired<T>() -> AcpResult<T> {
        Err(AcpAdapterError::Unsupported(
            "OpenCode ACP adapter 尚未接入 Host 调用路径".to_string(),
        ))
    }
}

impl AcpRuntimeAdapter for OpenCodeAcpAdapter {
    fn identity(&self) -> RuntimeIdentity {
        self.binding.identity()
    }

    fn expected_adapter_version(&self) -> &str {
        OPENCODE_ACP_VERSION_FOR_ADAPTER
    }

    fn spawn_and_initialize(&self, _cwd: PathBuf) -> AcpFuture<Arc<AcpTransport>> {
        Box::pin(async move { Self::not_wired() })
    }

    fn new_session(
        &self,
        _transport: Arc<AcpTransport>,
        _working_copy: PathBuf,
    ) -> AcpFuture<Value> {
        Box::pin(async move { Self::not_wired() })
    }

    fn load_session(
        &self,
        _transport: Arc<AcpTransport>,
        _native_session_id: String,
        _working_copy: PathBuf,
    ) -> AcpFuture<Value> {
        Box::pin(async move { Self::not_wired() })
    }

    fn close_session(
        &self,
        _transport: Arc<AcpTransport>,
        _native_session_id: String,
    ) -> AcpFuture<Value> {
        Box::pin(async move { Self::not_wired() })
    }

    fn set_config_option(
        &self,
        _transport: Arc<AcpTransport>,
        _native_session_id: String,
        _option_id: String,
        _value: Value,
        _value_type: Option<String>,
    ) -> AcpFuture<Value> {
        Box::pin(async move { Self::not_wired() })
    }

    fn send_prompt(
        &self,
        _transport: Arc<AcpTransport>,
        _native_session_id: String,
        _text: String,
    ) -> AcpFuture<Value> {
        Box::pin(async move { Self::not_wired() })
    }

    fn stop_turn(
        &self,
        _transport: Arc<AcpTransport>,
        _native_session_id: String,
        _native_request: Value,
    ) -> AcpFuture<Value> {
        Box::pin(async move { Self::not_wired() })
    }

    fn respond_client_request(
        &self,
        _transport: Arc<AcpTransport>,
        _request_id: &str,
        _response: Value,
    ) -> AcpResult<()> {
        Self::not_wired()
    }

    fn map_event(&self, event: Value) -> AcpResult<Value> {
        Ok(event)
    }
}

#[cfg(test)]
pub(crate) mod tests;
