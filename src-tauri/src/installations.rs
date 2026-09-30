//! Farfold-owned installation inventory. Paths alone never grant deletion authority.
use crate::{
    acp_client::manager::AcpManager,
    agent_catalog::AgentCatalog,
    meta_store::{AgentRow, MetaStore},
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
static MUTATION: std::sync::Mutex<()> = std::sync::Mutex::new(());
const KEY: &str = "installations.v1";
#[derive(Clone)]
pub(crate) struct ProgramReceipt {
    pub path: PathBuf,
    pub version: Option<String>,
    pub node_launch: Option<crate::program_launch::NodeLaunch>,
    pub release: Option<crate::npm_release::ProgramRelease>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Installation {
    pub id: String,
    pub agent_id: String,
    pub path: String,
    pub command: String,
    pub args: Vec<String>,
    pub version: Option<String>,
    pub source: String,
    pub managed_root: Option<String>,
    pub program_only: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) node_launch: Option<crate::program_launch::NodeLaunch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) release: Option<crate::npm_release::ProgramRelease>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallationView {
    #[serde(flatten)]
    item: Installation,
    selected: bool,
    in_use: bool,
    can_uninstall: bool,
}
fn read(store: &MetaStore) -> Result<Vec<Installation>, String> {
    store
        .get_setting(KEY)?
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| "无法读取程序清单，原数据已保留".into())
        .map(|v| v.unwrap_or_default())
}
fn write(store: &MetaStore, items: &[Installation]) -> Result<(), String> {
    store.set_setting(
        KEY,
        &serde_json::to_value(items).map_err(|_| "无法保存程序清单")?,
    )
}
fn identity(agent: &str, path: &str) -> String {
    format!("{agent}:{path}")
}
pub fn record(store: &MetaStore, row: &AgentRow, root: &Path) -> Result<(), String> {
    record_with_program(store, row, root, None)
}
pub(crate) fn record_with_program(
    store: &MetaStore,
    row: &AgentRow,
    root: &Path,
    program: Option<&ProgramReceipt>,
) -> Result<(), String> {
    let _lock = MUTATION.lock().map_err(|_| "程序清单暂时不可用")?;
    let mut items = read(store)?;
    append_receipt(&mut items, row, root, program)?;
    write(store, &items)
}

pub(crate) fn record_unselected_program(
    store: &MetaStore,
    expected: &AgentRow,
    root: &Path,
    program: &ProgramReceipt,
) -> Result<(), String> {
    let _lock = MUTATION.lock().map_err(|_| "程序清单暂时不可用")?;
    let mut items = read(store)?;
    append_receipt(&mut items, expected, root, Some(program))?;
    store.save_program_inventory(
        expected,
        &serde_json::to_value(items).map_err(|_| "无法保存程序清单")?,
    )
}

fn append_receipt(
    items: &mut Vec<Installation>,
    row: &AgentRow,
    root: &Path,
    program: Option<&ProgramReceipt>,
) -> Result<(), String> {
    let path = root
        .canonicalize()
        .map_err(|_| "无法确认安装位置")?
        .to_string_lossy()
        .into_owned();
    let id = identity(&row.id, &path);
    let executable = program
        .map(|program| {
            program
                .path
                .canonicalize()
                .map_err(|_| "无法确认所需程序位置")
        })
        .transpose()?;
    if executable
        .as_ref()
        .is_some_and(|executable| !executable.starts_with(&path))
    {
        return Err("所需程序不在本次安装目录中".into());
    }
    let executable = executable.map(|path| path.to_string_lossy().into_owned());
    items.retain(|item| item.id != id);
    items.push(Installation {
        id,
        agent_id: row.id.clone(),
        path: executable.clone().unwrap_or_else(|| path.clone()),
        command: executable.unwrap_or_else(|| row.command.clone()),
        args: if program.is_some() {
            vec![]
        } else {
            row.args.clone()
        },
        version: program.map_or_else(|| row.version.clone(), |program| program.version.clone()),
        source: "managed".into(),
        managed_root: Some(path),
        program_only: program.is_some(),
        node_launch: program.and_then(|program| program.node_launch.clone()),
        release: program.and_then(|program| program.release.clone()),
    });
    Ok(())
}

