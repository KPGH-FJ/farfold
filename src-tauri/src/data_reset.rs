//! Clear only Farfold-owned data: the registry/session index, settings, the
//! app-owned conversation folder, managed install/runtime directories and
//! Farfold's own secure-storage entries. Each Agent's own program, account,
//! configuration and history — and every user-selected project folder — stay
//! untouched. Nothing here deletes a path outside the app data directory, and
//! symlinks are removed as links, never followed into user content.

use std::path::Path;
use tauri::{AppHandle, Manager};

use crate::meta_store::MetaStore;

/// Directories Farfold creates inside its app data folder. These namespaces
/// are exclusively Farfold-owned; deleting a namespace cannot reach user
/// project folders or an Agent's own HOME/configuration.
const OWNED_DIRS: &[&str] = &[
    "conversations",
    "agent-installations",
    "companion-programs",
    // Legacy managed root namespace kept only for installs written by
    // previous versions; still entirely inside Farfold's app data folder.
    "agents",
    "node",
    "uv",
    "python",
];
const OWNED_FILES: &[&str] = &["registry-cache.json"];

/// Remove one exact Farfold-owned path. A symlink is deleted as a link — its
/// target is never followed — so a user-placed alias cannot cause deletion of
/// external content.
fn remove_owned(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(metadata) if metadata.file_type().is_symlink() => {
            std::fs::remove_file(path).map_err(|_| "无法删除".to_string())
        }
        Ok(metadata) if metadata.is_dir() => {
            std::fs::remove_dir_all(path).map_err(|_| "无法删除".to_string())
        }
        Ok(_) => std::fs::remove_file(path).map_err(|_| "无法删除".to_string()),
        Err(_) => Err("无法删除".to_string()),
    }
}

/// Every secure-storage service name owned by Farfold: pooled API credentials
/// and the per-Agent env copies referenced by `__keychain__` markers. The list
/// is built before the metadata reset so a partial failure never orphans a
/// vault entry whose reference was already forgotten.
fn keychain_services(store: &MetaStore) -> Result<Vec<String>, String> {
    let mut services = crate::credentials::secret_services(store)?;
    for row in store.list_agents()? {
        for (name, value) in &row.env {
            if value == crate::auth::KEYCHAIN_MARKER {
                services.push(crate::auth::env_keychain_service(&row.id, name));
            }
        }
    }
    Ok(services)
}

/// The deletable steps of a full clear, in an order that keeps failures
/// honest: secure-storage secrets first (their references live in settings),
/// then owned directories and files, then the metadata tables last so a
/// failure in any earlier step still leaves a consistent record of what kept
/// existing. Returns the names of owned paths that could not be removed.
pub(crate) fn clear_owned(
    data_dir: &Path,
    store: &MetaStore,
    delete_secret: &dyn Fn(&str) -> Result<(), String>,
) -> Result<(), String> {
    for service in keychain_services(store)? {
        delete_secret(&service)?;
    }
    let mut kept = Vec::new();
    for name in OWNED_DIRS.iter().map(|name| data_dir.join(name)) {
        if remove_owned(&name).is_err() {
            kept.push(name.display().to_string());
        }
    }
    for name in OWNED_FILES.iter().map(|name| data_dir.join(name)) {
        if remove_owned(&name).is_err() {
            kept.push(name.display().to_string());
        }
    }
    if kept.is_empty() {
        store.clear_all()
    } else {
        Err(format!(
            "部分 Farfold 数据未能删除，保留在: {}",
            kept.join("、")
        ))
    }
}

