//! Actual native facet failures over owned fixtures; never a privilege fallback.
use super::*;
use std::{fs::OpenOptions, os::windows::fs::OpenOptionsExt};
fn file(path: &std::path::Path, access: u32) -> File {
    OpenOptions::new()
        .access_mode(access)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .unwrap()
}
#[test]
fn ordinary_query_missing_read_control_is_denial_not_absent_security() {
    let temp = crate::test_support::tempdir().unwrap();
    let path = temp.path().join("owned");
    std::fs::write(&path, b"preserve").unwrap();
    let held = file(&path, FILE_READ_ATTRIBUTES | SYNCHRONIZE);
    let failure = capture(
        &held,
        &mut WorkBudget::new(1_000_000),
        &AtomicBool::new(false),
        &Resident::new(1_000_000),
    );
    assert!(matches!(
        failure,
        Err(Error::Io {
            phase: "ordinarySecurityQuery",
            code: Some(5)
        })
    ));
    assert_eq!(std::fs::read(path).unwrap(), b"preserve");
}
#[test]
fn ordinary_restore_missing_write_dac_keeps_source_and_target_facets() {
    let temp = crate::test_support::tempdir().unwrap();
    let source_path = temp.path().join("source");
    let target_path = temp.path().join("target");
    std::fs::write(&source_path, b"source").unwrap();
    std::fs::write(&target_path, b"target").unwrap();
    let dacl = crate::file_access::security_test_fixture::OwnedDacl::new(&source_path);
    dacl.set("D:P(A;;FA;;;WD)");
    let source = file(&source_path, FILE_GENERIC_READ);
    // WRITE_OWNER deliberately present; WRITE_DAC deliberately absent.
    let target = file(&target_path, FILE_GENERIC_READ | WRITE_OWNER);
    let mut work = WorkBudget::new(10_000_000);
    let cancel = AtomicBool::new(false);
    let resident = Resident::new(1_000_000);
    let original = capture(&source, &mut work, &cancel, &resident).unwrap();
    let before = capture(&target, &mut work, &cancel, &resident).unwrap();
    assert_ne!(original.summary.dacl_sha256, before.summary.dacl_sha256);
    assert!(matches!(
        restore(
            &target,
            &original.bytes,
            &original.summary,
            &mut work,
            &cancel,
            &resident
        ),
        Err(Error::Io {
            phase: "ordinarySecuritySet",
            code: Some(5)
        })
    ));
    assert!(
        capture(&target, &mut work, &cancel, &resident)
            .unwrap()
            .summary
            .same_facets(&before.summary)
    );
    assert!(
        capture(&source, &mut work, &cancel, &resident)
            .unwrap()
            .summary
            .same_facets(&original.summary)
    );
    assert_eq!(std::fs::read(&source_path).unwrap(), b"source");
    assert_eq!(std::fs::read(&target_path).unwrap(), b"target");
    drop((source, target));
    dacl.restore();
}
#[test]
fn ordinary_query_cancel_or_short_work_keeps_exact_held_object() {
    let temp = crate::test_support::tempdir().unwrap();
    let path = temp.path().join("owned");
    std::fs::write(&path, b"unchanged").unwrap();
    let held = file(&path, FILE_GENERIC_READ);
    let before = stamp(&held).unwrap();
    let resident = Resident::new(1_000_000);
    assert!(matches!(
        capture(
            &held,
            &mut WorkBudget::new(1_000_000),
            &AtomicBool::new(true),
            &resident
        ),
        Err(Error::Cancelled)
    ));
    assert!(matches!(
        capture(
            &held,
            &mut WorkBudget::new((BLOCK - 1) as u64),
            &AtomicBool::new(false),
            &resident
        ),
        Err(Error::Limit)
    ));
    assert_eq!(stamp(&held).unwrap(), before);
    assert_eq!(std::fs::read(path).unwrap(), b"unchanged");
}

fn directory_file(path: &std::path::Path, access: u32) -> File {
    OpenOptions::new()
        .access_mode(access)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .unwrap()
}