/// The caller has checked the candidate and still owns its configuration lock.
/// Keep receipt updates serialized across Agents, then commit all metadata in
/// one SQLite transaction without changing any credentials or session records.
pub(crate) fn commit_candidate(
    store: &MetaStore,
    candidate: &AgentRow,
    expected: Option<&AgentRow>,
    root: Option<&Path>,
) -> Result<(), String> {
    commit_candidate_with_program(store, candidate, expected, root, None)
}
pub(crate) fn commit_candidate_with_program(
    store: &MetaStore,
    candidate: &AgentRow,
    expected: Option<&AgentRow>,
    root: Option<&Path>,
    program: Option<&ProgramReceipt>,
) -> Result<(), String> {
    let _lock = MUTATION.lock().map_err(|_| "程序清单暂时不可用")?;
    let mut items = read(store)?;
    if let Some(root) = root {
        append_receipt(&mut items, candidate, root, program)?;
    }
    let previous = expected
        .map(|row| {
            let program_env = crate::acp_client::preparation::program_env(&row.id);
            serde_json::json!({
                "command": row.command,
                "args": row.args,
                "source": row.source,
                "version": row.version,
                "programEnv": program_env,
                "programPath": program_path(row),
            })
        })
        .unwrap_or(serde_json::Value::Null);
    store.commit_agent_candidate(
        candidate,
        expected,
        &previous,
        &serde_json::to_value(items).map_err(|_| "无法保存程序清单")?,
    )
}
fn program_path(row: &AgentRow) -> Option<&str> {
    let name = crate::acp_client::preparation::program_env(&row.id)?;
    row.env
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}
fn same_path(a: &str, b: &str) -> bool {
    a == b
        || Path::new(a)
            .canonicalize()
            .ok()
            .zip(Path::new(b).canonicalize().ok())
            .is_some_and(|(a, b)| a == b)
}
fn selected(item: &Installation, row: Option<&AgentRow>) -> bool {
    row.is_some_and(|r| {
        if item.program_only {
            program_path(r).is_some_and(|p| same_path(p, &item.path))
        } else {
            same_path(&r.command, &item.command) && r.args == item.args
        }
    })
}
fn inventory(
    store: &MetaStore,
    catalog: &AgentCatalog,
    id: &str,
) -> Result<Vec<Installation>, String> {
    inventory_with_discovered(store, catalog.discovered_cached().unwrap_or_default(), id)
}
fn inventory_with_discovered(
    store: &MetaStore,
    discovered: Vec<crate::agent_discovery::DiscoveredBinary>,
    id: &str,
) -> Result<Vec<Installation>, String> {
    let mut items: Vec<_> = read(store)?
        .into_iter()
        .filter(|i| i.agent_id == id)
        .collect();
    let def = crate::agent_catalog::def_for(id);
    let mut add = |command: String,
                   args: Vec<String>,
                   version: Option<String>,
                   program_only: bool,
                   source: &str| {
        if let Some(existing) = items.iter_mut().find(|i| {
            if i.program_only != program_only {
                return false;
            }
            if program_only {
                same_path(&i.path, &command)
            } else {
                same_path(&i.command, &command) && i.args == args
            }
        }) {
            // A selected external program is added before discovery, with an
            // unknown version. Merge fresh observations without duplicating
            // that installation or borrowing its connection component version.
            if version.is_some() {
                existing.version = version;
            }
            return;
        }
        items.push(Installation {
            id: identity(id, &format!("{command}:{args:?}")),
            agent_id: id.into(),
            path: if !program_only && def.as_ref().is_some_and(|d| d.discovered_cli_env.is_some()) {
                args.first()
                    .filter(|p| Path::new(p).is_absolute())
                    .cloned()
                    .unwrap_or_else(|| command.clone())
            } else {
                command.clone()
            },
            command,
            args,
            version,
            source: source.into(),
            managed_root: None,
            program_only,
            node_launch: None,
            release: None,
        });
    };
    if let Some(row) = store.get_agent(id)? {
        add(
            row.command.clone(),
            row.args.clone(),
            row.version.clone(),
            false,
            if row.source == "registry" {
                "unverified"
            } else {
                "external"
            },
        );
        if let Some(path) = program_path(&row) {
            add(path.into(), vec![], None, true, "external");
        }
    }
    if let Some(previous) = store.get_setting(&format!("installPrevious.{id}"))?
        && let (Some(command), Some(args)) =
            (previous["command"].as_str(), previous["args"].as_array())
    {
        add(
            command.into(),
            args.iter()
                .filter_map(|a| a.as_str().map(str::to_owned))
                .collect(),
            previous["version"].as_str().map(str::to_owned),
            false,
            "unverified",
        );
    }
    for found in discovered.into_iter().filter(|f| f.agent_id == id) {
        let component = def.as_ref().is_some_and(|d| d.discovered_cli_env.is_some());
        add(
            found.path,
            def.as_ref()
                .and_then(|d| d.binary_args.clone())
                .unwrap_or_default(),
            found.version,
            component,
            "external",
        );
    }
    Ok(items)
}
pub fn remember_before_remove(
    store: &MetaStore,
    catalog: &AgentCatalog,
    id: &str,
) -> Result<(), String> {
    let _lock = MUTATION.lock().map_err(|_| "程序清单暂时不可用")?;
    let known = inventory(store, catalog, id)?;
    let mut all = read(store)?;
    for item in known {
        if !all.iter().any(|i| i.id == item.id) {
            all.push(item);
        }
    }
    write(store, &all)
}
fn owned_root(item: &Installation, data: &Path) -> Result<PathBuf, String> {
    let root = PathBuf::from(
        item.managed_root
            .as_ref()
            .ok_or("请使用原安装方式管理此程序")?,
    );
    let parent = data
        .join("agents")
        .join(&item.agent_id)
        .canonicalize()
        .map_err(|_| "无法确认安装归属")?;
    // Never follow a replaced root symlink. Ownership was recorded by the installer.
    if std::fs::symlink_metadata(&root)
        .map_err(|_| "安装目录不可访问")?
        .file_type()
        .is_symlink()
    {
        return Err("安装位置已改变，不能卸载".into());
    }
    let canonical = root.canonicalize().map_err(|_| "无法确认安装归属")?;
    if canonical.parent() != Some(parent.as_path()) || canonical != root {
        return Err("安装位置已改变，不能卸载".into());
    }
    Ok(canonical)
}
#[tauri::command]
pub async fn agent_installations(
    app: AppHandle,
    agent_id: String,
) -> Result<Vec<InstallationView>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = app.state::<MetaStore>();
        let row = store.get_agent(&agent_id)?;
        let manager = app.state::<AcpManager>();
        let connected = manager.candidate_pending(&agent_id)?
            || manager
                .status(&agent_id)?
                .iter()
                .any(|s| matches!(s.state.as_str(), "ready" | "connecting" | "closing"));
        let data = app.path().app_data_dir().map_err(|_| "无法读取安装目录")?;
        Ok(inventory(&store, &app.state::<AgentCatalog>(), &agent_id)?
            .into_iter()
            .map(|item| {
                let selected = selected(&item, row.as_ref());
                let can_uninstall = !selected && !connected && owned_root(&item, &data).is_ok();
                InstallationView {
                    item,
                    selected,
                    in_use: selected && connected,
                    can_uninstall,
                }
            })
            .collect())
    })
    .await
    .map_err(|_| "无法读取程序清单".to_string())?
}
#[tauri::command]
pub async fn agent_installation_select(
    app: AppHandle,
    agent_id: String,
    installation_id: String,
) -> Result<(), String> {
    let lease = crate::install_job::begin(&agent_id, tauri::ipc::Channel::new(|_| Ok(())))?;
    tauri::async_runtime::spawn(async move {
        let _guard = lease.job.configuration(&agent_id).await?;
        crate::agent_install::require_disconnected(&app, &agent_id)?;
        let prepare_app = app.clone();
        let prepare_job = lease.job.clone();
        let (row, expected) = tauri::async_runtime::spawn_blocking(move || {
            let store = prepare_app.state::<MetaStore>();
            let item = inventory(&store, &prepare_app.state::<AgentCatalog>(), &agent_id)?
                .into_iter()
                .find(|i| i.id == installation_id)
                .ok_or("程序已不存在，请刷新")?;
            let expected = store.get_agent(&agent_id)?.ok_or("请先添加此 Agent")?;
            let data = prepare_app
                .path()
                .app_data_dir()
                .map_err(|_| "无法读取安装目录")?;
            let row = selection_candidate(&item, &expected, &data, || prepare_job.check())?;
            Ok::<_, String>((row, expected))
        })
        .await
        .map_err(|_| "无法读取程序选择")??;
        crate::agent_install::check_and_select(&app, row, Some(expected), None, lease.job.clone())
            .await
            .map(|_| ())
    })
    .await
    .map_err(|_| "程序选择未保存".to_string())?
}

