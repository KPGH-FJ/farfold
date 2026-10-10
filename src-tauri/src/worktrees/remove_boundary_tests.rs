use super::{
    recovery_tests as fixture,
    tests::{self, Repo, git},
    *,
};
use std::{fs, path::Path, sync::atomic::AtomicBool};
const REMOVE: &str = fixture::REMOVE;
fn confirmation(a: &Archive, b: &Recovery) -> RemoveConfirmation {
    RemoveConfirmation {
        record_id: a.id.clone(),
        expected_revision: a.revision,
        recovery_id: b.id.clone(),
        recovery_sha256: b.bundle_sha256.clone(),
        manifest_sha256: b.manifest_sha256.clone(),
    }
}
#[test]
fn remove_confirmation_rechecks_reflog_evidence_even_same_root_set() {
    recycle_tests::isolated(
        "worktrees::remove_boundary_tests::remove_confirmation_rechecks_reflog_evidence_even_same_root_set",
        || {
            let r = Repo::new();
            let s = tests::store();
            let m = Worktrees::default();
            let l = recycle_tests::created(&m, &s, &r);
            let a = fixture::archive(&m, &s, &l);
            let o = fixture::prepare_removal(&m, &s, &a);
            assert_eq!(o.state, "prepared");
            let b = o.recovery.unwrap();
            let snap = inspect::snapshot(Path::new(&a.retained_path)).unwrap();
            let log = Path::new(&snap.git_dir).join("logs/HEAD");
            let old = fs::read(&log).unwrap();
            let before = recovery_roots::capture(&snap, &AtomicBool::new(false)).unwrap();
            let mut altered = old.clone();
            altered.extend_from_slice(
                format!(
                    "{} {} Fixture <f@example.invalid> 4 +0000\tadditional evidence\n",
                    a.head_oid, a.head_oid
                )
                .as_bytes(),
            );
            fs::write(&log, &altered).unwrap();
            let after = recovery_roots::capture(&snap, &AtomicBool::new(false)).unwrap();
            assert_eq!(before.commits, after.commits);
            assert_ne!(before.summary().unwrap(), after.summary().unwrap());
            m.confirm_remove(&s, REMOVE, confirmation(&a, &b)).unwrap();
            let done = recycle_tests::wait(&m, &s, REMOVE);
            assert_eq!(done.state, "failed", "{done:?}");
            assert_eq!(done.delete_dispatched, Some(false));
            assert_eq!(done.code.as_deref(), Some("recoveryChanged"));
            assert!(Path::new(&a.retained_path).exists());
            assert_eq!(fs::read(log).unwrap(), altered);
        },
    );
}
#[test]
fn remove_confirmation_rejects_corrupt_bundle_and_keeps_source() {
    recycle_tests::isolated(
        "worktrees::remove_boundary_tests::remove_confirmation_rejects_corrupt_bundle_and_keeps_source",
        || {
            let r = Repo::new();
            let s = tests::store();
            let m = Worktrees::default();
            let l = recycle_tests::created(&m, &s, &r);
            let a = fixture::archive(&m, &s, &l);
            let o = fixture::prepare_removal(&m, &s, &a);
            let b = o.recovery.unwrap();
            let file = Path::new(&b.path).join("recovery.bundle");
            let mut bytes = fs::read(&file).unwrap();
            let n = bytes.len();
            bytes[n - 1] ^= 1;
            fs::write(&file, bytes).unwrap();
            m.confirm_remove(&s, REMOVE, confirmation(&a, &b)).unwrap();
            let done = recycle_tests::wait(&m, &s, REMOVE);
            assert_eq!(done.state, "failed");
            assert_eq!(done.delete_dispatched, Some(false));
            assert!(Path::new(&a.retained_path).exists());
            let checked = m.recovery_check(&s, &b.id, b.revision).unwrap();
            assert_eq!(checked.recoveries[0].availability, "changed");
        },
    );
}
#[test]
fn remove_cold_dispatched_record_survives_next_intent_and_reconciles_exact_absence() {
    recycle_tests::isolated(
        "worktrees::remove_boundary_tests::remove_cold_dispatched_record_survives_next_intent_and_reconciles_exact_absence",
        || {
            let r = Repo::new();
            let s = tests::store();
            let m = Worktrees::default();
            let l = recycle_tests::created(&m, &s, &r);
            let a = fixture::archive(&m, &s, &l);
            let o = fixture::prepare_removal(&m, &s, &a);
            let b = o.recovery.unwrap();
            m.cancel(&s, REMOVE).unwrap();
            // Controlled persisted dispatch/lost result, not a claim of a real process crash.
            let (raw, mut doc) = storage::read(&s).unwrap();
            let op = doc.operation.as_mut().unwrap();
            let intent = op.removal.as_mut().unwrap();
            intent.dispatched = true;
            intent.confirmation = Some(confirmation(&a, &b));
            op.status.state = "unknown".into();
            op.status.settled = true;
            op.status.maintenance_active = false;
            op.status.delete_dispatched = Some(true);
            op.status.removal_phase = Some("deleting".into());
            doc.archives[0].removal_operation = Some(REMOVE.into());
            doc.archives[0].archive.availability = "unknown".into();
            storage::save(&s, &raw, &doc).unwrap();
            let cold = Worktrees::default();
            cold.list(&s).unwrap();
            cold.acknowledge(&s, REMOVE).unwrap();
            // Replace the current intent with an unrelated, explicit existing-root adoption.
            let inspect = cold.inspect(&s, r.root.to_str().unwrap()).unwrap();
            let other = "92345678-1234-4123-8123-123456789abc";
            cold.adopt(&s, other, &inspect.inspection_id, &inspect.root)
                .unwrap();
            let list = cold.recycle_check(&s, &a.id, a.revision).unwrap();
            assert_eq!(list.archives[0].availability, "unknown");
            assert_eq!(list.operation.unwrap().operation_id, other);
            assert!(cold.remove_inspect(&s, &a.id, a.revision + 1).is_err());
            assert!(
                cold.recycle_inspect(&s, RecycleAction::Restore, &a.id, a.revision + 1)
                    .is_err()
            );
            // Own fixture simulates the already dispatched Git command finishing later.
            git(&r.root, &["worktree", "remove", "--", &a.retained_path]);
            let resolved = cold.recycle_check(&s, &a.id, a.revision + 1).unwrap();
            assert!(resolved.archives.is_empty());
            assert_eq!(resolved.recoveries[0].id, b.id);
            assert_eq!(resolved.operation.unwrap().operation_id, other);
        },
    );
}
#[test]
fn remove_cold_contract_rejects_misaligned_recovery_and_duplicate_ids() {
    recycle_tests::isolated(
        "worktrees::remove_boundary_tests::remove_cold_contract_rejects_misaligned_recovery_and_duplicate_ids",
        || {
            let r = Repo::new();
            let s = tests::store();
            let m = Worktrees::default();
            let l = recycle_tests::created(&m, &s, &r);
            let a = fixture::archive(&m, &s, &l);
            let o = fixture::prepare_removal(&m, &s, &a);
            assert_eq!(o.state, "prepared");
            m.cancel(&s, REMOVE).unwrap();
            let (_, good) = storage::read(&s).unwrap();
            assert!(good.valid());
            let mut cases = Vec::new();
            let mut bad = good.clone();
            bad.recoveries[0].receipt.head_oid = "0".repeat(40);
            cases.push(("mismatched source head", bad));
            let mut bad = good.clone();
            bad.recoveries[0].receipt.original_path = "/independent/other-original".into();
            cases.push(("mismatched original path", bad));
            let mut bad = good.clone();
            bad.recoveries.push(bad.recoveries[0].clone());
            cases.push(("duplicate recovery identity", bad));
            let mut bad = good.clone();
            bad.operation
                .as_mut()
                .unwrap()
                .status
                .recovery
                .as_mut()
                .unwrap()
                .manifest_sha256 = "0".repeat(64);
            cases.push(("mismatched status manifest", bad));
            let mut bad = good;
            bad.operation.as_mut().unwrap().status.target_path = Some("/other".into());
            cases.push(("remove has create destination", bad));
            let admitted: Vec<_> = cases
                .into_iter()
                .filter_map(|(label, doc)| doc.valid().then_some(label))
                .collect();
            assert!(
                admitted.is_empty(),
                "invalid cold shapes admitted: {admitted:?}"
            );
        },
    );
}
#[test]
fn remove_cancelled_retirement_keeps_maintenance_until_worker_returns() {
    recycle_tests::isolated(
        "worktrees::remove_boundary_tests::remove_cancelled_retirement_keeps_maintenance_until_worker_returns",
        || {
            let r = Repo::new();
            let s = tests::store();
            let m = Worktrees::default();
            let l = recycle_tests::created(&m, &s, &r);
            let a = fixture::archive(&m, &s, &l);
            let p = m.remove_inspect(&s, &a.id, a.revision).unwrap();
            let (tx, rx) = std::sync::mpsc::channel();
            let (release, held) = std::sync::mpsc::channel();
            let worker = m.clone();
            let store = s.clone();
            let task = std::thread::spawn(move || {
                worker.prepare_remove(
                    &store,
                    REMOVE,
                    RemoveInput {
                        inspection_id: p.inspection_id,
                        expected_draft_baseline: p.draft_baseline,
                    },
                    |_| {
                        tx.send(()).unwrap();
                        held.recv_timeout(std::time::Duration::from_secs(10))
                            .unwrap();
                        Ok(())
                    },
                )
            });
            rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
            let cancelled = tests::op(m.cancel(&s, REMOVE).unwrap());
            assert_eq!(cancelled.state, "cancelling");
            assert!(cancelled.maintenance_active);
            assert!(!cancelled.settled);
            assert!(m.seal_exit(Some(&s), true).is_err());
            assert!(
                s.set_setting("late.fixture", &serde_json::json!(true))
                    .is_err()
            );
            assert!(Path::new(&a.retained_path).exists());
            release.send(()).unwrap();
            task.join().unwrap().unwrap();
            let done = recycle_tests::wait(&m, &s, REMOVE);
            assert_eq!(done.state, "cancelled", "{done:?}");
            assert!(!done.maintenance_active);
            assert_eq!(done.delete_dispatched, Some(false));
            assert!(m.list(&s).unwrap().recoveries.is_empty());
            assert!(Path::new(&a.retained_path).exists());
            s.set_setting("late.fixture", &serde_json::json!(true))
                .unwrap();
        },
    );
}

