use super::*;
use std::{
    fs::OpenOptions,
    os::windows::fs::OpenOptionsExt,
    panic::{AssertUnwindSafe, catch_unwind},
};
use windows_sys::Win32::Storage::FileSystem::{FILE_READ_ATTRIBUTES, SYNCHRONIZE};

#[test]
fn real_label_query_keeps_same_file_and_directory_full_identity_without_privilege_adjustment() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let path = root.join("owned.txt");
    std::fs::write(&path, b"data").unwrap();
    let cancel = AtomicBool::new(false);
    for pin in [
        PinnedPath::directory(&root).unwrap(),
        PinnedPath::regular(&path).unwrap(),
    ] {
        let before = stamp(pin.file()).unwrap();
        let mut budget = WorkBudget::new(2 * QUERY_BYTES as u64);
        let first = observation(&pin, &mut budget, &cancel).unwrap();
        assert_eq!(observation(&pin, &mut budget, &cancel).unwrap(), first);
        assert_eq!(stamp(pin.file()).unwrap(), before);
    }
    assert_eq!(std::fs::read(path).unwrap(), b"data");
}
#[test]
fn label_query_missing_read_control_is_a_real_error_not_absent_label() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().canonicalize().unwrap().join("owned.txt");
    std::fs::write(&path, b"data").unwrap();
    let file = OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES | SYNCHRONIZE)
        .open(path)
        .unwrap();
    assert_eq!(
        query(&file, &mut WorkBudget::new(65536), &AtomicBool::new(false)),
        Err(Failure::Io {
            phase: "labelQuery",
            code: Some(5)
        })
    );
}
#[test]
fn busy_poison_cancel_and_small_offer_never_produce_an_empty_label() {
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
            panic!("owned label poison control");
        }))
        .is_err()
    );
    assert_eq!(
        observation(&pin, &mut WorkBudget::new(65536), &cancel),
        Err(Failure::Poisoned)
    );
}
