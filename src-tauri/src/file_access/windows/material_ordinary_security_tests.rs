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
