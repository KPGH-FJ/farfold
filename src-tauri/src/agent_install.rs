//! Agent installation: registry installs and discovered-binary registration.
//!
//! Two routes produce a launchable agent row:
//! - `install_from_registry`: npx adapters get a private `npm install` under
//!   `app_data/agents/<id>/<version>/`; binary distributions are downloaded
//!   (sha256-verified when the registry entry carries one) and unpacked.
//! - `register_discovered`: a binary the user already installed becomes the
//!   launch target verbatim — `{command, args, env}` only, never rewritten.
//!
//! Both write an `agents` row. Whether the result actually works is decided
//! by the ACP `initialize` handshake at connect time.

use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::agent_catalog::{AgentDef, AgentLaunch, RegistryAgent, def_for};
use crate::agent_discovery::{
    candidate_dirs, discover_def, probe_version, validate_executable_path,
};
use crate::meta_store::{AgentRow, MetaStore};
use crate::node_runtime;

const ARCHIVE_TIMEOUT: Duration = Duration::from_secs(300);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
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

fn install_dir_for(app_data_dir: &Path, agent_id: &str, version: &str) -> PathBuf {
    app_data_dir.join("agents").join(agent_id).join(version)
}

/// Env overrides injected into an installed agent row: when the user already
/// has the underlying CLI, the adapter should delegate to it instead of
/// fetching its own (auth and config reuse — D2).
fn discovered_cli_env(def: &AgentDef) -> Vec<(String, String)> {
    let Some(env_name) = def.discovered_cli_env else {
        return vec![];
    };
    let dirs = candidate_dirs();
    discover_def(def, &dirs)
        .map(|found| vec![(env_name.to_string(), found.path)])
        .unwrap_or_default()
}

/// Extract an archive into `dest`: `.tar.gz`/`.tgz` via the tar crate,
/// `.zip` via macOS `ditto` (platform is darwin-arm64 only this phase).
fn extract_archive(archive: &[u8], dest: &Path, label: &str) -> Result<(), String> {
    if label.ends_with(".zip") {
        let mut tmp = tempfile::Builder::new()
            .prefix(".archive-")
            .suffix(".zip")
            .tempfile_in(dest)
            .map_err(|error| format!("cannot create archive staging: {error}"))?;
        tmp.write_all(archive)
            .map_err(|error| format!("cannot stage {label}: {error}"))?;
        let status = Command::new("ditto")
            .args(["-x", "-k"])
            .arg(tmp.path())
            .arg(dest)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output();
        return match status {
            Ok(output) if output.status.success() => Ok(()),
            Ok(output) => Err(format!(
                "ditto failed for {label}: {}",
                String::from_utf8_lossy(&output.stderr)
            )),
            Err(error) => Err(format!("cannot run ditto for {label}: {error}")),
        };
    }
    let decoder = flate2::read::GzDecoder::new(archive);
    tar::Archive::new(decoder)
        .unpack(dest)
        .map_err(|error| format!("cannot extract {label}: {error}"))
}

fn install_npx_agent(
    def: &AgentDef,
    package: &str,
    extra_args: &[String],
    version: &str,
    app_data_dir: &Path,
    runtime: &node_runtime::NodeRuntime,
) -> Result<(String, Vec<String>), String> {
    let install_dir = install_dir_for(app_data_dir, def.id, version);
    let (node, bin_entry) = node_runtime::npm_install(runtime, package, &install_dir)?;
    let mut args = vec![bin_entry.to_string_lossy().into_owned()];
    args.extend(extra_args.iter().cloned());
    Ok((node.to_string_lossy().into_owned(), args))
}

fn install_binary_agent(
    def: &AgentDef,
    entry: &RegistryAgent,
    app_data_dir: &Path,
) -> Result<(String, Vec<String>), String> {
    let binary = entry
        .distribution
        .binary
        .as_ref()
        .and_then(|map| map.get("darwin-aarch64"))
        .ok_or_else(|| format!("{} has no darwin-aarch64 binary distribution", def.id))?;
    let archive = https_get(&binary.archive, ARCHIVE_TIMEOUT)?;
    if let Some(expected) = &binary.sha256 {
        let actual = sha256_hex(&archive);
        if &actual != expected {
            return Err(format!(
                "{} archive sha256 mismatch: expected {expected}, got {actual}",
                def.id
            ));
        }
    }
    let install_dir = install_dir_for(app_data_dir, def.id, &entry.version);
    std::fs::create_dir_all(&install_dir)
        .map_err(|error| format!("cannot create install dir: {error}"))?;
    extract_archive(&archive, &install_dir, &binary.archive)?;
    let cmd = install_dir.join(&binary.cmd);
    let cmd = cmd
        .canonicalize()
        .map_err(|error| format!("installed {} binary missing: {error}", def.id))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(&cmd, std::fs::Permissions::from_mode(0o755));
    }
    Ok((cmd.to_string_lossy().into_owned(), binary.args.clone()))
}

