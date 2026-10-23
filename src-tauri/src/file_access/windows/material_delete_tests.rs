//! Dedicated owners must reject shared aliases and original private extra data.
use super::*;
use std::{fs, fs::OpenOptions, os::windows::fs::OpenOptionsExt};
use windows_sys::Wdk::Storage::FileSystem::NtSetEaFile;
fn ea(path: &Path) {
    let writer = OpenOptions::new()
        .access_mode(FILE_WRITE_EA | SYNCHRONIZE)
        .open(path)
        .unwrap();
    let name = b"owned-remove-ea";
    let mut raw = Vec::new();
    raw.extend(0u32.to_le_bytes());
    raw.extend([0, name.len() as u8]);
    raw.extend(3u16.to_le_bytes());
    raw.extend(name);
    raw.push(0);
    raw.extend([0, 255, 4]);
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
#[ignore = "manual: actual NTFS and pre-existing full SACL access; no privilege adjustment"]
fn actual_delete_owner_refuses_live_arc_and_private_ads_ea_then_deletes_only_original_leaf() {
    let temp = crate::test_support::tempdir().unwrap();
    let root_path = temp.path().join("original");
    fs::create_dir(&root_path).unwrap();
    fs::write(root_path.join("plain"), b"original data").unwrap();
    fs::write(root_path.join("ads"), b"default data").unwrap();
    fs::write(root_path.join("ads:extra:$DATA"), b"retained named data").unwrap();
    fs::write(root_path.join("ea"), b"retained ea data").unwrap();
    ea(&root_path.join("ea"));
    let cancel = AtomicBool::new(false);
    let memory = super::super::MixedMemory::default();
    let mut work = WorkBudget::new(crate::file_access::MATERIAL_WORK_LIMIT);
    let root = WorktreeDeleteNode::root(&root_path, &memory, &cancel).unwrap();
    let entries = root.entries(4, &mut work, &cancel).unwrap();
    for name in ["ads", "ea"] {
        let raw: Vec<u16> = name.encode_utf16().collect();
        let node = root.child(&raw, &entries[&raw], &cancel).unwrap();
        assert!(matches!(
            node.require_plain(&memory, &mut work, &cancel),
            Err(Error::Unsupported)
        ));
    }
    let raw: Vec<u16> = "plain".encode_utf16().collect();
    let node = root.child(&raw, &entries[&raw], &cancel).unwrap();
    node.require_plain(&memory, &mut work, &cancel).unwrap();
    let alias = node.material();
    assert!(matches!(
        node.remove(&raw, &mut Vec::new()),
        Err(Error::Unsupported)
    ));
    assert_eq!(fs::read(root_path.join("plain")).unwrap(), b"original data");
    drop(alias);
    let node = root.child(&raw, &entries[&raw], &cancel).unwrap();
    node.remove(&raw, &mut Vec::new()).unwrap();
    fs::write(root_path.join("late"), b"never selected").unwrap();
    assert!(root.remove(&[], &mut Vec::new()).is_err());
    assert_eq!(fs::read(root_path.join("late")).unwrap(), b"never selected");
    assert_eq!(
        fs::read(root_path.join("ads:extra:$DATA")).unwrap(),
        b"retained named data"
    );
    assert_eq!(fs::read(root_path.join("ea")).unwrap(), b"retained ea data");
}
