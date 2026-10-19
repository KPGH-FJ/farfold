//! Test-registered first real carrier component. No public recovery gate opens.
use super::*;
use super::{
    material_carrier_native::{self as native, Facts},
    material_restore::{self, Namespace},
};
use crate::file_access::{
    ea_records::WorkBudget,
    material_backup_io::{self as transfer, Api, Mode, RetiredContext, Session},
    material_carrier_records::{
        self as records, Error, Parsed, RESIDENT_LIMIT, Resident, Result, WORK_LIMIT, check,
        io_error,
    },
};
use std::{
    ffi::c_void,
    io::{Seek, SeekFrom},
    panic::AssertUnwindSafe,
    sync::atomic::AtomicBool,
};

pub(crate) struct CarrierRequest {
    parent: PinnedPath,
    leaf: Vec<u16>,
    expected: Identity,
}
impl CarrierRequest {
    // Internal held-capability constructor. The only registered consumers in
    // this slice are OWNED tests; this is not arbitrary public-path authority.
    pub(crate) fn held_regular(
        parent: PinnedPath,
        leaf: Vec<u16>,
        expected: Identity,
    ) -> Result<Self> {
        if !parent.full_security_purpose()
            || stamp(parent.file())
                .map_err(|e| io_error("sourceParent", e))?
                .regular
        {
            return Err(Error::Unsupported);
        }
        let text = String::from_utf16(&leaf).map_err(|_| Error::Unsupported)?;
        name(OsStr::new(&text)).map_err(|e| io_error("sourceLeaf", e))?;
        Ok(Self {
            parent,
            leaf,
            expected,
        })
    }
}
// Raw context stays inert and PRIVATE. The outer existing Slot stores this
// whole owner using ManuallyDrop<Box<_>> until process exit on any unknown.
pub(crate) struct CarrierRetirement {
    _source: Option<PinnedPath>,
    _parent: PinnedPath,
    _namespace: Option<Namespace>,
    _context: Option<RetiredContext>,
    _operation_error: Option<Error>,
    _cleanup_error: Error,
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct CarrierReceipt {
    pub source: Identity,
    pub target: Identity,
    pub carrier_bytes: u64,
    pub carrier_sha256: [u8; 32],
    pub data_streams: usize,
    pub ea_count: u64,
    pub full_security_sha256: [u8; 32],
    pub target_recaptured: bool,
    pub owned_handles_closed_and_disposition_accepted: bool,
}
struct Native;
impl Api for Native {
    fn read(&mut self, file: &File, bytes: &mut [u8], ctx: &mut *mut c_void) -> io::Result<usize> {
        let mut n = 0;
        if unsafe {
            BackupRead(
                handle(file),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                &mut n,
                0,
                1,
                ctx,
            )
        } == 0
        {
            Err(io::Error::last_os_error())
        } else {
            Ok(n as usize)
        }
    }
    fn write(&mut self, file: &File, bytes: &[u8], ctx: &mut *mut c_void) -> io::Result<usize> {
        let mut n = 0;
        if unsafe {
            BackupWrite(
                handle(file),
                bytes.as_ptr(),
                bytes.len() as u32,
                &mut n,
                0,
                1,
                ctx,
            )
        } == 0
        {
            Err(io::Error::last_os_error())
        } else {
            Ok(n as usize)
        }
    }
    fn abort(&mut self, mode: Mode, file: &File, ctx: &mut *mut c_void) -> io::Result<()> {
        let ok = unsafe {
            match mode {
                Mode::Read => {
                    BackupRead(handle(file), ptr::null_mut(), 0, ptr::null_mut(), 1, 1, ctx)
                }
                Mode::Write => {
                    BackupWrite(handle(file), ptr::null(), 0, ptr::null_mut(), 1, 1, ctx)
                }
            }
        };
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}
fn parsed(
    spool: &File,
    facts: &Facts,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    resident: &Resident,
) -> Result<Parsed> {
    let mut input = spool;
    input
        .seek(SeekFrom::Start(0))
        .map_err(|e| io_error("carrierSeek", e))?;
    let value = records::parse(input, &facts.expected, work, cancel, resident)?;
    if value.security != facts.security || value.has_ea() != (facts.ea.count != 0) {
        return Err(Error::Changed);
    }
    Ok(value)
}
fn captured(
    file: &File,
    spool: &File,
    facts: &Facts,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    context: &mut Option<RetiredContext>,
    resident: &Resident,
) -> Result<Parsed> {
    let mut api = Native;
    let mut session = Session::new(file, &mut api, Mode::Read, context);
    let length = transfer::capture(
        &mut session,
        spool,
        work,
        cancel,
        size_of::<WIN32_STREAM_ID>() + 1,
        resident,
    )?;
    drop(session);
    material_restore::flushed(spool)?;
    let value = parsed(spool, facts, work, cancel, resident)?;
    if value.bytes != length {
        return Err(Error::Changed);
    }
    Ok(value)
}
pub(crate) fn carrier_roundtrip(
    request: CarrierRequest,
    cancel: &AtomicBool,
    retirement: &mut Option<CarrierRetirement>,
) -> Result<CarrierReceipt> {
    if retirement.is_some() {
        return Err(Error::CleanupUnknown);
    }
    let CarrierRequest {
        parent,
        leaf,
        expected,
    } = request;
    let mut source = None;
    let mut namespace = None;
    let mut context = None;
    // Caller acquires its existing Slot before here. Reservation spans source,
    // carrier, native write, recapture and all cleanup, including Rust unwind.
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        check(cancel)?;
        parent.verify().map_err(|e| io_error("parentVerify", e))?;
        source = Some(
            parent
                .child(&leaf, false)
                .map_err(|e| io_error("sourceOpen", e))?,
        );
        let pin = source.as_ref().ok_or(Error::Invalid)?;
        if pin.identity() != &expected {
            return Err(Error::Changed);
        }
        let _query = pin
            .try_observation_owner()
            .map_err(|_| Error::Unsupported)?;
        pin.verify().map_err(|e| io_error("sourceVerify", e))?;
        let mut work = WorkBudget::new(WORK_LIMIT);
        let resident = Resident::new(RESIDENT_LIMIT);
        let _namespace_memory = resident.lease(4 * records::BLOCK)?;
        let before = native::facts(pin.file(), &mut work, cancel, &resident)?;
        namespace = Some(Namespace::reserve()?);
        let ns = namespace.as_mut().ok_or(Error::Invalid)?;
        ns.open()?;
        let carrier = ns.source_carrier.as_ref().ok_or(Error::Invalid)?;
        let first = captured(
            pin.file(),
            carrier,
            &before,
            &mut work,
            cancel,
            &mut context,
            &resident,
        )?;
        let after = native::facts(pin.file(), &mut work, cancel, &resident)?;
        if !before.unchanged(&after) {
            return Err(Error::Changed);
        }
        drop(after);
        pin.verify()
            .map_err(|e| io_error("sourceAfterCapture", e))?;
        // Full framing/SD/inventory and source fences pass BEFORE target create.
        // The carrier handle is exclusive; no writable external alias is made.
        ns.create_target()?;
        let target = ns.target.as_ref().ok_or(Error::Invalid)?;
        let target_id = stamp(target)
            .map_err(|e| io_error("targetStamp", e))?
            .identity;
        if target_id == expected {
            return Err(Error::Changed);
        }
        let mut api = Native;
        let mut session = Session::new(target, &mut api, Mode::Write, &mut context);
        transfer::restore(
            &mut session,
            ns.source_carrier.as_ref().ok_or(Error::Invalid)?,
            first.bytes,
            &mut work,
            cancel,
            size_of::<WIN32_STREAM_ID>() + 1,
            &resident,
        )?;
        drop(session);
        material_restore::flushed(target)?;
        material_restore::finalize(target, &before.basic)?;
        let target_before = native::facts(target, &mut work, cancel, &resident)?;
        if target_before.expected != before.expected
            || target_before.ea != before.ea
            || target_before.security != before.security
        {
            return Err(Error::Changed);
        }
        let recaptured = captured(
            target,
            ns.target_carrier.as_ref().ok_or(Error::Invalid)?,
            &target_before,
            &mut work,
            cancel,
            &mut context,
            &resident,
        )?;
        let target_after = native::facts(target, &mut work, cancel, &resident)?;
        if !target_before.unchanged(&target_after) || !first.same_contents(&recaptured) {
            return Err(Error::Changed);
        }
        drop(target_after);
        if !before.unchanged(&native::facts(pin.file(), &mut work, cancel, &resident)?) {
            return Err(Error::Changed);
        }
        pin.verify().map_err(|e| io_error("sourceFinalVerify", e))?;
        parent
            .verify()
            .map_err(|e| io_error("parentFinalVerify", e))?;
        ns.verify()?;
        check(cancel)?;
        material_restore::finalize(target, &before.basic)?;
        material_restore::flushed(target)?;
        let actual: FILE_BASIC_INFO =
            info(target, FileBasicInfo).map_err(|e| io_error("targetFinalBasic", e))?;
        if actual.CreationTime != before.basic.created
            || actual.LastAccessTime != before.basic.accessed
            || actual.LastWriteTime != before.basic.modified
            || actual.FileAttributes != before.basic.attributes
            || stamp(target)
                .map_err(|e| io_error("targetFinalStamp", e))?
                .identity
                != target_id
        {
            return Err(Error::Changed);
        }
        Ok(CarrierReceipt {
            source: expected.clone(),
            target: target_id,
            carrier_bytes: first.bytes,
            carrier_sha256: first.sha256,
            data_streams: before.expected.len(),
            ea_count: before.ea.count,
            full_security_sha256: before.security.sha256,
            target_recaptured: true,
            owned_handles_closed_and_disposition_accepted: false,
        })
    }))
    .unwrap_or(Err(Error::Unsupported));
    // NEVER dispose handles/namespace after an unsuccessful read/write abort.
    let cleanup = if context.is_none() {
        namespace.as_mut().map_or(Ok(()), Namespace::cleanup)
    } else {
        Err(Error::CleanupUnknown)
    };
    if let Err(cleanup_error) = cleanup {
        let operation_error = context
            .as_ref()
            .and_then(RetiredContext::operation_error)
            .cloned()
            .or_else(|| result.err());
        *retirement = Some(CarrierRetirement {
            _source: source,
            _parent: parent,
            _namespace: namespace,
            _context: context,
            _operation_error: operation_error,
            _cleanup_error: cleanup_error,
        });
        return Err(Error::CleanupUnknown);
    }
    result.map(|mut receipt| {
        receipt.owned_handles_closed_and_disposition_accepted = true;
        receipt
    })
}