fn selection_candidate(
    item: &Installation,
    expected: &AgentRow,
    data: &Path,
    check: impl Fn() -> Result<(), String>,
) -> Result<AgentRow, String> {
    check()?;
    let mut row = expected.clone();
    if item.program_only {
        // Component selection may have changed since this program was installed.
        // Validate its current component and the actual program, never a receipt's
        // obsolete component command.
        crate::agent_discovery::validate_executable_path(&expected.command)?;
        crate::agent_discovery::validate_executable_path(&item.path)?;
        if let Some(launch) = &item.node_launch {
            let release = item
                .release
                .as_ref()
                .ok_or("程序发行信息不完整，请重新安装")?;
            let root = owned_root(item, data)?;
            crate::program_launch::validate(&root, Path::new(&item.path), launch, release, &check)?;
        }
        let name =
            crate::acp_client::preparation::program_env(&row.id).ok_or("此接入不支持选择程序")?;
        row.env.retain(|(key, _)| key != name);
        row.env.push((name.into(), item.path.clone()));
    } else {
        crate::agent_discovery::validate_executable_path(&item.command)?;
        row.command = item.command.clone();
        row.args = item.args.clone();
        row.version = item.version.clone();
        row.source = if item.managed_root.is_some() {
            "registry"
        } else {
            "discovered"
        }
        .into();
    }
    row.handshake = None;
    check()?;
    Ok(row)
}
#[tauri::command]
pub async fn agent_installation_uninstall(
    app: AppHandle,
    agent_id: String,
    installation_id: String,
) -> Result<(), String> {
    let _guard = crate::install_job::configuration_guard(&agent_id).await;
    crate::agent_install::require_disconnected(&app, &agent_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = _guard;
        let store = app.state::<MetaStore>();
        let data = app.path().app_data_dir().map_err(|_| "无法读取安装目录")?;
        remove_installed(&store, &data, &agent_id, &installation_id)
    })
    .await
    .map_err(|_| "卸载未完成，请重试".to_string())?
}
fn remove_installed(
    store: &MetaStore,
    data: &Path,
    agent_id: &str,
    installation_id: &str,
) -> Result<(), String> {
    let _lock = MUTATION.lock().map_err(|_| "程序清单暂时不可用")?;
    let mut items = read(store)?;
    let item = items
        .iter()
        .find(|i| i.id == installation_id && i.agent_id == agent_id)
        .ok_or("此安装未由 Farfold 登记，不能卸载")?;
    if selected(item, store.get_agent(agent_id)?.as_ref()) {
        return Err("请先切换程序或移除此接入，再卸载".into());
    }
    let root = PathBuf::from(item.managed_root.as_ref().ok_or("不能卸载外部程序")?);
    // Missing means a previous removal succeeded but metadata persistence failed.
    if root.symlink_metadata().is_ok() {
        let root = owned_root(item, data)?;
        for row in store.list_agents()? {
            if std::iter::once(row.command.as_str())
                .chain(row.args.iter().map(String::as_str))
                .chain(row.env.iter().map(|(_, v)| v.as_str()))
                .any(|p| Path::new(p).starts_with(&root))
            {
                return Err("另一个接入仍在使用此程序，请先更换其程序".into());
            }
        }
        std::fs::remove_dir_all(root).map_err(|_| "卸载未完成，配置与历史已保留，请重试")?;
    }
    items.retain(|i| i.id != installation_id);
    write(store, &items)
}
#[cfg(test)]
mod tests {
    use super::*;

