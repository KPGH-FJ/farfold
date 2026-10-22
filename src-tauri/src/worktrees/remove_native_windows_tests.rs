//! Production final-fence race controls on disposable NTFS repositories.
//! These assert preservation; static compilation is not a Windows execution.
use super::{recovery_public_windows_tests::backup, *};
use crate::meta_store::MetaStore;
use std::{
    cell::Cell,
    fs::{self, OpenOptions},
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};
use windows_sys::{
    Wdk::Storage::FileSystem::{NtQueryEaFile, NtSetEaFile},
    Win32::{
        Storage::FileSystem::{FILE_READ_EA, FILE_WRITE_EA, SYNCHRONIZE},
        System::IO::IO_STATUS_BLOCK,
    },
};

fn late_change(
    kind: &'static str,
    change: impl FnOnce(&Path, &AtomicBool),
    retained: impl FnOnce(&Path),
) {
    let fixture = backup(false);
    let store = MetaStore::open(fixture.database()).unwrap();
    let (_, doc) = storage::read(&store).unwrap();
    let intent = doc.operation.unwrap().removal.unwrap();
    let source = Path::new(&intent.saved.archive.retained_path);
    let manifest = Path::new(&fixture.recovery().path).join("manifest.json");
    let original_manifest = fs::read(&manifest).unwrap();
    let original_config = fs::read(fixture.main().join(".git/config")).unwrap();
    let original_pointer = fs::read(source.join(".git")).unwrap();
    let reached = Cell::new(false);
    let owner = material_owner::Owner::default();
    let saved_recovery = intent.recovery.as_ref().unwrap();
    let original_recovery = recovery_pack::verify(
        &material_owner::Owner::default(),
        saved_recovery,
        &AtomicBool::new(false),
    )
    .unwrap();
    let cancel = AtomicBool::new(false);
    // Invoke the real delete path and its actual final before_dispatch callback.
    // No fake Native proof, callback-only substitute, or public gate bypass flag.
    let result = removal::delete(&owner, &intent, &cancel, || {
        change(source, &cancel);
        reached.set(true);
        eprintln!("FARFOLD_REMOVE_FINAL_CALLBACK_INJECTED kind={kind}");
        Ok(())
    });
    assert!(
        reached.get(),
        "the actual final callback was not reached: {result:?}"
    );
    assert!(
        result.is_err(),
        "late material was disposed after the last complete backup fence"
    );
    assert_eq!(result.unwrap_err().code, "cleanupUnknown");
    // A rejected dispatch is recoverable from the ACTUAL original independent
    // material, not merely from unchanged manifest text. This injection is
    // before the added last observation, not a claim about arbitrary future I/O.
    let rechecked = recovery_pack::verify(
        &material_owner::Owner::default(),
        saved_recovery,
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(rechecked, original_recovery);
    assert_eq!(
        fs::read(source.join("payload.txt")).unwrap(),
        b"retained\ncontent\n"
    );
    retained(source);
    assert_eq!(fs::read(source.join(".git")).unwrap(), original_pointer);
    assert_eq!(
        fs::read(fixture.main().join(".git/config")).unwrap(),
        original_config
    );
    assert_eq!(fs::read(manifest).unwrap(), original_manifest);
}

#[test]
#[ignore = "manual: NTFS/full SACL; real callback injection and same-owner terminal material fence"]
fn late_named_stream_after_complete_native_fence_must_be_preserved() {
    late_change(
        "namedStream",
        |root, _| {
            fs::write(
                root.join("payload.txt:late-owned:$DATA"),
                b"late named bytes",
            )
            .unwrap()
        },
        |root| {
            assert_eq!(
                fs::read(root.join("payload.txt:late-owned:$DATA")).unwrap(),
                b"late named bytes"
            )
        },
    );
}

fn ea_record() -> Vec<u8> {
    let name = b"owned-final-fence-ea";
    let mut raw = Vec::new();
    raw.extend(0_u32.to_le_bytes());
    raw.extend([0, name.len() as u8]);
    raw.extend(3_u16.to_le_bytes());
    raw.extend(name);
    raw.push(0);
    raw.extend([0, 255, 17]);
    raw
}

#[test]
#[ignore = "manual: NTFS/full SACL; real callback injection and same-owner terminal material fence"]
fn late_ea_after_complete_native_fence_must_be_preserved() {
    late_change(
        "ea",
        |root, _| {
            let writer = OpenOptions::new()
                .access_mode(FILE_WRITE_EA | SYNCHRONIZE)
                .open(root.join("payload.txt"))
                .unwrap();
            let raw = ea_record();
            let mut ios = IO_STATUS_BLOCK::default();
            assert_eq!(
                unsafe {
                    NtSetEaFile(
                        writer.as_raw_handle(),
                        &mut ios,
                        raw.as_ptr().cast(),
                        raw.len() as u32,
                    )
                },
                0
            );
            // Close this actual writer before disposition: leaving it open
            // would produce an unrelated delete-pending/absence failure.
            drop(writer);
        },
        |root| {
            let reader = OpenOptions::new()
                .access_mode(FILE_READ_EA | SYNCHRONIZE)
                .open(root.join("payload.txt"))
                .unwrap();
            let mut aligned = [0_u64; 64];
            let mut ios = IO_STATUS_BLOCK::default();
            assert_eq!(
                unsafe {
                    NtQueryEaFile(
                        reader.as_raw_handle(),
                        &mut ios,
                        aligned.as_mut_ptr().cast(),
                        512,
                        false,
                        std::ptr::null(),
                        0,
                        std::ptr::null(),
                        true,
                    )
                },
                0
            );
            let raw = ea_record();
            assert_eq!(ios.Information, raw.len());
            let bytes =
                unsafe { std::slice::from_raw_parts(aligned.as_ptr().cast::<u8>(), raw.len()) };
            assert_eq!(bytes, raw);
        },
    );
}

#[test]
#[ignore = "manual: NTFS/full SACL; actual same-size named-stream payload change"]
fn same_size_named_stream_change_in_final_callback_is_rejected_with_valid_recovery() {
    use std::mem::size_of;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_BASIC_INFO, FILE_READ_ATTRIBUTES, FILE_WRITE_ATTRIBUTES, FileBasicInfo,
        GetFileInformationByHandleEx, SetFileInformationByHandle,
    };
    late_change(
        "sameSizeNamedStream",
        |root, _| {
            let path = root.join("payload.txt:retained:$DATA");
            let original = fs::read(&path).unwrap();
            assert!(!original.is_empty());
            let metadata = OpenOptions::new()
                .access_mode(FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES | SYNCHRONIZE)
                .open(root.join("payload.txt"))
                .unwrap();
            let mut before: FILE_BASIC_INFO = unsafe { std::mem::zeroed() };
            assert_ne!(
                unsafe {
                    GetFileInformationByHandleEx(
                        metadata.as_raw_handle(),
                        FileBasicInfo,
                        (&mut before as *mut FILE_BASIC_INFO).cast(),
                        size_of::<FILE_BASIC_INFO>() as u32,
                    )
                },
                0
            );
            let mut changed = original.clone();
            changed[0] ^= 0x20;
            assert_eq!(changed.len(), original.len());
            fs::write(&path, &changed).unwrap();
            assert_eq!(fs::read(&path).unwrap(), changed);
            // This owned control restores actual basic timestamps/attributes,
            // so a mere ChangeTime/size comparison cannot stand in for hashing
            // the named bytes. The writer is closed before the real fence.
            assert_ne!(
                unsafe {
                    SetFileInformationByHandle(
                        metadata.as_raw_handle(),
                        FileBasicInfo,
                        (&before as *const FILE_BASIC_INFO).cast(),
                        size_of::<FILE_BASIC_INFO>() as u32,
                    )
                },
                0
            );
            let mut after: FILE_BASIC_INFO = unsafe { std::mem::zeroed() };
            assert_ne!(
                unsafe {
                    GetFileInformationByHandleEx(
                        metadata.as_raw_handle(),
                        FileBasicInfo,
                        (&mut after as *mut FILE_BASIC_INFO).cast(),
                        size_of::<FILE_BASIC_INFO>() as u32,
                    )
                },
                0
            );
            assert_eq!(after.CreationTime, before.CreationTime);
            assert_eq!(after.LastWriteTime, before.LastWriteTime);
            assert_eq!(after.ChangeTime, before.ChangeTime);
            assert_eq!(after.FileAttributes, before.FileAttributes);
            drop(metadata);
        },
        |root| {
            let mut expected = b"actual named stream".to_vec();
            expected[0] ^= 0x20;
            assert_eq!(
                fs::read(root.join("payload.txt:retained:$DATA")).unwrap(),
                expected
            );
        },
    );
}

