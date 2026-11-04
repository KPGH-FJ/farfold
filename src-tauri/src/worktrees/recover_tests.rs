use super::{
    recovery_tests as fixture,
    tests::{self, Repo, git},
    *,
};
use std::{fs, path::Path};
const REMOVE: &str = "42345678-1234-4123-8123-123456789abc";
const RECOVER: &str = "52345678-1234-4123-8123-123456789abc";
// Actual recovery verification follows creation setup and needs its own test wait.
const RECOVER_WAIT: std::time::Duration =
    std::time::Duration::from_secs(if cfg!(windows) { 60 } else { 20 });
fn backup(m: &Worktrees, s: &crate::meta_store::MetaStore, r: &Repo) -> Recovery {
    let timeout = std::time::Duration::from_secs(if cfg!(windows) { 60 } else { 20 });
    let l = recycle_tests::created_with_timeout(m, s, r, timeout);
    let a = fixture::archive(m, s, &l);
    let o = fixture::prepare_removal(m, s, &a);
    assert_eq!(o.state, "prepared", "{o:?}");
    let recovery = o.recovery.unwrap();
    m.cancel(s, REMOVE).unwrap();
    recovery
}
fn input(r: &Repo, b: &Recovery, name: &str) -> RecoverInput {
    RecoverInput {
        recovery_id: b.id.clone(),
        expected_revision: b.revision,
        parent_path: r
            ._dir
            .path()
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
            .into(),
        directory_name: name.into(),
    }
}
#[test]
fn recover_explicit_new_folder_is_independent_existing_and_cold_never_restarts() {
    recycle_tests::isolated_with_timeout(
        "worktrees::recover_tests::recover_explicit_new_folder_is_independent_existing_and_cold_never_restarts",
        std::time::Duration::from_secs(if cfg!(windows) { 240 } else { 90 }),
        || {
            let r = Repo::new();
            let s = tests::store();
            let m = Worktrees::default();
            let b = backup(&m, &s, &r);
            let i = input(&r, &b, "recovered");
            let target = Path::new(&i.parent_path).join(&i.directory_name);
            let p = tests::op(m.prepare_recover(&s, RECOVER, i.clone()).unwrap());
            assert_eq!(p.state, "prepared", "{p:?}");
            assert_eq!(p.action, "recover");
            assert!(!p.maintenance_active);
            assert!(!target.exists());
            let mut different = i.clone();
            different.directory_name = "not-the-request".into();
            assert_eq!(
                m.prepare_recover(&s, RECOVER, different).unwrap_err().code,
                "operationConflict"
            );
            let objects = r.root.join(".git/objects");
            let offline = r.root.join(".git/offline-objects");
            fs::rename(&objects, &offline).unwrap();
            m.start(&s, RECOVER).unwrap();
            m.start(&s, RECOVER).unwrap();
            let done = recycle_tests::wait_with_timeout(&m, &s, RECOVER, RECOVER_WAIT);
            fs::rename(&offline, &objects).unwrap();
            assert_eq!(done.state, "ready", "{done:?}");
            let l = done.location.unwrap();
            assert_eq!(l.path, target.to_str().unwrap());
            assert_eq!(l.path, l.repository_root);
            assert_eq!(l.ownership, "existing");
            assert_eq!(l.head_oid, b.head_oid);
            assert!(
                l.branch
                    .as_ref()
                    .unwrap()
                    .starts_with("refs/heads/recovery/")
            );
            assert_eq!(fs::read(target.join("a.txt")).unwrap(), b"fixture");
            assert!(tests::recovered_remotes(&target).is_empty());
            assert!(!target.join(".git/objects/info/alternates").exists());
            assert_eq!(m.check_location(&s, &l.id).unwrap().ownership, "existing");
            assert!(
                m.recycle_inspect(&s, RecycleAction::Archive, &l.id, l.revision + 1)
                    .is_err()
            );
            let cold = Worktrees::default();
            let old = cold.list(&s).unwrap();
            assert_eq!(old.operation.as_ref().unwrap().state, "unknown");
            assert_eq!(tests::op(cold.start(&s, RECOVER).unwrap()).state, "unknown");
            assert_eq!(tests::op(cold.recheck(&s, RECOVER).unwrap()).state, "ready");
            assert_eq!(cold.list(&s).unwrap().recoveries.len(), 1);
        },
    );
}
#[test]
fn recover_cancelled_prepare_never_creates_and_existing_destination_is_preserved() {
    recycle_tests::isolated_with_timeout(
        "worktrees::recover_tests::recover_cancelled_prepare_never_creates_and_existing_destination_is_preserved",
        std::time::Duration::from_secs(if cfg!(windows) { 240 } else { 90 }),
        || {
            let r = Repo::new();
            let s = tests::store();
            let m = Worktrees::default();
            let b = backup(&m, &s, &r);
            let i = input(&r, &b, "cancelled");
            m.prepare_recover(&s, RECOVER, i.clone()).unwrap();
            let cancelled = tests::op(m.cancel(&s, RECOVER).unwrap());
            assert_eq!(cancelled.state, "cancelled");
            assert_eq!(cancelled.action, "recover");
            assert_eq!(tests::op(m.start(&s, RECOVER).unwrap()).state, "cancelled");
            assert!(!Path::new(&i.parent_path).join(&i.directory_name).exists());
            let occupied = Path::new(&i.parent_path).join("occupied");
            fs::create_dir(&occupied).unwrap();
            fs::write(occupied.join("keep"), "unchanged").unwrap();
            let id = "62345678-1234-4123-8123-123456789abc";
            let failed = tests::op(
                m.prepare_recover(&s, id, input(&r, &b, "occupied"))
                    .unwrap(),
            );
            assert_eq!(failed.state, "failed");
            assert_eq!(failed.code.as_deref(), Some("targetExists"));
            assert_eq!(failed.action, "recover");
            assert_eq!(fs::read(occupied.join("keep")).unwrap(), b"unchanged");
        },
    );
}
#[test]
fn recover_keeps_private_ref_and_orphan_reflog_only_commits_offline() {
    recycle_tests::isolated_with_timeout(
        "worktrees::recover_tests::recover_keeps_private_ref_and_orphan_reflog_only_commits_offline",
        std::time::Duration::from_secs(if cfg!(windows) { 240 } else { 90 }),
        || {
            let r = Repo::new();
            let s = tests::store();
            let m = Worktrees::default();
            let l = recycle_tests::created(&m, &s, &r);
            let path = Path::new(&l.path);
            let base = git(path, &["rev-parse", "HEAD"]);
            fs::write(path.join("a.txt"), "orphan-only").unwrap();
            git(path, &["commit", "-qam", "orphan only"]);
            let orphan = git(path, &["rev-parse", "HEAD"]);
            git(path, &["reset", "--hard", &base]);
            fs::write(path.join("a.txt"), "private-only").unwrap();
            git(path, &["commit", "-qam", "private only"]);
            let private = git(path, &["rev-parse", "HEAD"]);
            git(path, &["reset", "--hard", &base]);
            git(path, &["update-ref", "refs/worktree/kept", &private]);
            let snap = inspect::snapshot(path).unwrap();
            let dir = Path::new(&snap.git_dir);
            fs::create_dir_all(dir.join("logs/refs/worktree")).unwrap();
            fs::write(
                dir.join("logs/HEAD"),
                format!("{base} {base} Fixture <f@example.invalid> 1 +0000\tbase\n"),
            )
            .unwrap();
            fs::write(dir.join("ORIG_HEAD"), format!("{base}\n")).unwrap();
            fs::write(
                dir.join("logs/refs/worktree/deleted"),
                format!("{orphan} {base} Fixture <f@example.invalid> 1 +0000\tdeleted ref\n"),
            )
            .unwrap();
            let a = fixture::archive(&m, &s, &l);
            let o = fixture::prepare_removal(&m, &s, &a);
            assert_eq!(o.state, "prepared", "{o:?}");
            let b = o.recovery.unwrap();
            assert_eq!(b.root_count, 3);
            m.cancel(&s, REMOVE).unwrap();
            let objects = r.root.join(".git/objects");
            let offline = r.root.join(".git/offline-objects");
            fs::rename(&objects, &offline).unwrap();
            let args = input(&r, &b, "all-private-roots");
            let prepared = m.prepare_recover(&s, RECOVER, args.clone());
            let outcome = prepared
                .and_then(|_| m.start(&s, RECOVER))
                .map(|_| recycle_tests::wait_with_timeout(&m, &s, RECOVER, RECOVER_WAIT));
            fs::rename(&offline, &objects).unwrap();
            let ready = outcome.unwrap();
            assert_eq!(ready.state, "ready", "{ready:?}");
            let target = Path::new(&args.parent_path).join(args.directory_name);
            let roots = git(
                &target,
                &[
                    "for-each-ref",
                    "--format=%(objectname)",
                    "refs/heads/recovery/",
                ],
            );
            for oid in [&base, &orphan, &private] {
                assert!(roots.lines().any(|l| l == oid));
                assert_eq!(git(&target, &["cat-file", "-t", oid]), "commit");
            }
            assert_eq!(fs::read(target.join("a.txt")).unwrap(), b"fixture");
        },
    );
}

