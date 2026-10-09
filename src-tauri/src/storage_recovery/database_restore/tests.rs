use super::*;
use crate::meta_store::MetaStore;
use std::{cell::Cell, fs};

struct Fixture {
    _dir: tempfile::TempDir,
    path: PathBuf,
    source: PathBuf,
    originals: Vec<(String, Vec<u8>)>,
}
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let path = root.join("farfold.sqlite3");
    let source = root.join("candidate.sqlite3");
    let store = MetaStore::open(&source).unwrap();
    store
        .set_setting(
            "restore-proof",
            &serde_json::json!({"text":"saved content"}),
        )
        .unwrap();
    drop(store);
    let originals = ["", "-wal", "-shm", "-journal"]
        .iter()
        .map(|suffix| {
            let name = format!("farfold.sqlite3{suffix}");
            let bytes = format!("retained damaged material {suffix}").into_bytes();
            fs::write(root.join(&name), &bytes).unwrap();
            (name, bytes)
        })
        .collect();
    Fixture {
        _dir: dir,
        path,
        source,
        originals,
    }
}
fn prepared(f: &Fixture) -> (State, String) {
    let mut state = State::default();
    let preview = state.preview(&f.path, &f.source).unwrap();
    operation::prepare(&f.path, state.pending.as_ref().unwrap(), &files::Native).unwrap();
    (state, preview.id)
}
fn protected_originals(f: &Fixture, id: &str) {
    for (name, bytes) in &f.originals {
        assert_eq!(
            fs::read(work(&f.path, id).unwrap().join("protected").join(name)).unwrap(),
            *bytes
        );
    }
}

