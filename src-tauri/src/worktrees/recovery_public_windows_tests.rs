//! Actual public operations on disposable NTFS repositories only.
//! These need pre-existing FullSecurity rights; no privilege change or fallback.
use super::*;
use crate::meta_store::MetaStore;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};
const CREATE: &str = "11111111-1111-4111-8111-111111111111";
const ARCHIVE: &str = "22222222-2222-4222-8222-222222222222";
const REMOVE: &str = "33333333-3333-4333-8333-333333333333";
const RECOVER: &str = "44444444-4444-4444-8444-444444444444";

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git.exe")
        .arg("-C")
        .arg(root)
        .args(["-c", "core.hooksPath=NUL", "-c", "core.fsmonitor=false"])
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "owned fixture Git failed: {args:?}"
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}
fn wait(manager: &Worktrees, store: &MetaStore, id: &str, prepared: bool) -> Operation {
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        let op = tests::op(manager.status(store, id).unwrap());
        if (prepared && op.state == "prepared") || (op.settled && !op.maintenance_active) {
            return op;
        }
        assert!(
            Instant::now() < deadline,
            "public operation did not settle: {op:?}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}
pub(super) struct Fixture {
    _temp: tempfile::TempDir,
    parent: PathBuf,
    database: PathBuf,
    main: PathBuf,
    recovery: Recovery,
}
impl Fixture {
    pub(super) fn parent(&self) -> &Path {
        &self.parent
    }
    pub(super) fn database(&self) -> &Path {
        &self.database
    }
    pub(super) fn main(&self) -> &Path {
        &self.main
    }
    pub(super) fn recovery(&self) -> &Recovery {
        &self.recovery
    }
}
pub(super) fn backup(delete: bool) -> Fixture {
    eprintln!("FARFOLD_PUBLIC_FIXTURE_REACHED phase=entered");
    let temporary = crate::test_support::tempdir().unwrap();
    let parent = PathBuf::from(inspect::canonical(temporary.path()).unwrap());
    let main = parent.join("owned main");
    fs::create_dir(&main).unwrap();
    git(&main, &["init", "-q"]);
    for (key, value) in [
        ("user.name", "Fixture"),
        ("user.email", "fixture@example.invalid"),
        ("core.autocrlf", "false"),
    ] {
        git(&main, &["config", key, value]);
    }
    fs::write(main.join("payload.txt"), b"retained\ncontent\n").unwrap();
    git(&main, &["add", "."]);
    git(&main, &["commit", "-qm", "owned root"]);
    let head = git(&main, &["rev-parse", "HEAD"]);
    eprintln!("FARFOLD_PUBLIC_FIXTURE_REACHED phase=owned-git-prepared");
    let database = parent.join("owned metadata.sqlite");
    let store = MetaStore::open(&database).unwrap();
    let manager = Worktrees::default();
    eprintln!("FARFOLD_PUBLIC_FIXTURE_REACHED phase=inspect-start");
    let inspection = manager.inspect(&store, main.to_str().unwrap()).unwrap();
    eprintln!("FARFOLD_PUBLIC_FIXTURE_REACHED phase=inspect-returned");
    let create = Create {
        inspection_id: inspection.inspection_id,
        parent_path: parent.to_str().unwrap().into(),
        directory_name: "owned linked".into(),
        branch: Branch::New {
            name: "retained-public-control".into(),
            start_oid: head.clone(),
        },
    };
    eprintln!("FARFOLD_PUBLIC_FIXTURE_REACHED phase=create-prepare-start");
    let prepared = tests::op(manager.prepare(&store, CREATE, create).unwrap());
    assert_eq!(
        prepared.state, "prepared",
        "FARFOLD_PUBLIC_FIXTURE_OPERATION phase=createPrepare code={:?} settled={}",
        prepared.code, prepared.settled
    );
    eprintln!("FARFOLD_PUBLIC_FIXTURE_REACHED phase=create-start");
    manager.start(&store, CREATE).unwrap();
    let created = wait(&manager, &store, CREATE, false);
    eprintln!("FARFOLD_PUBLIC_FIXTURE_REACHED phase=create-wait-returned");
    assert_eq!(
        created.state, "ready",
        "FARFOLD_PUBLIC_FIXTURE_OPERATION phase=createStart code={:?} settled={}",
        created.code, created.settled
    );
    let location = created.location.unwrap();
    let linked = Path::new(&location.path);
    fs::create_dir(linked.join("empty retained directory")).unwrap();
    fs::write(linked.join("untracked.bin"), [0, 255, 3]).unwrap();
    fs::write(
        linked.join("payload.txt:retained:$DATA"),
        b"actual named stream",
    )
    .unwrap();
    eprintln!("FARFOLD_PUBLIC_FIXTURE_REACHED phase=archive-inspect-start");
    let inspected = manager
        .recycle_inspect(
            &store,
            RecycleAction::Archive,
            &location.id,
            location.revision,
        )
        .unwrap();
    let input = RecycleInput {
        inspection_id: inspected.inspection_id,
        action: inspected.action,
        expected_draft_baseline: inspected.draft_baseline,
    };
    eprintln!("FARFOLD_PUBLIC_FIXTURE_REACHED phase=archive-prepare-start");
    assert_eq!(
        tests::op(
            manager
                .prepare_recycle(&store, ARCHIVE, input, |_| Ok(()))
                .unwrap()
        )
        .state,
        "prepared"
    );
    eprintln!("FARFOLD_PUBLIC_FIXTURE_REACHED phase=archive-start");
    manager.start(&store, ARCHIVE).unwrap();
    let archived = wait(&manager, &store, ARCHIVE, false);
    eprintln!("FARFOLD_PUBLIC_FIXTURE_REACHED phase=archive-wait-returned");
    assert_eq!(archived.state, "ready", "{archived:?}");
    let archive = archived.archive.unwrap();
    eprintln!("FARFOLD_PUBLIC_FIXTURE_REACHED phase=remove-inspect-start");
    let inspection = manager
        .remove_inspect(&store, &archive.id, archive.revision)
        .unwrap();
    eprintln!("FARFOLD_PUBLIC_FIXTURE_REACHED phase=remove-prepare-start");
    manager
        .prepare_remove(
            &store,
            REMOVE,
            RemoveInput {
                inspection_id: inspection.inspection_id,
                expected_draft_baseline: inspection.draft_baseline,
            },
            |_| Ok(()),
        )
        .unwrap();
    let prepared = wait(&manager, &store, REMOVE, true);
    eprintln!("FARFOLD_PUBLIC_FIXTURE_REACHED phase=remove-prepare-wait-returned");
    assert_eq!(prepared.state, "prepared", "{prepared:?}");
    assert_eq!(prepared.delete_dispatched, Some(false));
    assert!(Path::new(&archive.retained_path).is_dir());
    let recovery = prepared.recovery.unwrap();
    let artifact = Path::new(&recovery.path);
    let manifest: recovery_pack::Manifest =
        serde_json::from_slice(&fs::read(artifact.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest.version, 2);
    assert!(
        manifest.windows_material.as_ref().unwrap().content.nodes
            < manifest.windows_material.as_ref().unwrap().nodes.len() as u32
    );
    assert!(artifact.join("recovery.bundle").is_file());
    assert!(artifact.join("material.bin").is_file());
    if delete {
        eprintln!("FARFOLD_PUBLIC_FIXTURE_REACHED phase=remove-confirm-start");
        manager
            .confirm_remove(
                &store,
                REMOVE,
                RemoveConfirmation {
                    record_id: archive.id,
                    expected_revision: archive.revision,
                    recovery_id: recovery.id.clone(),
                    recovery_sha256: recovery.bundle_sha256.clone(),
                    manifest_sha256: recovery.manifest_sha256.clone(),
                },
            )
            .unwrap();
        let removed = wait(&manager, &store, REMOVE, false);
        eprintln!("FARFOLD_PUBLIC_FIXTURE_REACHED phase=remove-confirm-wait-returned");
        assert_eq!(removed.state, "ready", "{removed:?}");
        assert_eq!(removed.delete_dispatched, Some(true));
        assert!(!Path::new(&archive.retained_path).exists());
        assert_eq!(
            git(&main, &["rev-parse", "refs/heads/retained-public-control"]),
            head
        );
    } else {
        eprintln!("FARFOLD_PUBLIC_FIXTURE_REACHED phase=backup-cancel-start");
        assert_eq!(
            tests::op(manager.cancel(&store, REMOVE).unwrap()).state,
            "cancelled"
        );
        assert!(Path::new(&archive.retained_path).is_dir());
    }
    drop(manager);
    drop(store);
    eprintln!("FARFOLD_PUBLIC_FIXTURE_REACHED phase=fixture-return");
    Fixture {
        _temp: temporary,
        parent,
        database,
        main,
        recovery,
    }
}
fn checked(f: &Fixture, manager: &Worktrees, store: &MetaStore) -> Recovery {
    let listing = manager.list(store).unwrap();
    let cold = listing
        .recoveries
        .iter()
        .find(|r| r.id == f.recovery.id)
        .unwrap();
    assert_eq!(cold.availability, "unknown");
    let checked = manager
        .recovery_check(store, &cold.id, cold.revision)
        .unwrap();
    let recovery = checked
        .recoveries
        .iter()
        .find(|r| r.id == f.recovery.id)
        .unwrap()
        .clone();
    assert_eq!(recovery.availability, "verified");
    if listing
        .operation
        .as_ref()
        .is_some_and(|o| o.state == "unknown")
    {
        manager.acknowledge(store, REMOVE).unwrap();
    }
    recovery
}
fn request(f: &Fixture, recovery: &Recovery, leaf: &str) -> RecoverInput {
    RecoverInput {
        recovery_id: recovery.id.clone(),
        expected_revision: recovery.revision,
        parent_path: f.parent.to_str().unwrap().into(),
        directory_name: leaf.into(),
    }
}

#[test]
#[ignore = "manual: existing FullSecurity source/target rights on actual NTFS; public Create Archive Remove Recover, no privilege adjustment"]
fn public_remove_then_cold_recover_keeps_native_material_and_git_without_original_repository() {
    let f = backup(true);
    fs::remove_dir_all(&f.main).unwrap();
    assert!(!f.main.exists());
    let store = MetaStore::open(&f.database).unwrap();
    let manager = Worktrees::default();
    let recovery = checked(&f, &manager, &store);
    let target = f.parent.join("cold independent recovery");
    assert!(!target.exists());
    assert_eq!(
        tests::op(
            manager
                .prepare_recover(
                    &store,
                    RECOVER,
                    request(&f, &recovery, "cold independent recovery")
                )
                .unwrap()
        )
        .state,
        "prepared"
    );
    assert!(!target.exists());
    manager.start(&store, RECOVER).unwrap();
    let ready = wait(&manager, &store, RECOVER, false);
    assert_eq!(ready.state, "ready", "{ready:?}");
    assert_eq!(ready.location.as_ref().unwrap().ownership, "existing");
    assert_eq!(
        fs::read(target.join("payload.txt")).unwrap(),
        b"retained\ncontent\n"
    );
    assert_eq!(
        fs::read(target.join("payload.txt:retained:$DATA")).unwrap(),
        b"actual named stream"
    );
    assert_eq!(fs::read(target.join("untracked.bin")).unwrap(), [0, 255, 3]);
    assert!(target.join("empty retained directory").is_dir());
    assert!(target.join(".git").is_dir());
    assert_eq!(git(&target, &["rev-parse", "HEAD"]), recovery.head_oid);
    assert!(git(&target, &["remote"]).is_empty());
    git(&target, &["fsck", "--full", "--strict"]);
    assert!(!target.join(".git/objects/info/alternates").exists());
    drop(manager);
    drop(store);
    let store = MetaStore::open(&f.database).unwrap();
    let cold = Worktrees::default();
    assert_eq!(
        cold.list(&store).unwrap().operation.unwrap().state,
        "unknown"
    );
    assert_eq!(
        tests::op(cold.start(&store, RECOVER).unwrap()).state,
        "unknown"
    );
    let rechecked = tests::op(cold.recheck(&store, RECOVER).unwrap());
    assert_eq!(rechecked.state, "ready", "{rechecked:?}");
}

#[test]
#[ignore = "manual: existing FullSecurity rights; public cold recovery collision, cancellation and changed Manifest preserve original material"]
fn public_cold_recover_rejects_collision_cancel_and_changed_manifest_without_deletion() {
    let f = backup(false);
    let store = MetaStore::open(&f.database).unwrap();
    let manager = Worktrees::default();
    let recovery = checked(&f, &manager, &store);
    let occupied = f.parent.join("occupied");
    fs::create_dir(&occupied).unwrap();
    fs::write(occupied.join("keep"), b"foreign owned canary").unwrap();
    let rejected = tests::op(
        manager
            .prepare_recover(&store, RECOVER, request(&f, &recovery, "occupied"))
            .unwrap(),
    );
    assert_eq!(rejected.state, "failed");
    assert_eq!(rejected.code.as_deref(), Some("targetExists"));
    assert_eq!(
        fs::read(occupied.join("keep")).unwrap(),
        b"foreign owned canary"
    );
    let cancelled_id = "55555555-5555-4555-8555-555555555555";
    assert_eq!(
        tests::op(
            manager
                .prepare_recover(
                    &store,
                    cancelled_id,
                    request(&f, &recovery, "cancelled destination")
                )
                .unwrap()
        )
        .state,
        "prepared"
    );
    assert_eq!(
        tests::op(manager.cancel(&store, cancelled_id).unwrap()).state,
        "cancelled"
    );
    assert_eq!(
        tests::op(manager.start(&store, cancelled_id).unwrap()).state,
        "cancelled"
    );
    assert!(!f.parent.join("cancelled destination").exists());
    let manifest_path = Path::new(&recovery.path).join("manifest.json");
    let mut bytes = fs::read(&manifest_path).unwrap();
    bytes.push(b' ');
    fs::write(&manifest_path, &bytes).unwrap();
    let changed = tests::op(
        manager
            .prepare_recover(
                &store,
                "66666666-6666-4666-8666-666666666666",
                request(&f, &recovery, "changed destination"),
            )
            .unwrap(),
    );
    assert_eq!(changed.state, "failed");
    assert_eq!(changed.code.as_deref(), Some("recoveryChanged"));
    assert!(!f.parent.join("changed destination").exists());
    assert!(Path::new(&recovery.retained_path).is_dir());
    assert!(Path::new(&recovery.path).join("material.bin").is_file());
    assert_eq!(fs::read(&manifest_path).unwrap(), bytes);
}
