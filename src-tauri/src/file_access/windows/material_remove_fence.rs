//! Same-owner final material comparison, not an atomic filesystem snapshot.
//! Only the original closed membership may be disposed. Observed changes fail;
//! after dispatch, failure retains the original resources and recovery state.
use super::super::{
    material_carrier_native::{self as native, Basic},
    material_directory_carrier::Native,
    material_directory_facts as directory_facts,
    material_mixed_tree_input::{MixedInput, NativeProof},
};
use super::*;
use crate::file_access::{
    material_backup_io::{self as transfer, Mode, RetiredContext, Session},
    material_carrier_records::{self as records, Resident, ResidentLease},
    material_directory_records::{self as directory_records, Profile},
};

// Disjoint borrows of the original Resources owner, never a cloned resource
// or a second retirement controller.
pub(in super::super) struct RemovalProgress<'a> {
    pub(in super::super) stopped:
        &'a mut Vec<super::super::worktree_delete_file::DeleteStoppedHandle>,
    pub(in super::super) dispatched: &'a mut bool,
    pub(in super::super) context: &'a mut Option<RetiredContext>,
}
pub(crate) struct RemovalMaterial {
    pub(crate) content: crate::worktrees::MaterialContent,
    native: Vec<NativeProof>,
    basic: Vec<(Basic, u64)>,
    resident: Resident,
    _memory: ResidentLease,
}
impl MixedInput<'_> {
    pub(crate) fn complete_removal_digest(&mut self) -> Result<RemovalMaterial> {
        let content = self.complete_digest()?;
        let catalog = self.native_catalog.as_ref().ok_or(Error::Unsupported)?;
        if self.user_nodes != self.verified.nodes.len() || catalog.len() != self.user_nodes {
            return Err(Error::Invalid);
        }
        // Keep the original pool payment after build's borrowed witness vector
        // drops. Individual NativeProofs already own their key/record payments.
        let bytes = catalog
            .capacity()
            .checked_mul(size_of::<NativeProof>())
            .and_then(|n| n.checked_add(self.user_nodes.checked_mul(size_of::<(Basic, u64)>())?))
            .ok_or(Error::Limit)?;
        let memory = self.resident.lease(bytes)?;
        let mut basic = Vec::with_capacity(self.user_nodes);
        for (node, proof) in self.verified.nodes.iter().zip(catalog) {
            check(self.cancel)?;
            charge(self.work, 128)?;
            if !proof.matches(node) {
                return Err(Error::Changed);
            }
            basic.push((
                Basic {
                    created: node.metadata.created,
                    accessed: node.metadata.accessed,
                    modified: node.metadata.modified,
                    attributes: node.metadata.attributes,
                },
                node.native_bytes,
            ));
        }
        Ok(RemovalMaterial {
            content,
            native: self.native_catalog.take().ok_or(Error::Invalid)?,
            basic,
            resident: self.resident.clone(),
            _memory: memory,
        })
    }
}
enum Current {
    Directory(directory_facts::Facts),
    Regular(native::Facts),
}
impl Current {
    fn take(
        node: &Node,
        material: &RemovalMaterial,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        let file = Owner::file(&node.pin);
        match node.kind {
            Kind::Directory => directory_facts::take(file, true, work, cancel, &material.resident)
                .map(Self::Directory),
            Kind::Regular => {
                native::facts(file, work, cancel, &material.resident).map(Self::Regular)
            }
        }
    }
    fn basic(&self) -> &Basic {
        match self {
            Self::Directory(f) => &f.basic,
            Self::Regular(f) => &f.basic,
        }
    }
    fn unchanged(&self, after: &Self) -> bool {
        match (self, after) {
            (Self::Directory(a), Self::Directory(b)) => a.unchanged(b),
            (Self::Regular(a), Self::Regular(b)) => a.unchanged(b),
            _ => false,
        }
    }
    fn matches(&self, expected: &NativeProof, basic: &Basic, after_children: bool) -> bool {
        let native = match self {
            Self::Directory(f) => {
                f.stamp.identity == expected.identity
                    && f.expected == expected.expected
                    && f.ea == expected.ea
                    && f.security.as_ref() == Some(&expected.security)
            }
            Self::Regular(f) => {
                f.stamp.identity == expected.identity
                    && f.expected == expected.expected
                    && f.ea == expected.ea
                    && f.security == expected.security
            }
        };
        let actual = self.basic();
        // Removing our children can change a DIRECTORY's mtime/change/allocation.
        // Native payload/EA/full SD and stable creation/attributes stay exact.
        native
            && actual.created == basic.created
            && actual.attributes == basic.attributes
            && (after_children && matches!(self, Self::Directory(_))
                || actual.modified == basic.modified)
    }
}
impl RemovalMaterial {
    fn recheck(
        &self,
        index: usize,
        node: &Node,
        after_children: bool,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
        context: &mut Option<RetiredContext>,
    ) -> Result<()> {
        check(cancel)?;
        if context.is_some() || !node.pin.deletion_purpose() {
            return Err(Error::CleanupUnknown);
        }
        let expected = self.native.get(index).ok_or(Error::Invalid)?;
        let (basic, native_bytes) = self.basic.get(index).ok_or(Error::Invalid)?;
        let mut compared = 256usize;
        for name in expected.expected.keys() {
            check(cancel)?;
            compared = compared
                .checked_add(name.len().checked_mul(4).ok_or(Error::Limit)?)
                .and_then(|n| n.checked_add(64))
                .ok_or(Error::Limit)?;
        }
        charge(work, compared)?;
        if expected.kind != node.kind || &expected.identity != node.pin.identity() {
            return Err(Error::Changed);
        }
        let _query = node
            .pin
            .try_observation_owner()
            .map_err(|_| Error::Unsupported)?;
        node.pin
            .verify()
            .map_err(|e| io_error("removeMaterialBefore", e))?;
        let before = Current::take(node, self, work, cancel)?;
        if !before.matches(expected, basic, after_children) {
            return Err(Error::Changed);
        }
        // Parse actual BackupRead bytes, including SAME-SIZE ADS edits. No hash
        // inferred from inventory, no path reopen and no native context escapes.
        let mut api = Native::new(true);
        let mut session = Session::new(Owner::file(&node.pin), &mut api, Mode::Read, context);
        let semantic = transfer::inspect(
            &mut session,
            *native_bytes,
            size_of::<WIN32_STREAM_ID>() + 1,
            work,
            &self.resident,
            |mut reader, work| match &before {
                Current::Directory(f) => {
                    let parsed = directory_records::parse(
                        &mut reader,
                        &f.expected,
                        Profile::WithFullSecurity,
                        work,
                        cancel,
                        &self.resident,
                    )?;
                    if parsed.security != f.security
                        || parsed.ea.as_ref().is_some_and(|ea| ea != &f.ea)
                        || parsed.has_ea() != (f.ea.count != 0)
                    {
                        return Err(Error::Changed);
                    }
                    Ok(parsed.semantic_sha256())
                }
                Current::Regular(f) => {
                    let parsed =
                        records::parse(&mut reader, &f.expected, work, cancel, &self.resident)?;
                    if parsed.security != f.security || parsed.has_ea() != (f.ea.count != 0) {
                        return Err(Error::Changed);
                    }
                    Ok(parsed.semantic_sha256())
                }
            },
        );
        drop(session);
        let semantic = semantic?;
        if !api.eof()
            || api.aborts() != 1
            || semantic != expected.semantic_sha256
            || !before.unchanged(&Current::take(node, self, work, cancel)?)
        {
            return Err(Error::Changed);
        }
        node.pin
            .verify()
            .map_err(|e| io_error("removeMaterialAfter", e))
    }
}
impl Sources {
    pub(in super::super) fn remove_owned(
        &mut self,
        material: &RemovalMaterial,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
        progress: RemovalProgress<'_>,
        before: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        if self.recovery_git.is_some()
            || self.nodes.is_empty()
            || material.native.len() != self.nodes.len()
            || self.user_nodes != self.nodes.len()
            || !self.nodes[0].pin.deletion_purpose()
            || !self
                .managed_root_git
                .as_ref()
                .is_some_and(|p| p.deletion_purpose())
        {
            return Err(Error::Unsupported);
        }
        self.verify(work, cancel)?;
        check(cancel)?;
        before()?;
        *progress.dispatched = true;
        // The durable callback may perform I/O. Revalidate AFTER it, before the
        // first deletion, so an injected/observed change cannot be swallowed.
        self.verify(work, cancel)?;
        for (index, node) in self.nodes.iter().enumerate() {
            material.recheck(index, node, false, work, cancel, progress.context)?;
        }
        self.verify(work, cancel)?;
        let _progress_memory = material.resident.lease(self.nodes.len())?;
        let mut removed_children = vec![false; self.nodes.len()];
        // The original breadth-first list alone grants membership. New entries
        // never become deletion targets and prevent their directory's removal.
        while self.nodes.len() > 1 {
            check(cancel)?;
            let index = self.nodes.len() - 1;
            let node = &self.nodes[index];
            material.recheck(
                index,
                node,
                removed_children[index],
                work,
                cancel,
                progress.context,
            )?;
            if node.kind == Kind::Directory
                && !listing(&node.pin, 0, work, cancel)?.as_entries().is_empty()
            {
                return Err(Error::Changed);
            }
            let node = self.nodes.pop().ok_or(Error::Invalid)?;
            let parent = usize::try_from(node.parent).map_err(|_| Error::Invalid)?;
            node.pin.remove_owned(&node.leaf, progress.stopped)?;
            *removed_children.get_mut(parent).ok_or(Error::Invalid)? = true;
        }
        self.managed_root_git.take().ok_or(Error::Invalid)?.remove(
            &mut self.removal_hold,
            progress.stopped,
            work,
            cancel,
        )?;
        removed_children[0] = true; // actual original root .git was removed
        check(cancel)?;
        let root = self.nodes.first().ok_or(Error::Invalid)?;
        material.recheck(0, root, removed_children[0], work, cancel, progress.context)?;
        if !listing(&root.pin, 0, work, cancel)?.as_entries().is_empty() {
            return Err(Error::Changed);
        }
        let root = self.nodes.pop().ok_or(Error::Invalid)?;
        root.pin.remove_owned(&root.leaf, progress.stopped)
    }
}
