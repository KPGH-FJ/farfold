//! Whole-program history, owned removal and retry using only temporary data.
use super::*;
#[cfg(unix)]
use std::os::unix::fs::symlink;

fn entry_name() -> &'static str {
    if cfg!(windows) { "entry.exe" } else { "entry" }
}

fn external_interpreter() -> String {
    if cfg!(windows) {
        std::env::current_exe().unwrap().display().to_string()
    } else {
        "/bin/sh".into()
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    data: PathBuf,
    store: MetaStore,
    old: AgentRow,
    current: AgentRow,
    old_root: PathBuf,
    current_root: PathBuf,
    old_item: Installation,
    old_path: PathBuf,
    kept_session: crate::meta_store::SessionRow,
}

impl Fixture {
    fn new(script: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().canonicalize().unwrap();
        let store = MetaStore::open(&data.join("meta.db")).unwrap();
        let old_root = data.join("agents/whole-history/old");
        let current_root = data.join("agents/whole-history/current");
        for root in [&old_root, &current_root] {
            std::fs::create_dir_all(root).unwrap();
            let program = root.join(entry_name());
            std::fs::write(&program, "#!/bin/sh\nexit 0\n").unwrap();
            // These files exercise metadata and removal only; they are not launched.
            crate::process_platform::set_executable(&program).unwrap();
        }
        #[cfg(unix)]
        let alias = {
            let alias = data.join("old-user-alias");
            symlink(old_root.join(entry_name()), &alias).unwrap();
            alias
        };
        #[cfg(windows)]
        let alias = old_root.join(entry_name());
        let old = AgentRow {
            id: "whole-history".into(),
            name: "Fixture".into(),
            source: "registry".into(),
            command: if script {
                external_interpreter()
            } else {
                alias.display().to_string()
            },
            args: if script {
                vec![alias.display().to_string(), "--acp".into()]
            } else {
                vec!["--acp".into()]
            },
            env: vec![
                ("KEPT_CHOICE".into(), "unchanged".into()),
                ("KEY_REF".into(), "__keychain__".into()),
            ],
            version: Some("1.0.0".into()),
            handshake: None,
            created_at: 1,
            updated_at: 1,
        };
        store.insert_agent(&old).unwrap();
        record(&store, &old, &old_root).unwrap();
        let old_item = read(&store).unwrap().remove(0);
        let mut current = old.clone();
        current.command = current_root.join(entry_name()).display().to_string();
        current.args = vec!["--new-acp".into()];
        current.version = Some("2.0.0".into());
        commit_candidate(&store, &current, Some(&old), Some(&current_root)).unwrap();
        let current = store.get_agent(&old.id).unwrap().unwrap();
        let kept_session = crate::meta_store::SessionRow {
            id: "kept-session".into(),
            agent_id: old.id.clone(),
            cwd: data.display().to_string(),
            native_session_id: Some("kept-native-id".into()),
            title: Some("kept-title".into()),
            config_options: Some(serde_json::json!({"model":"chosen","thought_level":"ultra"})),
            pinned: true,
            archived: false,
            created_at: 1,
            updated_at: 1,
        };
        store.upsert_session(&kept_session).unwrap();
        store
            .set_setting(
                "kept-draft",
                &serde_json::json!({"text":"original-unsent-draft","choices":["keep"]}),
            )
            .unwrap();
        Self {
            _dir: dir,
            data,
            store,
            old,
            current,
            old_root,
            current_root,
            old_item,
            old_path: alias,
            kept_session,
        }
    }

    fn cold_store(&self) -> MetaStore {
        MetaStore::open(&self.data.join("meta.db")).unwrap()
    }

    fn assert_current_kept(&self, store: &MetaStore) {
        assert_eq!(
            store.get_agent(&self.current.id).unwrap().unwrap(),
            self.current
        );
        assert!(self.current_root.join(entry_name()).exists());
        assert_eq!(
            store.get_session("kept-session").unwrap().unwrap(),
            self.kept_session
        );
        assert_eq!(
            store.get_setting("kept-draft").unwrap().unwrap(),
            serde_json::json!({"text":"original-unsent-draft","choices":["keep"]})
        );
        #[cfg(unix)]
        assert!(
            std::fs::symlink_metadata(&self.old_path)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    fn assert_no_old_history(&self, store: &MetaStore, id: &str) {
        let inventory = inventory_with_discovered(store, vec![], id).unwrap();
        assert!(
            !inventory.iter().any(|item| {
                item.id == self.old_item.id
                    || (item.command == self.old.command && item.args == self.old.args)
                    || item.path == self.old_root.display().to_string()
            }),
            "uninstalled receipt or exact original launch returned from cold inventory"
        );
        assert!(
            !inventory.iter().any(|item| {
                program_under_root(&item.command, &self.old_root)
                    || item
                        .args
                        .iter()
                        .any(|arg| program_under_root(arg, &self.old_root))
                    || program_under_root(&item.path, &self.old_root)
            }),
            "uninstalled whole program returned from cold inventory"
        );
    }
}

#[test]
fn whole_history_uninstall_does_not_resurrect_binary_launch() {
    assert_whole_history_removed(false);
}

#[test]
fn whole_history_uninstall_does_not_resurrect_absolute_script_launch() {
    assert_whole_history_removed(true);
}

fn assert_whole_history_removed(script: bool) {
    let f = Fixture::new(script);
    let previous = f
        .store
        .get_setting("installPrevious.whole-history")
        .unwrap()
        .unwrap();
    assert_eq!(previous["command"], f.old.command);
    assert_eq!(previous["args"], serde_json::json!(f.old.args));
    remove_installed(&f.store, &f.data, &f.old.id, &f.old_item.id).unwrap();
    assert!(!f.old_root.exists());
    let cold = f.cold_store();
    f.assert_current_kept(&cold);
    f.assert_no_old_history(&cold, &f.old.id);
    let mut wanted = previous;
    wanted["command"] = serde_json::Value::Null;
    wanted["args"] = serde_json::Value::Null;
    assert_eq!(
        cold.get_setting("installPrevious.whole-history")
            .unwrap()
            .unwrap(),
        wanted
    );
    let current = cold.get_agent(&f.old.id).unwrap().unwrap();
    commit_candidate(&cold, &current, Some(&current), None).unwrap();
    f.assert_no_old_history(&cold, &f.old.id);
}

#[test]
fn whole_history_uninstall_clears_only_deleted_root_across_agents_and_raw_entries() {
    let f = Fixture::new(true);
    let alias = f.old_path.display().to_string();
    let mut items = read(&f.store).unwrap();
    let mut raw = f.old_item.clone();
    raw.id = "other:raw-script".into();
    raw.agent_id = "other".into();
    raw.managed_root = None;
    raw.source = "unverified".into();
    // Match a persisted whole-launch fallback: its external interpreter path
    // alone is unrelated; only the absolute script argument uses the old root.
    raw.path = raw.command.clone();
    items.push(raw);
    write(&f.store, &items).unwrap();
    let old_other = serde_json::json!({"command":external_interpreter(),"args":[alias,"--acp"],"source":"kept-source","version":"kept-version","programPath":"/unrelated/external"});
    f.store
        .set_setting("installPrevious.other", &old_other)
        .unwrap();
    let untouched =
        serde_json::json!({"command":"/unrelated/entry","args":["--acp"],"extra":{"path":alias}});
    f.store
        .set_setting("installPrevious.untouched", &untouched)
        .unwrap();
    f.store
        .set_setting("user-setting", &serde_json::json!({"command":alias}))
        .unwrap();
    // A registered launch still using the owned root must block removal.
    let mut active = f.old.clone();
    active.id = "other".into();
    f.store.insert_agent(&active).unwrap();
    assert!(remove_installed(&f.store, &f.data, &f.old.id, &f.old_item.id).is_err());
    assert!(f.old_root.exists());
    assert_eq!(
        f.store
            .get_setting("installPrevious.other")
            .unwrap()
            .unwrap(),
        old_other
    );
    active.command = external_interpreter();
    active.args.clear();
    f.store.replace_agent_launch(&active).unwrap();
    let active = f.store.get_agent("other").unwrap().unwrap();
    remove_installed(&f.store, &f.data, &f.old.id, &f.old_item.id).unwrap();
    let cold = f.cold_store();
    f.assert_no_old_history(&cold, "other");
    assert_eq!(cold.get_agent("other").unwrap().unwrap(), active);
    let mut cleared = old_other;
    cleared["command"] = serde_json::Value::Null;
    cleared["args"] = serde_json::Value::Null;
    assert_eq!(
        cold.get_setting("installPrevious.other").unwrap().unwrap(),
        cleared
    );
    assert_eq!(
        cold.get_setting("installPrevious.untouched")
            .unwrap()
            .unwrap(),
        untouched
    );
    assert_eq!(
        cold.get_setting("user-setting").unwrap().unwrap(),
        serde_json::json!({"command":alias})
    );
    f.assert_current_kept(&cold);
}

#[test]
fn whole_history_uninstall_snapshot_failure_is_atomic_and_retryable() {
    assert_whole_history_retry("installPrevious.whole-history");
}

#[test]
fn whole_history_uninstall_receipt_failure_is_retryable_after_snapshot_save() {
    assert_whole_history_retry(KEY);
}

fn assert_whole_history_retry(failing_key: &str) {
    let f = Fixture::new(false);
    let before = f
        .store
        .get_setting("installPrevious.whole-history")
        .unwrap()
        .unwrap();
    let connection = rusqlite::Connection::open(f.data.join("meta.db")).unwrap();
    connection.execute_batch(&format!("CREATE TRIGGER removal_failure BEFORE UPDATE ON settings WHEN NEW.key = '{failing_key}' BEGIN SELECT RAISE(ABORT, 'fixture'); END;")).unwrap();
    assert!(remove_installed(&f.store, &f.data, &f.old.id, &f.old_item.id).is_err());
    assert!(!f.old_root.exists());
    let cold = f.cold_store();
    assert!(
        read(&cold)
            .unwrap()
            .iter()
            .any(|item| item.id == f.old_item.id)
    );
    assert!(owned_root(&f.old_item, &f.data).is_ok());
    let previous = cold
        .get_setting("installPrevious.whole-history")
        .unwrap()
        .unwrap();
    if failing_key != KEY {
        assert_eq!(previous, before);
    } else {
        assert!(previous["command"].is_null() && previous["args"].is_null());
    }
    f.assert_current_kept(&cold);
    connection
        .execute_batch("DROP TRIGGER removal_failure;")
        .unwrap();
    remove_installed(&cold, &f.data, &f.old.id, &f.old_item.id).unwrap();
    let final_store = f.cold_store();
    assert!(
        !read(&final_store)
            .unwrap()
            .iter()
            .any(|item| item.id == f.old_item.id)
    );
    f.assert_no_old_history(&final_store, &f.old.id);
    f.assert_current_kept(&final_store);
}
