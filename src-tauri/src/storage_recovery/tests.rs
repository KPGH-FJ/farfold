use super::error::IssueKind;
use super::*;
use serde_json::json;
use std::fs;

#[test]
fn recovery_gate_rejects_every_existing_non_recovery_command() {
    let source = include_str!("../lib.rs");
    let commands = source
        .split("tauri::generate_handler![")
        .nth(1)
        .unwrap()
        .split("];")
        .next()
        .unwrap();
    let mut checked = 0;
    for line in commands.lines() {
        let line = line.trim().trim_end_matches(',');
        if let Some(command) = line.rsplit("::").next().filter(|_| line.contains("::")) {
            let recovery = command.starts_with("storage_recovery_");
            assert_eq!(command_allowed(false, command), recovery, "{command}");
            assert!(command_allowed(true, command));
            checked += 1;
        }
    }
    assert!(checked > 100);
    assert!(!command_allowed(false, "storage_recovery_reset"));
    assert!(!command_allowed(false, "app_drafts_ready"));
    assert!(
        source
            .find("state.allows(invoke.message.command())")
            .unwrap()
            < source.find("tauri::generate_handler![").unwrap()
    );
}

#[test]
fn missing_previously_observed_database_is_never_recreated() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("farfold.sqlite3");
    drop(MetaStore::open(&path).unwrap());
    let state = StorageRecoveryState::new(path.clone());
    fs::rename(&path, dir.path().join("original.sqlite3")).unwrap();
    let mut recovery = state.0.lock().unwrap();
    let error = recovery.open().err().unwrap();
    assert_eq!(StorageIssue::from_receipt(&error).kind, IssueKind::Missing);
    assert!(!path.exists());
    assert!(dir.path().join("original.sqlite3").exists());
}

#[test]
fn file_created_during_a_failed_attempt_is_remembered_before_retry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("farfold.sqlite3");
    let state = StorageRecoveryState::new(path.clone());
    // Simulates a previously unseen store with a failure in required defaults.
    let store = MetaStore::open(&path).unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute(
            "INSERT INTO settings(key,value) VALUES ('lifemodel.master','{broken')",
            [],
        )
        .unwrap();
    drop(connection);
    drop(store);
    let mut recovery = state.0.lock().unwrap();
    assert!(recovery.open().is_err());
    fs::rename(&path, dir.path().join("preserved.sqlite3")).unwrap();
    assert_eq!(
        StorageIssue::from_receipt(&recovery.open().err().unwrap()).kind,
        IssueKind::Missing
    );
    assert!(!path.exists());
}

#[test]
fn corrupt_database_and_side_files_are_retained_and_exported_as_unverified() {
    let dir = tempfile::tempdir().unwrap();
    let output = tempfile::tempdir().unwrap();
    let path = dir.path().join("farfold.sqlite3");
    let data = [
        (
            "farfold.sqlite3",
            b"not a database; keep original".as_slice(),
        ),
        ("farfold.sqlite3-wal", b"keep wal".as_slice()),
        ("farfold.sqlite3-shm", b"keep shm".as_slice()),
        ("farfold.sqlite3-journal", b"keep journal".as_slice()),
    ];
    for (name, bytes) in data {
        fs::write(dir.path().join(name), bytes).unwrap();
    }
    let error = MetaStore::open(&path).err().unwrap();
    assert_eq!(StorageIssue::from_receipt(&error).kind, IssueKind::Corrupt);
    let receipt = export::export(&path, None, output.path()).unwrap();
    assert_eq!(receipt.kind, "unverifiedFiles");
    for (name, bytes) in data {
        assert_eq!(fs::read(dir.path().join(name)).unwrap(), bytes);
        assert_eq!(
            fs::read(Path::new(&receipt.path).join(name)).unwrap(),
            bytes
        );
    }
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(Path::new(&receipt.path).join("recovery.json")).unwrap())
            .unwrap();
    assert_eq!(manifest["kind"], "unverifiedFiles");
    assert_eq!(manifest["files"].as_array().unwrap().len(), 4);
}

#[test]
fn a_truncated_existing_file_is_not_initialized_as_an_empty_store() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("farfold.sqlite3");
    fs::write(&path, []).unwrap();
    let error = MetaStore::open(&path).err().unwrap();
    assert_eq!(StorageIssue::from_receipt(&error).kind, IssueKind::Corrupt);
    assert_eq!(fs::read(&path).unwrap(), Vec::<u8>::new());
}

