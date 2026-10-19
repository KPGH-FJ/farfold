//! Real owned NTFS directory tree only, not regular/alias/full restore.
use super::{Slot, error};
use crate::file_access::{
    CarrierFailure as E, DirectoryTreeMemory, DirectoryTreeReceipt, DirectoryTreeRequest,
    DirectoryTreeRetirement, EaWorkBudget as WorkBudget, PinnedPath, directory_tree_roundtrip,
};
use std::{
    ffi::OsString,
    fs::OpenOptions,
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        fs::OpenOptionsExt,
        io::AsRawHandle,
    },
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};
use windows_sys::{
    Wdk::Storage::FileSystem::NtSetEaFile,
    Win32::{
        Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_WRITE_EA,
            GetVolumeInformationByHandleW, SYNCHRONIZE,
        },
        System::IO::IO_STATUS_BLOCK,
    },
};
fn request(path: &Path, full: bool, memory: &DirectoryTreeMemory) -> DirectoryTreeRequest {
    let p = path.canonicalize().unwrap();
    let pin = if full {
        PinnedPath::directory_full_security(&p).unwrap()
    } else {
        PinnedPath::directory(&p).unwrap()
    };
    let mut fs = [0u16; 32];
    assert_ne!(
        unsafe {
            GetVolumeInformationByHandleW(
                pin.file().as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                fs.as_mut_ptr(),
                32,
            )
        },
        0
    );
    assert_eq!(
        String::from_utf16(&fs[..fs.iter().position(|v| *v == 0).unwrap()]).unwrap(),
        "NTFS"
    );
    DirectoryTreeRequest::held(
        pin,
        p.file_name().unwrap().encode_wide().collect(),
        memory,
        &AtomicBool::new(false),
    )
    .unwrap()
}
fn ea(path: &Path) {
    let f = OpenOptions::new()
        .access_mode(FILE_WRITE_EA | SYNCHRONIZE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .unwrap();
    let mut b = vec![0u8; 8];
    b[5] = 1;
    b[6..8].copy_from_slice(&2u16.to_le_bytes());
    b.extend(b"X\0\0\xff");
    let mut ios = IO_STATUS_BLOCK::default();
    assert_eq!(
        unsafe {
            NtSetEaFile(
                f.as_raw_handle(),
                &mut ios,
                b.as_ptr().cast(),
                b.len() as u32,
            )
        },
        0
    );
}
fn ads(path: &Path) -> PathBuf {
    let mut p = path.as_os_str().to_os_string();
    p.push(":shape:$DATA");
    let p = PathBuf::from(p);
    std::fs::write(&p, b"directory-tree\0\xff").unwrap();
    p
}
fn run(request: DirectoryTreeRequest, work: u64, cancel: bool) -> Result<DirectoryTreeReceipt, E> {
    let slot = Slot::<DirectoryTreeRetirement>::default();
    let mut value = None;
    let outer = slot.run(|retired| {
        value = Some(directory_tree_roundtrip(
            request,
            &mut WorkBudget::new(work),
            &AtomicBool::new(cancel),
            retired,
        ));
        match value.as_ref().unwrap() {
            Ok(_) => Ok(()),
            Err(_) => Err(error("treeFailed")),
        }
    });
    assert!(
        !slot.occupied(),
        "native unknown remains an occupied failure, never a successful directory tree"
    );
    match value {
        Some(v) => v,
        None => panic!("Slot refused {outer:?}"),
    }
}
fn finished(r: &DirectoryTreeReceipt, n: usize, full: bool) {
    assert_eq!(r.directories, n);
    assert_eq!(r.explicit_full_security, full);
    assert!(r.tree_bytes > 0);
    assert_ne!(r.tree_sha256, [0; 32]);
    assert_eq!(r.metadata_order, (0..n as u32).rev().collect::<Vec<_>>());
    assert!(r.owned_targets_and_carriers_closed);
}
#[test]
fn actual_three_directory_empty_tree_uses_one_namespace_and_finalizes_descendants_first() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("tree-root");
    let child = root.join("child");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(&child).unwrap();
    std::fs::create_dir(child.join("grandchild")).unwrap();
    let r = run(
        request(&root, false, &DirectoryTreeMemory::default()),
        crate::file_access::SHAPE_WORK_LIMIT,
        false,
    )
    .unwrap();
    finished(&r, 3, false);
    drop(r);
    temp.close().unwrap();
}
#[test]
fn actual_raw_utf16_parent_child_directory_ea_ads_are_carried_and_recaptured() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("tree-root");
    std::fs::create_dir(&root).unwrap();
    let child = root.join(OsString::from_wide(&[0x61, 0xd800, 0x62]));
    std::fs::create_dir(&child).unwrap();
    ea(&root);
    ea(&child);
    let first = ads(&root);
    let second = ads(&child);
    let r = run(
        request(&root, false, &DirectoryTreeMemory::default()),
        crate::file_access::SHAPE_WORK_LIMIT,
        false,
    )
    .unwrap();
    finished(&r, 2, false);
    assert_eq!(std::fs::read(first).unwrap(), b"directory-tree\0\xff");
    assert_eq!(std::fs::read(second).unwrap(), b"directory-tree\0\xff");
    drop(r);
    temp.close().unwrap();
}
#[test]
fn actual_regular_child_is_explicitly_rejected_without_skipping_or_modifying_it() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("tree-root");
    std::fs::create_dir(&root).unwrap();
    let path = root.join("regular");
    std::fs::write(&path, b"preserve-regular").unwrap();
    assert!(matches!(
        run(
            request(&root, false, &DirectoryTreeMemory::default()),
            crate::file_access::SHAPE_WORK_LIMIT,
            false
        ),
        Err(E::Unsupported)
    ));
    assert_eq!(std::fs::read(path).unwrap(), b"preserve-regular");
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
    temp.close().unwrap();
}
#[test]
fn source_tree_precancel_and_shared_work_limit_remain_failures() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("tree-root");
    std::fs::create_dir(&root).unwrap();
    let memory = DirectoryTreeMemory::default();
    assert!(matches!(
        run(
            request(&root, false, &memory),
            crate::file_access::SHAPE_WORK_LIMIT,
            true
        ),
        Err(E::Cancelled)
    ));
    assert!(matches!(
        run(request(&root, false, &memory), 1, false),
        Err(E::Limit)
    ));
    assert!(std::fs::read_dir(&root).unwrap().next().is_none());
    temp.close().unwrap();
}
#[test]
#[ignore = "manual: full security read/write privilege must already be present; no adjustment or partial fallback"]
fn actual_two_directory_full_security_tree_uses_explicit_purpose_and_no_fallback() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("tree-root");
    let child = root.join("child");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(&child).unwrap();
    ea(&root);
    ea(&child);
    ads(&root);
    ads(&child);
    let r = run(
        request(&root, true, &DirectoryTreeMemory::default()),
        crate::file_access::SHAPE_WORK_LIMIT,
        false,
    )
    .unwrap();
    finished(&r, 2, true);
    drop(r);
    temp.close().unwrap();
}