#[test]
fn valid_copy_replaces_only_after_protection_and_requires_fresh_startup() {
    let f = fixture();
    let mut state = State::default();
    let preview = state.preview(&f.path, &f.source).unwrap();
    let receipt = state.apply(&f.path, &preview.id).unwrap();
    assert!(receipt.can_restart);
    assert!(state.active());
    protected_originals(&f, &preview.id);
    for (name, bytes) in &f.originals {
        assert_eq!(
            fs::read(
                work(&f.path, &preview.id)
                    .unwrap()
                    .join("original")
                    .join(name)
            )
            .unwrap(),
            *bytes
        );
    }
    assert_eq!(
        operation::read_intent(&f.path).unwrap().unwrap().phase,
        Phase::Installed
    );
    assert!(startup(&f.path).unwrap());
    assert_eq!(
        operation::read_intent(&f.path).unwrap().unwrap().phase,
        Phase::Released
    );
    let store = MetaStore::open(&f.path).unwrap();
    assert_eq!(
        store.get_setting("restore-proof").unwrap(),
        Some(serde_json::json!({"text":"saved content"}))
    );
}
#[test]
fn released_receipt_never_overwrites_later_database_writes() {
    let f = fixture();
    let mut state = State::default();
    let preview = state.preview(&f.path, &f.source).unwrap();
    state.apply(&f.path, &preview.id).unwrap();
    startup(&f.path).unwrap();
    let store = MetaStore::open(&f.path).unwrap();
    store
        .set_setting("later", &serde_json::json!("new user work"))
        .unwrap();
    drop(store);
    let bytes = fs::read(&f.path).unwrap();
    assert!(startup(&f.path).unwrap());
    assert_eq!(fs::read(&f.path).unwrap(), bytes);
    assert_eq!(
        MetaStore::open(&f.path)
            .unwrap()
            .get_setting("later")
            .unwrap(),
        Some(serde_json::json!("new user work"))
    );
}
#[test]
fn preview_source_replacement_does_not_change_reviewed_material() {
    let f = fixture();
    let mut state = State::default();
    let preview = state.preview(&f.path, &f.source).unwrap();
    fs::write(&f.source, b"different and invalid source").unwrap();
    state.apply(&f.path, &preview.id).unwrap();
    startup(&f.path).unwrap();
    assert!(
        MetaStore::open(&f.path)
            .unwrap()
            .get_setting("restore-proof")
            .unwrap()
            .is_some()
    );
}
#[test]
fn lost_apply_reply_is_idempotent_and_another_ticket_cannot_apply() {
    let f = fixture();
    let mut state = State::default();
    let preview = state.preview(&f.path, &f.source).unwrap();
    state.apply(&f.path, &preview.id).unwrap();
    let bytes = fs::read(&f.path).unwrap();
    assert!(state.apply(&f.path, &preview.id).unwrap().can_restart);
    assert!(state.apply(&f.path, &"b".repeat(48)).is_err());
    assert_eq!(fs::read(&f.path).unwrap(), bytes);
}
#[test]
fn missing_main_keeps_every_side_file_and_never_mixes_it_with_new_database() {
    let mut f = fixture();
    fs::remove_file(&f.path).unwrap();
    f.originals.remove(0);
    let mut state = State::default();
    let preview = state.preview(&f.path, &f.source).unwrap();
    state.apply(&f.path, &preview.id).unwrap();
    protected_originals(&f, &preview.id);
    assert!(startup(&f.path).unwrap());
}
#[test]
fn intent_tampering_and_unexpected_side_files_keep_admission_closed() {
    let f = fixture();
    let (_state, id) = prepared(&f);
    assert!(startup(&f.path).is_err());
    let main = fs::read(&f.path).unwrap();
    let mut intent = operation::read_intent(&f.path).unwrap().unwrap();
    intent.originals[0].name = "../outside".into();
    fs::write(
        record(&f.path).unwrap(),
        serde_json::to_vec(&intent).unwrap(),
    )
    .unwrap();
    assert!(operation::advance(&f.path, &id, &files::Native).is_err());
    assert!(startup(&f.path).is_err());
    assert_eq!(fs::read(&f.path).unwrap(), main);
}
#[test]
fn future_schema_and_same_columns_without_constraints_are_rejected() {
    let f = fixture();
    let conn = rusqlite::Connection::open(&f.source).unwrap();
    conn.pragma_update(None, "user_version", 1).unwrap();
    drop(conn);
    assert!(State::default().preview(&f.path, &f.source).is_err());
    let conn = rusqlite::Connection::open(&f.source).unwrap();
    conn.pragma_update(None, "user_version", 0).unwrap();
    conn.execute_batch("ALTER TABLE settings RENAME TO old_settings; CREATE TABLE settings(key TEXT,value TEXT); INSERT INTO settings SELECT * FROM old_settings; DROP TABLE old_settings;").unwrap();
    drop(conn);
    assert!(State::default().preview(&f.path, &f.source).is_err());
    assert_eq!(fs::read(&f.path).unwrap(), f.originals[0].1);
}
#[cfg(unix)]
#[test]
fn symbolic_link_intent_is_not_followed_or_replaced() {
    let f = fixture();
    let outside = f.path.parent().unwrap().join("outside");
    fs::write(&outside, b"keep me").unwrap();
    std::os::unix::fs::symlink(&outside, record(&f.path).unwrap()).unwrap();
    assert!(startup(&f.path).is_err());
    assert!(State::default().preview(&f.path, &f.source).is_err());
    assert_eq!(fs::read(outside).unwrap(), b"keep me");
}
struct Fail {
    at: usize,
    step: Cell<usize>,
    after: bool,
}
impl Fail {
    fn call(&self, action: impl FnOnce() -> Result<(), Failure>) -> Result<(), Failure> {
        self.step.set(self.step.get() + 1);
        if self.step.get() == self.at && !self.after {
            return Err(Failure::new("unknown"));
        }
        action()?;
        if self.step.get() == self.at && self.after {
            return Err(Failure::new("unknown"));
        }
        Ok(())
    }
}
impl FileOps for Fail {
    fn move_new(&self, source: &Path, dest: &Path) -> Result<(), Failure> {
        self.call(|| files::Native.move_new(source, dest))
    }
    fn sync_directory(&self, path: &Path) -> Result<(), Failure> {
        self.call(|| files::Native.sync_directory(path))
    }
    fn save_record(&self, path: &Path, bytes: &[u8], replace: bool) -> Result<(), Failure> {
        self.call(|| files::Native.save_record(path, bytes, replace))
    }
}
#[test]
fn interruption_before_and_after_each_mutation_can_resume_without_losing_originals() {
    for after in [false, true] {
        for at in 1..=16 {
            let f = fixture();
            let (_state, id) = prepared(&f);
            let io = Fail {
                at,
                step: Cell::new(0),
                after,
            };
            let _interrupted = operation::advance(&f.path, &id, &io);
            protected_originals(&f, &id);
            let receipt = operation::advance(&f.path, &id, &files::Native).unwrap();
            assert!(receipt.can_restart, "{at} {after}");
            assert!(startup(&f.path).unwrap());
            protected_originals(&f, &id);
        }
    }
}

