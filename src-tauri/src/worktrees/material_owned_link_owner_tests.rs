//! Real owned NTFS controls; not full-tree/Manifest2 or product restore proof.
use super::{Slot, error};
use crate::file_access::{
    CarrierFailure as E, EaWorkBudget as WorkBudget, OWNED_LINK_WORK_LIMIT as WORK_LIMIT,
    OwnedLinkMemory, OwnedLinkReceipt, OwnedLinks, stamp,
};
use std::{
    io::{Read, Seek, SeekFrom, Write},
    os::windows::io::AsRawHandle,
    panic::AssertUnwindSafe,
    sync::atomic::AtomicBool,
};
use windows_sys::{Wdk::Storage::FileSystem::NtSetEaFile, Win32::System::IO::IO_STATUS_BLOCK};
fn owned<T>(full: bool, f: impl FnOnce(&mut OwnedLinks) -> Result<T, E>) -> Result<T, E> {
    let slot = Slot::<OwnedLinks>::default();
    let mut actual = None;
    let result = slot.run(|retired| {
        let mut owner =
            OwnedLinks::reserve(&OwnedLinkMemory::default()).map_err(|_| error("reserve"))?;
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            owner.open(full, &AtomicBool::new(false))?;
            // The namespace's held parent was actual-local-volume validated.
            let mut fs = [0u16; 32];
            assert_ne!(
                unsafe {
                    windows_sys::Win32::Storage::FileSystem::GetVolumeInformationByHandleW(
                        owner.target()?.as_raw_handle(),
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
            f(&mut owner)
        }))
        .unwrap_or(Err(E::Unsupported));
        if let Err(error) = &result {
            owner.record_failure(error.clone());
        }
        let cleanup = owner.cleanup();
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
        "unknown native ownership is failure, never a skip/success"
    );
    result.unwrap();
    actual.unwrap()
}
fn payload() -> Vec<u8> {
    (0..=255).cycle().take(300).collect()
}
fn fill(owner: &mut OwnedLinks) -> Result<(), E> {
    let target = owner.target()?;
    target.write_all(&payload()).map_err(|_| E::Invalid)?;
    target.sync_all().map_err(|_| E::Invalid)?;
    let name = b"OWNED";
    let value = b"\0\xffowned-EA";
    let mut ea = vec![0u8; 8];
    ea[5] = name.len() as u8;
    ea[6..8].copy_from_slice(&(value.len() as u16).to_le_bytes());
    ea.extend(name);
    ea.push(0);
    ea.extend(value);
    let mut ios = IO_STATUS_BLOCK::default();
    assert_eq!(
        unsafe {
            NtSetEaFile(
                target.as_raw_handle(),
                &mut ios,
                ea.as_mut_ptr().cast(),
                ea.len() as u32,
            )
        },
        0
    );
    Ok(())
}
fn link(owner: &mut OwnedLinks, leaf: &[u16]) -> Result<OwnedLinkReceipt, E> {
    owner.add(
        leaf,
        &mut WorkBudget::new(WORK_LIMIT),
        &AtomicBool::new(false),
    )
}
#[test]
fn native_link_abi_is_class11_counted_utf16_and_an_aligned_bounded_header() {
    use windows_sys::Wdk::Storage::FileSystem::{FILE_LINK_INFORMATION, FileLinkInformation};
    assert_eq!(FileLinkInformation, 11);
    assert_eq!(
        std::mem::offset_of!(FILE_LINK_INFORMATION, RootDirectory),
        8
    );
    assert_eq!(
        std::mem::offset_of!(FILE_LINK_INFORMATION, FileNameLength),
        16
    );
    assert_eq!(std::mem::offset_of!(FILE_LINK_INFORMATION, FileName), 20);
    assert_eq!(std::mem::size_of::<FILE_LINK_INFORMATION>(), 24);
    assert_eq!(std::mem::align_of::<FILE_LINK_INFORMATION>(), 8);
    assert_eq!(20 + 2 * 255, 530);
}
#[test]
fn owned_ntfs_relative_link_retains_full128_data_ea_and_ordinary_security_then_closes() {
    let result = owned(false, |owner| {
        fill(owner)?;
        let original = stamp(owner.target()?).unwrap();
        let r = link(owner, &"alias-Δ🙂.bin".encode_utf16().collect::<Vec<_>>())?;
        let mut actual = windows_sys::Win32::Storage::FileSystem::FILE_ID_INFO::default();
        assert_ne!(
            unsafe {
                windows_sys::Win32::Storage::FileSystem::GetFileInformationByHandleEx(
                    owner.target()?.as_raw_handle(),
                    windows_sys::Win32::Storage::FileSystem::FileIdInfo,
                    (&mut actual as *mut windows_sys::Win32::Storage::FileSystem::FILE_ID_INFO)
                        .cast(),
                    std::mem::size_of_val(&actual) as u32,
                )
            },
            0
        );
        assert_eq!(r.identity.device, actual.VolumeSerialNumber);
        assert_eq!(
            r.identity.inode,
            u128::from_le_bytes(actual.FileId.Identifier)
        );
        assert_eq!(r.identity, original.identity);
        assert_eq!(r.alias_identity, r.identity);
        assert_eq!(r.links, 2);
        assert_eq!(r.data_bytes, 300);
        assert_eq!(r.ea_count, 1);
        assert!(!r.full_security_observed);
        let expected: [u8; 32] = <sha2::Sha256 as sha2::Digest>::digest(payload()).into();
        assert_eq!(r.data_sha256, expected);
        assert_eq!(r.ea_sha256, r.before_ea_sha256);
        assert_eq!(r.security_sha256, r.before_security_sha256);
        assert_eq!(owner.last_native_status(), Some(0));
        Ok(())
    });
    assert!(result.is_ok());
}
#[test]
fn owned_ntfs_counted_unpaired_and_255unit_aliases_are_not_string_paths() {
    let names = [vec![97, 0xd800, 98], vec![0x4e2d; 255]];
    for name in names {
        owned(false, |owner| {
            fill(owner)?;
            let r = link(owner, &name)?;
            assert_eq!(r.links, 2);
            assert_eq!(r.identity, r.alias_identity);
            Ok(())
        })
        .unwrap();
    }
}
#[test]
fn replace_false_collision_keeps_original_owned_target_and_returns_exact_status() {
    owned(false,|owner| {
        fill(owner)?;let id=stamp(owner.target()?).unwrap().identity;
        let result=link(owner,&"capture.bin".encode_utf16().collect::<Vec<_>>());
        assert!(matches!(result,Err(E::NtStatus{phase:"ownedRelativeLink",status}) if status==0xc0000035u32 as i32));
        assert_eq!(owner.last_native_status(),Some(0xc0000035u32 as i32));
        assert_eq!(stamp(owner.target()?).unwrap().identity,id);assert_eq!(stamp(owner.target()?).unwrap().links,1);
        let file=owner.target()?;file.seek(SeekFrom::Start(0)).unwrap();let mut bytes=Vec::new();file.read_to_end(&mut bytes).unwrap();assert_eq!(bytes,payload());Ok(())
    }).unwrap();
}
#[test]
fn invalid_absolute_stream_traversal_and_precancel_never_create_a_link() {
    owned(false, |owner| {
        fill(owner)?;
        for name in [
            "",
            ".",
            "..",
            "a/b",
            "a\\b",
            "C:target",
            "\\target",
            "file:stream",
            "NUL",
            "trailing.",
        ] {
            assert_eq!(
                link(owner, &name.encode_utf16().collect::<Vec<_>>()).err(),
                Some(E::Invalid)
            );
            assert_eq!(stamp(owner.target()?).unwrap().links, 1);
        }
        assert_eq!(
            owner
                .add(
                    &[65],
                    &mut WorkBudget::new(WORK_LIMIT),
                    &AtomicBool::new(true)
                )
                .err(),
            Some(E::Cancelled)
        );
        assert_eq!(stamp(owner.target()?).unwrap().links, 1);
        Ok(())
    })
    .unwrap();
}
#[test]
fn insufficient_shared_work_is_failure_before_mutation_not_a_short_link_success() {
    owned(false, |owner| {
        fill(owner)?;
        assert_eq!(
            owner
                .add(&[65], &mut WorkBudget::new(0), &AtomicBool::new(false))
                .err(),
            Some(E::Limit)
        );
        assert_eq!(stamp(owner.target()?).unwrap().links, 1);
        Ok(())
    })
    .unwrap();
}
#[test]
#[ignore = "manual: current token permits combined full security target rights; no privilege adjustment"]
fn owned_ntfs_relative_link_keeps_actual_full_security_bytes_when_token_allows() {
    owned(true, |owner| {
        fill(owner)?;
        let r = link(owner, &[0x4e2d, 65])?;
        assert!(r.full_security_observed);
        assert_eq!(r.links, 2);
        assert_eq!(r.ea_count, 1);
        assert_eq!(r.security_sha256, r.before_security_sha256);
        Ok(())
    })
    .unwrap();
}
