//! Private Node runtime for npx-distributed agents.
//!
//! If the user's login PATH already has Node ≥18 and npm, we use it. Otherwise
//! Farfold downloads the official `node-v22.20.0-darwin-arm64.tar.gz` into
//! `app_data/node/` (verified against the matching `SHASUMS256.txt` entry) and
//! uses the npm bundled inside that dist. Users never need to install Node.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::agent_discovery::find_binary;
use crate::shell_env;

mod npm_entry;

const NODE_DIST_VERSION: &str = "v22.20.0";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const NODE_DIST_NAME: &str = "node-v22.20.0-darwin-arm64";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const NODE_DIST_NAME: &str = "node-v22.20.0-darwin-x64";
#[cfg(all(windows, target_arch = "x86_64"))]
const NODE_DIST_NAME: &str = "node-v22.20.0-win-x64";
#[cfg(all(windows, target_arch = "aarch64"))]
const NODE_DIST_NAME: &str = "node-v22.20.0-win-arm64";
const NODE_BIN: &str = if cfg!(windows) {
    "node.exe"
} else {
    "bin/node"
};
const NPM_CLI: &str = if cfg!(windows) {
    "node_modules/npm/bin/npm-cli.js"
} else {
    "lib/node_modules/npm/bin/npm-cli.js"
};
const NODE_MIN_MAJOR: u64 = 18;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);

/// How `npm install` is invoked.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum NpmRunner {
    /// A system npm executable on PATH (invoked directly).
    #[cfg(unix)]
    System { npm: PathBuf },
    /// The npm bundled inside a Node dist (`node <npm-cli.js>`).
    BundledCli { npm_cli: PathBuf },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeRuntime {
    pub node: PathBuf,
    pub npm: NpmRunner,
    /// `system` when reused from PATH, `bundled` when downloaded by Farfold.
    pub source: &'static str,
    pub version: Option<String>,
}

impl NodeRuntime {
    fn npm_install_command(&self, pkg_spec: &str, install_dir: &Path) -> Command {
        let mut command = match &self.npm {
            #[cfg(unix)]
            NpmRunner::System { npm } => {
                let mut command = Command::new(npm);
                command
                    .args(["install", "--prefix"])
                    .arg(install_dir)
                    .arg(pkg_spec)
                    .arg("--save-exact");
                command
            }
            NpmRunner::BundledCli { npm_cli } => {
                let mut command = Command::new(&self.node);
                command
                    .arg(npm_cli)
                    .args(["install", "--prefix"])
                    .arg(install_dir)
                    .arg(pkg_spec)
                    .arg("--save-exact");
                command
            }
        };
        let mut env = shell_env::command_env();
        let mut paths = self
            .node
            .parent()
            .map(Path::to_path_buf)
            .into_iter()
            .collect::<Vec<_>>();
        if let Some(path) = env.get("PATH") {
            paths.extend(std::env::split_paths(path));
        }
        if let Ok(path) = std::env::join_paths(paths) {
            env.insert("PATH".into(), path.to_string_lossy().into_owned());
        }
        command.envs(env);
        command
    }

    fn official_npm_install_command(&self, pkg_spec: &str, install_dir: &Path) -> Command {
        let mut command = self.npm_install_command(pkg_spec, install_dir);
        // Only the verified named route overrides npm sources for this operation.
        // Explicit CLI flags beat inherited npm config without modifying its files.
        command.args(["--registry", "https://registry.npmjs.org"]);
        let package = package_name_of(pkg_spec);
        if let Some(scope) = package
            .strip_prefix('@')
            .and_then(|package| package.split_once('/').map(|(scope, _)| scope))
        {
            command.arg(format!("--@{scope}:registry=https://registry.npmjs.org"));
        }
        command
    }
}

fn node_major(version: &str) -> Option<u64> {
    let text = version.trim().trim_start_matches('v');
    let major = text.split('.').next()?.parse().ok()?;
    Some(major)
}

fn node_version_string(node: &Path, job: &crate::install_job::Job) -> Option<String> {
    crate::agent_discovery::version_output(node, Duration::from_secs(10), || job.check())
        .ok()
        .flatten()
}

