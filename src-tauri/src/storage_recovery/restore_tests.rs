use super::{restore::*, *};
use serde_json::json;
use std::{collections::BTreeMap, fs};
fn saved(dir: &Path, text: &str) -> (PathBuf, MetaStore) {
    let path = dir.canonicalize().unwrap().join("farfold.sqlite3");
    let store = MetaStore::open(&path).unwrap();
    store
        .set_setting(KEYS[0], &json!({"version":1,"text":text}))
        .unwrap();
    store
        .set_setting(KEYS[1], &json!({"version":1,"completed":[]}))
        .unwrap();
    (path, store)
}

fn startup_restore_fixture(
    source: &Path,
    target: &Path,
) -> (StorageRecoveryState, MetaStore, RestorePreview) {
    let (source_path, source_store) = saved(source, "candidate");
    let candidate: serde_json::Value = serde_json::from_str(include_str!(
        "../../../src/runtime/fixtures/storage-restore-v1.json"
    ))
    .unwrap();
    for key in KEYS {
        source_store.set_setting(key, &candidate[key]).unwrap();
    }
    drop(source_store);
    let (path, store) = saved(target, "original");
    store
        .set_setting(KEYS[0], &json!({"version":99,"text":"original"}))
        .unwrap();
    drop(store);

    let recovery = StorageRecoveryState::new(path);
    let mut store = None;
    let preview = {
        let mut state = recovery.0.lock().unwrap();
        state.initialize(|opened| {
            store = Some(opened);
            Ok(())
        });
        assert!(state.status.ready && !state.editable);
        state
            .restore
            .preview(store.as_ref().unwrap(), &source_path)
            .unwrap()
    };
    (recovery, store.unwrap(), preview)
}

#[test]
fn a_startup_record_restore_cannot_write_after_exit_admission() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let copies = tempfile::tempdir().unwrap();
    let (state, store, preview) = startup_restore_fixture(source.path(), target.path());
    let exit = state.begin_change().unwrap();
    exit.reserve_exit().unwrap();
    drop(exit);

    let result =
        state.apply_startup_restore(Some(&store), &preview.id, &[KEYS[0].into()], copies.path());
    let error = result.as_ref().err().map(|failure| failure.code);
    let current = store.get_setting(KEYS[0]).unwrap();
    let backups = fs::read_dir(copies.path()).unwrap().count();
    assert_eq!(
        (
            error,
            current.as_ref().and_then(|value| value["version"].as_u64()),
            backups
        ),
        (Some("unavailable"), Some(99), 0),
    );
    assert_eq!(current, Some(json!({"version":99,"text":"original"})));
}