#[test]
fn private_verification_accepts_a_valid_database_through_resolved_temp_path() {
    let f = fixture();
    assert!(validate::captured_database(&f.source).is_ok());
}
#[test]
fn missing_intent_after_preparation_never_becomes_a_fresh_database() {
    let f = fixture();
    let (_state, _id) = prepared(&f);
    fs::remove_file(record(&f.path).unwrap()).unwrap();
    assert!(startup(&f.path).is_err());
}
#[test]
fn receipt_cannot_expand_total_material_size_past_the_preparation_limit() {
    let f = fixture();
    let (_state, _id) = prepared(&f);
    let mut intent = operation::read_intent(&f.path).unwrap().unwrap();
    for old in &mut intent.originals {
        old.fact.bytes = LIMIT;
    }
    fs::write(
        record(&f.path).unwrap(),
        serde_json::to_vec(&intent).unwrap(),
    )
    .unwrap();
    assert!(operation::read_intent(&f.path).is_err());
}

#[test]
fn failed_first_preparation_can_be_explicitly_retried_without_discarding_materials() {
    let f = fixture();
    let mut first = State::default();
    let old = first.preview(&f.path, &f.source).unwrap();
    let failure = Fail {
        at: 2,
        step: Cell::new(0),
        after: true,
    };
    assert!(operation::prepare(&f.path, first.pending.as_ref().unwrap(), &failure).is_err());
    for (name, bytes) in &f.originals {
        assert_eq!(
            fs::read(f.path.parent().unwrap().join(name)).unwrap(),
            *bytes
        );
    }
    assert!(startup(&f.path).is_err());
    let mut retry = State::default();
    let next = retry.preview(&f.path, &f.source).unwrap();
    assert_ne!(old.id, next.id);
    retry.apply(&f.path, &next.id).unwrap();
    assert!(startup(&f.path).unwrap());
    assert!(
        work(&f.path, &next.id)
            .unwrap()
            .join("previous-receipt.json")
            .exists()
    );
    protected_originals(&f, &next.id);
}

