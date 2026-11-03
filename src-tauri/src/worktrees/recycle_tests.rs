use super::tests::{OP, Repo, git, input, op, store};
use super::*;
use std::{
    path::Path,
    sync::atomic::AtomicBool,
    time::{Duration, Instant},
};
const ARCH: &str = "22345678-1234-4123-8123-123456789abc";
const RESTORE: &str = "32345678-1234-4123-8123-123456789abc";
fn wire(label: &str, value: &impl serde::Serialize) {
    println!(
        "RECYCLE_WIRE {}",
        serde_json::to_string(&serde_json::json!({"label":label,"value":value})).unwrap()
    );
}
pub(super) fn wait(m: &Worktrees, s: &crate::meta_store::MetaStore, id: &str) -> Operation {
    wait_with_timeout(m, s, id, Duration::from_secs(20))
}
pub(super) fn wait_with_timeout(
    m: &Worktrees,
    s: &crate::meta_store::MetaStore,
    id: &str,
    timeout: Duration,
) -> Operation {
    let deadline = Instant::now() + timeout;
    loop {
        let o = op(m.status(s, id).unwrap());
        if o.settled && !o.maintenance_active {
            return o;
        }
        assert!(Instant::now() < deadline, "{o:?}");
        std::thread::sleep(Duration::from_millis(5));
    }
}
pub(super) fn created(m: &Worktrees, s: &crate::meta_store::MetaStore, r: &Repo) -> Location {
    created_with_timeout(m, s, r, Duration::from_secs(20))
}
pub(super) fn created_with_timeout(
    m: &Worktrees,
    s: &crate::meta_store::MetaStore,
    r: &Repo,
    timeout: Duration,
) -> Location {
    let args = input(
        m,
        s,
        r,
        Branch::New {
            name: "retained-fixture".into(),
            start_oid: git(&r.root, &["rev-parse", "HEAD"]),
        },
        "owned",
    );
    m.prepare(s, OP, args).unwrap();
    m.start(s, OP).unwrap();
    let result = wait_with_timeout(m, s, OP, timeout);
    assert_eq!(result.state, "ready");
    result.location.unwrap()
}
pub(super) fn prepare(
    m: &Worktrees,
    s: &crate::meta_store::MetaStore,
    id: &str,
    p: RecycleInspection,
) -> Operation {
    op(m.prepare_recycle(
        s,
        id,
        RecycleInput {
            inspection_id: p.inspection_id,
            action: p.action,
            expected_draft_baseline: p.draft_baseline,
        },
        |_| Ok(()),
    )
    .unwrap())
}
// Production uses one global gate. Isolate only tests that take its write side;
// never serialize or alter the actual application's gate for test convenience.
pub(crate) fn isolated(name: &str, body: impl FnOnce()) {
    isolated_with_timeout(name, Duration::from_secs(90), body);
}