// Preserve child inodes/bytes while replacing only the explicitly selected parent.
// This is a stable external replacement probe, not an OS-wide exclusion claim.
fn replace_parent_keep_children(path: &Path) {
    let holder = tempfile::tempdir().unwrap();
    let old = holder.path().join("previous-parent");
    fs::rename(path, &old).unwrap();
    fs::create_dir(path).unwrap();
    for entry in fs::read_dir(&old).unwrap() {
        let entry = entry.unwrap();
        fs::rename(entry.path(), path.join(entry.file_name())).unwrap();
    }
}
#[test]
fn removal_identity_backup_rejects_parent_replacement_before_build() {
    recycle_tests::isolated(
        "worktrees::remove_boundary_tests::removal_identity_backup_rejects_parent_replacement_before_build",
        || {
            let r = Repo::new();
            let s = tests::store();
            let m = Worktrees::default();
            let l = recycle_tests::created(&m, &s, &r);
            let a = fixture::archive(&m, &s, &l);
            let (_, doc) = storage::read(&s).unwrap();
            let saved = doc.archives[0].clone();
            let cancel = AtomicBool::new(false);
            let plan = removal::capture(&saved, &cancel).unwrap();
            let root = Path::new(&saved.parent).join(".farfold-recovery-identity-test");
            fs::create_dir(&root).unwrap();
            replace_parent_keep_children(Path::new(&saved.parent));
            let result = recovery_pack::build(
                REMOVE,
                &saved,
                &plan,
                "62345678-1234-4123-8123-123456789abc",
                &root,
                &inspect::stamp(&root).unwrap(),
                &cancel,
            );
            assert!(
                result.is_err(),
                "replaced parent was accepted as a fresh backup baseline"
            );
            assert!(!root.join("recovery.bundle").exists());
            assert!(Path::new(&a.retained_path).exists());
        },
    );
}
#[test]
fn removal_identity_deleted_requires_original_retained_parent() {
    recycle_tests::isolated(
        "worktrees::remove_boundary_tests::removal_identity_deleted_requires_original_retained_parent",
        || {
            let r = Repo::new();
            let s = tests::store();
            let m = Worktrees::default();
            let l = recycle_tests::created(&m, &s, &r);
            let a = fixture::archive(&m, &s, &l);
            let o = fixture::prepare_removal(&m, &s, &a);
            let b = o.recovery.unwrap();
            m.confirm_remove(&s, REMOVE, confirmation(&a, &b)).unwrap();
            assert_eq!(recycle_tests::wait(&m, &s, REMOVE).state, "ready");
            let (_, doc) = storage::read(&s).unwrap();
            let intent = doc.operation.unwrap().removal.unwrap();
            let cancel = AtomicBool::new(false);
            removal::verify_deleted(&intent, &cancel).unwrap();
            replace_parent_keep_children(Path::new(&intent.saved.retained_parent));
            assert!(
                removal::verify_deleted(&intent, &cancel).is_err(),
                "absence inside a replacement parent must not become a deletion receipt"
            );
            assert!(Path::new(&b.path).join("recovery.bundle").exists());
        },
    );
}
#[test]
fn removal_identity_recovered_repository_rejects_replaced_parent() {
    recycle_tests::isolated(
        "worktrees::remove_boundary_tests::removal_identity_recovered_repository_rejects_replaced_parent",
        || {
            let r = Repo::new();
            let s = tests::store();
            let m = Worktrees::default();
            let l = recycle_tests::created(&m, &s, &r);
            let a = fixture::archive(&m, &s, &l);
            let o = fixture::prepare_removal(&m, &s, &a);
            let b = o.recovery.unwrap();
            m.cancel(&s, REMOVE).unwrap();
            let destination = tempfile::tempdir().unwrap();
            let parent = destination.path().canonicalize().unwrap();
            let id = "52345678-1234-4123-8123-123456789abc";
            let prepared = tests::op(
                m.prepare_recover(
                    &s,
                    id,
                    RecoverInput {
                        recovery_id: b.id,
                        expected_revision: b.revision,
                        parent_path: parent.to_str().unwrap().into(),
                        directory_name: "restored".into(),
                    },
                )
                .unwrap(),
            );
            assert_eq!(prepared.state, "prepared");
            m.start(&s, id).unwrap();
            assert_eq!(recycle_tests::wait(&m, &s, id).state, "ready");
            let (_, doc) = storage::read(&s).unwrap();
            let intent = doc.operation.unwrap().recovery.unwrap();
            replace_parent_keep_children(&parent);
            assert!(recover::verify(&intent, &AtomicBool::new(false)).is_err());
            assert_eq!(fs::read(parent.join("restored/a.txt")).unwrap(), b"fixture");
        },
    );
}

