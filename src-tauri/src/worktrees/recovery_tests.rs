use super::{
    tests::{Repo, git},
    *,
};
use std::{fs, path::Path, sync::atomic::AtomicBool};
#[test]
fn recovery_content_has_no_inode_identity_but_preserves_empty_material() {
    let t = tempfile::tempdir().unwrap();
    let a = t.path().canonicalize().unwrap().join("a");
    let b = t.path().canonicalize().unwrap().join("b");
    fs::create_dir(&a).unwrap();
    fs::create_dir(&b).unwrap();
    fs::write(a.join("same"), "x").unwrap();
    fs::write(b.join("same"), "x").unwrap();
    let c = AtomicBool::new(false);
    assert_ne!(
        material_scan::capture(&a, &c).unwrap(),
        material_scan::capture(&b, &c).unwrap()
    );
    assert_eq!(
        material_scan::content(&a, &c).unwrap(),
        material_scan::content(&b, &c).unwrap()
    );
    fs::create_dir(b.join("ignored-empty")).unwrap();
    assert_ne!(
        material_scan::content(&a, &c).unwrap(),
        material_scan::content(&b, &c).unwrap()
    );
}
#[test]
fn recovery_discovers_deleted_private_ref_log_and_orig_head_drift() {
    let r = Repo::new();
    let linked = r._dir.path().join("linked");
    git(
        &r.root,
        &["worktree", "add", "-b", "private", linked.to_str().unwrap()],
    );
    fs::write(linked.join("a.txt"), "second").unwrap();
    git(&linked, &["commit", "-qam", "second"]);
    let old = git(&linked, &["rev-parse", "HEAD"]);
    git(&linked, &["reset", "--hard", "HEAD~1"]);
    let s = inspect::snapshot(&linked).unwrap();
    let private = Path::new(&s.git_dir);
    fs::create_dir_all(private.join("logs/refs/worktree")).unwrap();
    let head = s.head.as_ref().unwrap();
    fs::write(
        private.join("logs/refs/worktree/deleted"),
        format!("{old} {head} Fixture <f@example.invalid> 1 +0000\torphan\n"),
    )
    .unwrap();
    let c = AtomicBool::new(false);
    let before = recovery_roots::capture(&s, &c).unwrap();
    assert!(before.commits.contains(&old));
    fs::write(
        private.join("logs/refs/worktree/deleted"),
        format!("{old} {head} Fixture <f@example.invalid> 2 +0000\torphan changed\n"),
    )
    .unwrap();
    let after = recovery_roots::capture(&s, &c).unwrap();
    assert_eq!(before.commits, after.commits);
    assert_ne!(before.summary().unwrap(), after.summary().unwrap());
    fs::write(private.join("ORIG_HEAD"), format!("{head}\n")).unwrap();
    assert_ne!(after, recovery_roots::capture(&s, &c).unwrap());
    fs::write(private.join("MERGE_HEAD"), format!("{old}\n")).unwrap();
    assert_eq!(
        recovery_roots::capture(&s, &c).unwrap_err().code,
        "unprovenPrivateCommits"
    );
}
#[test]
fn recovery_two_confirmations_preserve_branch_and_restore_without_source_objects() {
    recycle_tests::isolated(
        "worktrees::recovery_tests::recovery_two_confirmations_preserve_branch_and_restore_without_source_objects",
        || {
            let r = Repo::new();
            let s = tests::store();
            let m = Worktrees::default();
            let l = recycle_tests::created(&m, &s, &r);
            let arch = "22345678-1234-4123-8123-123456789abc";
            let remove = "42345678-1234-4123-8123-123456789abc";
            let p = m
                .recycle_inspect(&s, RecycleAction::Archive, &l.id, l.revision)
                .unwrap();
            recycle_tests::prepare(&m, &s, arch, p);
            m.start(&s, arch).unwrap();
            let a = recycle_tests::wait(&m, &s, arch).archive.unwrap();
            let p = m.remove_inspect(&s, &a.id, a.revision).unwrap();
            let reply = m
                .prepare_remove(
                    &s,
                    remove,
                    RemoveInput {
                        inspection_id: p.inspection_id,
                        expected_draft_baseline: p.draft_baseline,
                    },
                    |_| Ok(()),
                )
                .unwrap();
            assert_eq!(tests::op(reply).action, "remove");
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
            let prepared = loop {
                let o = tests::op(m.status(&s, remove).unwrap());
                if o.state == "prepared" || o.settled {
                    break o;
                }
                assert!(std::time::Instant::now() < deadline, "{o:?}");
                std::thread::sleep(std::time::Duration::from_millis(5));
            };
            assert_eq!(prepared.state, "prepared", "{prepared:?}");
            assert_eq!(
                prepared.removal_phase.as_deref(),
                Some("awaitingConfirmation")
            );
            assert!(prepared.maintenance_active);
            assert!(Path::new(&a.retained_path).exists());
            assert_eq!(
                m.start(&s, remove).unwrap_err().code,
                "confirmationRequired"
            );
            let recovery = prepared.recovery.unwrap();
            let c = RemoveConfirmation {
                record_id: a.id.clone(),
                expected_revision: a.revision,
                recovery_id: recovery.id.clone(),
                recovery_sha256: recovery.bundle_sha256.clone(),
                manifest_sha256: recovery.manifest_sha256.clone(),
            };
            let mut wrong = c.clone();
            wrong.recovery_sha256 = "0".repeat(64);
            assert_eq!(
                m.confirm_remove(&s, remove, wrong).unwrap_err().code,
                "operationConflict"
            );
            assert!(Path::new(&a.retained_path).exists());
            m.confirm_remove(&s, remove, c.clone()).unwrap();
            m.confirm_remove(&s, remove, c).unwrap();
            let done = recycle_tests::wait(&m, &s, remove);
            assert_eq!(done.state, "ready", "{done:?}");
            assert!(!Path::new(&a.retained_path).exists());
            assert_eq!(
                git(&r.root, &["rev-parse", a.branch.as_ref().unwrap()]),
                a.head_oid
            );
            let list = m.list(&s).unwrap();
            assert!(list.archives.is_empty());
            assert_eq!(list.recoveries.len(), 1);
            assert!(list.locations.is_empty());
            let raw = fs::read(Path::new(&recovery.path).join("manifest.json")).unwrap();
            let manifest: recovery_pack::Manifest = serde_json::from_slice(&raw).unwrap();
            let objects = r.root.join(".git/objects");
            let offline = r.root.join(".git/objects.offline");
            fs::rename(&objects, &offline).unwrap();
            let destination = r._dir.path().canonicalize().unwrap().join("restored");
            let actual = recovery_pack::recover_into(
                &Path::new(&recovery.path).join("recovery.bundle"),
                &manifest,
                &destination,
                &AtomicBool::new(false),
            );
            fs::rename(&offline, &objects).unwrap();
            actual.unwrap();
            assert_eq!(fs::read(destination.join("a.txt")).unwrap(), b"fixture");
            let cold = Worktrees::default();
            assert_eq!(cold.list(&s).unwrap().recoveries[0].availability, "unknown");
            assert!(
                cold.confirm_remove(
                    &s,
                    remove,
                    RemoveConfirmation {
                        record_id: a.id,
                        expected_revision: a.revision,
                        recovery_id: recovery.id,
                        recovery_sha256: recovery.bundle_sha256,
                        manifest_sha256: recovery.manifest_sha256
                    }
                )
                .is_ok()
            );
        },
    );
}
pub(super) fn wait_prepared(
    m: &Worktrees,
    s: &crate::meta_store::MetaStore,
    id: &str,
) -> Operation {
    let end = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let o = tests::op(m.status(s, id).unwrap());
        if o.state == "prepared" || o.settled {
            return o;
        }
        assert!(std::time::Instant::now() < end, "{o:?}");
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}
pub(super) fn archive(
    m: &Worktrees,
    s: &crate::meta_store::MetaStore,
    l: &Location,
) -> WorktreeArchiveAlias {
    let id = "22345678-1234-4123-8123-123456789abc";
    let p = m
        .recycle_inspect(s, RecycleAction::Archive, &l.id, l.revision)
        .unwrap();
    recycle_tests::prepare(m, s, id, p);
    m.start(s, id).unwrap();
    recycle_tests::wait(m, s, id).archive.unwrap()
}
type WorktreeArchiveAlias = Archive;
pub(super) const REMOVE: &str = "42345678-1234-4123-8123-123456789abc";
pub(super) fn prepare_removal(
    m: &Worktrees,
    s: &crate::meta_store::MetaStore,
    a: &Archive,
) -> Operation {
    let p = m.remove_inspect(s, &a.id, a.revision).unwrap();
    m.prepare_remove(
        s,
        REMOVE,
        RemoveInput {
            inspection_id: p.inspection_id,
            expected_draft_baseline: p.draft_baseline,
        },
        |_| Ok(()),
    )
    .unwrap();
    wait_prepared(m, s, REMOVE)
}
#[test]
fn recovery_refuses_assume_unchanged_bytes_and_ignored_empty_directories() {
    recycle_tests::isolated(
        "worktrees::recovery_tests::recovery_refuses_assume_unchanged_bytes_and_ignored_empty_directories",
        || {
            for variant in ["assume", "empty"] {
                let r = Repo::new();
                fs::write(r.root.join(".gitignore"), "ignored/\n").unwrap();
                git(&r.root, &["add", "."]);
                git(&r.root, &["commit", "-qm", "ignore fixture"]);
                let s = tests::store();
                let m = Worktrees::default();
                let l = recycle_tests::created(&m, &s, &r);
                let path = Path::new(&l.path);
                if variant == "assume" {
                    git(path, &["update-index", "--assume-unchanged", "a.txt"]);
                    fs::write(path.join("a.txt"), "uncommitted protected bytes").unwrap();
                } else {
                    fs::create_dir(path.join("ignored")).unwrap();
                }
                let a = archive(&m, &s, &l);
                let before =
                    material_scan::capture(Path::new(&a.retained_path), &AtomicBool::new(false))
                        .unwrap();
                let o = prepare_removal(&m, &s, &a);
                assert_eq!(o.state, "failed", "{o:?}");
                assert_eq!(o.code.as_deref(), Some("uncommittedMaterial"));
                assert!(!o.maintenance_active);
                assert_eq!(o.delete_dispatched, Some(false));
                assert_eq!(
                    material_scan::capture(Path::new(&a.retained_path), &AtomicBool::new(false))
                        .unwrap(),
                    before
                );
                assert_eq!(m.list(&s).unwrap().archives.len(), 1);
                assert_eq!(m.list(&s).unwrap().materials.len(), 1);
            }
        },
    );
}
#[test]
fn recovery_cancel_prepared_keeps_verified_artifact_and_no_delete_authority() {
    recycle_tests::isolated(
        "worktrees::recovery_tests::recovery_cancel_prepared_keeps_verified_artifact_and_no_delete_authority",
        || {
            let r = Repo::new();
            let s = tests::store();
            let m = Worktrees::default();
            let l = recycle_tests::created(&m, &s, &r);
            let a = archive(&m, &s, &l);
            let o = prepare_removal(&m, &s, &a);
            assert_eq!(o.state, "prepared", "{o:?}");
            let receipt = o.recovery.unwrap();
            let cancel = tests::op(m.cancel(&s, REMOVE).unwrap());
            assert_eq!(cancel.state, "cancelled");
            assert!(!cancel.maintenance_active);
            assert!(Path::new(&a.retained_path).exists());
            assert_eq!(m.list(&s).unwrap().recoveries.len(), 1);
            assert!(
                m.confirm_remove(
                    &s,
                    REMOVE,
                    RemoveConfirmation {
                        record_id: a.id,
                        expected_revision: a.revision,
                        recovery_id: receipt.id.clone(),
                        recovery_sha256: receipt.bundle_sha256,
                        manifest_sha256: receipt.manifest_sha256
                    }
                )
                .is_err()
            );
            let cold = Worktrees::default();
            assert_eq!(cold.list(&s).unwrap().recoveries[0].availability, "unknown");
            let list = cold
                .recovery_check(&s, &receipt.id, receipt.revision)
                .unwrap();
            assert_eq!(list.recoveries[0].availability, "verified");
            assert!(Path::new(&a.retained_path).exists());
        },
    );
}

