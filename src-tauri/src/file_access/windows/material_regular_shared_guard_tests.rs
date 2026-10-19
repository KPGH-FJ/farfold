//! Real held read-only source plus controlled inert abort failure, no native claim.
use super::*;
use crate::file_access::{
    material_backup_io::{self as transfer, Api, Mode, Session},
    material_carrier_records::{RESIDENT_LIMIT, WORK_LIMIT},
};
use std::ffi::c_void;
fn ordinary() -> (tempfile::TempDir, PinnedPath) {
    let d = tempfile::tempdir().unwrap();
    std::fs::write(d.path().join("a.bin"), b"read-only-purpose").unwrap();
    let p = PinnedPath::directory(&d.path().canonicalize().unwrap()).unwrap();
    let child = p
        .child(&"a.bin".encode_utf16().collect::<Vec<_>>(), false)
        .unwrap();
    (d, child)
}
#[test]
fn ordinary_held_source_is_rejected_before_work_pool_or_native_context() {
    let (d, p) = ordinary();
    let resident = Resident::new(RESIDENT_LIMIT);
    let mut work = WorkBudget::new(WORK_LIMIT);
    let mut context = None;
    let result = prepare(
        Held::Legacy(&p),
        &mut Io {
            work: &mut work,
            cancel: &AtomicBool::new(false),
            resident: &resident,
            context: &mut context,
        },
    );
    assert!(matches!(&result, Err(Error::Unsupported)));
    drop(result);
    assert!(context.is_none());
    assert_eq!(work.remaining(), WORK_LIMIT);
    assert!(resident.lease(RESIDENT_LIMIT).is_ok());
    drop(p);
    d.close().unwrap();
}
struct FailedAbort {
    reads: u32,
    aborts: u32,
}
impl Api for FailedAbort {
    fn read(&mut self, _: &File, _: &mut [u8], context: &mut *mut c_void) -> io::Result<usize> {
        self.reads += 1;
        *context = 0x77usize as *mut c_void;
        Err(io::Error::from_raw_os_error(23))
    }
    fn write(&mut self, _: &File, _: &[u8], _: &mut *mut c_void) -> io::Result<usize> {
        panic!("not a write fixture")
    }
    fn abort(&mut self, _: Mode, _: &File, _: &mut *mut c_void) -> io::Result<()> {
        self.aborts += 1;
        Err(io::Error::from_raw_os_error(5))
    }
}
#[test]
fn existing_failed_abort_blocks_a_new_prepare_without_replacing_the_original_context() {
    let (d, p) = ordinary();
    let source = tempfile::tempfile().unwrap();
    let spool = tempfile::tempfile().unwrap();
    let resident = Resident::new(RESIDENT_LIMIT);
    let mut work = WorkBudget::new(WORK_LIMIT);
    let mut context = None;
    let cancel = AtomicBool::new(false);
    let mut api = FailedAbort {
        reads: 0,
        aborts: 0,
    };
    let mut session = Session::new(&source, &mut api, Mode::Read, &mut context);
    assert!(matches!(
        transfer::capture(&mut session, &spool, &mut work, &cancel, 33, &resident),
        Err(Error::CleanupUnknown)
    ));
    drop(session);
    assert_eq!(
        context.as_ref().unwrap().operation_error(),
        Some(&Error::Io {
            phase: "backupRead",
            code: Some(23)
        })
    );
    assert!(matches!(
        prepare(
            Held::Legacy(&p),
            &mut Io {
                work: &mut work,
                cancel: &cancel,
                resident: &resident,
                context: &mut context
            }
        ),
        Err(Error::CleanupUnknown)
    ));
    assert_eq!(
        context.as_ref().unwrap().operation_error(),
        Some(&Error::Io {
            phase: "backupRead",
            code: Some(23)
        })
    );
    assert_eq!(api.reads, 1);
    assert_eq!(api.aborts, 1);
    drop(p);
    d.close().unwrap();
    // 0x77 is a stopped inert trait-fake token, never a native BackupRead context.
}
