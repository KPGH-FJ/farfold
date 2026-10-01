//! Agent installation: registry installs and discovered-binary registration.
//!
//! Two routes produce a launchable agent row:
//! - Registry candidates get a private `npm install` under
//!   `app_data/agents/<id>/install-*`; binary distributions are downloaded
//!   (sha256-verified when the registry entry carries one) and unpacked.
//! - `register_discovered`: a binary the user already installed becomes the
//!   launch target verbatim — `{command, args, env}` only, never rewritten.
//!
//! Updates and selections initialize a candidate using the shared ACP client,
//! confirm process cleanup, then atomically select it. Initial registration
//! remains separate from establishing a connection.

use std::path::Path;
use std::sync::Arc;
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

mod archive;
mod cleanup;
use archive::extract_archive;

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

fn install_binary_agent(
    agent_id: &str,
    entry: &RegistryAgent,
    install_dir: &Path,
    job: &Job,
) -> Result<(String, Vec<String>), String> {
    let binary = entry
        .distribution
        .binary
        .as_ref()
        .and_then(|map| map.get("darwin-aarch64"))
        .ok_or_else(|| format!("{agent_id} has no darwin-aarch64 binary distribution"))?;
    let archive = job.download(&binary.archive, ARCHIVE_TIMEOUT)?;
    job.report("verify", None, None);
    job.check()?;
    if let Some(expected) = &binary.sha256 {
        let actual = sha256_hex(&archive);
        if &actual != expected {
            return Err(format!(
                "{} archive sha256 mismatch: expected {expected}, got {actual}",
                agent_id
            ));
        }
    }
    std::fs::create_dir_all(install_dir)
        .map_err(|error| format!("cannot create install dir: {error}"))?;
    job.report("extract", None, None);
    job.check()?;
    extract_archive(&archive, install_dir, &binary.archive, job)?;
    job.check()?;
    let cmd = install_dir.join(&binary.cmd);
    let cmd = cmd
        .canonicalize()
        .map_err(|error| format!("installed {agent_id} binary missing: {error}"))?;
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

struct PreparedInstallation {
    row: AgentRow,
    previous: Option<AgentRow>,
    staging: tempfile::TempDir,
}

struct ReviewedInstallation {
    entry: RegistryAgent,
    launch: AgentLaunch,
    args: Vec<String>,
    previous: Option<AgentRow>,
}

/// Freeze one distribution snapshot and validate public input before any
/// runtime/package preparation. The same entry is later used for downloading.
fn review_installation(
    catalog: &crate::agent_catalog::AgentCatalog,
    store: &MetaStore,
    agent_id: &str,
    input: Option<&crate::acp_client::installation_parameters::InstallationInput>,
) -> Result<ReviewedInstallation, String> {
    let (entry, launch) = catalog.installation_entry(agent_id)?;
    let previous = store.get_agent(agent_id)?;
    let args = crate::acp_client::installation_parameters::compile_args(
        &entry,
        &launch,
        previous.as_ref(),
        input,
    )?;
    Ok(ReviewedInstallation {
        entry,
        launch,
        args,
        previous,
    })
}

/// Prepare a separate candidate. No selected target or receipt changes yet.
fn prepare_from_registry(
    agent_id: &str,
    reviewed: ReviewedInstallation,
    node: Option<&node_runtime::NodeRuntime>,
    app_data_dir: &Path,
    job: &Job,
) -> Result<PreparedInstallation, String> {
    job.check()?;
    let def = def_for(agent_id);
    let ReviewedInstallation {
        entry,
        launch,
        args: startup_args,
        previous,
    } = reviewed;

    let parent = app_data_dir.join("agents").join(agent_id);
    std::fs::create_dir_all(&parent).map_err(|_| "无法准备安装目录".to_string())?;
    let staging = tempfile::Builder::new()
        .prefix("install-")
        .tempdir_in(&parent)
        .map_err(|_| "无法准备安装目录".to_string())?;
    job.check()?;
    let (command, args, declared_env) = match &launch {
        AgentLaunch::Npx { .. } => {
            let npx = entry
                .distribution
                .npx
                .clone()
                .ok_or_else(|| format!("{agent_id} has no npx distribution"))?;
            job.report("install", None, None);
            let installed = node_runtime::npm_install(
                node.ok_or("无法准备安装工具")?,
                &npx.package,
                staging.path(),
                job,
            )?;
            let mut args = installed.prefix_args;
            args.extend(startup_args.clone());
            (
                installed.command.to_string_lossy().into_owned(),
                args,
                npx.env,
            )
        }
        AgentLaunch::Binary { .. } => {
            let (command, _) = install_binary_agent(agent_id, &entry, staging.path(), job)?;
            let env = entry
                .distribution
                .binary
                .as_ref()
                .and_then(|map| map.get("darwin-aarch64"))
                .map(|binary| binary.env.clone())
                .unwrap_or_default();
            (command, startup_args.clone(), env)
        }
        AgentLaunch::Uvx { .. } => {
            let uvx = crate::agent_catalog::RegistryUvx::decode(
                entry
                    .distribution
                    .uvx
                    .as_ref()
                    .ok_or("目录没有提供此安装方式")?,
            )
            .ok_or("此安装声明尚不能使用，请查看官方说明")?;
            let command = crate::uv_runtime::install_package(
                app_data_dir,
                staging.path(),
                &uvx.package,
                job,
            )?;
            (
                command.to_string_lossy().into_owned(),
                startup_args.clone(),
                uvx.env,
            )
        }
    };
    let mut env: Vec<(String, String)> = declared_env.into_iter().collect();
    let existing = previous
        .as_ref()
        .map(|row| row.env.clone())
        .unwrap_or_else(|| def.as_ref().map(discovered_cli_env).unwrap_or_default());
    for (name, value) in existing {
        env.retain(|(key, _)| key != &name);
        env.push((name, value));
    }

    let row = AgentRow {
        id: agent_id.to_string(),
        name: previous
            .as_ref()
            .map(|row| row.name.clone())
            .unwrap_or_else(|| {
                def.as_ref()
                    .map_or_else(|| entry.name.clone(), |def| def.display_name.to_string())
            }),
        source: "registry".to_string(),
        command,
        args,
        env,
        version: Some(entry.version.clone()),
        handshake: None,
        created_at: previous
            .as_ref()
            .map(|row| row.created_at)
            .unwrap_or_else(now_millis),
        updated_at: now_millis(),
    };
    job.check()?;
    Ok(PreparedInstallation {
        row,
        previous,
        staging,
    })
}

/// All install/program-selection paths use the same candidate lifecycle. The
/// operation task keeps the configuration reservation until cleanup and commit.
pub(crate) async fn check_and_select(
    app: &AppHandle,
    candidate: AgentRow,
    previous: Option<AgentRow>,
    staging: Option<tempfile::TempDir>,
    job: Arc<Job>,
) -> Result<AgentRow, String> {
    check_and_select_program(app, candidate, previous, staging, job, None).await
}

pub(crate) async fn check_and_select_program(
    app: &AppHandle,
    candidate: AgentRow,
    previous: Option<AgentRow>,
    staging: Option<tempfile::TempDir>,
    job: Arc<Job>,
    program: Option<crate::installations::ProgramReceipt>,
) -> Result<AgentRow, String> {
    job.check()?;
    job.report("check", None, None);
    let manager = app.state::<crate::acp_client::manager::AcpManager>();
    let store = app.state::<MetaStore>();
    let diagnostics = manager.startup_diagnostics(&candidate.id);
    if staging.is_some() {
        diagnostics.cleanup(crate::acp_client::startup_diagnostics::Cleanup::Pending);
    }
    if let Err(error) = manager
        .probe_launch_diagnosed(&candidate, &store, job.cancelled(), diagnostics.clone())
        .await
    {
        if let Some(staging) = staging {
            if manager.candidate_pending(&candidate.id).unwrap_or(true)
                || !diagnostics.candidate_files_releasable()
            {
                // Unresolved ownership retains executable files and the existing receipt.
                let root = staging.keep();
                diagnostics.cleanup(crate::acp_client::startup_diagnostics::Cleanup::Retained);
                let row = candidate.clone();
                store
                    .run(move |store| match program.as_ref() {
                        Some(program) => crate::installations::record_with_program(
                            store,
                            &row,
                            &root,
                            Some(program),
                        ),
                        None => crate::installations::record(store, &row, &root),
                    })
                    .await
                    .map_err(|_| "检查进程尚未确认结束；安装文件已保留，但清单未能保存，请重试")?;
            } else {
                let observer = diagnostics.clone();
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    cleanup::close(staging, &observer)
                })
                .await;
            }
        }
        return Err(error);
    }
    let selected = candidate.clone();
    store
        .run(move |store| {
            let mut staging = staging;
            let result = job.commit(|| {
                job.report("activate", None, None);
                let root = staging.as_ref().map(|directory| directory.path());
                match program.as_ref() {
                    Some(program) => crate::installations::commit_candidate_with_program(
                        store,
                        &candidate,
                        previous.as_ref(),
                        root,
                        Some(program),
                    ),
                    None => crate::installations::commit_candidate(
                        store,
                        &candidate,
                        previous.as_ref(),
                        root,
                    ),
                }?;
                if let Some(staging) = staging.take() {
                    let _ = staging.keep();
                    diagnostics.cleanup(crate::acp_client::startup_diagnostics::Cleanup::Retained);
                }
                job.report("ready", None, None);
                Ok(())
            });
            if let Some(staging) = staging {
                cleanup::close(staging, &diagnostics);
            }
            result
        })
        .await?;
    Ok(selected)
}