#[test]
fn a_startup_record_restore_blocks_exit_until_the_receipt_and_releases_admission() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let copies = tempfile::tempdir().unwrap();
    let (state, store, preview) = startup_restore_fixture(source.path(), target.path());
    let worktrees = crate::worktrees::Worktrees::default();
    let blocked_worktree = worktrees.seal_exit(None, false).unwrap();
    assert!(
        state
            .admit_startup_exit(|| worktrees.seal_exit(Some(&store), false))
            .is_err()
    );
    drop(blocked_worktree);

    let receipt = std::thread::scope(|scope| {
        // Hold the real recovery mutex so apply cannot reach the backup while
        // the main-thread exit admission is checked.
        let locked = state.0.lock().unwrap();
        let applying = scope.spawn(|| {
            state.apply_startup_restore(Some(&store), &preview.id, &[KEYS[0].into()], copies.path())
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while state.1.load(Ordering::SeqCst) == AVAILABLE {
            assert!(
                std::time::Instant::now() < deadline,
                "restore never admitted"
            );
            std::thread::yield_now();
        }
        assert_eq!(state.1.load(Ordering::SeqCst), CHANGING);
        assert!(
            state
                .admit_startup_exit::<()>(|| panic!("exit crossed active recovery"))
                .is_err()
        );
        assert_eq!(fs::read_dir(copies.path()).unwrap().count(), 0);
        drop(locked);
        applying.join().unwrap().unwrap()
    });
    assert_eq!(receipt.id, preview.id);
    assert_eq!(
        store.get_setting(KEYS[0]).unwrap(),
        Some(serde_json::from_str(preview.values[KEYS[0]].as_deref().unwrap()).unwrap()),
    );
    let backup =
        MetaStore::open(&Path::new(&receipt.protected_path).join("farfold.sqlite3")).unwrap();
    assert_eq!(
        backup.get_setting(KEYS[0]).unwrap(),
        Some(json!({"version":99,"text":"original"})),
    );
    assert_eq!(fs::read_dir(copies.path()).unwrap().count(), 1);
    assert!(
        state
            .admit_startup_exit(|| worktrees.seal_exit(Some(&store), false))
            .is_ok()
    );
}

#[test]
fn preview_is_read_only_and_restores_captured_bytes_not_a_later_replaced_file() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let copies = tempfile::tempdir().unwrap();
    let (source_path, source_store) = saved(source.path(), "candidate");
    let (path, store) = saved(target.path(), "original");
    drop(source_store);
    let before = fs::read(&source_path).unwrap();
    let mut state = RestoreState::default();
    let preview = state.preview(&store, &source_path).unwrap();
    assert_eq!(fs::read(&source_path).unwrap(), before);
    assert_eq!(
        store.get_setting(KEYS[0]).unwrap().unwrap()["text"],
        "original"
    );
    fs::write(&source_path, b"source changed after preview").unwrap();
    let receipt = state
        .apply(&store, &path, &preview.id, &[KEYS[0].into()], copies.path())
        .unwrap();
    assert_eq!(
        store.get_setting(KEYS[0]).unwrap().unwrap()["text"],
        "candidate"
    );
    let protected =
        MetaStore::open(&Path::new(&receipt.protected_path).join("farfold.sqlite3")).unwrap();
    assert_eq!(
        protected.get_setting(KEYS[0]).unwrap().unwrap()["text"],
        "original"
    );
    let again = state
        .apply(&store, &path, &preview.id, &[KEYS[0].into()], copies.path())
        .unwrap();
    assert_eq!(again.protected_path, receipt.protected_path);
    assert_eq!(fs::read_dir(copies.path()).unwrap().count(), 1);
    assert_eq!(state.receipt(&preview.id).unwrap().keys, vec![KEYS[0]]);
}
#[test]
fn a_change_to_either_startup_key_after_preview_refuses_the_whole_restore() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let copies = tempfile::tempdir().unwrap();
    let (source_path, _) = saved(source.path(), "candidate");
    let (path, store) = saved(target.path(), "original");
    let mut state = RestoreState::default();
    let preview = state.preview(&store, &source_path).unwrap();
    store
        .set_setting(KEYS[1], &json!({"version":1,"changed":true}))
        .unwrap();
    let error = state
        .apply(&store, &path, &preview.id, &[KEYS[0].into()], copies.path())
        .unwrap_err();
    assert_eq!(error.code, "changed");
    assert!(error.materials_complete);
    assert_eq!(
        store.get_setting(KEYS[0]).unwrap().unwrap()["text"],
        "original"
    );
    assert!(state.receipt(&preview.id).is_none());
}
#[test]
fn missing_backup_location_unknown_key_and_future_candidate_do_not_write() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let copies = tempfile::tempdir().unwrap();
    let (source_path, candidate) = saved(source.path(), "candidate");
    let (path, store) = saved(target.path(), "original");
    let mut state = RestoreState::default();
    let preview = state.preview(&store, &source_path).unwrap();
    assert_eq!(
        state
            .apply(
                &store,
                &path,
                &preview.id,
                &["credentials".into()],
                copies.path()
            )
            .unwrap_err()
            .code,
        "selection"
    );
    assert_eq!(
        state
            .apply(
                &store,
                &path,
                &preview.id,
                &[KEYS[0].into()],
                &copies.path().join("missing")
            )
            .unwrap_err()
            .code,
        "backup"
    );
    candidate
        .set_setting(KEYS[0], &json!({"version":999}))
        .unwrap();
    let preview = state.preview(&store, &source_path).unwrap();
    assert_eq!(
        state
            .apply(&store, &path, &preview.id, &[KEYS[0].into()], copies.path())
            .unwrap_err()
            .code,
        "unsupported"
    );
    assert_eq!(
        store.get_setting(KEYS[0]).unwrap().unwrap()["text"],
        "original"
    );
    assert_eq!(fs::read_dir(copies.path()).unwrap().count(), 0);
}
#[test]
fn a_failure_on_the_second_key_rolls_back_both_and_retains_a_confirmed_original_copy() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let copies = tempfile::tempdir().unwrap();
    let (source_path, _) = saved(source.path(), "candidate");
    let (path, store) = saved(target.path(), "original");
    let mut state = RestoreState::default();
    let preview = state.preview(&store, &source_path).unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("CREATE TRIGGER refuse_restore BEFORE UPDATE ON settings WHEN NEW.key='agentSetup.v1' BEGIN SELECT RAISE(ABORT, 'fixture save failure'); END;").unwrap();
    let before = store.restore_values().unwrap();
    let error = state
        .apply(
            &store,
            &path,
            &preview.id,
            &KEYS.map(String::from),
            copies.path(),
        )
        .unwrap_err();
    assert!(error.materials_complete);
    assert_eq!(store.restore_values().unwrap(), before);
}
#[cfg(unix)]
#[test]
fn a_symbolic_link_candidate_is_rejected_without_following_it() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let (source_path, _) = saved(source.path(), "candidate");
    let (_, store) = saved(target.path(), "original");
    let link = source.path().join("linked.sqlite3");
    std::os::unix::fs::symlink(source_path, &link).unwrap();
    assert_eq!(
        RestoreState::default()
            .preview(&store, &link)
            .unwrap_err()
            .code,
        "unsupported"
    );
}
#[test]
fn direct_restore_rejects_keys_outside_the_two_allowed_records() {
    let dir = tempfile::tempdir().unwrap();
    let (_, store) = saved(dir.path(), "original");
    let baseline = store.restore_values().unwrap();
    assert!(
        store
            .restore_startup_values(
                &baseline,
                &BTreeMap::from([("credential".into(), "null".into())])
            )
            .is_err()
    );
    assert_eq!(store.restore_values().unwrap(), baseline);
}
#[test]
fn a_valid_candidate_named_snapshot_sqlite3_does_not_collide_with_private_snapshot() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let (source_path, candidate) = saved(source.path(), "candidate");
    drop(candidate);
    let renamed = source_path.with_file_name("snapshot.sqlite3");
    fs::rename(source_path, &renamed).unwrap();
    let (_, store) = saved(target.path(), "original");
    assert!(RestoreState::default().preview(&store, &renamed).is_ok());
}
#[test]
fn duplicate_candidate_key_rows_are_not_silently_selected() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let (source_path, candidate) = saved(source.path(), "candidate");
    drop(candidate);
    let connection = rusqlite::Connection::open(&source_path).unwrap();
    connection.execute_batch("ALTER TABLE settings RENAME TO old_settings; CREATE TABLE settings(key TEXT,value TEXT); INSERT INTO settings SELECT key,value FROM old_settings; INSERT INTO settings SELECT key,value FROM old_settings; DROP TABLE old_settings;").unwrap();
    drop(connection);
    let (_, store) = saved(target.path(), "original");
    assert!(
        RestoreState::default()
            .preview(&store, &source_path)
            .is_err()
    );
}
#[test]
fn valid_dual_record_fixture_restores_once_and_preserves_other_settings_and_original_copy() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let copies = tempfile::tempdir().unwrap();
    let (source_path, candidate) = saved(source.path(), "old-fixture");
    let (path, store) = saved(target.path(), "original");
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../src/runtime/fixtures/storage-restore-v1.json"
    ))
    .unwrap();
    // Shared TS/Rust retention contract only. Coordinate validation remains in
    // parseDraftSnapshot/parseFeedbackAnchor before the recovery apply request.
    let feedback = &fixture["unsentWork.v1"]["feedback"]["fixture-thread"];
    assert_eq!(feedback.as_object().unwrap().len(), 6);
    assert_eq!(
        feedback["area.png"]["anchor"],
        json!({
            "kind":"image-area", "space":"display-oriented-v1",
            "left":1, "top":200000, "right":999999, "bottom":800001
        })
    );
    assert_eq!(
        feedback["area.pdf"]["anchor"],
        json!({
            "kind":"pdf-area", "space":"display-oriented-v1", "page":2, "pageCount":3,
            "left":100001, "top":2, "right":700000, "bottom":1000000
        })
    );
    for key in KEYS {
        candidate.set_setting(key, &fixture[key]).unwrap();
    }
    candidate
        .set_setting("credential", &json!("never-import-fixture"))
        .unwrap();
    store
        .set_setting("credential", &json!("keep-target-fixture"))
        .unwrap();
    assert!(
        fs::metadata(format!("{}-wal", source_path.display()))
            .unwrap()
            .len()
            > 0
    );
    let originals = store.restore_values().unwrap();
    let materials = existing_material(&source_path).unwrap();
    let bytes = materials
        .iter()
        .map(|p| fs::read(p).unwrap())
        .collect::<Vec<_>>();
    let mut restore = RestoreState::default();
    let preview = restore.preview(&store, &source_path).unwrap();
    assert_eq!(existing_material(&source_path).unwrap(), materials);
    assert_eq!(
        materials
            .iter()
            .map(|p| fs::read(p).unwrap())
            .collect::<Vec<_>>(),
        bytes
    );
    let receipt = restore
        .apply(
            &store,
            &path,
            &preview.id,
            &KEYS.map(String::from),
            copies.path(),
        )
        .unwrap();
    let mut reversed = KEYS.map(String::from);
    reversed.reverse();
    assert_eq!(
        restore
            .apply(&store, &path, &preview.id, &reversed, copies.path())
            .unwrap()
            .protected_path,
        receipt.protected_path
    );
    assert_eq!(fs::read_dir(copies.path()).unwrap().count(), 1);
    assert_eq!(
        restore
            .apply(&store, &path, &preview.id, &[KEYS[0].into()], copies.path())
            .unwrap_err()
            .code,
        "selection"
    );
    drop(store);
    let cold = MetaStore::open(&path).unwrap();
    for key in KEYS {
        assert_eq!(cold.get_setting(key).unwrap().unwrap(), fixture[key]);
    }
    assert_eq!(
        cold.get_setting("credential").unwrap(),
        Some(json!("keep-target-fixture"))
    );
    let original =
        MetaStore::open(&Path::new(&receipt.protected_path).join("farfold.sqlite3")).unwrap();
    assert_eq!(original.restore_values().unwrap(), originals);
}
#[test]
fn unknown_database_version_and_added_schema_are_refused_without_migration() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let (source_path, candidate) = saved(source.path(), "candidate");
    drop(candidate);
    let (_, store) = saved(target.path(), "original");
    let connection = rusqlite::Connection::open(&source_path).unwrap();
    connection.pragma_update(None, "user_version", 9).unwrap();
    drop(connection);
    let before = fs::read(&source_path).unwrap();
    assert!(
        RestoreState::default()
            .preview(&store, &source_path)
            .is_err()
    );
    assert_eq!(fs::read(&source_path).unwrap(), before);
    let connection = rusqlite::Connection::open(&source_path).unwrap();
    connection.pragma_update(None, "user_version", 0).unwrap();
    connection
        .execute_batch("ALTER TABLE settings ADD COLUMN future_send TEXT;")
        .unwrap();
    drop(connection);
    assert!(
        RestoreState::default()
            .preview(&store, &source_path)
            .is_err()
    );
}
#[test]
fn startup_ready_and_restore_are_serialized_until_the_receipt_is_recorded() {
    use std::sync::{Arc, mpsc};
    use std::time::Duration;
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let copies = tempfile::tempdir().unwrap();
    let (source_path, _) = saved(source.path(), "candidate");
    let (path, store) = saved(target.path(), "original");
    let state = Arc::new(StorageRecoveryState::new(path.clone()));
    {
        state.0.lock().unwrap().status.ready = true;
    }
    assert!(!state.allows("settings_set"));
    assert!(state.allows("settings_get"));
    let mut guard = state.0.lock().unwrap();
    let preview = guard.restore.preview(&store, &source_path).unwrap();
    drop(guard);
    assert!(!state.allows("settings_get"));
    assert!(state.mark_editable().is_err());
    let mut guard = state.0.lock().unwrap();
    let (started, wait_started) = mpsc::channel();
    let (done, wait_done) = mpsc::channel();
    let copy = state.clone();
    let worker = std::thread::spawn(move || {
        started.send(()).unwrap();
        done.send(copy.mark_editable()).unwrap();
    });
    wait_started.recv().unwrap();
    assert!(wait_done.recv_timeout(Duration::from_millis(20)).is_err());
    guard
        .restore
        .apply(&store, &path, &preview.id, &[KEYS[0].into()], copies.path())
        .unwrap();
    assert!(guard.restore.receipt(&preview.id).is_some());
    assert!(wait_done.try_recv().is_err());
    drop(guard);
    assert!(
        wait_done
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .is_ok()
    );
    worker.join().unwrap();
    assert!(state.allows("settings_set"));
}
