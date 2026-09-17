use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::{
    host_ids::{
        AdapterId, ConnectionId, InstallationId, ProviderConfigVersionId, ProviderConnectionId,
        RuntimeBuildId, RuntimeProductId, derived_host_id,
    },
    host_store::{
        HostStore,
        provider_projection::{ProviderApplyState, ProviderConnectionSource, ProviderSaveState},
    },
    runtime_registry::RuntimeBinding,
};

use super::status::{OpenCodeAcpLaunchRecord, OpenCodeAcpManagedProviderBinding};

pub(crate) const OPENCODE_ACP_VERSION: &str = "1.18.30";
pub(crate) const OPENCODE_ACP_VERSION_FOR_ADAPTER: &str = OPENCODE_ACP_VERSION;
pub(crate) const OPENCODE_ACP_BINARY_SHA256: &str =
    "2d0c9c339bb91046c6ea951c97664bc2f8a8eaca707f31fbfbb7bc73c4eddc62";
pub(crate) const OPENCODE_ACP_ADAPTER_ID: &str = "opencode-acp-stdio-v1";
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
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

pub(crate) fn verify_acp_binary(path: &Path) -> Result<PathBuf, String> {
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

pub(crate) fn acp_binding(binary_path: &Path) -> Result<RuntimeBinding, String> {
    acp_binding_for_discriminator(binary_path, "stdio")
}

pub(crate) fn managed_acp_binding(
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

pub(crate) fn managed_acp_registered_binding(
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

pub(crate) fn managed_acp_connection_id(
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

/// The Farfold-managed Provider projection bound to this exact Runtime
/// connection, if one is saved and applied. Lives in `identity` because it is
/// part of resolving a verified connection target, not of session status.
pub(crate) fn managed_provider_for_runtime_target(
    store: &HostStore,
    binding: &RuntimeBinding,
) -> Result<Option<OpenCodeAcpManagedProviderBinding>, String> {
    for connection in
        store.provider_connections_by_source(ProviderConnectionSource::FarfoldManaged)?
    {
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

pub(crate) fn is_acp_binding(binding: &RuntimeBinding) -> bool {
    binding.product_id.as_str() == "opencode"
        && binding.adapter_id.as_str() == OPENCODE_ACP_ADAPTER_ID
}

pub(crate) fn acp_launch_record(binary_path: &Path) -> OpenCodeAcpLaunchRecord {
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

pub(crate) fn verified_saved_acp_binding(
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
