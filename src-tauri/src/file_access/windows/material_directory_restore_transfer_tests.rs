//! Controlled shared transfer + actual typed file view. NO native fault claim.
use super::*;
use crate::file_access::material_backup_io::Api;
use std::{ffi::c_void, io::Cursor, sync::atomic::Ordering};
fn typed(bytes: &[u8]) -> (File, facet::Verified) {
    let mut file = tempfile::tempfile().unwrap();
    let meta = facet::Metadata {
        security_full: false,
        raw_leaf: vec![0x61, 0xd800],
        source_volume: 1,
        source_id: 1u128 << 110,
        created: 1,
        accessed: 2,
        modified: 3,
        attributes: FILE_ATTRIBUTE_DIRECTORY,
    };
    let hash: [u8; 32] = <sha2::Sha256 as sha2::Digest>::digest(bytes).into();
    let extent = facet::NativeExtent {
        bytes: bytes.len() as u64,
        sha256: hash,
    };
    let resident = Resident::new(records::RESIDENT_LIMIT);
    let mut work = WorkBudget::new(records::WORK_LIMIT);
    facet::append(
        &mut Cursor::new(bytes),
        &mut file,
        &meta,
        &extent,
        &mut work,
        &AtomicBool::new(false),
        &resident,
    )
    .unwrap();
    file.seek(SeekFrom::Start(0)).unwrap();
    let record =
        facet::verify_exact(&mut file, &mut work, &AtomicBool::new(false), &resident).unwrap();
    (file, record)
}
struct Fake<'a> {
    write_error: bool,
    cancel: Option<&'a AtomicBool>,
    abort_error: bool,
    bytes: Vec<u8>,
    calls: u32,
    aborts: u32,
}
impl Api for Fake<'_> {
    fn read(&mut self, _: &File, _: &mut [u8], _: &mut *mut c_void) -> io::Result<usize> {
        Err(io::ErrorKind::Unsupported.into())
    }
    fn write(&mut self, _: &File, b: &[u8], ctx: &mut *mut c_void) -> io::Result<usize> {
        self.calls += 1;
        *ctx = 0x71usize as *mut c_void;
        if self.write_error {
            return Err(io::Error::from_raw_os_error(23));
        }
        let n = if self.calls == 1 {
            33.min(b.len())
        } else {
            b.len()
        };
        self.bytes.extend_from_slice(&b[..n]);
        if let Some(c) = self.cancel {
            c.store(true, Ordering::SeqCst);
        }
        Ok(n)
    }
    fn abort(&mut self, mode: Mode, _: &File, _: &mut *mut c_void) -> io::Result<()> {
        assert!(mode == Mode::Write);
        self.aborts += 1;
        if self.abort_error {
            Err(io::Error::from_raw_os_error(5))
        } else {
            Ok(())
        }
    }
}
fn fake(cancel: Option<&AtomicBool>, write_error: bool, abort_error: bool) -> Fake<'_> {
    Fake {
        write_error,
        cancel,
        abort_error,
        bytes: Vec::new(),
        calls: 0,
        aborts: 0,
    }
}
#[test]
fn actual_typed_file_view_bounds_seek_and_partial_transfer_to_native_extent() {
    let bytes: Vec<u8> = (0..=255).cycle().take(105).collect();
    let (file, record) = typed(&bytes);
    let mut payload = Payload::verified(&file, &record).unwrap();
    assert!(payload.seek(SeekFrom::Start(106)).is_err());
    assert!(payload.seek(SeekFrom::Current(-1)).is_err());
    let target = tempfile::tempfile().unwrap();
    let mut api = fake(None, false, false);
    let mut retired = None;
    let mut session = Session::new(&target, &mut api, Mode::Write, &mut retired);
    transfer::restore(
        &mut session,
        payload,
        105,
        &mut WorkBudget::new(records::WORK_LIMIT),
        &AtomicBool::new(false),
        33,
        &Resident::new(records::RESIDENT_LIMIT),
    )
    .unwrap();
    drop(session);
    assert_eq!(api.bytes, bytes);
    assert_eq!(api.calls, 2);
    assert_eq!(api.aborts, 1);
    assert!(retired.is_none());
}
#[test]
fn typed_transfer_retains_distinct_write_error_and_failed_abort_once() {
    let (file, record) = typed(&[7; 105]);
    let target = tempfile::tempfile().unwrap();
    let mut api = fake(None, true, true);
    let mut retired = None;
    let mut session = Session::new(&target, &mut api, Mode::Write, &mut retired);
    assert!(matches!(
        transfer::restore(
            &mut session,
            Payload::verified(&file, &record).unwrap(),
            105,
            &mut WorkBudget::new(records::WORK_LIMIT),
            &AtomicBool::new(false),
            33,
            &Resident::new(records::RESIDENT_LIMIT)
        ),
        Err(Error::CleanupUnknown)
    ));
    drop(session);
    assert_eq!(
        retired.as_ref().unwrap().operation_error(),
        Some(&Error::Io {
            phase: "backupWrite",
            code: Some(23)
        })
    );
    assert_eq!(api.aborts, 1);
    assert_eq!(api.calls, 1);
    // This is an inert trait-fake token, NOT an un-aborted native Windows context.
}
#[test]
fn typed_transfer_cancellation_after_partial_write_keeps_failed_abort_owner() {
    let (file, record) = typed(&[7; 105]);
    let target = tempfile::tempfile().unwrap();
    let cancel = AtomicBool::new(false);
    let mut api = fake(Some(&cancel), false, true);
    let mut retired = None;
    let mut session = Session::new(&target, &mut api, Mode::Write, &mut retired);
    assert!(matches!(
        transfer::restore(
            &mut session,
            Payload::verified(&file, &record).unwrap(),
            105,
            &mut WorkBudget::new(records::WORK_LIMIT),
            &cancel,
            33,
            &Resident::new(records::RESIDENT_LIMIT)
        ),
        Err(Error::CleanupUnknown)
    ));
    drop(session);
    assert_eq!(
        retired.as_ref().unwrap().operation_error(),
        Some(&Error::Cancelled)
    );
    assert_eq!(api.calls, 1);
    assert_eq!(api.aborts, 1);
    assert_eq!(api.bytes.len(), 33);
}
