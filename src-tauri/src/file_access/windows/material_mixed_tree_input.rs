//! One operation-scoped immutable mixed carrier, consumed inside the original Slot.
//! No target tree/alias/Manifest2 or public restore is claimed by these bytes.
use super::*;
use super::{
    directory::Owner,
    material_carrier::{FragmentConsumer, FragmentSource},
    material_carrier_native::Basic,
    material_directory_carrier::pin_error,
    material_directory_facts as facts, material_directory_tree_source as dirs,
    material_mixed_tree_source::Sources,
    material_pin::MaterialPin,
    material_regular_shared::{self as regular, Held, Io},
    material_restore::{self, Namespace},
};
use crate::file_access::{
    ea_records::WorkBudget,
    material_backup_io::RetiredContext,
    material_carrier_fragment as fragment,
    material_carrier_records::{
        self as records, Error, Resident, ResidentLease, Result, charge, check, io_error,
    },
    material_mixed_tree_records::{self as tree, Kind},
};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Seek, SeekFrom, Write},
    panic::AssertUnwindSafe,
    sync::atomic::AtomicBool,
};
pub(crate) struct MixedMemory(Resident);
impl MixedMemory {
    pub(super) fn shared(&self) -> Resident {
        self.0.clone()
    }
}
impl Default for MixedMemory {
    fn default() -> Self {
        Self(Resident::new(records::RESIDENT_LIMIT))
    }
}
enum RootPolicy {
    OwnedTree,
    NoRootGit,
}
pub(crate) struct MixedRequest {
    root_policy: RootPolicy,
    root: MaterialPin,
    leaf: Vec<u16>,
    resident: Resident,
    _memory: ResidentLease,
}
impl MixedRequest {
    pub(super) fn require_pool(&self, lease: &mut ResidentLease) -> Result<()> {
        self.resident.grow(lease, 0)
    }
    pub(super) fn for_material_store(mut self) -> Self {
        self.root_policy = RootPolicy::NoRootGit;
        self
    }
    pub(crate) fn held(
        pin: PinnedPath,
        leaf: Vec<u16>,
        memory: &MixedMemory,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        if !pin.full_security_purpose() {
            return Err(Error::Unsupported);
        }
        let reserved = memory.0.lease(2048)?;
        let root = MaterialPin::root(pin, &memory.0, cancel).map_err(pin_error)?;
        root.directory_carrier_leaf(&leaf).map_err(pin_error)?;
        Ok(Self {
            root_policy: RootPolicy::OwnedTree,
            root,
            leaf,
            resident: memory.0.clone(),
            _memory: reserved,
        })
    }
}
struct Resources {
    sources: Option<Sources>,
    namespace: Option<Namespace>,
    context: Option<RetiredContext>,
    resident: Resident,
    _memory: ResidentLease,
    _namespace_memory: Option<ResidentLease>,
}
pub(crate) struct MixedRetirement {
    _resources: Resources,
    _operation_error: Option<Error>,
    _cleanup_error: Error,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MixedSummary {
    pub nodes: usize,
    pub directories: usize,
    pub regulars: usize,
    pub carrier_bytes: u64,
    pub carrier_sha256: [u8; 32],
    pub carrier_identity: Identity,
}
// Borrowed disjoint fields only, never an owned resource or self-reference.
// T in with_mixed_tree_input is outside c: references cannot escape the callback.
pub(crate) struct MixedInput<'c> {
    pub(super) namespace: &'c mut Namespace,
    pub(super) verified: &'c tree::Verified,
    pub(super) context: &'c mut Option<RetiredContext>,
    pub(super) work: &'c mut WorkBudget,
    pub(super) cancel: &'c AtomicBool,
    pub(super) resident: &'c Resident,
}
fn equal(a: &[u16], b: &[u16]) -> Result<bool> {
    let n =
        unsafe { CompareStringOrdinal(a.as_ptr(), a.len() as i32, b.as_ptr(), b.len() as i32, 1) };
    if n == 0 {
        Err(io_error("mixedNameCompare", io::Error::last_os_error()))
    } else {
        Ok(n == CSTR_EQUAL)
    }
}
pub(crate) struct MixedOutputLease {
    _memory: ResidentLease,
}
impl MixedOutputLease {
    pub(super) fn reserve(resident: &Resident, bytes: usize) -> Result<Self> {
        Ok(Self {
            _memory: resident.lease(bytes)?,
        })
    }
}
pub(super) struct MixedBytes {
    pub summary: MixedSummary,
    pub whole_sha256: [u8; 32],
}
impl MixedInput<'_> {
    // Complete actual carrier, including typed index/header/trailer, not just
    // selected node hashes. Output remains under the caller's original Slot.
    pub(super) fn copy_tree<W: Write>(&mut self, out: &mut W) -> Result<MixedBytes> {
        let summary = self.verify()?;
        let _memory = self.resident.lease(2 * records::BLOCK)?;
        let mut buffer = vec![0u8; records::BLOCK];
        let mut file = self.namespace.tree_carrier.as_ref().ok_or(Error::Invalid)?;
        let before = stamp(file).map_err(|e| io_error("mixedSealBefore", e))?;
        if before.size != summary.carrier_bytes {
            return Err(Error::Changed);
        }
        file.rewind().map_err(|e| io_error("mixedSealSeek", e))?;
        let mut hash = Sha256::new();
        let mut left = summary.carrier_bytes;
        while left != 0 {
            check(self.cancel)?;
            let offer = left
                .min(records::BLOCK as u64)
                .min(self.work.remaining() / 2) as usize;
            if offer == 0 {
                return Err(Error::Limit);
            }
            charge(self.work, offer * 2)?;
            file.read_exact(&mut buffer[..offer])
                .map_err(|e| io_error("mixedSealRead", e))?;
            out.write_all(&buffer[..offer])
                .map_err(|e| io_error("mixedSealWrite", e))?;
            hash.update(&buffer[..offer]);
            left -= offer as u64;
        }
        let mut extra = [0u8; 1];
        check(self.cancel)?;
        charge(self.work, 1)?;
        if file
            .read(&mut extra)
            .map_err(|e| io_error("mixedSealEof", e))?
            != 0
            || stamp(file).map_err(|e| io_error("mixedSealAfter", e))? != before
        {
            return Err(Error::Changed);
        }
        self.namespace.verify()?;
        Ok(MixedBytes {
            summary,
            whole_sha256: hash.finalize().into(),
        })
    }

    // Caller-owned buffering must reserve the SAME pool before allocating. Streams
    // to another bounded owned file do not need an entire payload Vec reservation.
    pub(crate) fn reserve_output(&self, bytes: usize) -> Result<MixedOutputLease> {
        Ok(MixedOutputLease {
            _memory: self.resident.lease(bytes)?,
        })
    }
    pub(crate) fn verify(&mut self) -> Result<MixedSummary> {
        let work = &mut *self.work;
        let cancel = self.cancel;
        let resident = self.resident;
        check(cancel)?;
        if self.context.is_some() {
            return Err(Error::CleanupUnknown);
        }
        self.namespace.verify()?;
        let mut file = self.namespace.tree_carrier.as_ref().ok_or(Error::Invalid)?;
        let before = stamp(file).map_err(|e| io_error("mixedInputStamp", e))?;
        file.seek(SeekFrom::Start(0))
            .map_err(|e| io_error("mixedInputSeek", e))?;
        let actual = tree::verify_exact(&mut file, work, cancel, resident, equal)?;
        if actual.nodes != self.verified.nodes
            || actual.bytes != self.verified.bytes
            || actual.sha256 != self.verified.sha256
            || stamp(file).map_err(|e| io_error("mixedInputAfter", e))? != before
        {
            return Err(Error::Changed);
        }
        self.namespace.verify()?;
        Ok(MixedSummary {
            nodes: actual.nodes.len(),
            directories: actual
                .nodes
                .iter()
                .filter(|n| n.kind == Kind::Directory)
                .count(),
            regulars: actual
                .nodes
                .iter()
                .filter(|n| n.kind == Kind::Regular)
                .count(),
            carrier_bytes: actual.bytes,
            carrier_sha256: actual.sha256,
            carrier_identity: before.identity,
        })
    }
    // An actual typed-record byte consumer. No arbitrary path/File/target capability.
    pub(crate) fn copy_node<W: Write>(&mut self, index: usize, out: &mut W) -> Result<[u8; 32]> {
        let work = &mut *self.work;
        let cancel = self.cancel;
        let resident = self.resident;
        check(cancel)?;
        if self.context.is_some() {
            return Err(Error::CleanupUnknown);
        }
        let node = self.verified.nodes.get(index).ok_or(Error::Invalid)?;
        let _memory = resident.lease(2 * records::BLOCK)?;
        let mut scratch = vec![0u8; records::BLOCK];
        self.namespace.verify()?;
        let mut file = self.namespace.tree_carrier.as_ref().ok_or(Error::Invalid)?;
        let before = stamp(file).map_err(|e| io_error("mixedCopyStamp", e))?;
        if node
            .typed_start
            .checked_add(node.typed_bytes)
            .ok_or(Error::Limit)?
            > before.size
        {
            return Err(Error::Changed);
        }
        file.seek(SeekFrom::Start(node.typed_start))
            .map_err(|e| io_error("mixedCopySeek", e))?;
        let mut left = node.typed_bytes;
        let mut hash = Sha256::new();
        while left != 0 {
            check(cancel)?;
            let offer = left.min(records::BLOCK as u64).min(work.remaining() / 2) as usize;
            if offer == 0 {
                return Err(Error::Limit);
            }
            charge(work, offer * 2)?;
            file.read_exact(&mut scratch[..offer])
                .map_err(|e| io_error("mixedCopyRead", e))?;
            out.write_all(&scratch[..offer])
                .map_err(|e| io_error("mixedCopyWrite", e))?;
            hash.update(&scratch[..offer]);
            left -= offer as u64;
        }
        if stamp(file).map_err(|e| io_error("mixedCopyAfter", e))? != before {
            return Err(Error::Changed);
        }
        self.namespace.verify()?;
        Ok(hash.finalize().into())
    }
}
struct Expected {
    bytes: u64,
    sha256: [u8; 32],
    basic: Basic,
}
struct RegularSink<'a> {
    file: &'a File,
    result: Option<(u64, [u8; 32])>,
}
impl FragmentConsumer for RegularSink<'_> {
    fn consume(
        &mut self,
        source: FragmentSource<'_>,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
        resident: &Resident,
    ) -> Result<()> {
        if self.result.is_some() {
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
            .map_err(|e| io_error("mixedRegularSource", e))?;
        let mut output = self.file;
        output
            .set_len(0)
            .map_err(|e| io_error("mixedRegularReset", e))?;
        output
            .seek(SeekFrom::Start(0))
            .map_err(|e| io_error("mixedRegularSeek", e))?;
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
            .map_err(|e| io_error("mixedRegularVerify", e))?;
        let actual = fragment::verify_exact(&mut output, work, cancel, resident)?;
        if actual.metadata != meta
            || actual.native.bytes != extent.bytes
            || actual.native.sha256 != extent.sha256
            || actual.stored_bytes != stored
        {
            return Err(Error::Changed);
        }
        self.result = Some((stored, actual.record_sha256));
        Ok(())
    }
}
fn reset_raw(ns: &Namespace, expected: &Identity, context: &Option<RetiredContext>) -> Result<()> {
    if context.is_some() {
        return Err(Error::CleanupUnknown);
    }
    ns.verify()?;
    let mut f = ns.source_carrier.as_ref().ok_or(Error::Invalid)?;
    if &stamp(f)
        .map_err(|e| io_error("mixedRawIdentity", e))?
        .identity
        != expected
    {
        return Err(Error::Changed);
    }
    f.set_len(0).map_err(|e| io_error("mixedRawReset", e))?;
    f.seek(SeekFrom::Start(0))
        .map_err(|e| io_error("mixedRawSeek", e))?;
    Ok(())
}
fn build<T, F>(
    resources: &mut Resources,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    consume: F,
) -> Result<T>
where
    F: for<'c> FnOnce(MixedInput<'c>) -> Result<T>,
{
    let sources = resources.sources.as_ref().ok_or(Error::Invalid)?;
    let resident = &resources.resident;
    resources._namespace_memory = Some(resident.lease(4 * records::BLOCK)?);
    resources.namespace = Some(Namespace::reserve()?);
    let ns = resources.namespace.as_mut().ok_or(Error::Invalid)?;
    ns.open_directory_namespace()?;
    ns.prepare_mixed_input()?;
    let carrier_id = stamp(ns.source_carrier.as_ref().ok_or(Error::Invalid)?)
        .map_err(|e| io_error("mixedRawInitial", e))?
        .identity;
    // Declared BEFORE all dependent vectors: their borrowed pins/metadata drop first.
    let _witness_memory = resident.lease(tree::MAX_NODES * 8192)?;
    let mut directories: Vec<(usize, dirs::Node)> = Vec::with_capacity(tree::MAX_NODES);
    let mut witnesses = Vec::with_capacity(tree::MAX_NODES);
    let mut expected: Vec<Expected> = Vec::with_capacity(tree::MAX_NODES);
    let mut output = ns.tree_carrier.as_ref().ok_or(Error::Invalid)?;
    let mut writer = tree::Writer::begin(&mut output, sources.nodes.len(), work, cancel, resident)?;
    for (index, node) in sources.nodes.iter().enumerate() {
        check(cancel)?;
        let (stored, record) = match node.kind {
            Kind::Directory => {
                let mut directory = dirs::Node {
                    parent: node.parent,
                    leaf: node.leaf.clone(),
                    pin: node.pin.clone(),
                    facts: None,
                    bytes: 0,
                    sha256: [0; 32],
                };
                let (record, stored) = dirs::capture_node(
                    &mut directory,
                    ns,
                    work,
                    cancel,
                    resident,
                    &mut resources.context,
                )?;
                let f = directory.facts.as_ref().ok_or(Error::Invalid)?;
                expected.push(Expected {
                    bytes: directory.bytes,
                    sha256: directory.sha256,
                    basic: f.basic.clone(),
                });
                directories.push((index, directory));
                (stored, record)
            }
            Kind::Regular => {
                let mut capture = regular::prepare(
                    Held::material(&node.pin)?,
                    &mut Io {
                        work,
                        cancel,
                        resident,
                        context: &mut resources.context,
                    },
                )?
                .capture(
                    ns,
                    &mut Io {
                        work,
                        cancel,
                        resident,
                        context: &mut resources.context,
                    },
                )?;
                expected.push(Expected {
                    bytes: capture.parsed.bytes,
                    sha256: capture.parsed.sha256,
                    basic: capture.facts.basic.clone(),
                });
                let result = {
                    let mut sink = RegularSink {
                        file: ns.target_carrier.as_ref().ok_or(Error::Invalid)?,
                        result: None,
                    };
                    capture.consume_bytes(
                        ns,
                        &node.leaf,
                        &mut Io {
                            work,
                            cancel,
                            resident,
                            context: &mut resources.context,
                        },
                        &mut sink,
                    )?;
                    sink.result.take().ok_or(Error::Invalid)?
                };
                witnesses.push(capture.recycle(
                    ns,
                    &mut Io {
                        work,
                        cancel,
                        resident,
                        context: &mut resources.context,
                    },
                )?);
                result
            }
        };
        let mut typed = ns.target_carrier.as_ref().ok_or(Error::Invalid)?;
        typed
            .seek(SeekFrom::Start(0))
            .map_err(|e| io_error("mixedAppendSeek", e))?;
        writer.append(
            tree::Entry {
                kind: node.kind,
                parent: node.parent,
            },
            &mut typed,
            stored,
            record,
            work,
            cancel,
        )?;
        // Only scratch spools recycle. Unified carrier is append-only, NEVER reset.
        reset_raw(ns, &carrier_id, &resources.context)?;
    }
    let digest = writer.finish(work, cancel)?;
    material_restore::flushed(output)?;
    output
        .seek(SeekFrom::Start(0))
        .map_err(|e| io_error("mixedTreeVerify", e))?;
    let verified = tree::verify_exact(&mut output, work, cancel, resident, equal)?;
    if verified.sha256 != digest || verified.nodes.len() != sources.nodes.len() {
        return Err(Error::Changed);
    }
    for (index, record) in verified.nodes.iter().enumerate() {
        let source = &sources.nodes[index];
        let e = &expected[index];
        if record.kind != source.kind
            || record.parent != source.parent
            || record.metadata.raw_leaf != source.leaf
            || record.metadata.source_volume != source.pin.identity().device
            || record.metadata.source_id != source.pin.identity().inode
            || record.native_bytes != e.bytes
            || record.native_sha256 != e.sha256
            || record.metadata.created != e.basic.created
            || record.metadata.accessed != e.basic.accessed
            || record.metadata.modified != e.basic.modified
            || record.metadata.attributes != e.basic.attributes
        {
            return Err(Error::Changed);
        }
    }
    // Guards/actual Facts are still live here, and never stored with backreferences.
    for witness in &witnesses {
        witness.verify_unchanged(
            &mut Io {
                work,
                cancel,
                resident,
                context: &mut resources.context,
            },
            "mixedRegularFinal",
        )?;
    }
    for (_, node) in &directories {
        let f = node.facts.as_ref().ok_or(Error::Invalid)?;
        let _query = node
            .pin
            .try_observation_owner()
            .map_err(|_| Error::Unsupported)?;
        if !f.unchanged(&facts::take(
            Owner::file(&node.pin),
            true,
            work,
            cancel,
            resident,
        )?) {
            return Err(Error::Changed);
        }
    }
    sources.verify(work, cancel)?;
    ns.verify()?;
    check(cancel)?;
    // Keep ALL source witnesses live THROUGH the whole bounded transaction.
    // This capability contains disjoint borrowed fields, not ownership/backrefs.
    let input_identity = stamp(ns.tree_carrier.as_ref().ok_or(Error::Invalid)?)
        .map_err(|e| io_error("mixedCarrierBeforeConsumer", e))?
        .identity;
    let value = consume(MixedInput {
        namespace: &mut *ns,
        verified: &verified,
        context: &mut resources.context,
        work,
        cancel,
        resident,
    })?;
    if stamp(ns.tree_carrier.as_ref().ok_or(Error::Invalid)?)
        .map_err(|e| io_error("mixedCarrierAfterConsumer", e))?
        .identity
        != input_identity
    {
        return Err(Error::Changed);
    }
    // Whole input remains the same bytes even after a future same-namespace step.
    MixedInput {
        namespace: &mut *ns,
        verified: &verified,
        context: &mut resources.context,
        work,
        cancel,
        resident,
    }
    .verify()?;
    // A successful consumer is not successful input completion until original
    // Facts/query witnesses and complete namespace/topology pass AFTER consumption.
    for witness in &witnesses {
        witness.verify_unchanged(
            &mut Io {
                work,
                cancel,
                resident,
                context: &mut resources.context,
            },
            "mixedRegularAfterConsumer",
        )?;
    }
    for (_, node) in &directories {
        let f = node.facts.as_ref().ok_or(Error::Invalid)?;
        let _query = node
            .pin
            .try_observation_owner()
            .map_err(|_| Error::Unsupported)?;
        if !f.unchanged(&facts::take(
            Owner::file(&node.pin),
            true,
            work,
            cancel,
            resident,
        )?) {
            return Err(Error::Changed);
        }
    }
    sources.verify(work, cancel)?;
    ns.verify()?;
    check(cancel)?;
    Ok(value)
    // Witnesses and directory Facts drop ONLY AFTER final consumer fence. No
    // self-borrow survives returning/moving outside Resources into retirement.
}
pub(crate) fn with_mixed_tree_input<T, F>(
    request: MixedRequest,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    retirement: &mut Option<MixedRetirement>,
    consume: F,
) -> Result<T>
where
    F: for<'c> FnOnce(MixedInput<'c>) -> Result<T>,
{
    if retirement.is_some() {
        return Err(Error::CleanupUnknown);
    }
    if work.remaining() > records::WORK_LIMIT {
        return Err(Error::Limit);
    }
    let MixedRequest {
        root_policy,
        root,
        leaf,
        resident,
        _memory,
    } = request;
    // No native context exists before Sources is installed in this outside owner.
    let sources = Sources::collect(root, leaf, work, cancel, &resident)?;
    // Material persistence has no managed admin-edge authority yet. Refuse
    // before build/BackupRead/spools, not after copying .git into a carrier.
    if matches!(root_policy, RootPolicy::NoRootGit) {
        for node in &sources.nodes {
            if node.parent == 0 && equal(&node.leaf, &[46, 103, 105, 116])? {
                return Err(Error::Unsupported);
            }
        }
    }
    let mut resources = Resources {
        sources: Some(sources),
        namespace: None,
        context: None,
        resident,
        _memory,
        _namespace_memory: None,
    };
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        build(&mut resources, work, cancel, consume)
    }))
    .unwrap_or(Err(Error::Unsupported));
    let cleanup = if resources.context.is_none() {
        resources
            .namespace
            .as_mut()
            .map_or(Ok(()), Namespace::cleanup)
    } else {
        Err(Error::CleanupUnknown)
    };
    if let Err(cleanup_error) = cleanup {
        let operation_error = resources
            .context
            .as_ref()
            .and_then(RetiredContext::operation_error)
            .cloned()
            .or_else(|| result.err());
        *retirement = Some(MixedRetirement {
            _resources: resources,
            _operation_error: operation_error,
            _cleanup_error: cleanup_error,
        });
        return Err(Error::CleanupUnknown);
    }
    drop(resources);
    result
}