#[test]
fn recovery_root_type_verification_honors_cancellation_before_next_git_read() {
    let r = Repo::new();
    let roots = std::collections::BTreeSet::from([git(&r.root, &["rev-parse", "HEAD"])]);
    let result = recovery_roots::verify_commits(&r.root, &roots, &AtomicBool::new(true));
    assert_eq!(result.unwrap_err().code, "cancelled");
}

#[test]
fn recovery_publication_does_not_replace_an_existing_file_or_follow_its_symlink() {
    let t = tempfile::tempdir().unwrap();
    let source = t.path().join("staged");
    fs::write(&source, b"verified fixture bytes").unwrap();
    let destination = t.path().join("recovery.bundle");
    fs::write(&destination, b"external canary").unwrap();
    assert_eq!(
        recovery_pack::publish_bundle(&source, &destination, &AtomicBool::new(false))
            .unwrap_err()
            .code,
        "targetExists"
    );
    assert_eq!(fs::read(&destination).unwrap(), b"external canary");
    #[cfg(unix)]
    {
        let alias = t.path().join("alias");
        std::os::unix::fs::symlink(&destination, &alias).unwrap();
        assert_eq!(
            recovery_pack::publish_bundle(&source, &alias, &AtomicBool::new(false))
                .unwrap_err()
                .code,
            "targetExists"
        );
        assert_eq!(fs::read(&destination).unwrap(), b"external canary");
    }
    let fresh = t.path().join("fresh");
    recovery_pack::publish_bundle(&source, &fresh, &AtomicBool::new(false)).unwrap();
    assert_eq!(fs::read(fresh).unwrap(), b"verified fixture bytes");
}
