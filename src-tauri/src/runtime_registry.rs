use crate::performance_trace::{RuntimeCheckPhase as Phase, RuntimeCheckTrace};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fmt::Write as _,
    fs::{self, File},
    io::Read,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

const RUNTIME_VERSION_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RUNTIME_VERSION_BYTES: usize = 1_024;
const MAX_RUNTIME_DOWNLOAD_BYTES: u64 = 128 * 1024 * 1024;
const MAX_RUNTIME_EXECUTABLE_BYTES: u64 = 256 * 1024 * 1024;
const OPENCODE_ACP_ARCHIVE_URL: &str =
    "https://github.com/anomalyco/opencode/releases/download/v1.18.30/opencode-darwin-arm64.zip";

pub(crate) const PI_RUNTIME_PRODUCT_ID: &str = "pi";
pub(crate) const PI_RUNTIME_INSTALLATION_ID: &str = "bundled-pi";
pub(crate) const PI_RUNTIME_BUILD_ID: &str =
    "pi@0.84.3+sha256:e844dc14981fc70c7f4c45c5ba5f8c237199891bd8520d1ed21fe78be6479dac";
pub(crate) const PI_RUNTIME_ADAPTER_ID: &str = "pi-rpc-jsonl";
pub(crate) const PI_RUNTIME_CONNECTION_ID: &str = "pi-local-native-config-v1";
pub(crate) const PI_RUNTIME_VERSION: &str = "0.84.3";
pub(crate) const PI_RUNTIME_BINARY_SHA256: &str =
    "e844dc14981fc70c7f4c45c5ba5f8c237199891bd8520d1ed21fe78be6479dac";

pub(crate) const OPENCODE_RUNTIME_PRODUCT_ID: &str = "opencode";
pub(crate) const OPENCODE_RUNTIME_INSTALLATION_ID: &str = "bundled-opencode-1.15.13-arm64";
pub(crate) const OPENCODE_RUNTIME_BUILD_ID: &str =
    "opencode@1.15.13+sha256:1cdcb7e426a863528a41ae8f9f6b65470b8395ddd48937229b01299ddc1085f0";
pub(crate) const OPENCODE_RUNTIME_ADAPTER_ID: &str = "opencode-server-http-sse-v1";
pub(crate) const OPENCODE_RUNTIME_CONNECTION_ID: &str = "opencode-local-native-config-v1";
pub(crate) const OPENCODE_RUNTIME_VERSION: &str = "1.15.13";
pub(crate) const OPENCODE_RUNTIME_BINARY_SHA256: &str =
    "1cdcb7e426a863528a41ae8f9f6b65470b8395ddd48937229b01299ddc1085f0";
pub(crate) const OPENCODE_ACP_RUNTIME_INSTALLATION_ID: &str = "opencode-acp-system-1.18.30-arm64";
pub(crate) const OPENCODE_ACP_RUNTIME_BUILD_ID: &str =
    "opencode-acp@1.18.30+sha256:2d0c9c339bb91046c6ea951c97664bc2f8a8eaca707f31fbfbb7bc73c4eddc62";