#[test]
#[ignore = "manual: NTFS/full SACL; actual DACL write handle is closed before terminal comparison"]
fn security_change_in_final_callback_is_rejected_with_valid_recovery() {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
            },
            DACL_SECURITY_INFORMATION, SetKernelObjectSecurity,
        },
        Storage::FileSystem::{READ_CONTROL, WRITE_DAC},
    };
    late_change(
        "security",
        |root, _| {
            let file = OpenOptions::new()
                .access_mode(READ_CONTROL | WRITE_DAC | SYNCHRONIZE)
                .open(root.join("payload.txt"))
                .unwrap();
            let text: Vec<u16> = "D:P(A;;FA;;;WD)".encode_utf16().chain(Some(0)).collect();
            let mut descriptor = std::ptr::null_mut();
            assert_ne!(
                unsafe {
                    ConvertStringSecurityDescriptorToSecurityDescriptorW(
                        text.as_ptr(),
                        SDDL_REVISION_1,
                        &mut descriptor,
                        std::ptr::null_mut(),
                    )
                },
                0
            );
            let result = unsafe {
                SetKernelObjectSecurity(file.as_raw_handle(), DACL_SECURITY_INFORMATION, descriptor)
            };
            unsafe {
                LocalFree(descriptor);
            }
            assert_ne!(result, 0);
            drop(file); // No held writer may manufacture delete-pending failure.
        },
        |_| {},
    );
}

#[test]
#[ignore = "manual: NTFS/full SACL; new member is never added to the deletion list"]
fn new_member_in_final_callback_is_not_chased_and_recovery_remains_valid() {
    late_change(
        "newMember",
        |root, _| {
            fs::write(
                root.join("not-in-original-membership.bin"),
                b"new external work",
            )
            .unwrap();
        },
        |root| {
            assert_eq!(
                fs::read(root.join("not-in-original-membership.bin")).unwrap(),
                b"new external work"
            );
        },
    );
}

#[test]
#[ignore = "manual: NTFS/full SACL; cancellation at actual final callback"]
fn cancellation_in_final_callback_preserves_source_and_valid_recovery() {
    late_change(
        "cancel",
        |_, cancel| {
            cancel.store(true, Ordering::SeqCst);
        },
        |_| {},
    );
}
