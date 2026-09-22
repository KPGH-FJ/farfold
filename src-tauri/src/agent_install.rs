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

use std::io::Write as _;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::agent_catalog::{AgentDef, AgentLaunch, RegistryAgent, def_for};
use crate::agent_discovery::{
    candidate_dirs, discover_def, probe_version, validate_executable_path,
};
use crate::install_job::Job;
use crate::meta_store::{AgentRow, MetaStore};
use crate::node_runtime;

const ARCHIVE_TIMEOUT: Duration = Duration::from_secs(300);

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

fn install_binary_agent(
    def: &AgentDef,
    entry: &RegistryAgent,
    install_dir: &Path,
    job: &Job,
) -> Result<(String, Vec<String>), String> {
    let binary = entry
        .distribution
        .binary
        .as_ref()
        .and_then(|map| map.get("darwin-aarch64"))
        .ok_or_else(|| format!("{} has no darwin-aarch64 binary distribution", def.id))?;
    let archive = job.download(&binary.archive, ARCHIVE_TIMEOUT)?;
    job.report("verify", None, None);
    job.check()?;
    if let Some(expected) = &binary.sha256 {
        let actual = sha256_hex(&archive);
        if &actual != expected {
            return Err(format!(
                "{} archive sha256 mismatch: expected {expected}, got {actual}",
                def.id
            ));
        }
    }
    std::fs::create_dir_all(install_dir)
        .map_err(|error| format!("cannot create install dir: {error}"))?;
    job.report("extract", None, None);
    job.check()?;
    extract_archive(&archive, install_dir, &binary.archive)?;
    job.check()?;
    let cmd = install_dir.join(&binary.cmd);
    let cmd = cmd
        .canonicalize()
        .map_err(|error| format!("installed {} binary missing: {error}", def.id))?;
    if !cmd.starts_with(install_dir.canonicalize().map_err(|_| "无法读取安装目录")?) {
        return Err("下载内容中的执行文件位置无效".into());
    }
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
    node: Option<&node_runtime::NodeRuntime>,
    app_data_dir: &Path,
    job: &Job,
) -> Result<AgentRow, String> {
    job.check()?;
    let def = def_for(agent_id).ok_or_else(|| format!("unknown agent id: {agent_id}"))?;
    let entry = catalog
        .entry_for(&def)
        .ok_or_else(|| format!("no registry entry for {}", def.registry_id))?;

    let parent = app_data_dir.join("agents").join(def.id);
    std::fs::create_dir_all(&parent).map_err(|_| "无法准备安装目录".to_string())?;
    let staging = tempfile::Builder::new()
        .prefix("install-")
        .tempdir_in(&parent)
        .map_err(|_| "无法准备安装目录".to_string())?;
    let previous = store.get_agent(agent_id)?;
    job.check()?;
    let (command, args) = match &def.install_launch {
        AgentLaunch::Npx { .. } => {
            let npx = entry
                .distribution
                .npx
                .clone()
                .ok_or_else(|| format!("{} has no npx distribution", def.id))?;
            job.report("install", None, None);
            let (node, bin) = node_runtime::npm_install(
                node.ok_or("无法准备安装工具")?,
                &npx.package,
                staging.path(),
                job,
            )?;
            let mut args = vec![bin.to_string_lossy().into_owned()];
            args.extend(npx.args);
            (node.to_string_lossy().into_owned(), args)
        }
        AgentLaunch::Binary { .. } => install_binary_agent(&def, &entry, staging.path(), job)?,
    };

    let row = AgentRow {
        id: def.id.to_string(),
        name: def.display_name.to_string(),
        source: "registry".to_string(),
        command,
        args,
        env: previous
            .as_ref()
            .map(|row| row.env.clone())
            .unwrap_or_else(|| discovered_cli_env(&def)),
        version: Some(entry.version.clone()),
        handshake: None,
        created_at: now_millis(),
        updated_at: now_millis(),
    };
    job.commit(|| {
    job.report("activate", None, None);
    if let Some(previous) = previous {
        store.set_setting(&format!("installPrevious.{agent_id}"), &serde_json::json!({"command":previous.command,"args":previous.args,"source":previous.source,"version":previous.version}))?;
    }
    store.upsert_agent(&row)?;
    let _ = staging.keep();

        Ok(())
    })?;
    job.report("ready", None, None);
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
pub async fn agent_install(
    app: AppHandle,
    agent_id: String,
    progress: tauri::ipc::Channel<crate::install_job::Progress>,
) -> Result<AgentRow, String> {
    let lease = crate::install_job::begin(&agent_id, progress)?;
    let _guard = crate::install_job::configuration_guard(&agent_id).await;
    require_disconnected(&app, &agent_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|_| "无法读取安装目录".to_string())?;
        let store = app.state::<MetaStore>();
        let catalog = app.state::<crate::agent_catalog::AgentCatalog>();
        lease.job.report("prepare", None, None);
        lease.job.check()?;
        let node = if def_for(&agent_id)
            .is_some_and(|def| matches!(def.install_launch, AgentLaunch::Npx { .. }))
        {
            Some(
                app.state::<node_runtime::NodeRuntimeState>()
                    .get(&lease.job)?,
            )
        } else {
            None
        };
        install_from_registry(
            &agent_id,
            &store,
            &catalog,
            node.as_ref(),
            &app_data_dir,
            &lease.job,
        )
    })
    .await
    .map_err(|_| "安装未完成，请重试".to_string())?
}