pub(crate) const OPENCODE_ACP_RUNTIME_ADAPTER_ID: &str = "opencode-acp-stdio-v1";
pub(crate) const OPENCODE_ACP_RUNTIME_CONNECTION_ID: &str = "opencode-acp-system-local-v1";
pub(crate) const OPENCODE_ACP_RUNTIME_VERSION: &str = "1.18.30";
pub(crate) const OPENCODE_ACP_RUNTIME_BINARY_SHA256: &str =
    "2d0c9c339bb91046c6ea951c97664bc2f8a8eaca707f31fbfbb7bc73c4eddc62";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedRuntimeCandidateInput {
    pub(crate) runtime: ManagedRuntimeKey,
    pub(crate) path: PathBuf,
    pub(crate) source: Option<ManagedRuntimeCandidateSource>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ManagedRuntimeCandidateSource {
    Bundled,
    Environment,
    Path,
    Common,
    Manual,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeCandidatePath {
    path: PathBuf,
    source: ManagedRuntimeCandidateSource,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeCandidateInspection {
    pub(crate) runtime: RuntimeIdentity,
    pub(crate) display_name: String,
    pub(crate) selected_path: PathBuf,
    pub(crate) canonical_path: PathBuf,
    pub(crate) source: ManagedRuntimeCandidateSource,
    pub(crate) distribution: String,
    pub(crate) observed_version: String,
    pub(crate) expected_version: String,
    pub(crate) artifact_sha256: String,
    pub(crate) expected_sha256: Option<String>,
    pub(crate) compatible: bool,
    pub(crate) launch_reference_available: bool,
    pub(crate) activation: String,
    pub(crate) verified_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeCandidates {
    runtime: RuntimeIdentity,
    paths: Vec<ManagedRuntimeCandidatePath>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeSavedInstallation {
    pub(crate) installation_id: String,
    pub(crate) runtime_build_id: String,
    pub(crate) connection_id: String,
    pub(crate) inspection: ManagedRuntimeCandidateInspection,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ManagedRuntimeKey {
    Pi,
    Opencode,
    OpencodeAcp,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeInstallationStatus {
    runtime: ManagedRuntimeKey,
    phase: String,
    cancellable: bool,
}

#[derive(Default)]
struct ManagedRuntimeInstallationOperation {
    cancel_requested: bool,
    child_pid: Option<u32>,
}

#[derive(Clone, Default)]
pub(crate) struct ManagedRuntimeInstallationOperations {
    inner: Arc<Mutex<HashMap<ManagedRuntimeKey, ManagedRuntimeInstallationOperation>>>,
}

struct ManagedRuntimeInstallationGuard {
    operations: ManagedRuntimeInstallationOperations,
    runtime: ManagedRuntimeKey,
}

impl Drop for ManagedRuntimeInstallationGuard {
    fn drop(&mut self) {
        if let Ok(mut operations) = self.operations.inner.lock() {
            operations.remove(&self.runtime);
        }
    }
}

impl ManagedRuntimeInstallationOperations {
    fn begin(&self, runtime: ManagedRuntimeKey) -> Result<ManagedRuntimeInstallationGuard, String> {
        let mut operations = self
            .inner
            .lock()
            .map_err(|_| "Runtime 安装状态不可用".to_string())?;
        if operations.contains_key(&runtime) {
            return Err("此 Runtime 安装正在进行，请等待当前安装结束或取消。".to_string());
        }
        operations.insert(runtime, ManagedRuntimeInstallationOperation::default());
        Ok(ManagedRuntimeInstallationGuard {
            operations: self.clone(),
            runtime,
        })
    }

    fn status(
        &self,
        runtime: ManagedRuntimeKey,
    ) -> Result<ManagedRuntimeInstallationStatus, String> {
        let operations = self
            .inner
            .lock()
            .map_err(|_| "Runtime 安装状态不可用".to_string())?;
        let phase = operations
            .get(&runtime)
            .map(|operation| {
                if operation.cancel_requested {
                    "cancelling"
                } else {
                    "running"
                }
            })
            .unwrap_or("idle")
            .to_string();
        Ok(ManagedRuntimeInstallationStatus {
            runtime,
            cancellable: phase != "idle",
            phase,
        })
    }

    fn request_cancel(
        &self,
        runtime: ManagedRuntimeKey,
    ) -> Result<ManagedRuntimeInstallationStatus, String> {
        let child_pid = {
            let mut operations = self
                .inner
                .lock()
                .map_err(|_| "Runtime 安装状态不可用".to_string())?;
            let Some(operation) = operations.get_mut(&runtime) else {
                return Ok(ManagedRuntimeInstallationStatus {
                    runtime,
                    phase: "idle".to_string(),
                    cancellable: false,
                });
            };
            operation.cancel_requested = true;
            operation.child_pid
        };
        if let Some(pid) = child_pid {
            let _ = Command::new("/bin/kill")
                .arg("-TERM")
                .arg(pid.to_string())
                .status();
        }
        self.status(runtime)
    }

    fn is_cancelled(&self, runtime: ManagedRuntimeKey) -> bool {
        self.inner
            .lock()
            .ok()
            .and_then(|operations| {
                operations
                    .get(&runtime)
                    .map(|operation| operation.cancel_requested)
            })
            .unwrap_or(false)
    }

    fn set_child_pid(&self, runtime: ManagedRuntimeKey, child_pid: Option<u32>) {
        if let Ok(mut operations) = self.inner.lock()
            && let Some(operation) = operations.get_mut(&runtime)
        {
            operation.child_pid = child_pid;
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeIdentity {
    pub(crate) product_id: String,
    pub(crate) installation_id: String,
    pub(crate) adapter_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ManagedRuntimeDefinition {
    pub(crate) product_id: &'static str,
    pub(crate) installation_id: &'static str,
    pub(crate) runtime_build_id: &'static str,
    pub(crate) adapter_id: &'static str,
    pub(crate) default_connection_id: &'static str,
    pub(crate) display_name: &'static str,
    pub(crate) version: &'static str,
    pub(crate) distribution: &'static str,
    pub(crate) protocol: &'static str,
    pub(crate) binary_resource_path: &'static str,
    pub(crate) binary_sha256: &'static str,
}

/// Owned identities for both bundled and user-selected Runtime connections.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RuntimeBinding {
    pub(crate) product_id: crate::host_ids::RuntimeProductId,
    pub(crate) installation_id: crate::host_ids::InstallationId,
    pub(crate) runtime_build_id: crate::host_ids::RuntimeBuildId,
    pub(crate) adapter_id: crate::host_ids::AdapterId,
    pub(crate) connection_id: crate::host_ids::ConnectionId,
}

impl RuntimeBinding {
    pub(crate) fn identity(&self) -> RuntimeIdentity {
        RuntimeIdentity {
            product_id: self.product_id.as_str().to_owned(),
            installation_id: self.installation_id.as_str().to_owned(),
            adapter_id: self.adapter_id.as_str().to_owned(),
        }
    }
}

impl From<ManagedRuntimeDefinition> for RuntimeBinding {
    fn from(value: ManagedRuntimeDefinition) -> Self {
        use crate::host_ids::*;
        Self {
            product_id: RuntimeProductId::parse(value.product_id).expect("fixed product ID"),
            installation_id: InstallationId::parse(value.installation_id)
                .expect("fixed installation ID"),
            runtime_build_id: RuntimeBuildId::parse(value.runtime_build_id)
                .expect("fixed build ID"),
            adapter_id: AdapterId::parse(value.adapter_id).expect("fixed adapter ID"),
            connection_id: ConnectionId::parse(value.default_connection_id)
                .expect("fixed connection ID"),
        }
    }
}

impl ManagedRuntimeDefinition {
    pub(crate) fn identity(self) -> RuntimeIdentity {
        RuntimeIdentity {
            product_id: self.product_id.to_string(),
            installation_id: self.installation_id.to_string(),
            adapter_id: self.adapter_id.to_string(),
        }
    }
}

impl ManagedRuntimeKey {
    pub(crate) fn definition(self) -> ManagedRuntimeDefinition {
        match self {
            Self::Pi => PI_RUNTIME,
            Self::Opencode => OPENCODE_RUNTIME,
            Self::OpencodeAcp => OPENCODE_ACP_RUNTIME,
        }
    }
}

pub(crate) const PI_RUNTIME: ManagedRuntimeDefinition = ManagedRuntimeDefinition {
    product_id: PI_RUNTIME_PRODUCT_ID,
    installation_id: PI_RUNTIME_INSTALLATION_ID,
    runtime_build_id: PI_RUNTIME_BUILD_ID,
    adapter_id: PI_RUNTIME_ADAPTER_ID,
    default_connection_id: PI_RUNTIME_CONNECTION_ID,
    display_name: "Pi",
    version: PI_RUNTIME_VERSION,
    distribution: "bundled",
    protocol: "pi-rpc-jsonl",
    binary_resource_path: "pi-runtime/pi",
    binary_sha256: PI_RUNTIME_BINARY_SHA256,
};

pub(crate) const PI_ACP_RUNTIME: ManagedRuntimeDefinition = ManagedRuntimeDefinition {
    installation_id: "bundled-pi-acp",
    runtime_build_id: "pi-acp@0.84.3+sha256:e844dc14981fc70c7f4c45c5ba5f8c237199891bd8520d1ed21fe78be6479dac",
    adapter_id: crate::pi_acp_interactions::PI_ACP_ADAPTER_ID,
    default_connection_id: "pi-acp-managed-local-v1",
    protocol: "pi-acp-stdio",
    ..PI_RUNTIME
};

pub(crate) const OPENCODE_RUNTIME: ManagedRuntimeDefinition = ManagedRuntimeDefinition {
    product_id: OPENCODE_RUNTIME_PRODUCT_ID,
    installation_id: OPENCODE_RUNTIME_INSTALLATION_ID,
    runtime_build_id: OPENCODE_RUNTIME_BUILD_ID,
    adapter_id: OPENCODE_RUNTIME_ADAPTER_ID,
    default_connection_id: OPENCODE_RUNTIME_CONNECTION_ID,
    display_name: "OpenCode",
    version: OPENCODE_RUNTIME_VERSION,
    distribution: "bundled",
    protocol: "opencode-server-http-sse",
    binary_resource_path: "opencode-runtime/opencode",
    binary_sha256: OPENCODE_RUNTIME_BINARY_SHA256,
};

pub(crate) const OPENCODE_ACP_RUNTIME: ManagedRuntimeDefinition = ManagedRuntimeDefinition {
    product_id: OPENCODE_RUNTIME_PRODUCT_ID,
    installation_id: OPENCODE_ACP_RUNTIME_INSTALLATION_ID,
    runtime_build_id: OPENCODE_ACP_RUNTIME_BUILD_ID,
    adapter_id: OPENCODE_ACP_RUNTIME_ADAPTER_ID,
    default_connection_id: OPENCODE_ACP_RUNTIME_CONNECTION_ID,
    display_name: "OpenCode ACP",
    version: OPENCODE_ACP_RUNTIME_VERSION,
    distribution: "system",
    protocol: "opencode-acp-stdio",
    binary_resource_path: "opencode-acp-runtime/opencode",
    binary_sha256: OPENCODE_ACP_RUNTIME_BINARY_SHA256,
};

fn runtime_product_display_name(product_id: &str) -> Result<&'static str, String> {
    match product_id {
        PI_RUNTIME_PRODUCT_ID => Ok("Pi"),
        OPENCODE_RUNTIME_PRODUCT_ID => Ok("OpenCode"),
        _ => Err(format!("Unknown Runtime product ID {product_id}")),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ObservedRuntimeInstallation {
    pub(crate) definition: ManagedRuntimeDefinition,
    pub(crate) binary_path: PathBuf,
    pub(crate) observed_version: String,
    pub(crate) artifact_sha256: String,
}

pub(crate) fn pi_identity() -> RuntimeIdentity {
    PI_RUNTIME.identity()
}

fn development_binary_path(definition: ManagedRuntimeDefinition) -> Option<PathBuf> {
    let prepared = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(definition.binary_resource_path);
    if prepared.is_file() {
        return Some(prepared);
    }
    #[cfg(debug_assertions)]
    if definition.product_id == OPENCODE_RUNTIME_PRODUCT_ID
        && let Some(path) = std::env::var_os("FARFOLD_OPENCODE_BINARY")
    {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

fn managed_binary_path(
    app: &AppHandle,
    definition: ManagedRuntimeDefinition,
) -> Result<PathBuf, String> {
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|directory| directory.join(definition.binary_resource_path))
        .filter(|path| path.is_file());
    bundled
        .or_else(|| development_binary_path(definition))
        .ok_or_else(|| {
            format!(
                "Cannot locate the pinned {} Runtime artifact",
                definition.display_name
            )
        })
}

pub(crate) fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| {
        format!(
            "Cannot open managed Runtime artifact {}: {error}",
            path.display()
        )
    })?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| {
            format!(
                "Cannot read managed Runtime artifact {}: {error}",
                path.display()
            )
        })?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    let digest = digest.finalize();
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(encoded)
}

fn binary_version(path: &Path, display_name: &str) -> Result<String, String> {
    binary_version_observed(path, display_name, &mut |_| {})
}

fn binary_version_observed(
    path: &Path,
    display_name: &str,
    observe: &mut impl FnMut(Phase),
) -> Result<String, String> {
    let temporary =
        tempfile::tempdir().map_err(|_| "Cannot create Runtime check directory".to_string())?;
    observe(Phase::SpawnBegin);
    let mut child = Command::new(path)
        .arg("--version")
        .env_clear()
        .env("HOME", temporary.path())
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .current_dir(temporary.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            observe(Phase::SpawnFailed {
                errno: error.raw_os_error(),
            });
            format!("Cannot inspect {display_name} Runtime version: {error}")
        })?;
    let deadline = Instant::now() + RUNTIME_VERSION_TIMEOUT;
    observe(Phase::Spawned { pid: child.id() });
    let mut polls = 0;
    let status = loop {
        polls += 1;
        match child.try_wait() {
            Ok(Some(status)) => {
                observe(Phase::Exited {
                    polls,
                    code: status.code(),
                    success: status.success(),
                });
                break status;
            }
            Ok(None) if Instant::now() < deadline => {
                if polls == 1 || polls % 50 == 0 {
                    observe(Phase::Pending { polls });
                }
                thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                observe(Phase::Timeout { polls });
                observe(crate::performance_trace::child_state(child.id()));
                use std::os::fd::AsRawFd;
                let buffered = child.stdout.as_ref().and_then(|pipe| {
                    let mut bytes: libc::c_int = 0;
                    (unsafe { libc::ioctl(pipe.as_raw_fd(), libc::FIONREAD, &mut bytes) } == 0)
                        .then_some(bytes.max(0) as u32)
                });
                observe(Phase::BufferedOutput { bytes: buffered });
                observe(Phase::Killed {
                    success: child.kill().is_ok(),
                });
                observe(Phase::Reaped {
                    success: child.wait().is_ok(),
                });
                return Err(format!("{display_name} Runtime version check timed out"));
            }
            Err(error) => {
                observe(Phase::ObserveFailed {
                    errno: error.raw_os_error(),
                });
                observe(Phase::Killed {
                    success: child.kill().is_ok(),
                });
                observe(Phase::Reaped {
                    success: child.wait().is_ok(),
                });
                return Err(format!(
                    "Cannot observe {display_name} Runtime version check: {error}"
                ));
            }
        }
    };
    let output = child
        .wait_with_output()
        .map_err(|error| format!("Cannot read {display_name} Runtime version: {error}"))?;
    observe(Phase::Output {
        bytes: output.stdout.len(),
    });
    if !status.success() {
        return Err(format!(
            "{display_name} Runtime version check failed with status {}",
            status
        ));
    }
    if output.stdout.len() > MAX_RUNTIME_VERSION_BYTES {
        observe(Phase::Parsed {
            valid_utf8: std::str::from_utf8(&output.stdout).is_ok(),
            within_limit: false,
        });
        return Err(format!(
            "{display_name} Runtime version output is too large"
        ));
    }
    observe(Phase::Parsed {
        valid_utf8: std::str::from_utf8(&output.stdout).is_ok(),
        within_limit: true,
    });
    String::from_utf8(output.stdout)
        .map(|value| value.trim().to_string())
        .map_err(|error| format!("{display_name} Runtime returned a non-UTF-8 version: {error}"))
}

pub(crate) fn verify_managed_installation(
    app: &AppHandle,
    definition: ManagedRuntimeDefinition,
) -> Result<ObservedRuntimeInstallation, String> {
    let binary_path = managed_binary_path(app, definition)?;
    let trace = RuntimeCheckTrace::new(
        app,
        definition.binary_resource_path,
        definition.binary_sha256,
    );
    trace.record(Phase::Enter {
        bundled: app
            .path()
            .resource_dir()
            .ok()
            .is_some_and(|root| binary_path == root.join(definition.binary_resource_path)),
    });
    verify_managed_binary_path_observed(binary_path, definition, &mut |phase| trace.record(phase))
}

pub(crate) fn verify_managed_installation_in_resource_dir(
    resource_dir: &Path,
    definition: ManagedRuntimeDefinition,
) -> Result<ObservedRuntimeInstallation, String> {
    verify_managed_binary_path(
        resource_dir.join(definition.binary_resource_path),
        definition,
    )
}

pub(crate) fn verify_managed_binary_path(
    binary_path: PathBuf,
    definition: ManagedRuntimeDefinition,
) -> Result<ObservedRuntimeInstallation, String> {
    verify_managed_binary_path_observed(binary_path, definition, &mut |_| {})
}

fn verify_managed_binary_path_observed(
    binary_path: PathBuf,
    definition: ManagedRuntimeDefinition,
    observe: &mut impl FnMut(Phase),
) -> Result<ObservedRuntimeInstallation, String> {
    if !binary_path.is_file() {
        return Err(format!(
            "Cannot locate the pinned {} Runtime artifact",
            definition.display_name
        ));
    }
    let artifact_sha256 = file_sha256(&binary_path)?;
    observe(Phase::Digest {
        matches: artifact_sha256 == definition.binary_sha256,
    });
    if artifact_sha256 != definition.binary_sha256 {
        return Err(format!(
            "{} Runtime digest mismatch: expected {}, found {}",
            definition.display_name, definition.binary_sha256, artifact_sha256
        ));
    }
    let observed_version = binary_version_observed(&binary_path, definition.display_name, observe)?;
    observe(Phase::Version {
        matches: observed_version == definition.version,
    });
    if observed_version != definition.version {
        return Err(format!(
            "{} Runtime version mismatch: expected {}, found {}",
            definition.display_name, definition.version, observed_version
        ));
    }
    Ok(ObservedRuntimeInstallation {
        definition,
        binary_path,
        observed_version,
        artifact_sha256,
    })
}

pub(crate) fn inspect_managed_runtime_candidate(
    input: ManagedRuntimeCandidateInput,
) -> Result<ManagedRuntimeCandidateInspection, String> {
    inspect_managed_runtime_candidate_with_source(
        input.runtime,
        input.path,
        input
            .source
            .unwrap_or(ManagedRuntimeCandidateSource::Manual),
    )
}

fn inspect_managed_runtime_candidate_with_source(
    runtime: ManagedRuntimeKey,
    path: PathBuf,
    source: ManagedRuntimeCandidateSource,
) -> Result<ManagedRuntimeCandidateInspection, String> {
    let definition = runtime.definition();
    if !path.is_absolute() {
        return Err("请选择本机 Runtime 程序的绝对路径".to_string());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| format!("Runtime 程序不存在或无法读取：{}", path.display()))?;
    let meta = canonical
        .metadata()
        .map_err(|_| "无法读取 Runtime 程序属性".to_string())?;
    if !meta.is_file() || meta.len() > 512 * 1024 * 1024 {
        return Err(format!("不是支持的 Runtime 程序：{}", path.display()));
    }
    if meta.permissions().mode() & 0o111 == 0 {
        return Err(format!("Runtime 程序没有执行权限：{}", path.display()));
    }
    let artifact_sha256 = file_sha256(&canonical)?;
    let observed_version = binary_version(&canonical, definition.display_name)?;
    let bundled_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(definition.binary_resource_path)
        .canonicalize()
        .ok();
    let source = if bundled_path.as_ref() == Some(&canonical) {
        ManagedRuntimeCandidateSource::Bundled
    } else {
        source
    };
    let bundled = source == ManagedRuntimeCandidateSource::Bundled;
    let requires_digest_match = bundled || runtime == ManagedRuntimeKey::OpencodeAcp;
    let compatible = observed_version == definition.version
        && (!requires_digest_match || artifact_sha256 == definition.binary_sha256);
    Ok(ManagedRuntimeCandidateInspection {
        runtime: RuntimeIdentity {
            product_id: definition.product_id.to_string(),
            installation_id: if bundled {
                definition.installation_id.to_string()
            } else {
                crate::host_ids::derived_host_id(
                    "system-installation",
                    &[definition.product_id, &canonical.to_string_lossy()],
                )
            },
            adapter_id: definition.adapter_id.to_string(),
        },
        display_name: definition.display_name.to_string(),
        selected_path: path,
        canonical_path: canonical,
        source,
        distribution: if bundled { "managed_bundled" } else { "system" }.to_string(),
        observed_version,
        expected_version: definition.version.to_string(),
        artifact_sha256,
        expected_sha256: requires_digest_match.then(|| definition.binary_sha256.to_string()),
        compatible,
        launch_reference_available: compatible,
        activation: if compatible {
            "checked_not_active"
        } else {
            "incompatible"
        }
        .to_string(),
        verified_at: crate::host_store::now_millis(),
    })
}

fn add_runtime_candidate(
    paths: &mut Vec<ManagedRuntimeCandidatePath>,
    warnings: &mut Vec<String>,
    seen: &mut HashSet<PathBuf>,
    path: PathBuf,
    source: ManagedRuntimeCandidateSource,
    missing_label: Option<&str>,
) {
    if path.is_file() {
        match path.canonicalize() {
            Ok(canonical) => {
                if seen.insert(canonical) {
                    paths.push(ManagedRuntimeCandidatePath { path, source });
                }
            }
            Err(_) => warnings.push(format!("候选路径无法解析：{}", path.display())),
        }
    } else if let Some(label) = missing_label {
        warnings.push(format!("{label} 指向的文件不存在。"));
    }
}

pub(crate) fn managed_runtime_candidate_paths_with_context(
    runtime: ManagedRuntimeKey,
    home: Option<&Path>,
    path_value: Option<&str>,
) -> ManagedRuntimeCandidates {
    let definition = runtime.definition();
    let mut paths = Vec::new();
    let mut warnings = Vec::new();
    let mut seen = HashSet::new();
    let bundled = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(definition.binary_resource_path);
    add_runtime_candidate(
        &mut paths,
        &mut warnings,
        &mut seen,
        bundled,
        ManagedRuntimeCandidateSource::Bundled,
        None,
    );
    let env_name = match runtime {
        ManagedRuntimeKey::Pi => "FARFOLD_PI_BINARY",
        ManagedRuntimeKey::Opencode => "FARFOLD_OPENCODE_BINARY",
        ManagedRuntimeKey::OpencodeAcp => "FARFOLD_OPENCODE_ACP_BINARY",
    };
    if let Some(path) = std::env::var_os(env_name).map(PathBuf::from) {
        add_runtime_candidate(
            &mut paths,
            &mut warnings,
            &mut seen,
            path,
            ManagedRuntimeCandidateSource::Environment,
            Some(env_name),
        );
    }
    let binary_name = match runtime {
        ManagedRuntimeKey::Pi => "pi",
        ManagedRuntimeKey::Opencode | ManagedRuntimeKey::OpencodeAcp => "opencode",
    };
    if let Some(path_value) = path_value {
        for directory in std::env::split_paths(path_value).take(64) {
            add_runtime_candidate(
                &mut paths,
                &mut warnings,
                &mut seen,
                directory.join(binary_name),
                ManagedRuntimeCandidateSource::Path,
                None,
            );
        }
    }
    if let Some(home) = home {
        for path in [
            home.join(".local/bin").join(binary_name),
            home.join(".npm-global/bin").join(binary_name),
        ] {
            add_runtime_candidate(
                &mut paths,
                &mut warnings,
                &mut seen,
                path,
                ManagedRuntimeCandidateSource::Common,
                None,
            );
        }
        if let Ok(entries) = fs::read_dir(home.join(".nvm/versions/node")) {
            for entry in entries.take(64).flatten() {
                add_runtime_candidate(
                    &mut paths,
                    &mut warnings,
                    &mut seen,
                    entry.path().join("bin").join(binary_name),
                    ManagedRuntimeCandidateSource::Common,
                    None,
                );
            }
        }
    }
    for path in [
        PathBuf::from("/opt/homebrew/bin").join(binary_name),
        PathBuf::from("/usr/local/bin").join(binary_name),
    ] {
        add_runtime_candidate(
            &mut paths,
            &mut warnings,
            &mut seen,
            path,
            ManagedRuntimeCandidateSource::Common,
            None,
        );
    }
    paths.sort_by(|a, b| a.path.cmp(&b.path));
    if paths.is_empty() {
        warnings.push("未发现本机候选；可手动选择程序文件。".to_string());
    }
    ManagedRuntimeCandidates {
        runtime: definition.identity(),
        paths,
        warnings,
    }
}

#[cfg(test)]
pub(crate) fn managed_runtime_candidate_paths(
    runtime: ManagedRuntimeKey,
) -> ManagedRuntimeCandidates {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let path_value = std::env::var("PATH").ok();
    managed_runtime_candidate_paths_with_context(runtime, home.as_deref(), path_value.as_deref())
}

pub(crate) fn managed_system_registration(
    inspection: &ManagedRuntimeCandidateInspection,
) -> Result<crate::host_store::records::RuntimeRegistration, String> {
    use crate::{host_ids::*, host_store::records::*};
    if inspection.source == ManagedRuntimeCandidateSource::Bundled || !inspection.compatible {
        return Err("只有兼容的本机系统安装可以登记为启动引用".to_string());
    }
    Ok(RuntimeRegistration {
        runtime_product_id: RuntimeProductId::parse(&inspection.runtime.product_id)
            .map_err(|e| e.to_string())?,
        display_name: runtime_product_display_name(&inspection.runtime.product_id)?.to_string(),
        installation_id: InstallationId::parse(&inspection.runtime.installation_id)
            .map_err(|e| e.to_string())?,
        runtime_build_id: RuntimeBuildId::parse(derived_host_id(
            "runtime-build",
            &[
                &inspection.runtime.installation_id,
                &inspection.observed_version,
                &inspection.artifact_sha256,
            ],
        ))
        .map_err(|e| e.to_string())?,
        adapter_id: AdapterId::parse(&inspection.runtime.adapter_id).map_err(|e| e.to_string())?,
        distribution: RuntimeDistribution::System,
        observed_version: inspection.observed_version.clone(),
        artifact_sha256: inspection.artifact_sha256.clone(),
        connection_id: ConnectionId::parse(derived_host_id(
            "connection",
            &[
                &inspection.runtime.installation_id,
                &inspection.runtime.adapter_id,
            ],
        ))
        .map_err(|e| e.to_string())?,
        connection_label: format!("{} system local", inspection.display_name),
        connection_kind: RuntimeConnectionKind::SystemLocal,
        created_at: inspection.verified_at,
        verified_at: inspection.verified_at,
    })
}

pub(crate) fn saved_from_installation(
    runtime: ManagedRuntimeKey,
    record: crate::host_store::system_installation::RuntimeSystemInstallation,
) -> Result<ManagedRuntimeSavedInstallation, String> {
    let inspection: ManagedRuntimeCandidateInspection =
        serde_json::from_str(&record.launch_json)
            .map_err(|_| "已保存的 Runtime 启动记录无效".to_string())?;
    let definition = runtime.definition();
    if inspection.runtime.adapter_id != definition.adapter_id
        || inspection.observed_version != definition.version
    {
        return Err("已保存的 Runtime 启动记录不属于当前接入目标".to_string());
    }
    let registration = managed_system_registration(&inspection)?;
    if registration.installation_id != record.installation_id
        || registration.runtime_build_id != record.runtime_build_id
        || registration.runtime_product_id != record.runtime_product_id
        || registration.artifact_sha256 != record.artifact_sha256
        || registration.observed_version != record.observed_version
        || inspection.canonical_path != record.selected_path
        || inspection.verified_at != record.verified_at
    {
        return Err("系统安装记录与持久构建身份不一致；不能启动".to_string());
    }
    Ok(ManagedRuntimeSavedInstallation {
        installation_id: record.installation_id.into_inner(),
        runtime_build_id: record.runtime_build_id.into_inner(),
        connection_id: registration.connection_id.into_inner(),
        inspection,
    })
}

pub(crate) fn verified_system_runtime_binding(
    store: &crate::host_store::HostStore,
    runtime: ManagedRuntimeKey,
    installation_id: &str,
    connection_id: &str,
) -> Result<(RuntimeBinding, PathBuf), String> {
    use crate::host_ids::*;
    let product =
        RuntimeProductId::parse(runtime.definition().product_id).map_err(|e| e.to_string())?;
    let saved = store
        .runtime_system_installations(&product)?
        .into_iter()
        .filter_map(|record| saved_from_installation(runtime, record).ok())
        .collect::<Vec<_>>()
        .into_iter()
        .find(|entry| entry.installation_id == installation_id)
        .ok_or("找不到已登记的本机 Runtime 安装")?;
    if saved.connection_id != connection_id {
        return Err("本机 Runtime 连接身份不匹配".to_string());
    }
    let observed = inspect_managed_runtime_candidate(ManagedRuntimeCandidateInput {
        runtime,
        path: saved.inspection.selected_path.clone(),
        source: Some(saved.inspection.source),
    })?;
    if observed.canonical_path != saved.inspection.canonical_path
        || observed.observed_version != saved.inspection.observed_version
        || observed.artifact_sha256 != saved.inspection.artifact_sha256
        || !observed.compatible
    {
        return Err("本机 Runtime 程序已移动或被替换，请重新定位并核验".to_string());
    }
    let registration = managed_system_registration(&saved.inspection)?;
    Ok((
        RuntimeBinding {
            product_id: registration.runtime_product_id,
            installation_id: registration.installation_id,
            runtime_build_id: registration.runtime_build_id,
            adapter_id: registration.adapter_id,
            connection_id: registration.connection_id,
        },
        saved.inspection.canonical_path,
    ))
}

fn managed_runtime_install_root(
    app_data_dir: &Path,
    definition: ManagedRuntimeDefinition,
) -> PathBuf {
    app_data_dir
        .join("managed-runtimes")
        .join(definition.product_id)
        .join(definition.adapter_id)
        .join(format!(
            "{}-{}",
            definition.version, definition.binary_sha256
        ))
}

fn find_opencode_binary(root: &Path) -> Result<PathBuf, String> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        let entries = fs::read_dir(&directory)
            .map_err(|error| format!("Cannot read OpenCode archive contents: {error}"))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.file_name().and_then(|name| name.to_str()) == Some("opencode") {
                return Ok(path);
            }
        }
    }
    Err("OpenCode archive did not contain the expected executable".to_string())
}

fn bounded_stderr(bytes: &[u8]) -> String {
    let mut message = String::from_utf8_lossy(bytes).trim().to_string();
    if message.len() > 2_048 {
        message.truncate(2_048);
        message.push('…');
    }
    message
}

fn ensure_install_not_cancelled(
    operations: &ManagedRuntimeInstallationOperations,
    runtime: ManagedRuntimeKey,
) -> Result<(), String> {
    if operations.is_cancelled(runtime) {
        Err("Runtime 安装已取消；未启用新的安装。".to_string())
    } else {
        Ok(())
    }
}

fn download_file(
    operations: &ManagedRuntimeInstallationOperations,
    runtime: ManagedRuntimeKey,
    url: &str,
    destination: &Path,
) -> Result<(), String> {
    ensure_install_not_cancelled(operations, runtime)?;
    let mut child = Command::new("/usr/bin/curl")
        .arg("--fail")
        .arg("--location")
        .arg("--silent")
        .arg("--show-error")
        .arg("--max-time")
        .arg("120")
        .arg("--max-filesize")
        .arg(MAX_RUNTIME_DOWNLOAD_BYTES.to_string())
        .arg(url)
        .arg("--output")
        .arg(destination)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Cannot start Runtime archive download: {error}"))?;
    operations.set_child_pid(runtime, Some(child.id()));
    loop {
        if operations.is_cancelled(runtime) {
            let _ = child.kill();
            let _ = child.wait();
            operations.set_child_pid(runtime, None);
            let _ = fs::remove_file(destination);
            return Err("Runtime 安装已取消；未启用新的安装。".to_string());
        }
        match child
            .try_wait()
            .map_err(|error| format!("Cannot observe Runtime archive download: {error}"))?
        {
            Some(_) => break,
            None => thread::sleep(Duration::from_millis(100)),
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("Cannot finish Runtime archive download: {error}"))?;
    operations.set_child_pid(runtime, None);
    let status = output.status;
    if !status.success() {
        let stderr = bounded_stderr(&output.stderr);
        if !stderr.is_empty() {
            return Err(format!(
                "Runtime archive download failed with status {status}: {stderr}"
            ));
        }
        return Err(format!(
            "Runtime archive download failed with status {status}"
        ));
    }
    let length = fs::metadata(destination)
        .map_err(|error| format!("Cannot inspect Runtime archive: {error}"))?
        .len();
    if length == 0 || length > MAX_RUNTIME_DOWNLOAD_BYTES {
        return Err("Runtime archive is empty or too large".to_string());
    }
    Ok(())
}

fn accept_inspected_runtime(
    store: &crate::host_store::HostStore,
    runtime: ManagedRuntimeKey,
    path: PathBuf,
) -> Result<ManagedRuntimeSavedInstallation, String> {
    let inspection = inspect_runtime_path(runtime, path)?;
    register_inspected_runtime(store, runtime, inspection)
}

fn inspect_runtime_path(
    runtime: ManagedRuntimeKey,
    path: PathBuf,
) -> Result<ManagedRuntimeCandidateInspection, String> {
    inspect_managed_runtime_candidate(ManagedRuntimeCandidateInput {
        runtime,
        path,
        source: Some(ManagedRuntimeCandidateSource::Common),
    })
}

fn register_inspected_runtime(
    store: &crate::host_store::HostStore,
    runtime: ManagedRuntimeKey,
    inspection: ManagedRuntimeCandidateInspection,
) -> Result<ManagedRuntimeSavedInstallation, String> {
    let registration = managed_system_registration(&inspection)?;
    let json = serde_json::to_string(&inspection).map_err(|e| e.to_string())?;
    let accepted = store.accept_runtime_system_installation(
        &registration,
        &inspection.canonical_path,
        &json,
        inspection.verified_at,
    )?;
    saved_from_installation(runtime, accepted)
}

fn existing_valid_managed_runtime(
    store: &crate::host_store::HostStore,
    runtime: ManagedRuntimeKey,
    destination: &Path,
) -> Result<Option<ManagedRuntimeSavedInstallation>, String> {
    if !destination.is_file() {
        return Ok(None);
    }
    let inspection = match inspect_runtime_path(runtime, destination.to_path_buf()) {
        Ok(inspection) => inspection,
        Err(_) => return Ok(None),
    };
    if !inspection.compatible {
        return Ok(None);
    }
    register_inspected_runtime(store, runtime, inspection).map(Some).map_err(|error| {
        "Farfold managed Runtime is valid, but its registry record could not be updated; the existing executable was preserved: "
            .to_string()
            + &error
    })
}

fn restore_previous_destination(previous: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        fs::remove_file(destination)
            .map_err(|error| format!("Cannot remove incomplete Runtime install: {error}"))?;
    }
    fs::rename(previous, destination)
        .map_err(|error| format!("Cannot restore previous Runtime install: {error}"))
}

fn commit_managed_runtime_file(
    staged: &Path,
    destination: &Path,
    install_root: &Path,
) -> Result<Option<PathBuf>, String> {
    let previous_destination = if destination.exists() {
        if !destination.is_file() {
            return Err(
                "Farfold managed OpenCode ACP install path exists but is not a file".to_string(),
            );
        }
        let previous = install_root.join(format!(
            ".opencode-repair-backup-{}-{}",
            std::process::id(),
            crate::host_store::now_millis()
        ));
        fs::rename(destination, &previous)
            .map_err(|error| format!("Cannot prepare OpenCode ACP Runtime repair: {error}"))?;
        Some(previous)
    } else {
        None
    };
    if let Err(error) = fs::rename(staged, destination) {
        if let Some(previous) = &previous_destination
            && let Err(restore_error) = restore_previous_destination(previous, destination)
        {
            return Err(format!(
                "Cannot install OpenCode ACP Runtime: {error}; previous install remains at {} because restore failed: {restore_error}",
                previous.display()
            ));
        }
        return Err(format!("Cannot install OpenCode ACP Runtime: {error}"));
    }
    Ok(previous_destination)
}

fn rollback_committed_runtime_file(
    destination: &Path,
    previous_destination: Option<&Path>,
) -> Result<(), String> {
    if destination.exists() {
        fs::remove_file(destination)
            .map_err(|error| format!("Cannot remove rolled-back Runtime install: {error}"))?;
    }
    if let Some(previous) = previous_destination {
        restore_previous_destination(previous, destination)?;
    }
    Ok(())
}

fn install_opencode_acp_runtime_from_archive(
    app_data_dir: &Path,
    store: &crate::host_store::HostStore,
    operations: &ManagedRuntimeInstallationOperations,
    archive: &Path,
) -> Result<ManagedRuntimeSavedInstallation, String> {
    let runtime = ManagedRuntimeKey::OpencodeAcp;
    let definition = OPENCODE_ACP_RUNTIME;
    let install_root = managed_runtime_install_root(app_data_dir, definition);
    let destination = install_root.join("opencode");
    if let Some(saved) = existing_valid_managed_runtime(store, runtime, &destination)? {
        return Ok(saved);
    }
    let parent = install_root
        .parent()
        .ok_or_else(|| "Cannot resolve managed Runtime installation directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot prepare managed Runtime directory: {error}"))?;
    let temporary = tempfile::Builder::new()
        .prefix("opencode-acp-install-")
        .tempdir_in(parent)
        .map_err(|_| "Cannot reserve managed Runtime installation directory".to_string())?;
    ensure_install_not_cancelled(operations, runtime)?;
    let unpacked = temporary.path().join("unpacked");
    fs::create_dir(&unpacked)
        .map_err(|error| format!("Cannot prepare Runtime unpack directory: {error}"))?;
    let status = Command::new("/usr/bin/unzip")
        .arg("-q")
        .arg(archive)
        .arg("-d")
        .arg(&unpacked)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("Cannot unpack Runtime archive: {error}"))?;
    if !status.success() {
        return Err(format!(
            "Runtime archive unpack failed with status {status}"
        ));
    }
    ensure_install_not_cancelled(operations, runtime)?;
    let source = find_opencode_binary(&unpacked)?;
    let source_len = fs::metadata(&source)
        .map_err(|error| format!("Cannot inspect OpenCode ACP Runtime: {error}"))?
        .len();
    if source_len == 0 || source_len > MAX_RUNTIME_EXECUTABLE_BYTES {
        return Err("OpenCode ACP Runtime executable is empty or too large".to_string());
    }
    let staged = temporary.path().join("opencode");
    fs::copy(&source, &staged)
        .map_err(|error| format!("Cannot stage OpenCode ACP Runtime: {error}"))?;
    let mut permissions = fs::metadata(&staged)
        .map_err(|error| format!("Cannot inspect staged OpenCode ACP Runtime: {error}"))?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&staged, permissions)
        .map_err(|error| format!("Cannot prepare staged OpenCode ACP Runtime: {error}"))?;
    verify_managed_binary_path(staged.clone(), definition)?;
    ensure_install_not_cancelled(operations, runtime)?;
    fs::create_dir_all(&install_root)
        .map_err(|error| format!("Cannot create managed Runtime install directory: {error}"))?;
    let previous_destination = commit_managed_runtime_file(&staged, &destination, &install_root)?;
    match accept_inspected_runtime(store, runtime, destination.clone()) {
        Ok(saved) => {
            if let Some(previous) = previous_destination {
                let _ = fs::remove_file(previous);
            }
            Ok(saved)
        }
        Err(error) => {
            if let Err(rollback_error) =
                rollback_committed_runtime_file(&destination, previous_destination.as_deref())
            {
                return Err(format!(
                    "OpenCode ACP Runtime was verified but could not be registered: {error}; rollback failed: {rollback_error}"
                ));
            }
            Err(format!(
                "OpenCode ACP Runtime was verified but could not be registered; this install was rolled back: {error}"
            ))
        }
    }
}

fn install_opencode_acp_runtime(
    app_data_dir: &Path,
    store: &crate::host_store::HostStore,
    operations: &ManagedRuntimeInstallationOperations,
) -> Result<ManagedRuntimeSavedInstallation, String> {
    let definition = OPENCODE_ACP_RUNTIME;
    let install_root = managed_runtime_install_root(app_data_dir, definition);
    let destination = install_root.join("opencode");
    if let Some(saved) =
        existing_valid_managed_runtime(store, ManagedRuntimeKey::OpencodeAcp, &destination)?
    {
        return Ok(saved);
    }
    let parent = install_root
        .parent()
        .ok_or_else(|| "Cannot resolve managed Runtime installation directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot prepare managed Runtime directory: {error}"))?;
    let temporary = tempfile::Builder::new()
        .prefix("opencode-acp-download-")
        .tempdir_in(parent)
        .map_err(|_| "Cannot reserve managed Runtime download directory".to_string())?;
    let archive = temporary.path().join("opencode-darwin-arm64.zip");
    download_file(
        operations,
        ManagedRuntimeKey::OpencodeAcp,
        OPENCODE_ACP_ARCHIVE_URL,
        &archive,
    )?;
    install_opencode_acp_runtime_from_archive(app_data_dir, store, operations, &archive)
}

#[tauri::command]
pub async fn managed_runtime_installation_candidates(
    app: AppHandle,
    runtime: ManagedRuntimeKey,
) -> Result<ManagedRuntimeCandidates, String> {
    let home = app.path().home_dir().ok();
    let path_value = std::env::var("PATH").ok();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(managed_runtime_candidate_paths_with_context(
            runtime,
            home.as_deref(),
            path_value.as_deref(),
        ))
    })
    .await
    .map_err(|_| "本机 Runtime 候选检查被中断".to_string())?
}