#[test]
fn online_export_includes_committed_wal_and_preserves_invalid_draft_text() {
    let dir = tempfile::tempdir().unwrap();
    let output = tempfile::tempdir().unwrap();
    let path = dir.path().join("farfold.sqlite3");
    let store = MetaStore::open(&path).unwrap();
    let raw = "{invalid JSON: original draft must remain byte exact";
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .pragma_update(None, "wal_autocheckpoint", 0)
        .unwrap();
    connection
        .execute(
            "INSERT INTO settings(key,value) VALUES ('unsentWork.v1',?1)",
            [raw],
        )
        .unwrap();
    store
        .set_setting("latest", &json!({"value":"committed in WAL"}))
        .unwrap();
    assert!(
        dir.path()
            .join("farfold.sqlite3-wal")
            .metadata()
            .unwrap()
            .len()
            > 0
    );
    let receipt = export::export(&path, Some(&store), output.path()).unwrap();
    assert_eq!(receipt.kind, "snapshot");
    let copy =
        rusqlite::Connection::open(Path::new(&receipt.path).join("farfold.sqlite3")).unwrap();
    let retained: String = copy
        .query_row(
            "SELECT value FROM settings WHERE key='unsentWork.v1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retained, raw);
    let latest: String = copy
        .query_row("SELECT value FROM settings WHERE key='latest'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&latest).unwrap(),
        json!({"value":"committed in WAL"})
    );
    assert!(store.get_setting("unsentWork.v1").is_err());
    assert_eq!(
        connection
            .query_row::<String, _, _>(
                "SELECT value FROM settings WHERE key='unsentWork.v1'",
                [],
                |row| row.get(0)
            )
            .unwrap(),
        raw
    );
    let second = export::export(&path, Some(&store), output.path()).unwrap();
    assert_ne!(second.path, receipt.path);
    assert!(Path::new(&receipt.path).join("recovery.json").exists());
}

#[test]
fn failed_copy_never_acknowledges_a_complete_export_or_touches_the_source() {
    let dir = tempfile::tempdir().unwrap();
    let output = tempfile::tempdir().unwrap();
    let path = dir.path().join("farfold.sqlite3");
    fs::write(&path, b"original").unwrap();
    fs::create_dir(dir.path().join("farfold.sqlite3-wal")).unwrap();
    let failure = export::export(&path, None, output.path()).unwrap_err();
    let partial = PathBuf::from(failure.partial_path.unwrap());
    assert_eq!(partial.parent(), Some(output.path()));
    assert!(partial.is_dir());
    assert!(!partial.join("recovery.json").exists());
    assert_eq!(fs::read(&path).unwrap(), b"original");
    for entry in fs::read_dir(output.path()).unwrap() {
        assert!(!entry.unwrap().path().join("recovery.json").exists());
    }
}

#[cfg(unix)]
#[test]
fn read_only_database_is_reported_before_initialization_changes_it() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("farfold.sqlite3");
    drop(MetaStore::open(&path).unwrap());
    let original = fs::read(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
    let error = MetaStore::open(&path).err().unwrap();
    assert_eq!(StorageIssue::from_receipt(&error).kind, IssueKind::ReadOnly);
    assert_eq!(fs::read(&path).unwrap(), original);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(MetaStore::open(&path).is_ok());
}

#[test]
fn extended_readonly_recovery_errors_do_not_claim_filesystem_permissions() {
    for (code, kind) in [
        (rusqlite::ffi::SQLITE_READONLY_DBMOVED, IssueKind::Missing),
        (rusqlite::ffi::SQLITE_READONLY_RECOVERY, IssueKind::Unknown),
        (rusqlite::ffi::SQLITE_READONLY_ROLLBACK, IssueKind::Unknown),
    ] {
        let receipt = sqlite_receipt(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(code),
            None,
        ));
        assert_eq!(StorageIssue::from_receipt(&receipt).kind, kind);
    }
}

