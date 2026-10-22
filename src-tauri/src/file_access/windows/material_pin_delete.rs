//! Deletion is available only to a root created with the dedicated purpose.
use super::super::{
    pinned::WorktreeDeleteRoot,
    worktree_delete_file::{DeleteStoppedHandle, close_deleted},
};
use super::*;
use crate::file_access::material_carrier_records::{Error, Result, io_error};
impl MaterialPin {
    pub(in crate::file_access::windows) fn delete_root(
        root: WorktreeDeleteRoot,
        resident: &Resident,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        crate::file_access::material_carrier_records::check(cancel)?;
        let memory = resident.lease(NODE_MEMORY)?;
        let pin = root.pin();
        pin.verify().map_err(|e| io_error("deleteRootVerify", e))?;
        let opening = metadata_file(pin.file()).map_err(|_| Error::Invalid)?;
        if opening.kind != MetadataKind::Directory || !ordinary(&opening) {
            return Err(Error::Unsupported);
        }
        let identity = stamp(pin.file())
            .map_err(|e| io_error("deleteRootStamp", e))?
            .identity;
        let guid = guid(pin.file(), resident)
            .map_err(super::super::material_directory_carrier::pin_error)?;
        Ok(Self {
            inner: Arc::new(Node {
                resource: Resource::DeleteRoot(root),
                identity,
                guid,
                opening,
                full_security: true,
                deletion: true,
                depth: 0,
                resident: resident.clone(),
                _memory: memory,
            }),
        })
    }
    pub(in crate::file_access::windows) fn deletion_purpose(&self) -> bool {
        self.inner.deletion
    }
    pub(in crate::file_access::windows) fn remove_owned(
        self,
        leaf: &[u16],
        stopped: &mut Vec<DeleteStoppedHandle>,
    ) -> Result<()> {
        if !self.inner.deletion || Arc::strong_count(&self.inner) != 1 {
            return Err(Error::Unsupported);
        }
        self.verify().map_err(|e| io_error("removeNodeVerify", e))?;
        // A NativeProof, witness or administrative pointer still holding this
        // exact FileObject prevents retirement. No POSIX rename hides that bug.
        let node = Arc::try_unwrap(self.inner).map_err(|_| Error::Unsupported)?;
        match node.resource {
            Resource::DeleteRoot(root) => root.remove(stopped),
            Resource::Child { parent, file, .. } => {
                parent
                    .verify()
                    .map_err(|e| io_error("removeNodeParent", e))?;
                close_deleted(file, parent.file(), leaf, stopped)?;
                parent
                    .verify()
                    .map_err(|e| io_error("removeNodeParentAfter", e))
            }
            Resource::Root(_) => Err(Error::Unsupported),
        }
    }
}
