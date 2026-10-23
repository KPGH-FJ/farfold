//! Actual same-source two-target ordering control, separate from the unchanged
//! original restrictive-DACL whole-tree regression. No token adjustment/skip.
use super::*;
use crate::file_access::{
    material_backup_io::{RetiredContext, security_last::SecurityLast},
    security_test_fixture::OwnedDacl,
    windows::material_carrier,
};
use sha2::{Digest, Sha256};
use std::{
    fs::{OpenOptions, Permissions},
    mem::ManuallyDrop,
    os::windows::fs::OpenOptionsExt,
    panic::{AssertUnwindSafe, catch_unwind, resume_unwind},
    path::{Path, PathBuf},
};
use windows_sys::{
    Wdk::Storage::FileSystem::NtSetEaFile, Win32::System::SystemServices::ACCESS_SYSTEM_SECURITY,
};

struct Readonly {
    path: PathBuf,
    original: Permissions,
}
impl Drop for Readonly {
    fn drop(&mut self) {
        if std::fs::set_permissions(&self.path, self.original.clone()).is_err() {
            eprintln!("FARFOLD_SECURITY_ORDER_OWNED_READONLY_CLEANUP_UNKNOWN");
        }
    }
}
fn add_material(path: &Path) {
    let file = OpenOptions::new()
        .access_mode(FILE_WRITE_EA | SYNCHRONIZE)
        .open(path)
        .unwrap();
    let mut bytes = vec![0u8; 8];
    bytes[5] = 1;
    bytes[6..8].copy_from_slice(&2u16.to_le_bytes());
    bytes.extend(b"X\0\0\xff");
    let mut ios = IO_STATUS_BLOCK::default();
    assert_eq!(
        unsafe {
            NtSetEaFile(
                handle(&file),
                &mut ios,
                bytes.as_ptr().cast(),
                bytes.len() as u32,
            )
        },
        0
    );
    drop(file);
    let mut ads = path.as_os_str().to_os_string();
    ads.push(":retained:$DATA");
    std::fs::write(PathBuf::from(ads), b"actual-ads\0\xff").unwrap();
}

