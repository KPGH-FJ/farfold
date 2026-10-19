use super::*;
use std::{
    fs::OpenOptions,
    os::windows::fs::OpenOptionsExt,
    panic::{AssertUnwindSafe, catch_unwind},
};
use windows_sys::Wdk::Storage::FileSystem::NtSetEaFile;

fn require_ntfs(pin: &PinnedPath) {
    let mut fs = [0u16; 32];
    assert_ne!(
        unsafe {
            GetVolumeInformationByHandleW(
                handle(pin.file()),
                ptr::null_mut(),
                0,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                fs.as_mut_ptr(),
                fs.len() as u32,
            )
        },
        0
    );
    let end = fs.iter().position(|v| *v == 0).unwrap();
    assert_eq!(
        String::from_utf16(&fs[..end]).unwrap(),
        "NTFS",
        "real owned NTFS is required, not skipped to success"
    );
}
// Explicit write permission exists ONLY in this owned fixture setup, closed
// before PinnedPath opens. It does not change any production access/share mask.
fn set_owned_ea(path: &Path, value: &[u8]) {
    let writer = OpenOptions::new()
        .access_mode(FILE_WRITE_EA | SYNCHRONIZE)
        .open(path)
        .unwrap();
    let name = b"farfold-public-owned";
    let mut raw = Vec::new();
    raw.extend(0u32.to_le_bytes());
    raw.extend([0, name.len() as u8]);
    raw.extend((value.len() as u16).to_le_bytes());
    raw.extend(name);
    raw.push(0);
    raw.extend(value);
    let mut ios = IO_STATUS_BLOCK::default();
    assert_eq!(
        unsafe {
            NtSetEaFile(
                handle(&writer),
                &mut ios,
                raw.as_ptr().cast(),
                raw.len() as u32,
            )
        },
        0
    );
}
#[test]
fn real_owned_ntfs_ea_is_read_on_the_same_handle_and_changes_with_opaque_value() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("owned.txt");
    std::fs::write(&path, b"same-default-data").unwrap();
    set_owned_ea(&path, b"first\0\xff");
    let cancel = AtomicBool::new(false);
    let first = {
        let pin = PinnedPath::regular(&path).unwrap();
        require_ntfs(&pin);
        let mut budget = WorkBudget::new(2 * QUERY_BYTES as u64);
        let before = observation(&pin, &mut budget, &cancel).unwrap();
        assert_eq!(before.count, 1);
        assert_eq!(observation(&pin, &mut budget, &cancel).unwrap(), before);
        before
    };
    set_owned_ea(&path, b"other\0\xff");
    let second = {
        let pin = PinnedPath::regular(&path).unwrap();
        observation(&pin, &mut WorkBudget::new(QUERY_BYTES as u64), &cancel).unwrap()
    };
    assert_ne!(first, second);
}
#[test]
fn same_owner_busy_cancel_and_poison_are_failures_not_empty_records() {
    let temp = tempfile::tempdir().unwrap();
    let pin = PinnedPath::directory(temp.path()).unwrap();
    require_ntfs(&pin);
    let cancel = AtomicBool::new(false);
    let owner = pin.try_observation_owner().unwrap();
    assert_eq!(
        observation(&pin, &mut WorkBudget::new(QUERY_BYTES as u64), &cancel),
        Err(Failure::Busy)
    );
    drop(owner);
    assert_eq!(
        observation(
            &pin,
            &mut WorkBudget::new(QUERY_BYTES as u64),
            &AtomicBool::new(true)
        ),
        Err(Failure::Cancelled)
    );
    assert!(
        catch_unwind(AssertUnwindSafe(|| {
            let _owner = pin.try_observation_owner().unwrap();
            panic!("owned poison control");
        }))
        .is_err()
    );
    assert_eq!(
        observation(&pin, &mut WorkBudget::new(QUERY_BYTES as u64), &cancel),
        Err(Failure::Poisoned)
    );
}
