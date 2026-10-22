//! Opaque actual DELETE owners used only by the worktree removal transaction.
pub(crate) use super::worktree_delete_file::DeleteStoppedHandle;
use super::*;
use super::{directory::Owner, material_pin::MaterialPin};
use crate::file_access::{
    DirectoryObservation,
    ea_records::WorkBudget,
    material_carrier_records::{Error, Result, check},
};
use std::{path::Path, sync::atomic::AtomicBool};
pub(crate) struct WorktreeDeleteNode {
    pin: MaterialPin,
}
pub(crate) struct DeleteSecurity {
    sha256: [u8; 32],
    _memory: crate::file_access::material_carrier_records::ResidentLease,
}
impl WorktreeDeleteNode {
    pub(crate) fn plain_security(
        &self,
        memory: &super::MixedMemory,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
    ) -> Result<DeleteSecurity> {
        let lease = memory.shared().lease(size_of::<DeleteSecurity>())?;
        Ok(DeleteSecurity {
            sha256: self.require_plain(memory, work, cancel)?,
            _memory: lease,
        })
    }
    pub(crate) fn require_same_plain(
        &self,
        expected: &DeleteSecurity,
        memory: &super::MixedMemory,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
    ) -> Result<()> {
        crate::file_access::material_carrier_records::charge(work, 64)?;
        if self.require_plain(memory, work, cancel)? != expected.sha256 {
            return Err(Error::Changed);
        }
        Ok(())
    }
    pub(crate) fn root(
        path: &Path,
        memory: &super::MixedMemory,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        let root = super::pinned::WorktreeDeleteRoot::open(path).map_err(|e| {
            crate::file_access::material_carrier_records::io_error("deleteRootOpen", e)
        })?;
        Ok(Self {
            pin: MaterialPin::delete_root(root, &memory.shared(), cancel)?,
        })
    }
    pub(crate) fn child(
        &self,
        raw: &[u16],
        listed: &DirectoryObservation,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        Ok(Self {
            pin: self
                .pin
                .child(raw, listed, cancel)
                .map_err(super::material_directory_carrier::pin_error)?,
        })
    }
    pub(crate) fn file(&self) -> &File {
        Owner::file(&self.pin)
    }
    pub(crate) fn verify(&self) -> Result<()> {
        self.pin.verify().map_err(|e| {
            crate::file_access::material_carrier_records::io_error("deletePinVerify", e)
        })
    }
    pub(crate) fn entries(
        &self,
        limit: usize,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
    ) -> Result<crate::file_access::material_directory_budget::MaterialEntries> {
        super::material_directory_tree_source::listing(&self.pin, limit, work, cancel)
    }
    // Original private Git bytes are represented by the independently verified
    // recovery repository. Any extra ADS/EA is user material we cannot discard.
    pub(crate) fn require_plain(
        &self,
        memory: &super::MixedMemory,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
    ) -> Result<[u8; 32]> {
        check(cancel)?;
        self.verify()?;
        let _query = self
            .pin
            .try_observation_owner()
            .map_err(|_| Error::Unsupported)?;
        let resident = memory.shared();
        let (expected, ea, security) = if self.pin.opening_metadata().kind
            == MetadataKind::Directory
        {
            let f =
                super::material_directory_facts::take(self.file(), true, work, cancel, &resident)?;
            (f.expected, f.ea, f.security.ok_or(Error::Unsupported)?)
        } else {
            let f = super::material_carrier_native::facts(self.file(), work, cancel, &resident)?;
            (f.expected, f.ea, f.security)
        };
        if expected.keys().any(|key| !key.is_empty()) || ea.count != 0 {
            return Err(Error::Unsupported);
        }
        self.verify()?;
        Ok(security.sha256)
    }
    pub(crate) fn remove(self, raw: &[u16], stopped: &mut Vec<DeleteStoppedHandle>) -> Result<()> {
        self.pin.remove_owned(raw, stopped)
    }
    pub(super) fn material(&self) -> MaterialPin {
        self.pin.clone()
    }
}
#[cfg(test)]
#[path = "material_delete_tests.rs"]
mod tests;