#[tauri::command]
pub async fn managed_runtime_installation_inspect(
    input: ManagedRuntimeCandidateInput,
) -> Result<ManagedRuntimeCandidateInspection, String> {
    tauri::async_runtime::spawn_blocking(move || inspect_managed_runtime_candidate(input))
        .await
        .map_err(|_| "本机 Runtime 安装检查被中断".to_string())?
}

#[tauri::command]
pub fn managed_runtime_installation_list(
    store: tauri::State<'_, crate::host_store::HostStore>,
    runtime: ManagedRuntimeKey,
) -> Result<Vec<ManagedRuntimeSavedInstallation>, String> {
    let product = crate::host_ids::RuntimeProductId::parse(runtime.definition().product_id)
        .map_err(|e| e.to_string())?;
    Ok(store
        .runtime_system_installations(&product)?
        .into_iter()
        .filter_map(|record| saved_from_installation(runtime, record).ok())
        .collect())
}

#[tauri::command]
pub async fn managed_runtime_installation_accept(
    store: tauri::State<'_, crate::host_store::HostStore>,
    input: ManagedRuntimeCandidateInput,
) -> Result<ManagedRuntimeSavedInstallation, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = input.runtime;
        let inspection = inspect_managed_runtime_candidate(input)?;
        let registration = managed_system_registration(&inspection)?;
        let json = serde_json::to_string(&inspection).map_err(|e| e.to_string())?;
        let accepted = store.accept_runtime_system_installation(
            &registration,
            &inspection.canonical_path,
            &json,
            inspection.verified_at,
        )?;
        saved_from_installation(runtime, accepted)
    })
    .await
    .map_err(|_| "本机 Runtime 安装登记被中断".to_string())?
}

