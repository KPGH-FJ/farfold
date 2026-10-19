//! Real target-only NTFS groups. Source carriers/FullSD restore are not claimed.
use super::{Slot, error};
use crate::file_access::{
    CarrierFailure as E, EaWorkBudget as WorkBudget, OWNED_LINK_WORK_LIMIT as WORK_LIMIT,
    OwnedTargetLinks, TARGET_LINK_MAX_NODES as MAX, TARGET_LINK_ROOT as ROOT, TargetLinkMemory,
    TargetLinkReceipt,
};
use std::{
    io::Write,
    os::windows::{
        ffi::OsStringExt,
        io::{AsRawHandle, FromRawHandle},
    },
    panic::AssertUnwindSafe,
    sync::atomic::AtomicBool,
};
use windows_sys::{
    Wdk::Storage::FileSystem::{
        FILE_LINK_INFORMATION, FileLinkInformation, NtSetEaFile, NtSetInformationFile,
    },
    Win32::{
        Foundation::{ERROR_SHARING_VIOLATION, INVALID_HANDLE_VALUE},
        Storage::FileSystem::*,
        System::IO::IO_STATUS_BLOCK,
    },
};
fn off() -> AtomicBool {
    AtomicBool::new(false)
}
fn name(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn owned<T>(
    f: impl FnOnce(&mut OwnedTargetLinks, &mut WorkBudget) -> Result<T, E>,
) -> Result<T, E> {
    let slot = Slot::<OwnedTargetLinks>::default();
    let mut actual = None;
    let result = slot.run(|retired| {
        let mut owner = OwnedTargetLinks::reserve(&TargetLinkMemory::default())
            .map_err(|_| error("reserve"))?;
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            owner.open(&off())?;
            f(&mut owner, &mut WorkBudget::new(WORK_LIMIT))
        }))
        .unwrap_or(Err(E::Unsupported));
        let cleanup = owner.cleanup();
        let _ = writeln!(
            std::io::stderr().lock(),
            "FARFOLD_TARGET_LINK_GROUP_OUTCOME operation={:?} cleanup={:?} native_status={:?}",
            result.as_ref().err(),
            cleanup.as_ref().err(),
            owner.last_native_status()
        );
        if cleanup.is_err() {
            *retired = Some(owner);
            actual = Some(Err(E::CleanupUnknown));
            return Err(error("cleanupUnknown"));
        }
        actual = Some(result);
        Ok(())
    });
    assert!(
        !slot.occupied(),
        "unknown native ownership is not a passing cleanup"
    );
    result.unwrap();
    actual.unwrap()
}
fn parents(owner: &mut OwnedTargetLinks) -> Result<(u32, u32, u32), E> {
    let root = owner.create_parent(ROOT, &name("source-label-not-a-path"), &off())?;
    let left = owner.create_parent(root, &name("left"), &off())?;
    let right = owner.create_parent(root, &name("right"), &off())?;
    Ok((root, left, right))
}
fn payload(seed: u8) -> Vec<u8> {
    (0..=255u8).cycle().take(300).map(|b| b ^ seed).collect()
}
fn fill(owner: &mut OwnedTargetLinks, group: u32, seed: u8) -> Result<[u8; 32], E> {
    let file = owner.target(group)?;
    let mut fs = [0u16; 32];
    assert_ne!(
        unsafe {
            GetVolumeInformationByHandleW(
                file.as_raw_handle(),
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
    let end = fs.iter().position(|u| *u == 0).unwrap();
    assert_eq!(String::from_utf16(&fs[..end]).unwrap(), "NTFS");
    let bytes = payload(seed);
    file.write_all(&bytes).map_err(|_| E::Invalid)?;
    file.sync_all().map_err(|_| E::Invalid)?;
    let mut ea = vec![0; 8];
    ea[5] = 5;
    ea[6..8].copy_from_slice(&4u16.to_le_bytes());
    ea.extend(b"GROUP\0");
    ea.extend([seed, 0, 255, 17]);
    let mut ios = IO_STATUS_BLOCK::default();
    assert_eq!(
        unsafe {
            NtSetEaFile(
                file.as_raw_handle(),
                &mut ios,
                ea.as_mut_ptr().cast(),
                ea.len() as u32,
            )
        },
        0
    );
    Ok(<sha2::Sha256 as sha2::Digest>::digest(&bytes).into())
}
fn check_receipt(r: &TargetLinkReceipt, expected: [u8; 32], links: u64) {
    assert_eq!(r.links, links);
    assert_eq!(r.data_bytes, 300);
    assert_eq!(r.data_sha256, expected);
    assert_eq!(r.ea_count, 1);
    assert_ne!(r.ea_sha256, [0; 32]);
    assert_ne!(r.security_sha256, [0; 32]);
    assert_ne!(r.identity.inode, 0);
}
#[test]
fn cross_parent_groups_keep_distinct_real_data_ea_sd_and_complete_name_identity_sets() {
    owned(|owner, work| {
        let (root, left, right) = parents(owner)?;
        let a = owner.create_group(left, &name("primary-a.bin"), false, &off())?;
        let ah = fill(owner, a, 7)?;
        let b = owner.create_group(right, &name("primary-b.bin"), false, &off())?;
        let bh = fill(owner, b, 19)?;
        owner.add(a, right, &name("alias-a.bin"), work, &off())?;
        owner.add(a, root, &name("root-a.bin"), work, &off())?;
        owner.add(a, left, &name("same-a.bin"), work, &off())?;
        owner.add(b, left, &name("alias-b.bin"), work, &off())?;
        let actual = owner.verify(work, &off())?;
        assert_eq!(actual.len(), 2);
        check_receipt(&actual[0], ah, 4);
        check_receipt(&actual[1], bh, 2);
        assert_ne!(actual[0].identity, actual[1].identity);
        assert!(!actual[0].full_security_observed);
        assert!(!actual[1].full_security_observed);
        assert!(matches!(owner.target(a), Err(E::Invalid)));
        Ok(())
    })
    .unwrap();
}
#[test]
fn empty_default_data_has_real_cross_parent_links_without_a_fabricated_payload() {
    owned(|owner, work| {
        let (_, left, right) = parents(owner)?;
        let a = owner.create_group(left, &name("empty.bin"), false, &off())?;
        owner.add(a, right, &name("empty-alias.bin"), work, &off())?;
        let result = owner.verify(work, &off())?;
        assert_eq!(result[0].links, 2);
        assert_eq!(result[0].data_bytes, 0);
        let expected: [u8; 32] = <sha2::Sha256 as sha2::Digest>::digest([]).into();
        assert_eq!(result[0].data_sha256, expected);
        assert_eq!(result[0].ea_count, 0);
        Ok(())
    })
    .unwrap();
}
#[test]
fn cross_parent_counted_unpaired_utf16_and_max_leaf_are_actual_names() {
    owned(|owner, work| {
        let (_, left, right) = parents(owner)?;
        let a = owner.create_group(left, &name("primary.bin"), false, &off())?;
        let expected = fill(owner, a, 23)?;
        owner.add(a, right, &[97, 0xd800, 98], work, &off())?;
        owner.add(a, right, &[0x4e2d; 255], work, &off())?;
        let result = owner.verify(work, &off())?;
        check_receipt(&result[0], expected, 3);
        Ok(())
    })
    .unwrap();
}
#[test]
fn cross_parent_replace_false_collision_preserves_both_existing_groups() {
    owned(|owner,work| {
        let (_,left,right) = parents(owner)?;
        let a = owner.create_group(left,&name("a.bin"),false,&off())?; let ah = fill(owner,a,1)?;
        let b = owner.create_group(right,&name("b.bin"),false,&off())?; let bh = fill(owner,b,2)?;
        assert!(matches!(owner.add(a,right,&name("b.bin"),work,&off()),
            Err(E::NtStatus {phase:"targetGroupRelativeLink",status}) if status == 0xc0000035u32 as i32));
        let result = owner.verify(work,&off())?;
        check_receipt(&result[0],ah,1); check_receipt(&result[1],bh,1);
        Ok(())
    }).unwrap();
}
#[test]
fn invalid_names_precancel_and_insufficient_shared_work_do_not_mutate_any_group() {
    owned(|owner, work| {
        let (_, left, right) = parents(owner)?;
        let a = owner.create_group(left, &name("a.bin"), false, &off())?;
        let ah = fill(owner, a, 11)?;
        for invalid in [
            "", ".", "..", "a/b", "a\\b", "C:x", "x:y", "NUL", "tail.", "tail ",
        ] {
            assert_eq!(
                owner.add(a, right, &name(invalid), work, &off()).err(),
                Some(E::Invalid)
            );
        }
        assert_eq!(
            owner
                .add(a, right, &name("cancelled"), work, &AtomicBool::new(true))
                .err(),
            Some(E::Cancelled)
        );
        assert_eq!(
            owner
                .add(a, right, &name("budget"), &mut WorkBudget::new(0), &off())
                .err(),
            Some(E::Limit)
        );
        let result = owner.verify(work, &off())?;
        check_receipt(&result[0], ah, 1);
        Ok(())
    })
    .unwrap();
}
// Test-only pathname use attempts a NON-MUTATING DELETE open on our known target
// parent. Production create/link/cleanup uses only held ancestors + counted names.
fn delete_open_denied(parent: &std::path::Path) {
    use std::os::windows::ffi::OsStrExt;
    let text: Vec<u16> = parent.as_os_str().encode_wide().chain(Some(0)).collect();
    let raw = unsafe {
        CreateFileW(
            text.as_ptr(),
            DELETE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    let error = std::io::Error::last_os_error().raw_os_error();
    if raw != INVALID_HANDLE_VALUE {
        drop(unsafe { std::fs::File::from_raw_handle(raw) });
    }
    assert_eq!(raw, INVALID_HANDLE_VALUE);
    assert_eq!(error, Some(ERROR_SHARING_VIOLATION as i32));
}
#[test]
fn actual_target_parent_denies_new_delete_before_and_after_cross_parent_links() {
    owned(|owner, work| {
        let (_, left, right) = parents(owner)?;
        let a = owner.create_group(left, &name("a.bin"), false, &off())?;
        fill(owner, a, 0)?;
        let file = owner.target(a)?;
        let mut raw = vec![0u16; 32768];
        let n = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                raw.as_mut_ptr(),
                raw.len() as u32,
                FILE_NAME_NORMALIZED | VOLUME_NAME_GUID,
            )
        };
        assert!(n > 0 && n < raw.len() as u32);
        raw.truncate(n as usize);
        let path = std::path::PathBuf::from(std::ffi::OsString::from_wide(&raw));
        let parent = path.parent().unwrap();
        delete_open_denied(parent);
        owner.add(a, right, &name("a-alias.bin"), work, &off())?;
        delete_open_denied(parent);
        assert_eq!(owner.verify(work, &off())?[0].links, 2);
        Ok(())
    })
    .unwrap();
}
#[test]
fn caller_error_after_verified_cross_parent_effect_still_closes_original_slot() {
    assert_eq!(
        owned::<()>(|owner, work| {
            let (_, left, right) = parents(owner)?;
            let a = owner.create_group(left, &name("a.bin"), false, &off())?;
            fill(owner, a, 31)?;
            owner.add(a, right, &name("a-alias.bin"), work, &off())?;
            assert_eq!(owner.verify(work, &off())?[0].links, 2);
            Err(E::Cancelled)
        })
        .err(),
        Some(E::Cancelled)
    );
}
#[test]
fn all_directory_and_member_nodes_share_one_fixed_admission_limit() {
    owned(|owner, _work| {
        let root = owner.create_parent(ROOT, &name("root"), &off())?;
        for n in 1..MAX {
            owner.create_parent(root, &name(&format!("p{n}")), &off())?;
        }
        assert_eq!(
            owner
                .create_group(root, &name("over-limit"), false, &off())
                .err(),
            Some(E::Limit)
        );
        Ok(())
    })
    .unwrap();
}
#[test]
fn undeclared_real_alias_cannot_be_forgiven_or_deleted_and_retains_the_same_slot() {
    let slot = Slot::<OwnedTargetLinks>::default();
    let mut operation = None;
    let mut cleanup = None;
    let result: super::Result<()> = slot.run(|retired| {
        let mut owner = OwnedTargetLinks::reserve(&TargetLinkMemory::default()).unwrap();
        let actual = std::panic::catch_unwind(AssertUnwindSafe(|| -> Result<(), E> {
            owner.open(&off())?;
            let (_, left, _right) = parents(&mut owner)?;
            let a = owner.create_group(left, &name("a.bin"), false, &off())?;
            fill(&mut owner, a, 37)?;
            // Exact owned fixture only: one alias outside the declared set via
            // the original FileObject. No source/user path or receipt is used.
            let leaf = name("undeclared.bin");
            let bytes = std::mem::size_of::<FILE_LINK_INFORMATION>()
                .max(std::mem::offset_of!(FILE_LINK_INFORMATION, FileName) + 2 * leaf.len());
            let mut buffer = vec![0u64; bytes.div_ceil(8)];
            let record = buffer.as_mut_ptr().cast::<FILE_LINK_INFORMATION>();
            unsafe {
                (*record).Anonymous.ReplaceIfExists = false;
                (*record).RootDirectory = std::ptr::null_mut();
                (*record).FileNameLength = (2 * leaf.len()) as u32;
                std::ptr::copy_nonoverlapping(
                    leaf.as_ptr(),
                    std::ptr::addr_of_mut!((*record).FileName).cast::<u16>(),
                    leaf.len(),
                );
            }
            let mut ios = IO_STATUS_BLOCK::default();
            assert_eq!(
                unsafe {
                    NtSetInformationFile(
                        owner.target(a)?.as_raw_handle(),
                        &mut ios,
                        record.cast(),
                        bytes as u32,
                        FileLinkInformation,
                    )
                },
                0
            );
            assert_eq!(
                owner.verify(&mut WorkBudget::new(WORK_LIMIT), &off()).err(),
                Some(E::Changed)
            );
            Ok(())
        }))
        .unwrap_or(Err(E::Unsupported));
        operation = Some(actual);
        let closed = owner.cleanup();
        cleanup = Some(closed.clone());
        if closed.is_err() {
            *retired = Some(owner);
            return Err(error("cleanupUnknown"));
        }
        Ok(())
    });
    assert_eq!(operation, Some(Ok(())));
    assert_eq!(cleanup, Some(Err(E::Changed)));
    assert!(result.is_err());
    assert!(slot.occupied());
    assert!(slot.available().is_err());
    // Intentional bounded unknown control. One actual namespace/resources stays
    // in the existing ManuallyDrop retirement until this test process exits.
}
#[test]
#[ignore = "manual: current token permits full security target access; no privilege adjustment"]
fn cross_parent_groups_observe_actual_full_sd_without_claiming_source_sd_restore() {
    owned(|owner, work| {
        let (_, left, right) = parents(owner)?;
        let a = owner.create_group(left, &name("full.bin"), true, &off())?;
        let ah = fill(owner, a, 41)?;
        owner.add(a, right, &name("full-alias.bin"), work, &off())?;
        let result = owner.verify(work, &off())?;
        check_receipt(&result[0], ah, 2);
        assert!(result[0].full_security_observed);
        Ok(())
    })
    .unwrap();
}
