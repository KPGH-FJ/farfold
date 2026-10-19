//! Real owned NTFS capture controls. Not directory restore/TreeFacet/Manifest2.
use super::{Slot, error};
use crate::file_access::{
    CarrierFailure as E, DirectoryMemory, DirectoryReceipt, DirectoryRequest, DirectoryRetirement,
    EaWorkBudget as WorkBudget, PinnedPath, capture_directory, stamp,
};
use std::{
    fs::OpenOptions,
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle},
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
fn ntfs(pin: &PinnedPath) {
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
        String::from_utf16(&fs[..fs.iter().position(|u| *u == 0).unwrap()]).unwrap(),
        "NTFS"
    );
}
fn request(path: &Path, full: bool, memory: &DirectoryMemory) -> DirectoryRequest {
    let path = path.canonicalize().unwrap();
    let pin = if full {
        PinnedPath::directory_full_security(&path).unwrap()
    } else {
        PinnedPath::directory(&path).unwrap()
    };
    ntfs(&pin);
    let leaf = path.file_name().unwrap().encode_wide().collect();
    DirectoryRequest::held(pin, leaf, memory, &AtomicBool::new(false)).unwrap()
}
fn run(request: DirectoryRequest, work: u64, cancel: bool) -> Result<DirectoryReceipt, E> {
    let slot = Slot::<DirectoryRetirement>::default();
    let mut result = None;
    let outer = slot.run(|retired| {
        result = Some(capture_directory(
            request,
            &mut WorkBudget::new(work),
            &AtomicBool::new(cancel),
            retired,
        ));
        match result.as_ref().unwrap() {
            Ok(_) => Ok(()),
            Err(_) => Err(error("directoryCaptureFailed")),
        }
    });
    assert!(
        !slot.occupied(),
        "directory context/owned carrier cleanupUnknown remains a failure, not success"
    );
    match result {
        Some(value) => value,
        None => panic!("Slot refused: {outer:?}"),
    }
}
fn fixture() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("owned-directory-Δ🙂");
    std::fs::create_dir(&path).unwrap();
    (temp, path)
}
fn add_ea(path: &Path) {
    let writer = OpenOptions::new()
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
                writer.as_raw_handle(),
                &mut ios,
                b.as_ptr().cast(),
                b.len() as u32,
            )
        },
        0
    );
}
fn finished(r: &DirectoryReceipt) {
    assert!(r.native_eof && r.abort_calls == 1 && r.verified_bytes && r.owned_carriers_closed);
    assert!(r.facet_bytes > r.native_bytes);
    assert_ne!(r.record_sha256, [0; 32]);
}
#[test]
fn ordinary_empty_directory_captures_zero_native_bytes_into_a_typed_verified_facet() {
    let (temp, path) = fixture();
    let memory = DirectoryMemory::default();
    let canonical = path.canonicalize().unwrap();
    let pin = PinnedPath::directory(&canonical).unwrap();
    let expected = stamp(pin.file()).unwrap().identity;
    drop(pin);
    let r = run(
        request(&path, false, &memory),
        crate::file_access::SHAPE_WORK_LIMIT,
        false,
    )
    .unwrap();
    finished(&r);
    assert_eq!(r.source, expected);
    assert_eq!(
        r.raw_leaf,
        canonical
            .file_name()
            .unwrap()
            .encode_wide()
            .collect::<Vec<_>>()
    );
    assert_eq!(r.native_bytes, 0);
    assert_eq!(r.named_data, 0);
    assert_eq!(r.ea_count, 0);
    assert!(r.full_security_sha256.is_none());
    let expected: [u8; 32] = <sha2::Sha256 as sha2::Digest>::digest([]).into();
    assert_eq!(r.native_sha256, expected);
    drop(r);
    temp.close().unwrap();
}
#[test]
fn ordinary_directory_ea_ads_and_raw_leaf_are_preserved_without_security_claim() {
    let (temp, path) = fixture();
    add_ea(&path);
    let stream = format!("{}:shape:$DATA", path.display());
    let named = b"directory-named\0\xff";
    std::fs::write(&stream, named).unwrap();
    let memory = DirectoryMemory::default();
    let r = run(
        request(&path, false, &memory),
        crate::file_access::SHAPE_WORK_LIMIT,
        false,
    )
    .unwrap();
    finished(&r);
    assert_eq!(r.named_data, 1);
    assert_eq!(r.ea_count, 1);
    assert!(r.native_bytes > named.len() as u64);
    assert!(r.full_security_sha256.is_none());
    assert_eq!(std::fs::read(&stream).unwrap(), named);
    drop(r);
    temp.close().unwrap();
}
#[test]
fn wrong_kind_label_precancel_and_insufficient_work_never_become_a_facet() {
    let (temp, path) = fixture();
    let file = temp.path().join("file.bin");
    std::fs::write(&file, b"owned").unwrap();
    let memory = DirectoryMemory::default();
    let pin = PinnedPath::regular(&file.canonicalize().unwrap()).unwrap();
    assert!(matches!(
        DirectoryRequest::held(
            pin,
            "file.bin".encode_utf16().collect(),
            &memory,
            &AtomicBool::new(false)
        ),
        Err(E::Unsupported)
    ));
    let pin = PinnedPath::directory(&path.canonicalize().unwrap()).unwrap();
    assert!(matches!(
        DirectoryRequest::held(
            pin,
            "different".encode_utf16().collect(),
            &memory,
            &AtomicBool::new(false)
        ),
        Err(E::Changed)
    ));
    assert!(matches!(
        run(
            request(&path, false, &memory),
            crate::file_access::SHAPE_WORK_LIMIT,
            true
        ),
        Err(E::Cancelled)
    ));
    assert!(matches!(
        run(request(&path, false, &memory), 1, false),
        Err(E::Limit)
    ));
    assert!(std::fs::read_dir(&path).unwrap().next().is_none());
    temp.close().unwrap();
}
#[test]
#[ignore = "manual: current token must already permit full security directory reads, no privilege change or ordinary fallback"]
fn full_security_directory_is_a_distinct_actual_native_capture_profile() {
    let (temp, path) = fixture();
    add_ea(&path);
    std::fs::write(
        format!("{}:shape:$DATA", path.display()),
        b"directory-full-owned",
    )
    .unwrap();
    let r = run(
        request(&path, true, &DirectoryMemory::default()),
        crate::file_access::SHAPE_WORK_LIMIT,
        false,
    )
    .unwrap();
    finished(&r);
    assert_eq!(r.named_data, 1);
    assert_eq!(r.ea_count, 1);
    assert_ne!(r.full_security_sha256, Some([0; 32]));
    assert!(r.full_security_sha256.is_some());
    drop(r);
    temp.close().unwrap();
}