#[test]
fn retry_failure_keeps_the_gate_closed_and_parallel_retry_installs_only_once() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("farfold.sqlite3");
    fs::write(&path, b"broken original").unwrap();
    let state = Arc::new(StorageRecoveryState::new(path.clone()));
    let installed = Arc::new(AtomicUsize::new(0));
    state.0.lock().unwrap().initialize(|_| {
        installed.fetch_add(1, Ordering::SeqCst);
        Ok(())
    });
    assert_eq!(installed.load(Ordering::SeqCst), 0);
    assert!(!state.allows("settings_set"));
    assert_eq!(fs::read(&path).unwrap(), b"broken original");
    // This test's external repair preserves the original under a new fixture name.
    fs::rename(&path, dir.path().join("preserved-original")).unwrap();
    drop(MetaStore::open(&path).unwrap());
    let workers: Vec<_> = (0..4)
        .map(|_| {
            let state = state.clone();
            let installed = installed.clone();
            std::thread::spawn(move || {
                state.0.lock().unwrap().initialize(|_| {
                    installed.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    assert_eq!(installed.load(Ordering::SeqCst), 1);
    assert!(state.allows("settings_set"));
    assert_eq!(
        fs::read(dir.path().join("preserved-original")).unwrap(),
        b"broken original"
    );
}

#[test]
fn run_event_and_menu_paths_do_not_require_an_uninitialized_meta_store() {
    // These callbacks bypass IPC. Their required non-storage state remains
    // registered before storage initialization; native notifications start after it.
    for source in [
        include_str!("../app_menu.rs"),
        include_str!("../macos_quit.rs"),
        include_str!("../draft_exit.rs"),
        include_str!("../browser_workspace.rs"),
    ] {
        assert!(!source.contains("state::<MetaStore>"));
        assert!(!source.contains("state::<crate::meta_store::MetaStore>"));
    }
    let lib = include_str!("../lib.rs");
    let initialize = lib
        .find("storage_recovery::initialize(app.handle())")
        .unwrap();
    for registered in [
        "draft_exit::DraftExit::default()",
        "pty::PtyManager::default()",
        "AcpManager::new(",
        "AgentCatalog::new(",
        "NodeRuntimeState::new(",
    ] {
        assert!(lib.find(registered).unwrap() < initialize);
    }
}

#[test]
fn a_failed_manifest_promotion_keeps_incomplete_material_without_a_completion_file() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("farfold.sqlite3"), b"retained partial copy").unwrap();
    fs::create_dir(dir.path().join("recovery.json")).unwrap();
    let result = export::complete_manifest(dir.path(), &json!({"version":1,"kind":"snapshot"}));
    assert!(result.is_err());
    assert!(dir.path().join("recovery.incomplete.json").is_file());
    assert!(!dir.path().join("recovery.json").is_file());
    assert_eq!(
        fs::read(dir.path().join("farfold.sqlite3")).unwrap(),
        b"retained partial copy"
    );
}

#[test]
fn structural_damage_after_a_valid_sqlite_header_is_rejected_without_repairing_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("farfold.sqlite3");
    drop(MetaStore::open(&path).unwrap());
    let mut bytes = fs::read(&path).unwrap();
    // The first b-tree page begins immediately after SQLite's 100-byte header.
    bytes[100] = 0xff;
    fs::write(&path, &bytes).unwrap();
    let error = MetaStore::open(&path).err().unwrap();
    assert_eq!(StorageIssue::from_receipt(&error).kind, IssueKind::Corrupt);
    assert_eq!(fs::read(&path).unwrap(), bytes);
}

#[test]
fn orphaned_wal_prevents_empty_initialization_and_can_be_preserved_on_its_own() {
    let dir = tempfile::tempdir().unwrap();
    let output = tempfile::tempdir().unwrap();
    let path = dir.path().join("farfold.sqlite3");
    let wal = dir.path().join("farfold.sqlite3-wal");
    fs::write(&wal, b"last remaining recovery material").unwrap();
    let state = StorageRecoveryState::new(path.clone());
    state.0.lock().unwrap().initialize(|_| Ok(()));
    assert!(
        !state.allows("settings_set"),
        "a side file is evidence of prior storage"
    );
    assert!(
        !path.exists(),
        "must not create a blank database over retained side files"
    );
    assert_eq!(fs::read(&wal).unwrap(), b"last remaining recovery material");
    assert!(MetaStore::open(&path).is_err());
    assert!(!path.exists());
    let receipt = export::export(&path, None, output.path()).unwrap();
    assert_eq!(receipt.kind, "unverifiedFiles");
    assert!(!Path::new(&receipt.path).join("farfold.sqlite3").exists());
    assert_eq!(
        fs::read(Path::new(&receipt.path).join("farfold.sqlite3-wal")).unwrap(),
        b"last remaining recovery material"
    );
}

#[test]
fn orphaned_shm_and_journal_also_block_creation_but_similarly_named_files_do_not() {
    for suffix in ["-shm", "-journal"] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("farfold.sqlite3");
        fs::write(dir.path().join(format!("farfold.sqlite3{suffix}")), b"keep").unwrap();
        assert!(MetaStore::open(&path).is_err());
        assert!(!path.exists());
    }
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("farfold.sqlite3-wal-other"),
        b"unrelated user file",
    )
    .unwrap();
    let path = dir.path().join("farfold.sqlite3");
    assert!(MetaStore::open(&path).is_ok());
    assert_eq!(
        fs::read(dir.path().join("farfold.sqlite3-wal-other")).unwrap(),
        b"unrelated user file"
    );
}