fn try_system_node(job: &crate::install_job::Job) -> Option<NodeRuntime> {
    let env = shell_env::command_env();
    let dirs: Vec<PathBuf> = env
        .get("PATH")
        .map(|path| {
            std::env::split_paths(path)
                .filter(|entry| !entry.as_os_str().is_empty())
                .collect()
        })
        .unwrap_or_default();
    let node = find_binary("node", &dirs)?;
    let npm = find_binary("npm", &dirs)?;
    let version = node_version_string(&node, job)?;
    let major = node_major(&version)?;
    if major < NODE_MIN_MAJOR {
        return None;
    }
    Some(NodeRuntime {
        version: Some(version),
        node: node.clone(),
        npm: {
            #[cfg(unix)]
            {
                NpmRunner::System { npm }
            }
            #[cfg(windows)]
            {
                // Official Node Windows distributions keep npm beside node.exe.
                // Execute its declared JavaScript CLI directly, never through cmd.
                let cli = node.parent()?.join("node_modules/npm/bin/npm-cli.js");
                if !cli.is_file()
                    || npm.parent()?.canonicalize().ok()? != node.parent()?.canonicalize().ok()?
                {
                    return None;
                }
                NpmRunner::BundledCli { npm_cli: cli }
            }
        },
        source: "system",
    })
}

fn bundled_layout(app_data_dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let root = app_data_dir.join("node").join(NODE_DIST_NAME);
    let node = root.join(NODE_BIN);
    let npm_cli = root.join(NPM_CLI);
    (root, node, npm_cli)
}