#[test]
fn recover_cancel_during_validation_has_exact_action_and_keeps_worker_admission() {
    recycle_tests::isolated_with_timeout(
        "worktrees::recover_tests::recover_cancel_during_validation_has_exact_action_and_keeps_worker_admission",
        std::time::Duration::from_secs(if cfg!(windows) { 240 } else { 90 }),
        || {
            let r = Repo::new();
            let s = tests::store();
            let m = Worktrees::default();
            let b = backup(&m, &s, &r);
            let args = input(&r, &b, "withdrawn-validation");
            let (entered_tx, entered_rx) = std::sync::mpsc::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let worker = m.clone();
            let store = s.clone();
            let input = args.clone();
            let handle = std::thread::spawn(move || {
                worker.prepare_recover_checked(&store, RECOVER, input, move |input, recovery| {
                    entered_tx.send(()).unwrap();
                    release_rx
                        .recv_timeout(std::time::Duration::from_secs(10))
                        .unwrap();
                    recover::prepare(&super::material_owner::Owner::default(), input, recovery)
                })
            });
            entered_rx
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap();
            m.cancel(&s, RECOVER).unwrap();
            assert!(crate::managed_update::exclusive().is_err());
            release_tx.send(()).unwrap();
            let result = tests::op(handle.join().unwrap().unwrap());
            assert_eq!(result.state, "cancelled");
            assert_eq!(result.action, "recover");
            assert!(result.settled);
            assert!(
                !Path::new(&args.parent_path)
                    .join(args.directory_name)
                    .exists()
            );
            assert!(crate::managed_update::exclusive().is_ok());
        },
    );
}
