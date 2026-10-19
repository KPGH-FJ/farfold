use super::*;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::{fs::OpenOptions, os::windows::fs::OpenOptionsExt};

#[test]
fn actual_held_file_and_directory_security_are_stable_under_the_same_identity() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let path = root.join("owned.txt");
    std::fs::write(&path, b"same-data").unwrap();
    let cancel = AtomicBool::new(false);
    for pin in [
        PinnedPath::directory(&root).unwrap(),
        PinnedPath::regular(&path).unwrap(),
    ] {
        let identity = stamp(pin.file()).unwrap().identity;
        let mut budget = WorkBudget::new(2 * QUERY_BYTES as u64);
        let first = observation(&pin, &mut budget, &cancel).unwrap();
        assert_eq!(observation(&pin, &mut budget, &cancel).unwrap(), first);
        assert_eq!(stamp(pin.file()).unwrap().identity, identity);
        assert!(budget.remaining() < 2 * QUERY_BYTES as u64);
    }
}
#[test]
fn busy_cancel_small_budget_and_poison_do_not_produce_empty_descriptors() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let pin = PinnedPath::directory(&root).unwrap();
    let cancel = AtomicBool::new(false);
    let owner = pin.try_observation_owner().unwrap();
    assert_eq!(
        observation(&pin, &mut WorkBudget::new(65536), &cancel),
        Err(Failure::Busy)
    );
    drop(owner);
    assert_eq!(
        observation(&pin, &mut WorkBudget::new(19), &cancel),
        Err(Failure::Limit)
    );
    assert_eq!(
        observation(&pin, &mut WorkBudget::new(65536), &AtomicBool::new(true)),
        Err(Failure::Cancelled)
    );
    assert!(
        catch_unwind(AssertUnwindSafe(|| {
            let _owner = pin.try_observation_owner().unwrap();
            panic!("owned security poison control");
        }))
        .is_err()
    );
    assert_eq!(
        observation(&pin, &mut WorkBudget::new(65536), &cancel),
        Err(Failure::Poisoned)
    );
}

#[test]
fn missing_read_control_is_actual_access_denied_not_empty_security() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let path = root.join("owned.txt");
    std::fs::write(&path, b"owned").unwrap();
    let attributes_only = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES | SYNCHRONIZE)
        .open(&path)
        .unwrap();
    assert_eq!(
        query(
            &attributes_only,
            &mut WorkBudget::new(65536),
            &AtomicBool::new(false)
        ),
        Err(Failure::Io {
            phase: "securityQuery",
            code: Some(5)
        })
    );
}

#[test]
fn same_held_full_identity_observes_owned_dacl_change_without_reading_file_data() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let path = root.join("owned.txt");
    std::fs::write(&path, b"same-data").unwrap();
    let fixture = crate::file_access::security_test_fixture::OwnedDacl::new(&path);
    fixture.set("D:P(A;;FA;;;WD)");
    let pin = PinnedPath::regular(&path).unwrap();
    let identity = stamp(pin.file()).unwrap().identity;
    let cancel = AtomicBool::new(false);
    let a = observation(&pin, &mut WorkBudget::new(65536), &cancel).unwrap();
    fixture.set("D:P(A;;FR;;;WD)");
    let b = observation(&pin, &mut WorkBudget::new(65536), &cancel).unwrap();
    assert_eq!(stamp(pin.file()).unwrap().identity, identity);
    assert_ne!(a.sha256, b.sha256);
    assert_eq!(std::fs::read(&path).unwrap(), b"same-data");
    drop(pin);
    fixture.restore();
}
