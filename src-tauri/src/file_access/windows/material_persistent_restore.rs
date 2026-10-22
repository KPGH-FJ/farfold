//! Store-owned actual reconstruction. No callback-local owner or second Slot.
use super::super::{material_regular_shared::Io, material_restore::Namespace};
use super::*;
use crate::file_access::material_backup_io::RetiredContext;
#[path = "material_sealed_restore_node.rs"]
mod node;

pub(super) fn validate_native(
    store: &Store,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<()> {
    let proofs = store
        .copied
        .as_ref()
        .and_then(|c| c.native_catalog.as_ref())
        .ok_or(Error::Unsupported)?;
    let nodes = &store.verified.as_ref().ok_or(Error::Invalid)?.nodes;
    if proofs.len() != nodes.len() {
        return Err(Error::Changed);
    }
    let file = store.file.as_ref().ok_or(Error::Invalid)?;
    for (entry, proof) in nodes.iter().zip(proofs) {
        node::validate(file, entry, proof, work, cancel, &store.request.resident)?;
    }
    Ok(())
}

pub(super) struct Restore {
    namespace: Namespace,
    target: Option<MaterialTargetRequest>,
    context: Option<RetiredContext>,
    _memory: ResidentLease,
}
impl Restore {
    pub(super) fn reserve(
        resident: &Resident,
        mut target: Option<MaterialTargetRequest>,
    ) -> Result<Self> {
        if let Some(target) = &mut target {
            target.require_pool(resident)?;
            target.verify()?;
        }
        let memory = resident.lease(4 * records::BLOCK)?;
        Ok(Self {
            namespace: Namespace::reserve()?,
            target,
            context: None,
            _memory: memory,
        })
    }
    pub(super) fn cleanup(&mut self) -> Result<()> {
        if self.context.is_some() {
            return Err(Error::CleanupUnknown);
        }
        self.namespace.cleanup()
    }
}
#[derive(Debug)]
pub(crate) struct MaterialTreeReceipt {
    pub nodes: usize,
    pub directories: usize,
    pub regulars: usize,
    pub write_aborts: u32,
    pub read_aborts: u32,
    pub exact_edges_verified: bool,
    pub all_native_recaptured: bool,
    pub metadata_finalized: bool,
    pub retained: bool,
    // Data only. These IDs grant no constructor/path/reopen authority.
    pub target_ids: Vec<Identity>,
    _memory: ResidentLease,
}
pub(super) fn rebuild(
    store: &mut Store,
    target: Option<MaterialTargetRequest>,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<MaterialTreeReceipt> {
    check(cancel)?;
    if work.remaining() > records::WORK_LIMIT || store.restore.is_some() {
        return Err(Error::Invalid);
    }
    let sealed = store.verify(work, cancel)?;
    let resident = &store.request.resident;
    let copied = store.copied.as_ref().ok_or(Error::Invalid)?;
    let proofs = copied.native_catalog.as_ref().ok_or(Error::Unsupported)?;
    let verified = store.verified.as_ref().ok_or(Error::Invalid)?;
    if proofs.len() != verified.nodes.len()
        || proofs
            .iter()
            .zip(&verified.nodes)
            .any(|(p, n)| !p.matches(n))
    {
        return Err(Error::Changed);
    }
    // Original Box owns this before namespace creation, target creation or
    // BackupWrite can produce a native handle/context. Panic does not detach it.
    store.restore = Some(Restore::reserve(resident, target)?);
    let result_memory = resident.lease(
        verified
            .nodes
            .len()
            .checked_mul(128)
            .and_then(|bytes| bytes.checked_add(4096))
            .ok_or(Error::Limit)?,
    )?;
    let restored = store.restore.as_mut().ok_or(Error::Invalid)?;
    restored.namespace.open_directory_namespace()?;
    restored
        .namespace
        .prepare_sealed_tree(resident, verified.nodes.len())?;
    for source in &verified.nodes {
        if let Some(target) = &restored.target {
            target.verify()?;
            restored
                .namespace
                .sealed_tree
                .as_mut()
                .ok_or(Error::Invalid)?
                .create_at(target.parent(), target.leaf(), source, cancel)?;
        } else {
            restored.namespace.create_sealed_node(source, cancel)?;
        }
    }
    let targets = restored
        .namespace
        .sealed_tree
        .as_ref()
        .ok_or(Error::Invalid)?;
    targets.verify_edges(work, cancel)?;
    let input = store.file.as_ref().ok_or(Error::Invalid)?;
    let spool = restored
        .namespace
        .target_carrier
        .as_ref()
        .ok_or(Error::Invalid)?;
    let before = stamp(input).map_err(|e| io_error("treeRestoreSourceBefore", e))?;
    if before != sealed.stamp {
        return Err(Error::Changed);
    }
    let mut writes = 0u32;
    let mut reads = 0u32;
    // All target FileObjects already hold their full required rights. No create
    // or pathname reopen follows restoration of a source security descriptor.
    for kind in [tree::Kind::Regular, tree::Kind::Directory] {
        for index in (0..verified.nodes.len()).rev() {
            let source = &verified.nodes[index];
            if source.kind != kind {
                continue;
            }
            check(cancel)?;
            store.request.verify()?;
            if let Some(target) = &restored.target {
                target.verify()?;
            }
            if stamp(input).map_err(|e| io_error("treeRestoreSourceFence", e))? != before {
                return Err(Error::Changed);
            }
            let (w, r) = node::restore(
                node::Input {
                    sealed: input,
                    node: source,
                    proof: &proofs[index],
                },
                targets.node(index)?,
                spool,
                &mut Io {
                    work,
                    cancel,
                    resident,
                    context: &mut restored.context,
                },
            )?;
            writes = writes.checked_add(w).ok_or(Error::Limit)?;
            reads = reads.checked_add(r).ok_or(Error::Limit)?;
            if stamp(input).map_err(|e| io_error("treeRestoreSourceAfterNode", e))? != before {
                return Err(Error::Changed);
            }
        }
    }
    // Repeat complete raw parent/name/full128 pairing after all payload+security
    // writes. Unknown entries/failed enumeration cannot be a missing child.
    targets.verify_edges(work, cancel)?;
    restored.namespace.verify()?;
    store.request.verify()?;
    let mut target_ids = Vec::with_capacity(verified.nodes.len());
    // All native recapture/enumeration has ended. Final basic metadata follows
    // reverse topology; afterwards only same-handle metadata queries occur.
    for index in (0..verified.nodes.len()).rev() {
        let held = targets.node(index)?;
        node::finalize(
            held.file,
            &verified.nodes[index],
            &proofs[index],
            work,
            cancel,
            resident,
        )?;
    }
    for (index, source) in verified.nodes.iter().enumerate() {
        let held = targets.node(index)?;
        node::verify_final(held.file, source, &proofs[index], work, cancel, resident)?;
        target_ids.push(held.identity.clone());
    }
    if restored.context.is_some()
        || writes as usize != verified.nodes.len()
        || reads as usize != verified.nodes.len()
        || stamp(input).map_err(|e| io_error("treeRestoreSourceFinal", e))? != before
    {
        return Err(Error::Changed);
    }
    restored.namespace.verify()?;
    store.request.verify()?;
    check(cancel)?;
    let retained = restored.target.is_some();
    if let Some(target) = &restored.target {
        target.verify()?;
        // This is the only publication boundary. All source/target/native
        // checks have completed; the original owner now closes without delete.
        restored
            .namespace
            .sealed_tree
            .as_mut()
            .ok_or(Error::Invalid)?
            .retain()?;
    }
    Ok(MaterialTreeReceipt {
        nodes: verified.nodes.len(),
        directories: sealed.directories,
        regulars: sealed.regulars,
        write_aborts: writes,
        read_aborts: reads,
        exact_edges_verified: true,
        all_native_recaptured: true,
        metadata_finalized: true,
        retained,
        target_ids,
        _memory: result_memory,
    })
}

#[cfg(test)]
#[path = "material_persistent_restore_tests.rs"]
mod tests;