/// Clear all Farfold-owned data. Runs only when nothing is in flight or
/// unconfirmed — the same quiescence a managed update requires — then ends
/// every connection (including unfinished candidates) and waits for confirmed
/// termination before deleting owned paths and resetting the metadata store.
/// Agent-owned programs/configuration/history outside the app data directory
/// and user project folders are never touched.
#[tauri::command]
pub async fn farfold_data_clear(app: AppHandle) -> Result<(), String> {
    let permit = crate::managed_update::exclusive()?;
    let exit = app.state::<crate::draft_exit::DraftExit>();
    let _clearing = exit.begin_data_clear();
    let data_dir = app.path().app_data_dir().map_err(|_| "无法读取数据目录")?;
    let connections: Vec<_> = {
        let manager = app.state::<crate::acp_client::manager::AcpManager>();
        manager
            .lock()?
            .values()
            .map(|connection| connection.life.clone())
            .collect()
    };
    for life in &connections {
        life.release_for_configuration()?;
    }
    for life in &connections {
        if !life.finished() {
            life.closed().await?;
        }
    }
    let store = app.state::<MetaStore>().inner().clone();
    if let Some(runtime) = app.try_state::<crate::node_runtime::NodeRuntimeState>() {
        runtime.reset();
    }
    tauri::async_runtime::spawn_blocking(move || {
        clear_owned(&data_dir, &store, &crate::auth::keychain_delete)
    })
    .await
    .map_err(|_| "清除未完成，请重试".to_string())??;
    // The user explicitly discarded unsent work. Never run the normal save
    // barrier with the renderer's old caches after clearing the database.
    app.state::<crate::draft_exit::DraftExit>()
        .prepare_cleared_restart(permit);
    app.request_restart();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meta_store::AgentRow;
    use std::sync::{Arc, Mutex};

    fn agent(env: Vec<(String, String)>) -> AgentRow {
        AgentRow {
            id: String::new(),
            name: "agent".to_string(),
            source: "custom".to_string(),
            command: "/bin/echo".to_string(),
            args: vec![],
            env,
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn clear_owned_removes_only_farfold_namespaces_and_resets_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path().join("data");
        for name in OWNED_DIRS {
            std::fs::create_dir_all(data.join(name).join("nested")).unwrap();
        }
        std::fs::write(data.join("registry-cache.json"), b"{}").unwrap();
        let foreign = data.join("anything-else");
        std::fs::create_dir_all(&foreign).unwrap();
        let project = directory.path().join("user-project");
        std::fs::create_dir_all(&project).unwrap();
        let store = MetaStore::open(&data.join("meta.db")).unwrap();
        let row = store
            .insert_custom_agent(agent(vec![
                (
                    "TOKEN".to_string(),
                    crate::auth::KEYCHAIN_MARKER.to_string(),
                ),
                ("PLAIN".to_string(), "value".to_string()),
            ]))
            .unwrap();
        store.set_setting("example", &serde_json::json!(1)).unwrap();

        let deleted: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&deleted);
        clear_owned(&data, &store, &move |service| {
            captured.lock().unwrap().push(service.to_string());
            Ok(())
        })
        .unwrap();

        for name in OWNED_DIRS {
            assert!(!data.join(name).exists(), "{name} must be removed");
        }
        assert!(!data.join("registry-cache.json").exists());
        assert!(foreign.exists(), "foreign directories stay");
        assert!(project.exists(), "user project folders stay");
        assert!(data.join("meta.db").exists(), "database file stays");
        assert!(store.list_agents().unwrap().is_empty());
        assert!(store.get_setting("example").unwrap().is_none());
        // Only the marked env secret is collected; plain values never are.
        assert_eq!(
            deleted.lock().unwrap().as_slice(),
            &[crate::auth::env_keychain_service(&row.id, "TOKEN")]
        );
    }

    #[test]
    fn clear_owned_deletes_an_owned_symlink_without_touching_its_target() {
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        let target = directory.path().join("external-target");
        std::fs::create_dir_all(target.join("keep")).unwrap();
        std::os::unix::fs::symlink(&target, data.join("conversations")).unwrap();
        let store = MetaStore::open(&data.join("meta.db")).unwrap();

        clear_owned(&data, &store, &|_| Ok(())).unwrap();

        assert!(!data.join("conversations").exists());
        assert!(target.join("keep").exists());
    }

    #[test]
    fn cleared_store_rejects_late_old_snapshots_until_reopened() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("meta.db");
        let store = MetaStore::open(&path).unwrap();
        let old_snapshot = serde_json::json!({"composers": {"new": {"text": "old draft"}}});
        store.set_setting("unsentWork.v1", &old_snapshot).unwrap();
        let old_writer = store.clone();
        clear_owned(directory.path(), &store, &|_| Ok(())).unwrap();

        assert!(
            old_writer
                .set_setting("unsentWork.v1", &old_snapshot)
                .is_err()
        );
        assert!(old_writer.insert_custom_agent(agent(vec![])).is_err());
        assert!(store.list_settings().unwrap().is_empty());
        assert!(store.list_agents().unwrap().is_empty());
        drop(old_writer);
        drop(store);
        let reopened = MetaStore::open(&path).unwrap();
        assert!(reopened.list_settings().unwrap().is_empty());
        reopened
            .set_setting("new", &serde_json::json!(true))
            .unwrap();
    }

    #[test]
    fn clear_owned_stops_before_namespaces_when_secret_deletion_fails() {
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path().join("data");
        std::fs::create_dir_all(data.join("conversations")).unwrap();
        let store = MetaStore::open(&data.join("meta.db")).unwrap();
        store
            .insert_custom_agent(agent(vec![(
                "TOKEN".to_string(),
                crate::auth::KEYCHAIN_MARKER.to_string(),
            )]))
            .unwrap();

        let result = clear_owned(&data, &store, &|_| Err("拒绝".to_string()));

        assert!(result.is_err());
        assert!(
            data.join("conversations").exists(),
            "a failed secret step must not proceed to owned data"
        );
        assert_eq!(
            store.list_agents().unwrap().len(),
            1,
            "metadata stays when an earlier step fails"
        );
    }

    #[test]
    fn clear_owned_reports_and_keeps_paths_that_cannot_be_removed() {
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path().join("data");
        std::fs::create_dir_all(data.join("node")).unwrap();
        // A dangling symlink target removes fine, so instead block removal by
        // making the owned path unreadable is platform-fragile; instead use a
        // file inside a directory we removed write permission from.
        let locked = data.join("conversations");
        std::fs::create_dir_all(&locked).unwrap();
        std::fs::write(locked.join("f"), b"x").unwrap();
        let mut permissions = std::fs::metadata(&locked).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&locked, permissions).unwrap();
        let store = MetaStore::open(&data.join("meta.db")).unwrap();

        store
            .set_setting("retained", &serde_json::json!(true))
            .unwrap();

        let result = clear_owned(&data, &store, &|_| Ok(()));

        if let Ok(metadata) = std::fs::metadata(&locked) {
            let mut permissions = metadata.permissions();
            #[allow(clippy::permissions_set_readonly_false)]
            permissions.set_readonly(false);
            let _ = std::fs::set_permissions(&locked, permissions);
        }
        match result {
            Err(message) => {
                assert!(message.contains("conversations"), "{message}");
                assert!(store.get_setting("missing").unwrap().is_none());
                assert_eq!(
                    store.get_setting("retained").unwrap(),
                    Some(serde_json::json!(true))
                );
            }
            // Some filesystems still delete readonly directories' contents;
            // success is acceptable only if the path itself is gone.
            Ok(()) => assert!(!locked.exists()),
        }
    }
}
