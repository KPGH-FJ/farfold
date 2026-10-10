use super::*;
use crate::worktrees::{recycle_tests, tests, *};
use std::{fs, path::Path};

const ARCHIVE: &str = "22345678-1234-4123-8123-123456789abc";
const RESTORE: &str = "32345678-1234-4123-8123-123456789abc";

fn restored(m: &Worktrees, s: &MetaStore, r: &tests::Repo) -> Location {
    let location = recycle_tests::created(m, s, r);
    let preview = m
        .recycle_inspect(s, RecycleAction::Archive, &location.id, location.revision)
        .unwrap();
    assert_eq!(
        recycle_tests::prepare(m, s, ARCHIVE, preview).state,
        "prepared"
    );
    m.start(s, ARCHIVE).unwrap();
    let archived = recycle_tests::wait(m, s, ARCHIVE);
    assert_eq!(archived.state, "ready", "{archived:?}");
    let archive = archived.archive.unwrap();
    let preview = m
        .recycle_inspect(s, RecycleAction::Restore, &archive.id, archive.revision)
        .unwrap();
    assert_eq!(
        recycle_tests::prepare(m, s, RESTORE, preview).state,
        "prepared"
    );
    m.start(s, RESTORE).unwrap();
    let done = recycle_tests::wait(m, s, RESTORE);
    assert_eq!(done.state, "ready", "{done:?}");
    assert!(m.list(s).unwrap().archives.is_empty());
    done.location.unwrap()
}

#[test]
fn cold_restored_location_recheck_publishes_one_canonical_result_without_moving_history() {
    recycle_tests::isolated(
        "worktrees::manager::cold_restore_recheck_tests::cold_restored_location_recheck_publishes_one_canonical_result_without_moving_history",
        || {
            let r = tests::Repo::new();
            let s = tests::store();
            let original = Worktrees::default();
            let restored = restored(&original, &s, &r);
            let row = crate::acp_client::session_index::touch_session_row(
                &s,
                "fixture",
                &restored.path,
                "native",
                Some("historical"),
                None,
            )
            .unwrap();
            let bytes = fs::read(Path::new(&restored.path).join("a.txt")).unwrap();
            let mut revision = restored.revision;
            // A second cold load proves the newly persisted result, not only a warm cache.
            for _ in 0..2 {
                let cold = Worktrees::default();
                let list = cold.list(&s).unwrap();
                assert!(list.archives.is_empty());
                assert_eq!(list.locations[0].availability, "unknown");
                assert_eq!(list.operation.unwrap().state, "unknown");
                let checked = tests::op(cold.recheck(&s, RESTORE).unwrap());
                assert_eq!(checked.state, "ready", "{checked:?}");
                assert!(checked.settled && !checked.maintenance_active && !checked.reviewed);
                assert!(checked.code.is_none());
                let current = checked.location.clone().unwrap();
                assert_eq!(current.id, restored.id);
                assert_eq!(current.path, restored.path);
                assert_eq!(current.head_oid, restored.head_oid);
                assert_eq!(current.ownership, "created");
                assert_eq!(current.revision, revision + 1);
                assert_eq!(current.availability, "verified");
                revision = current.revision;
                let list = cold.list(&s).unwrap();
                assert_eq!(list.locations, vec![current.clone()]);
                assert!(list.archives.is_empty());
                assert_eq!(list.operation.as_ref(), Some(&checked));
                let (_, durable) = storage::read(&s).unwrap();
                assert_eq!(durable.locations[0].location, current);
                let operation = durable.operation.unwrap();
                assert_eq!(operation.status, checked);
                assert!(operation.completed);
                assert_eq!(s.get_session(&row.id).unwrap().unwrap(), row);
                assert_eq!(
                    fs::read(Path::new(&restored.path).join("a.txt")).unwrap(),
                    bytes
                );
                assert!(!Path::new(checked.retained_path.as_ref().unwrap()).exists());
            }
        },
    );
}

