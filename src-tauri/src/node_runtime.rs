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

const NODE_DIST_VERSION: &str = "v22.20.0";
const NODE_DIST_NAME: &str = "node-v22.20.0-darwin-arm64";
const NODE_MIN_MAJOR: u64 = 18;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);

/// How `npm install` is invoked.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum NpmRunner {
    /// A system npm executable on PATH (invoked directly).
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
            path.split(':')
                .filter(|entry| !entry.is_empty())
                .map(PathBuf::from)
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
        node,
        npm: NpmRunner::System { npm },
        source: "system",
    })
}

fn bundled_layout(app_data_dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let root = app_data_dir.join("node").join(NODE_DIST_NAME);
    let node = root.join("bin/node");
    let npm_cli = root.join("lib/node_modules/npm/bin/npm-cli.js");
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

fn extract_node_archive(archive: &[u8], dist_dir: &Path) -> Result<tempfile::TempDir, String> {
    let staging = tempfile::Builder::new()
        .prefix(".extract-")
        .tempdir_in(dist_dir)
        .map_err(|error| format!("cannot create node staging dir: {error}"))?;
    let decoder = flate2::read::GzDecoder::new(archive);
    tar::Archive::new(decoder)
        .unpack(staging.path())
        .map_err(|error| format!("cannot extract node archive: {error}"))?;
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
    let archive_name = format!("{NODE_DIST_NAME}.tar.gz");
    let shasums = String::from_utf8_lossy(
        &job.download(&format!("{base}/SHASUMS256.txt"), Duration::from_secs(30))?,
    )
    .into_owned();
    let expected = shasums_entry(&shasums, &archive_name)
        .ok_or_else(|| format!("no SHASUMS256 entry for {archive_name}"))?;

    let archive = job.download(&format!("{base}/{archive_name}"), DOWNLOAD_TIMEOUT)?;
    let actual = sha256_hex(&archive);
    if actual != expected {
        return Err(format!(
            "node archive sha256 mismatch: expected {expected}, got {actual}"
        ));
    }

    job.check()?;
    job.report("extract", None, None);
    let staging = extract_node_archive(&archive, &dist_dir)?;
    let extracted_root = staging.path().join(NODE_DIST_NAME);
    let (final_root, node, npm_cli) = bundled_layout(app_data_dir);
    if final_root.exists() {
        return Err("已有 Node 文件不完整；已保留，请检查后重试".into());
    }
    job.check()?;
    if !extracted_root.join("bin/node").is_file()
        || !extracted_root
            .join("lib/node_modules/npm/bin/npm-cli.js")
            .is_file()
    {
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
}

/// `npm install --prefix <install_dir> <pkg_spec> --save-exact`, then resolve
/// the package's `bin` entry to an absolute path. Returns the launch pair
/// `(node_path, bin_entry_path)` for `node <bin-entry>` invocation.
pub fn npm_install(
    runtime: &NodeRuntime,
    pkg_spec: &str,
    install_dir: &Path,
    job: &crate::install_job::Job,
) -> Result<(PathBuf, PathBuf), String> {
    std::fs::create_dir_all(install_dir)
        .map_err(|error| format!("cannot create install dir: {error}"))?;
    job.run(&mut runtime.npm_install_command(pkg_spec, install_dir))?;

    let package_name = package_name_of(pkg_spec);
    let package_dir = install_dir.join("node_modules").join(&package_name);
    let manifest_raw = std::fs::read_to_string(package_dir.join("package.json"))
        .map_err(|error| format!("installed {pkg_spec} has no package.json: {error}"))?;
    let manifest: serde_json::Value = serde_json::from_str(&manifest_raw)
        .map_err(|error| format!("installed {pkg_spec} manifest is not JSON: {error}"))?;
    let bin_entry = bin_entry_of(&manifest)
        .ok_or_else(|| format!("installed {pkg_spec} exposes no bin entry"))?;
    let bin_path = package_dir.join(&bin_entry);
    let bin_path = bin_path
        .canonicalize()
        .map_err(|error| format!("installed {pkg_spec} bin entry missing: {error}"))?;
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
mod tests {
    use super::*;

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
        assert!(extract_node_archive(b"invalid archive", dir.path()).is_err());
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
