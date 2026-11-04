use super::{
    tests::{Repo, git},
    *,
};
use std::{fs, path::Path, sync::atomic::AtomicBool, time::Duration};
#[test]
fn recovery_content_has_no_inode_identity_but_preserves_empty_material() {
    #[cfg(windows)]
    super::recovery_ordinary_windows_tests::assert_recovery_material_identity();
    #[cfg(unix)]
    assert_unix_recovery_material_identity();
}

#[cfg(unix)]
fn assert_unix_recovery_material_identity() {
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
    let operation_wait = Duration::from_secs(if cfg!(windows) { 60 } else { 20 });
    let prepare_wait = Duration::from_secs(if cfg!(windows) { 60 } else { 30 });
    recycle_tests::isolated_with_timeout(
        "worktrees::recovery_tests::recovery_two_confirmations_preserve_branch_and_restore_without_source_objects",
        Duration::from_secs(if cfg!(windows) { 240 } else { 90 }),
        || {
            let r = Repo::new();
            let s = tests::store();
            let m = Worktrees::default();
            let l = recycle_tests::created_with_timeout(&m, &s, &r, operation_wait);
            let arch = "22345678-1234-4123-8123-123456789abc";
            let remove = "42345678-1234-4123-8123-123456789abc";
            let p = m
                .recycle_inspect(&s, RecycleAction::Archive, &l.id, l.revision)
                .unwrap();
            recycle_tests::prepare(&m, &s, arch, p);
            m.start(&s, arch).unwrap();
            let a = recycle_tests::wait_with_timeout(&m, &s, arch, operation_wait)
                .archive
                .unwrap();
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
            let prepared = wait_prepared(&m, &s, remove, prepare_wait);
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
            m.confirm_remove(&s, remove, c.clone()).unwrap();
            let done = recycle_tests::wait_with_timeout(&m, &s, remove, operation_wait);
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
            // Replay while the removal is still the current persisted operation.
            let cold = Worktrees::default();
            assert_eq!(cold.list(&s).unwrap().recoveries[0].availability, "unknown");
            let replay = tests::op(cold.confirm_remove(&s, remove, c).unwrap());
            assert_eq!(replay.state, "unknown");
            assert_eq!(replay.delete_dispatched, Some(true));
            let parent = r._dir.path().canonicalize().unwrap();
            let destination = parent.join("restored");
            let objects = r.root.join(".git/objects");
            let offline = r.root.join(".git/objects.offline");
            fs::rename(&objects, &offline).unwrap();
            #[cfg(unix)]
            {
                let raw = fs::read(Path::new(&recovery.path).join("manifest.json")).unwrap();
                let manifest: recovery_pack::Manifest = serde_json::from_slice(&raw).unwrap();
                recovery_pack::recover_into(
                    &Path::new(&recovery.path).join("recovery.bundle"),
                    &manifest,
                    &destination,
                    &AtomicBool::new(false),
                )
                .unwrap();
            }
            #[cfg(windows)]
            {
                let canonical = &list.recoveries[0];
                let restore = "52345678-1234-4123-8123-123456789abc";
                let prepared = tests::op(
                    m.prepare_recover(
                        &s,
                        restore,
                        RecoverInput {
                            recovery_id: canonical.id.clone(),
                            expected_revision: canonical.revision,
                            parent_path: parent.to_str().unwrap().into(),
                            directory_name: "restored".into(),
                        },
                    )
                    .unwrap(),
                );
                assert_eq!(prepared.state, "prepared", "{prepared:?}");
                assert!(!destination.exists());
                m.start(&s, restore).unwrap();
                let ready = recycle_tests::wait_with_timeout(&m, &s, restore, operation_wait);
                assert_eq!(ready.state, "ready", "{ready:?}");
                let location = ready.location.unwrap();
                assert_eq!(location.ownership, "existing");
                assert_eq!(Path::new(&location.path), destination);
                assert!(!objects.exists());
            }
            fs::rename(&offline, &objects).unwrap();
            assert_eq!(fs::read(destination.join("a.txt")).unwrap(), b"fixture");
        },
    );
}
pub(super) fn wait_prepared(
    m: &Worktrees,
    s: &crate::meta_store::MetaStore,
    id: &str,
    timeout: std::time::Duration,
) -> Operation {
    let started = std::time::Instant::now();
    let end = started + timeout;
    #[cfg(windows)]
    let mut previous = None;
    loop {
        let o = tests::op(m.status(s, id).unwrap());
        #[cfg(windows)]
        {
            let phase = (o.state.clone(), o.removal_phase.clone(), o.settled);
            if previous.as_ref() != Some(&phase) {
                eprintln!(
                    "FARFOLD_REMOVE_PREPARE_WAIT {}",
                    serde_json::json!({"operationId":id,"elapsedMs":started.elapsed().as_millis(),
                        "budgetMs":timeout.as_millis(),"state":o.state,"phase":o.removal_phase,
                        "settled":o.settled,"deleteDispatched":o.delete_dispatched})
                );
                previous = Some(phase);
            }
        }
        if o.state == "prepared" || o.settled {
            return o;
        }
        assert!(
            std::time::Instant::now() < end,
            "recovery preparation did not finish after {:?} (budget {timeout:?}): {o:?}",
            started.elapsed()
        );
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
    let timeout = Duration::from_secs(if cfg!(windows) { 60 } else { 20 });
    recycle_tests::wait_with_timeout(m, s, id, timeout)
        .archive
        .unwrap()
}
type WorktreeArchiveAlias = Archive;
pub(super) const REMOVE: &str = "42345678-1234-4123-8123-123456789abc";
pub(super) fn prepare_removal(
    m: &Worktrees,
    s: &crate::meta_store::MetaStore,
    a: &Archive,
) -> Operation {
    let seconds = if cfg!(windows) { 60 } else { 30 };
    prepare_removal_with_timeout(m, s, a, Duration::from_secs(seconds))
}
pub(super) fn prepare_removal_with_timeout(
    m: &Worktrees,
    s: &crate::meta_store::MetaStore,
    a: &Archive,
    timeout: std::time::Duration,
) -> Operation {
    #[cfg(windows)]
    let started = std::time::Instant::now();
    #[cfg(windows)]
    let phase = |name| {
        eprintln!(
            "FARFOLD_REMOVE_PREPARE phase={name} elapsedMs={}",
            started.elapsed().as_millis()
        );
    };
    #[cfg(windows)]
    phase("inspect.enter");
    let p = m.remove_inspect(s, &a.id, a.revision).unwrap();
    #[cfg(windows)]
    phase("prepare.enter");
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
    #[cfg(windows)]
    phase("wait.enter");
    let prepared = wait_prepared(m, s, REMOVE, timeout);
    #[cfg(windows)]
    phase("wait.return");
    prepared
}
#[test]
fn recovery_refuses_assume_unchanged_bytes_and_ignored_empty_directories() {
    let operation_wait = Duration::from_secs(if cfg!(windows) { 60 } else { 20 });
    let prepare_wait = Duration::from_secs(if cfg!(windows) { 60 } else { 30 });
    recycle_tests::isolated_with_timeout(
        "worktrees::recovery_tests::recovery_refuses_assume_unchanged_bytes_and_ignored_empty_directories",
        Duration::from_secs(if cfg!(windows) { 360 } else { 90 }),
        || {
            for variant in ["assume", "empty"] {
                let r = Repo::new();
                fs::write(r.root.join(".gitignore"), "ignored/\n").unwrap();
                git(&r.root, &["add", "."]);
                git(&r.root, &["commit", "-qm", "ignore fixture"]);
                let s = tests::store();
                let m = Worktrees::default();
                let l = recycle_tests::created_with_timeout(&m, &s, &r, operation_wait);
                let path = Path::new(&l.path);
                if variant == "assume" {
                    git(path, &["update-index", "--assume-unchanged", "a.txt"]);
                    fs::write(path.join("a.txt"), "uncommitted protected bytes").unwrap();
                } else {
                    fs::create_dir(path.join("ignored")).unwrap();
                }
                let a = archive(&m, &s, &l);
                let retained = Path::new(&a.retained_path);
                let cancel = AtomicBool::new(false);
                let before = material_scan::capture(retained, &cancel).unwrap();
                let o = prepare_removal_with_timeout(&m, &s, &a, prepare_wait);
                assert_eq!(o.delete_dispatched, Some(false));
                #[cfg(unix)]
                {
                    assert_eq!(o.state, "failed", "{o:?}");
                    assert_eq!(o.code.as_deref(), Some("uncommittedMaterial"));
                    assert!(!o.maintenance_active);
                    assert_eq!(m.list(&s).unwrap().materials.len(), 1);
                }
                assert_eq!(material_scan::capture(retained, &cancel).unwrap(), before);
                assert_eq!(m.list(&s).unwrap().archives.len(), 1);
                #[cfg(windows)]
                {
                    // Windows prepares a complete material backup before offering deletion.
                    let target = restore_protected_fixture(&m, &s, o, operation_wait);
                    if variant == "assume" {
                        assert_eq!(
                            fs::read(target.join("a.txt")).unwrap(),
                            b"uncommitted protected bytes"
                        );
                    } else {
                        assert_eq!(fs::read(target.join("a.txt")).unwrap(), b"fixture");
                        let ignored = target.join("ignored");
                        assert!(ignored.is_dir());
                        assert!(fs::read_dir(ignored).unwrap().next().is_none());
                    }
                    assert_eq!(material_scan::capture(retained, &cancel).unwrap(), before);
                    let list = m.list(&s).unwrap();
                    assert_eq!(list.archives.len(), 1);
                    assert_eq!(list.recoveries.len(), 1);
                    assert!(list.materials.is_empty());
                    eprintln!("FARFOLD_RECOVERY_PROTECTED_MATERIAL verified={variant}");
                }
            }
        },
    );
}

#[cfg(windows)]
fn restore_protected_fixture(
    m: &Worktrees,
    s: &crate::meta_store::MetaStore,
    prepared: Operation,
    timeout: Duration,
) -> std::path::PathBuf {
    assert_eq!(prepared.state, "prepared", "{prepared:?}");
    assert_eq!(
        prepared.removal_phase.as_deref(),
        Some("awaitingConfirmation")
    );
    let recovery = prepared.recovery.unwrap();
    assert_eq!(recovery.availability, "verified");
    let cancelled = tests::op(m.cancel(s, REMOVE).unwrap());
    assert_eq!(cancelled.state, "cancelled", "{cancelled:?}");
    assert!(!cancelled.maintenance_active);
    assert_eq!(cancelled.delete_dispatched, Some(false));
    assert!(
        m.confirm_remove(
            s,
            REMOVE,
            RemoveConfirmation {
                record_id: recovery.archive_id.clone(),
                expected_revision: recovery.archive_revision,
                recovery_id: recovery.id.clone(),
                recovery_sha256: recovery.bundle_sha256,
                manifest_sha256: recovery.manifest_sha256,
            },
        )
        .is_err()
    );
    let parent = Path::new(&recovery.original_path).parent().unwrap();
    let directory_name = "restored-protected-material";
    let target = parent.join(directory_name);
    let recover = "52345678-1234-4123-8123-123456789abc";
    let prepared = tests::op(
        m.prepare_recover(
            s,
            recover,
            RecoverInput {
                recovery_id: recovery.id,
                expected_revision: recovery.revision,
                parent_path: parent.to_str().unwrap().into(),
                directory_name: directory_name.into(),
            },
        )
        .unwrap(),
    );
    assert_eq!(prepared.state, "prepared", "{prepared:?}");
    assert!(!target.exists());
    m.start(s, recover).unwrap();
    let restored = recycle_tests::wait_with_timeout(m, s, recover, timeout);
    assert_eq!(restored.state, "ready", "{restored:?}");
    let location = restored.location.unwrap();
    assert_eq!(location.ownership, "existing");
    assert_eq!(Path::new(&location.path), target);
    assert_eq!(location.repository_root, location.path);
    target
}

#[test]
fn recovery_cancel_prepared_keeps_verified_artifact_and_no_delete_authority() {
    recycle_tests::isolated_with_timeout(
        "worktrees::recovery_tests::recovery_cancel_prepared_keeps_verified_artifact_and_no_delete_authority",
        std::time::Duration::from_secs(if cfg!(windows) { 240 } else { 90 }),
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