/// Install `agent_id` from the ACP registry and write the `agents` row
/// (source=`registry`). Returns the row.
pub fn install_from_registry(
    agent_id: &str,
    store: &MetaStore,
    catalog: &crate::agent_catalog::AgentCatalog,
    node: &node_runtime::NodeRuntime,
    app_data_dir: &Path,
) -> Result<AgentRow, String> {
    let def = def_for(agent_id).ok_or_else(|| format!("unknown agent id: {agent_id}"))?;
    let entry = catalog
        .entry_for(&def)
        .ok_or_else(|| format!("no registry entry for {}", def.registry_id))?;

    let (command, args) = match &def.install_launch {
        AgentLaunch::Npx { .. } => {
            let npx = entry
                .distribution
                .npx
                .clone()
                .ok_or_else(|| format!("{} has no npx distribution", def.id))?;
            install_npx_agent(
                &def,
                &npx.package,
                &npx.args,
                &entry.version,
                app_data_dir,
                node,
            )?
        }
        AgentLaunch::Binary { .. } => install_binary_agent(&def, &entry, app_data_dir)?,
    };

    let row = AgentRow {
        id: def.id.to_string(),
        name: def.display_name.to_string(),
        source: "registry".to_string(),
        command,
        args,
        env: discovered_cli_env(&def),
        version: Some(entry.version.clone()),
        handshake: None,
        created_at: now_millis(),
        updated_at: now_millis(),
    };
    store.upsert_agent(&row)?;
    Ok(row)
}

/// Register a binary the user already installed as the launch target
/// (source=`discovered`). Only defs whose binary speaks ACP directly may
/// register this way; adapter-based agents go through `install_from_registry`.
pub fn register_discovered(
    agent_id: &str,
    path: &str,
    store: &MetaStore,
) -> Result<AgentRow, String> {
    let def = def_for(agent_id).ok_or_else(|| format!("unknown agent id: {agent_id}"))?;
    let args = def.binary_args.clone().ok_or_else(|| {
        format!(
            "{} connects through its adapter — install it from the registry instead",
            def.display_name
        )
    })?;
    let resolved = validate_executable_path(path)?;
    let row = AgentRow {
        id: def.id.to_string(),
        name: def.display_name.to_string(),
        source: "discovered".to_string(),
        command: resolved.to_string_lossy().into_owned(),
        args,
        env: vec![],
        version: probe_version(&resolved),
        handshake: None,
        created_at: now_millis(),
        updated_at: now_millis(),
    };
    store.upsert_agent(&row)?;
    Ok(row)
}

/// Register a user-supplied command as a custom agent (source=`custom`).
pub fn register_custom(
    name: &str,
    command: &str,
    args: &[String],
    env: &[(String, String)],
    store: &MetaStore,
) -> Result<AgentRow, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("agent name is empty".to_string());
    }
    let resolved = validate_executable_path(command)?;
    let slug: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let mut id = format!("custom-{slug}");
    let mut suffix = 2;
    while store
        .get_agent(&id)?
        .is_some_and(|row| row.command != resolved.to_string_lossy())
    {
        id = format!("custom-{slug}-{suffix}");
        suffix += 1;
    }
    let row = AgentRow {
        id,
        name: name.to_string(),
        source: "custom".to_string(),
        command: resolved.to_string_lossy().into_owned(),
        args: args.to_vec(),
        env: env.to_vec(),
        version: probe_version(&resolved),
        handshake: None,
        created_at: now_millis(),
        updated_at: now_millis(),
    };
    store.upsert_agent(&row)?;
    Ok(row)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Register a locally discovered binary as the launch target for `agent_id`.