#[test]
fn cold_restore_recheck_rejects_a_replacement_directory_at_the_same_path() {
    recycle_tests::isolated(
        "worktrees::manager::cold_restore_recheck_tests::cold_restore_recheck_rejects_a_replacement_directory_at_the_same_path",
        || {
            let r = tests::Repo::new();
            let s = tests::store();
            let original = Worktrees::default();
            let restored = restored(&original, &s, &r);
            let cold = Worktrees::default();
            cold.list(&s).unwrap();
            let path = Path::new(&restored.path);
            let displaced = r._dir.path().join("displaced-owned");
            fs::rename(path, &displaced).unwrap();
            fs::create_dir(path).unwrap();
            fs::write(path.join("replacement"), b"must remain untouched").unwrap();
            let checked = tests::op(cold.recheck(&s, RESTORE).unwrap());
            assert_eq!(checked.state, "unknown", "{checked:?}");
            assert_eq!(checked.code.as_deref(), Some("changed"));
            let location = checked.location.unwrap();
            assert_eq!(location.availability, "unknown");
            assert_eq!(cold.list(&s).unwrap().locations, vec![location]);
            assert_eq!(
                fs::read(path.join("replacement")).unwrap(),
                b"must remain untouched"
            );
            assert_eq!(fs::read(displaced.join("a.txt")).unwrap(), b"fixture");
            assert!(!path.join(".git").exists());
            assert!(!Path::new(checked.retained_path.as_ref().unwrap()).exists());
        },
    );
}

#[test]
fn cold_restore_recheck_rejects_head_change_without_resetting_the_checkout() {
    recycle_tests::isolated(
        "worktrees::manager::cold_restore_recheck_tests::cold_restore_recheck_rejects_head_change_without_resetting_the_checkout",
        || {
            let r = tests::Repo::new();
            let s = tests::store();
            let original = Worktrees::default();
            let restored = restored(&original, &s, &r);
            let cold = Worktrees::default();
            cold.list(&s).unwrap();
            let path = Path::new(&restored.path);
            tests::git(
                path,
                &[
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "--allow-empty",
                    "-qm",
                    "after restore",
                ],
            );
            let changed_head = tests::git(path, &["rev-parse", "HEAD"]);
            assert_ne!(changed_head, restored.head_oid);
            let checked = tests::op(cold.recheck(&s, RESTORE).unwrap());
            assert_eq!(checked.state, "unknown", "{checked:?}");
            assert_eq!(checked.code.as_deref(), Some("changed"));
            let location = checked.location.unwrap();
            assert_eq!(location.availability, "unknown");
            assert_eq!(location.head_oid, restored.head_oid);
            assert_eq!(cold.list(&s).unwrap().locations, vec![location]);
            assert_eq!(tests::git(path, &["rev-parse", "HEAD"]), changed_head);
            assert_eq!(fs::read(path.join("a.txt")).unwrap(), b"fixture");
        },
    );
}

#[test]
fn cold_restore_recheck_rejects_changed_material_without_rewriting_it() {
    recycle_tests::isolated(
        "worktrees::manager::cold_restore_recheck_tests::cold_restore_recheck_rejects_changed_material_without_rewriting_it",
        || {
            let r = tests::Repo::new();
            let s = tests::store();
            let original = Worktrees::default();
            let restored = restored(&original, &s, &r);
            let cold = Worktrees::default();
            cold.list(&s).unwrap();
            let path = Path::new(&restored.path).join("a.txt");
            fs::write(&path, b"changed after restore").unwrap();
            let checked = tests::op(cold.recheck(&s, RESTORE).unwrap());
            assert_eq!(checked.state, "unknown", "{checked:?}");
            assert_eq!(checked.code.as_deref(), Some("materialChanged"));
            let location = checked.location.unwrap();
            assert_eq!(location.availability, "unknown");
            assert_eq!(cold.list(&s).unwrap().locations, vec![location]);
            assert_eq!(fs::read(path).unwrap(), b"changed after restore");
            assert!(!Path::new(checked.retained_path.as_ref().unwrap()).exists());
        },
    );
}