/// Register a binary the user already installed as the launch target
/// (source=`discovered`). Only defs whose binary speaks ACP directly may
/// register this way; adapter-based agents prepare a registry candidate first.
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
    store.insert_agent(&row)?;
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
    let row = AgentRow {
        id: String::new(),
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
    store.insert_custom_agent(row)
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
    let _guard = crate::install_job::configuration_guard(&agent_id).await;
    require_disconnected(&app, &agent_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = _guard;
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
    installation_input: Option<crate::acp_client::installation_parameters::InstallationInput>,
) -> Result<AgentRow, String> {
    let lease = crate::install_job::begin(&agent_id, progress)?;
    tauri::async_runtime::spawn(async move {
        let _guard = lease.job.configuration(&agent_id).await?;
        require_disconnected(&app, &agent_id)?;
        let prepare_app = app.clone();
        let prepare_job = lease.job.clone();
        let prepared = tauri::async_runtime::spawn_blocking(move || {
            let app_data_dir = prepare_app
                .path()
                .app_data_dir()
                .map_err(|_| "无法读取安装目录")?;
            let store = prepare_app.state::<MetaStore>();
            let catalog = prepare_app.state::<crate::agent_catalog::AgentCatalog>();
            prepare_job.report("prepare", None, None);
            prepare_job.check()?;
            let reviewed =
                review_installation(&catalog, &store, &agent_id, installation_input.as_ref())?;
            let node = if matches!(reviewed.launch, AgentLaunch::Npx { .. }) {
                Some(
                    prepare_app
                        .state::<node_runtime::NodeRuntimeState>()
                        .get(&prepare_job)?,
                )
            } else {
                None
            };
            prepare_from_registry(
                &agent_id,
                reviewed,
                node.as_ref(),
                &app_data_dir,
                &prepare_job,
            )
        })
        .await
        .map_err(|_| "安装准备未完成，请重试")??;
        check_and_select(
            &app,
            prepared.row,
            prepared.previous,
            Some(prepared.staging),
            lease.job.clone(),
        )
        .await
    })
    .await
    .map_err(|_| "安装未完成，请重试".to_string())?
}

pub(crate) fn require_disconnected(app: &AppHandle, id: &str) -> Result<(), String> {
    if app
        .state::<crate::acp_client::manager::AcpManager>()
        .candidate_pending(id)?
    {
        return Err("版本检查进程尚未确认结束，请稍后重试".into());
    }
    if app
        .state::<crate::acp_client::manager::AcpManager>()
        .status(id)?
        .iter()
        .any(|s| matches!(s.state.as_str(), "ready" | "connecting" | "closing"))
    {
        return Err("请先结束任务并断开此 Agent，再更换程序".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn agent_install_rollback(app: AppHandle, agent_id: String) -> Result<(), String> {
    let lease = crate::install_job::begin(&agent_id, tauri::ipc::Channel::new(|_| Ok(())))?;
    tauri::async_runtime::spawn(async move {
        let _guard = lease.job.configuration(&agent_id).await?;
        require_disconnected(&app, &agent_id)?;
        let store = app.state::<MetaStore>();
        let (row, expected) = store
            .run(move |store| {
                let expected = store.get_agent(&agent_id)?.ok_or("尚未添加此 Agent")?;
                let mut row = expected.clone();
                let previous = store
                    .get_setting(&format!("installPrevious.{agent_id}"))?
                    .ok_or("没有可返回的安装")?;
                row.command = previous["command"]
                    .as_str()
                    .ok_or("没有可返回的安装")?
                    .into();
                row.args = serde_json::from_value(previous["args"].clone())
                    .map_err(|_| "无法读取原设置")?;
                row.source = previous["source"].as_str().unwrap_or("registry").into();
                row.version = previous["version"].as_str().map(str::to_string);
                if let Some(name) = previous["programEnv"].as_str() {
                    if crate::acp_client::preparation::program_env(&agent_id) != Some(name) {
                        return Err("程序设置已变化，请重新选择安装版本".into());
                    }
                    row.env.retain(|(key, _)| key != name);
                    if let Some(path) = previous["programPath"].as_str() {
                        row.env.push((name.into(), path.into()));
                    }
                }
                row.handshake = None;
                Ok((row, expected))
            })
            .await?;
        check_and_select(&app, row, Some(expected), None, lease.job.clone())
            .await
            .map(|_| ())
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
    let lease = crate::install_job::begin(&agent_id, tauri::ipc::Channel::new(|_| Ok(())))?;
    tauri::async_runtime::spawn(async move {
        let _guard = lease.job.configuration(&agent_id).await?;
        require_disconnected(&app, &agent_id)?;
        let store = app.state::<MetaStore>();
        let (row, expected) = store
            .run(move |store| {
                let name = crate::acp_client::preparation::program_env(&agent_id)
                    .ok_or("此接入不支持选择程序")?;
                let expected = store.get_agent(&agent_id)?.ok_or("请先安装接入组件")?;
                let mut row = expected.clone();
                let selected = match path {
                    Some(p) => Some(validate_executable_path(&p)?.to_string_lossy().into_owned()),
                    None if def_for(&agent_id).is_some_and(|def| def.bundled_program) => None,
                    None => return Err("请先选择已安装的程序".into()),
                };
                row.env.retain(|(key, _)| key != name);
                if let Some(path) = selected {
                    row.env.push((name.into(), path));
                }
                row.handshake = None;
                Ok((row, expected))
            })
            .await?;
        check_and_select(&app, row, Some(expected), None, lease.job.clone())
            .await
            .map(|_| ())
    })
    .await
    .map_err(|_| "程序选择未保存".to_string())?
}

/// Remove an agent row after disconnecting its live connections.
#[tauri::command]
pub async fn agent_remove(app: AppHandle, agent_id: String) -> Result<bool, String> {
    let _guard = crate::install_job::configuration_guard(&agent_id).await;
    require_disconnected(&app, &agent_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = _guard;
        let store = app.state::<MetaStore>();
        crate::installations::remember_before_remove(
            &store,
            &app.state::<crate::agent_catalog::AgentCatalog>(),
            &agent_id,
        )?;
        crate::credentials::revoke_agent(&store, &agent_id)?;
        store.remove_agent(&agent_id)
    })
    .await
    .map_err(|_| "移除未完成，请重试".to_string())?
}

#[cfg(test)]
mod npm_entry_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_parameter_review_freezes_one_directory_snapshot_before_preparation() {
        use crate::acp_client::installation_parameters::{InstallationInput, options};
        let dir = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&dir.path().join("store.sqlite3")).unwrap();
        let entry: RegistryAgent = serde_json::from_value(serde_json::json!({
            "id":"fast-agent","name":"fast-agent","version":"0.10.1",
            "distribution":{"uvx":{"package":"fast-agent-acp==0.10.1","args":["-x"],
                "env":{"FAST_AGENT_MODEL":"codexplan"}}}
        }))
        .unwrap();
        let launch = crate::agent_catalog::registry_launch(&entry).unwrap();
        let options = options(&entry, &launch, None).unwrap();
        let input = InstallationInput {
            declaration_id: options.declaration_id,
            registry_version: options.registry_version,
            launch: options.launch,
            values: std::collections::BTreeMap::from([("model".into(), "$system.default".into())]),
        };
        let now = now_millis() as u64;
        let cache = dir.path().join("registry-cache.json");
        let write_cache = |entry: &RegistryAgent, fetched_at: u64| {
            std::fs::write(
                &cache,
                serde_json::to_vec(&serde_json::json!({
                    "source":crate::agent_catalog::REGISTRY_URL,
                    "fetchedAt":fetched_at,"agents":[entry]
                }))
                .unwrap(),
            )
            .unwrap();
        };
        write_cache(&entry, now);
        let catalog = crate::agent_catalog::AgentCatalog::new(dir.path().into());
        let reviewed =
            review_installation(&catalog, &store, "registry:fast-agent", Some(&input)).unwrap();
        let mut changed = entry.clone();
        changed.distribution.uvx.as_mut().unwrap()["env"]["FAST_AGENT_MODEL"] =
            serde_json::json!("other-public-model");
        write_cache(&changed, now + 1);
        assert!(
            review_installation(&catalog, &store, "registry:fast-agent", Some(&input)).is_err()
        );
        // Preparation consumes this owned snapshot, never a second catalog lookup.
        assert_eq!(reviewed.entry, entry);
        assert_eq!(reviewed.launch, launch);
        assert_eq!(reviewed.args, vec!["-x", "--model", "$system.default"]);
        assert!(reviewed.previous.is_none());
        assert!(store.list_agents().unwrap().is_empty());
        assert!(!dir.path().join("agents").exists());
        assert!(store.get_setting("installations.v1").unwrap().is_none());
    }

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
        store.insert_agent(&old).unwrap();
        let reviewed = ReviewedInstallation {
            entry: RegistryAgent::default(),
            launch: AgentLaunch::Npx {
                package: "not-executed".into(),
                args: vec![],
            },
            args: vec![],
            previous: Some(old.clone()),
        };
        let lease =
            crate::install_job::begin("codex-cancel-test", tauri::ipc::Channel::new(|_| Ok(())))
                .unwrap();
        crate::install_job::agent_install_cancel("codex-cancel-test".into()).unwrap();
        assert!(prepare_from_registry("codex", reviewed, None, dir.path(), &lease.job).is_err());
        let after = store.get_agent("codex").unwrap().unwrap();
        assert_eq!(after.command, old.command);
        assert_eq!(after.env, old.env);
        let installs = dir.path().join("agents/codex");
        assert!(!installs.exists() || std::fs::read_dir(installs).unwrap().count() == 0);
    }

    fn store() -> MetaStore {
        let directory = tempfile::tempdir().expect("tempdir");
        MetaStore::open(&directory.path().join("farfold.sqlite3")).expect("open store")
    }

    #[test]
    fn access_regression_custom_add_never_replaces_an_existing_identity() {
        let directory = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&directory.path().join("meta.db")).unwrap();
        let first = register_custom(
            "助手甲",
            "/bin/echo",
            &["first-agent".into()],
            &[("TOKEN".into(), "__keychain__".into())],
            &store,
        )
        .unwrap();
        let second =
            register_custom("助手乙", "/bin/echo", &["second-agent".into()], &[], &store).unwrap();
        assert_ne!(first.id, second.id);
        assert_eq!(store.get_agent(&first.id).unwrap().unwrap(), first);
        assert_eq!(store.list_agents().unwrap().len(), 2);
    }

    #[test]
    fn concurrent_custom_adds_preserve_legacy_session_and_credential_ids() {
        let directory = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&directory.path().join("meta.db")).unwrap();
        let legacy = AgentRow {
            id: "custom-existing".into(),
            name: "助手".into(),
            source: "custom".into(),
            command: "/bin/echo".into(),
            args: vec!["existing".into()],
            env: vec![("TOKEN".into(), "__keychain__".into())],
            version: None,
            handshake: Some(serde_json::json!({"authMethods": []})),
            created_at: 1,
            updated_at: 1,
        };
        store.insert_agent(&legacy).unwrap();
        let session = crate::meta_store::SessionRow {
            id: "legacy-session".into(),
            agent_id: legacy.id.clone(),
            cwd: "/existing".into(),
            native_session_id: Some("native-history".into()),
            title: Some("keep".into()),
            config_options: None,
            pinned: true,
            archived: false,
            created_at: 1,
            updated_at: 1,
        };
        store.upsert_session(&session).unwrap();
        let grant = serde_json::json!([{"id": "fixture-key", "label": "fixture", "provider": "fixture", "endpoint": "", "apiType": "", "secretRef": "fixture-reference", "retired": [], "grants": [{"agentId": legacy.id, "envName": "TOKEN", "overrideExisting": true}], "deleting": false}]);
        store.set_setting("credentials.v1", &grant).unwrap();
        std::thread::scope(|scope| {
            let handles = (0..4)
                .map(|_| {
                    scope.spawn(|| {
                        register_custom("助手", "/bin/echo", &["new".into()], &[], &store)
                            .unwrap()
                            .id
                    })
                })
                .collect::<Vec<_>>();
            let ids = handles
                .into_iter()
                .map(|h| h.join().unwrap())
                .collect::<std::collections::HashSet<_>>();
            assert_eq!(ids.len(), 4);
        });
        assert_eq!(store.get_agent(&legacy.id).unwrap().unwrap(), legacy);
        assert_eq!(store.get_session(&session.id).unwrap().unwrap(), session);
        assert_eq!(store.get_setting("credentials.v1").unwrap().unwrap(), grant);
        assert_eq!(store.list_agents().unwrap().len(), 5);
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
        assert!(row.id.starts_with("custom-"));
        assert_eq!(row.source, "custom");
        assert_eq!(row.args, vec!["--acp".to_string()]);
        assert_eq!(row.env, vec![("FOO".to_string(), "1".to_string())]);
        assert!(store.get_agent(&row.id).unwrap().is_some());
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