#[tauri::command]
pub async fn agent_register(
    app: AppHandle,
    agent_id: String,
    path: String,
) -> Result<AgentRow, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<MetaStore>();
        register_discovered(&agent_id, &path, &store)
    })
    .await
    .map_err(|error| format!("agent_register failed: {error}"))?
}

/// Register a user-supplied `{command, args, env}` as a custom agent.
#[tauri::command]
pub async fn agent_add_custom(
    app: AppHandle,
    name: String,
    command: String,
    args: Vec<String>,
    env: std::collections::HashMap<String, String>,
) -> Result<AgentRow, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<MetaStore>();
        let env: Vec<(String, String)> = env.into_iter().collect();
        register_custom(&name, &command, &args, &env, &store)
    })
    .await
    .map_err(|error| format!("agent_add_custom failed: {error}"))?
}

/// Install `agent_id` from the ACP registry (npx private install or binary
/// archive download) and write the agents row.
#[tauri::command]
pub async fn agent_install(app: AppHandle, agent_id: String) -> Result<AgentRow, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("cannot resolve app data dir: {error}"))?;
        let store = app.state::<MetaStore>();
        let catalog = app.state::<crate::agent_catalog::AgentCatalog>();
        let node = app.state::<node_runtime::NodeRuntimeState>().get()?;
        install_from_registry(&agent_id, &store, &catalog, &node, &app_data_dir)
    })
    .await
    .map_err(|error| format!("agent_install failed: {error}"))?
}

/// Remove an agent row after disconnecting its live connections.
#[tauri::command]
pub fn agent_remove(app: AppHandle, agent_id: String) -> Result<bool, String> {
    let manager = app.state::<crate::acp_client::manager::AcpManager>();
    disconnect_all(&manager, &agent_id);
    let store = app.state::<MetaStore>();
    store.remove_agent(&agent_id)
}

/// Disconnect every live connection an agent has (any cwd).
fn disconnect_all(manager: &crate::acp_client::manager::AcpManager, agent_id: &str) {
    if let Ok(statuses) = manager.status(agent_id) {
        for status in statuses {
            let _ = manager.disconnect(agent_id, std::path::Path::new(&status.cwd));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_zip_only_removes_its_own_staged_file() {
        let dir = tempfile::tempdir().unwrap();
        let previous = dir
            .path()
            .join(format!(".archive-{}.zip", std::process::id()));
        std::fs::write(&previous, "previous attempt").unwrap();
        assert!(extract_archive(b"invalid zip", dir.path(), "fixture.zip").is_err());
        assert_eq!(
            std::fs::read_to_string(previous).unwrap(),
            "previous attempt"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    fn store() -> MetaStore {
        let directory = tempfile::tempdir().expect("tempdir");
        MetaStore::open(&directory.path().join("farfold.sqlite3")).expect("open store")
    }

    #[test]
    fn register_custom_writes_row_and_validates() {
        let store = store();
        assert!(register_custom("bad", "/no/such/bin", &[], &[], &store).is_err());
        assert!(register_custom("", "/bin/ls", &[], &[], &store).is_err());

        let row = register_custom(
            "My Agent",
            "/bin/ls",
            &["--acp".to_string()],
            &[("FOO".to_string(), "1".to_string())],
            &store,
        )
        .unwrap();
        assert_eq!(row.id, "custom-my-agent");
        assert_eq!(row.source, "custom");
        assert_eq!(row.args, vec!["--acp".to_string()]);
        assert_eq!(row.env, vec![("FOO".to_string(), "1".to_string())]);
        assert!(store.get_agent("custom-my-agent").unwrap().is_some());
    }

    #[test]
    fn register_discovered_requires_binary_capable_def() {
        let store = store();
        assert!(register_discovered("codex", "/bin/ls", &store).is_err());
        assert!(register_discovered("nope", "/bin/ls", &store).is_err());
        assert!(register_discovered("opencode", "/definitely/missing", &store).is_err());
    }

    #[test]
    fn register_discovered_opencode_writes_row() {
        let store = store();
        let row = register_discovered("opencode", "/bin/ls", &store).unwrap();
        assert_eq!(row.source, "discovered");
        assert_eq!(row.args, vec!["acp".to_string()]);
        assert_eq!(row.command, "/bin/ls");
    }
}
