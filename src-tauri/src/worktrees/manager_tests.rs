use super::*;
use crate::worktrees::tests::{OP, Repo, git, input, op, store};

const OTHER: &str = "22345678-1234-4123-8123-123456789abc";
fn prepared(m: &Worktrees, s: &MetaStore, r: &Repo) -> Create {
    let args = input(
        m,
        s,
        r,
        Branch::New {
            name: "owned-new".into(),
            start_oid: git(&r.root, &["rev-parse", "HEAD"]),
        },
        "owned-new",
    );
    assert_eq!(
        op(m.prepare(s, OP, args.clone()).unwrap()).state,
        "prepared"
    );
    args
}
#[test]
fn same_id_with_changed_input_and_cross_operation_never_reuses_authority() {
    let r = Repo::new();
    let s = store();
    let m = Worktrees::default();
    let args = prepared(&m, &s, &r);
    let mut changed = args.clone();
    changed.directory_name = "other".into();
    assert_eq!(
        m.prepare(&s, OP, changed).unwrap_err().code,
        "operationConflict"
    );
    assert_eq!(
        m.adopt(&s, OP, &args.inspection_id, r.root.to_str().unwrap())
            .unwrap_err()
            .code,
        "operationConflict"
    );
    assert_eq!(op(m.prepare(&s, OP, args).unwrap()).state, "prepared");
    assert!(!r._dir.path().join("owned-new").exists());
    m.cancel(&s, OP).unwrap();
    let inspection = m.inspect(&s, r.root.to_str().unwrap()).unwrap();
    assert_eq!(
        op(
            m.adopt(&s, OTHER, &inspection.inspection_id, &inspection.root)
                .unwrap()
        )
        .state,
        "ready"
    );
    let create = input(
        &m,
        &s,
        &r,
        Branch::New {
            name: "another".into(),
            start_oid: inspection.head.oid.unwrap(),
        },
        "another",
    );
    assert_eq!(
        m.prepare(&s, OTHER, create).unwrap_err().code,
        "operationConflict"
    );
}
#[test]
fn cold_unknown_can_be_reviewed_without_claiming_outcome_and_keeps_material_after_new_intent() {
    let r = Repo::new();
    let s = store();
    let m = Worktrees::default();
    let args = prepared(&m, &s, &r);
    drop(m);
    let cold = Worktrees::default();
    let unknown = cold.list(&s).unwrap().operation.unwrap();
    assert_eq!(unknown.state, "unknown");
    assert!(unknown.settled);
    assert!(!unknown.reviewed);
    assert_eq!(
        cold.seal_exit(Some(&s), false).err().unwrap(),
        "EXIT_CONFIRMATION_REQUIRED"
    );
    let acknowledged = op(cold.acknowledge(&s, OP).unwrap());
    assert_eq!(acknowledged.state, "unknown");
    assert!(acknowledged.reviewed);
    let expected_target = std::path::Path::new(&args.parent_path).join(&args.directory_name);
    assert_eq!(
        acknowledged.target_path.as_deref(),
        expected_target.to_str()
    );
    assert!(acknowledged.location.is_none());
    let next = input(
        &cold,
        &s,
        &r,
        Branch::New {
            name: "second".into(),
            start_oid: git(&r.root, &["rev-parse", "HEAD"]),
        },
        "second",
    );
    assert_eq!(op(cold.prepare(&s, OTHER, next).unwrap()).state, "prepared");
    let list = cold.list(&s).unwrap();
    assert_eq!(list.materials.len(), 1);
    assert_eq!(list.materials[0].operation_id, OP);
    assert!(list.locations.is_empty());
    assert!(!r._dir.path().join("owned-new").exists());
    let reloaded = Worktrees::default().list(&s).unwrap();
    assert_eq!(reloaded.materials[0].path, list.materials[0].path);
    assert!(matches!(cold.start(&s, OP).unwrap(), Reply::Unknown { .. }));
}
fn conflict_store(m: &Worktrees, s: &MetaStore) {
    let expected = s.worktree_raw().unwrap();
    let mut actual: Document = serde_json::from_str(expected.as_deref().unwrap()).unwrap();
    actual.operation.as_mut().unwrap().status.cancel_requested = true;
    assert!(
        s.worktree_compare_write(
            expected.as_deref(),
            &serde_json::to_string(&actual).unwrap()
        )
        .unwrap()
    );
    let mut inner = m.lock().unwrap();
    let next = inner.doc.clone();
    assert_eq!(inner.save(s, next).unwrap_err().code, "storageConflict");
}
#[test]
fn storage_failure_after_work_has_ended_allows_only_explicit_risk_confirmed_exit() {
    let r = Repo::new();
    let s = store();
    let m = Worktrees::default();
    prepared(&m, &s, &r);
    conflict_store(&m, &s);
    let result = op(m.status(&s, OP).unwrap());
    assert_eq!(result.state, "unknown");
    assert!(result.settled);
    assert!(result.location.is_none());
    assert_eq!(
        m.seal_exit(Some(&s), false).err().unwrap(),
        "EXIT_CONFIRMATION_REQUIRED"
    );
    let exit = m
        .seal_exit(Some(&s), true)
        .expect("settled storage uncertainty must not require force quit");
    assert!(m.0.admission.activity().is_err());
    drop(exit);
    assert_eq!(m.recheck(&s, OP).unwrap_err().code, "storageConflict");
    assert!(!r._dir.path().join("owned-new").exists());
    assert!(s.worktree_raw().unwrap().unwrap().contains("owned-new"));
}
#[test]
fn storage_failure_while_owned_work_is_in_flight_cannot_be_acknowledged_or_confirmed_away() {
    let r = Repo::new();
    let s = store();
    let m = Worktrees::default();
    prepared(&m, &s, &r);
    // This is the production admission/owner state; no claim of an actual OS child here.
    let permit = m.0.admission.activity().unwrap();
    m.lock().unwrap().working = Some(Working::new(OP, Arc::new(AtomicBool::new(false))));
    conflict_store(&m, &s);
    assert!(!op(m.status(&s, OP).unwrap()).settled);
    assert_eq!(
        m.seal_exit(Some(&s), true).err().unwrap(),
        "WORKTREE_EXIT_BLOCKED"
    );
    assert_eq!(m.acknowledge(&s, OP).unwrap_err().code, "busy");
    drop(permit);
    assert_eq!(
        m.seal_exit(Some(&s), true).err().unwrap(),
        "WORKTREE_EXIT_BLOCKED"
    );
    m.lock().unwrap().working = None;
    assert!(m.seal_exit(Some(&s), true).is_ok());
}
#[test]
fn explicit_storage_recovery_retries_only_metadata_and_never_creates_a_directory() {
    let r = Repo::new();
    let s = store();
    let m = Worktrees::default();
    prepared(&m, &s, &r);
    let expected = s.worktree_raw().unwrap();
    conflict_store(&m, &s);
    let modified = s.worktree_raw().unwrap();
    assert!(
        s.worktree_compare_write(modified.as_deref(), expected.as_deref().unwrap())
            .unwrap()
    );
    let checked = op(m.recheck(&s, OP).unwrap());
    assert_eq!(checked.state, "unknown");
    assert!(checked.settled);
    assert!(!r._dir.path().join("owned-new").exists());
    assert!(op(m.acknowledge(&s, OP).unwrap()).reviewed);
}
#[test]
fn cold_old_location_and_material_ids_cannot_start_new_filesystem_work() {
    let r = Repo::new();
    let s = store();
    let m = Worktrees::default();
    let first = m.inspect(&s, r.root.to_str().unwrap()).unwrap();
    m.adopt(&s, OP, &first.inspection_id, &first.root).unwrap();
    // Save a different current intent, leaving A only in location metadata.
    let next = input(
        &m,
        &s,
        &r,
        Branch::New {
            name: "second".into(),
            start_oid: git(&r.root, &["rev-parse", "HEAD"]),
        },
        "second",
    );
    m.prepare(&s, OTHER, next).unwrap();
    m.start(&s, OTHER).unwrap();
    let until = Instant::now() + Duration::from_secs(15);
    loop {
        let value = op(m.status(&s, OTHER).unwrap());
        if value.settled {
            assert_eq!(value.state, "ready", "{value:?}");
            break;
        }
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(10));
    }
    drop(m);
    let cold = Worktrees::default();
    cold.list(&s).unwrap();
    let reused = input(
        &cold,
        &s,
        &r,
        Branch::New {
            name: "illegal-reuse".into(),
            start_oid: git(&r.root, &["rev-parse", "HEAD"]),
        },
        "illegal-reuse",
    );
    let reply = cold.prepare(&s, OP, reused).unwrap();
    assert!(
        matches!(reply, Reply::Unknown { .. }),
        "old location ID must be retired before any new prepare: {reply:?}"
    );
    assert!(!r._dir.path().join("illegal-reuse").exists());
    // A retained unresolved path is authority to retire its ID, never to replay creation.
    let mut raw = storage::read(&s).unwrap().1;
    raw.materials.push(Material {
        operation_id: "32345678-1234-4123-8123-123456789abc".into(),
        path: r
            ._dir
            .path()
            .canonicalize()
            .unwrap()
            .join("unknown-material")
            .to_str()
            .unwrap()
            .into(),
        repository_root: r.root.canonicalize().unwrap().to_str().unwrap().into(),
    });
    let old = s.worktree_raw().unwrap();
    storage::save(&s, &old, &raw).unwrap();
    let again = Worktrees::default();
    again.list(&s).unwrap();
    let reused = input(
        &again,
        &s,
        &r,
        Branch::New {
            name: "illegal-material".into(),
            start_oid: git(&r.root, &["rev-parse", "HEAD"]),
        },
        "illegal-material",
    );
    assert!(matches!(
        again
            .prepare(&s, "32345678-1234-4123-8123-123456789abc", reused)
            .unwrap(),
        Reply::Unknown { .. }
    ));
    assert!(!r._dir.path().join("illegal-material").exists());
}
#[test]
fn cancellation_before_prepare_retires_the_exact_fresh_id_with_a_confirmed_no_start_receipt() {
    let r = Repo::new();
    let s = store();
    let m = Worktrees::default();
    let args = input(
        &m,
        &s,
        &r,
        Branch::New {
            name: "cancel-first".into(),
            start_oid: git(&r.root, &["rev-parse", "HEAD"]),
        },
        "cancel-first",
    );
    let result = m.cancel(&s, OP).unwrap();
    assert!(
        matches!(&result,Reply::Operation(o) if o.state=="cancelled" && o.settled),
        "fresh ID cancel must have an exact known result: {result:?}"
    );
    assert_eq!(op(m.prepare(&s, OP, args).unwrap()).state, "cancelled");
    assert_eq!(op(m.start(&s, OP).unwrap()).state, "cancelled");
    assert!(!r._dir.path().join("cancel-first").exists());
}
#[test]
fn real_git_completion_followed_by_storage_failure_keeps_files_and_can_recover_metadata_only() {
    let r = Repo::new();
    let db = r._dir.path().join("owned-state.sqlite3");
    let s = MetaStore::open(&db).unwrap();
    let m = Worktrees::default();
    prepared(&m, &s, &r);
    let sql = rusqlite::Connection::open(&db).unwrap();
    sql.execute_batch("CREATE TRIGGER reject_ready BEFORE UPDATE ON settings WHEN NEW.key='worktreeLocations.v1' AND NEW.value LIKE '%\"state\":\"ready\"%' BEGIN SELECT RAISE(ABORT,'controlled final receipt failure'); END;").unwrap();
    m.start(&s, OP).unwrap();
    let result = crate::worktrees::tests::wait(&m, &s);
    assert_eq!(result.state, "unknown");
    assert!(result.settled);
    assert_eq!(result.code.as_deref(), Some("storageUnknown"));
    let target = r._dir.path().canonicalize().unwrap().join("owned-new");
    assert_eq!(std::fs::read(target.join("a.txt")).unwrap(), b"fixture");
    assert_eq!(git(&target, &["status", "--porcelain"]), "");
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match m.seal_exit(Some(&s), false) {
            Err(e) if e == "WORKTREE_EXIT_BLOCKED" => {
                assert!(Instant::now() < deadline);
                std::thread::yield_now();
            }
            Err(e) => {
                assert_eq!(e, "EXIT_CONFIRMATION_REQUIRED");
                break;
            }
            Ok(_) => panic!("storage failure needs explicit review"),
        }
    }
    assert!(m.seal_exit(Some(&s), true).is_ok());
    let persisted = s.worktree_raw().unwrap().unwrap();
    assert!(persisted.contains("owned-new"));
    assert!(persisted.contains("\"dispatched\":true"));
    assert!(
        m.recheck(&s, OP).is_err(),
        "the trigger remains active, so metadata recovery is not success"
    );
    sql.execute_batch("DROP TRIGGER reject_ready;").unwrap();
    assert_eq!(op(m.recheck(&s, OP).unwrap()).state, "ready");
    assert_eq!(op(m.start(&s, OP).unwrap()).state, "ready");
    assert_eq!(
        git(&r.root, &["worktree", "list", "--porcelain"])
            .matches("worktree ")
            .count(),
        2
    );
}