fn try_existing_bundled(app_data_dir: &Path, job: &crate::install_job::Job) -> Option<NodeRuntime> {
    let (_root, node, npm_cli) = bundled_layout(app_data_dir);
    if !node.is_file() || !npm_cli.is_file() {
        return None;
    }
    let version = node_version_string(&node, job)?;
    node_major(&version)?;
    Some(NodeRuntime {
        version: Some(version),
        node,
        npm: NpmRunner::BundledCli { npm_cli },
        source: "bundled",
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

fn shasums_entry(shasums: &str, file_name: &str) -> Option<String> {
    for line in shasums.lines() {
        let mut parts = line.split_whitespace();
        match (parts.next(), parts.next()) {
            (Some(sha), Some(name)) if name == file_name => {
                return Some(sha.to_string());
            }
            _ => {}
        }
    }
    None
}

fn extract_node_archive(
    archive: &[u8],
    dist_dir: &Path,
    _check: impl Fn() -> Result<(), String>,
) -> Result<tempfile::TempDir, String> {
    let staging = tempfile::Builder::new()
        .prefix(".extract-")
        .tempdir_in(dist_dir)
        .map_err(|error| format!("cannot create node staging dir: {error}"))?;
    #[cfg(windows)]
    crate::archive_zip::extract(archive, staging.path(), _check)?;
    #[cfg(unix)]
    {
        let decoder = flate2::read::GzDecoder::new(archive);
        tar::Archive::new(decoder)
            .unpack(staging.path())
            .map_err(|error| format!("cannot extract node archive: {error}"))?;
    }
    Ok(staging)
}

fn download_and_extract_node(
    app_data_dir: &Path,
    job: &crate::install_job::Job,
) -> Result<NodeRuntime, String> {
    let dist_dir = app_data_dir.join("node");
    std::fs::create_dir_all(&dist_dir)
        .map_err(|error| format!("cannot create node directory: {error}"))?;

    let base = format!("https://nodejs.org/dist/{NODE_DIST_VERSION}");
    let archive_name = format!(
        "{NODE_DIST_NAME}.{}",
        if cfg!(windows) { "zip" } else { "tar.gz" }
    );
    let sums_url = format!("{base}/SHASUMS256.txt");
    let sums_bytes = if cfg!(windows) {
        job.download_bounded(&sums_url, Duration::from_secs(30), 1024 * 1024, None)?
    } else {
        job.download(&sums_url, Duration::from_secs(30))?
    };
    let shasums = String::from_utf8_lossy(&sums_bytes).into_owned();
    let expected = shasums_entry(&shasums, &archive_name)
        .ok_or_else(|| format!("no SHASUMS256 entry for {archive_name}"))?;

    let archive_url = format!("{base}/{archive_name}");
    let archive = if cfg!(windows) {
        job.download_bounded(&archive_url, DOWNLOAD_TIMEOUT, 1024 * 1024 * 1024, None)?
    } else {
        job.download(&archive_url, DOWNLOAD_TIMEOUT)?
    };
    let actual = sha256_hex(&archive);
    if actual != expected {
        return Err(format!(
            "node archive sha256 mismatch: expected {expected}, got {actual}"
        ));
    }

    job.check()?;
    job.report("extract", None, None);
    let staging = extract_node_archive(&archive, &dist_dir, || job.check())?;
    let extracted_root = staging.path().join(NODE_DIST_NAME);
    let (final_root, node, npm_cli) = bundled_layout(app_data_dir);
    if final_root.exists() {
        return Err("已有 Node 文件不完整；已保留，请检查后重试".into());
    }
    job.check()?;
    if !extracted_root.join(NODE_BIN).is_file() || !extracted_root.join(NPM_CLI).is_file() {
        return Err("运行环境下载不完整，请重试".into());
    }
    std::fs::rename(&extracted_root, &final_root)
        .map_err(|error| format!("cannot place node dist: {error}"))?;

    if !node.is_file() {
        return Err("extracted node dist is missing bin/node".to_string());
    }
    if !npm_cli.is_file() {
        return Err("extracted node dist is missing bundled npm-cli.js".to_string());
    }
    // Extraction does not guarantee the exec bit through every tar entry.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755));
    }
    let version = node_version_string(&node, job);
    job.check()?;
    Ok(NodeRuntime {
        version,
        node,
        npm: NpmRunner::BundledCli { npm_cli },
        source: "bundled",
    })
}

/// Resolve a usable Node: system Node ≥18 + npm when present, else the
/// Farfold-managed dist (downloaded and sha256-verified on first use).
pub fn ensure_node(
    app_data_dir: &Path,
    job: &crate::install_job::Job,
) -> Result<NodeRuntime, String> {
    job.check()?;
    if let Some(runtime) = try_system_node(job) {
        return Ok(runtime);
    }
    job.check()?;
    if let Some(runtime) = try_existing_bundled(app_data_dir, job) {
        return Ok(runtime);
    }
    job.check()?;
    download_and_extract_node(app_data_dir, job)
}

/// Managed state wrapper: resolves Node once per process and caches the
/// result (system reuse or downloaded dist) for `npm_install` callers.
pub struct NodeRuntimeState {
    app_data_dir: PathBuf,
    resolved: std::sync::Mutex<Option<NodeRuntime>>,
}

impl NodeRuntimeState {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            app_data_dir,
            resolved: std::sync::Mutex::new(None),
        }
    }

    /// Forget the cached runtime so a cleared managed directory is re-resolved
    /// instead of leaving a dangling path for later installs.
    pub(crate) fn reset(&self) {
        if let Ok(mut resolved) = self.resolved.lock() {
            *resolved = None;
        }
    }

    pub fn get(&self, job: &crate::install_job::Job) -> Result<NodeRuntime, String> {
        // A different install may be resolving Node; its work must not make
        // this install's cancellation wait for that probe or download.
        let mut cached = loop {
            job.check()?;
            match self.resolved.try_lock() {
                Ok(cached) => break cached,
                Err(std::sync::TryLockError::Poisoned(_)) => return Err("无法准备运行环境".into()),
                Err(std::sync::TryLockError::WouldBlock) => {
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        };
        job.check()?;
        if let Some(runtime) = cached.as_ref() {
            return Ok(runtime.clone());
        }
        let runtime = ensure_node(&self.app_data_dir, job)?;
        job.check()?;
        *cached = Some(runtime.clone());
        Ok(runtime)
    }

    /// The package's verified engines requirement applies only to this install.
    /// Existing launches and the ordinary Node >=18 selection policy are unchanged.
    pub(crate) fn get_for_engine(
        &self,
        range: &str,
        job: &crate::install_job::Job,
    ) -> Result<NodeRuntime, String> {
        let requirement = semver::VersionReq::parse(range)
            .map_err(|_| "官方安装工具要求暂时无法识别，请查看官方说明")?;
        let mut cached = loop {
            job.check()?;
            match self.resolved.try_lock() {
                Ok(cached) => break cached,
                Err(std::sync::TryLockError::Poisoned(_)) => return Err("无法准备运行环境".into()),
                Err(std::sync::TryLockError::WouldBlock) => {
                    std::thread::sleep(Duration::from_millis(20))
                }
            }
        };
        if let Some(runtime) = cached.as_ref()
            && let Some(runtime) = checked_engine(runtime.clone(), &requirement, job)?
        {
            return Ok(runtime);
        }
        for runtime in [
            try_system_node(job),
            try_existing_bundled(&self.app_data_dir, job),
        ]
        .into_iter()
        .flatten()
        {
            if let Some(runtime) = checked_engine(runtime, &requirement, job)? {
                *cached = Some(runtime.clone());
                return Ok(runtime);
            }
        }
        job.check()?;
        if !requirement.matches(
            &semver::Version::parse(NODE_DIST_VERSION.trim_start_matches('v'))
                .map_err(|_| "无法核对运行环境版本")?,
        ) {
            return Err(
                "现有安装工具版本未满足官方要求，请准备符合要求的 Node 后重试；原程序保持不变"
                    .into(),
            );
        }
        let runtime = download_and_extract_node(&self.app_data_dir, job)?;
        let runtime = checked_engine(runtime, &requirement, job)?
            .ok_or("安装工具版本未满足官方要求，原程序保持不变")?;
        *cached = Some(runtime.clone());
        Ok(runtime)
    }
}

fn checked_engine(
    mut runtime: NodeRuntime,
    requirement: &semver::VersionReq,
    job: &crate::install_job::Job,
) -> Result<Option<NodeRuntime>, String> {
    let version = node_version_string(&runtime.node, job);
    job.check()?;
    let Some(parsed) = version
        .as_deref()
        .and_then(crate::acp_client::versions::public_version)
        .and_then(|version| semver::Version::parse(&version).ok())
    else {
        return Ok(None);
    };
    if !requirement.matches(&parsed) {
        return Ok(None);
    }
    runtime.version = Some(parsed.to_string());
    Ok(Some(runtime))
}

pub(crate) struct NpmLaunch {
    pub command: PathBuf,
    pub prefix_args: Vec<String>,
}

/// Install the declared package and return its launch prefix. Registry arguments
/// are appended by the caller, after this prefix.
pub fn npm_install(
    runtime: &NodeRuntime,
    pkg_spec: &str,
    install_dir: &Path,
    job: &crate::install_job::Job,
) -> Result<NpmLaunch, String> {
    let (node, entry) = npm_install_bin(runtime, pkg_spec, None, install_dir, job)?;
    job.check()?;
    npm_entry::launch(node, entry)
}

pub(crate) fn npm_install_named(
    runtime: &NodeRuntime,
    pkg_spec: &str,
    bin: &str,
    install_dir: &Path,
    job: &crate::install_job::Job,
) -> Result<(PathBuf, PathBuf), String> {
    npm_install_bin(runtime, pkg_spec, Some(bin), install_dir, job)
}

fn npm_install_bin(
    runtime: &NodeRuntime,
    pkg_spec: &str,
    bin: Option<&str>,
    install_dir: &Path,
    job: &crate::install_job::Job,
) -> Result<(PathBuf, PathBuf), String> {
    std::fs::create_dir_all(install_dir)
        .map_err(|error| format!("cannot create install dir: {error}"))?;
    let mut command = if bin.is_some() {
        runtime.official_npm_install_command(pkg_spec, install_dir)
    } else {
        runtime.npm_install_command(pkg_spec, install_dir)
    };
    job.run(&mut command)?;
    job.check()?;

    let package_name = package_name_of(pkg_spec);
    let package_dir = install_dir.join("node_modules").join(&package_name);
    // Ordinary registry packages may link their bin to a platform dependency in
    // this same node_modules tree. Named companion programs retain their tighter
    // package-local entry contract below.
    let modules = bin
        .is_none()
        .then(|| npm_entry::modules_root(install_dir))
        .transpose()?;
    let manifest_path = match &modules {
        Some(root) => {
            let package = npm_entry::owned_path(&package_dir, root)?;
            npm_entry::owned_path(&package.join("package.json"), &package)?
        }
        None => package_dir.join("package.json"),
    };
    let manifest_raw = std::fs::read_to_string(manifest_path)
        .map_err(|error| format!("installed {pkg_spec} has no package.json: {error}"))?;
    let manifest: serde_json::Value = serde_json::from_str(&manifest_raw)
        .map_err(|error| format!("installed {pkg_spec} manifest is not JSON: {error}"))?;
    let bin_entry = bin
        .map_or_else(
            || bin_entry_of(&manifest),
            |name| match &manifest["bin"] {
                serde_json::Value::String(path) => Some(path.clone()),
                serde_json::Value::Object(bins) => bins[name].as_str().map(str::to_owned),
                _ => None,
            },
        )
        .ok_or_else(|| format!("installed {pkg_spec} exposes no bin entry"))?;
    let bin_path = package_dir.join(&bin_entry);
    let bin_path = bin_path
        .canonicalize()
        .map_err(|error| format!("installed {pkg_spec} bin entry missing: {error}"))?;
    if let Some(root) = modules {
        npm_entry::owned_path(&bin_path, &root)?;
    }
    if bin.is_some()
        && !bin_path.starts_with(
            package_dir
                .canonicalize()
                .map_err(|_| "无法确认程序安装位置")?,
        )
    {
        return Err("官方程序入口不在本次安装包中，原选择保持不变".into());
    }
    Ok((runtime.node.clone(), bin_path))
}

/// Strip the version pin from an npm spec: `foo@1.2.3` → `foo`,
/// `@scope/foo@1.2.3` → `@scope/foo` (the `@` inside the version pin only —
/// the leading scope `@` is preserved).
pub fn package_name_of(pkg_spec: &str) -> String {
    if let Some(rest) = pkg_spec.strip_prefix('@') {
        match rest.rfind('@') {
            Some(index) => format!("@{}", &rest[..index]),
            None => pkg_spec.to_string(),
        }
    } else {
        pkg_spec.split('@').next().unwrap_or(pkg_spec).to_string()
    }
}

/// The package's `bin` entry: object form picks the first entry (npm packages
/// expose exactly one for adapters); string form is used verbatim.
fn bin_entry_of(manifest: &serde_json::Value) -> Option<String> {
    match manifest.get("bin")? {
        serde_json::Value::String(path) => Some(path.clone()),
        serde_json::Value::Object(map) => map.values().find_map(|v| v.as_str().map(str::to_string)),
        _ => None,
    }
}

#[cfg(test)]
pub(crate) mod npm_entry_tests;

#[cfg(all(test, windows))]
mod windows_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn engine_requirement_checks_full_node_version_without_changing_default_policy() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let node = root.path().join("node");
        let lease =
            crate::install_job::begin("engine-full-version", tauri::ipc::Channel::new(|_| Ok(())))
                .unwrap();
        let requirement = semver::VersionReq::parse(">=22.19.0").unwrap();
        for (version, expected) in [
            ("18.20.0", false),
            ("22.18.0", false),
            ("22.19.0", true),
            ("22.22.3", true),
        ] {
            std::fs::write(&node, format!("#!/bin/sh\nprintf '%s\\n' 'v{version}'\n")).unwrap();
            std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
            let runtime = NodeRuntime {
                node: node.clone(),
                npm: NpmRunner::System {
                    npm: "/fixture/npm".into(),
                },
                source: "fixture",
                version: Some("stale-version".into()),
            };
            assert_eq!(
                checked_engine(runtime, &requirement, &lease.job)
                    .unwrap()
                    .is_some(),
                expected
            );
        }
        let state = NodeRuntimeState::new(root.path().into());
        assert!(
            state
                .get_for_engine("unsupported || range", &lease.job)
                .is_err()
        );
        assert!(!root.path().join("node").is_dir());
        assert_eq!(NODE_MIN_MAJOR, 18);
    }

    #[test]
    fn verified_named_install_overrides_registry_and_scope_without_changing_ordinary_npm() {
        let runtime = NodeRuntime {
            node: "/fixture/node".into(),
            npm: NpmRunner::BundledCli {
                npm_cli: "/fixture/npm-cli.js".into(),
            },
            source: "fixture",
            version: None,
        };
        let official = runtime.official_npm_install_command(
            "@earendil-works/pi-coding-agent@0.87.1",
            Path::new("/managed/candidate"),
        );
        let args: Vec<_> = official
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(
            args.windows(2)
                .any(|args| args == ["--registry", "https://registry.npmjs.org"])
        );
        assert!(args.contains(&"--@earendil-works:registry=https://registry.npmjs.org".into()));
        let ordinary =
            runtime.npm_install_command("old-component@1.0.0", Path::new("/managed/old"));
        assert!(!ordinary.get_args().any(|arg| arg == "--registry"));
    }

    #[cfg(unix)]
    #[test]
    fn cancelled_node_probe_ends_descendants_holding_stdout() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let node = directory.path().join("node");
        let marker = directory.path().join("descendant-finished");
        std::fs::write(
            &node,
            format!(
                "#!/bin/sh\n(/bin/sleep 1; /usr/bin/printf alive > '{}') &\n/usr/bin/printf 'v22.20.0\\n'\nexit 0\n",
                marker.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
        let lease =
            crate::install_job::begin("cancelled-node-probe", tauri::ipc::Channel::new(|_| Ok(())))
                .unwrap();
        let cancel = std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(50));
            crate::install_job::agent_install_cancel("cancelled-node-probe".into()).unwrap();
        });
        let started = std::time::Instant::now();
        let result = node_version_string(&node, &lease.job);
        cancel.join().unwrap();
        assert!(lease.job.check().is_err());
        assert!(started.elapsed() < Duration::from_millis(750));
        assert!(result.is_none());
        std::thread::sleep(Duration::from_millis(1100));
        assert!(
            !marker.exists(),
            "cancelled probe left a descendant running"
        );
    }

    #[test]
    fn cancelled_install_does_not_wait_for_another_node_probe() {
        let directory = tempfile::tempdir().unwrap();
        let state = std::sync::Arc::new(NodeRuntimeState::new(directory.path().into()));
        let held = state.resolved.lock().unwrap();
        let lease = crate::install_job::begin(
            "cancelled-node-probe-waiter",
            tauri::ipc::Channel::new(|_| Ok(())),
        )
        .unwrap();
        let job = lease.job.clone();
        let state_for_waiter = state.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let waiter = std::thread::spawn(move || {
            tx.send(state_for_waiter.get(&job)).unwrap();
        });
        std::thread::sleep(Duration::from_millis(50));
        crate::install_job::agent_install_cancel("cancelled-node-probe-waiter".into()).unwrap();
        let result = rx.recv_timeout(Duration::from_millis(750));
        drop(held);
        waiter.join().unwrap();
        assert!(result.is_ok_and(|result| result.is_err()));
    }

    #[cfg(unix)]
    #[test]
    fn access_regression_npm_uses_selected_node_with_a_gui_path() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let node = directory.path().join("node");
        let npm = directory.path().join("npm");
        std::fs::write(&node, "#!/bin/sh\n/usr/bin/printf selected-node\n").unwrap();
        std::fs::write(&npm, "#!/usr/bin/env node\n").unwrap();
        for path in [&node, &npm] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let runtime = NodeRuntime {
            node,
            npm: NpmRunner::System { npm },
            source: "system",
            version: None,
        };
        let mut command = runtime.npm_install_command("fixture", directory.path());
        // Simulate the inherited GUI PATH only when the launch builder did not set one.
        let path = command
            .get_envs()
            .find(|(key, _)| *key == "PATH")
            .and_then(|(_, value)| value.map(std::ffi::OsStr::to_os_string))
            .unwrap_or_else(|| "/usr/bin:/bin:/usr/sbin:/sbin".into());
        let output = command.env("PATH", path).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, b"selected-node");
    }

    #[cfg(unix)]
    #[test]
    fn npm_lifecycle_uses_the_selected_node_for_system_and_bundled_launches() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let node = directory.path().join("node");
        let npm = directory.path().join("npm");
        let lifecycle = directory.path().join("lifecycle");
        std::fs::write(&node, "#!/bin/sh\nexec /bin/sh \"$@\"\n").unwrap();
        std::fs::write(
            &npm,
            format!("#!/usr/bin/env node\nnode '{}'\n", lifecycle.display()),
        )
        .unwrap();
        std::fs::write(&lifecycle, "printf selected-lifecycle").unwrap();
        for path in [&node, &npm] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        for runner in [
            NpmRunner::System { npm: npm.clone() },
            NpmRunner::BundledCli {
                npm_cli: npm.clone(),
            },
        ] {
            let runtime = NodeRuntime {
                node: node.clone(),
                npm: runner,
                source: "fixture",
                version: None,
            };
            let output = runtime
                .npm_install_command("fixture", directory.path())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(output.stdout, b"selected-lifecycle");
        }
    }

    #[test]
    fn failed_extraction_preserves_existing_staging_and_installed_files() {
        let dir = tempfile::tempdir().unwrap();
        let previous = dir.path().join(format!(".extract-{}", std::process::id()));
        std::fs::create_dir(&previous).unwrap();
        std::fs::write(previous.join("keep"), "previous attempt").unwrap();
        std::fs::write(dir.path().join(NODE_DIST_NAME), "keep installed data").unwrap();
        assert!(extract_node_archive(b"invalid archive", dir.path(), || Ok(())).is_err());
        assert_eq!(
            std::fs::read_to_string(previous.join("keep")).unwrap(),
            "previous attempt"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn package_name_strips_version_pins() {
        assert_eq!(package_name_of("pi-acp@0.0.33"), "pi-acp");
        assert_eq!(
            package_name_of("@agentclientprotocol/codex-acp@1.12.0"),
            "@agentclientprotocol/codex-acp"
        );
        assert_eq!(package_name_of("left-pad"), "left-pad");
    }

    #[test]
    fn shasums_entry_finds_matching_line() {
        let shasums =
            "aaa  node-v22.20.0-linux-x64.tar.gz\nbbb  node-v22.20.0-darwin-arm64.tar.gz\n";
        assert_eq!(
            shasums_entry(shasums, "node-v22.20.0-darwin-arm64.tar.gz").as_deref(),
            Some("bbb")
        );
        assert!(shasums_entry(shasums, "missing.tar.gz").is_none());
    }

    #[test]
    fn bin_entry_parses_string_and_object_forms() {
        let manifest = serde_json::json!({"bin": "dist/cli.js"});
        assert_eq!(bin_entry_of(&manifest).as_deref(), Some("dist/cli.js"));
        let manifest = serde_json::json!({"bin": {"codex-acp": "dist/index.js"}});
        assert_eq!(bin_entry_of(&manifest).as_deref(), Some("dist/index.js"));
        let manifest = serde_json::json!({"name": "no-bin"});
        assert!(bin_entry_of(&manifest).is_none());
    }

    #[test]
    fn system_node_probe_is_consistent_when_present() {
        // If a system node exists it must satisfy the version floor.
        let lease =
            crate::install_job::begin("system-node-probe", tauri::ipc::Channel::new(|_| Ok(())))
                .unwrap();
        if let Some(runtime) = try_system_node(&lease.job) {
            assert_eq!(runtime.source, "system");
            assert!(runtime.node.is_file());
        }
    }
}
