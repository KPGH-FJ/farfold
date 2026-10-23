//! Reacquire DELETE authority only after the original read graph has retired.
use super::*;
use crate::file_access::{
    CarrierFailure as E, DeleteSecurity, DeleteStoppedHandle, EaWorkBudget, MixedMemory,
    MixedRequest, WorktreeDeleteNode, metadata_file,
};
use std::{fs::File, os::windows::ffi::OsStrExt, path::Path};
struct Held {
    baseline: FrozenNode,
    pin: WorktreeDeleteNode,
    security: DeleteSecurity,
}
pub(super) struct DeletionOwner {
    frozen: FrozenSource,
    root: WorktreeDeleteNode,
    pointer: WorktreeDeleteNode,
    pointer_security: DeleteSecurity,
    private: Vec<Held>,
    memory: MixedMemory,
}
fn carrier(value: E) -> super::super::super::types::Failure {
    error(match value {
        E::Cancelled => "cancelled",
        E::Limit => "recoveryLimit",
        E::Changed => "recoveryChanged",
        E::CleanupUnknown => "cleanupUnknown",
        _ => "unsupportedMaterial",
    })
}
fn deletion_failure(value: super::super::super::types::Failure) -> E {
    match value.code {
        "cancelled" => E::Cancelled,
        "recoveryLimit" => E::Limit,
        "cleanupUnknown" => E::CleanupUnknown,
        "unsupportedMaterial" => E::Unsupported,
        _ => E::Changed,
    }
}
fn verify_node(
    pin: &WorktreeDeleteNode,
    baseline: &FrozenNode,
    memory: &MixedMemory,
    work: &mut EaWorkBudget,
    used: &mut u64,
    plain: bool,
    cancel: &AtomicBool,
) -> Result<()> {
    pin.verify().map_err(carrier)?;
    if stamp(pin.file()).map_err(|_| error("recoveryChanged"))? != baseline.before
        || metadata_file(pin.file()).map_err(|_| error("recoveryChanged"))? != baseline.metadata
    {
        return Err(error("recoveryChanged"));
    }
    if let Some(children) = &baseline.children {
        let actual = pin.entries(children.len(), work, cancel).map_err(carrier)?;
        for raw in children.keys() {
            cancelled(cancel)?;
            let compared = raw
                .len()
                .checked_mul(4)
                .and_then(|n| n.checked_add(128))
                .ok_or(error("recoveryLimit"))?;
            work.charge(compared).map_err(|_| error("recoveryLimit"))?;
        }
        if actual.as_entries() != children {
            return Err(error("recoveryChanged"));
        }
    }
    if let Some(expected) = baseline.sha256 {
        work.charge(usize::try_from(baseline.before.size).map_err(|_| error("recoveryLimit"))?)
            .map_err(|_| error("recoveryLimit"))?;
        if super::frozen::hash_file(pin.file(), &baseline.before, used, cancel)? != expected {
            return Err(error("recoveryChanged"));
        }
    }
    if plain {
        pin.require_plain(memory, work, cancel).map_err(carrier)?;
    }
    pin.verify().map_err(carrier)
}
impl FrozenSource {
    pub(in crate::worktrees) fn deletion_request(
        mut self,
        full: bool,
        cancel: &AtomicBool,
    ) -> Result<MixedRequest> {
        let memory = MixedMemory::default();
        let mut work = EaWorkBudget::new(crate::file_access::MATERIAL_WORK_LIMIT);
        let mut used = 0;
        self.common.verify()?;
        let root =
            WorktreeDeleteNode::root_for(Path::new(&self.snapshot.root), &memory, full, cancel)
                .map_err(carrier)?;
        verify_node(
            &root, &self.root, &memory, &mut work, &mut used, false, cancel,
        )?;
        let raw = vec![46u16, 103, 105, 116];
        let listed = self
            .root
            .children
            .as_ref()
            .and_then(|v| v.get(&raw))
            .ok_or(error("recoveryChanged"))?;
        let pointer = root.child(&raw, listed, cancel).map_err(carrier)?;
        verify_node(
            &pointer,
            &self.pointer,
            &memory,
            &mut work,
            &mut used,
            true,
            cancel,
        )?;
        let pointer_security = pointer
            .plain_security(&memory, &mut work, cancel)
            .map_err(carrier)?;
        let private_root =
            WorktreeDeleteNode::root_for(Path::new(&self.snapshot.git_dir), &memory, full, cancel)
                .map_err(carrier)?;
        let mut private: Vec<Held> = Vec::with_capacity(self.private.len());
        let mut baselines = std::mem::take(&mut self.private).into_iter();
        let first = baselines.next().ok_or(error("recoveryChanged"))?;
        if !first.relative.as_os_str().is_empty() {
            return Err(error("recoveryChanged"));
        }
        verify_node(
            &private_root,
            &first,
            &memory,
            &mut work,
            &mut used,
            true,
            cancel,
        )?;
        private.push(Held {
            baseline: first,
            security: private_root
                .plain_security(&memory, &mut work, cancel)
                .map_err(carrier)?,
            pin: private_root,
        });
        for baseline in baselines {
            let relative_parent = baseline.relative.parent().ok_or(error("recoveryChanged"))?;
            let parent = private
                .iter()
                .find(|n| n.baseline.relative == relative_parent)
                .ok_or(error("recoveryChanged"))?;
            let raw: Vec<u16> = baseline
                .relative
                .file_name()
                .ok_or(error("recoveryChanged"))?
                .encode_wide()
                .collect();
            let listed = parent
                .baseline
                .children
                .as_ref()
                .and_then(|v| v.get(&raw))
                .ok_or(error("recoveryChanged"))?;
            let pin = parent.pin.child(&raw, listed, cancel).map_err(carrier)?;
            verify_node(&pin, &baseline, &memory, &mut work, &mut used, true, cancel)?;
            let security = pin
                .plain_security(&memory, &mut work, cancel)
                .map_err(carrier)?;
            private.push(Held {
                baseline,
                pin,
                security,
            });
        }
        let leaf = Path::new(&self.snapshot.root)
            .file_name()
            .ok_or(error("unsafePath"))?
            .encode_wide()
            .collect();
        let owner = Arc::new(DeletionOwner {
            frozen: self,
            root,
            pointer,
            pointer_security,
            private,
            memory,
        });
        owner.recheck(&mut work, cancel)?;
        MixedRequest::deleting(
            &owner.root,
            leaf,
            &owner.memory,
            cancel,
            ManagedRootGitEdge::deletion(Arc::clone(&owner)),
        )
        .map_err(carrier)
    }
}
impl DeletionOwner {
    pub(super) fn common_owner(&self) -> Arc<super::super::super::windows_git::RemovalContext> {
        Arc::clone(&self.frozen.common)
    }
    pub(super) fn recheck(&self, work: &mut EaWorkBudget, cancel: &AtomicBool) -> Result<()> {
        cancelled(cancel)?;
        self.frozen.common.verify()?;
        let mut used = 0;
        verify_node(
            &self.root,
            &self.frozen.root,
            &self.memory,
            work,
            &mut used,
            false,
            cancel,
        )?;
        verify_node(
            &self.pointer,
            &self.frozen.pointer,
            &self.memory,
            work,
            &mut used,
            true,
            cancel,
        )?;
        for node in &self.private {
            verify_node(
                &node.pin,
                &node.baseline,
                &self.memory,
                work,
                &mut used,
                true,
                cancel,
            )?;
        }
        Ok(())
    }
    pub(super) fn matches(
        &self,
        root: &File,
        raw: &[u16],
        listed: &crate::file_access::DirectoryObservation,
    ) -> std::result::Result<(), E> {
        if raw != [46, 103, 105, 116]
            || stamp(root).map_err(|_| E::Changed)?.identity != self.frozen.root.before.identity
            || !self
                .frozen
                .pointer
                .metadata
                .matches_directory_identity(listed)
            || metadata_file(self.pointer.file()).map_err(|_| E::Changed)?
                != self.frozen.pointer.metadata
        {
            return Err(E::Changed);
        }
        self.pointer.verify()
    }
    pub(super) fn remove(
        self: Arc<Self>,
        stopped: &mut Vec<DeleteStoppedHandle>,
        work: &mut EaWorkBudget,
        cancel: &AtomicBool,
    ) -> std::result::Result<(), E> {
        let owner = Arc::try_unwrap(self).map_err(|_| E::Unsupported)?;
        let Self {
            root,
            pointer,
            pointer_security,
            mut private,
            memory,
            frozen,
        } = owner;
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(E::Cancelled);
        }
        frozen.common.verify().map_err(deletion_failure)?;
        let mut used = 0;
        verify_node(
            &pointer,
            &frozen.pointer,
            &memory,
            work,
            &mut used,
            false,
            cancel,
        )
        .map_err(deletion_failure)?;
        pointer.require_same_plain(&pointer_security, &memory, work, cancel)?;
        pointer.remove(&[46, 103, 105, 116], stopped)?;
        drop(root); // Release the administrative owner's root Arc before Sources removes its root.
        while let Some(node) = private.pop() {
            if cancel.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(E::Cancelled);
            }
            frozen.common.verify().map_err(deletion_failure)?;
            if node.baseline.before.regular {
                verify_node(
                    &node.pin,
                    &node.baseline,
                    &memory,
                    work,
                    &mut used,
                    false,
                    cancel,
                )
                .map_err(deletion_failure)?;
            } else {
                node.pin.verify()?;
                work.charge(128).map_err(|_| E::Limit)?;
                let metadata = metadata_file(node.pin.file()).map_err(|_| E::Changed)?;
                let removed_children = node
                    .baseline
                    .children
                    .as_ref()
                    .is_some_and(|children| !children.is_empty());
                if !(if removed_children {
                    metadata.same_directory_after_owned_removals(&node.baseline.metadata)
                } else {
                    metadata == node.baseline.metadata
                }) || !node.pin.entries(0, work, cancel)?.as_entries().is_empty()
                {
                    return Err(E::Changed);
                }
            }
            node.pin
                .require_same_plain(&node.security, &memory, work, cancel)?;
            let raw: Vec<u16> = node
                .baseline
                .relative
                .file_name()
                .map(|v| v.encode_wide().collect())
                .unwrap_or_default();
            node.pin.remove(&raw, stopped)?;
        }
        drop(frozen);
        drop(memory);
        Ok(())
    }
}