    fn candidate_fixture(store: &MetaStore, root: &Path) -> (AgentRow, ProgramReceipt) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(root).unwrap();
        let program = root.join("program");
        std::fs::write(&program, "#!/bin/sh\nprintf '0.81.0\\n'\n").unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let row = AgentRow {
            id: "pi".into(),
            name: "Pi".into(),
            source: "registry".into(),
            command: "/bin/sh".into(),
            args: vec!["kept-component".into()],
            env: vec![("PI_ACP_PI_COMMAND".into(), "/external/daily-pi".into())],
            version: Some("0.0.34".into()),
            handshake: Some(serde_json::json!({"kept":true})),
            created_at: 1,
            updated_at: 1,
        };
        store.insert_agent(&row).unwrap();
        (
            row,
            ProgramReceipt {
                path: program,
                version: Some("0.81.0".into()),
                node_launch: None,
                release: None,
            },
        )
    }

    #[test]
    fn unselected_program_publish_keeps_current_launch_and_accepts_only_handshake_updates() {
        let data = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&data.path().join("meta.db")).unwrap();
        let root = data.path().join("agents/pi/new-candidate");
        let (row, receipt) = candidate_fixture(&store, &root);
        store
            .set_setting("kept-setting", &serde_json::json!({"draft":"untouched"}))
            .unwrap();
        store
            .set_agent_handshake(&row, &serde_json::json!({"new":"handshake only"}))
            .unwrap();
        let observed = store.get_agent(&row.id).unwrap().unwrap();
        record_unselected_program(&store, &row, &root, &receipt).unwrap();
        assert_eq!(store.get_agent(&row.id).unwrap().unwrap(), observed);
        assert_eq!(
            store.get_setting("kept-setting").unwrap().unwrap()["draft"],
            "untouched"
        );
        let items = read(&store).unwrap();
        assert_eq!(items.len(), 1);
        assert!(!selected(&items[0], Some(&observed)));
        assert!(store.get_setting("installPrevious.pi").unwrap().is_none());
        let mut newer = observed.clone();
        newer.env[0].1 = "/external/new-choice".into();
        store.replace_agent_launch(&newer).unwrap();
        assert!(record_unselected_program(&store, &row, &root, &receipt).is_err());
        assert_eq!(read(&store).unwrap().len(), 1);
    }

    #[test]
    fn unselected_program_receipt_failure_or_cancel_cannot_change_selection() {
        let data = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&data.path().join("meta.db")).unwrap();
        let root = data.path().join("agents/pi/new-candidate");
        let (row, receipt) = candidate_fixture(&store, &root);
        let lease = crate::install_job::begin(
            "unselected-program-cancel",
            tauri::ipc::Channel::new(|_| Ok(())),
        )
        .unwrap();
        crate::install_job::agent_install_cancel("unselected-program-cancel".into()).unwrap();
        assert!(
            lease
                .job
                .commit(|| record_unselected_program(&store, &row, &root, &receipt))
                .is_err()
        );
        assert!(store.get_setting(KEY).unwrap().is_none());
        rusqlite::Connection::open(data.path().join("meta.db")).unwrap().execute_batch("CREATE TRIGGER fail_program_receipt BEFORE INSERT ON settings WHEN NEW.key = 'installations.v1' BEGIN SELECT RAISE(ABORT, 'fixture'); END;").unwrap();
        assert!(record_unselected_program(&store, &row, &root, &receipt).is_err());
        assert!(store.get_setting(KEY).unwrap().is_none());
        assert_eq!(store.get_agent(&row.id).unwrap().unwrap(), row);
        assert!(receipt.path.exists());
    }

    #[test]
    fn program_selection_uses_current_component_even_when_old_receipt_component_disappeared() {
        let data = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&data.path().join("meta.db")).unwrap();
        let root = data.path().join("agents/pi/new-candidate");
        let (row, receipt) = candidate_fixture(&store, &root);
        record_unselected_program(&store, &row, &root, &receipt).unwrap();
        let mut item = read(&store).unwrap().remove(0);
        item.command = "/removed/old-component".into();
        let candidate = selection_candidate(&item, &row, data.path(), || Ok(())).unwrap();
        assert_eq!(candidate.command, row.command);
        assert_eq!(candidate.args, row.args);
        assert_eq!(candidate.version, row.version);
        assert_eq!(program_path(&candidate), Some(item.path.as_str()));
        assert_eq!(store.get_agent(&row.id).unwrap().unwrap(), row);
        commit_candidate(&store, &candidate, Some(&row), None).unwrap();
        let mut external = item.clone();
        external.path = "/bin/sh".into();
        external.managed_root = None;
        external.node_launch = None;
        external.release = None;
        let returned = selection_candidate(&external, &candidate, data.path(), || Ok(())).unwrap();
        assert_eq!(returned.command, row.command);
        assert_eq!(program_path(&returned), Some("/bin/sh"));
    }

    #[test]
    fn dependency_receipt_is_atomic_selectable_and_never_owns_the_external_entrypoint() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().canonicalize().unwrap();
        let store = MetaStore::open(&data.join("meta.db")).unwrap();
        let root = data.join("agents/registry:amp-acp/dependency-fixture");
        std::fs::create_dir_all(&root).unwrap();
        let program = root.join("amp");
        std::fs::write(&program, "fixture").unwrap();
        let old = AgentRow {
            id: "registry:amp-acp".into(),
            name: "Amp".into(),
            source: "registry".into(),
            command: "/external/amp-acp".into(),
            args: vec![],
            env: vec![("CREDENTIAL_REF".into(), "__keychain__".into())],
            version: Some("0.9.0".into()),
            handshake: None,
            created_at: 1,
            updated_at: 1,
        };
        store.insert_agent(&old).unwrap();
        let mut candidate = old.clone();
        candidate
            .env
            .push(("AMP_CLI_PATH".into(), program.display().to_string()));
        let receipt = ProgramReceipt {
            path: program.clone(),
            version: Some("2099.0.0".into()),
            node_launch: None,
            release: None,
        };
        commit_candidate_with_program(&store, &candidate, Some(&old), Some(&root), Some(&receipt))
            .unwrap();
        let selected_row = store.get_agent(&old.id).unwrap().unwrap();
        assert_eq!(selected_row.command, old.command);
        assert_eq!(selected_row.env, candidate.env);
        let items = read(&store).unwrap();
        assert_eq!(items.len(), 1);
        assert!(items[0].program_only);
        assert_eq!(items[0].path, program.display().to_string());
        assert_eq!(items[0].version.as_deref(), Some("2099.0.0"));
        assert!(selected(&items[0], Some(&selected_row)));
        assert!(owned_root(&items[0], &data).is_ok());
        assert!(remove_installed(&store, &data, &old.id, &items[0].id).is_err());
        let previous = store
            .get_setting(&format!("installPrevious.{}", old.id))
            .unwrap()
            .unwrap();
        assert_eq!(previous["programEnv"], "AMP_CLI_PATH");
        assert!(previous["programPath"].is_null());
        assert!(!previous.to_string().contains("CREDENTIAL_REF"));
        store.replace_agent_launch(&old).unwrap();
        remove_installed(&store, &data, &old.id, &items[0].id).unwrap();
        assert!(!root.exists());
        assert_eq!(store.get_agent(&old.id).unwrap().unwrap().env, old.env);
    }

    #[test]
    fn stale_dependency_selection_cannot_publish_a_receipt_or_replace_the_new_selection() {
        let dir = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
        let root = dir.path().join("dependency");
        std::fs::create_dir(&root).unwrap();
        let path = root.join("amp");
        std::fs::write(&path, "fixture").unwrap();
        let old = AgentRow {
            id: "registry:amp-acp".into(),
            name: "Amp".into(),
            source: "registry".into(),
            command: "/external/amp-acp".into(),
            args: vec![],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 1,
            updated_at: 1,
        };
        store.insert_agent(&old).unwrap();
        let mut newer = old.clone();
        newer
            .env
            .push(("AMP_CLI_PATH".into(), "/external/new-choice".into()));
        store.replace_agent_launch(&newer).unwrap();
        let receipt = ProgramReceipt {
            path,
            version: None,
            node_launch: None,
            release: None,
        };
        assert!(
            commit_candidate_with_program(&store, &old, Some(&old), Some(&root), Some(&receipt))
                .is_err()
        );
        assert_eq!(store.get_agent(&old.id).unwrap().unwrap().env, newer.env);
        assert!(store.get_setting(KEY).unwrap().is_none());
    }

    #[test]
    fn cancelled_checked_candidate_keeps_target_receipts_and_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
        let old = AgentRow {
            id: "cancelled-candidate".into(),
            name: "Kept".into(),
            source: "custom".into(),
            command: "/fixture/old-agent".into(),
            args: vec![],
            env: vec![("MODEL_KEY".into(), "__keychain__".into())],
            version: Some("1".into()),
            handshake: Some(serde_json::json!({"kept":true})),
            created_at: 1,
            updated_at: 1,
        };
        store.insert_agent(&old).unwrap();
        let mut candidate = old.clone();
        candidate.command = "/fixture/checked-agent".into();
        candidate.handshake = None;
        let lease =
            crate::install_job::begin(&old.id, tauri::ipc::Channel::new(|_| Ok(()))).unwrap();
        // The compatibility result arrived after cancellation. It has no right
        // to publish a selection even though its process has already exited.
        crate::install_job::agent_install_cancel(old.id.clone()).unwrap();
        assert!(
            lease
                .job
                .commit(|| commit_candidate(&store, &candidate, Some(&old), None))
                .is_err()
        );
        assert_eq!(store.get_agent(&old.id).unwrap(), Some(old));
        assert!(store.get_setting(KEY).unwrap().is_none());
        assert!(
            store
                .get_setting("installPrevious.cancelled-candidate")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn checked_program_selection_preserves_credentials_and_only_snapshots_program_path() {
        let dir = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
        let old = AgentRow {
            id: "codex".into(),
            name: "My Codex".into(),
            source: "registry".into(),
            command: "/fixture/node".into(),
            args: vec!["/fixture/component.js".into()],
            env: vec![
                ("CODEX_PATH".into(), "/fixture/old-codex".into()),
                ("MODEL_KEY".into(), "__keychain__".into()),
            ],
            version: Some("1.12.0".into()),
            handshake: Some(serde_json::json!({"old":true})),
            created_at: 1,
            updated_at: 1,
        };
        store.insert_agent(&old).unwrap();
        let mut candidate = old.clone();
        candidate.env[0].1 = "/fixture/new-codex".into();
        candidate.handshake = None;
        commit_candidate(&store, &candidate, Some(&old), None).unwrap();
        let selected = store.get_agent("codex").unwrap().unwrap();
        assert_eq!(selected.env, candidate.env);
        assert!(selected.handshake.is_none());
        assert_eq!(selected.created_at, old.created_at);
        let previous = store.get_setting("installPrevious.codex").unwrap().unwrap();
        assert_eq!(previous["programPath"], "/fixture/old-codex");
        assert!(!previous.to_string().contains("MODEL_KEY"));
        assert!(!previous.to_string().contains("__keychain__"));
    }
    #[test]
    fn selected_external_program_keeps_its_discovered_version_separate_from_component() {
        let dir = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
        let row = AgentRow {
            id: "codex".into(),
            name: "Codex".into(),
            source: "registry".into(),
            command: "/fixture/node".into(),
            args: vec!["/fixture/codex-acp/index.js".into()],
            env: vec![("CODEX_PATH".into(), "/fixture/codex".into())],
            version: Some("1.12.0".into()),
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        store.insert_agent(&row).unwrap();
        let items = inventory_with_discovered(
            &store,
            vec![crate::agent_discovery::DiscoveredBinary {
                agent_id: "codex".into(),
                path: "/fixture/codex".into(),
                version: Some("0.143.0".into()),
            }],
            "codex",
        )
        .unwrap();
        assert_eq!(items.len(), 2);
        let program = items.iter().find(|item| item.program_only).unwrap();
        assert!(selected(program, Some(&row)));
        assert_eq!(program.version.as_deref(), Some("0.143.0"));
        let component = items.iter().find(|item| !item.program_only).unwrap();
        assert_eq!(component.version.as_deref(), Some("1.12.0"));
    }
    #[test]
    fn uninstall_refuses_selected_and_preserves_other_installs_and_history() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().canonicalize().unwrap();
        let store = MetaStore::open(&data.join("meta.db")).unwrap();
        let first = data.join("agents/opencode/first");
        let second = data.join("agents/opencode/second");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        std::fs::write(first.join("agent"), "first").unwrap();
        std::fs::write(second.join("agent"), "second").unwrap();
        std::fs::write(data.join("user-history"), "keep").unwrap();
        let mut row = AgentRow {
            id: "opencode".into(),
            name: "test".into(),
            source: "registry".into(),
            command: first.join("agent").display().to_string(),
            args: vec![],
            env: vec![],
            version: Some("1".into()),
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        record(&store, &row, &first).unwrap();
        store.insert_agent(&row).unwrap();
        let id = read(&store).unwrap()[0].id.clone();
        assert!(remove_installed(&store, &data, "opencode", &id).is_err());
        row.command = second.join("agent").display().to_string();
        record(&store, &row, &second).unwrap();
        store.replace_agent_launch(&row).unwrap();
        remove_installed(&store, &data, "opencode", &id).unwrap();
        assert!(!first.exists());
        assert!(second.join("agent").exists());
        assert_eq!(
            std::fs::read_to_string(data.join("user-history")).unwrap(),
            "keep"
        );
        assert_eq!(read(&store).unwrap().len(), 1);
        assert!(remove_installed(&store, &data, "other", &id).is_err());
    }
    #[test]
    fn multiple_same_version_installs_remain_distinct_and_selection_is_exact() {
        let dir = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
        let mut row = AgentRow {
            id: "opencode".into(),
            name: "test".into(),
            source: "registry".into(),
            command: "/bin/sh".into(),
            args: vec!["first".into()],
            env: vec![],
            version: Some("1.0".into()),
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        for name in ["one", "two"] {
            let root = dir.path().join("agents/opencode").join(name);
            std::fs::create_dir_all(&root).unwrap();
            record(&store, &row, &root).unwrap();
            row.args = vec!["second".into()];
        }
        let items = read(&store).unwrap();
        assert_eq!(items.len(), 2);
        assert_ne!(items[0].id, items[1].id);
        assert!(!selected(&items[0], Some(&row)));
        assert!(selected(&items[1], Some(&row)));
        let catalog = AgentCatalog::new(dir.path().into());
        store.insert_agent(&row).unwrap();
        assert_eq!(inventory(&store, &catalog, "opencode").unwrap().len(), 2);
        assert_eq!(inventory(&store, &catalog, "opencode").unwrap().len(), 2);
        store.remove_agent("opencode").unwrap();
        assert_eq!(read(&store).unwrap().len(), 2);
    }
    #[test]
    fn ownership_rejects_external_and_symlink_roots() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("agents/a");
        std::fs::create_dir_all(&parent).unwrap();
        let root = parent.join("one");
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let mut item = Installation {
            id: "a".into(),
            agent_id: "a".into(),
            path: root.display().to_string(),
            command: String::new(),
            args: vec![],
            version: None,
            source: "managed".into(),
            managed_root: Some(root.display().to_string()),
            program_only: false,
            node_launch: None,
            release: None,
        };
        assert!(owned_root(&item, dir.path()).is_ok());
        item.managed_root = None;
        assert!(owned_root(&item, dir.path()).is_err());
        let link = parent.join("link");
        std::os::unix::fs::symlink(&root, &link).unwrap();
        item.managed_root = Some(link.display().to_string());
        assert!(owned_root(&item, dir.path()).is_err());
    }
}
