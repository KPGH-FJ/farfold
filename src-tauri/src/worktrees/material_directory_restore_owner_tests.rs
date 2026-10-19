//! Actual owned directory target/BackupWrite/recapture controls. Not whole tree.
use super::{Slot, error};
use crate::file_access::{
    CarrierFailure as E, DirectoryMemory, DirectoryRequest, DirectoryRestoreReceipt,
    DirectoryRetirement, EaWorkBudget as WorkBudget, PinnedPath, directory_roundtrip,
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
fn fixture() -> (tempfile::TempDir, PathBuf) {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("restore-directory-Δ🙂");
    std::fs::create_dir(&path).unwrap();
    (d, path)
}
fn request(path: &Path, full: bool, memory: &DirectoryMemory) -> DirectoryRequest {
    let path = path.canonicalize().unwrap();
    let pin = if full {
        PinnedPath::directory_full_security(&path).unwrap()
    } else {
        PinnedPath::directory(&path).unwrap()
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
        String::from_utf16(&fs[..fs.iter().position(|u| *u == 0).unwrap()]).unwrap(),
        "NTFS"
    );
    DirectoryRequest::held(
        pin,
        path.file_name().unwrap().encode_wide().collect(),
        memory,
        &AtomicBool::new(false),
    )
    .unwrap()
}
fn ea(path: &Path, value: &[u8]) {
    let file = OpenOptions::new()
        .access_mode(FILE_WRITE_EA | SYNCHRONIZE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .unwrap();
    let mut raw = vec![0u8; 8];
    raw[5] = 1;
    raw[6..8].copy_from_slice(&(value.len() as u16).to_le_bytes());
    raw.extend(b"X\0");
    raw.extend(value);
    let mut ios = IO_STATUS_BLOCK::default();
    assert_eq!(
        unsafe {
            NtSetEaFile(
                file.as_raw_handle(),
                &mut ios,
                raw.as_ptr().cast(),
                raw.len() as u32,
            )
        },
        0
    );
}
fn run(request: DirectoryRequest, work: u64, cancel: bool) -> Result<DirectoryRestoreReceipt, E> {
    let slot = Slot::<DirectoryRetirement>::default();
    let mut result = None;
    let outer = slot.run(|retired| {
        result = Some(directory_roundtrip(
            request,
            &mut WorkBudget::new(work),
            &AtomicBool::new(cancel),
            retired,
        ));
        match result.as_ref().unwrap() {
            Ok(_) => Ok(()),
            Err(_) => Err(error("directoryRestoreFailed")),
        }
    });
    assert!(
        !slot.occupied(),
        "native unknown context/namespace must not become success"
    );
    match result {
        Some(r) => r,
        None => panic!("Slot refused: {outer:?}"),
    }
}
fn closed(r: &DirectoryRestoreReceipt) {
    assert!(
        r.capture.native_eof
            && r.capture.abort_calls == 1
            && r.capture.verified_bytes
            && r.capture.owned_carriers_closed
    );
    assert!(r.target_recaptured && r.metadata_finalized);
    assert_ne!(r.capture.source, r.target);
    assert_eq!(r.recapture_aborts, 1);
}
#[test]
fn empty_partial_directory_creates_real_owned_target_without_fabricated_write_context() {
    let (d, p) = fixture();
    let r = run(
        request(&p, false, &DirectoryMemory::default()),
        crate::file_access::SHAPE_WORK_LIMIT,
        false,
    )
    .unwrap();
    closed(&r);
    assert_eq!(r.capture.native_bytes, 0);
    assert_eq!(r.write_aborts, 0);
    assert!(r.capture.full_security_sha256.is_none());
    drop(r);
    d.close().unwrap();
}
#[test]
fn ordinary_directory_ea_ads_roundtrip_keeps_actual_source_and_finalizes_childless_metadata_last() {
    let (d, p) = fixture();
    ea(&p, b"EA\0\xff");
    let stream = format!("{}:shape:$DATA", p.display());
    let bytes = b"directory-restore\0\xff";
    std::fs::write(&stream, bytes).unwrap();
    let r = run(
        request(&p, false, &DirectoryMemory::default()),
        crate::file_access::SHAPE_WORK_LIMIT,
        false,
    )
    .unwrap();
    closed(&r);
    assert_eq!(r.write_aborts, 1);
    assert_eq!(r.capture.ea_count, 1);
    assert_eq!(r.capture.named_data, 1);
    assert!(r.capture.full_security_sha256.is_none());
    assert_eq!(std::fs::read(&stream).unwrap(), bytes);
    assert!(std::fs::read_dir(&p).unwrap().next().is_none());
    drop(r);
    d.close().unwrap();
}
#[test]
fn precancel_and_shared_work_failure_preserve_source_without_a_successful_restore() {
    let (d, p) = fixture();
    let memory = DirectoryMemory::default();
    assert!(matches!(
        run(
            request(&p, false, &memory),
            crate::file_access::SHAPE_WORK_LIMIT,
            true
        ),
        Err(E::Cancelled)
    ));
    let limited = run(request(&p, false, &memory), 1, false);
    assert!(matches!(limited, Err(E::Limit)), "{limited:?}");
    assert!(std::fs::read_dir(&p).unwrap().next().is_none());
    d.close().unwrap();
}
#[test]
#[ignore = "manual: full SD read/write privileges must already be present, no privilege adjustment or PayloadOnly fallback"]
fn full_security_directory_restore_is_explicit_and_recaptures_actual_full_sd() {
    let (d, p) = fixture();
    ea(&p, b"EA\0\xff");
    std::fs::write(
        format!("{}:shape:$DATA", p.display()),
        b"full-security-directory",
    )
    .unwrap();
    let r = run(
        request(&p, true, &DirectoryMemory::default()),
        crate::file_access::SHAPE_WORK_LIMIT,
        false,
    )
    .unwrap();
    closed(&r);
    assert_eq!(r.write_aborts, 1);
    assert!(r.capture.full_security_sha256.is_some());
    assert_ne!(r.capture.full_security_sha256, Some([0; 32]));
    drop(r);
    d.close().unwrap();
}
