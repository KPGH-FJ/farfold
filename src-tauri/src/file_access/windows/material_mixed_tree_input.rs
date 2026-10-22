//! One operation-scoped immutable mixed carrier, consumed inside the original Slot.
//! The outer complete-tree and Manifest owners decide publication and target admission.
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
#[path = "material_mixed_native_proof.rs"]
mod native_proof;
pub(super) use native_proof::NativeProof;

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
    retain_native: bool,
    root: MaterialPin,
    managed_root_git: Option<crate::worktrees::ManagedRootGitEdge>,
    recovery_git: Option<crate::worktrees::PreparedRecoveryGit>,
    leaf: Vec<u16>,
    resident: Resident,
    _memory: ResidentLease,
}
impl MixedRequest {
    pub(crate) fn deleting(
        pin: &super::WorktreeDeleteNode,
        leaf: Vec<u16>,
        memory: &MixedMemory,
        cancel: &AtomicBool,
        proof: crate::worktrees::ManagedRootGitEdge,
    ) -> Result<Self> {
        check(cancel)?;
        if !proof.deletion_purpose() {
            return Err(Error::Unsupported);
        }
        let reserved = memory.0.lease(2048)?;
        let root = pin.material();
        if !root.deletion_purpose() {
            return Err(Error::Unsupported);
        }
        root.directory_carrier_leaf(&leaf).map_err(pin_error)?;
        Ok(Self {
            root_policy: RootPolicy::OwnedTree,
            retain_native: true,
            root,
            managed_root_git: Some(proof),
            recovery_git: None,
            leaf,
            resident: memory.0.clone(),
            _memory: reserved,
        })
    }
    pub(crate) fn with_recovery_git(
        mut self,
        proof: crate::worktrees::PreparedRecoveryGit,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        if self.managed_root_git.is_none() || self.recovery_git.is_some() {
            return Err(Error::Unsupported);
        }
        proof.verify(cancel).map_err(|_| Error::Changed)?;
        self.recovery_git = Some(proof);
        Ok(self)
    }
    pub(super) fn require_pool(&self, lease: &mut ResidentLease) -> Result<()> {
        self.resident.grow(lease, 0)
    }
    pub(super) fn for_material_store(mut self) -> Self {
        if self.managed_root_git.is_none() {
            self.root_policy = RootPolicy::NoRootGit;
        }
        self.retain_native = true;
        self
    }
    pub(crate) fn worktree(
        pin: PinnedPath,
        leaf: Vec<u16>,
        memory: &MixedMemory,
        cancel: &AtomicBool,
        proof: crate::worktrees::ManagedRootGitEdge,
    ) -> Result<Self> {
        let mut request = Self::held(pin, leaf, memory, cancel)?;
        request.managed_root_git = Some(proof);
        request.retain_native = true;
        Ok(request)
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
            retain_native: false,
            root,
            managed_root_git: None,
            recovery_git: None,
            leaf,
            resident: memory.0.clone(),
            _memory: reserved,
        })
    }
}
struct Resources {
    delete_stopped: Vec<super::worktree_delete_file::DeleteStoppedHandle>,
    sources: Option<Sources>,
    retain_native: bool,
    namespace: Option<Namespace>,
    context: Option<RetiredContext>,
    resident: Resident,
    _memory: ResidentLease,
    _namespace_memory: Option<ResidentLease>,
}
pub(crate) struct MixedRetirement {
    _resources: Box<Resources>,
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
    pub(super) user_nodes: usize,
    pub(super) native_catalog: &'c mut Option<Vec<NativeProof>>,
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
#[cfg(test)]
pub(crate) struct MixedOutputLease {
    _memory: ResidentLease,
}
#[cfg(test)]
impl MixedOutputLease {
    pub(super) fn reserve(resident: &Resident, bytes: usize) -> Result<Self> {
        Ok(Self {
            _memory: resident.lease(bytes)?,
        })
    }
}
pub(super) struct MixedBytes {
    pub content: crate::worktrees::MaterialContent,
    pub summary: MixedSummary,
    pub whole_sha256: [u8; 32],
    pub native_catalog: Option<Vec<NativeProof>>,
}
impl MixedInput<'_> {
    pub(crate) fn complete_digest(&mut self) -> Result<crate::worktrees::MaterialContent> {
        self.verify()?;
        crate::file_access::material_mixed_semantic::summarize(
            &self.verified.nodes,
            self.user_nodes,
            |index| {
                self.native_catalog
                    .as_ref()
                    .map_or(self.verified.nodes[index].native_sha256, |catalog| {
                        catalog[index].semantic_sha256
                    })
            },
            self.work,
            self.cancel,
        )
    }
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
            content: crate::file_access::material_mixed_semantic::summarize(
                &self.verified.nodes,
                self.user_nodes,
                |index| {
                    self.native_catalog
                        .as_ref()
                        .map_or(self.verified.nodes[index].native_sha256, |catalog| {
                            catalog[index].semantic_sha256
                        })
                },
                self.work,
                self.cancel,
            )?,
            summary,
            whole_sha256: hash.finalize().into(),
            native_catalog: self.native_catalog.take(),
        })
    }

    // Caller-owned buffering must reserve the SAME pool before allocating. Streams
    // to another bounded owned file do not need an entire payload Vec reservation.
    #[cfg(test)]
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
    #[cfg(test)]
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
    let count = sources.nodes.len();
    let _witness_memory = resident.lease(count.checked_mul(8192).ok_or(Error::Limit)?)?;
    let mut directories: Vec<(usize, dirs::Node)> = Vec::with_capacity(count);
    let mut witnesses = Vec::with_capacity(count);
    let mut expected: Vec<Expected> = Vec::with_capacity(count);
    let mut native_catalog = resources.retain_native.then(|| Vec::with_capacity(count));
    let mut output = ns.tree_carrier.as_ref().ok_or(Error::Invalid)?;
    let mut writer = tree::Writer::begin(&mut output, sources.nodes.len(), work, cancel, resident)?;
    for (index, node) in sources.nodes.iter().enumerate() {
        check(cancel)?;
        let (stored, record) = match node.kind {
            Kind::Directory => {
                let mut directory = dirs::Node {
                    #[cfg(test)]
                    parent: node.parent,
                    leaf: node.leaf.clone(),
                    pin: node.pin.clone(),
                    facts: None,
                    bytes: 0,
                    sha256: [0; 32],
                    semantic_sha256: [0; 32],
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
                if let Some(catalog) = native_catalog.as_mut() {
                    catalog.push(NativeProof::from_facts(
                        &f.stamp.identity,
                        Kind::Directory,
                        directory.semantic_sha256,
                        &f.expected,
                        &f.ea,
                        f.security.as_ref().ok_or(Error::Unsupported)?,
                        resident,
                    )?);
                }
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
                if let Some(catalog) = native_catalog.as_mut() {
                    let f = &capture.facts;
                    catalog.push(NativeProof::from_facts(
                        &f.stamp.identity,
                        Kind::Regular,
                        capture.parsed.semantic_sha256(),
                        &f.expected,
                        &f.ea,
                        &f.security,
                        resident,
                    )?);
                }
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
        user_nodes: sources.user_nodes,
        native_catalog: &mut native_catalog,
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
        user_nodes: sources.user_nodes,
        native_catalog: &mut native_catalog,
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
pub(crate) struct VerifiedRemoval<'a> {
    sources: &'a mut Sources,
    work: &'a mut WorkBudget,
    cancel: &'a AtomicBool,
    stopped: &'a mut Vec<super::worktree_delete_file::DeleteStoppedHandle>,
    dispatched: &'a mut bool,
    context: &'a mut Option<RetiredContext>,
}
impl VerifiedRemoval<'_> {
    pub(crate) fn remove(
        self,
        material: &super::material_mixed_tree_source::RemovalMaterial,
        before: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        self.sources.remove_owned(
            material,
            self.work,
            self.cancel,
            super::material_mixed_tree_source::RemovalProgress {
                stopped: self.stopped,
                dispatched: self.dispatched,
                context: self.context,
            },
            before,
        )
    }
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
    with_mixed_tree_input_then(request, work, cancel, retirement, consume, |_, _| Ok(()))
}
pub(crate) fn with_mixed_tree_input_then<T, F, G>(
    request: MixedRequest,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    retirement: &mut Option<MixedRetirement>,
    consume: F,
    finish: G,
) -> Result<T>
where
    F: for<'c> FnOnce(MixedInput<'c>) -> Result<T>,
    G: for<'a> FnOnce(VerifiedRemoval<'a>, &T) -> Result<()>,
{
    if retirement.is_some() {
        return Err(Error::CleanupUnknown);
    }
    if work.remaining() > records::WORK_LIMIT {
        return Err(Error::Limit);
    }
    let MixedRequest {
        root_policy,
        retain_native,
        root,
        managed_root_git,
        recovery_git,
        leaf,
        resident,
        _memory,
    } = request;
    // No native context exists before Sources is installed in this outside owner.
    let sources = Sources::collect(
        root,
        leaf,
        managed_root_git,
        recovery_git,
        work,
        cancel,
        &resident,
    )?;
    // A material request WITHOUT the typed same-SourceOwner capability refuses
    // before build/BackupRead/spools, never after copying .git into a carrier.
    if matches!(root_policy, RootPolicy::NoRootGit) {
        for node in &sources.nodes {
            if node.parent == 0 && equal(&node.leaf, &[46, 103, 105, 116])? {
                return Err(Error::Unsupported);
            }
        }
    }
    let mut resources = Box::new(Resources {
        delete_stopped: Vec::with_capacity(1),
        sources: Some(sources),
        retain_native,
        namespace: None,
        context: None,
        resident,
        _memory,
        _namespace_memory: None,
    });
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
    // build returned only after its complete final Native/source fence. Its
    // witnesses/catalog borrows have dropped; every real context is retired,
    // and the private namespace has been successfully cleaned before mutation.
    let result = match result {
        Ok(value) => {
            let mut dispatched = false;
            let finished = std::panic::catch_unwind(AssertUnwindSafe(|| {
                let resources = resources.as_mut();
                let removal = VerifiedRemoval {
                    sources: resources.sources.as_mut().ok_or(Error::Invalid)?,
                    work,
                    cancel,
                    stopped: &mut resources.delete_stopped,
                    dispatched: &mut dispatched,
                    context: &mut resources.context,
                };
                finish(removal, &value)
            }))
            .unwrap_or(Err(Error::Unsupported));
            if let Err(e) = finished {
                if dispatched || !resources.delete_stopped.is_empty() || resources.context.is_some()
                {
                    *retirement = Some(MixedRetirement {
                        _resources: resources,
                        _operation_error: Some(e),
                        _cleanup_error: Error::CleanupUnknown,
                    });
                    return Err(Error::CleanupUnknown);
                }
                Err(e)
            } else {
                Ok(value)
            }
        }
        Err(e) => Err(e),
    };
    drop(resources);
    result
}
