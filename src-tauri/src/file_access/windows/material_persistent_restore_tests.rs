//! Ordinary Windows framing/owner negatives; never a synthetic restore success.
use super::super::tests::Fixture;
use super::*;
use crate::file_access::material_backup_io::{Api, Mode, Session};
use std::{ffi::c_void, io::Cursor, mem::ManuallyDrop};
#[test]
fn stored_synthetic_typed_bytes_without_actual_facts_never_open_a_target_namespace() {
    let mut f = Fixture::new();
    f.pending(&super::super::tests::bytes());
    f.publish_reopen();
    let mut work = WorkBudget::new(records::WORK_LIMIT);
    let cancel = AtomicBool::new(false);
    assert_eq!(
        rebuild(&mut f.store, &mut work, &cancel).unwrap_err(),
        Error::Unsupported
    );
    assert!(f.store.restore.is_none());
    f.store.cleanup_all().unwrap();
    assert!(f.root.join("material.bin").exists());
}
#[test]
fn missing_native_catalogue_members_refuse_before_any_target_effect() {
    let mut f = Fixture::new();
    f.pending(&super::super::tests::bytes());
    f.publish_reopen();
    f.store.copied.as_mut().unwrap().native_catalog = Some(Vec::new());
    assert_eq!(
        rebuild(
            &mut f.store,
            &mut WorkBudget::new(records::WORK_LIMIT),
            &AtomicBool::new(false)
        )
        .unwrap_err(),
        Error::Changed
    );
    assert!(f.store.restore.is_none());
    f.store.cleanup_all().unwrap();
}
#[test]
fn cancelled_or_exhausted_rebuild_does_not_offer_native_write_or_erase_material() {
    for (cancel, limit, wanted) in [
        (true, records::WORK_LIMIT, Error::Cancelled),
        (false, 0, Error::Limit),
    ] {
        let mut f = Fixture::new();
        f.pending(&super::super::tests::bytes());
        f.publish_reopen();
        assert_eq!(
            rebuild(
                &mut f.store,
                &mut WorkBudget::new(limit),
                &AtomicBool::new(cancel)
            )
            .unwrap_err(),
            wanted
        );
        assert!(f.store.restore.is_none());
        f.store.cleanup_all().unwrap();
        assert!(f.root.join("material.bin").exists());
    }
}
struct FailedAbort {
    attempts: u32,
    aborts: u32,
}
impl Api for FailedAbort {
    fn read(&mut self, _: &File, _: &mut [u8], _: &mut *mut c_void) -> io::Result<usize> {
        unreachable!()
    }
    fn write(&mut self, _: &File, bytes: &[u8], context: &mut *mut c_void) -> io::Result<usize> {
        self.attempts += 1;
        *context = std::ptr::dangling_mut::<c_void>();
        Ok(bytes.len())
    }
    fn abort(&mut self, _: Mode, _: &File, _: &mut *mut c_void) -> io::Result<()> {
        self.aborts += 1;
        Err(io::Error::from_raw_os_error(42))
    }
}
#[test]
fn failed_native_abort_prevents_actual_store_cleanup_and_keeps_the_same_resources() {
    let mut f = Fixture::new();
    f.pending(&super::super::tests::bytes());
    f.publish_reopen();
    f.store.restore = Some(Restore::reserve(&f.store.request.resident).unwrap());
    let mut api = FailedAbort {
        attempts: 0,
        aborts: 0,
    };
    let mut work = WorkBudget::new(records::WORK_LIMIT);
    let cancel = AtomicBool::new(false);
    let mut session = Session::new(
        f.store.file.as_ref().unwrap(),
        &mut api,
        Mode::Write,
        &mut f.store.restore.as_mut().unwrap().context,
    );
    let result = crate::file_access::material_backup_io::restore(
        &mut session,
        Cursor::new([1u8; 21]),
        21,
        &mut work,
        &cancel,
        21,
        &f.store.request.resident,
    );
    drop(session);
    assert!(result.is_err());
    assert_eq!((api.attempts, api.aborts), (1, 1));
    assert!(f.store.restore.as_ref().unwrap().context.is_some());
    assert_eq!(f.store.cleanup_all().unwrap_err(), Error::CleanupUnknown);
    assert!(f.store.file.is_some());
    assert!(f.root.join("material.bin").exists());
    // Fake opaque value has no real native context. Still retain the ORIGINAL
    // Store+Fixture as one finite resource unit; no pretend abort/release/retry.
    let _retired = ManuallyDrop::new(Box::new(f));
}
