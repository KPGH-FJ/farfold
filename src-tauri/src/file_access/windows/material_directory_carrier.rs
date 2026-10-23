//! Internal typed DIRECTORY capture and optional one-owned-target consumer.
//! No child topology, recursive carrier, TreeFacet completion, or public gate.
use super::*;
#[cfg(test)]
use super::{
    directory::Owner as DirectoryOwner,
    material_directory_facts as facts,
    material_pin::MaterialPin,
    material_restore::{self, Namespace},
};
#[cfg(test)]
use crate::file_access::{
    ea_records::WorkBudget,
    material_backup_io::{self as transfer, RetiredContext, Session},
    material_carrier_records::{self as records, Resident, ResidentLease, Result, check, io_error},
    material_directory_facet as facet,
    material_directory_records::{self as parser, Profile},
};
use crate::file_access::{
    material_backup_io::{Api, Mode},
    material_carrier_records::Error,
};
use std::ffi::c_void;
#[cfg(test)]
use std::{
    io::{Seek, SeekFrom},
    panic::AssertUnwindSafe,
    sync::atomic::AtomicBool,
};
#[cfg(test)]
pub(crate) struct DirectoryMemory(Resident);
#[cfg(test)]
impl Default for DirectoryMemory {
    fn default() -> Self {
        Self(Resident::new(records::RESIDENT_LIMIT))
    }
}
#[cfg(test)]
pub(crate) struct DirectoryRequest {
    source: MaterialPin,
    leaf: Vec<u16>,
    resident: Resident,
    _memory: ResidentLease,
}
pub(super) fn pin_error(error: super::material_pin::Failure) -> Error {
    use super::material_pin::Failure as E;
    match error {
        E::Cancelled => Error::Cancelled,
        E::Limit => Error::Limit,
        E::Changed => Error::Changed,
        E::Name(_) => Error::Invalid,
        E::Io {
            phase,
            code,
            nt_status: Some(status),
            ..
        } => {
            let _ = code;
            Error::NtStatus { phase, status }
        }
        E::Io { phase, code, .. } => Error::Io { phase, code },
        _ => Error::Unsupported,
    }
}
#[cfg(test)]
impl DirectoryRequest {
    pub(crate) fn held(
        pin: PinnedPath,
        leaf: Vec<u16>,
        memory: &DirectoryMemory,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        let reserved = memory.0.lease(2048)?;
        let source = MaterialPin::root(pin, &memory.0, cancel).map_err(pin_error)?;
        source.directory_carrier_leaf(&leaf).map_err(pin_error)?;
        Ok(Self {
            source,
            leaf,
            resident: memory.0.clone(),
            _memory: reserved,
        })
    }
}
#[cfg(test)]
pub(crate) struct DirectoryRetirement {
    _source: MaterialPin,
    _namespace: Option<Namespace>,
    _context: Option<RetiredContext>,
    _operation_error: Option<Error>,
    _cleanup_error: Error,
    _resident: Resident,
    _memory: ResidentLease,
    _namespace_memory: Option<ResidentLease>,
}
#[cfg(test)]
#[derive(Debug)]
pub(crate) struct DirectoryReceipt {
    pub source: Identity,
    pub raw_leaf: Vec<u16>,
    pub native_bytes: u64,
    pub native_sha256: [u8; 32],
    pub facet_bytes: u64,
    pub record_sha256: [u8; 32],
    pub named_data: usize,
    pub ea_count: u64,
    pub full_security_sha256: Option<[u8; 32]>,
    pub native_eof: bool,
    pub abort_calls: u32,
    pub verified_bytes: bool,
    pub owned_carriers_closed: bool,
    _memory: ResidentLease,
}
pub(super) struct Native {
    full: bool,
    eof: bool,
    aborts: u32,
}
impl Native {
    pub(super) fn new(full: bool) -> Self {
        Self {
            full,
            eof: false,
            aborts: 0,
        }
    }
    pub(super) fn eof(&self) -> bool {
        self.eof
    }
    pub(super) fn aborts(&self) -> u32 {
        self.aborts
    }
}
#[cfg(test)]
pub(super) struct Captured<'a> {
    pub facts: &'a facts::Facts,
    pub parsed: &'a parser::Parsed,
    pub metadata: &'a facet::Metadata,
}
#[cfg(test)]
pub(super) trait DirectoryConsumer {
    fn consume(
        &mut self,
        namespace: &mut Namespace,
        source: Captured<'_>,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
        resident: &Resident,
        context: &mut Option<RetiredContext>,
    ) -> Result<()>;
}
impl Api for Native {
    fn read(
        &mut self,
        file: &File,
        bytes: &mut [u8],
        context: &mut *mut c_void,
    ) -> io::Result<usize> {
        let mut count = 0;
        let ok = unsafe {
            BackupRead(
                handle(file),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                &mut count,
                0,
                i32::from(self.full),
                context,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        self.eof = count == 0;
        Ok(count as usize)
    }
    fn write(&mut self, file: &File, bytes: &[u8], context: &mut *mut c_void) -> io::Result<usize> {
        let mut count = 0;
        if unsafe {
            BackupWrite(
                handle(file),
                bytes.as_ptr(),
                bytes.len() as u32,
                &mut count,
                0,
                i32::from(self.full),
                context,
            )
        } == 0
        {
            // Save the native error before test-only diagnostic I/O.
            let error = io::Error::last_os_error();
            #[cfg(test)]
            eprintln!(
                "FARFOLD_BACKUP_WRITE_NATIVE_FAILURE fullSecurity={} offered={} reportedCount={} code={:?} reportedCountIsSuccessfulPrefix=false",
                self.full,
                bytes.len(),
                count,
                error.raw_os_error()
            );
            Err(error)
        } else {
            Ok(count as usize)
        }
    }
    fn abort(&mut self, mode: Mode, file: &File, context: &mut *mut c_void) -> io::Result<()> {
        self.aborts = self
            .aborts
            .checked_add(1)
            .ok_or_else(|| io::Error::other("abort count"))?;
        if unsafe {
            match mode {
                Mode::Read => BackupRead(
                    handle(file),
                    ptr::null_mut(),
                    0,
                    ptr::null_mut(),
                    1,
                    i32::from(self.full),
                    context,
                ),
                Mode::Write => BackupWrite(
                    handle(file),
                    ptr::null(),
                    0,
                    ptr::null_mut(),
                    1,
                    i32::from(self.full),
                    context,
                ),
            }
        } == 0
        {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}
#[cfg(test)]
pub(crate) fn capture_directory(
    request: DirectoryRequest,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    retirement: &mut Option<DirectoryRetirement>,
) -> Result<DirectoryReceipt> {
    capture_with_consumer(request, work, cancel, retirement, None)
}
#[cfg(test)]
pub(super) fn capture_with_consumer(
    request: DirectoryRequest,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    retirement: &mut Option<DirectoryRetirement>,
    mut consumer: Option<&mut dyn DirectoryConsumer>,
) -> Result<DirectoryReceipt> {
    if retirement.is_some() {
        return Err(Error::CleanupUnknown);
    }
    let DirectoryRequest {
        source,
        leaf,
        resident,
        _memory,
    } = request;
    let mut namespace = None;
    let mut namespace_memory = None;
    let mut context = None;
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        check(cancel)?;
        if work.remaining() > records::WORK_LIMIT {
            return Err(Error::Limit);
        }
        let _query = source
            .try_observation_owner()
            .map_err(|_| Error::Unsupported)?;
        source
            .verify()
            .map_err(|e| io_error("directorySourceVerify", e))?;
        source
            .directory_carrier_leaf(&leaf)
            .map_err(|_| Error::Changed)?;
        let file = DirectoryOwner::file(&source);
        let full = source.full_security_purpose();
        let before = facts::take(file, full, work, cancel, &resident)?;
        namespace_memory = Some(resident.lease(4 * records::BLOCK)?);
        namespace = Some(Namespace::reserve()?);
        let ns = namespace.as_mut().ok_or(Error::Invalid)?;
        if consumer.is_some() {
            ns.open_directory_namespace()?;
        } else {
            ns.open()?;
        }
        let spool = ns.source_carrier.as_ref().ok_or(Error::Invalid)?;
        let mut api = Native {
            full,
            eof: false,
            aborts: 0,
        };
        let mut session = Session::new(file, &mut api, Mode::Read, &mut context);
        let length = transfer::capture(
            &mut session,
            spool,
            work,
            cancel,
            size_of::<WIN32_STREAM_ID>() + 1,
            &resident,
        )?;
        drop(session);
        if !api.eof || api.aborts != 1 {
            return Err(Error::Invalid);
        }
        material_restore::flushed(spool)?;
        let mut input = spool;
        input
            .seek(SeekFrom::Start(0))
            .map_err(|e| io_error("directoryCarrierSeek", e))?;
        let profile = if full {
            Profile::WithFullSecurity
        } else {
            Profile::PayloadOnly
        };
        let parsed = parser::parse(
            &mut input,
            &before.expected,
            profile,
            work,
            cancel,
            &resident,
        )?;
        if parsed.bytes != length
            || parsed.security != before.security
            || parsed.ea.as_ref().is_some_and(|v| v != &before.ea)
            || parsed.has_ea() != (before.ea.count != 0)
        {
            return Err(Error::Changed);
        }
        if !before.unchanged(&facts::take(file, full, work, cancel, &resident)?) {
            return Err(Error::Changed);
        }
        source
            .verify()
            .map_err(|e| io_error("directorySourceAfter", e))?;
        let meta = facet::Metadata {
            security_full: full,
            raw_leaf: leaf.clone(),
            source_volume: before.stamp.identity.device,
            source_id: before.stamp.identity.inode,
            created: before.basic.created,
            accessed: before.basic.accessed,
            modified: before.basic.modified,
            attributes: before.basic.attributes,
        };
        let extent = facet::NativeExtent {
            bytes: parsed.bytes,
            sha256: parsed.sha256,
        };
        input
            .seek(SeekFrom::Start(0))
            .map_err(|e| io_error("directoryFacetSeek", e))?;
        let mut output = ns.target_carrier.as_ref().ok_or(Error::Invalid)?;
        let stored = facet::append(
            &mut input,
            &mut output,
            &meta,
            &extent,
            work,
            cancel,
            &resident,
        )?;
        material_restore::flushed(output)?;
        output
            .seek(SeekFrom::Start(0))
            .map_err(|e| io_error("directoryVerifySeek", e))?;
        let verified = facet::verify_exact(&mut output, work, cancel, &resident)?;
        if verified.metadata != meta
            || verified.native.bytes != parsed.bytes
            || verified.native.sha256 != parsed.sha256
            || verified.stored_bytes != stored
        {
            return Err(Error::Changed);
        }
        if let Some(consumer) = consumer.as_mut() {
            consumer.consume(
                ns,
                Captured {
                    facts: &before,
                    parsed: &parsed,
                    metadata: &meta,
                },
                work,
                cancel,
                &resident,
                &mut context,
            )?;
        }
        if !before.unchanged(&facts::take(file, full, work, cancel, &resident)?) {
            return Err(Error::Changed);
        }
        source
            .verify()
            .map_err(|e| io_error("directoryFinalSource", e))?;
        ns.verify()?;
        check(cancel)?;
        let receipt_memory = resident.lease(2048)?;
        Ok(DirectoryReceipt {
            _memory: receipt_memory,
            source: before.stamp.identity,
            raw_leaf: leaf.clone(),
            native_bytes: length,
            native_sha256: parsed.sha256,
            facet_bytes: stored,
            record_sha256: verified.record_sha256,
            named_data: before.expected.len(),
            ea_count: before.ea.count,
            full_security_sha256: before.security.as_ref().map(|s| s.sha256),
            native_eof: api.eof,
            abort_calls: api.aborts,
            verified_bytes: true,
            owned_carriers_closed: false,
        })
    }))
    .unwrap_or(Err(Error::Unsupported));
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
        *retirement = Some(DirectoryRetirement {
            _source: source,
            _namespace: namespace,
            _context: context,
            _operation_error: operation_error,
            _cleanup_error: cleanup_error,
            _resident: resident,
            _memory,
            _namespace_memory: namespace_memory,
        });
        return Err(Error::CleanupUnknown);
    }
    // Namespace allocation/handles are gone BEFORE its logical allowance returns.
    drop(namespace);
    drop(namespace_memory);
    result.map(|mut r| {
        r.owned_carriers_closed = true;
        r
    })
}