pub(super) fn isolated_with_timeout(name: &str, timeout: Duration, body: impl FnOnce()) {
    let args: Vec<_> = std::env::args().collect();
    if args.iter().any(|s| s == name) && args.iter().any(|s| s == "--exact") {
        body();
        eprintln!("completed:{name}");
        return;
    }
    use std::io::{Read, Seek, SeekFrom};
    let mut stdout = tempfile::tempfile().unwrap();
    let mut stderr = tempfile::tempfile().unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([name, "--exact", "--test-threads=1", "--nocapture"])
        .stdout(stdout.try_clone().unwrap())
        .stderr(stderr.try_clone().unwrap())
        .spawn()
        .unwrap();
    let end = Instant::now() + timeout;
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        if Instant::now() > end {
            let _ = child.kill();
            let _ = child.wait();
            fn tail(file: &mut std::fs::File) -> String {
                let end = file.seek(SeekFrom::End(0)).unwrap();
                file.seek(SeekFrom::Start(end.saturating_sub(262144)))
                    .unwrap();
                let mut bytes = Vec::new();
                file.take(262144).read_to_end(&mut bytes).unwrap();
                String::from_utf8_lossy(&bytes).into_owned()
            }
            panic!(
                "isolated maintenance test deadline: {name}\nstdout:\n{}\nstderr:\n{}",
                tail(&mut stdout),
                tail(&mut stderr)
            );
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    stdout.rewind().unwrap();
    stderr.rewind().unwrap();
    let mut out = String::new();
    stdout.take(262144).read_to_string(&mut out).unwrap();
    stderr.take(262144).read_to_string(&mut out).unwrap();
    assert!(
        status.success() && out.contains(&format!("completed:{name}")),
        "{out}"
    );
    eprintln!("{out}");
}
#[test]
fn retains_dirty_staged_ignored_symlink_and_restores_same_object_without_migrating_history() {
    isolated(
        "worktrees::recycle_tests::retains_dirty_staged_ignored_symlink_and_restores_same_object_without_migrating_history",
        || {
            let r = Repo::new();
            let s = store();
            let m = Worktrees::default();
            let l = created(&m, &s, &r);
            let root = Path::new(&l.path);
            std::fs::write(root.join(".gitignore"), "ignored\n").unwrap();
            std::fs::write(root.join("ignored"), "ignored retained").unwrap();
            std::fs::write(root.join("untracked"), "untracked retained").unwrap();
            std::fs::write(root.join("a.txt"), "staged").unwrap();
            git(root, &["add", "a.txt"]);
            std::fs::write(root.join("a.txt"), "dirty retained").unwrap();
            #[cfg(unix)]
            std::os::unix::fs::symlink("a.txt", root.join("alias")).unwrap();
            let row = crate::acp_client::session_index::touch_session_row(
                &s,
                "fixture",
                &l.path,
                "native",
                Some("historical"),
                None,
            )
            .unwrap();
            let main_index = std::fs::read(r.root.join(".git/index")).unwrap();
            let p = m
                .recycle_inspect(&s, RecycleAction::Archive, &l.id, l.revision)
                .unwrap();
            assert!(p.blockers.is_empty());
            assert_eq!(p.impact.conversations, 1);
            let expected = p.material.clone();
            wire("archiveInspection", &p);
            let prepared = prepare(&m, &s, ARCH, p);
            wire("archivePrepared", &prepared);
            wire("preparedList", &m.list(&s).unwrap());
            assert!(prepared.maintenance_active);
            assert_eq!(prepared.state, "prepared");
            assert!(!prepared.settled);
            assert!(root.exists());
            assert!(crate::managed_update::activity().is_err());
            assert!(m.seal_exit(Some(&s), true).is_err());
            assert!(s.set_setting("late", &serde_json::json!(1)).is_err());
            assert!(m.check_location(&s, &l.id).is_err());
            assert!(m.list(&s).unwrap().locations.is_empty());
            assert_eq!(m.list(&s).unwrap().archives.len(), 1);
            wire("archiveRunning", &m.start(&s, ARCH).unwrap());
            let archived = wait(&m, &s, ARCH);
            assert_eq!(archived.state, "ready", "{archived:?}");
            wire("archiveReady", &archived);
            wire("archivedList", &m.list(&s).unwrap());
            let a = archived.archive.unwrap();
            assert!(!root.exists());
            assert_eq!(
                material_scan::capture(Path::new(&a.retained_path), &AtomicBool::new(false))
                    .unwrap(),
                expected
            );
            assert_eq!(
                std::fs::read(r.root.join(".git/index")).unwrap(),
                main_index
            );
            assert_eq!(s.get_session(&row.id).unwrap().unwrap().cwd, l.path);
            assert!(m.forget(&s, &a.id, a.revision).is_err());
            assert!(m.check_location(&s, &a.id).is_err());
            let cold = Worktrees::default();
            let list = cold.list(&s).unwrap();
            wire("coldList", &list);
            assert_eq!(list.archives[0].availability, "unknown");
            assert!(
                cold.recycle_inspect(&s, RecycleAction::Restore, &a.id, a.revision)
                    .is_err()
            );
            let checked = cold.recycle_check(&s, &a.id, a.revision).unwrap();
            wire("checkedList", &checked);
            let a = &checked.archives[0];
            assert_eq!(a.availability, "verified");
            let p = cold
                .recycle_inspect(&s, RecycleAction::Restore, &a.id, a.revision)
                .unwrap();
            prepare(&cold, &s, RESTORE, p);
            cold.start(&s, RESTORE).unwrap();
            let restored = wait(&cold, &s, RESTORE);
            assert_eq!(restored.state, "ready", "{restored:?}");
            wire("restoreReady", &restored);
            wire("restoredList", &cold.list(&s).unwrap());
            let l2 = restored.location.unwrap();
            assert_eq!(l2.id, l.id);
            assert_eq!(l2.path, l.path);
            assert!(cold.list(&s).unwrap().archives.is_empty());
            assert_eq!(
                std::fs::read(root.join("a.txt")).unwrap(),
                b"dirty retained"
            );
            assert_eq!(s.get_session(&row.id).unwrap().unwrap(), row);
        },
    );
}
#[test]
fn maintenance_cancel_waits_for_retirement_and_never_moves_before_start() {
    isolated(
        "worktrees::recycle_tests::maintenance_cancel_waits_for_retirement_and_never_moves_before_start",
        || {
            let r = Repo::new();
            let s = store();
            let m = Worktrees::default();
            let l = created(&m, &s, &r);
            let p = m
                .recycle_inspect(&s, RecycleAction::Archive, &l.id, l.revision)
                .unwrap();
            let (enter, entered) = std::sync::mpsc::channel();
            let (release, hold) = std::sync::mpsc::channel();
            let mm = m.clone();
            let ss = s.clone();
            let job = std::thread::spawn(move || {
                mm.prepare_recycle(
                    &ss,
                    ARCH,
                    RecycleInput {
                        inspection_id: p.inspection_id,
                        action: p.action,
                        expected_draft_baseline: p.draft_baseline,
                    },
                    |_| {
                        enter.send(()).unwrap();
                        hold.recv_timeout(Duration::from_secs(5)).unwrap();
                        Ok(())
                    },
                )
                .unwrap()
            });
            entered.recv_timeout(Duration::from_secs(5)).unwrap();
            let cancelled = op(m.cancel(&s, ARCH).unwrap());
            assert!(cancelled.maintenance_active);
            assert!(!cancelled.settled);
            assert!(crate::managed_update::exclusive().is_err());
            assert!(Path::new(&l.path).exists());
            release.send(()).unwrap();
            job.join().unwrap();
            let result = wait(&m, &s, ARCH);
            assert_eq!(result.state, "cancelled");
            assert!(m.list(&s).unwrap().archives.is_empty());
            assert_eq!(m.list(&s).unwrap().locations[0].id, l.id);
            assert!(crate::managed_update::activity().is_ok());
            s.set_setting("late", &serde_json::json!(1)).unwrap();
        },
    );
}
#[test]
fn stale_drafts_material_and_restore_destination_are_rejected_without_mutation() {
    isolated(
        "worktrees::recycle_tests::stale_drafts_material_and_restore_destination_are_rejected_without_mutation",
        || {
            let r = Repo::new();
            let s = store();
            let m = Worktrees::default();
            let l = created(&m, &s, &r);
            let p = m
                .recycle_inspect(&s, RecycleAction::Archive, &l.id, l.revision)
                .unwrap();
            s.set_setting("agentSetup.v1", &serde_json::json!({"version":1}))
                .unwrap();
            let result = prepare(&m, &s, ARCH, p);
            assert_eq!(result.state, "failed");
            wire("draftChanged", &result);
            assert_eq!(result.code.as_deref(), Some("draftChanged"));
            assert!(!result.maintenance_active);
            assert_eq!(result.action, "archive");
            assert!(Path::new(&l.path).exists());
            let p = m
                .recycle_inspect(&s, RecycleAction::Archive, &l.id, l.revision)
                .unwrap();
            std::fs::write(Path::new(&l.path).join("new"), "changed after preview").unwrap();
            let result = prepare(&m, &s, RESTORE, p);
            assert_eq!(result.state, "failed");
            assert_eq!(result.code.as_deref(), Some("materialChanged"));
            assert!(m.list(&s).unwrap().archives.is_empty());
        },
    );
}

#[test]
fn restore_checks_unsent_at_historical_original_cwd_and_prepare_rejections_keep_exact_action() {
    isolated(
        "worktrees::recycle_tests::restore_checks_unsent_at_historical_original_cwd_and_prepare_rejections_keep_exact_action",
        || {
            let r = Repo::new();
            let s = store();
            let m = Worktrees::default();
            let l = created(&m, &s, &r);
            let row = crate::acp_client::session_index::touch_session_row(
                &s, "fixture", &l.path, "native", None, None,
            )
            .unwrap();
            let p = m
                .recycle_inspect(&s, RecycleAction::Archive, &l.id, l.revision)
                .unwrap();
            prepare(&m, &s, ARCH, p);
            m.start(&s, ARCH).unwrap();
            let a = wait(&m, &s, ARCH).archive.unwrap();
            s.set_setting("unsentWork.v1",&serde_json::json!({"version":1,"composers":{format!("session:{}",row.id):{"text":"preserve unsent","attachments":[]}},"feedback":{},"queues":{}})).unwrap();
            let p = m
                .recycle_inspect(&s, RecycleAction::Restore, &a.id, a.revision)
                .unwrap();
            assert!(
                p.impact.unsent,
                "restoring the original cwd must inspect its saved unsent work"
            );
            assert!(p.blockers.contains(&"unsentWork".into()));
        },
    );
}
#[test]
fn forgotten_record_after_preview_returns_settled_failure_not_unqueryable_error() {
    isolated(
        "worktrees::recycle_tests::forgotten_record_after_preview_returns_settled_failure_not_unqueryable_error",
        || {
            let r = Repo::new();
            let s = store();
            let m = Worktrees::default();
            let l = created(&m, &s, &r);
            let p = m
                .recycle_inspect(&s, RecycleAction::Archive, &l.id, l.revision)
                .unwrap();
            m.forget(&s, &l.id, l.revision).unwrap();
            let reply = m.prepare_recycle(
                &s,
                ARCH,
                RecycleInput {
                    inspection_id: p.inspection_id,
                    action: p.action,
                    expected_draft_baseline: p.draft_baseline,
                },
                |_| Ok(()),
            );
            let failed = op(reply.expect("known non-dispatch is an exact terminal receipt"));
            assert_eq!(failed.state, "failed");
            assert_eq!(failed.action, "archive");
            assert!(!failed.maintenance_active);
            assert_eq!(op(m.status(&s, ARCH).unwrap()).state, "failed");
            assert!(Path::new(&l.path).exists());
        },
    );
}
#[test]
fn cancel_before_recycle_prepare_retires_exact_action_without_future_move() {
    isolated(
        "worktrees::recycle_tests::cancel_before_recycle_prepare_retires_exact_action_without_future_move",
        || {
            let r = Repo::new();
            let s = store();
            let m = Worktrees::default();
            let l = created(&m, &s, &r);
            let p = m
                .recycle_inspect(&s, RecycleAction::Archive, &l.id, l.revision)
                .unwrap();
            m.cancel(&s, ARCH).unwrap();
            let cancelled = prepare(&m, &s, ARCH, p);
            assert_eq!(cancelled.state, "cancelled");
            assert_eq!(cancelled.action, "archive");
            assert!(!cancelled.maintenance_active);
            assert!(Path::new(&l.path).exists());
        },
    );
}

#[test]
fn retained_record_survives_unknown_ack_and_never_adopts_a_replacement_or_overwrites_restore_path()
{
    isolated(
        "worktrees::recycle_tests::retained_record_survives_unknown_ack_and_never_adopts_a_replacement_or_overwrites_restore_path",
        || {
            let r = Repo::new();
            let s = store();
            let m = Worktrees::default();
            let l = created(&m, &s, &r);
            let p = m
                .recycle_inspect(&s, RecycleAction::Archive, &l.id, l.revision)
                .unwrap();
            prepare(&m, &s, ARCH, p);
            m.start(&s, ARCH).unwrap();
            let a = wait(&m, &s, ARCH).archive.unwrap();
            std::fs::create_dir(&a.original_path).unwrap();
            std::fs::write(Path::new(&a.original_path).join("outside"), "must keep").unwrap();
            assert_eq!(
                m.recycle_inspect(&s, RecycleAction::Restore, &a.id, a.revision)
                    .unwrap_err()
                    .code,
                "targetExists"
            );
            assert_eq!(
                std::fs::read_to_string(Path::new(&a.original_path).join("outside")).unwrap(),
                "must keep"
            );
            let list = m.recycle_check(&s, &a.id, a.revision).unwrap();
            assert_eq!(list.archives[0].availability, "unknown");
            assert!(list.locations.is_empty());
            m.acknowledge(&s, ARCH).unwrap();
            assert!(m.list(&s).unwrap().operation.unwrap().reviewed);
            assert_eq!(m.list(&s).unwrap().archives.len(), 1);
            // Remove only this test's empty collision, then externally move the saved
            // object away and place another directory at the same retained spelling.
            std::fs::remove_file(Path::new(&a.original_path).join("outside")).unwrap();
            std::fs::remove_dir(&a.original_path).unwrap();
            let moved = r._dir.path().join("externally-moved");
            std::fs::rename(&a.retained_path, &moved).unwrap();
            std::fs::create_dir(&a.retained_path).unwrap();
            let rev = list.archives[0].revision;
            let list = m.recycle_check(&s, &a.id, rev).unwrap();
            assert_eq!(list.archives[0].availability, "unknown");
            assert!(list.locations.is_empty());
            assert!(moved.join("a.txt").exists());
            assert!(Path::new(&a.retained_path).exists());
        },
    );
}
#[test]
fn abandoned_read_keeps_global_admission_until_actual_worker_finishes() {
    isolated(
        "worktrees::recycle_tests::abandoned_read_keeps_global_admission_until_actual_worker_finishes",
        || {
            let runtime = tokio::runtime::Runtime::new().unwrap();
            runtime.block_on(async {
                let (enter, entered) = tokio::sync::oneshot::channel();
                let (release, hold) = std::sync::mpsc::channel();
                let job = tokio::spawn(crate::file_read_check::run(move || {
                    enter.send(()).unwrap();
                    hold.recv_timeout(Duration::from_secs(5)).unwrap();
                    Ok(())
                }));
                tokio::time::timeout(Duration::from_secs(2), entered)
                    .await
                    .unwrap()
                    .unwrap();
                job.abort();
                assert!(job.await.unwrap_err().is_cancelled());
                assert!(crate::managed_update::exclusive().is_err());
                release.send(()).unwrap();
                let deadline = Instant::now() + Duration::from_secs(2);
                loop {
                    if let Ok(permit) = crate::managed_update::exclusive() {
                        drop(permit);
                        break;
                    }
                    assert!(Instant::now() < deadline);
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            });
        },
    );
}
#[test]
fn unowned_nested_special_and_submodule_material_is_not_moved() {
    isolated(
        "worktrees::recycle_tests::unowned_nested_special_and_submodule_material_is_not_moved",
        || {
            let r = Repo::new();
            let s = store();
            let m = Worktrees::default();
            let l = created(&m, &s, &r);
            let nested = Path::new(&l.path).join("nested");
            std::fs::create_dir_all(nested.join(".git")).unwrap();
            assert_eq!(
                m.recycle_inspect(&s, RecycleAction::Archive, &l.id, l.revision)
                    .unwrap_err()
                    .code,
                "nestedRepository"
            );
            std::fs::remove_dir(nested.join(".git")).unwrap();
            std::fs::remove_dir(&nested).unwrap();
            #[cfg(unix)]
            {
                let fifo = Path::new(&l.path).join("named-pipe");
                let name = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
                assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
                assert_eq!(
                    m.recycle_inspect(&s, RecycleAction::Archive, &l.id, l.revision)
                        .unwrap_err()
                        .code,
                    "specialFile"
                );
                std::fs::remove_file(fifo).unwrap();
            }
            std::fs::write(
                Path::new(&l.path).join(".gitmodules"),
                "retained unsupported",
            )
            .unwrap();
            assert_eq!(
                m.recycle_inspect(&s, RecycleAction::Archive, &l.id, l.revision)
                    .unwrap_err()
                    .code,
                "submodules"
            );
            assert!(Path::new(&l.path).exists());
            let inspection = m.inspect(&s, r.root.to_str().unwrap()).unwrap();
            let adopted = op(m
                .adopt(&s, RESTORE, &inspection.inspection_id, &inspection.root)
                .unwrap())
            .location
            .unwrap();
            assert_eq!(
                m.recycle_inspect(&s, RecycleAction::Archive, &adopted.id, adopted.revision)
                    .unwrap_err()
                    .code,
                "notOwned"
            );
        },
    );
}
#[test]
fn ended_prepare_unwind_has_an_exact_unknown_receipt_and_keeps_material_recheckable() {
    isolated(
        "worktrees::recycle_tests::ended_prepare_unwind_has_an_exact_unknown_receipt_and_keeps_material_recheckable",
        || {
            let r = Repo::new();
            let s = store();
            let m = Worktrees::default();
            let l = created(&m, &s, &r);
            let p = m
                .recycle_inspect(&s, RecycleAction::Archive, &l.id, l.revision)
                .unwrap();
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                m.prepare_recycle(
                    &s,
                    ARCH,
                    RecycleInput {
                        inspection_id: p.inspection_id,
                        action: p.action,
                        expected_draft_baseline: p.draft_baseline,
                    },
                    |_| panic!("controlled retirement owner unwind before any Git move"),
                )
            }));
            let o = op(m.status(&s, ARCH).unwrap());
            assert_eq!(o.state, "unknown");
            assert!(o.settled);
            assert!(!o.maintenance_active);
            assert!(Path::new(&l.path).exists());
            assert_eq!(m.list(&s).unwrap().archives.len(), 1);
            assert!(crate::managed_update::activity().is_ok());
        },
    );
}
#[test]
fn storage_version_one_migrates_read_only_and_version_two_does_not_omit_required_action() {
    let s = store();
    let raw = "{\"version\":1,\"locations\":[],\"materials\":[],\"operation\":null}";
    s.worktree_compare_write(None, raw).unwrap();
    let (original, doc) = storage::read(&s).unwrap();
    assert_eq!(doc.version, 3);
    assert_eq!(original.as_deref(), Some(raw));
    assert_eq!(s.worktree_raw().unwrap().as_deref(), Some(raw));
    let bad = "{\"version\":2,\"locations\":[],\"materials\":[],\"operation\":null}";
    s.worktree_compare_write(Some(raw), bad).unwrap();
    assert_eq!(storage::read(&s).unwrap_err().code, "storageInvalid");
}
#[test]
fn unreadable_storage_prepare_has_queryable_exact_failure_without_directory_io() {
    let s = store();
    s.worktree_compare_write(None, "{}").unwrap();
    let m = Worktrees::default();
    let r = m
        .prepare_recycle(
            &s,
            ARCH,
            RecycleInput {
                inspection_id: RESTORE.into(),
                action: RecycleAction::Archive,
                expected_draft_baseline: DraftBaseline {
                    unsent_work: None,
                    agent_setup: None,
                },
            },
            |_| panic!("must never retire or move"),
        )
        .unwrap();
    let o = op(r);
    assert_eq!(o.action, "archive");
    assert_eq!(o.state, "failed");
    assert!(!o.maintenance_active);
    assert_eq!(op(m.status(&s, ARCH).unwrap()).state, "failed");
    assert_eq!(op(m.cancel(&s, ARCH).unwrap()).state, "failed");
}
