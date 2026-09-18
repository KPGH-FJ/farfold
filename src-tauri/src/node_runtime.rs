//! Private Node runtime for npx-distributed agents.
//!
//! If the user's login PATH already has Node ≥18 and npm, we use it. Otherwise
//! Farfold downloads the official `node-v22.20.0-darwin-arm64.tar.gz` into
//! `app_data/node/` (verified against the matching `SHASUMS256.txt` entry) and
//! uses the npm bundled inside that dist. Users never need to install Node.

use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::agent_discovery::find_binary;
use crate::shell_env;

const NODE_DIST_VERSION: &str = "v22.20.0";
const NODE_DIST_NAME: &str = "node-v22.20.0-darwin-arm64";
const NODE_MIN_MAJOR: u64 = 18;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

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
        match &self.npm {
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
        }
    }
}

fn node_major(node: &Path) -> Option<u64> {
    let output = Command::new(node)
        .arg("--version")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let text = text.trim().trim_start_matches('v');
    let major = text.split('.').next()?.parse().ok()?;
    Some(major)
}

fn node_version_string(node: &Path) -> Option<String> {
    let output = Command::new(node).arg("--version").output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn try_system_node() -> Option<NodeRuntime> {
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
    let major = node_major(&node)?;
    if major < NODE_MIN_MAJOR {
        return None;
    }
    Some(NodeRuntime {
        version: node_version_string(&node),
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

fn try_existing_bundled(app_data_dir: &Path) -> Option<NodeRuntime> {
    let (_root, node, npm_cli) = bundled_layout(app_data_dir);
    if !node.is_file() || !npm_cli.is_file() {
        return None;
    }
    node_major(&node)?;
    Some(NodeRuntime {
        version: node_version_string(&node),
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

fn https_get(url: &str, timeout: Duration) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .https_only(true)
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(timeout)
        .build()
        .map_err(|_| "cannot create download client".to_string())?;
    let mut response = client
        .get(url)
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("download failed for {url}: {error}"))?;
    let mut bytes = Vec::new();
    response
        .read_to_end(&mut bytes)
        .map_err(|error| format!("download truncated for {url}: {error}"))?;
    Ok(bytes)
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

fn download_and_extract_node(app_data_dir: &Path) -> Result<NodeRuntime, String> {
    let dist_dir = app_data_dir.join("node");
    std::fs::create_dir_all(&dist_dir)
        .map_err(|error| format!("cannot create node directory: {error}"))?;

    let base = format!("https://nodejs.org/dist/{NODE_DIST_VERSION}");
    let archive_name = format!("{NODE_DIST_NAME}.tar.gz");
    let shasums = String::from_utf8_lossy(&https_get(
        &format!("{base}/SHASUMS256.txt"),
        Duration::from_secs(30),
    )?)
    .into_owned();
    let expected = shasums_entry(&shasums, &archive_name)
        .ok_or_else(|| format!("no SHASUMS256 entry for {archive_name}"))?;

    let archive = https_get(&format!("{base}/{archive_name}"), DOWNLOAD_TIMEOUT)?;
    let actual = sha256_hex(&archive);
    if actual != expected {
        return Err(format!(
            "node archive sha256 mismatch: expected {expected}, got {actual}"
        ));
    }

    let staging = dist_dir.join(format!(".extract-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)
        .map_err(|error| format!("cannot create node staging dir: {error}"))?;
    let decoder = flate2::read::GzDecoder::new(&archive[..]);
    let mut tar = tar::Archive::new(decoder);
    tar.unpack(&staging)
        .map_err(|error| format!("cannot extract node archive: {error}"))?;

    let extracted_root = staging.join(NODE_DIST_NAME);
    let (final_root, node, npm_cli) = bundled_layout(app_data_dir);
    if final_root.exists() {
        let _ = std::fs::remove_dir_all(&final_root);
    }
    std::fs::rename(&extracted_root, &final_root)
        .map_err(|error| format!("cannot place node dist: {error}"))?;
    let _ = std::fs::remove_dir_all(&staging);

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
    Ok(NodeRuntime {
        version: node_version_string(&node),
        node,
        npm: NpmRunner::BundledCli { npm_cli },
        source: "bundled",
    })
}

/// Resolve a usable Node: system Node ≥18 + npm when present, else the
/// Farfold-managed dist (downloaded and sha256-verified on first use).
pub fn ensure_node(app_data_dir: &Path) -> Result<NodeRuntime, String> {
    if let Some(runtime) = try_system_node() {
        return Ok(runtime);
    }
    if let Some(runtime) = try_existing_bundled(app_data_dir) {
        return Ok(runtime);
    }
    download_and_extract_node(app_data_dir)
}

/// Managed state wrapper: resolves Node once per process and caches the
/// result (system reuse or downloaded dist) for `npm_install` callers.
pub struct NodeRuntimeState {
    app_data_dir: PathBuf,
    resolved: std::sync::OnceLock<Result<NodeRuntime, String>>,
}

impl NodeRuntimeState {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            app_data_dir,
            resolved: std::sync::OnceLock::new(),
        }
    }

    pub fn get(&self) -> Result<NodeRuntime, String> {
        self.resolved
            .get_or_init(|| ensure_node(&self.app_data_dir))
            .clone()
    }
}

/// `npm install --prefix <install_dir> <pkg_spec> --save-exact`, then resolve
/// the package's `bin` entry to an absolute path. Returns the launch pair
/// `(node_path, bin_entry_path)` for `node <bin-entry>` invocation.
pub fn npm_install(
    runtime: &NodeRuntime,
    pkg_spec: &str,
    install_dir: &Path,
) -> Result<(PathBuf, PathBuf), String> {
    std::fs::create_dir_all(install_dir)
        .map_err(|error| format!("cannot create install dir: {error}"))?;
    let output = runtime
        .npm_install_command(pkg_spec, install_dir)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("cannot run npm install for {pkg_spec}: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "npm install {pkg_spec} failed ({}): {}",
            output.status,
            stderr.chars().take(400).collect::<String>()
        ));
    }

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
        if let Some(runtime) = try_system_node() {
            assert_eq!(runtime.source, "system");
            assert!(runtime.node.is_file());
        }
    }
}