#[test]
fn removal_leaf_reservation_cannot_be_replaced_or_prepopulated() {
    recycle_tests::isolated(
        "worktrees::remove_boundary_tests::removal_leaf_reservation_cannot_be_replaced_or_prepopulated",
        || {
            let r = Repo::new();
            let s = tests::store();
            let m = Worktrees::default();
            let l = recycle_tests::created(&m, &s, &r);
            let a = fixture::archive(&m, &s, &l);
            let (_, doc) = storage::read(&s).unwrap();
            let saved = doc.archives[0].clone();
            let cancel = AtomicBool::new(false);
            let plan = removal::capture(&saved, &cancel).unwrap();
            let mut failures = vec![];
            for (name, replace) in [("replaced", true), ("occupied", false)] {
                let root = Path::new(&saved.parent).join(format!(".farfold-recovery-{name}"));
                fs::create_dir(&root).unwrap();
                let stamp = inspect::stamp(&root).unwrap();
                if replace {
                    replace_parent_keep_children(&root);
                }
                let canary = root.join("recovery.bundle");
                if !replace {
                    fs::write(&canary, b"external canary").unwrap();
                }
                let result = recovery_pack::build(
                    REMOVE,
                    &saved,
                    &plan,
                    "62345678-1234-4123-8123-123456789abc",
                    &root,
                    &stamp,
                    &cancel,
                );
                if result.is_ok() {
                    failures.push(format!("{name} accepted"));
                }
                if !replace && fs::read(canary).unwrap() != b"external canary" {
                    failures.push("existing file overwritten".into());
                }
            }
            assert!(Path::new(&a.retained_path).exists());
            assert!(failures.is_empty(), "{failures:?}");
        },
    );
}
