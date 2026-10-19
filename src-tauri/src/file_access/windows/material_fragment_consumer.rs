//! First real byte consumer, while complete tree/Manifest2 restoration stays closed.
use super::*;
use super::{
    material_carrier::{
        self, CarrierReceipt, CarrierRequest, CarrierRetirement, FragmentConsumer, FragmentSource,
    },
    material_restore::{self, Namespace},
};
use crate::file_access::{
    ea_records::WorkBudget,
    material_carrier_fragment::{self as fragment, Metadata, NativeExtent},
    material_carrier_records::{Error, Resident, Result},
};
use std::{
    io::{Seek, SeekFrom},
    panic::AssertUnwindSafe,
    sync::atomic::AtomicBool,
};
pub(crate) struct FragmentReceipt {
    pub node: CarrierReceipt,
    pub copied_native_bytes: u64,
    pub stored_bytes: u64,
    pub record_sha256: [u8; 32],
}
pub(crate) struct FragmentRetirement {
    _node: Option<CarrierRetirement>,
    _namespace: Option<Namespace>,
    _operation_error: Option<Error>,
    _cleanup_error: Error,
}
struct Stored {
    copied_native_bytes: u64,
    stored_bytes: u64,
    record_sha256: [u8; 32],
}
struct Consumer<'a> {
    output: &'a File,
    stored: Option<Stored>,
}
impl FragmentConsumer for Consumer<'_> {
    fn consume(
        &mut self,
        source: FragmentSource<'_>,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
        resident: &Resident,
    ) -> Result<()> {
        let FragmentSource {
            file,
            leaf,
            facts,
            parsed,
        } = source;
        if self.stored.is_some() {
            return Err(Error::Invalid);
        }
        let _metadata_memory = resident.lease(1024)?;
        let metadata = Metadata {
            raw_leaf: leaf.to_vec(),
            source_volume: facts.stamp.identity.device,
            source_id: facts.stamp.identity.inode,
            created: facts.basic.created,
            accessed: facts.basic.accessed,
            modified: facts.basic.modified,
            attributes: facts.basic.attributes,
        };
        let extent = NativeExtent {
            bytes: parsed.bytes,
            sha256: parsed.sha256,
        };
        let mut input = file;
        input.seek(SeekFrom::Start(0)).map_err(|e| {
            crate::file_access::material_carrier_records::io_error("fragmentSourceSeek", e)
        })?;
        let mut output = self.output;
        let stored_bytes = fragment::append(
            &mut input,
            &mut output,
            &metadata,
            &extent,
            work,
            cancel,
            resident,
        )?;
        material_restore::flushed(output)?;
        output.seek(SeekFrom::Start(0)).map_err(|e| {
            crate::file_access::material_carrier_records::io_error("fragmentOutputSeek", e)
        })?;
        let actual = fragment::verify_exact(&mut output, work, cancel, resident)?;
        if actual.metadata != metadata
            || actual.native.bytes != extent.bytes
            || actual.native.sha256 != extent.sha256
            || actual.stored_bytes != stored_bytes
        {
            return Err(Error::Changed);
        }
        self.stored = Some(Stored {
            copied_native_bytes: actual.native.bytes,
            stored_bytes,
            record_sha256: actual.record_sha256,
        });
        Ok(())
    }
}
pub(crate) fn carrier_fragment_roundtrip(
    request: CarrierRequest,
    cancel: &AtomicBool,
    retirement: &mut Option<FragmentRetirement>,
) -> Result<FragmentReceipt> {
    if retirement.is_some() {
        return Err(Error::CleanupUnknown);
    }
    // The caller uses the SAME existing Slot before this first native open.
    // No global slot/worker or arbitrary destination path is introduced.
    let mut namespace = None;
    let mut node_retirement = None;
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        namespace = Some(Namespace::reserve()?);
        let owned = namespace.as_mut().ok_or(Error::Invalid)?;
        owned.open()?;
        let mut consumer = Consumer {
            output: owned.source_carrier.as_ref().ok_or(Error::Invalid)?,
            stored: None,
        };
        let node = material_carrier::roundtrip_with_consumer(
            request,
            cancel,
            &mut node_retirement,
            Some(&mut consumer),
        )?;
        let stored = consumer.stored.take().ok_or(Error::Invalid)?;
        Ok(FragmentReceipt {
            node,
            copied_native_bytes: stored.copied_native_bytes,
            stored_bytes: stored.stored_bytes,
            record_sha256: stored.record_sha256,
        })
    }))
    .unwrap_or(Err(Error::Unsupported));
    // Unknown node abort/cleanup retains both actual owners in the caller's
    // one slot. Do not call any namespace API again in that branch.
    let cleanup = if node_retirement.is_some() {
        Err(Error::CleanupUnknown)
    } else {
        namespace.as_mut().map_or(Ok(()), Namespace::cleanup)
    };
    if let Err(cleanup_error) = cleanup {
        *retirement = Some(FragmentRetirement {
            _node: node_retirement,
            _namespace: namespace,
            _operation_error: result.err(),
            _cleanup_error: cleanup_error,
        });
        return Err(Error::CleanupUnknown);
    }
    result
}