#[test]
#[ignore = "manual: existing SeSecurity with Backup/Restore disabled; actual restrictive full-SD two-target ordering control"]
fn same_full_security_carrier_original_order_denies_ads_security_last_recaptures_exactly() {
    let temp = crate::test_support::tempdir().unwrap();
    let path = temp.path().join("owned.bin");
    std::fs::write(&path, b"owned restrictive data").unwrap();
    add_material(&path);
    let readonly = Readonly {
        path: path.clone(),
        original: std::fs::metadata(&path).unwrap().permissions(),
    };
    let mut permissions = readonly.original.clone();
    permissions.set_readonly(true);
    std::fs::set_permissions(&path, permissions).unwrap();
    let parent_dacl = OwnedDacl::directory(temp.path());
    parent_dacl.set("D:P(D;;0x00000040;;;WD)(A;;FA;;;WD)");
    let dacl = OwnedDacl::new(&path);
    dacl.set("D:P(A;;FR;;;WD)");
    assert_eq!(
        OpenOptions::new()
            .access_mode(DELETE)
            .open(&path)
            .unwrap_err()
            .raw_os_error(),
        Some(5)
    );
    let source = OpenOptions::new()
        .access_mode(FILE_GENERIC_READ | ACCESS_SYSTEM_SECURITY)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .open(&path)
        .unwrap();
    let resident = Resident::new(records::RESIDENT_LIMIT);
    let memory = resident.lease(8 * records::BLOCK).unwrap();
    let mut work = WorkBudget::new(records::WORK_LIMIT);
    let cancel = AtomicBool::new(false);
    let mut namespaces = [
        material_restore::Namespace::reserve().unwrap(),
        material_restore::Namespace::reserve().unwrap(),
    ];
    let mut contexts: [Option<RetiredContext>; 2] = [None, None];
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        // Both targets are created and held before either native write. The
        // failed target is only inspected and cleaned using its original handle.
        for ns in &mut namespaces {
            ns.open().unwrap();
            ns.create_target().unwrap();
        }
        let original = regular::facts(&source, &mut work, &cancel, &resident).unwrap();
        assert_eq!(original.expected.len(), 2);
        assert_eq!(original.ea.count, 1);
        let carrier = namespaces[0].source_carrier.as_ref().unwrap();
        let parsed = material_carrier::captured(
            &source,
            carrier,
            &original,
            &mut work,
            &cancel,
            &mut contexts[0],
            &resident,
        )
        .unwrap();
        let security = parsed.security_record.clone().unwrap();
        assert_eq!(
            security.start, 0,
            "control requires the actual security-first carrier"
        );
        assert!(security.end < parsed.bytes);
        assert!(parsed.bytes <= (2 * records::BLOCK) as u64);
        let _comparison_memory = resident.lease(2 * parsed.bytes as usize).unwrap();
        let mut source_bytes = Vec::new();
        let mut reader = carrier;
        reader.rewind().unwrap();
        (&mut reader)
            .take(parsed.bytes + 1)
            .read_to_end(&mut source_bytes)
            .unwrap();
        assert_eq!(source_bytes.len() as u64, parsed.bytes);
        charge(&mut work, source_bytes.len()).unwrap();
        let source_hash: [u8; 32] = Sha256::digest(&source_bytes).into();
        assert_eq!(source_hash, parsed.sha256);
        let first = namespaces[0].target.as_ref().unwrap();
        let second = namespaces[1].target.as_ref().unwrap();
        assert_ne!(
            stamp(first).unwrap().identity,
            stamp(second).unwrap().identity
        );
        let minimum = size_of::<WIN32_STREAM_ID>() + 1;
        let mut api = Native::new(true);
        let mut session = Session::new(first, &mut api, Mode::Write, &mut contexts[0]);
        let denied = transfer::restore(
            &mut session,
            carrier,
            parsed.bytes,
            &mut work,
            &cancel,
            minimum,
            &resident,
        );
        drop(session);
        assert_eq!(
            denied,
            Err(Error::Io {
                phase: "backupWrite",
                code: Some(5)
            })
        );
        assert!(contexts[0].is_none());
        assert_eq!(api.aborts(), 1);
        assert_eq!(
            regular::security(first, &mut work, &cancel).unwrap(),
            original.security
        );
        let partial = regular::inventory(first, &mut work, &cancel)
            .unwrap()
            .carrier_data();
        assert_eq!(
            partial,
            [(Vec::new(), original.expected[&Vec::new()])].into()
        );
        eprintln!(
            "FARFOLD_SECURITY_ORDER_CONTROL original-order=denied5 full-sd-equal=true named-streams=0"
        );
        let mut api = Native::new(true);
        let mut session = Session::new(second, &mut api, Mode::Write, &mut contexts[1]);
        let input = SecurityLast::new(carrier, parsed.bytes, security).unwrap();
        let restored = transfer::restore(
            &mut session,
            input,
            parsed.bytes,
            &mut work,
            &cancel,
            minimum,
            &resident,
        );
        drop(session);
        assert_eq!(restored, Ok(()));
        assert!(contexts[1].is_none());
        assert_eq!(api.aborts(), 1);
        material_restore::flushed(second).unwrap();
        let actual = regular::facts(second, &mut work, &cancel, &resident).unwrap();
        assert_eq!(actual.expected, original.expected);
        assert_eq!(actual.ea, original.ea);
        assert_eq!(actual.security, original.security);
        let recaptured = material_carrier::captured(
            second,
            namespaces[1].target_carrier.as_ref().unwrap(),
            &actual,
            &mut work,
            &cancel,
            &mut contexts[1],
            &resident,
        )
        .unwrap();
        assert!(parsed.same_contents(&recaptured));
        material_restore::finalize(second, &original.basic).unwrap();
        let finalized = regular::facts(second, &mut work, &cancel, &resident).unwrap();
        assert_eq!(finalized.basic, original.basic);
        assert_eq!(finalized.security, original.security);
        assert!(
            original.unchanged(&regular::facts(&source, &mut work, &cancel, &resident).unwrap())
        );
        let mut after = Vec::new();
        reader.rewind().unwrap();
        (&mut reader)
            .take(parsed.bytes + 1)
            .read_to_end(&mut after)
            .unwrap();
        charge(&mut work, after.len()).unwrap();
        assert_eq!(after, source_bytes);
        eprintln!(
            "FARFOLD_SECURITY_ORDER_CONTROL security-last=recaptured-exactly source-unchanged=true"
        );
    }));
    let cleanup = if contexts.iter().all(Option::is_none) {
        (namespaces[0].cleanup(), namespaces[1].cleanup())
    } else {
        (Err(Error::CleanupUnknown), Err(Error::CleanupUnknown))
    };
    if cleanup.0.is_err() || cleanup.1.is_err() {
        // Retain the complete owned fixture on unknown native context/cleanup,
        // including its original source and permission-restoration handles.
        let _retained = ManuallyDrop::new(Box::new((
            namespaces,
            contexts,
            source,
            dacl,
            parent_dacl,
            readonly,
            temp,
            resident,
            memory,
        )));
        panic!("owned security-order control cleanup unknown: {cleanup:?}");
    }
    dacl.restore();
    parent_dacl.restore();
    drop(readonly);
    if let Err(panic) = outcome {
        resume_unwind(panic);
    }
}
