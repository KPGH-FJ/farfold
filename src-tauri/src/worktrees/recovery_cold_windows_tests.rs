//! Recovery can be exercised while the original retained material still exists.
//! This does not replace the separate Remove + offline recovery control.
use super::{recovery_public_windows_tests::backup, *};
use crate::meta_store::MetaStore;
use std::{
    fs,
    path::Path,
    time::{Duration, Instant},
};

const RECOVER: &str = "77777777-7777-4777-8777-777777777777";

fn settled(manager: &Worktrees, store: &MetaStore) -> Operation {
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        let op = tests::op(manager.status(store, RECOVER).unwrap());
        if op.settled && !op.maintenance_active {
            return op;
        }
        assert!(Instant::now() < deadline, "recovery did not settle: {op:?}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
#[ignore = "manual: existing FullSecurity NTFS rights; retained backup, cold public Recover and explicit recheck without dispatching Remove"]
fn public_cold_recover_with_original_retained_keeps_source_and_requires_explicit_recheck() {
    let fixture = backup(false);
    let source = Path::new(&fixture.recovery().retained_path);
    let original_config = fs::read(fixture.main().join(".git/config")).unwrap();
    let original_pointer = fs::read(source.join(".git")).unwrap();
    let manifest = Path::new(&fixture.recovery().path).join("manifest.json");
    let original_manifest = fs::read(&manifest).unwrap();
    let store = MetaStore::open(fixture.database()).unwrap();
    let manager = Worktrees::default();
    let listing = manager.list(&store).unwrap();
    let cold = listing
        .recoveries
        .iter()
        .find(|r| r.id == fixture.recovery().id)
        .unwrap();
    assert_eq!(cold.availability, "unknown");
    let listing = manager
        .recovery_check(&store, &cold.id, cold.revision)
        .unwrap();
    let recovery = listing.recoveries.iter().find(|r| r.id == cold.id).unwrap();
    assert_eq!(recovery.availability, "verified");
    assert!(source.is_dir());
    assert_eq!(
        listing.operation.as_ref().unwrap().delete_dispatched,
        Some(false)
    );
    let target = fixture.parent().join("cold recovery with retained source");
    assert!(!target.exists());
    let reply = manager
        .prepare_recover(
            &store,
            RECOVER,
            RecoverInput {
                recovery_id: recovery.id.clone(),
                expected_revision: recovery.revision,
                parent_path: fixture.parent().to_str().unwrap().into(),
                directory_name: "cold recovery with retained source".into(),
            },
        )
        .unwrap();
    assert_eq!(tests::op(reply).state, "prepared");
    assert!(!target.exists());
    manager.start(&store, RECOVER).unwrap();
    let ready = settled(&manager, &store);
    assert_eq!(ready.state, "ready", "{ready:?}");
    assert_eq!(ready.location.as_ref().unwrap().ownership, "existing");
    for root in [source, target.as_path()] {
        assert_eq!(
            fs::read(root.join("payload.txt")).unwrap(),
            b"retained\ncontent\n"
        );
        assert_eq!(
            fs::read(root.join("payload.txt:retained:$DATA")).unwrap(),
            b"actual named stream"
        );
        assert_eq!(fs::read(root.join("untracked.bin")).unwrap(), [0, 255, 3]);
        assert!(root.join("empty retained directory").is_dir());
    }
    assert!(target.join(".git").is_dir());
    assert_eq!(
        fs::read(fixture.main().join(".git/config")).unwrap(),
        original_config
    );
    assert_eq!(fs::read(source.join(".git")).unwrap(), original_pointer);
    assert_eq!(fs::read(&manifest).unwrap(), original_manifest);
    drop(manager);
    drop(store);
    let store = MetaStore::open(fixture.database()).unwrap();
    let manager = Worktrees::default();
    assert_eq!(
        manager.list(&store).unwrap().operation.unwrap().state,
        "unknown"
    );
    assert_eq!(
        tests::op(manager.start(&store, RECOVER).unwrap()).state,
        "unknown"
    );
    let rechecked = tests::op(manager.recheck(&store, RECOVER).unwrap());
    assert_eq!(rechecked.state, "ready", "{rechecked:?}");
    assert!(source.is_dir());
    assert_eq!(fs::read(source.join(".git")).unwrap(), original_pointer);
}