// Only a newly-created parent owned by this test is passed here. The ordinary
// product path never obtains a descriptor from SDDL or changes source security.
fn owned_parent_dacl(path: &std::path::Path, text: &str) {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
        },
    };
    let parent = directory_file(path, READ_CONTROL | WRITE_DAC | SYNCHRONIZE);
    let wide: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    let mut raw = ptr::null_mut();
    assert_ne!(
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                SDDL_REVISION_1,
                &mut raw,
                ptr::null_mut(),
            )
        },
        0
    );
    let mut present = 0;
    let mut defaulted = 0;
    let mut acl = ptr::null_mut();
    let read = unsafe { GetSecurityDescriptorDacl(raw, &mut present, &mut acl, &mut defaulted) };
    let set = if read != 0 && present != 0 && !acl.is_null() {
        unsafe {
            SetSecurityInfo(
                handle(&parent),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                acl,
                ptr::null(),
            )
        }
    } else {
        u32::MAX
    };
    assert!(unsafe { LocalFree(raw) }.is_null());
    assert_eq!(set, 0, "owned fixture parent DACL");
}

#[test]
fn ordinary_restore_preserves_unprotected_inherited_dacl_across_different_parents() {
    let temp = crate::test_support::tempdir().unwrap();
    let source_parent = temp.path().join("source-parent");
    let target_parent = temp.path().join("target-parent");
    std::fs::create_dir(&source_parent).unwrap();
    std::fs::create_dir(&target_parent).unwrap();
    owned_parent_dacl(&source_parent, "D:P(A;OICI;FA;;;WD)(A;OICI;FR;;;BU)");
    owned_parent_dacl(&target_parent, "D:P(A;OICI;FA;;;WD)");
    let cancel = AtomicBool::new(false);
    let resident = Resident::new(2_000_000);
    let mut work = WorkBudget::new(100_000_000);
    for directory in [false, true] {
        let name = if directory { "directory" } else { "file" };
        let source_path = source_parent.join(name);
        let target_path = target_parent.join(name);
        if directory {
            std::fs::create_dir(&source_path).unwrap();
            std::fs::create_dir(&target_path).unwrap();
        } else {
            std::fs::write(&source_path, b"original-source").unwrap();
            std::fs::write(&target_path, b"original-target").unwrap();
        }
        let open = if directory { directory_file } else { file };
        let source = open(&source_path, FILE_GENERIC_READ);
        let target = open(&target_path, FILE_GENERIC_READ | WRITE_OWNER | WRITE_DAC);
        let source_id = stamp(&source).unwrap().identity;
        let target_id = stamp(&target).unwrap().identity;
        let original = capture(&source, &mut work, &cancel, &resident).unwrap();
        let before = capture(&target, &mut work, &cancel, &resident).unwrap();
        let decoded = records::decode(&original.bytes, &mut work, &cancel).unwrap();
        let control = u16::from_le_bytes(decoded.owner_group_dacl[2..4].try_into().unwrap());
        assert_eq!(control & SE_DACL_PROTECTED, 0);
        assert_eq!(original.summary.dacl_aces, 2);
        assert_eq!(before.summary.dacl_aces, 1);
        assert_ne!(original.summary.dacl_sha256, before.summary.dacl_sha256);
        restore(
            &target,
            &original.bytes,
            &original.summary,
            &mut work,
            &cancel,
            &resident,
        )
        .unwrap();
        let restored = capture(&target, &mut work, &cancel, &resident).unwrap();
        assert!(restored.summary.same_facets(&original.summary));
        assert!(
            capture(&source, &mut work, &cancel, &resident)
                .unwrap()
                .summary
                .same_facets(&original.summary)
        );
        assert_eq!(stamp(&source).unwrap().identity, source_id);
        assert_eq!(stamp(&target).unwrap().identity, target_id);
        drop((source, target));
        let reopened = open(&target_path, FILE_GENERIC_READ);
        assert!(
            capture(&reopened, &mut work, &cancel, &resident)
                .unwrap()
                .summary
                .same_facets(&original.summary)
        );
        assert_eq!(stamp(&reopened).unwrap().identity, target_id);
        if !directory {
            assert_eq!(std::fs::read(source_path).unwrap(), b"original-source");
            assert_eq!(std::fs::read(target_path).unwrap(), b"original-target");
        }
    }
}
