//! Actual two-source consumer for the reusable entry; no tree/restore completion.
use super::*;
use super::{
    material_carrier::{FragmentConsumer, FragmentSource},
    material_directory_carrier::pin_error,
    material_pin::MaterialPin,
    material_regular_shared::{self as shared, Held, Io},
    material_restore::{self, Namespace},
};
use crate::file_access::{
    ea_records::WorkBudget,
    material_backup_io::RetiredContext,
    material_carrier_fragment as fragment,
    material_carrier_records::{
        self as records, Error, Resident, ResidentLease, Result, check, io_error,
    },
};
use std::{
    io::{Seek, SeekFrom},
    panic::AssertUnwindSafe,
    sync::atomic::AtomicBool,
};
pub(crate) struct RegularSharedMemory(Resident);
impl Default for RegularSharedMemory {
    fn default() -> Self {
        Self(Resident::new(records::RESIDENT_LIMIT))
    }
}
pub(crate) struct RegularSharedRequest {
    root: MaterialPin,
    leaves: [Vec<u16>; 2],
    resident: Resident,
    _memory: ResidentLease,
}
impl RegularSharedRequest {
    pub(crate) fn held(
        parent: PinnedPath,
        leaves: [Vec<u16>; 2],
        memory: &RegularSharedMemory,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        if !parent.full_security_purpose() {
            return Err(Error::Unsupported);
        }
        for leaf in &leaves {
            crate::file_access::material_raw_name::check(leaf).map_err(|_| Error::Unsupported)?;
        }
        let comparison = unsafe {
            CompareStringOrdinal(
                leaves[0].as_ptr(),
                leaves[0].len() as i32,
                leaves[1].as_ptr(),
                leaves[1].len() as i32,
                1,
            )
        };
        if comparison == 0 {
            return Err(io_error("sharedNameCompare", io::Error::last_os_error()));
        }
        if comparison == CSTR_EQUAL {
            return Err(Error::Invalid);
        }
        let reserved = memory.0.lease(8192)?;
        let root = MaterialPin::root(parent, &memory.0, cancel).map_err(pin_error)?;
        Ok(Self {
            root,
            leaves,
            resident: memory.0.clone(),
            _memory: reserved,
        })
    }
}
pub(crate) struct RegularSharedRetirement {
    _root: MaterialPin,
    _sources: Vec<MaterialPin>,
    _namespace: Option<Namespace>,
    _context: Option<RetiredContext>,
    _operation_error: Option<Error>,
    _cleanup_error: Error,
    _resident: Resident,
    _memory: ResidentLease,
    _namespace_memory: Option<ResidentLease>,
}
#[derive(Debug)]
pub(crate) struct RegularSharedReceipt {
    pub sources: [Identity; 2],
    pub carrier_identity: Identity,
    pub native_bytes: [u64; 2],
    pub native_sha256: [[u8; 32]; 2],
    pub typed_sha256: [[u8; 32]; 2],
    pub budget_before: u64,
    pub after_first: u64,
    pub after_second: u64,
    pub owned_carriers_closed: bool,
}
struct Stored {
    source: Identity,
    bytes: u64,
    native: [u8; 32],
    typed: [u8; 32],
}
struct Sink<'a> {
    output: &'a File,
    stored: Option<Stored>,
}
impl FragmentConsumer for Sink<'_> {
    fn consume(
        &mut self,
        source: FragmentSource<'_>,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
        resident: &Resident,
    ) -> Result<()> {
        if self.stored.is_some() {
            return Err(Error::Invalid);
        }
        let _memory = resident.lease(1024)?;
        let meta = fragment::Metadata {
            raw_leaf: source.leaf.to_vec(),
            source_volume: source.facts.stamp.identity.device,
            source_id: source.facts.stamp.identity.inode,
            created: source.facts.basic.created,
            accessed: source.facts.basic.accessed,
            modified: source.facts.basic.modified,
            attributes: source.facts.basic.attributes,
        };
        let extent = fragment::NativeExtent {
            bytes: source.parsed.bytes,
            sha256: source.parsed.sha256,
        };
        let mut input = source.file;
        input
            .seek(SeekFrom::Start(0))
            .map_err(|e| io_error("sharedRead", e))?;
        let mut output = self.output;
        output
            .set_len(0)
            .map_err(|e| io_error("sharedTypedReset", e))?;
        output
            .seek(SeekFrom::Start(0))
            .map_err(|e| io_error("sharedTypedSeek", e))?;
        let stored = fragment::append(
            &mut input,
            &mut output,
            &meta,
            &extent,
            work,
            cancel,
            resident,
        )?;
        material_restore::flushed(output)?;
        output
            .seek(SeekFrom::Start(0))
            .map_err(|e| io_error("sharedTypedVerify", e))?;
        let actual = fragment::verify_exact(&mut output, work, cancel, resident)?;
        if actual.metadata != meta
            || actual.native.bytes != extent.bytes
            || actual.native.sha256 != extent.sha256
            || actual.stored_bytes != stored
        {
            return Err(Error::Changed);
        }
        self.stored = Some(Stored {
            source: source.facts.stamp.identity.clone(),
            bytes: actual.native.bytes,
            native: actual.native.sha256,
            typed: actual.record_sha256,
        });
        Ok(())
    }
}
pub(crate) fn regular_shared_capture(
    request: RegularSharedRequest,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    retirement: &mut Option<RegularSharedRetirement>,
) -> Result<RegularSharedReceipt> {
    if retirement.is_some() {
        return Err(Error::CleanupUnknown);
    }
    let RegularSharedRequest {
        root,
        leaves,
        resident,
        _memory,
    } = request;
    let mut sources = Vec::with_capacity(2);
    let mut namespace = None;
    let mut namespace_memory = None;
    let mut context = None;
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        check(cancel)?;
        let budget_before = work.remaining();
        records::charge(work, 5 * records::BLOCK)?;
        let listed = root.entries(2, cancel).map_err(|e| match e {
            crate::file_access::DirectoryFailure::Cancelled => Error::Cancelled,
            crate::file_access::DirectoryFailure::Limit => Error::Limit,
            crate::file_access::DirectoryFailure::Changed => Error::Changed,
            crate::file_access::DirectoryFailure::Io {
                phase,
                nt_status: Some(status),
                ..
            } => Error::NtStatus { phase, status },
            crate::file_access::DirectoryFailure::Io { phase, code, .. } => {
                Error::Io { phase, code }
            }
            _ => Error::Unsupported,
        })?;
        if listed.as_entries().len() != 2 {
            return Err(Error::Unsupported);
        }
        for raw in &leaves {
            let seen = listed.as_entries().get(raw).ok_or(Error::Changed)?;
            let pin = root.child(raw, seen, cancel).map_err(pin_error)?;
            sources.push(pin);
        } // Duplicate identities still face original links==1 Facts before capture;
        // never reinterpret aliases as independent completed nodes.
        let first = shared::prepare(
            Held::material(&sources[0])?,
            &mut Io {
                work,
                cancel,
                resident: &resident,
                context: &mut context,
            },
        )?;
        if sources[0].identity() == sources[1].identity() {
            return Err(Error::Unsupported);
        }
        namespace_memory = Some(resident.lease(4 * records::BLOCK)?);
        namespace = Some(Namespace::reserve()?);
        let ns = namespace.as_mut().ok_or(Error::Invalid)?;
        ns.open()?;
        let mut first = first.capture(
            ns,
            &mut Io {
                work,
                cancel,
                resident: &resident,
                context: &mut context,
            },
        )?;
        let carrier_identity = first.carrier_identity().clone();
        let a = {
            let mut sink = Sink {
                output: ns.target_carrier.as_ref().ok_or(Error::Invalid)?,
                stored: None,
            };
            first.consume_bytes(
                ns,
                &leaves[0],
                &mut Io {
                    work,
                    cancel,
                    resident: &resident,
                    context: &mut context,
                },
                &mut sink,
            )?;
            sink.stored.take().ok_or(Error::Invalid)?
        };
        let first = first.recycle(
            ns,
            &mut Io {
                work,
                cancel,
                resident: &resident,
                context: &mut context,
            },
        )?;
        let after_first = work.remaining();
        let mut second = shared::prepare(
            Held::material(&sources[1])?,
            &mut Io {
                work,
                cancel,
                resident: &resident,
                context: &mut context,
            },
        )?
        .capture(
            ns,
            &mut Io {
                work,
                cancel,
                resident: &resident,
                context: &mut context,
            },
        )?;
        if second.carrier_identity() != &carrier_identity {
            return Err(Error::Changed);
        }
        let b = {
            let mut sink = Sink {
                output: ns.target_carrier.as_ref().ok_or(Error::Invalid)?,
                stored: None,
            };
            second.consume_bytes(
                ns,
                &leaves[1],
                &mut Io {
                    work,
                    cancel,
                    resident: &resident,
                    context: &mut context,
                },
                &mut sink,
            )?;
            sink.stored.take().ok_or(Error::Invalid)?
        };
        second.verify_unchanged(
            &mut Io {
                work,
                cancel,
                resident: &resident,
                context: &mut context,
            },
            "sharedSecondFinal",
        )?;
        drop(second);
        first.verify_unchanged(
            &mut Io {
                work,
                cancel,
                resident: &resident,
                context: &mut context,
            },
            "sharedFirstFinal",
        )?;
        drop(first);
        root.verify().map_err(|e| io_error("sharedRootFinal", e))?;
        ns.verify()?;
        check(cancel)?;
        Ok(RegularSharedReceipt {
            sources: [a.source, b.source],
            carrier_identity,
            native_bytes: [a.bytes, b.bytes],
            native_sha256: [a.native, b.native],
            typed_sha256: [a.typed, b.typed],
            budget_before,
            after_first,
            after_second: work.remaining(),
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
        *retirement = Some(RegularSharedRetirement {
            _root: root,
            _sources: sources,
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
    drop(namespace);
    drop(namespace_memory);
    result.map(|mut value| {
        value.owned_carriers_closed = true;
        value
    })
}