#[tauri::command]
pub async fn managed_runtime_installation_install(
    app: AppHandle,
    store: tauri::State<'_, crate::host_store::HostStore>,
    operations: tauri::State<'_, ManagedRuntimeInstallationOperations>,
    runtime: ManagedRuntimeKey,
) -> Result<ManagedRuntimeSavedInstallation, String> {
    let store = store.inner().clone();
    let operations = operations.inner().clone();
    let guard = operations.begin(runtime)?;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || match runtime {
        ManagedRuntimeKey::OpencodeAcp => {
            let result = install_opencode_acp_runtime(&app_data_dir, &store, &operations);
            drop(guard);
            result
        }
        _ => Err("此 Runtime 的按需安装尚未接入".to_string()),
    })
    .await
    .map_err(|_| "本机 Runtime 按需安装被中断".to_string())?
}

#[tauri::command]
pub fn managed_runtime_installation_status(
    operations: tauri::State<'_, ManagedRuntimeInstallationOperations>,
    runtime: ManagedRuntimeKey,
) -> Result<ManagedRuntimeInstallationStatus, String> {
    operations.status(runtime)
}

#[tauri::command]
pub fn managed_runtime_installation_cancel(
    operations: tauri::State<'_, ManagedRuntimeInstallationOperations>,
    runtime: ManagedRuntimeKey,
) -> Result<ManagedRuntimeInstallationStatus, String> {
    operations.request_cancel(runtime)
}