#[test]
fn first_preparation_interruptions_preserve_originals_and_have_a_deterministic_exit() {
    for after in [false, true] {
        for at in 1..=8 {
            let f = fixture();
            let mut state = State::default();
            let p = state.preview(&f.path, &f.source).unwrap();
            let io = Fail {
                at,
                step: Cell::new(0),
                after,
            };
            assert!(
                operation::prepare(&f.path, state.pending.as_ref().unwrap(), &io).is_err(),
                "{at} {after}"
            );
            for (name, bytes) in &f.originals {
                assert_eq!(
                    fs::read(f.path.parent().unwrap().join(name)).unwrap(),
                    *bytes
                );
            }
            let intent = operation::read_intent(&f.path).unwrap();
            let mut cold = State::default();
            let restored = if intent.as_ref().is_some_and(|i| i.phase == Phase::Prepared) {
                cold.resume(&f.path, &p.id).unwrap()
            } else {
                let next = cold.preview(&f.path, &f.source).unwrap();
                cold.apply(&f.path, &next.id).unwrap()
            };
            assert!(restored.can_restart);
            assert!(startup(&f.path).unwrap());
        }
    }
}
#[test]
fn preparing_record_cannot_replay_moves_or_accept_changed_originals() {
    let f = fixture();
    let mut state = State::default();
    let p = state.preview(&f.path, &f.source).unwrap();
    operation::prepare(
        &f.path,
        state.pending.as_ref().unwrap(),
        &Fail {
            at: 3,
            step: Cell::new(0),
            after: false,
        },
    )
    .unwrap_err();
    let bytes = fs::read(&f.path).unwrap();
    let mut cold = State::default();
    let reply = cold.apply(&f.path, &p.id).unwrap();
    assert_eq!(reply.phase, "preparing");
    assert!(!reply.can_continue);
    assert_eq!(fs::read(&f.path).unwrap(), bytes);
    fs::write(&f.path, b"changed outside recovery").unwrap();
    assert!(cold.preview(&f.path, &f.source).is_err());
    assert!(cold.cancel(&f.path).is_err());
    assert!(startup(&f.path).is_err());
}
#[test]
fn release_failure_never_admits_even_when_the_marker_was_promoted() {
    for after in [false, true] {
        let f = fixture();
        let mut state = State::default();
        let p = state.preview(&f.path, &f.source).unwrap();
        state.apply(&f.path, &p.id).unwrap();
        assert!(
            startup_with(
                &f.path,
                &Fail {
                    at: 1,
                    step: Cell::new(0),
                    after
                }
            )
            .is_err()
        );
        let bytes = fs::read(&f.path).unwrap();
        assert!(startup(&f.path).unwrap());
        assert_eq!(fs::read(&f.path).unwrap(), bytes);
        protected_originals(&f, &p.id);
    }
}
#[test]
fn interrupted_or_changed_promoted_files_never_release_to_database_open() {
    let f = fixture();
    let mut state = State::default();
    let p = state.preview(&f.path, &f.source).unwrap();
    state.apply(&f.path, &p.id).unwrap();
    fs::write(
        f.path.with_file_name("farfold.sqlite3-wal"),
        b"unexpected side file",
    )
    .unwrap();
    assert!(startup(&f.path).is_err());
    fs::remove_file(f.path.with_file_name("farfold.sqlite3-wal")).unwrap();
    fs::write(&f.path, b"changed replacement").unwrap();
    assert!(startup(&f.path).is_err());
    protected_originals(&f, &p.id);
}
#[test]
fn oversized_and_future_receipts_cannot_open_or_trigger_new_recovery() {
    for bytes in [vec![b' '; 65537], br#"{"version":99}"#.to_vec()] {
        let f = fixture();
        fs::write(record(&f.path).unwrap(), bytes).unwrap();
        assert!(startup(&f.path).is_err());
        assert!(State::default().preview(&f.path, &f.source).is_err());
        assert_eq!(fs::read(&f.path).unwrap(), f.originals[0].1);
    }
}
#[test]
fn next_recovery_after_release_keeps_the_previous_receipt_and_all_originals() {
    let f = fixture();
    let mut first = State::default();
    let p = first.preview(&f.path, &f.source).unwrap();
    first.apply(&f.path, &p.id).unwrap();
    startup(&f.path).unwrap();
    fs::write(&f.path, b"later physical damage").unwrap();
    let mut next = State::default();
    let q = next.preview(&f.path, &f.source).unwrap();
    next.apply(&f.path, &q.id).unwrap();
    let old: Intent = serde_json::from_slice(
        &fs::read(work(&f.path, &q.id).unwrap().join("previous-receipt.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(old.id, p.id);
    assert_eq!(old.phase, Phase::Released);
    protected_originals(&f, &p.id);
    assert_eq!(
        fs::read(
            work(&f.path, &q.id)
                .unwrap()
                .join("protected/farfold.sqlite3")
        )
        .unwrap(),
        b"later physical damage"
    );
}

#[test]
fn released_database_symlink_does_not_admit_an_external_file() {
    let f = fixture();
    let mut state = State::default();
    let p = state.preview(&f.path, &f.source).unwrap();
    state.apply(&f.path, &p.id).unwrap();
    startup(&f.path).unwrap();
    fs::remove_file(&f.path).unwrap();
    std::os::unix::fs::symlink(&f.source, &f.path).unwrap();
    assert!(startup(&f.path).is_err());
}