fn require_disconnected(app: &AppHandle, id: &str) -> Result<(), String> {
    if app
        .state::<crate::acp_client::manager::AcpManager>()
        .status(id)?
        .iter()
        .any(|s| s.state == "ready" || s.state == "connecting")
    {
        return Err("请先结束任务并断开此 Agent，再更换程序".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn agent_install_rollback(app: AppHandle, agent_id: String) -> Result<(), String> {
    let _guard = crate::install_job::configuration_guard(&agent_id).await;
    require_disconnected(&app, &agent_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<MetaStore>();
        let mut row = store.get_agent(&agent_id)?.ok_or("尚未添加此 Agent")?;
        let key = format!("installPrevious.{agent_id}");
        let previous = store.get_setting(&key)?.ok_or("没有可返回的安装")?;
        row.command = previous["command"]
            .as_str()
            .ok_or("没有可返回的安装")?
            .into();
        row.args =
            serde_json::from_value(previous["args"].clone()).map_err(|_| "无法读取原设置")?;
        row.source = previous["source"].as_str().unwrap_or("registry").into();
        row.version = previous["version"].as_str().map(str::to_string);
        row.handshake = None;
        store.upsert_agent(&row)?;
        store.set_setting(&key, &serde_json::Value::Null)
    })
    .await
    .map_err(|_| "未能返回原设置".to_string())?
}

#[tauri::command]
pub async fn agent_select_program(
    app: AppHandle,
    agent_id: String,
    path: Option<String>,
) -> Result<(), String> {
    let _guard = crate::install_job::configuration_guard(&agent_id).await;
    require_disconnected(&app, &agent_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<MetaStore>();
        let def = def_for(&agent_id).ok_or("此接入不支持选择程序")?;
        let name = def.discovered_cli_env.ok_or("此接入不支持选择程序")?;
        let mut row = store.get_agent(&agent_id)?.ok_or("请先安装接入组件")?;
        let selected = match path {
            Some(p) => Some(validate_executable_path(&p)?.to_string_lossy().into_owned()),
            None if def.bundled_program => None,
            None => return Err("请先选择已安装的程序".into()),
        };
        row.env.retain(|(key, _)| key != name);
        if let Some(path) = selected {
            row.env.push((name.into(), path));
        }
        row.handshake = None;
        store.upsert_agent(&row)
    })
    .await
    .map_err(|_| "程序选择未保存".to_string())?
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
    fn cancelled_install_preserves_previous_program_and_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&dir.path().join("store.sqlite3")).unwrap();
        let old = register_custom(
            "old",
            "/bin/sh",
            &[],
            &[("KEY".into(), "__keychain__".into())],
            &store,
        )
        .unwrap();
        let mut old = old;
        old.id = "codex".into();
        store.upsert_agent(&old).unwrap();
        let catalog = crate::agent_catalog::AgentCatalog::new(dir.path().into());
        let lease =
            crate::install_job::begin("codex-cancel-test", tauri::ipc::Channel::new(|_| Ok(())))
                .unwrap();
        crate::install_job::agent_install_cancel("codex-cancel-test".into()).unwrap();
        assert!(
            install_from_registry("codex", &store, &catalog, None, dir.path(), &lease.job).is_err()
        );
        let after = store.get_agent("codex").unwrap().unwrap();
        assert_eq!(after.command, old.command);
        assert_eq!(after.env, old.env);
        let installs = dir.path().join("agents/codex");
        assert!(!installs.exists() || std::fs::read_dir(installs).unwrap().count() == 0);
    }

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