#[cfg(test)]
mod tests {
    use super::{
        ManagedRuntimeCandidateInput, ManagedRuntimeKey, OPENCODE_ACP_RUNTIME, OPENCODE_RUNTIME,
        OPENCODE_RUNTIME_BINARY_SHA256, OPENCODE_RUNTIME_VERSION, PI_RUNTIME,
        PI_RUNTIME_BINARY_SHA256, PI_RUNTIME_VERSION, file_sha256,
        inspect_managed_runtime_candidate, managed_runtime_candidate_paths,
    };
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        path::PathBuf,
        process::Command,
        sync::atomic::{AtomicU64, Ordering},
    };

    static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn version_check_telemetry_records_outcomes_without_output_or_environment() {
        use super::Phase;
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("synthetic-secret-path");
        for (script, expected) in [
            ("printf '0.84.3\\n'", "success"),
            ("printf 'synthetic-output-secret'; exit 9", "nonzero"),
            ("printf '\\377'", "utf8"),
            ("head -c 1025 /dev/zero", "oversize"),
            ("exec /bin/sleep 30", "timeout"),
        ] {
            fs::write(&binary, format!("#!/bin/sh\n{script}\n")).unwrap();
            fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
            let mut phases = Vec::new();
            let result =
                super::binary_version_observed(&binary, "Fixture", &mut |phase| phases.push(phase));
            assert!(phases.contains(&Phase::SpawnBegin));
            let pid = phases
                .iter()
                .find_map(|phase| {
                    if let Phase::Spawned { pid } = phase {
                        Some(*pid)
                    } else {
                        None
                    }
                })
                .unwrap();
            match expected {
                "success" => {
                    assert_eq!(result.unwrap(), "0.84.3");
                    assert!(phases.contains(&Phase::Output { bytes: 7 }));
                    assert!(phases.contains(&Phase::Parsed {
                        valid_utf8: true,
                        within_limit: true
                    }));
                }
                "nonzero" => {
                    assert!(result.unwrap_err().contains("status"));
                    assert!(phases.iter().any(|phase| matches!(
                        phase,
                        Phase::Exited {
                            code: Some(9),
                            success: false,
                            ..
                        }
                    )));
                }
                "utf8" => {
                    assert!(result.is_err());
                    assert!(phases.contains(&Phase::Parsed {
                        valid_utf8: false,
                        within_limit: true
                    }));
                }
                "oversize" => {
                    assert!(result.is_err());
                    assert!(phases.contains(&Phase::Parsed {
                        valid_utf8: true,
                        within_limit: false
                    }));
                }
                "timeout" => {
                    assert!(result.unwrap_err().contains("timed out"));
                    assert!(
                        phases
                            .iter()
                            .any(|phase| matches!(phase, Phase::Timeout { .. }))
                    );
                    assert!(phases.contains(&Phase::Killed { success: true }));
                    assert!(phases.contains(&Phase::Reaped { success: true }));
                    assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
                }
                _ => unreachable!(),
            }
            let log = format!("{phases:?}");
            assert!(!log.contains("synthetic"));
            assert!(!log.contains("HOME"));
            assert!(!log.contains(&directory.path().to_string_lossy().to_string()));
        }
        let mut phases = Vec::new();
        assert!(
            super::binary_version_observed(
                &directory.path().join("missing"),
                "Fixture",
                &mut |phase| phases.push(phase)
            )
            .is_err()
        );
        assert!(
            phases
                .iter()
                .any(|phase| matches!(phase, Phase::SpawnFailed { .. }))
        );
        assert_eq!(
            super::RUNTIME_VERSION_TIMEOUT,
            std::time::Duration::from_secs(5)
        );
    }

    #[test]
    fn registry_keeps_every_runtime_identity_dimension_distinct() {
        for definition in [PI_RUNTIME, OPENCODE_RUNTIME, OPENCODE_ACP_RUNTIME] {
            assert_ne!(definition.product_id, definition.installation_id);
            assert_ne!(definition.installation_id, definition.runtime_build_id);
            assert_ne!(definition.runtime_build_id, definition.adapter_id);
            assert_ne!(definition.adapter_id, definition.default_connection_id);
            assert!(definition.runtime_build_id.contains(definition.version));
            assert!(
                definition
                    .runtime_build_id
                    .contains(definition.binary_sha256)
            );
        }
    }

    #[test]
    fn registry_pins_match_fetch_scripts() {
        let pi_script = include_str!("../../scripts/fetch-pi-sidecar.sh");
        assert!(pi_script.contains(&format!("PI_VERSION=\"{PI_RUNTIME_VERSION}\"")));
        assert!(pi_script.contains(&format!("PI_BINARY_SHA256=\"{PI_RUNTIME_BINARY_SHA256}\"")));

        let opencode_script = include_str!("../../scripts/fetch-opencode-sidecar.sh");
        assert!(
            opencode_script.contains(&format!("OPENCODE_VERSION=\"{OPENCODE_RUNTIME_VERSION}\""))
        );
        assert!(opencode_script.contains(&format!(
            "OPENCODE_BINARY_SHA256=\"{OPENCODE_RUNTIME_BINARY_SHA256}\""
        )));
    }

    #[test]
    fn artifact_digest_is_streamed_from_the_actual_file() {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "farfold-runtime-registry-{}-{sequence}.bin",
            std::process::id()
        ));
        fs::write(&path, b"farfold-runtime").unwrap();
        let digest = file_sha256(&path).unwrap();
        fs::remove_file(path).unwrap();
        assert_eq!(
            digest,
            "8c1017b5b78c85c188678ff847e7081c16ab138a51483e271a67697ccf9c2e6e"
        );
    }

    #[test]
    fn managed_runtime_candidate_paths_include_the_prepared_bundled_artifact() {
        let candidates = managed_runtime_candidate_paths(ManagedRuntimeKey::Pi);
        assert_eq!(candidates.runtime.product_id, "pi");
        assert!(
            candidates
                .paths
                .iter()
                .any(|candidate| candidate.path.ends_with("resources/pi-runtime/pi"))
        );
    }

    #[test]
    #[ignore = "set FARFOLD_PI_VERSION_DIAGNOSTIC_BINARY to an exact fixed Pi artifact"]
    fn fixed_pi_version_check_inside_tauri_async_runtime() {
        let binary = std::env::var_os("FARFOLD_PI_VERSION_DIAGNOSTIC_BINARY")
            .map(PathBuf::from)
            .expect("FARFOLD_PI_VERSION_DIAGNOSTIC_BINARY must point to fixed Pi");
        assert_eq!(file_sha256(&binary).unwrap(), PI_RUNTIME_BINARY_SHA256);

        tauri::async_runtime::block_on(async move {
            for _ in 0..12 {
                let candidate = binary.clone();
                let observed = tauri::async_runtime::spawn_blocking(move || {
                    super::verify_managed_binary_path(candidate, PI_RUNTIME)
                })
                .await
                .expect("Tauri blocking task must complete")
                .expect("fixed Pi version check must complete");
                assert_eq!(observed.observed_version, PI_RUNTIME_VERSION);
            }
        });
    }

    #[test]
    fn external_runtime_candidate_uses_its_own_identity_and_digest() {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "farfold-runtime-candidate-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("pi");
        fs::write(&path, "#!/bin/sh\nprintf '0.84.3\\n'\n").unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions).unwrap();

        let inspection = inspect_managed_runtime_candidate(ManagedRuntimeCandidateInput {
            runtime: ManagedRuntimeKey::Pi,
            path: path.clone(),
            source: None,
        })
        .unwrap();
        assert_eq!(
            inspection.source,
            super::ManagedRuntimeCandidateSource::Manual
        );
        assert_eq!(inspection.distribution, "system");
        assert!(inspection.compatible);
        assert_eq!(inspection.expected_sha256, None);
        assert_ne!(
            inspection.runtime.installation_id,
            PI_RUNTIME.installation_id
        );
        assert_eq!(inspection.artifact_sha256, file_sha256(&path).unwrap());
        fs::remove_file(path).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn external_runtime_candidate_rejects_wrong_version() {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "farfold-runtime-candidate-wrong-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("opencode");
        fs::write(&path, "#!/bin/sh\nprintf '1.18.30\\n'\n").unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions).unwrap();

        let inspection = inspect_managed_runtime_candidate(ManagedRuntimeCandidateInput {
            runtime: ManagedRuntimeKey::Opencode,
            path: path.clone(),
            source: None,
        })
        .unwrap();
        assert!(!inspection.compatible);
        assert_eq!(inspection.activation, "incompatible");
        fs::remove_file(path).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn opencode_acp_candidate_uses_the_acp_version_contract() {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "farfold-runtime-candidate-acp-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        let acp_path = directory.join("opencode-acp");
        fs::write(&acp_path, "#!/bin/sh\nprintf '1.18.30\\n'\n").unwrap();
        let server_path = directory.join("opencode-server");
        fs::write(&server_path, "#!/bin/sh\nprintf '1.15.13\\n'\n").unwrap();
        for path in [&acp_path, &server_path] {
            let mut permissions = fs::metadata(path).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions).unwrap();
        }

        let acp = inspect_managed_runtime_candidate(ManagedRuntimeCandidateInput {
            runtime: ManagedRuntimeKey::OpencodeAcp,
            path: acp_path.clone(),
            source: None,
        })
        .unwrap();
        assert!(!acp.compatible);
        assert_eq!(acp.runtime.product_id, "opencode");
        assert_eq!(acp.runtime.adapter_id, OPENCODE_ACP_RUNTIME.adapter_id);
        assert_eq!(acp.expected_version, "1.18.30");
        assert_eq!(
            acp.expected_sha256,
            Some(OPENCODE_ACP_RUNTIME.binary_sha256.to_string())
        );

        let server = inspect_managed_runtime_candidate(ManagedRuntimeCandidateInput {
            runtime: ManagedRuntimeKey::OpencodeAcp,
            path: server_path.clone(),
            source: None,
        })
        .unwrap();
        assert!(!server.compatible);
        assert_eq!(server.expected_version, "1.18.30");

        fs::remove_file(acp_path).unwrap();
        fs::remove_file(server_path).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn system_runtime_installation_persists_without_polluting_codex_records() {
        use crate::host_store::HostStore;
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("opencode with spaces");
        fs::write(&binary, "#!/bin/sh\nprintf '1.15.13\\n'\n").unwrap();
        let mut permissions = fs::metadata(&binary).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&binary, permissions).unwrap();
        let inspection = inspect_managed_runtime_candidate(ManagedRuntimeCandidateInput {
            runtime: ManagedRuntimeKey::Opencode,
            path: binary.clone(),
            source: None,
        })
        .unwrap();
        let registration = super::managed_system_registration(&inspection).unwrap();
        let store = HostStore::open(directory.path().join("host.sqlite3"));
        let json = serde_json::to_string(&inspection).unwrap();
        let accepted = store
            .accept_runtime_system_installation(
                &registration,
                &inspection.canonical_path,
                &json,
                inspection.verified_at,
            )
            .unwrap();
        assert_eq!(
            accepted.installation_id.as_str(),
            inspection.runtime.installation_id
        );
        assert_eq!(store.system_installations().unwrap().len(), 0);
        let product = crate::host_ids::RuntimeProductId::parse("opencode").unwrap();
        let restored = store.runtime_system_installations(&product).unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].selected_path, inspection.canonical_path);
        assert!(
            super::saved_from_installation(ManagedRuntimeKey::Opencode, restored[0].clone())
                .is_ok()
        );
        assert!(
            super::saved_from_installation(ManagedRuntimeKey::OpencodeAcp, restored[0].clone())
                .is_err()
        );
    }

    #[test]
    #[ignore = "set OPENCODE_ACP_TEST_BINARY to the fixed opencode 1.18.30 arm64 binary"]
    fn fixed_opencode_acp_archive_install_registers_managed_runtime() {
        use crate::host_store::HostStore;

        let binary = std::env::var("OPENCODE_ACP_TEST_BINARY")
            .expect("OPENCODE_ACP_TEST_BINARY must point to opencode 1.18.30");
        let binary = std::path::PathBuf::from(binary);
        assert_eq!(
            file_sha256(&binary).unwrap(),
            OPENCODE_ACP_RUNTIME.binary_sha256
        );

        let temp = tempfile::tempdir().unwrap();
        let app_data_dir = temp.path().join("app-data");
        let store = HostStore::open(temp.path().join("host.sqlite3"));
        let archive = fixed_opencode_acp_archive(temp.path(), &binary);

        let operations = super::ManagedRuntimeInstallationOperations::default();
        let installed = super::install_opencode_acp_runtime_from_archive(
            &app_data_dir,
            &store,
            &operations,
            &archive,
        )
        .unwrap();
        let expected_path = app_data_dir
            .join("managed-runtimes")
            .join(OPENCODE_ACP_RUNTIME.product_id)
            .join(OPENCODE_ACP_RUNTIME.adapter_id)
            .join(format!(
                "{}-{}",
                OPENCODE_ACP_RUNTIME.version, OPENCODE_ACP_RUNTIME.binary_sha256
            ))
            .join("opencode");
        let expected_path = fs::canonicalize(expected_path).unwrap();

        assert_eq!(installed.inspection.canonical_path, expected_path);
        assert_eq!(
            installed.inspection.runtime.adapter_id,
            OPENCODE_ACP_RUNTIME.adapter_id
        );
        assert_eq!(
            installed.inspection.artifact_sha256,
            OPENCODE_ACP_RUNTIME.binary_sha256
        );
        assert!(installed.inspection.compatible);
        assert!(expected_path.is_file());

        let product =
            crate::host_ids::RuntimeProductId::parse(OPENCODE_ACP_RUNTIME.product_id).unwrap();
        let records = store.runtime_system_installations(&product).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].selected_path, expected_path);
    }

    #[test]
    fn runtime_installation_operations_are_mutexed_and_cancellable() {
        let operations = super::ManagedRuntimeInstallationOperations::default();
        let guard = operations.begin(ManagedRuntimeKey::OpencodeAcp).unwrap();
        assert!(operations.begin(ManagedRuntimeKey::OpencodeAcp).is_err());
        assert_eq!(
            operations
                .status(ManagedRuntimeKey::OpencodeAcp)
                .unwrap()
                .phase,
            "running"
        );
        assert_eq!(
            operations
                .request_cancel(ManagedRuntimeKey::OpencodeAcp)
                .unwrap()
                .phase,
            "cancelling"
        );
        assert!(operations.is_cancelled(ManagedRuntimeKey::OpencodeAcp));
        drop(guard);
        assert_eq!(
            operations
                .status(ManagedRuntimeKey::OpencodeAcp)
                .unwrap()
                .phase,
            "idle"
        );
    }

    #[test]
    fn cancelled_runtime_installation_download_exits_before_file_creation() {
        let operations = super::ManagedRuntimeInstallationOperations::default();
        let _guard = operations.begin(ManagedRuntimeKey::OpencodeAcp).unwrap();
        operations
            .request_cancel(ManagedRuntimeKey::OpencodeAcp)
            .unwrap();
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("archive.zip");

        let error = super::download_file(
            &operations,
            ManagedRuntimeKey::OpencodeAcp,
            "https://example.invalid/archive.zip",
            &destination,
        )
        .unwrap_err();

        assert!(error.contains("已取消"));
        assert!(!destination.exists());
    }

    #[test]
    fn cancelled_runtime_installation_releases_slot_for_retry() {
        let operations = super::ManagedRuntimeInstallationOperations::default();
        let guard = operations.begin(ManagedRuntimeKey::OpencodeAcp).unwrap();
        operations
            .request_cancel(ManagedRuntimeKey::OpencodeAcp)
            .unwrap();
        drop(guard);

        let retry = operations.begin(ManagedRuntimeKey::OpencodeAcp).unwrap();
        assert_eq!(
            operations
                .status(ManagedRuntimeKey::OpencodeAcp)
                .unwrap()
                .phase,
            "running"
        );
        drop(retry);
    }

    #[test]
    #[ignore = "set OPENCODE_ACP_TEST_BINARY to the fixed opencode 1.18.30 arm64 binary"]
    fn fixed_opencode_acp_registration_failure_removes_new_install_file() {
        use crate::{
            host_ids::{AdapterId, ConnectionId, InstallationId, RuntimeBuildId, RuntimeProductId},
            host_store::{
                HostStore,
                records::{RuntimeConnectionKind, RuntimeDistribution, RuntimeRegistration},
            },
        };

        let binary = std::path::PathBuf::from(
            std::env::var("OPENCODE_ACP_TEST_BINARY")
                .expect("OPENCODE_ACP_TEST_BINARY must point to opencode 1.18.30"),
        );
        let temp = tempfile::tempdir().unwrap();
        let app_data_dir = temp.path().join("app-data");
        let store = HostStore::open(temp.path().join("host.sqlite3"));
        let expected_path = app_data_dir
            .join("managed-runtimes")
            .join(OPENCODE_ACP_RUNTIME.product_id)
            .join(OPENCODE_ACP_RUNTIME.adapter_id)
            .join(format!(
                "{}-{}",
                OPENCODE_ACP_RUNTIME.version, OPENCODE_ACP_RUNTIME.binary_sha256
            ))
            .join("opencode");
        fs::create_dir_all(expected_path.parent().unwrap()).unwrap();
        let expected_path = fs::canonicalize(expected_path.parent().unwrap())
            .unwrap()
            .join("opencode");
        let archive = fixed_opencode_acp_archive(temp.path(), &binary);
        let conflict = RuntimeRegistration {
            runtime_product_id: RuntimeProductId::parse("pi").unwrap(),
            display_name: "Pi".to_string(),
            installation_id: InstallationId::parse("conflicting-installation").unwrap(),
            runtime_build_id: RuntimeBuildId::parse("conflicting-build").unwrap(),
            adapter_id: AdapterId::parse("pi-rpc-jsonl").unwrap(),
            distribution: RuntimeDistribution::System,
            observed_version: "0.84.3".to_string(),
            artifact_sha256: "a".repeat(64),
            connection_id: ConnectionId::parse("conflicting-connection").unwrap(),
            connection_label: "Conflicting install".to_string(),
            connection_kind: RuntimeConnectionKind::SystemLocal,
            created_at: 1,
            verified_at: 1,
        };
        store
            .accept_runtime_system_installation(&conflict, &expected_path, "{}", 1)
            .unwrap();

        let operations = super::ManagedRuntimeInstallationOperations::default();
        let error = super::install_opencode_acp_runtime_from_archive(
            &app_data_dir,
            &store,
            &operations,
            &archive,
        )
        .unwrap_err();
        assert!(error.contains("rolled back"));
        assert!(!expected_path.exists());
    }

    #[test]
    #[ignore = "set OPENCODE_ACP_TEST_BINARY to the fixed opencode 1.18.30 arm64 binary"]
    fn fixed_opencode_acp_valid_existing_install_is_preserved_when_registry_update_fails() {
        use crate::{
            host_ids::{AdapterId, ConnectionId, InstallationId, RuntimeBuildId, RuntimeProductId},
            host_store::{
                HostStore,
                records::{RuntimeConnectionKind, RuntimeDistribution, RuntimeRegistration},
            },
        };

        let binary = std::path::PathBuf::from(
            std::env::var("OPENCODE_ACP_TEST_BINARY")
                .expect("OPENCODE_ACP_TEST_BINARY must point to opencode 1.18.30"),
        );
        let temp = tempfile::tempdir().unwrap();
        let app_data_dir = temp.path().join("app-data");
        let expected_path = app_data_dir
            .join("managed-runtimes")
            .join(OPENCODE_ACP_RUNTIME.product_id)
            .join(OPENCODE_ACP_RUNTIME.adapter_id)
            .join(format!(
                "{}-{}",
                OPENCODE_ACP_RUNTIME.version, OPENCODE_ACP_RUNTIME.binary_sha256
            ))
            .join("opencode");
        fs::create_dir_all(expected_path.parent().unwrap()).unwrap();
        fs::copy(&binary, &expected_path).unwrap();
        let mut permissions = fs::metadata(&expected_path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&expected_path, permissions).unwrap();
        let canonical_path = fs::canonicalize(&expected_path).unwrap();

        let store = HostStore::open(temp.path().join("host.sqlite3"));
        let conflict = RuntimeRegistration {
            runtime_product_id: RuntimeProductId::parse("pi").unwrap(),
            display_name: "Pi".to_string(),
            installation_id: InstallationId::parse("conflicting-installation").unwrap(),
            runtime_build_id: RuntimeBuildId::parse("conflicting-build").unwrap(),
            adapter_id: AdapterId::parse("pi-rpc-jsonl").unwrap(),
            distribution: RuntimeDistribution::System,
            observed_version: "0.84.3".to_string(),
            artifact_sha256: "a".repeat(64),
            connection_id: ConnectionId::parse("conflicting-connection").unwrap(),
            connection_label: "Conflicting install".to_string(),
            connection_kind: RuntimeConnectionKind::SystemLocal,
            created_at: 1,
            verified_at: 1,
        };
        store
            .accept_runtime_system_installation(&conflict, &canonical_path, "{}", 1)
            .unwrap();

        let operations = super::ManagedRuntimeInstallationOperations::default();
        let error = super::install_opencode_acp_runtime_from_archive(
            &app_data_dir,
            &store,
            &operations,
            &temp.path().join("unused.zip"),
        )
        .unwrap_err();

        assert!(error.contains("valid"));
        assert!(error.contains("preserved"));
        assert_eq!(
            file_sha256(&expected_path).unwrap(),
            OPENCODE_ACP_RUNTIME.binary_sha256
        );
    }

    #[test]
    fn managed_runtime_commit_failure_restores_existing_destination() {
        let temp = tempfile::tempdir().unwrap();
        let install_root = temp.path().join("install");
        fs::create_dir_all(&install_root).unwrap();
        let destination = install_root.join("opencode");
        fs::write(&destination, b"previous").unwrap();
        let missing_staged = temp.path().join("missing-staged");

        let error =
            super::commit_managed_runtime_file(&missing_staged, &destination, &install_root)
                .unwrap_err();

        assert!(error.contains("Cannot install OpenCode ACP Runtime"));
        assert_eq!(fs::read(&destination).unwrap(), b"previous");
        assert!(fs::read_dir(&install_root).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".opencode-repair-backup-")
        }));
    }

    #[test]
    #[ignore = "set OPENCODE_ACP_TEST_BINARY to the fixed opencode 1.18.30 arm64 binary"]
    fn fixed_opencode_acp_repair_replaces_only_damaged_managed_install() {
        use crate::host_store::HostStore;

        let binary = std::path::PathBuf::from(
            std::env::var("OPENCODE_ACP_TEST_BINARY")
                .expect("OPENCODE_ACP_TEST_BINARY must point to opencode 1.18.30"),
        );
        let temp = tempfile::tempdir().unwrap();
        let app_data_dir = temp.path().join("app-data");
        let expected_path = app_data_dir
            .join("managed-runtimes")
            .join(OPENCODE_ACP_RUNTIME.product_id)
            .join(OPENCODE_ACP_RUNTIME.adapter_id)
            .join(format!(
                "{}-{}",
                OPENCODE_ACP_RUNTIME.version, OPENCODE_ACP_RUNTIME.binary_sha256
            ))
            .join("opencode");
        fs::create_dir_all(expected_path.parent().unwrap()).unwrap();
        fs::write(&expected_path, "#!/bin/sh\nprintf 'broken\\n'\n").unwrap();
        let mut permissions = fs::metadata(&expected_path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&expected_path, permissions).unwrap();

        let store = HostStore::open(temp.path().join("host.sqlite3"));
        let archive = fixed_opencode_acp_archive(temp.path(), &binary);
        let operations = super::ManagedRuntimeInstallationOperations::default();
        let installed = super::install_opencode_acp_runtime_from_archive(
            &app_data_dir,
            &store,
            &operations,
            &archive,
        )
        .unwrap();
        assert_eq!(
            installed.inspection.artifact_sha256,
            OPENCODE_ACP_RUNTIME.binary_sha256
        );
        assert_eq!(
            file_sha256(&expected_path).unwrap(),
            OPENCODE_ACP_RUNTIME.binary_sha256
        );
    }

    #[test]
    #[ignore = "downloads the fixed official OpenCode ACP archive once"]
    fn official_opencode_acp_archive_download_matches_fixed_digest() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("opencode-darwin-arm64.zip");
        let operations = super::ManagedRuntimeInstallationOperations::default();
        let _guard = operations.begin(ManagedRuntimeKey::OpencodeAcp).unwrap();
        super::download_file(
            &operations,
            ManagedRuntimeKey::OpencodeAcp,
            super::OPENCODE_ACP_ARCHIVE_URL,
            &archive,
        )
        .unwrap();
        let unpacked = temp.path().join("unpacked");
        fs::create_dir(&unpacked).unwrap();
        let status = Command::new("/usr/bin/unzip")
            .arg("-q")
            .arg(&archive)
            .arg("-d")
            .arg(&unpacked)
            .status()
            .unwrap();
        assert!(status.success());
        let binary = super::find_opencode_binary(&unpacked).unwrap();
        assert_eq!(
            file_sha256(&binary).unwrap(),
            OPENCODE_ACP_RUNTIME.binary_sha256
        );
    }

    fn fixed_opencode_acp_archive(root: &std::path::Path, binary: &std::path::Path) -> PathBuf {
        assert_eq!(
            file_sha256(binary).unwrap(),
            OPENCODE_ACP_RUNTIME.binary_sha256
        );
        let archive_root = root.join(format!(
            "archive-root-{}",
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let archive_bin = archive_root.join("opencode-darwin-arm64/bin");
        fs::create_dir_all(&archive_bin).unwrap();
        let archived_binary = archive_bin.join("opencode");
        fs::copy(binary, &archived_binary).unwrap();
        let mut permissions = fs::metadata(&archived_binary).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&archived_binary, permissions).unwrap();

        let archive = root.join(format!(
            "opencode-darwin-arm64-{}.zip",
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let status = Command::new("/usr/bin/zip")
            .arg("-q")
            .arg("-r")
            .arg(&archive)
            .arg(".")
            .current_dir(&archive_root)
            .status()
            .unwrap();
        assert!(status.success());
        archive
    }
}