#[test]
fn late_restore_verification_preserves_a_newer_location_revision_then_allows_a_fresh_recheck() {
    recycle_tests::isolated(
        "worktrees::manager::cold_restore_recheck_tests::late_restore_verification_preserves_a_newer_location_revision_then_allows_a_fresh_recheck",
        || {
            let r = tests::Repo::new();
            let s = tests::store();
            let original = Worktrees::default();
            let restored = restored(&original, &s, &r);
            let cold = Worktrees::default();
            cold.list(&s).unwrap();
            let mut newer = None;
            let mut durable_after_newer = None;
            let error = cold
                .recheck_restored_with(&s, RESTORE, |saved| {
                    let snapshot = crate::worktrees::recycle::verify_at(
                        saved,
                        false,
                        &AtomicBool::new(false),
                    )?;
                    newer = Some(cold.check_location(&s, &restored.id)?);
                    durable_after_newer = s.worktree_raw().unwrap();
                    Ok(snapshot)
                })
                .unwrap_err();
            assert_eq!(error.code, "changed");
            let newer = newer.unwrap();
            assert!(newer.revision > restored.revision);
            assert_eq!(cold.list(&s).unwrap().locations, vec![newer.clone()]);
            assert_eq!(s.worktree_raw().unwrap(), durable_after_newer);
            assert_eq!(
                tests::op(cold.status(&s, RESTORE).unwrap()).state,
                "unknown"
            );

            // The late callback cannot publish, but a new explicit check may use
            // the newer canonical observation if all substantive identity matches.
            let checked = tests::op(cold.recheck(&s, RESTORE).unwrap());
            assert_eq!(checked.state, "ready", "{checked:?}");
            let latest = checked.location.unwrap();
            assert_eq!(latest.revision, newer.revision + 1);
            assert_eq!(latest.availability, "verified");
            assert_eq!(cold.list(&s).unwrap().locations, vec![latest.clone()]);
            let (_, durable) = storage::read(&s).unwrap();
            assert_eq!(durable.locations[0].location, latest);
            assert_eq!(durable.operation.unwrap().status.location, Some(latest));
        },
    );
}

#[test]
fn late_restore_verification_cannot_erase_an_acknowledged_unknown_operation() {
    recycle_tests::isolated(
        "worktrees::manager::cold_restore_recheck_tests::late_restore_verification_cannot_erase_an_acknowledged_unknown_operation",
        || {
            let r = tests::Repo::new();
            let s = tests::store();
            let original = Worktrees::default();
            restored(&original, &s, &r);
            let cold = Worktrees::default();
            cold.list(&s).unwrap();
            let mut durable_after_acknowledge = None;
            let error = cold
                .recheck_restored_with(&s, RESTORE, |saved| {
                    let snapshot = crate::worktrees::recycle::verify_at(
                        saved,
                        false,
                        &AtomicBool::new(false),
                    )?;
                    let acknowledged = tests::op(cold.acknowledge(&s, RESTORE)?);
                    assert_eq!(acknowledged.state, "unknown");
                    assert!(acknowledged.reviewed);
                    durable_after_acknowledge = s.worktree_raw().unwrap();
                    Ok(snapshot)
                })
                .unwrap_err();
            assert_eq!(error.code, "changed");
            assert_eq!(s.worktree_raw().unwrap(), durable_after_acknowledge);
            let current = tests::op(cold.status(&s, RESTORE).unwrap());
            assert_eq!(current.state, "unknown");
            assert!(current.reviewed);
            assert_eq!(cold.list(&s).unwrap().locations[0].availability, "unknown");
        },
    );
}
