use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::thread;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex, atomic::Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};

use crate::acp_provider_profile::{protect_directory, safe_path_segment};

use crate::{
    acp_runtime::{AcpEventConnection, AcpLifecycle, AcpRuntime, start_event_pump},
    acp_session_operations::{AcpSessionOperationKind, AcpSessionOperations},
    acp_transport::{AcpDispatchError, AcpTransport},
    host_ids::{
        AdapterId, ConnectionId, FarfoldSessionId, InstallationId, NativeSessionId,
        ProviderConfigVersionId, ProviderConnectionId, RuntimeBuildId, RuntimeProductId,
        derived_host_id,
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
    runtime_registry::{RuntimeBinding},
};

pub mod status;
pub use status::*;

const OPENCODE_ACP_VERSION: &str = "1.18.30";
pub(crate) const OPENCODE_ACP_VERSION_FOR_ADAPTER: &str = OPENCODE_ACP_VERSION;
const OPENCODE_ACP_BINARY_SHA256: &str =
    "2d0c9c339bb91046c6ea951c97664bc2f8a8eaca707f31fbfbb7bc73c4eddc62";
const OPENCODE_ACP_ADAPTER_ID: &str = "opencode-acp-stdio-v1";
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);
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



fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
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

fn binary_sha256(path: &Path) -> Result<String, String> {
    let mut file =
        fs::File::open(path).map_err(|error| format!("无法读取 OpenCode ACP 程序：{error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("无法读取 OpenCode ACP 程序：{error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn verify_acp_binary(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("OpenCode ACP 程序路径必须是绝对路径".to_string());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("无法解析 OpenCode ACP 程序路径：{error}"))?;
    if !canonical.is_file() {
        return Err("OpenCode ACP 程序路径不是文件".to_string());
    }
    let observed_sha = binary_sha256(&canonical)?;
    if observed_sha != OPENCODE_ACP_BINARY_SHA256 {
        return Err(format!(
            "OpenCode ACP 程序 SHA-256 不匹配；期望 {OPENCODE_ACP_BINARY_SHA256}，实际 {observed_sha}"
        ));
    }
    let mut child = Command::new(&canonical)
        .arg("--version")
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| format!("无法核验 OpenCode ACP 版本：{error}"))?;
    let deadline = std::time::Instant::now() + VERSION_TIMEOUT;
    while std::time::Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                let mut stdout = String::new();
                if let Some(mut pipe) = child.stdout.take() {
                    let _ = pipe.read_to_string(&mut stdout);
                }
                let version = stdout.trim();
                if version == OPENCODE_ACP_VERSION {
                    return Ok(canonical);
                }
                return Err(format!(
                    "OpenCode ACP 版本不匹配；期望 {OPENCODE_ACP_VERSION}，实际 {version}"
                ));
            }
            Ok(Some(status)) => {
                return Err(format!("OpenCode ACP 版本核验异常退出：{status}"));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(error) => return Err(format!("无法核验 OpenCode ACP 版本：{error}")),
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    Err("OpenCode ACP 版本核验超时".to_string())
}

fn acp_binding(binary_path: &Path) -> Result<RuntimeBinding, String> {
    acp_binding_for_discriminator(binary_path, "stdio")
}

fn managed_acp_binding(
    binary_path: &Path,
    provider_connection_id: &ProviderConnectionId,
    provider_config_version_id: &ProviderConfigVersionId,
) -> Result<RuntimeBinding, String> {
    acp_binding_for_discriminator(
        binary_path,
        &format!(
            "managed:{}:{}",
            provider_connection_id.as_str(),
            provider_config_version_id.as_str()
        ),
    )
}

fn managed_acp_registered_binding(
    store: &HostStore,
    binary_path: &Path,
    provider_connection_id: &ProviderConnectionId,
    provider_config_version_id: &ProviderConfigVersionId,
) -> Result<RuntimeBinding, String> {
    let mut binding = managed_acp_binding(
        binary_path,
        provider_connection_id,
        provider_config_version_id,
    )?;
    if let Some(saved) = store
        .runtime_system_installations(&binding.product_id)?
        .into_iter()
        .find(|saved| saved.selected_path == binary_path)
    {
        binding.installation_id = saved.installation_id;
        binding.runtime_build_id = saved.runtime_build_id;
        binding.connection_id = managed_acp_connection_id(
            &binding.installation_id,
            provider_connection_id,
            provider_config_version_id,
        )?;
        verified_saved_acp_binding(store, &binding)?;
    }
    Ok(binding)
}

fn managed_acp_connection_id(
    installation_id: &InstallationId,
    provider_connection_id: &ProviderConnectionId,
    provider_config_version_id: &ProviderConfigVersionId,
) -> Result<ConnectionId, String> {
    ConnectionId::parse(derived_host_id(
        "connection",
        &[
            installation_id.as_str(),
            OPENCODE_ACP_ADAPTER_ID,
            &format!(
                "managed:{}:{}",
                provider_connection_id.as_str(),
                provider_config_version_id.as_str()
            ),
        ],
    ))
    .map_err(|error| error.to_string())
}

fn acp_binding_for_discriminator(
    binary_path: &Path,
    connection_discriminator: &str,
) -> Result<RuntimeBinding, String> {
    let installation = derived_host_id("system-opencode-acp", &[&binary_path.to_string_lossy()]);
    let runtime_build_id =
        format!("opencode@{OPENCODE_ACP_VERSION}+sha256:{OPENCODE_ACP_BINARY_SHA256}");
    let connection = derived_host_id(
        "connection",
        &[
            &installation,
            OPENCODE_ACP_ADAPTER_ID,
            connection_discriminator,
        ],
    );
    Ok(RuntimeBinding {
        product_id: RuntimeProductId::parse("opencode").map_err(|error| error.to_string())?,
        installation_id: InstallationId::parse(installation).map_err(|error| error.to_string())?,
        runtime_build_id: RuntimeBuildId::parse(runtime_build_id)
            .map_err(|error| error.to_string())?,
        adapter_id: AdapterId::parse(OPENCODE_ACP_ADAPTER_ID).map_err(|error| error.to_string())?,
        connection_id: ConnectionId::parse(connection).map_err(|error| error.to_string())?,
    })
}

pub(crate) fn is_acp_binding(binding: &RuntimeBinding) -> bool {
    binding.product_id.as_str() == "opencode"
        && binding.adapter_id.as_str() == OPENCODE_ACP_ADAPTER_ID
}

fn acp_launch_record(binary_path: &Path) -> OpenCodeAcpLaunchRecord {
    OpenCodeAcpLaunchRecord {
        kind: "opencode_acp_stdio".to_string(),
        adapter_id: OPENCODE_ACP_ADAPTER_ID.to_string(),
        binary_path: binary_path.to_path_buf(),
        version: OPENCODE_ACP_VERSION.to_string(),
        sha256: OPENCODE_ACP_BINARY_SHA256.to_string(),
        question_bridge: false,
    }
}

pub(crate) fn verified_acp_creation_target(
    store: &HostStore,
    installation_id: &str,
    connection_id: &str,
) -> Result<(RuntimeBinding, PathBuf), String> {
    let key = crate::runtime_registry::ManagedRuntimeKey::OpencodeAcp;
    let saved = store
        .runtime_system_installations(&RuntimeProductId::parse("opencode").unwrap())?
        .into_iter()
        .filter_map(|record| crate::runtime_registry::saved_from_installation(key, record).ok())
        .find(|saved| saved.installation_id == installation_id)
        .ok_or("找不到已登记的 OpenCode ACP 安装")?;
    let (mut binding, path) = crate::runtime_registry::verified_system_runtime_binding(
        store,
        key,
        installation_id,
        &saved.connection_id,
    )?;
    if connection_id != saved.connection_id {
        binding.connection_id =
            ConnectionId::parse(connection_id).map_err(|error| error.to_string())?;
        let provider = managed_provider_for_runtime_target(store, &binding)?
            .ok_or("找不到这个安装下已登记的 ACP 托管连接")?;
        if managed_acp_connection_id(
            &binding.installation_id,
            &provider.provider_connection_id,
            &provider.provider_config_version_id,
        )? != binding.connection_id
        {
            return Err("ACP 托管连接与固定配置版本不一致".into());
        }
    }
    Ok((binding, path))
}

fn verified_saved_acp_binding(
    store: &HostStore,
    binding: &RuntimeBinding,
) -> Result<PathBuf, String> {
    if !is_acp_binding(binding) {
        return Err("Host Session is not an OpenCode ACP binding".to_string());
    }
    let saved = store
        .runtime_system_installations(&binding.product_id)?
        .into_iter()
        .find(|entry| {
            entry.installation_id == binding.installation_id
                && entry.runtime_build_id == binding.runtime_build_id
        })
        .ok_or("找不到已登记的 OpenCode ACP 程序")?;
    let launch_json: Value = serde_json::from_str(&saved.launch_json)
        .map_err(|_| "已保存的 OpenCode ACP 启动记录无效；不能启动".to_string())?;
    let launch_path =
        if launch_json.get("kind").and_then(Value::as_str) == Some("opencode_acp_stdio") {
            let launch: OpenCodeAcpLaunchRecord = serde_json::from_value(launch_json)
                .map_err(|_| "已保存的 OpenCode ACP 启动记录无效；不能启动".to_string())?;
            if launch.adapter_id != OPENCODE_ACP_ADAPTER_ID
                || launch.version != OPENCODE_ACP_VERSION
                || launch.sha256 != OPENCODE_ACP_BINARY_SHA256
            {
                return Err("OpenCode ACP 启动记录与持久构建身份不一致；不能启动".to_string());
            }
            launch.binary_path
        } else {
            let runtime = launch_json
                .get("runtime")
                .ok_or_else(|| "已保存的 OpenCode ACP 启动记录无效；不能启动".to_string())?;
            if runtime.get("productId").and_then(Value::as_str) != Some(binding.product_id.as_str())
                || runtime.get("installationId").and_then(Value::as_str)
                    != Some(binding.installation_id.as_str())
                || runtime.get("adapterId").and_then(Value::as_str) != Some(OPENCODE_ACP_ADAPTER_ID)
                || launch_json.get("observedVersion").and_then(Value::as_str)
                    != Some(OPENCODE_ACP_VERSION)
                || launch_json.get("artifactSha256").and_then(Value::as_str)
                    != Some(OPENCODE_ACP_BINARY_SHA256)
                || launch_json.get("compatible").and_then(Value::as_bool) != Some(true)
            {
                return Err("OpenCode ACP 启动记录与持久构建身份不一致；不能启动".to_string());
            }
            PathBuf::from(
                launch_json
                    .get("canonicalPath")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        "已保存的 OpenCode ACP 启动记录缺少程序路径；不能启动".to_string()
                    })?,
            )
        };
    if saved.observed_version != OPENCODE_ACP_VERSION
        || saved.artifact_sha256 != OPENCODE_ACP_BINARY_SHA256
    {
        return Err("OpenCode ACP 启动记录与持久构建身份不一致；不能启动".to_string());
    }
    let binary_path = verify_acp_binary(&launch_path)?;
    if binary_path != saved.selected_path {
        return Err("OpenCode ACP 程序路径与持久启动记录不一致；请重新核验".to_string());
    }
    Ok(binary_path)
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

fn managed_provider_for_runtime_target(
    store: &HostStore,
    binding: &RuntimeBinding,
) -> Result<Option<OpenCodeAcpManagedProviderBinding>, String> {
    for connection in store.provider_connections_by_source(
        crate::host_store::provider_projection::ProviderConnectionSource::FarfoldManaged,
    )? {
        let snapshot = store.provider_projection_snapshot(&connection.provider_connection_id)?;
        for projection in snapshot.projections {
            if projection.runtime_product_id == binding.product_id
                && projection.installation_id == binding.installation_id
                && projection.runtime_connection_id == binding.connection_id
                && projection.apply_state == ProviderApplyState::Applied
                && projection.save_state == ProviderSaveState::Saved
            {
                return Ok(Some(OpenCodeAcpManagedProviderBinding {
                    provider_connection_id: projection.provider_connection_id,
                    provider_config_version_id: projection.config_version_id,
                    runtime_provider_id: projection.runtime_provider_id,
                    runtime_model_id: projection.runtime_model_id,
                }));
            }
            if projection.runtime_product_id == binding.product_id
                && projection.installation_id == binding.installation_id
                && projection.runtime_connection_id == binding.connection_id
                && projection.save_state == ProviderSaveState::Saved
                && matches!(
                    projection.apply_state,
                    ProviderApplyState::Applied | ProviderApplyState::Pending
                )
            {
                for version in
                    store.provider_connection_versions(&projection.provider_connection_id)?
                {
                    if managed_acp_connection_id(
                        &binding.installation_id,
                        &version.provider_connection_id,
                        &version.config_version_id,
                    )? == binding.connection_id
                    {
                        return Ok(Some(OpenCodeAcpManagedProviderBinding {
                            provider_connection_id: projection.provider_connection_id,
                            provider_config_version_id: version.config_version_id,
                            runtime_provider_id: projection.runtime_provider_id,
                            runtime_model_id: projection.runtime_model_id,
                        }));
                    }
                }
            }
        }
    }
    Ok(None)
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

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::host_store::provider_projection::TurnProviderBindingAuthority;

    #[test]
    fn acp_binding_uses_distinct_protocol_identity() {
        let binding = acp_binding(&PathBuf::from("/tmp/opencode")).unwrap();
        assert_eq!(binding.product_id.as_str(), "opencode");
        assert_eq!(binding.adapter_id.as_str(), OPENCODE_ACP_ADAPTER_ID);
        assert_ne!(
            binding.connection_id.as_str(),
            crate::runtime_registry::OPENCODE_RUNTIME.default_connection_id
        );
    }

    #[test]
    fn acp_native_session_registers_host_navigation_identity() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let store = HostStore::open(temp.path().join("host.sqlite3"));
        let binding = acp_binding(Path::new("/tmp/opencode")).unwrap();

        let (farfold_session_id, navigation) = register_acp_runtime_and_session(
            &store,
            &binding,
            &workspace,
            Path::new("/tmp/opencode"),
            "ses_acp_host",
        )
        .map(|(session_id, _, navigation)| (session_id, navigation))
        .unwrap();

        let restore_state = serde_json::to_value(navigation.restore_state.as_ref().unwrap())
            .expect("restore state serializes for frontend navigation");
        assert_eq!(restore_state["lastSessionId"], farfold_session_id.as_str());
        let restore_updated_at = restore_state["updatedAt"].as_i64().unwrap();
        let session = navigation
            .session_index
            .sessions
            .iter()
            .find(|session| session.farfold_session_id == farfold_session_id)
            .unwrap();
        assert_eq!(session.runtime_product_id, binding.product_id);
        assert_eq!(session.installation_id, binding.installation_id);
        assert_eq!(session.runtime_build_id, binding.runtime_build_id);
        assert_eq!(session.adapter_id.as_str(), OPENCODE_ACP_ADAPTER_ID);
        assert_eq!(session.connection_id, binding.connection_id);
        assert_eq!(session.native_session_id.as_str(), "ses_acp_host");
        assert_eq!(
            session.working_copy_path,
            workspace.canonicalize().unwrap().to_string_lossy()
        );
        assert_eq!(session.title, "OpenCode ACP");
        assert_eq!(session.last_opened_at, restore_updated_at);
    }

    #[test]
    #[ignore = "set OPENCODE_ACP_TEST_BINARY to the fixed opencode 1.18.30 arm64 binary"]
    fn fixed_opencode_acp_registry_record_survives_session_registration_and_restore() {
        let binary = std::env::var("OPENCODE_ACP_TEST_BINARY")
            .expect("OPENCODE_ACP_TEST_BINARY must point to opencode 1.18.30");
        let binary = verify_acp_binary(&PathBuf::from(binary)).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let store = HostStore::open(temp.path().join("host.sqlite3"));
        let installation = derived_host_id(
            "system-installation",
            &["opencode", &binary.to_string_lossy()],
        );
        let runtime_build_id = derived_host_id(
            "runtime-build",
            &[
                &installation,
                OPENCODE_ACP_VERSION,
                OPENCODE_ACP_BINARY_SHA256,
            ],
        );
        let connection = derived_host_id("connection", &[&installation, OPENCODE_ACP_ADAPTER_ID]);
        let binding = RuntimeBinding {
            product_id: RuntimeProductId::parse("opencode").unwrap(),
            installation_id: InstallationId::parse(installation.clone()).unwrap(),
            runtime_build_id: RuntimeBuildId::parse(runtime_build_id).unwrap(),
            adapter_id: AdapterId::parse(OPENCODE_ACP_ADAPTER_ID).unwrap(),
            connection_id: ConnectionId::parse(connection).unwrap(),
        };
        let now = i64::try_from(now_millis()).unwrap();
        let inspection = json!({
            "runtime": {
                "productId": "opencode",
                "installationId": installation,
                "adapterId": OPENCODE_ACP_ADAPTER_ID,
            },
            "displayName": "OpenCode ACP",
            "selectedPath": binary.clone(),
            "canonicalPath": binary.clone(),
            "source": "manual",
            "distribution": "system",
            "observedVersion": OPENCODE_ACP_VERSION,
            "expectedVersion": OPENCODE_ACP_VERSION,
            "artifactSha256": OPENCODE_ACP_BINARY_SHA256,
            "expectedSha256": OPENCODE_ACP_BINARY_SHA256,
            "compatible": true,
            "launchReferenceAvailable": true,
            "activation": "checked_not_active",
            "verifiedAt": now,
        });
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
        let launch_json = inspection.to_string();
        store
            .accept_runtime_system_installation(&registration, &binary, &launch_json, now)
            .unwrap();

        let (verified_binding, verified_path) =
            crate::runtime_registry::verified_system_runtime_binding(
                &store,
                crate::runtime_registry::ManagedRuntimeKey::OpencodeAcp,
                binding.installation_id.as_str(),
                binding.connection_id.as_str(),
            )
            .unwrap();
        assert_eq!(verified_binding, binding);
        assert_eq!(verified_path, binary);
        register_acp_runtime_and_session(&store, &binding, &workspace, &binary, "ses_registry_acp")
            .unwrap();
        let saved = store
            .runtime_system_installations(&binding.product_id)
            .unwrap()
            .into_iter()
            .find(|record| record.installation_id == binding.installation_id)
            .unwrap();
        assert_eq!(saved.launch_json, launch_json);
        assert!(
            crate::runtime_registry::saved_from_installation(
                crate::runtime_registry::ManagedRuntimeKey::OpencodeAcp,
                saved,
            )
            .is_ok()
        );
        assert_eq!(
            verified_saved_acp_binding(&store, &binding).unwrap(),
            binary
        );
        let managed = managed_acp_registered_binding(
            &store,
            &binary,
            &ProviderConnectionId::parse("provider-registry-qa").unwrap(),
            &ProviderConfigVersionId::parse("config-registry-qa").unwrap(),
        )
        .unwrap();
        assert_eq!(managed.installation_id, binding.installation_id);
        assert_eq!(managed.runtime_build_id, binding.runtime_build_id);
        assert_ne!(managed.connection_id, binding.connection_id);
        register_acp_runtime_and_session(
            &store,
            &managed,
            &workspace,
            &binary,
            "ses_registry_managed_acp",
        )
        .unwrap();
        assert_eq!(
            store
                .runtime_system_installations(&binding.product_id)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    #[ignore = "set OPENCODE_ACP_TEST_BINARY to the fixed opencode 1.18.30 arm64 binary"]
    fn fixed_opencode_acp_host_create_open_and_reuse_registry_installation_without_model_turn() {
        let binary = std::env::var("OPENCODE_ACP_TEST_BINARY")
            .expect("OPENCODE_ACP_TEST_BINARY must point to opencode 1.18.30");
        let binary = verify_acp_binary(&PathBuf::from(binary)).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let app_data_root = temp.path().join("app-data");
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&app_data_root).unwrap();
        std::fs::create_dir(&workspace).unwrap();
        let store = HostStore::open(temp.path().join("host.sqlite3"));
        let inspection = crate::runtime_registry::inspect_managed_runtime_candidate(
            crate::runtime_registry::ManagedRuntimeCandidateInput {
                runtime: crate::runtime_registry::ManagedRuntimeKey::OpencodeAcp,
                path: binary.clone(),
                source: Some(crate::runtime_registry::ManagedRuntimeCandidateSource::Manual),
            },
        )
        .unwrap();
        assert!(inspection.compatible);
        let registration = crate::runtime_registry::managed_system_registration(&inspection)
            .expect("compatible ACP inspection can become a system registration");
        let inspection_json = serde_json::to_string(&inspection).unwrap();
        store
            .accept_runtime_system_installation(
                &registration,
                &inspection.canonical_path,
                &inspection_json,
                inspection.verified_at,
            )
            .unwrap();
        let (binding, verified_path) = crate::runtime_registry::verified_system_runtime_binding(
            &store,
            crate::runtime_registry::ManagedRuntimeKey::OpencodeAcp,
            registration.installation_id.as_str(),
            registration.connection_id.as_str(),
        )
        .unwrap();
        assert_eq!(verified_path, binary);

        let runtime = OpenCodeAcpRuntime::default();
        let created = create_registered_host_session_with_app_data(
            &app_data_root,
            runtime.clone(),
            RuntimeEventRouter::default(),
            store.clone(),
            OpenCodeAcpHostCreateInput {
                binding: binding.clone(),
                binary_path: binary.clone(),
                working_copy_path: workspace.clone(),
                managed_provider: None,
            },
        )
        .unwrap();
        assert_eq!(created.installation_id, binding.installation_id.as_str());
        assert!(created.runtime_generation > 0);
        let stopped = opencode_acp_stop_blocking(runtime).unwrap();
        assert_eq!(stopped.state, "stopped");

        let reopened_runtime = OpenCodeAcpRuntime::default();
        let reopened = open_registered_host_session_with_app_data(
            &app_data_root,
            reopened_runtime.clone(),
            RuntimeEventRouter::default(),
            store.clone(),
            OpenCodeAcpHostOpenInput {
                binding: binding.clone(),
                farfold_session_id: created.farfold_session_id.clone(),
                working_copy_path: workspace.clone(),
                native_session_id: created.native_session_id.clone(),
            },
        )
        .unwrap();
        assert!(reopened.runtime_generation > 0);
        let stopped = opencode_acp_stop_blocking(reopened_runtime).unwrap();
        assert_eq!(stopped.state, "stopped");

        let saved = store
            .runtime_system_installations(&binding.product_id)
            .unwrap()
            .into_iter()
            .find(|record| record.installation_id == binding.installation_id)
            .unwrap();
        assert_eq!(saved.launch_json, inspection_json);
        let listed = crate::runtime_registry::saved_from_installation(
            crate::runtime_registry::ManagedRuntimeKey::OpencodeAcp,
            saved,
        )
        .unwrap();

        let reused_runtime = OpenCodeAcpRuntime::default();
        let reused = create_registered_host_session_with_app_data(
            &app_data_root,
            reused_runtime.clone(),
            RuntimeEventRouter::default(),
            store.clone(),
            OpenCodeAcpHostCreateInput {
                binding: binding.clone(),
                binary_path: listed.inspection.canonical_path.clone(),
                working_copy_path: workspace.clone(),
                managed_provider: None,
            },
        )
        .unwrap();
        assert!(reused.runtime_generation > 0);
        let stopped = opencode_acp_stop_blocking(reused_runtime).unwrap();
        assert_eq!(stopped.state, "stopped");

        let provider = crate::managed_provider::save_api_key_in_dir(
            &app_data_root,
            Some(&store),
            crate::managed_provider::ManagedProviderApiKeySaveInput {
                provider_key: "openai".into(),
                label: "Host create fixture".into(),
                account_label: "qa".into(),
                endpoint: "https://fixture.example.invalid/v1".into(),
                api_kind: "openai-chat-completions".into(),
                api_key: "fixture-not-a-secret".into(),
                model_id: "fixture-model".into(),
                context_window: Some(128000),
                max_tokens: Some(8192),
                reasoning: Some(false),
                image_input: Some(false),
                supports_developer_role: Some(false),
                supports_reasoning_effort: Some(false),
            },
        )
        .unwrap();
        let runtime = OpenCodeAcpRuntime::default();
        let router = RuntimeEventRouter::default();
        let managed = create_registered_host_session_with_app_data(
            &app_data_root,
            runtime.clone(),
            router.clone(),
            store.clone(),
            OpenCodeAcpHostCreateInput {
                binding: binding.clone(),
                binary_path: binary.clone(),
                working_copy_path: workspace.clone(),
                managed_provider: Some(crate::managed_provider::ManagedProviderSelection {
                    provider_connection_id: provider.provider_connection_id.clone(),
                    provider_config_version_id: provider.current_config_version_id.clone(),
                }),
            },
        )
        .unwrap();
        let target = store
            .session_open_target(&managed.farfold_session_id)
            .unwrap();
        assert_ne!(target.connection_id, binding.connection_id);
        assert_eq!(
            verified_acp_creation_target(
                &store,
                target.installation_id.as_str(),
                target.connection_id.as_str()
            )
            .unwrap()
            .0,
            target.binding()
        );
        assert!(
            verified_acp_creation_target(
                &store,
                target.installation_id.as_str(),
                "connection-unknown"
            )
            .is_err()
        );
        let inherited = create_registered_host_session_with_app_data(
            &app_data_root,
            runtime.clone(),
            router,
            store.clone(),
            OpenCodeAcpHostCreateInput {
                binding: target.binding(),
                binary_path: binary,
                working_copy_path: workspace,
                managed_provider: None,
            },
        )
        .unwrap();
        let next = store
            .session_open_target(&inherited.farfold_session_id)
            .unwrap();
        assert_eq!(next.connection_id, target.connection_id);
        assert_ne!(next.native_session_id, target.native_session_id);
        assert!(
            current_status(&runtime, None)
                .unwrap()
                .managed_provider
                .unwrap()
                .runtime_model_id
                .ends_with("/fixture-model")
        );
        opencode_acp_stop_blocking(runtime).unwrap();
    }

    fn fixture_connection(script_body: &str) -> (tempfile::TempDir, OpenCodeAcpConnection) {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("fixture.py");
        std::fs::write(&script, script_body).unwrap();
        let transport =
            Arc::new(AcpTransport::spawn(Command::new("/usr/bin/python3").arg(script)).unwrap());
        let binding = acp_binding(Path::new("/tmp/opencode")).unwrap();
        (
            temp,
            OpenCodeAcpConnection {
                transport,
                binding,
                generation: 1,
                cwd: PathBuf::from("/tmp"),
                binary_path: PathBuf::from("/tmp/opencode"),
                session_id: Some("ses_keep".to_string()),
                agent_name: Some("OpenCode".to_string()),
                agent_version: OPENCODE_ACP_VERSION.to_string(),
                protocol_version: 1,
                question_bridge: false,
                load_session: true,
                config_options: json!([]),
                managed_provider: None,
                private_launch_dir: None,
                last_error: None,
                dropped_events: 0,
                initialized_at_ms: 1,
                operations: AcpSessionOperations::default(),
                event_pump_stop: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            },
        )
    }

    #[cfg(test)]
    pub(crate) struct ChatFixtureServer {
        pub(crate) port: u16,
        pub(crate) captured: Arc<Mutex<Vec<(String, String, Value)>>>,
        stop: Arc<std::sync::atomic::AtomicBool>,
        handle: Option<thread::JoinHandle<()>>,
    }

    impl ChatFixtureServer {
        pub(crate) fn start() -> Self {
            use std::{
                io::{Read as _, Write as _},
                net::{TcpListener, TcpStream},
            };

            fn read_chunked_body(mut stream: &TcpStream) -> Result<Vec<u8>, String> {
                let mut body = Vec::new();
                loop {
                    let mut line = Vec::new();
                    let mut byte = [0_u8; 1];
                    loop {
                        stream
                            .read_exact(&mut byte)
                            .map_err(|error| format!("cannot read chunk header: {error}"))?;
                        line.push(byte[0]);
                        if line.ends_with(b"\r\n") {
                            break;
                        }
                    }
                    let line_text = String::from_utf8(line)
                        .map_err(|error| format!("chunk header is not utf8: {error}"))?;
                    let size_hex = line_text
                        .split(';')
                        .next()
                        .ok_or("chunk header is empty")?
                        .trim();
                    let size = usize::from_str_radix(size_hex, 16)
                        .map_err(|error| format!("chunk size is invalid: {error}"))?;
                    if size == 0 {
                        let mut trailer_end = Vec::new();
                        loop {
                            stream
                                .read_exact(&mut byte)
                                .map_err(|error| format!("cannot read chunk trailer: {error}"))?;
                            trailer_end.push(byte[0]);
                            if trailer_end.ends_with(b"\r\n\r\n") || trailer_end == b"\r\n" {
                                break;
                            }
                        }
                        return Ok(body);
                    }
                    let start = body.len();
                    body.resize(start + size, 0);
                    stream
                        .read_exact(&mut body[start..])
                        .map_err(|error| format!("cannot read chunk body: {error}"))?;
                    let mut crlf = [0_u8; 2];
                    stream
                        .read_exact(&mut crlf)
                        .map_err(|error| format!("cannot read chunk terminator: {error}"))?;
                    if crlf != *b"\r\n" {
                        return Err("chunk terminator is invalid".to_string());
                    }
                }
            }

            fn read_http_request(mut stream: &TcpStream) -> Option<(String, String, Value)> {
                let mut header = Vec::new();
                let mut buffer = [0_u8; 1];
                while !header.ends_with(b"\r\n\r\n") {
                    if stream.read_exact(&mut buffer).is_err() {
                        return None;
                    }
                    header.push(buffer[0]);
                }
                let header_text = String::from_utf8(header).ok()?;
                let lower_header = header_text.to_ascii_lowercase();
                let chunked = lower_header
                    .lines()
                    .any(|line| line.trim() == "transfer-encoding: chunked");
                let content_length = header_text
                    .lines()
                    .find_map(|line| {
                        line.strip_prefix("Content-Length:")
                            .or_else(|| line.strip_prefix("content-length:"))
                    })
                    .map(str::trim)
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(0);
                let path = header_text
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("")
                    .to_string();
                let authorization = header_text
                    .lines()
                    .find_map(|line| {
                        line.strip_prefix("Authorization:")
                            .or_else(|| line.strip_prefix("authorization:"))
                    })
                    .map(str::trim)
                    .unwrap_or("")
                    .to_string();
                let sanitized_headers = header_text
                    .lines()
                    .map(|line| {
                        if line.to_ascii_lowercase().starts_with("authorization:") {
                            "Authorization: <redacted>".to_string()
                        } else {
                            line.to_string()
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                let raw_body = if chunked {
                    match read_chunked_body(stream) {
                        Ok(body) => body,
                        Err(error) => {
                            let body = json!({
                                "_readError": error,
                                "_headers": sanitized_headers,
                                "_rawBodyBytes": 0,
                            });
                            return Some((path, authorization, body));
                        }
                    }
                } else {
                    let mut body = vec![0_u8; content_length];
                    if let Err(error) = stream.read_exact(&mut body) {
                        let body = json!({
                            "_readError": error.to_string(),
                            "_headers": sanitized_headers,
                            "_rawBodyUtf8": String::from_utf8_lossy(&body),
                            "_rawBodyBytes": body.len(),
                        });
                        return Some((path, authorization, body));
                    }
                    body
                };
                let body = serde_json::from_slice(&raw_body).unwrap_or_else(|error| {
                    json!({
                        "_parseError": error.to_string(),
                        "_headers": sanitized_headers,
                        "_rawBodyUtf8": String::from_utf8_lossy(&raw_body),
                        "_rawBodyBytes": raw_body.len(),
                    })
                });
                Some((path, authorization, body))
            }

            fn write_chat_completion(mut stream: TcpStream) {
                let chunk = r#"data: {"id":"chatcmpl-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}

data: {"id":"chatcmpl-fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]

"#;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
                    chunk.len(),
                    chunk
                );
                stream.write_all(response.as_bytes()).unwrap();
            }

            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let port = listener.local_addr().unwrap().port();
            let captured = Arc::new(Mutex::new(Vec::<(String, String, Value)>::new()));
            let captured_thread = captured.clone();
            let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let stop_thread = stop.clone();
            let handle = thread::spawn(move || {
                let deadline = std::time::Instant::now() + Duration::from_secs(45);
                while !stop_thread.load(Ordering::Acquire) && std::time::Instant::now() < deadline {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            if let Some(request) = read_http_request(&stream) {
                                captured_thread.lock().unwrap().push(request);
                                write_chat_completion(stream);
                            } else {
                                captured_thread.lock().unwrap().push((
                                    "<unparsed>".to_string(),
                                    String::new(),
                                    json!({"_readError": "request header unavailable"}),
                                ));
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(20));
                        }
                        Err(error) => panic!("fixture HTTP server failed: {error}"),
                    }
                }
            });
            Self {
                port,
                captured,
                stop,
                handle: Some(handle),
            }
        }

        fn endpoint(&self) -> String {
            format!("http://127.0.0.1:{}/v1", self.port)
        }

        fn captured(&self) -> Vec<(String, String, Value)> {
            self.captured.lock().unwrap().clone()
        }
    }

    impl Drop for ChatFixtureServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            let _ = std::net::TcpStream::connect(("127.0.0.1", self.port));
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }

    #[cfg(test)]
    struct ToolCallFixtureServer {
        port: u16,
        captured: Arc<Mutex<Vec<(String, String, Value)>>>,
        stop: Arc<std::sync::atomic::AtomicBool>,
        handle: Option<thread::JoinHandle<()>>,
    }

    impl ToolCallFixtureServer {
        fn start() -> Self {
            use std::{
                io::{Read as _, Write as _},
                net::{TcpListener, TcpStream},
            };

            fn read_http_request(mut stream: &TcpStream) -> Option<(String, String, Value)> {
                let mut header = Vec::new();
                let mut buffer = [0_u8; 1];
                while !header.ends_with(b"\r\n\r\n") {
                    if stream.read_exact(&mut buffer).is_err() {
                        return None;
                    }
                    header.push(buffer[0]);
                }
                let header_text = String::from_utf8(header).ok()?;
                let content_length = header_text
                    .lines()
                    .find_map(|line| {
                        line.strip_prefix("Content-Length:")
                            .or_else(|| line.strip_prefix("content-length:"))
                    })
                    .map(str::trim)
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(0);
                let mut body = vec![0_u8; content_length];
                if stream.read_exact(&mut body).is_err() {
                    return None;
                }
                let path = header_text
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("")
                    .to_string();
                let authorization = header_text
                    .lines()
                    .find_map(|line| {
                        line.strip_prefix("Authorization:")
                            .or_else(|| line.strip_prefix("authorization:"))
                    })
                    .map(str::trim)
                    .unwrap_or("")
                    .to_string();
                let body = serde_json::from_slice(&body).ok()?;
                Some((path, authorization, body))
            }

            fn write_event_stream(mut stream: TcpStream, body: &str) {
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream.write_all(response.as_bytes()).unwrap();
            }

            fn write_tool_call(stream: TcpStream) {
                let chunk = r#"data: {"id":"chatcmpl-tool-fixture","object":"chat.completion.chunk","created":0,"model":"gpt-fixture","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_bash_1","type":"function","function":{"name":"bash","arguments":"{\"command\":\"cat /etc/hosts\"}"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-tool-fixture","object":"chat.completion.chunk","created":0,"model":"gpt-fixture","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]

"#;
                write_event_stream(stream, chunk);
            }

            fn write_chat_completion(stream: TcpStream) {
                let chunk = r#"data: {"id":"chatcmpl-tool-fixture","object":"chat.completion.chunk","created":0,"model":"gpt-fixture","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}

data: {"id":"chatcmpl-tool-fixture","object":"chat.completion.chunk","created":0,"model":"gpt-fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]

"#;
                write_event_stream(stream, chunk);
            }

            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let port = listener.local_addr().unwrap().port();
            let captured = Arc::new(Mutex::new(Vec::<(String, String, Value)>::new()));
            let captured_thread = captured.clone();
            let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let stop_thread = stop.clone();
            let tool_call_sent = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let tool_call_sent_thread = tool_call_sent.clone();
            let handle = thread::spawn(move || {
                let deadline = std::time::Instant::now() + Duration::from_secs(45);
                while !stop_thread.load(Ordering::Acquire) && std::time::Instant::now() < deadline {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let should_send_tool = if let Some(request) = read_http_request(&stream)
                            {
                                let body_text = request.2.to_string();
                                let is_title_prompt = body_text.contains("title generator");
                                let is_task_prompt = !is_title_prompt
                                    && chat_fixture_body_contains(&request.2, "Use bash");
                                captured_thread.lock().unwrap().push(request);
                                is_task_prompt
                                    && !tool_call_sent_thread.swap(true, Ordering::SeqCst)
                            } else {
                                captured_thread.lock().unwrap().push((
                                    "<unparsed>".to_string(),
                                    String::new(),
                                    json!({"_readError": "request header unavailable"}),
                                ));
                                false
                            };
                            if should_send_tool {
                                write_tool_call(stream);
                            } else {
                                write_chat_completion(stream);
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(20));
                        }
                        Err(error) => panic!("fixture HTTP server failed: {error}"),
                    }
                }
            });
            Self {
                port,
                captured,
                stop,
                handle: Some(handle),
            }
        }

        fn endpoint(&self) -> String {
            format!("http://127.0.0.1:{}/v1", self.port)
        }

        fn captured(&self) -> Vec<(String, String, Value)> {
            self.captured.lock().unwrap().clone()
        }
    }

    impl Drop for ToolCallFixtureServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            let _ = std::net::TcpStream::connect(("127.0.0.1", self.port));
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }

    fn chat_fixture_request_summary(captured: &[(String, String, Value)]) -> Vec<Value> {
        captured
            .iter()
            .map(|(path, authorization, body)| {
                json!({
                    "path": path,
                    "hasFixtureAuthorization": authorization.starts_with("Bearer sk-"),
                    "model": body.get("model").cloned().unwrap_or(Value::Null),
                    "messages": body.get("messages").cloned().unwrap_or(Value::Null),
                    "input": body.get("input").cloned().unwrap_or(Value::Null),
                    "prompt": body.get("prompt").cloned().unwrap_or(Value::Null),
                })
            })
            .collect()
    }

    fn chat_fixture_body_contains(body: &Value, needle: &str) -> bool {
        body.get("messages")
            .and_then(Value::as_array)
            .is_some_and(|messages| {
                messages
                    .iter()
                    .any(|message| message.to_string().contains(needle))
            })
            || body
                .get("input")
                .is_some_and(|input| input.to_string().contains(needle))
            || body
                .get("prompt")
                .is_some_and(|prompt| prompt.to_string().contains(needle))
    }

    fn wait_for_permission_event(
        router: &RuntimeEventRouter,
        request_id: &str,
        native_session_id: &str,
    ) -> Value {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let snapshot = serde_json::to_value(router.snapshot(None, None).unwrap()).unwrap();
            if let Some(event) =
                snapshot
                    .get("events")
                    .and_then(Value::as_array)
                    .and_then(|events| {
                        events
                            .iter()
                            .find(|event| {
                                event
                                    .pointer("/nativeEnvelope/payload/id")
                                    .is_some_and(|id| {
                                        id.as_str() == Some(request_id)
                                            || request_id
                                                .parse::<i64>()
                                                .is_ok_and(|value| id.as_i64() == Some(value))
                                    })
                                    && event
                                        .pointer("/nativeEnvelope/payload/method")
                                        .and_then(Value::as_str)
                                        == Some("session/request_permission")
                                    && event
                                        .pointer("/nativeEnvelope/payload/params/sessionId")
                                        .and_then(Value::as_str)
                                        == Some(native_session_id)
                            })
                            .cloned()
                    })
            {
                return event;
            }
            if std::time::Instant::now() >= deadline {
                panic!("permission event was not routed: {snapshot}");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    struct PiCapabilityStopGuard<'a>(&'a crate::pi_capabilities::PiCapabilities);

    impl Drop for PiCapabilityStopGuard<'_> {
        fn drop(&mut self) {
            let _ = crate::pi_capabilities::stop_process(self.0);
        }
    }

    struct OpenCodeAcpStopGuard(OpenCodeAcpRuntime);

    impl Drop for OpenCodeAcpStopGuard {
        fn drop(&mut self) {
            let _ = opencode_acp_stop_blocking(self.0.clone());
        }
    }

    #[test]
    fn event_pump_routes_updates_and_permission_before_prompt_finishes() {
        let (_temp, connection) = fixture_connection(
            r#"
import json,sys,time
request=json.loads(sys.stdin.readline())
print(json.dumps({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_keep","update":{"sessionUpdate":"agent_message_chunk","messageId":"msg_1","content":{"type":"text","text":"streamed"}}}}),flush=True)
print(json.dumps({"jsonrpc":"2.0","id":"agent-permission-1","method":"session/request_permission","params":{"sessionId":"ses_keep","toolCall":{"toolCallId":"call_1","title":"Run tool"},"options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"}]}}),flush=True)
reply=json.loads(sys.stdin.readline())
assert reply["result"]["outcome"]["optionId"]=="allow-once"
print(json.dumps({"jsonrpc":"2.0","id":request["id"],"result":{"stopReason":"end_turn"}}),flush=True)
"#,
        );
        let binding = connection.binding.clone();
        let generation = connection.generation;
        let transport = connection.transport.clone();
        let stop = connection.event_pump_stop.clone();
        let handle = Arc::new(Mutex::new(connection));
        let interactions = crate::interaction_registry::InteractionRegistry::default();
        let router =
            RuntimeEventRouter::with_capacity_and_observers(16, None, Some(interactions.clone()));
        start_event_pump(handle, router.clone(), stop.clone()).unwrap();
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let prompt = transport.clone();
        thread::spawn(move || {
            sender
                .send(prompt.request_unbounded(
                    "session/prompt",
                    json!({"sessionId":"ses_keep","prompt":[{"type":"text","text":"go"}]}),
                ))
                .unwrap();
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let snapshot = serde_json::to_value(router.snapshot(None, None).unwrap()).unwrap();
            let saw_update = snapshot["events"].as_array().is_some_and(|events| {
                events.iter().any(|event| {
                    event
                        .pointer("/nativeEnvelope/payload/method")
                        .and_then(Value::as_str)
                        == Some("session/update")
                })
            });
            let pending = serde_json::to_value(interactions.snapshots().unwrap()).unwrap();
            let saw_permission = pending.as_array().is_some_and(|items| {
                items.iter().any(|item| {
                    item["interactionId"] == "agent-permission-1"
                        && item["nativeSessionId"] == "ses_keep"
                })
            });
            if saw_update && saw_permission {
                break;
            }
            if std::time::Instant::now() >= deadline {
                panic!("snapshot={snapshot} pending={pending}");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(receiver.try_recv().is_err());
        interactions
            .begin_response(
                binding.clone(),
                generation,
                "agent-permission-1",
                Some("ses_keep"),
            )
            .unwrap();
        transport
            .respond_client_request(
                "agent-permission-1",
                json!({"outcome":"selected","optionId":"allow-once"}),
            )
            .unwrap();
        interactions
            .finish_response(binding, generation, "agent-permission-1", true)
            .unwrap();
        assert_eq!(
            receiver
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .unwrap()["stopReason"],
            "end_turn"
        );
        stop.store(true, Ordering::Release);
        transport.stop().unwrap();
    }

    #[test]
    fn event_pump_and_status_reads_preserve_native_history_order() {
        let (_temp, connection) = fixture_connection(
            r#"
import json,sys,time
request=json.loads(sys.stdin.readline())
for index in range(64):
    print(json.dumps({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_keep","update":{"sessionUpdate":"agent_message_chunk","messageId":"msg_"+str(index),"content":{"type":"text","text":str(index)}}}}),flush=True)
    time.sleep(0.002)
print(json.dumps({"jsonrpc":"2.0","id":request["id"],"result":{"stopReason":"end_turn"}}),flush=True)
for line in sys.stdin: pass
"#,
        );
        let transport = connection.transport.clone();
        let stop = connection.event_pump_stop.clone();
        let handle = Arc::new(Mutex::new(connection));
        let router = RuntimeEventRouter::with_capacity_and_observers(128, None, None);
        start_event_pump(handle.clone(), router.clone(), stop.clone()).unwrap();
        let prompt_transport = transport.clone();
        let prompt = thread::spawn(move || {
            prompt_transport.request_unbounded("session/prompt", json!({"sessionId":"ses_keep"}))
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        let events = loop {
            {
                let mut connection = handle.lock().unwrap();
                thread::sleep(Duration::from_millis(3));
                update_events(&mut connection, &router).unwrap();
            }
            let snapshot = serde_json::to_value(router.snapshot(None, None).unwrap()).unwrap();
            let events = snapshot["events"].as_array().unwrap().clone();
            if events.len() == 64 {
                break events;
            }
            assert!(std::time::Instant::now() < deadline);
            thread::sleep(Duration::from_millis(1));
        };
        let texts: Vec<_> = events
            .iter()
            .map(|event| {
                event
                    .pointer("/nativeEnvelope/payload/params/update/content/text")
                    .and_then(Value::as_str)
                    .unwrap()
                    .parse::<usize>()
                    .unwrap()
            })
            .collect();
        assert_eq!(texts, (0..64).collect::<Vec<_>>());
        prompt.join().unwrap().unwrap();
        stop.store(true, Ordering::Release);
        transport.stop().unwrap();
    }

    #[test]
    fn host_switch_closes_idle_connection_but_preserves_pending_operation() {
        let (_temp, mut connection) =
            fixture_connection("import sys\nfor line in sys.stdin: pass\n");
        let operation = connection
            .operations
            .begin(
                AcpSessionOperationKind::Load,
                Some("ses_keep".into()),
                None,
                false,
            )
            .unwrap();
        let runtime = OpenCodeAcpRuntime::default();
        let handle = Arc::new(Mutex::new(connection));
        *runtime.state.lock().unwrap() = OpenCodeAcpLifecycle::Running(handle.clone());
        let stop = handle.lock().unwrap().event_pump_stop.clone();
        start_event_pump(handle.clone(), RuntimeEventRouter::default(), stop).unwrap();
        assert!(stop_idle_connection_for_host_switch(&runtime).is_err());
        assert!(handle.lock().unwrap().transport.is_running().unwrap());
        handle
            .lock()
            .unwrap()
            .operations
            .complete(operation)
            .unwrap();
        stop_idle_connection_for_host_switch(&runtime).unwrap();
        assert!(matches!(
            *runtime.state.lock().unwrap(),
            OpenCodeAcpLifecycle::Stopped
        ));
        assert!(!handle.lock().unwrap().transport.is_running().unwrap());
    }

    #[test]
    fn host_recovery_rejects_stale_generation_and_confirms_owned_process_exit() {
        let (_temp, connection) = fixture_connection("import sys\nfor line in sys.stdin: pass\n");
        let binding = connection.binding.clone();
        let cwd = connection.cwd.clone();
        let generation = connection.generation;
        let native = NativeSessionId::parse("ses_keep").unwrap();
        let transport = connection.transport.clone();
        let runtime = OpenCodeAcpRuntime::default();
        runtime.generation.store(generation, Ordering::SeqCst);
        *runtime.state.lock().unwrap() =
            OpenCodeAcpLifecycle::Running(Arc::new(Mutex::new(connection)));
        assert!(
            stop_session_for_host_recovery(&runtime, &binding, &cwd, &native, generation + 1)
                .is_err()
        );
        assert!(transport.is_running().unwrap());
        let stopped =
            stop_session_for_host_recovery(&runtime, &binding, &cwd, &native, generation).unwrap();
        assert!(!stopped.running);
        assert_eq!(stopped.generation, generation + 1);
        assert!(!transport.is_running().unwrap());
        assert_eq!(stopped.session_id.as_deref(), Some("ses_keep"));
        assert_eq!(
            stopped.runtime_connection_id,
            binding.connection_id.as_str()
        );
    }

    #[test]
    fn status_after_process_loss_retains_binding_for_host_recovery() {
        let (_temp, connection) = fixture_connection("import sys\nsys.exit(9)\n");
        let binding = connection.binding.clone();
        let cwd = connection.cwd.clone();
        let generation = connection.generation;
        let transport = connection.transport.clone();
        let runtime = OpenCodeAcpRuntime::default();
        runtime.generation.store(generation, Ordering::SeqCst);
        *runtime.state.lock().unwrap() =
            OpenCodeAcpLifecycle::Running(Arc::new(Mutex::new(connection)));
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while transport.is_running().unwrap() && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        let observed = current_status(&runtime, None).unwrap();
        assert!(!observed.running);
        assert_eq!(
            observed.runtime_connection_id,
            binding.connection_id.as_str()
        );
        assert!(observed.last_error.is_some());
        let native = NativeSessionId::parse("ses_keep").unwrap();
        let stopped =
            stop_session_for_host_recovery(&runtime, &binding, &cwd, &native, generation).unwrap();
        assert!(!stopped.running);
        assert_eq!(stopped.generation, generation + 1);
    }

    #[test]
    fn acp_permission_reply_requires_current_generation_and_replies_once() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("permission-replied");
        let script = temp.path().join("fixture.py");
        std::fs::write(
            &script,
            r#"
import json,sys,pathlib
marker=pathlib.Path("__MARKER__")
request=json.loads(sys.stdin.readline())
print(json.dumps({"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{"sessionId":"ses_keep","toolCall":{"toolCallId":"call_1","title":"Run tool"},"options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"}]}}),flush=True)
reply=json.loads(sys.stdin.readline())
assert reply["id"]==0
assert reply["result"]["outcome"]["outcome"]=="selected"
assert reply["result"]["outcome"]["optionId"]=="allow-once"
marker.write_text("replied")
print(json.dumps({"jsonrpc":"2.0","id":request["id"],"result":{"stopReason":"end_turn"}}),flush=True)
"#
            .replace("__MARKER__", &marker.to_string_lossy()),
        )
        .unwrap();
        let transport =
            Arc::new(AcpTransport::spawn(Command::new("/usr/bin/python3").arg(script)).unwrap());
        let binding = acp_binding(Path::new("/tmp/opencode")).unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let connection = OpenCodeAcpConnection {
            transport,
            binding,
            generation: 1,
            cwd: workspace.canonicalize().unwrap(),
            binary_path: PathBuf::from("/tmp/opencode"),
            session_id: Some("ses_keep".to_string()),
            agent_name: Some("OpenCode".to_string()),
            agent_version: OPENCODE_ACP_VERSION.to_string(),
            protocol_version: 1,
            question_bridge: false,
            load_session: true,
            config_options: json!([]),
            managed_provider: None,
            private_launch_dir: None,
            last_error: None,
            dropped_events: 0,
            initialized_at_ms: 1,
            operations: AcpSessionOperations::default(),
            event_pump_stop: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };
        let binding = connection.binding.clone();
        let generation = connection.generation;
        let transport = connection.transport.clone();
        let runtime = OpenCodeAcpRuntime::default();
        let store = HostStore::open(temp.path().join("host.sqlite3"));
        let (farfold_session_id, _, _) = register_acp_runtime_and_session(
            &store,
            &binding,
            &connection.cwd,
            &connection.binary_path,
            "ses_keep",
        )
        .unwrap();
        *runtime.state.lock().unwrap() =
            OpenCodeAcpLifecycle::Running(Arc::new(Mutex::new(connection)));
        let interactions = crate::interaction_registry::InteractionRegistry::default();
        let router =
            RuntimeEventRouter::with_capacity_and_observers(16, None, Some(interactions.clone()));
        let prompt = transport.clone();
        let marker_arg = marker.clone();
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        thread::spawn(move || {
            sender
                .send(prompt.request_unbounded(
                    "session/prompt",
                    json!({"sessionId":"ses_keep","prompt":[{"type":"text","text":"go"}]}),
                ))
                .unwrap();
            let _ = marker_arg;
        });
        let (events, _) = transport.wait_events(Duration::from_secs(2)).unwrap();
        let permission = events
            .into_iter()
            .find(|event| event["method"] == "session/request_permission")
            .expect("permission request is routed before prompt returns");
        router
            .route(
                binding.clone(),
                json!({"generation": generation, "kind": "acp", "payload": permission}),
            )
            .unwrap();
        let stale = respond_permission_blocking(
            runtime.clone(),
            store.clone(),
            interactions.clone(),
            OpenCodeAcpPermissionResponseInput {
                farfold_session_id: farfold_session_id.clone(),
                native_session_id: NativeSessionId::parse("ses_keep").unwrap(),
                runtime_generation: generation + 1,
                request_id: "0".to_string(),
                option_id: "allow-once".to_string(),
            },
        )
        .unwrap_err();
        assert!(stale.contains("Runtime generation"));
        assert!(!marker.exists());
        respond_permission_blocking(
            runtime.clone(),
            store,
            interactions.clone(),
            OpenCodeAcpPermissionResponseInput {
                farfold_session_id,
                native_session_id: NativeSessionId::parse("ses_keep").unwrap(),
                runtime_generation: generation,
                request_id: "0".to_string(),
                option_id: "allow-once".to_string(),
            },
        )
        .unwrap();
        assert_eq!(
            receiver
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .unwrap()["stopReason"],
            "end_turn"
        );
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "replied");
        let repeated = interactions.begin_response(binding, generation, "0", Some("ses_keep"));
        assert!(repeated.is_err());
        let _ = opencode_acp_stop_blocking(runtime);
    }

    #[test]
    fn acp_permission_reject_uses_the_native_option_id() {
        let (temp, mut connection) = fixture_connection(
            r#"
import json,sys
request=json.loads(sys.stdin.readline())
print(json.dumps({"jsonrpc":"2.0","id":"agent-permission-1","method":"session/request_permission","params":{"sessionId":"ses_keep","toolCall":{"toolCallId":"call_1","title":"Run tool"},"options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"},{"optionId":"reject-once","name":"Reject","kind":"reject_once"}]}}),flush=True)
reply=json.loads(sys.stdin.readline())
assert reply["id"]=="agent-permission-1"
assert reply["result"]["outcome"]["outcome"]=="selected"
assert reply["result"]["outcome"]["optionId"]=="reject-once"
print(json.dumps({"jsonrpc":"2.0","id":request["id"],"result":{"stopReason":"end_turn"}}),flush=True)
"#,
        );
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        connection.cwd = workspace.canonicalize().unwrap();
        let binding = connection.binding.clone();
        let generation = connection.generation;
        let transport = connection.transport.clone();
        let runtime = OpenCodeAcpRuntime::default();
        let store = HostStore::open(temp.path().join("host.sqlite3"));
        let (farfold_session_id, _, _) = register_acp_runtime_and_session(
            &store,
            &binding,
            &workspace.canonicalize().unwrap(),
            &connection.binary_path,
            "ses_keep",
        )
        .unwrap();
        *runtime.state.lock().unwrap() =
            OpenCodeAcpLifecycle::Running(Arc::new(Mutex::new(connection)));
        let interactions = crate::interaction_registry::InteractionRegistry::default();
        let router =
            RuntimeEventRouter::with_capacity_and_observers(16, None, Some(interactions.clone()));
        let prompt = transport.clone();
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        thread::spawn(move || {
            sender
                .send(prompt.request_unbounded(
                    "session/prompt",
                    json!({"sessionId":"ses_keep","prompt":[{"type":"text","text":"go"}]}),
                ))
                .unwrap();
        });
        let (events, _) = transport.wait_events(Duration::from_secs(2)).unwrap();
        let permission = events
            .into_iter()
            .find(|event| event["method"] == "session/request_permission")
            .expect("permission request is routed before prompt returns");
        router
            .route(
                binding,
                json!({"generation": generation, "kind": "acp", "payload": permission}),
            )
            .unwrap();
        respond_permission_blocking(
            runtime.clone(),
            store,
            interactions,
            OpenCodeAcpPermissionResponseInput {
                farfold_session_id,
                native_session_id: NativeSessionId::parse("ses_keep").unwrap(),
                runtime_generation: generation,
                request_id: "agent-permission-1".to_string(),
                option_id: "reject-once".to_string(),
            },
        )
        .unwrap();
        assert_eq!(
            receiver
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .unwrap()["stopReason"],
            "end_turn"
        );
        let _ = opencode_acp_stop_blocking(runtime);
    }

    #[test]
    fn config_option_updates_apply_only_to_current_native_session() {
        let (_temp, mut connection) = fixture_connection(
            r#"
import json,sys
request=json.loads(sys.stdin.readline())
print(json.dumps({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_old","update":{"sessionUpdate":"config_option_update","configOptions":[{"id":"model","name":"Model","type":"select","currentValue":"old","options":[{"value":"old","name":"Old"}]}]}}}),flush=True)
print(json.dumps({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_keep","update":{"sessionUpdate":"config_option_update","configOptions":[{"id":"model","name":"Model","type":"select","currentValue":"current","options":[{"value":"current","name":"Current"}]}]}}}),flush=True)
print(json.dumps({"jsonrpc":"2.0","id":request["id"],"result":{"ok":True}}),flush=True)
"#,
        );
        connection.config_options = json!([
            {"id":"model","name":"Model","type":"select","currentValue":"initial","options":[{"value":"initial","name":"Initial"}]}
        ]);
        let router = RuntimeEventRouter::default();
        assert_eq!(
            connection
                .transport
                .request_timeout("initialize", json!({}), Duration::from_secs(2))
                .unwrap()["ok"],
            true
        );
        update_events(&mut connection, &router).unwrap();
        assert_eq!(connection.config_options[0]["currentValue"], "current");
    }

    #[test]
    fn late_config_option_response_cannot_overwrite_newer_selection() {
        let (_temp, mut connection) = fixture_connection(
            r#"
import json,sys,time
first=json.loads(sys.stdin.readline())
second=json.loads(sys.stdin.readline())
print(json.dumps({"jsonrpc":"2.0","id":second["id"],"result":{"configOptions":[{"id":"model","name":"Model","type":"select","currentValue":"new","options":[{"value":"new","name":"New"}]}]}}),flush=True)
time.sleep(0.05)
print(json.dumps({"jsonrpc":"2.0","id":first["id"],"result":{"configOptions":[{"id":"model","name":"Model","type":"select","currentValue":"old","options":[{"value":"old","name":"Old"}]}]}}),flush=True)
"#,
        );
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        connection.cwd = workspace.canonicalize().unwrap();
        let store = HostStore::open(temp.path().join("host.sqlite3"));
        let (farfold_session_id, _, _) = register_acp_runtime_and_session(
            &store,
            &connection.binding,
            &connection.cwd,
            &connection.binary_path,
            "ses_keep",
        )
        .unwrap();
        let runtime = OpenCodeAcpRuntime::default();
        let handle = Arc::new(Mutex::new(connection));
        *runtime.state.lock().unwrap() = OpenCodeAcpLifecycle::Running(handle);
        let turns = crate::turn_coordinator::TurnCoordinator::default();
        let first_runtime = runtime.clone();
        let first_store = store.clone();
        let first_turns = turns.clone();
        let first_session = farfold_session_id.clone();
        let first = thread::spawn(move || {
            set_config_option_blocking(
                first_runtime,
                first_store,
                first_turns,
                OpenCodeAcpSetConfigOptionInput {
                    farfold_session_id: first_session,
                    native_session_id: NativeSessionId::parse("ses_keep").unwrap(),
                    config_id: "model".to_string(),
                    value: json!("old"),
                    value_type: None,
                },
            )
        });
        std::thread::sleep(Duration::from_millis(20));
        let second = set_config_option_blocking(
            runtime.clone(),
            store,
            turns,
            OpenCodeAcpSetConfigOptionInput {
                farfold_session_id,
                native_session_id: NativeSessionId::parse("ses_keep").unwrap(),
                config_id: "model".to_string(),
                value: json!("new"),
                value_type: None,
            },
        )
        .unwrap();
        assert_eq!(second.config_options[0]["currentValue"], "new");
        let stale = first.join().unwrap().unwrap_err();
        assert!(stale.contains("晚到结果已丢弃"));
        let status = current_status(&runtime, None).unwrap();
        assert_eq!(status.config_options[0]["currentValue"], "new");
        let _ = opencode_acp_stop_blocking(runtime);
    }

    #[test]
    fn config_option_change_is_rejected_while_session_has_active_turn() {
        let (_temp, mut connection) = fixture_connection(
            r#"
import sys
for _ in sys.stdin:
    pass
"#,
        );
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        connection.cwd = workspace.canonicalize().unwrap();
        let store = HostStore::open(temp.path().join("host.sqlite3"));
        let binding = connection.binding.clone();
        let (farfold_session_id, _, _) = register_acp_runtime_and_session(
            &store,
            &binding,
            &connection.cwd,
            &connection.binary_path,
            "ses_keep",
        )
        .unwrap();
        let target = store.session_open_target(&farfold_session_id).unwrap();
        let generation = connection.generation;
        let transport = connection.transport.clone();
        let runtime = OpenCodeAcpRuntime::default();
        *runtime.state.lock().unwrap() =
            OpenCodeAcpLifecycle::Running(Arc::new(Mutex::new(connection)));
        let turns = crate::turn_coordinator::TurnCoordinator::default();
        turns
            .admit(crate::turn_coordinator::TurnAdmissionRequest {
                farfold_session_id: farfold_session_id.clone(),
                working_copy_id: target.working_copy_id.clone(),
                runtime_product_id: target.runtime_product_id.clone(),
                installation_id: target.installation_id.clone(),
                runtime_connection_id: target.connection_id.clone(),
                native_session_id: target.native_session_id.clone(),
                runtime_generation: generation,
                started_at: 1,
                provider_connection_id: None,
                provider_config_version_id: None,
                runtime_provider_id: None,
                runtime_model_id: None,
                provider_binding_authority: TurnProviderBindingAuthority::CurrentAppliedProjection,
            })
            .unwrap();
        let error = set_config_option_blocking(
            runtime.clone(),
            store,
            turns,
            OpenCodeAcpSetConfigOptionInput {
                farfold_session_id,
                native_session_id: NativeSessionId::parse("ses_keep").unwrap(),
                config_id: "model".to_string(),
                value: json!("new"),
                value_type: None,
            },
        )
        .unwrap_err();
        assert!(error.contains("空闲"));
        assert!(transport.drain_events().unwrap().0.is_empty());
        let _ = opencode_acp_stop_blocking(runtime);
    }

    #[test]
    fn failed_close_keeps_the_bound_session_identity() {
        let (_temp, connection) = fixture_connection(
            r#"
import json,sys
for line in sys.stdin:
    request=json.loads(line)
    print(json.dumps({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32000,"message":"no"}}),flush=True)
"#,
        );
        let runtime = OpenCodeAcpRuntime::default();
        *runtime.state.lock().unwrap() =
            OpenCodeAcpLifecycle::Running(Arc::new(Mutex::new(connection)));
        let router = RuntimeEventRouter::default();
        let error =
            opencode_acp_close_session_blocking(runtime.clone(), router.clone()).unwrap_err();
        assert!(error.contains("错误码"));
        let status = opencode_acp_status_blocking(runtime, router).unwrap();
        assert_eq!(status.session_id.as_deref(), Some("ses_keep"));
        assert!(status.last_error.unwrap().contains("错误码"));
    }

    #[test]
    fn active_session_blocks_new_or_load_until_close_is_confirmed() {
        let (_temp, connection) = fixture_connection(
            r#"
import time
time.sleep(60)
"#,
        );
        let runtime = OpenCodeAcpRuntime::default();
        *runtime.state.lock().unwrap() =
            OpenCodeAcpLifecycle::Running(Arc::new(Mutex::new(connection)));
        let router = RuntimeEventRouter::default();
        let new_error =
            opencode_acp_new_session_blocking(runtime.clone(), router.clone(), None).unwrap_err();
        assert!(new_error.contains("已绑定 Session"));
        let load_error = opencode_acp_load_session_blocking(
            runtime,
            router,
            None,
            OpenCodeAcpLoadInput {
                session_id: "ses_other".to_string(),
            },
        )
        .unwrap_err();
        assert!(load_error.contains("已绑定 Session"));
    }

    #[test]
    fn managed_provider_private_config_is_confirmed_before_projection() {
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().join("app-data");
        let acp_root = temp.path().join("managed-acp-root");
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&app_data).unwrap();
        std::fs::create_dir(&acp_root).unwrap();
        std::fs::create_dir(&workspace).unwrap();
        let store = HostStore::open(temp.path().join("host.sqlite3"));
        let saved = crate::managed_provider::save_api_key_in_dir(
            &app_data,
            Some(&store),
            crate::managed_provider::ManagedProviderApiKeySaveInput {
                provider_key: "openai".to_string(),
                label: "OpenAI Fixture".to_string(),
                account_label: "work".to_string(),
                endpoint: "https://fixture.example.invalid/v1".to_string(),
                api_kind: "openai-chat-completions".to_string(),
                api_key: "sk-fixture-managed".to_string(),
                model_id: "gpt-fixture".to_string(),
                context_window: Some(128_000),
                max_tokens: Some(8_192),
                reasoning: Some(false),
                image_input: Some(false),
                supports_developer_role: Some(true),
                supports_reasoning_effort: Some(false),
            },
        )
        .unwrap();
        let input = OpenCodeAcpManagedSessionInput {
            binary_path: PathBuf::from("/tmp/opencode"),
            cwd: workspace.clone(),
            provider_connection_id: saved.provider_connection_id.clone(),
            provider_config_version_id: saved.current_config_version_id.clone(),
            operation_id: "managed-acp-test".to_string(),
        };
        let binding = managed_acp_binding(
            Path::new("/tmp/opencode"),
            &saved.provider_connection_id,
            &saved.current_config_version_id,
        )
        .unwrap();
        let prepared = prepare_managed_acp_provider(
            &app_data,
            &acp_root,
            "managed-acp-test",
            &binding,
            &store,
            &input,
            true,
        )
        .expect("managed ACP config is prepared from committed Host version");
        let config = std::fs::read_to_string(
            prepared
                .config_root
                .join("xdg-config")
                .join("opencode")
                .join("opencode.json"),
        )
        .unwrap();
        assert!(config.contains("https://fixture.example.invalid/v1"));
        assert!(config.contains("sk-fixture-managed"));
        assert!(config.contains(prepared.binding.provider_connection_id.as_str()));

        let (_fixture, mut connection) = fixture_connection(
            r#"
import time
time.sleep(60)
"#,
        );
        connection.cwd = workspace.canonicalize().unwrap();
        connection.managed_provider = Some(prepared.binding.clone());
        let router = RuntimeEventRouter::default();
        let result = session_result_from_response(
            &mut connection,
            json!({
                "sessionId": "ses_managed",
                "configOptions": [{
                    "id": "model",
                    "name": "Model",
                    "type": "select",
                    "currentValue": prepared.binding.runtime_model_id,
                    "options": [{
                        "value": prepared.binding.runtime_model_id,
                        "name": "GPT Fixture"
                    }]
                }]
            }),
            None,
            &router,
            Some(&store),
            true,
        )
        .unwrap();
        assert_eq!(result.session_id, "ses_managed");
        assert_eq!(
            result
                .status
                .managed_provider
                .unwrap()
                .provider_config_version_id,
            saved.current_config_version_id
        );
        let projection = serde_json::to_value(
            store
                .provider_projection_snapshot(&saved.provider_connection_id)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(projection["projections"][0]["applyState"], "applied");
        assert_eq!(
            projection["projections"][0]["runtimeProviderId"],
            saved.provider_connection_id.as_str()
        );
        assert_eq!(
            projection["projections"][0]["runtimeModelId"],
            prepared.binding.runtime_model_id
        );
    }

    #[test]
    fn managed_provider_projection_requires_native_config_option_confirmation() {
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().join("app-data");
        let acp_root = temp.path().join("managed-acp-root");
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&app_data).unwrap();
        std::fs::create_dir(&acp_root).unwrap();
        std::fs::create_dir(&workspace).unwrap();
        let store = HostStore::open(temp.path().join("host.sqlite3"));
        let saved = crate::managed_provider::save_api_key_in_dir(
            &app_data,
            Some(&store),
            crate::managed_provider::ManagedProviderApiKeySaveInput {
                provider_key: "openai".to_string(),
                label: "OpenAI Fixture".to_string(),
                account_label: "work".to_string(),
                endpoint: "https://fixture.example.invalid/v1".to_string(),
                api_kind: "openai-chat-completions".to_string(),
                api_key: "sk-fixture-managed".to_string(),
                model_id: "gpt-fixture".to_string(),
                context_window: Some(128_000),
                max_tokens: Some(8_192),
                reasoning: Some(false),
                image_input: Some(false),
                supports_developer_role: Some(true),
                supports_reasoning_effort: Some(false),
            },
        )
        .unwrap();
        let input = OpenCodeAcpManagedSessionInput {
            binary_path: PathBuf::from("/tmp/opencode"),
            cwd: workspace.clone(),
            provider_connection_id: saved.provider_connection_id.clone(),
            provider_config_version_id: saved.current_config_version_id.clone(),
            operation_id: "managed-acp-mismatch-test".to_string(),
        };
        let binding = managed_acp_binding(
            Path::new("/tmp/opencode"),
            &saved.provider_connection_id,
            &saved.current_config_version_id,
        )
        .unwrap();
        let prepared = prepare_managed_acp_provider(
            &app_data,
            &acp_root,
            "managed-acp-mismatch-test",
            &binding,
            &store,
            &input,
            true,
        )
        .unwrap();
        let (_fixture, mut connection) = fixture_connection(
            r#"
import time
time.sleep(60)
"#,
        );
        connection.cwd = workspace.canonicalize().unwrap();
        connection.managed_provider = Some(prepared.binding);
        let error = session_result_from_response(
            &mut connection,
            json!({
                "sessionId": "ses_wrong",
                "configOptions": [{
                    "id": "model",
                    "name": "Model",
                    "type": "select",
                    "currentValue": "other/model",
                    "options": [{"value": "other/model", "name": "Other"}]
                }]
            }),
            None,
            &RuntimeEventRouter::default(),
            Some(&store),
            true,
        )
        .unwrap_err();
        assert!(error.contains("did not confirm"));
        assert!(
            store
                .provider_projection_snapshot(&saved.provider_connection_id)
                .unwrap()
                .projections
                .is_empty()
        );
    }

    #[test]
    fn managed_provider_private_configs_do_not_cross_accounts_or_endpoints() {
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().join("app-data");
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&app_data).unwrap();
        std::fs::create_dir(&workspace).unwrap();
        let store = HostStore::open(temp.path().join("host.sqlite3"));
        let save = |account_label: &str, endpoint: &str, api_key: &str, model_id: &str| {
            crate::managed_provider::save_api_key_in_dir(
                &app_data,
                Some(&store),
                crate::managed_provider::ManagedProviderApiKeySaveInput {
                    provider_key: "openai".to_string(),
                    label: format!("OpenAI {account_label}"),
                    account_label: account_label.to_string(),
                    endpoint: endpoint.to_string(),
                    api_kind: "openai-chat-completions".to_string(),
                    api_key: api_key.to_string(),
                    model_id: model_id.to_string(),
                    context_window: Some(128_000),
                    max_tokens: Some(8_192),
                    reasoning: Some(false),
                    image_input: Some(false),
                    supports_developer_role: Some(true),
                    supports_reasoning_effort: Some(false),
                },
            )
            .unwrap()
        };
        let first = save(
            "work",
            "https://work.example.invalid/v1",
            "sk-work",
            "gpt-work",
        );
        let second = save(
            "personal",
            "https://personal.example.invalid/v1",
            "sk-personal",
            "gpt-personal",
        );
        assert_ne!(first.provider_connection_id, second.provider_connection_id);

        let prepare = |saved: &crate::managed_provider::ManagedProviderApiKeySaveResult,
                       operation_id: &str| {
            let acp_root = temp.path().join(format!("{operation_id}-root"));
            std::fs::create_dir(&acp_root).unwrap();
            let binding = managed_acp_binding(
                Path::new("/tmp/opencode"),
                &saved.provider_connection_id,
                &saved.current_config_version_id,
            )
            .unwrap();
            let prepared = prepare_managed_acp_provider(
                &app_data,
                &acp_root,
                operation_id,
                &binding,
                &store,
                &OpenCodeAcpManagedSessionInput {
                    binary_path: PathBuf::from("/tmp/opencode"),
                    cwd: workspace.clone(),
                    provider_connection_id: saved.provider_connection_id.clone(),
                    provider_config_version_id: saved.current_config_version_id.clone(),
                    operation_id: operation_id.to_string(),
                },
                true,
            )
            .unwrap();
            let config = std::fs::read_to_string(
                prepared
                    .config_root
                    .join("xdg-config")
                    .join("opencode")
                    .join("opencode.json"),
            )
            .unwrap();
            (prepared, config)
        };
        let (first_prepared, first_config) = prepare(&first, "managed-acp-work");
        let (second_prepared, second_config) = prepare(&second, "managed-acp-personal");

        assert!(first_config.contains("https://work.example.invalid/v1"));
        assert!(first_config.contains("sk-work"));
        assert!(first_config.contains(first.provider_connection_id.as_str()));
        assert!(!first_config.contains("https://personal.example.invalid/v1"));
        assert!(!first_config.contains("sk-personal"));
        assert!(!first_config.contains(second.provider_connection_id.as_str()));
        assert!(second_config.contains("https://personal.example.invalid/v1"));
        assert!(second_config.contains("sk-personal"));
        assert!(second_config.contains(second.provider_connection_id.as_str()));
        assert!(!second_config.contains("https://work.example.invalid/v1"));
        assert!(!second_config.contains("sk-work"));
        assert!(!second_config.contains(first.provider_connection_id.as_str()));
        assert_ne!(
            first_prepared.binding.runtime_model_id,
            second_prepared.binding.runtime_model_id
        );
    }

    #[test]
    fn product_stop_cleans_only_private_config_not_persistent_profile() {
        let (_temp, mut connection) = fixture_connection(
            r#"
pass
"#,
        );
        let temp = tempfile::tempdir().unwrap();
        let profile_root = temp.path().join("profile");
        let config_root = temp.path().join("config-launch");
        std::fs::create_dir(&profile_root).unwrap();
        std::fs::create_dir(&config_root).unwrap();
        std::fs::write(profile_root.join("native-session.sqlite3"), b"session").unwrap();
        std::fs::write(config_root.join("opencode.json"), b"{}").unwrap();
        connection.private_launch_dir = Some(config_root.clone());
        connection.transport.mark_eof_shutdown_requested_for_test();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while connection.transport.is_running().unwrap() && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        let runtime = OpenCodeAcpRuntime::default();
        *runtime.state.lock().unwrap() =
            OpenCodeAcpLifecycle::Running(Arc::new(Mutex::new(connection)));

        let stopped = opencode_acp_stop_blocking(runtime).unwrap();

        assert_eq!(stopped.state, "stopped");
        assert!(!config_root.exists());
        assert_eq!(
            std::fs::read(profile_root.join("native-session.sqlite3")).unwrap(),
            b"session"
        );
    }

    #[test]
    fn managed_acp_runtime_target_keeps_old_version_after_provider_update() {
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().join("app-data");
        let acp_root = temp.path().join("acp-root");
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&app_data).unwrap();
        std::fs::create_dir(&acp_root).unwrap();
        std::fs::create_dir(&workspace).unwrap();
        let store = HostStore::open(temp.path().join("host.sqlite3"));
        let first = crate::managed_provider::save_api_key_in_dir(
            &app_data,
            Some(&store),
            crate::managed_provider::ManagedProviderApiKeySaveInput {
                provider_key: "openai".to_string(),
                label: "OpenAI Fixture".to_string(),
                account_label: "work".to_string(),
                endpoint: "https://fixture.example.invalid/v1".to_string(),
                api_kind: "openai-chat-completions".to_string(),
                api_key: "sk-first".to_string(),
                model_id: "gpt-first".to_string(),
                context_window: Some(128_000),
                max_tokens: Some(8_192),
                reasoning: Some(false),
                image_input: Some(false),
                supports_developer_role: Some(true),
                supports_reasoning_effort: Some(false),
            },
        )
        .unwrap();
        let first_binding = managed_acp_binding(
            Path::new("/tmp/opencode"),
            &first.provider_connection_id,
            &first.current_config_version_id,
        )
        .unwrap();
        let first_input = OpenCodeAcpManagedSessionInput {
            binary_path: PathBuf::from("/tmp/opencode"),
            cwd: workspace.clone(),
            provider_connection_id: first.provider_connection_id.clone(),
            provider_config_version_id: first.current_config_version_id.clone(),
            operation_id: "old-version".to_string(),
        };
        let first_prepared = prepare_managed_acp_provider(
            &app_data,
            &acp_root,
            "old-version",
            &first_binding,
            &store,
            &first_input,
            true,
        )
        .unwrap();
        let (_fixture, mut first_connection) = fixture_connection(
            r#"
import time
time.sleep(60)
"#,
        );
        first_connection.binding = first_binding.clone();
        first_connection.cwd = workspace.canonicalize().unwrap();
        first_connection.managed_provider = Some(first_prepared.binding.clone());
        session_result_from_response(
            &mut first_connection,
            json!({
                "sessionId": "ses_old_version",
                "configOptions": [{
                    "id": "model",
                    "name": "Model",
                    "type": "select",
                    "currentValue": first_prepared.binding.runtime_model_id,
                    "options": [{"value": first_prepared.binding.runtime_model_id, "name": "First"}]
                }]
            }),
            None,
            &RuntimeEventRouter::default(),
            Some(&store),
            true,
        )
        .unwrap();

        let second = crate::managed_provider::save_api_key_in_dir(
            &app_data,
            Some(&store),
            crate::managed_provider::ManagedProviderApiKeySaveInput {
                provider_key: "openai".to_string(),
                label: "OpenAI Fixture".to_string(),
                account_label: "work".to_string(),
                endpoint: "https://fixture.example.invalid/v1".to_string(),
                api_kind: "openai-chat-completions".to_string(),
                api_key: "sk-second".to_string(),
                model_id: "gpt-second".to_string(),
                context_window: Some(128_000),
                max_tokens: Some(8_192),
                reasoning: Some(false),
                image_input: Some(false),
                supports_developer_role: Some(true),
                supports_reasoning_effort: Some(false),
            },
        )
        .unwrap();
        let second_binding = managed_acp_binding(
            Path::new("/tmp/opencode"),
            &second.provider_connection_id,
            &second.current_config_version_id,
        )
        .unwrap();
        assert_ne!(first_binding.connection_id, second_binding.connection_id);

        let old_target = managed_provider_for_runtime_target(&store, &first_binding)
            .unwrap()
            .unwrap();
        assert_eq!(
            old_target.provider_config_version_id,
            first.current_config_version_id
        );
        assert!(old_target.runtime_model_id.ends_with("/gpt-first"));
        let restore_input = OpenCodeAcpManagedSessionInput {
            binary_path: PathBuf::from("/tmp/opencode"),
            cwd: workspace.clone(),
            provider_connection_id: first.provider_connection_id.clone(),
            provider_config_version_id: old_target.provider_config_version_id.clone(),
            operation_id: "restore-old-version".to_string(),
        };
        let restored = prepare_managed_acp_provider(
            &app_data,
            &acp_root,
            "restore-old-version",
            &first_binding,
            &store,
            &restore_input,
            false,
        )
        .unwrap();
        assert!(restored.binding.runtime_model_id.ends_with("/gpt-first"));
        let (_fixture, mut restored_connection) = fixture_connection(
            r#"
import time
time.sleep(60)
"#,
        );
        restored_connection.binding = first_binding;
        restored_connection.cwd = workspace.canonicalize().unwrap();
        restored_connection.managed_provider = Some(restored.binding.clone());
        let loaded = session_result_from_response(
            &mut restored_connection,
            json!({
                "configOptions": [{
                    "id": "model",
                    "name": "Model",
                    "type": "select",
                    "currentValue": restored.binding.runtime_model_id,
                    "options": [{"value": restored.binding.runtime_model_id, "name": "First"}]
                }]
            }),
            Some("ses_old_version".to_string()),
            &RuntimeEventRouter::default(),
            None,
            false,
        )
        .unwrap();
        assert_eq!(loaded.session_id, "ses_old_version");
        let after_restore = store
            .provider_projection_snapshot(&first.provider_connection_id)
            .unwrap();
        assert_eq!(
            after_restore.connection.current_config_version_id,
            second.current_config_version_id
        );
        assert_eq!(
            after_restore.projections[0].config_version_id,
            second.current_config_version_id
        );
        assert_eq!(
            after_restore.projections[0].apply_state,
            ProviderApplyState::Pending
        );
    }

    #[test]
    fn acp_prompt_completion_and_cancel_use_official_session_methods() {
        let (_temp, connection) = fixture_connection(
            r#"
import json,sys
for line in sys.stdin:
    request=json.loads(line)
    if request["method"]=="session/prompt":
        assert request["params"]["sessionId"]=="ses_keep"
        assert request["params"]["prompt"][0]["text"]=="hello acp"
        print(json.dumps({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_keep","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ok"}}}}),flush=True)
        print(json.dumps({"jsonrpc":"2.0","id":request["id"],"result":{"stopReason":"end_turn"}}),flush=True)
    elif request["method"]=="session/cancel":
        assert request["params"]["sessionId"]=="ses_keep"
        break
"#,
        );
        let runtime = OpenCodeAcpRuntime::default();
        *runtime.state.lock().unwrap() =
            OpenCodeAcpLifecycle::Running(Arc::new(Mutex::new(connection)));
        let native = NativeSessionId::parse("ses_keep").unwrap();
        let result = prompt_text(&runtime, &native, "hello acp").unwrap();
        assert_eq!(result["stopReason"], "end_turn");
        cancel_session(&runtime, &native).unwrap();
        let handle = running_connection(&runtime).unwrap();
        let transport = handle.lock().unwrap().transport.clone();
        let (events, _) = transport.drain_events().unwrap();
        assert_eq!(events[0]["method"], "session/update");
    }

    #[test]
    fn idle_host_stop_rejects_stale_generation_before_stopping_owned_connection() {
        let (_temp, connection) = fixture_connection("import sys\nfor line in sys.stdin: pass\n");
        let binding = connection.binding.clone();
        let cwd = connection.cwd.clone();
        let generation = connection.generation;
        let native = NativeSessionId::parse("ses_keep").unwrap();
        let runtime = OpenCodeAcpRuntime::default();
        *runtime.state.lock().unwrap() =
            OpenCodeAcpLifecycle::Running(Arc::new(Mutex::new(connection)));
        assert!(stop_idle_host_session(&runtime, &binding, &cwd, &native, generation + 1).is_err());
        assert!(
            running_connection(&runtime)
                .unwrap()
                .lock()
                .unwrap()
                .transport
                .is_running()
                .unwrap()
        );
        let stopped =
            stop_idle_host_session(&runtime, &binding, &cwd, &native, generation).unwrap();
        assert!(!stopped.running);
        assert!(running_connection(&runtime).is_err());
    }

    #[test]
    fn host_acp_submit_treats_confirmed_cancelled_prompt_as_terminal_not_accepted() {
        let (temp, mut connection) = fixture_connection(
            r#"
import json,sys
first=json.loads(sys.stdin.readline())
assert first["method"]=="session/prompt"
print(json.dumps({"jsonrpc":"2.0","id":first["id"],"result":{"stopReason":"cancelled"}}),flush=True)
second=json.loads(sys.stdin.readline())
assert second["method"]=="session/prompt"
print(json.dumps({"jsonrpc":"2.0","id":second["id"],"result":{"stopReason":"end_turn"}}),flush=True)
"#,
        );
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        connection.cwd = workspace.canonicalize().unwrap();
        let binding = connection.binding.clone();
        let runtime = OpenCodeAcpRuntime::default();
        let store = HostStore::open(temp.path().join("host.sqlite3"));
        let (farfold_session_id, _, _) = register_acp_runtime_and_session(
            &store,
            &binding,
            &connection.cwd,
            &connection.binary_path,
            "ses_keep",
        )
        .unwrap();
        *runtime.state.lock().unwrap() =
            OpenCodeAcpLifecycle::Running(Arc::new(Mutex::new(connection)));
        let controller = Arc::new(crate::session_controller::HostSessionController::default());
        let coordinator = crate::turn_coordinator::TurnCoordinator::default();
        coordinator.attach_host_store(store.clone()).unwrap();
        let submission = crate::turn_coordinator::host_opencode_acp_turn_submit_blocking(
            &controller,
            &store,
            &runtime,
            &coordinator,
            crate::turn_coordinator::HostOpenCodeAcpTurnSubmitInput {
                farfold_session_id: farfold_session_id.clone(),
                native_session_id: NativeSessionId::parse("ses_keep").unwrap(),
                text: "cancel me".to_string(),
                provider_connection_id: None,
                provider_config_version_id: None,
                runtime_provider_id: None,
                runtime_model_id: None,
            },
        )
        .unwrap();
        match submission {
            crate::turn_coordinator::HostOpenCodeTurnSubmission::Cancelled { detail } => {
                assert!(detail.contains("已取消"));
            }
            crate::turn_coordinator::HostOpenCodeTurnSubmission::Accepted { .. } => {
                panic!("cancelled prompt must not be accepted");
            }
            crate::turn_coordinator::HostOpenCodeTurnSubmission::Unknown { detail }
            | crate::turn_coordinator::HostOpenCodeTurnSubmission::Failed { detail } => {
                panic!("confirmed cancellation must release Host Turn, got unknown: {detail}");
            }
        }
        let snapshot = serde_json::to_value(coordinator.snapshot().unwrap()).unwrap();
        assert_eq!(snapshot["activeTurns"].as_array().unwrap().len(), 0);
        let second = crate::turn_coordinator::host_opencode_acp_turn_submit_blocking(
            &controller,
            &store,
            &runtime,
            &coordinator,
            crate::turn_coordinator::HostOpenCodeAcpTurnSubmitInput {
                farfold_session_id,
                native_session_id: NativeSessionId::parse("ses_keep").unwrap(),
                text: "next turn".to_string(),
                provider_connection_id: None,
                provider_config_version_id: None,
                runtime_provider_id: None,
                runtime_model_id: None,
            },
        )
        .unwrap();
        assert!(matches!(
            second,
            crate::turn_coordinator::HostOpenCodeTurnSubmission::Accepted { .. }
        ));
        let database = rusqlite::Connection::open_with_flags(
            temp.path().join("host.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let completed: i64 = database.query_row(
                "SELECT COUNT(*) FROM turn_change_reviews WHERE completed_at IS NOT NULL AND terminal_reason = 'working_copy_not_managed'",
                [], |row| row.get(0),
            ).unwrap();
        assert_eq!(
            completed, 2,
            "both ACP terminal paths must finish their captured review"
        );
        let snapshot = serde_json::to_value(coordinator.snapshot().unwrap()).unwrap();
        assert_eq!(snapshot["activeTurns"].as_array().unwrap().len(), 0);
        let _ = opencode_acp_stop_blocking(runtime);
    }

    #[test]
    fn host_acp_abort_cancels_pending_permission_and_allows_next_turn() {
        let (temp, mut connection) = fixture_connection(
            r#"
import json,sys
first=json.loads(sys.stdin.readline())
assert first["method"]=="session/prompt"
print(json.dumps({"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{"sessionId":"ses_keep","toolCall":{"toolCallId":"call_1","title":"Run tool"},"options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"}]}}),flush=True)
reply=json.loads(sys.stdin.readline())
assert reply["id"]==0
assert reply["result"]["outcome"]["outcome"]=="cancelled"
cancel=json.loads(sys.stdin.readline())
assert cancel["method"]=="session/cancel"
assert cancel["params"]["sessionId"]=="ses_keep"
print(json.dumps({"jsonrpc":"2.0","id":first["id"],"result":{"stopReason":"cancelled"}}),flush=True)
second=json.loads(sys.stdin.readline())
assert second["method"]=="session/prompt"
print(json.dumps({"jsonrpc":"2.0","id":second["id"],"result":{"stopReason":"end_turn"}}),flush=True)
"#,
        );
        let workspace = temp.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        connection.cwd = workspace.canonicalize().unwrap();
        let binding = connection.binding.clone();
        let generation = connection.generation;
        let transport = connection.transport.clone();
        let stop = connection.event_pump_stop.clone();
        let handle = Arc::new(Mutex::new(connection));
        let runtime = OpenCodeAcpRuntime::default();
        *runtime.state.lock().unwrap() = OpenCodeAcpLifecycle::Running(handle.clone());
        let store = HostStore::open(temp.path().join("host.sqlite3"));
        let (farfold_session_id, _, _) = register_acp_runtime_and_session(
            &store,
            &binding,
            &workspace.canonicalize().unwrap(),
            Path::new("/tmp/opencode"),
            "ses_keep",
        )
        .unwrap();
        let interactions = crate::interaction_registry::InteractionRegistry::default();
        let router =
            RuntimeEventRouter::with_capacity_and_observers(16, None, Some(interactions.clone()));
        start_event_pump(handle, router, stop.clone()).unwrap();
        let controller = Arc::new(crate::session_controller::HostSessionController::default());
        let coordinator = crate::turn_coordinator::TurnCoordinator::default();
        let submit_runtime = runtime.clone();
        let submit_store = store.clone();
        let submit_controller = controller.clone();
        let submit_coordinator = coordinator.clone();
        let submit_session_id = farfold_session_id.clone();
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        thread::spawn(move || {
            sender
                .send(
                    crate::turn_coordinator::host_opencode_acp_turn_submit_blocking(
                        &submit_controller,
                        &submit_store,
                        &submit_runtime,
                        &submit_coordinator,
                        crate::turn_coordinator::HostOpenCodeAcpTurnSubmitInput {
                            farfold_session_id: submit_session_id,
                            native_session_id: NativeSessionId::parse("ses_keep").unwrap(),
                            text: "needs permission".to_string(),
                            provider_connection_id: None,
                            provider_config_version_id: None,
                            runtime_provider_id: None,
                            runtime_model_id: None,
                        },
                    ),
                )
                .unwrap();
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let pending = serde_json::to_value(interactions.snapshots().unwrap()).unwrap();
            if pending.as_array().is_some_and(|items| {
                items.iter().any(|item| {
                    item["interactionId"] == "0"
                        && item["runtimeGeneration"] == generation
                        && item["nativeSessionId"] == "ses_keep"
                })
            }) {
                break;
            }
            if std::time::Instant::now() >= deadline {
                panic!("permission was not registered");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        crate::turn_coordinator::host_opencode_acp_turn_abort_blocking(
            &controller,
            &store,
            &runtime,
            &interactions,
            &coordinator,
            crate::turn_coordinator::HostOpenCodeAcpTurnAbortInput {
                farfold_session_id: farfold_session_id.clone(),
                native_session_id: NativeSessionId::parse("ses_keep").unwrap(),
            },
        )
        .unwrap();
        let cancelled = receiver
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        assert!(matches!(
            cancelled,
            crate::turn_coordinator::HostOpenCodeTurnSubmission::Cancelled { .. }
        ));
        assert!(interactions.snapshots().unwrap().is_empty());
        let second = crate::turn_coordinator::host_opencode_acp_turn_submit_blocking(
            &controller,
            &store,
            &runtime,
            &coordinator,
            crate::turn_coordinator::HostOpenCodeAcpTurnSubmitInput {
                farfold_session_id,
                native_session_id: NativeSessionId::parse("ses_keep").unwrap(),
                text: "next turn".to_string(),
                provider_connection_id: None,
                provider_config_version_id: None,
                runtime_provider_id: None,
                runtime_model_id: None,
            },
        )
        .unwrap();
        assert!(matches!(
            second,
            crate::turn_coordinator::HostOpenCodeTurnSubmission::Accepted { .. }
        ));
        stop.store(true, Ordering::Release);
        transport.stop().unwrap();
    }

    #[test]
    fn acp_prompt_disconnect_keeps_result_unknown() {
        let (_temp, connection) = fixture_connection(
            r#"
import json,sys
json.loads(sys.stdin.readline())
sys.exit(0)
"#,
        );
        let runtime = OpenCodeAcpRuntime::default();
        *runtime.state.lock().unwrap() =
            OpenCodeAcpLifecycle::Running(Arc::new(Mutex::new(connection)));
        let native = NativeSessionId::parse("ses_keep").unwrap();
        let result = prompt_text(&runtime, &native, "hello acp");
        assert!(matches!(
            result,
            Err(AcpDispatchError::Unknown(_) | AcpDispatchError::NotSent(_))
        ));
    }

    #[test]
    #[ignore = "set OPENCODE_ACP_TEST_BINARY to the fixed opencode 1.18.30 arm64 binary"]
    fn fixed_opencode_acp_program_can_initialize_create_load_and_close_without_model_turn() {
        let binary = std::env::var("OPENCODE_ACP_TEST_BINARY")
            .expect("OPENCODE_ACP_TEST_BINARY must point to opencode 1.18.30");
        let binary = verify_acp_binary(&PathBuf::from(binary)).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("workspace");
        std::fs::create_dir(&cwd).unwrap();
        let home = temp.path().join("home");
        let data = temp.path().join("data");
        std::fs::create_dir(&home).unwrap();
        std::fs::create_dir(&data).unwrap();
        let mut command = Command::new(&binary);
        command
            .arg("acp")
            .arg("--pure")
            .arg("--cwd")
            .arg(&cwd)
            .current_dir(&cwd)
            .env_clear()
            .env("HOME", &home)
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("OPENCODE_CONFIG_DIR", data.join("config"))
            .env("XDG_CONFIG_HOME", data.join("xdg-config"))
            .env("XDG_DATA_HOME", data.join("xdg-data"))
            .env("XDG_CACHE_HOME", data.join("xdg-cache"))
            .env("XDG_STATE_HOME", data.join("xdg-state"));
        let transport = AcpTransport::spawn(&mut command).unwrap();
        let initialize = transport
            .request_timeout(
                "initialize",
                json!({"protocolVersion": 1, "clientCapabilities": {}}),
                Duration::from_secs(10),
            )
            .unwrap();
        assert_eq!(initialize["protocolVersion"], 1);
        assert_eq!(initialize["agentInfo"]["version"], OPENCODE_ACP_VERSION);
        assert_eq!(initialize["agentCapabilities"]["loadSession"], true);
        let created = transport
            .request_timeout(
                "session/new",
                json!({"cwd": cwd.clone(), "mcpServers": []}),
                Duration::from_secs(10),
            )
            .unwrap();
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        assert!(!session_id.is_empty());
        let store = HostStore::open(temp.path().join("host.sqlite3"));
        let binding = acp_binding(&binary).unwrap();
        let (farfold_session_id, _, navigation) =
            register_acp_runtime_and_session(&store, &binding, &cwd, &binary, &session_id).unwrap();
        assert_eq!(
            verified_saved_acp_binding(&store, &binding).unwrap(),
            binary
        );
        assert_eq!(
            serde_json::to_value(navigation.restore_state.unwrap()).unwrap()["lastSessionId"],
            farfold_session_id.as_str()
        );
        let loaded = transport
            .request_timeout(
                "session/load",
                json!({"cwd": cwd.clone(), "sessionId": session_id, "mcpServers": []}),
                Duration::from_secs(10),
            )
            .unwrap();
        assert!(loaded["configOptions"].is_array());
        transport
            .request_timeout(
                "session/close",
                json!({"sessionId": created["sessionId"].as_str().unwrap()}),
                Duration::from_secs(10),
            )
            .unwrap();
        transport.stop().unwrap();
        assert!(!transport.is_running().unwrap());
    }

    #[test]
    #[ignore = "set OPENCODE_ACP_TEST_BINARY to the fixed opencode 1.18.30 arm64 binary"]
    fn fixed_opencode_acp_program_reads_managed_private_config_without_model_turn() {
        let binary = std::env::var("OPENCODE_ACP_TEST_BINARY")
            .expect("OPENCODE_ACP_TEST_BINARY must point to opencode 1.18.30");
        let binary = verify_acp_binary(&PathBuf::from(binary)).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().join("app-data");
        let launch_root = temp.path().join("launch");
        let cwd = temp.path().join("workspace");
        std::fs::create_dir(&app_data).unwrap();
        std::fs::create_dir(&launch_root).unwrap();
        std::fs::create_dir(&cwd).unwrap();
        let store = HostStore::open(temp.path().join("host.sqlite3"));
        let saved = crate::managed_provider::save_api_key_in_dir(
            &app_data,
            Some(&store),
            crate::managed_provider::ManagedProviderApiKeySaveInput {
                provider_key: "openai".to_string(),
                label: "OpenAI Fixture".to_string(),
                account_label: "fixture".to_string(),
                endpoint: "https://fixture.example.invalid/v1".to_string(),
                api_kind: "openai-chat-completions".to_string(),
                api_key: "sk-fixture-do-not-send".to_string(),
                model_id: "gpt-fixture".to_string(),
                context_window: Some(128_000),
                max_tokens: Some(8_192),
                reasoning: Some(false),
                image_input: Some(false),
                supports_developer_role: Some(true),
                supports_reasoning_effort: Some(false),
            },
        )
        .unwrap();
        let input = OpenCodeAcpManagedSessionInput {
            binary_path: binary.clone(),
            cwd: cwd.clone(),
            provider_connection_id: saved.provider_connection_id,
            provider_config_version_id: saved.current_config_version_id,
            operation_id: "real-managed-acp".to_string(),
        };
        let binding = managed_acp_binding(
            &binary,
            &input.provider_connection_id,
            &input.provider_config_version_id,
        )
        .unwrap();
        let prepared = prepare_managed_acp_provider(
            &app_data,
            &launch_root,
            "real-managed-acp",
            &binding,
            &store,
            &input,
            true,
        )
        .unwrap();
        let mut command = Command::new(&binary);
        command
            .arg("acp")
            .arg("--pure")
            .arg("--cwd")
            .arg(&cwd)
            .current_dir(&cwd)
            .env_clear()
            .env("HOME", prepared.profile_root.join("home"))
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("OPENCODE_CONFIG_DIR", prepared.config_root.join("config"))
            .env("XDG_CONFIG_HOME", prepared.config_root.join("xdg-config"))
            .env("XDG_DATA_HOME", prepared.profile_root.join("xdg-data"))
            .env("XDG_CACHE_HOME", prepared.profile_root.join("xdg-cache"))
            .env("XDG_STATE_HOME", prepared.profile_root.join("xdg-state"));
        protect_directory(&prepared.profile_root.join("home")).unwrap();
        let transport = AcpTransport::spawn(&mut command).unwrap();
        let initialize = transport
            .request_timeout(
                "initialize",
                json!({"protocolVersion": 1, "clientCapabilities": {}}),
                Duration::from_secs(10),
            )
            .unwrap();
        assert_eq!(initialize["agentInfo"]["version"], OPENCODE_ACP_VERSION);
        let created = transport
            .request_timeout(
                "session/new",
                json!({"cwd": cwd.clone(), "mcpServers": []}),
                Duration::from_secs(10),
            )
            .unwrap();
        assert!(acp_config_options_select_target(
            &created["configOptions"],
            &prepared.binding.runtime_model_id
        ));
        transport.stop().unwrap();
    }

    #[test]
    #[ignore = "set OPENCODE_ACP_TEST_BINARY to the fixed opencode 1.18.30 arm64 binary"]
    fn fixed_opencode_acp_program_uses_chat_completions_with_managed_key_and_model() {
        use std::{
            io::{Read as _, Write as _},
            net::{TcpListener, TcpStream},
        };

        fn read_http_request(mut stream: &TcpStream) -> (String, String, Value) {
            let mut header = Vec::new();
            let mut buffer = [0_u8; 1];
            while !header.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut buffer).unwrap();
                header.push(buffer[0]);
            }
            let header_text = String::from_utf8(header).unwrap();
            let content_length = header_text
                .lines()
                .find_map(|line| {
                    line.strip_prefix("Content-Length:")
                        .or_else(|| line.strip_prefix("content-length:"))
                })
                .map(str::trim)
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            let mut body = vec![0_u8; content_length];
            stream.read_exact(&mut body).unwrap();
            let path = header_text
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or("")
                .to_string();
            let authorization = header_text
                .lines()
                .find_map(|line| {
                    line.strip_prefix("Authorization:")
                        .or_else(|| line.strip_prefix("authorization:"))
                })
                .map(str::trim)
                .unwrap_or("")
                .to_string();
            let body = serde_json::from_slice(&body).unwrap();
            (path, authorization, body)
        }

        fn write_chat_completion(mut stream: TcpStream) {
            let chunk = r#"data: {"id":"fixture","object":"chat.completion.chunk","created":0,"model":"gpt-fixture","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}

data: {"id":"fixture","object":"chat.completion.chunk","created":0,"model":"gpt-fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]

"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
                chunk.len(),
                chunk
            );
            stream.write_all(response.as_bytes()).unwrap();
        }

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener
            .set_nonblocking(false)
            .expect("fixture listener is blocking");
        let port = listener.local_addr().unwrap().port();
        let captured = Arc::new(Mutex::new(Vec::<(String, String, Value)>::new()));
        let captured_thread = captured.clone();
        let stop_server = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop_server_thread = stop_server.clone();
        let server = thread::spawn(move || {
            listener
                .set_nonblocking(true)
                .expect("fixture listener can be nonblocking");
            let deadline = std::time::Instant::now() + Duration::from_secs(20);
            while !stop_server_thread.load(Ordering::Acquire)
                && std::time::Instant::now() < deadline
            {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let request = read_http_request(&stream);
                        captured_thread.lock().unwrap().push(request);
                        write_chat_completion(stream);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(20));
                    }
                    Err(error) => panic!("fixture HTTP server failed: {error}"),
                }
            }
        });

        let binary = std::env::var("OPENCODE_ACP_TEST_BINARY")
            .expect("OPENCODE_ACP_TEST_BINARY must point to opencode 1.18.30");
        let binary = verify_acp_binary(&PathBuf::from(binary)).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().join("app-data");
        let launch_root = temp.path().join("launch");
        let cwd = temp.path().join("workspace");
        std::fs::create_dir(&app_data).unwrap();
        std::fs::create_dir(&launch_root).unwrap();
        std::fs::create_dir(&cwd).unwrap();
        let store = HostStore::open(temp.path().join("host.sqlite3"));
        let saved = crate::managed_provider::save_api_key_in_dir(
            &app_data,
            Some(&store),
            crate::managed_provider::ManagedProviderApiKeySaveInput {
                provider_key: "openai".to_string(),
                label: "OpenAI Fixture".to_string(),
                account_label: "fixture-http".to_string(),
                endpoint: format!("http://127.0.0.1:{port}/v1"),
                api_kind: "openai-chat-completions".to_string(),
                api_key: "sk-fixture-capture".to_string(),
                model_id: "gpt-fixture".to_string(),
                context_window: Some(128_000),
                max_tokens: Some(8_192),
                reasoning: Some(false),
                image_input: Some(false),
                supports_developer_role: Some(true),
                supports_reasoning_effort: Some(false),
            },
        )
        .unwrap();
        let input = OpenCodeAcpManagedSessionInput {
            binary_path: binary.clone(),
            cwd: cwd.clone(),
            provider_connection_id: saved.provider_connection_id,
            provider_config_version_id: saved.current_config_version_id,
            operation_id: "real-managed-acp-chat-completions".to_string(),
        };
        let binding = managed_acp_binding(
            &binary,
            &input.provider_connection_id,
            &input.provider_config_version_id,
        )
        .unwrap();
        let prepared = prepare_managed_acp_provider(
            &app_data,
            &launch_root,
            "real-managed-acp-chat-completions",
            &binding,
            &store,
            &input,
            true,
        )
        .unwrap();
        protect_directory(&prepared.profile_root.join("home")).unwrap();
        let mut command = Command::new(&binary);
        command
            .arg("acp")
            .arg("--pure")
            .arg("--cwd")
            .arg(&cwd)
            .current_dir(&cwd)
            .env_clear()
            .env("HOME", prepared.profile_root.join("home"))
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("OPENCODE_CONFIG_DIR", prepared.config_root.join("config"))
            .env("XDG_CONFIG_HOME", prepared.config_root.join("xdg-config"))
            .env("XDG_DATA_HOME", prepared.profile_root.join("xdg-data"))
            .env("XDG_CACHE_HOME", prepared.profile_root.join("xdg-cache"))
            .env("XDG_STATE_HOME", prepared.profile_root.join("xdg-state"));
        let transport = Arc::new(AcpTransport::spawn(&mut command).unwrap());
        transport
            .request_timeout(
                "initialize",
                json!({"protocolVersion": 1, "clientCapabilities": {}}),
                Duration::from_secs(10),
            )
            .unwrap();
        let created = transport
            .request_timeout(
                "session/new",
                json!({"cwd": cwd.clone(), "mcpServers": []}),
                Duration::from_secs(10),
            )
            .unwrap();
        let native_session_id = NativeSessionId::parse(created["sessionId"].as_str().unwrap())
            .expect("native session id parses");
        let runtime = OpenCodeAcpRuntime::default();
        *runtime.state.lock().unwrap() =
            OpenCodeAcpLifecycle::Running(Arc::new(Mutex::new(OpenCodeAcpConnection {
                transport: transport.clone(),
                binding,
                generation: 1,
                cwd,
                binary_path: binary,
                session_id: Some(native_session_id.as_str().to_string()),
                agent_name: Some("OpenCode".to_string()),
                agent_version: OPENCODE_ACP_VERSION.to_string(),
                protocol_version: 1,
                question_bridge: false,
                load_session: true,
                config_options: created["configOptions"].clone(),
                managed_provider: Some(prepared.binding),
                private_launch_dir: Some(prepared.config_root),
                last_error: None,
                dropped_events: 0,
                initialized_at_ms: 1,
                operations: AcpSessionOperations::default(),
                event_pump_stop: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            })));
        let prompt = prompt_text(&runtime, &native_session_id, "fixture hello").unwrap();
        assert_eq!(prompt["stopReason"], "end_turn");
        stop_server.store(true, Ordering::Release);
        let _ = TcpStream::connect(("127.0.0.1", port));
        server.join().unwrap();
        let requests = captured.lock().unwrap();
        assert!(!requests.is_empty());
        assert!(requests.iter().all(|(path, authorization, body)| {
            path == "/v1/chat/completions"
                && authorization == "Bearer sk-fixture-capture"
                && body.get("model").and_then(Value::as_str) == Some("gpt-fixture")
        }));
        assert!(
            requests
                .iter()
                .any(|(_, _, body)| { body.to_string().contains("fixture hello") })
        );
        let _ = opencode_acp_stop_blocking(runtime);
    }

    #[test]
    #[ignore = "set OPENCODE_ACP_TEST_BINARY to the fixed opencode 1.18.30 arm64 binary"]
    fn fixed_opencode_acp_real_permission_wait_can_cancel_and_continue() {
        let binary = std::env::var("OPENCODE_ACP_TEST_BINARY")
            .expect("OPENCODE_ACP_TEST_BINARY must point to opencode 1.18.30");
        let binary = verify_acp_binary(&PathBuf::from(binary)).unwrap();
        let server = ToolCallFixtureServer::start();
        let temp = tempfile::tempdir().unwrap();
        let app_data_root = temp.path().join("app-data");
        let host_path = temp.path().join("host.sqlite3");
        let cwd = temp.path().join("workspace");
        std::fs::create_dir(&app_data_root).unwrap();
        std::fs::create_dir(&cwd).unwrap();

        let store = HostStore::open(host_path);
        let saved = crate::managed_provider::save_api_key_in_dir(
            &app_data_root,
            Some(&store),
            crate::managed_provider::ManagedProviderApiKeySaveInput {
                provider_key: "openai".to_string(),
                label: "OpenAI Tool Fixture".to_string(),
                account_label: "permission-cancel".to_string(),
                endpoint: server.endpoint(),
                api_kind: "openai-chat-completions".to_string(),
                api_key: "sk-tool-fixture".to_string(),
                model_id: "gpt-fixture".to_string(),
                context_window: Some(128_000),
                max_tokens: Some(8_192),
                reasoning: Some(false),
                image_input: Some(false),
                supports_developer_role: Some(true),
                supports_reasoning_effort: Some(false),
            },
        )
        .unwrap();
        let runtime = OpenCodeAcpRuntime::default();
        let interactions = crate::interaction_registry::InteractionRegistry::default();
        let router =
            RuntimeEventRouter::with_capacity_and_observers(32, None, Some(interactions.clone()));
        let event_router = router.clone();
        let created = opencode_acp_new_managed_session_blocking_with_app_data(
            &app_data_root,
            runtime.clone(),
            router,
            store.clone(),
            OpenCodeAcpManagedSessionInput {
                binary_path: binary,
                cwd: cwd.clone(),
                provider_connection_id: saved.provider_connection_id.clone(),
                provider_config_version_id: saved.current_config_version_id.clone(),
                operation_id: "real-permission-cancel".to_string(),
            },
        )
        .unwrap();
        let _guard = OpenCodeAcpStopGuard(runtime.clone());
        let farfold_session_id = created
            .farfold_session_id
            .clone()
            .expect("managed new session registers Host session");
        let native_session_id =
            NativeSessionId::parse(created.session_id.clone()).expect("native session id parses");
        let generation = created.status.generation;
        let controller = Arc::new(crate::session_controller::HostSessionController::default());
        let coordinator = crate::turn_coordinator::TurnCoordinator::default();
        let submit_runtime = runtime.clone();
        let submit_store = store.clone();
        let submit_controller = controller.clone();
        let submit_coordinator = coordinator.clone();
        let submit_session_id = farfold_session_id.clone();
        let submit_native_id = native_session_id.clone();
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        thread::spawn(move || {
            let _ = sender.send(
                crate::turn_coordinator::host_opencode_acp_turn_submit_blocking(
                    &submit_controller,
                    &submit_store,
                    &submit_runtime,
                    &submit_coordinator,
                    crate::turn_coordinator::HostOpenCodeAcpTurnSubmitInput {
                        farfold_session_id: submit_session_id,
                        native_session_id: submit_native_id,
                        text: "Use bash to read /etc/hosts once.".to_string(),
                        provider_connection_id: None,
                        provider_config_version_id: None,
                        runtime_provider_id: None,
                        runtime_model_id: None,
                    },
                ),
            );
        });

        let pending = {
            let deadline = std::time::Instant::now() + Duration::from_secs(30);
            loop {
                let snapshots = serde_json::to_value(interactions.snapshots().unwrap()).unwrap();
                if let Some(permission) = snapshots.as_array().and_then(|items| {
                    items
                        .iter()
                        .find(|item| {
                            item["kind"] == "open_code_permission"
                                && item["runtimeGeneration"] == generation
                                && item["nativeSessionId"] == created.session_id
                        })
                        .cloned()
                }) {
                    break permission;
                }
                if let Ok(result) = receiver.try_recv() {
                    let events =
                        serde_json::to_value(event_router.snapshot(None, None).unwrap()).unwrap();
                    panic!(
                        "prompt finished before permission was registered: {result:?}; events={events}; requests={}",
                        serde_json::to_string(&chat_fixture_request_summary(&server.captured()))
                            .unwrap()
                    );
                }
                if std::time::Instant::now() >= deadline {
                    let events =
                        serde_json::to_value(event_router.snapshot(None, None).unwrap()).unwrap();
                    panic!(
                        "permission was not registered; interactions={snapshots}; events={events}; requests={}",
                        serde_json::to_string(&chat_fixture_request_summary(&server.captured()))
                            .unwrap()
                    );
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        assert_eq!(pending["runtimeGeneration"], generation);
        assert_eq!(pending["nativeSessionId"], created.session_id);
        assert_eq!(pending["state"], "pending");
        let request_id = pending["interactionId"]
            .as_str()
            .expect("permission request id is recorded")
            .to_string();
        let permission_event =
            wait_for_permission_event(&event_router, &request_id, &created.session_id);
        assert!(
            permission_event
                .pointer("/nativeEnvelope/payload/params/toolCall/title")
                .is_some_and(|title| title.to_string().contains("/etc/hosts"))
        );
        let option_kinds = permission_event["nativeEnvelope"]["payload"]["params"]["options"]
            .as_array()
            .expect("permission options are recorded")
            .iter()
            .filter_map(|option| option.get("kind").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert_eq!(
            option_kinds,
            vec!["allow_once", "allow_always", "reject_once"]
        );

        crate::turn_coordinator::host_opencode_acp_turn_abort_blocking(
            &controller,
            &store,
            &runtime,
            &interactions,
            &coordinator,
            crate::turn_coordinator::HostOpenCodeAcpTurnAbortInput {
                farfold_session_id: farfold_session_id.clone(),
                native_session_id: native_session_id.clone(),
            },
        )
        .unwrap();
        let cancelled = receiver
            .recv_timeout(Duration::from_secs(10))
            .unwrap()
            .unwrap();
        assert!(
            matches!(
                cancelled,
                crate::turn_coordinator::HostOpenCodeTurnSubmission::Cancelled { .. }
            ),
            "expected cancelled OpenCode ACP submission, got {cancelled:?}"
        );
        assert!(
            serde_json::to_value(interactions.snapshots().unwrap())
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["interactionId"].as_str() != Some(request_id.as_str()))
        );

        let next = crate::turn_coordinator::host_opencode_acp_turn_submit_blocking(
            &controller,
            &store,
            &runtime,
            &coordinator,
            crate::turn_coordinator::HostOpenCodeAcpTurnSubmitInput {
                farfold_session_id,
                native_session_id,
                text: "Say ok.".to_string(),
                provider_connection_id: None,
                provider_config_version_id: None,
                runtime_provider_id: None,
                runtime_model_id: None,
            },
        )
        .unwrap();
        assert!(matches!(
            next,
            crate::turn_coordinator::HostOpenCodeTurnSubmission::Accepted { .. }
        ));
        let requests = server.captured();
        assert!(
            requests
                .iter()
                .any(|(_, _, body)| chat_fixture_body_contains(body, "Use bash"))
        );
        assert!(
            requests
                .iter()
                .any(|(_, _, body)| chat_fixture_body_contains(body, "Say ok."))
        );
    }

    #[test]
    #[ignore = "set OPENCODE_ACP_TEST_BINARY to the fixed opencode 1.18.30 arm64 binary"]
    fn fixed_opencode_acp_managed_session_stops_cold_restores_old_version_and_new_uses_current() {
        let binary = std::env::var("OPENCODE_ACP_TEST_BINARY")
            .expect("OPENCODE_ACP_TEST_BINARY must point to opencode 1.18.30");
        let binary = verify_acp_binary(&PathBuf::from(binary)).unwrap();
        let server = ChatFixtureServer::start();
        let temp = tempfile::tempdir().unwrap();
        let app_data_root = temp.path().join("app-data");
        let host_path = temp.path().join("host.sqlite3");
        let cwd = temp.path().join("workspace");
        std::fs::create_dir(&app_data_root).unwrap();
        std::fs::create_dir(&cwd).unwrap();

        let store = HostStore::open(host_path.clone());
        let first = crate::managed_provider::save_api_key_in_dir(
            &app_data_root,
            Some(&store),
            crate::managed_provider::ManagedProviderApiKeySaveInput {
                provider_key: "openai".to_string(),
                label: "OpenAI Fixture".to_string(),
                account_label: "shared".to_string(),
                endpoint: server.endpoint(),
                api_kind: "openai-chat-completions".to_string(),
                api_key: "sk-first-fixture".to_string(),
                model_id: "gpt-first".to_string(),
                context_window: Some(200_000),
                max_tokens: Some(16_000),
                reasoning: Some(false),
                image_input: Some(false),
                supports_developer_role: Some(true),
                supports_reasoning_effort: Some(false),
            },
        )
        .unwrap();
        let first_binding = managed_acp_binding(
            &binary,
            &first.provider_connection_id,
            &first.current_config_version_id,
        )
        .unwrap();
        let first_runtime = OpenCodeAcpRuntime::default();
        let router = RuntimeEventRouter::default();
        let first_result = opencode_acp_new_managed_session_blocking_with_app_data(
            &app_data_root,
            first_runtime.clone(),
            router.clone(),
            store.clone(),
            OpenCodeAcpManagedSessionInput {
                binary_path: binary.clone(),
                cwd: cwd.clone(),
                provider_connection_id: first.provider_connection_id.clone(),
                provider_config_version_id: first.current_config_version_id.clone(),
                operation_id: "product-create-v1".to_string(),
            },
        )
        .unwrap();
        let first_session_id = first_result.session_id.clone();
        let farfold_session_id = first_result
            .farfold_session_id
            .clone()
            .expect("managed new session registers Host session");
        assert_eq!(
            first_result
                .status
                .managed_provider
                .as_ref()
                .unwrap()
                .provider_config_version_id,
            first.current_config_version_id
        );
        let first_profile_root = app_data_root
            .join("opencode-acp-experiment")
            .join("profiles")
            .join(safe_path_segment(first_binding.connection_id.as_str()));
        let first_config_root = app_data_root
            .join("opencode-acp-experiment")
            .join("launch-configs")
            .join("product-create-v1");
        let first_native_session_id = NativeSessionId::parse(first_session_id.clone()).unwrap();
        let seeded = prompt_text(
            &first_runtime,
            &first_native_session_id,
            "cold replay seed one",
        )
        .expect("first seed prompt succeeds before cold restore");
        assert_eq!(seeded["stopReason"], "end_turn");
        let seeded_second = prompt_text(
            &first_runtime,
            &first_native_session_id,
            "cold replay seed two",
        )
        .expect("second seed prompt succeeds before cold restore");
        assert_eq!(seeded_second["stopReason"], "end_turn");
        let stopped = opencode_acp_stop_blocking(first_runtime).unwrap();
        assert_eq!(stopped.state, "stopped");
        assert!(first_profile_root.exists());
        assert!(
            !first_config_root.exists(),
            "normal product stop removes only the owned launch config"
        );

        let second = crate::managed_provider::save_api_key_in_dir(
            &app_data_root,
            Some(&store),
            crate::managed_provider::ManagedProviderApiKeySaveInput {
                provider_key: "openai".to_string(),
                label: "OpenAI Fixture".to_string(),
                account_label: "shared".to_string(),
                endpoint: server.endpoint(),
                api_kind: "openai-chat-completions".to_string(),
                api_key: "sk-second-fixture".to_string(),
                model_id: "gpt-second".to_string(),
                context_window: Some(210_000),
                max_tokens: Some(17_000),
                reasoning: Some(false),
                image_input: Some(false),
                supports_developer_role: Some(true),
                supports_reasoning_effort: Some(false),
            },
        )
        .unwrap();
        assert_eq!(first.provider_connection_id, second.provider_connection_id);
        assert_ne!(
            first.current_config_version_id,
            second.current_config_version_id
        );

        let reopened_store = HostStore::open(host_path);
        let restored_runtime = OpenCodeAcpRuntime::default();
        let restored_router = RuntimeEventRouter::default();
        let opened = open_registered_host_session_with_app_data(
            &app_data_root,
            restored_runtime.clone(),
            restored_router.clone(),
            reopened_store.clone(),
            OpenCodeAcpHostOpenInput {
                binding: first_binding.clone(),
                farfold_session_id: farfold_session_id.clone(),
                working_copy_path: cwd.clone(),
                native_session_id: first_session_id.clone(),
            },
        )
        .unwrap();
        assert!(opened.runtime_generation > 0);
        std::thread::sleep(Duration::from_millis(500));
        let _ = opencode_acp_status_blocking(restored_runtime.clone(), restored_router.clone())
            .unwrap();
        let replay = serde_json::to_value(restored_router.snapshot(None, None).unwrap()).unwrap();
        let replay_events = replay["events"].as_array().unwrap();
        for expected in ["cold replay seed one", "cold replay seed two"] {
            assert!(
                replay_events.iter().any(|event| event["kind"] == "acp"
                    && event["nativeEnvelope"].to_string().contains(expected)),
                "session/load must replay official ACP events for {expected}; private DB reads are not allowed"
            );
        }
        let controller = crate::session_controller::HostSessionController::default();
        let coordinator = crate::turn_coordinator::TurnCoordinator::default();
        let forged_restored_submission =
            crate::turn_coordinator::host_opencode_acp_turn_submit_blocking(
                &controller,
                &reopened_store,
                &restored_runtime,
                &coordinator,
                crate::turn_coordinator::HostOpenCodeAcpTurnSubmitInput {
                    farfold_session_id: farfold_session_id.clone(),
                    native_session_id: NativeSessionId::parse(first_session_id.clone()).unwrap(),
                    text: "restore v1 forged hello".to_string(),
                    provider_connection_id: Some(second.provider_connection_id.clone()),
                    provider_config_version_id: Some(second.current_config_version_id.clone()),
                    runtime_provider_id: Some("forged-provider".to_string()),
                    runtime_model_id: Some("forged-model".to_string()),
                },
            );
        assert!(
            forged_restored_submission
                .unwrap_err()
                .contains("does not match the active managed Runtime Session"),
            "stale or forged ACP Provider receipt must be rejected"
        );

        let restored_submission = crate::turn_coordinator::host_opencode_acp_turn_submit_blocking(
            &controller,
            &reopened_store,
            &restored_runtime,
            &coordinator,
            crate::turn_coordinator::HostOpenCodeAcpTurnSubmitInput {
                farfold_session_id: farfold_session_id.clone(),
                native_session_id: NativeSessionId::parse(first_session_id.clone()).unwrap(),
                text: "restore v1 hello".to_string(),
                provider_connection_id: None,
                provider_config_version_id: None,
                runtime_provider_id: None,
                runtime_model_id: None,
            },
        )
        .unwrap();
        let restored_turn_id = match restored_submission {
            crate::turn_coordinator::HostOpenCodeTurnSubmission::Accepted { submission } => {
                submission.turn_id
            }
            crate::turn_coordinator::HostOpenCodeTurnSubmission::Unknown { detail }
            | crate::turn_coordinator::HostOpenCodeTurnSubmission::Failed { detail } => {
                panic!("restored v1 submit should be accepted, got unknown: {detail}")
            }
            crate::turn_coordinator::HostOpenCodeTurnSubmission::Cancelled { detail } => {
                panic!("restored v1 submit should be accepted, got cancelled: {detail}")
            }
        };
        let restored_turn_binding = reopened_store
            .test_turn_provider_binding(&restored_turn_id)
            .unwrap()
            .expect("restored v1 submit binds Provider version");
        assert_eq!(restored_turn_binding.0, first.current_config_version_id);
        assert_eq!(
            restored_turn_binding.1,
            format!("{}/gpt-first", first.provider_connection_id.as_str())
        );
        assert_eq!(restored_turn_binding.2, first_binding.connection_id);
        let snapshot_after_restore = reopened_store
            .provider_projection_snapshot(&first.provider_connection_id)
            .unwrap();
        assert_eq!(
            snapshot_after_restore.connection.current_config_version_id,
            second.current_config_version_id
        );
        assert_eq!(
            snapshot_after_restore.projections[0].config_version_id,
            second.current_config_version_id
        );
        let _ = opencode_acp_stop_blocking(restored_runtime);

        let second_runtime = OpenCodeAcpRuntime::default();
        let second_result = opencode_acp_new_managed_session_blocking_with_app_data(
            &app_data_root,
            second_runtime.clone(),
            RuntimeEventRouter::default(),
            reopened_store,
            OpenCodeAcpManagedSessionInput {
                binary_path: binary,
                cwd,
                provider_connection_id: second.provider_connection_id.clone(),
                provider_config_version_id: second.current_config_version_id.clone(),
                operation_id: "product-create-v2".to_string(),
            },
        )
        .unwrap();
        assert_eq!(
            second_result
                .status
                .managed_provider
                .as_ref()
                .unwrap()
                .provider_config_version_id,
            second.current_config_version_id
        );
        let second_native = NativeSessionId::parse(second_result.session_id).unwrap();
        let second_session_id = second_native.as_str().to_string();
        let second_submission = crate::turn_coordinator::host_opencode_acp_turn_submit_blocking(
            &controller,
            &store,
            &second_runtime,
            &coordinator,
            crate::turn_coordinator::HostOpenCodeAcpTurnSubmitInput {
                farfold_session_id: second_result
                    .farfold_session_id
                    .clone()
                    .expect("second managed session registers Host session"),
                native_session_id: second_native,
                text: "new v2 hello".to_string(),
                provider_connection_id: None,
                provider_config_version_id: None,
                runtime_provider_id: None,
                runtime_model_id: None,
            },
        )
        .unwrap();
        let second_turn_id = match second_submission {
            crate::turn_coordinator::HostOpenCodeTurnSubmission::Accepted { submission } => {
                submission.turn_id
            }
            crate::turn_coordinator::HostOpenCodeTurnSubmission::Unknown { detail }
            | crate::turn_coordinator::HostOpenCodeTurnSubmission::Failed { detail } => {
                panic!("new v2 submit should be accepted, got unknown: {detail}")
            }
            crate::turn_coordinator::HostOpenCodeTurnSubmission::Cancelled { detail } => {
                panic!("new v2 submit should be accepted, got cancelled: {detail}")
            }
        };
        let second_turn_binding = store
            .test_turn_provider_binding(&second_turn_id)
            .unwrap()
            .expect("new v2 submit binds Provider version");
        assert_eq!(second_turn_binding.0, second.current_config_version_id);
        assert_eq!(
            second_turn_binding.1,
            format!("{}/gpt-second", second.provider_connection_id.as_str())
        );
        assert_ne!(second_turn_binding.2, first_binding.connection_id);
        assert!(!second_session_id.is_empty());
        let _ = opencode_acp_stop_blocking(second_runtime);

        let captured = server.captured();
        assert!(captured.iter().any(|(path, authorization, body)| {
            path == "/v1/chat/completions"
                && authorization == "Bearer sk-first-fixture"
                && body.get("model").and_then(Value::as_str) == Some("gpt-first")
                && body.to_string().contains("restore v1 hello")
        }));
        assert!(captured.iter().any(|(path, authorization, body)| {
            path == "/v1/chat/completions"
                && authorization == "Bearer sk-second-fixture"
                && body.get("model").and_then(Value::as_str) == Some("gpt-second")
                && body.to_string().contains("new v2 hello")
        }));
    }

    #[test]
    #[ignore = "set OPENCODE_ACP_TEST_BINARY to the fixed opencode 1.18.30 arm64 binary"]
    fn fixed_shared_saved_connection_drives_pi_bridge_and_opencode_acp_without_reentering_key() {
        let binary = std::env::var("OPENCODE_ACP_TEST_BINARY")
            .expect("OPENCODE_ACP_TEST_BINARY must point to opencode 1.18.30");
        let binary = verify_acp_binary(&PathBuf::from(binary)).unwrap();
        let server = ChatFixtureServer::start();
        let temp = tempfile::tempdir().unwrap();
        let app_data_root = temp.path().join("app-data");
        let host_path = temp.path().join("host.sqlite3");
        let cwd = temp.path().join("workspace");
        let pi_agent_dir = temp.path().join("pi-agent");
        std::fs::create_dir(&app_data_root).unwrap();
        std::fs::create_dir(&cwd).unwrap();
        std::fs::create_dir(&pi_agent_dir).unwrap();

        let store = HostStore::open(host_path);
        store
            .register_runtime(&RuntimeRegistration {
                runtime_product_id: RuntimeProductId::parse(
                    crate::runtime_registry::PI_RUNTIME.product_id,
                )
                .unwrap(),
                display_name: crate::runtime_registry::PI_RUNTIME.display_name.to_string(),
                installation_id: InstallationId::parse(
                    crate::runtime_registry::PI_RUNTIME.installation_id,
                )
                .unwrap(),
                runtime_build_id: RuntimeBuildId::parse(
                    crate::runtime_registry::PI_RUNTIME.runtime_build_id,
                )
                .unwrap(),
                adapter_id: AdapterId::parse(crate::runtime_registry::PI_RUNTIME.adapter_id)
                    .unwrap(),
                distribution: RuntimeDistribution::Managed,
                observed_version: crate::runtime_registry::PI_RUNTIME.version.to_string(),
                artifact_sha256: crate::runtime_registry::PI_RUNTIME
                    .binary_sha256
                    .to_string(),
                connection_id: ConnectionId::parse(
                    crate::runtime_registry::PI_RUNTIME.default_connection_id,
                )
                .unwrap(),
                connection_label: "Pi native configuration".to_string(),
                connection_kind: RuntimeConnectionKind::ManagedLocal,
                created_at: 1,
                verified_at: 1,
            })
            .unwrap();
        let saved = crate::managed_provider::save_api_key_in_dir(
            &app_data_root,
            Some(&store),
            crate::managed_provider::ManagedProviderApiKeySaveInput {
                provider_key: "openai".to_string(),
                label: "OpenAI Shared Fixture".to_string(),
                account_label: "shared".to_string(),
                endpoint: server.endpoint(),
                api_kind: "openai-chat-completions".to_string(),
                api_key: "sk-shared-fixture".to_string(),
                model_id: "gpt-shared".to_string(),
                context_window: Some(200_000),
                max_tokens: Some(16_000),
                reasoning: Some(true),
                image_input: Some(true),
                supports_developer_role: Some(true),
                supports_reasoning_effort: Some(true),
            },
        )
        .unwrap();
        let listed =
            crate::managed_provider::list_committed_api_keys_in_dir(&app_data_root, &store)
                .unwrap()
                .into_iter()
                .find(|connection| {
                    connection.provider_connection_id == saved.provider_connection_id
                })
                .expect("Host list returns the saved shared connection");
        assert_eq!(
            listed.current_config_version_id.as_ref(),
            Some(&saved.current_config_version_id)
        );
        assert_eq!(listed.model_id, "gpt-shared");
        assert!(listed.reasoning);
        assert!(listed.image_input);
        assert!(listed.supports_reasoning_effort);

        let pi_capabilities =
            crate::pi_capabilities::PiCapabilities::with_agent_dir_for_test(pi_agent_dir);
        let _pi_stop = PiCapabilityStopGuard(&pi_capabilities);
        let pi_binding = crate::runtime_registry::RuntimeBinding {
            product_id: crate::host_ids::RuntimeProductId::parse(
                crate::runtime_registry::PI_RUNTIME.product_id,
            )
            .unwrap(),
            installation_id: crate::host_ids::InstallationId::parse(
                crate::runtime_registry::PI_RUNTIME.installation_id,
            )
            .unwrap(),
            runtime_build_id: crate::host_ids::RuntimeBuildId::parse(
                crate::runtime_registry::PI_RUNTIME.runtime_build_id,
            )
            .unwrap(),
            adapter_id: crate::host_ids::AdapterId::parse(
                crate::runtime_registry::PI_RUNTIME.adapter_id,
            )
            .unwrap(),
            connection_id: crate::host_ids::ConnectionId::parse(
                crate::runtime_registry::PI_RUNTIME.default_connection_id,
            )
            .unwrap(),
        };
        let before_pi_apply = server.captured().len();
        crate::managed_provider::managed_provider_apply_pi_blocking_with_app_data(
            &app_data_root,
            &store,
            &pi_capabilities,
            &pi_binding,
            crate::managed_provider::ManagedProviderApplyPiInput {
                provider_connection_id: listed.provider_connection_id.clone(),
                provider_config_version_id: listed.current_config_version_id.clone().unwrap(),
                operation_id: "shared-pi-apply".to_string(),
                runtime_product_id: pi_binding.product_id.clone(),
                installation_id: pi_binding.installation_id.clone(),
                runtime_connection_id: pi_binding.connection_id.clone(),
                runtime_provider_id: listed.provider_connection_id.as_str().to_string(),
                runtime_model_id: listed.model_id.clone(),
            },
        )
        .unwrap();
        let before_pi_probe = server.captured().len();
        let pi_probe = crate::pi_capabilities::test_connection_and_wait(
            &pi_capabilities,
            listed.provider_connection_id.as_str().to_string(),
            listed.model_id.clone(),
        )
        .unwrap_or_else(|error| {
            panic!(
                "Pi probe failed: {error}; fixture requests: {}",
                serde_json::to_string_pretty(&chat_fixture_request_summary(&server.captured()))
                    .unwrap()
            )
        });
        assert_eq!(pi_probe["model"]["id"], "gpt-shared");
        assert!(
            pi_probe["response"].to_string().contains("ok"),
            "Pi probe response should come from the local fixture stream: {}",
            serde_json::to_string_pretty(&pi_probe).unwrap()
        );
        assert_eq!(pi_probe["bridge"]["sdkVersion"], "0.84.3");
        let pi_dispatches = pi_probe["dispatches"]
            .as_array()
            .expect("Pi probe returns dispatch evidence");
        assert!(
            pi_dispatches.iter().any(|dispatch| {
                dispatch["url"]["path"]
                    .as_str()
                    .is_some_and(|path| path == "/v1/chat/completions")
                    && dispatch["method"] == "POST"
                    && dispatch["hasAuthorization"] == true
                    && dispatch["body"]["model"] == "gpt-shared"
                    && dispatch["body"]["messageRoles"]
                        .as_array()
                        .is_some_and(|roles| roles.iter().any(|role| role == "user"))
            }),
            "Pi probe should dispatch a real local Chat Completions request: {}",
            serde_json::to_string_pretty(&pi_probe).unwrap()
        );
        let after_pi_probe = server.captured();
        let pi_apply_requests = &after_pi_probe[before_pi_apply..before_pi_probe];
        let pi_requests = &after_pi_probe[before_pi_probe..];
        assert!(
            pi_requests.iter().any(|(path, authorization, body)| {
                path == "/v1/chat/completions"
                    && authorization == "Bearer sk-shared-fixture"
                    && body.get("model").and_then(Value::as_str) == Some("gpt-shared")
                    && chat_fixture_body_contains(body, "Reply OK")
            }),
            "Pi probe should use the saved key/model and explicit probe prompt; apply requests: {}; probe requests: {}; all requests: {}; pi response: {}",
            serde_json::to_string_pretty(&chat_fixture_request_summary(pi_apply_requests)).unwrap(),
            serde_json::to_string_pretty(&chat_fixture_request_summary(pi_requests)).unwrap(),
            serde_json::to_string_pretty(&chat_fixture_request_summary(&after_pi_probe)).unwrap(),
            serde_json::to_string_pretty(&pi_probe).unwrap()
        );
        crate::pi_capabilities::stop_process(&pi_capabilities).unwrap();

        let runtime = OpenCodeAcpRuntime::default();
        let _oc_stop = OpenCodeAcpStopGuard(runtime.clone());
        let router = RuntimeEventRouter::default();
        let result = opencode_acp_new_managed_session_blocking_with_app_data(
            &app_data_root,
            runtime.clone(),
            router,
            store.clone(),
            OpenCodeAcpManagedSessionInput {
                binary_path: binary,
                cwd,
                provider_connection_id: saved.provider_connection_id.clone(),
                provider_config_version_id: saved.current_config_version_id.clone(),
                operation_id: "shared-oc-create".to_string(),
            },
        )
        .unwrap();
        let controller = crate::session_controller::HostSessionController::default();
        let coordinator = crate::turn_coordinator::TurnCoordinator::default();
        let before_oc_prompt = server.captured().len();
        let submission = crate::turn_coordinator::host_opencode_acp_turn_submit_blocking(
            &controller,
            &store,
            &runtime,
            &coordinator,
            crate::turn_coordinator::HostOpenCodeAcpTurnSubmitInput {
                farfold_session_id: result.farfold_session_id.unwrap(),
                native_session_id: NativeSessionId::parse(result.session_id).unwrap(),
                text: "oc shared hello".to_string(),
                provider_connection_id: None,
                provider_config_version_id: None,
                runtime_provider_id: None,
                runtime_model_id: None,
            },
        )
        .unwrap();
        assert!(matches!(
            submission,
            crate::turn_coordinator::HostOpenCodeTurnSubmission::Accepted { .. }
        ));
        let _ = opencode_acp_stop_blocking(runtime);

        let after_oc_prompt = server.captured();
        let oc_requests = &after_oc_prompt[before_oc_prompt..];
        assert!(
            oc_requests.iter().any(|(path, authorization, body)| {
                path == "/v1/chat/completions"
                    && authorization == "Bearer sk-shared-fixture"
                    && body.get("model").and_then(Value::as_str) == Some("gpt-shared")
                    && chat_fixture_body_contains(body, "oc shared hello")
            }),
            "OpenCode ACP prompt should use the saved key/model and Host-submitted text: {}",
            serde_json::to_string_pretty(&chat_fixture_request_summary(oc_requests)).unwrap()
        );
        let all_requests = server.captured();
        let shared_requests = all_requests
            .iter()
            .filter(|(path, authorization, body)| {
                path == "/v1/chat/completions"
                    && authorization == "Bearer sk-shared-fixture"
                    && body.get("model").and_then(Value::as_str) == Some("gpt-shared")
            })
            .count();
        assert!(
            shared_requests >= 2,
            "Pi and OpenCode ACP should both use the same saved key/model: {}",
            serde_json::to_string_pretty(&chat_fixture_request_summary(&all_requests)).unwrap()
        );
    }
}
