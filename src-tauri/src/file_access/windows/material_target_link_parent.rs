//! Target-only link parent; never a source Pin or arbitrary destination path.
use super::super::super::{
    directory,
    material_pin::{self, Guid},
};
use super::*;
use std::sync::{Mutex, MutexGuard};

pub(super) struct Parent {
    file: Option<File>,
    witness: Option<File>,
    delete: Option<File>,
    identity: Option<Identity>,
    guid: Option<Guid>,
    pending: bool,
    stopped: Vec<StoppedHandle>,
    scan: Mutex<()>,
    resident: Resident,
}
impl Parent {
    pub(super) fn reserve(resident: &Resident) -> Self {
        Self {
            file: None,
            witness: None,
            delete: None,
            identity: None,
            guid: None,
            pending: false,
            stopped: Vec::with_capacity(3),
            scan: Mutex::new(()),
            resident: resident.clone(),
        }
    }
    pub(super) fn create(&mut self, parent: &File, leaf: &[u16]) -> Result<()> {
        if self.file.is_some() || self.identity.is_some() || self.pending {
            return Err(Error::Invalid);
        }
        material_raw_name::check(leaf).map_err(|_| Error::Invalid)?;
        let parent_guid = material_pin::guid(parent, &self.resident)
            .map_err(|e| io_error("targetParentGuid", material_pin::into_io(e)))?;
        // No DELETE desired and no FILE_SHARE_DELETE. On older Windows the
        // FileLinkInformation destination reopen shares READ|WRITE only.
        // These rights belong ONLY to this fresh target directory.
        let access = READ_CONTROL
            | FILE_LIST_DIRECTORY
            | FILE_ADD_FILE
            | FILE_ADD_SUBDIRECTORY
            | FILE_TRAVERSE
            | FILE_READ_EA
            | FILE_WRITE_EA
            | FILE_READ_ATTRIBUTES
            | FILE_WRITE_ATTRIBUTES
            | SYNCHRONIZE;
        let status = open(
            parent,
            leaf,
            true,
            FILE_CREATE,
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &mut self.file,
        );
        if status != 0 {
            self.pending = status >= 0;
            return Err(Error::NtStatus {
                phase: "targetLinkParentCreate",
                status,
            });
        }
        if self.file.is_none() {
            self.pending = true;
            return Err(Error::Invalid);
        }
        let file = self.file.as_ref().ok_or(Error::Invalid)?;
        let current = stamp(file).map_err(|e| io_error("targetParentStamp", e))?;
        if current.regular || current.identity.inode == 0 {
            return Err(Error::Unsupported);
        }
        let current_guid = material_pin::guid(file, &self.resident)
            .map_err(|e| io_error("targetParentCreatedGuid", material_pin::into_io(e)))?;
        if !current_guid.child_of(&parent_guid, leaf) {
            return Err(Error::Changed);
        }
        self.identity = Some(current.identity);
        self.guid = Some(current_guid);
        self.verify().map_err(|e| io_error("targetParentVerify", e))
    }
    pub(super) fn file(&self) -> Result<&File> {
        self.verify().map_err(|e| io_error("targetParentHeld", e))?;
        self.file.as_ref().ok_or(Error::Invalid)
    }
    fn verify(&self) -> io::Result<()> {
        if self.pending || !self.stopped.is_empty() {
            return Err(io::Error::other("target parent unknown"));
        }
        let file = self
            .file
            .as_ref()
            .ok_or_else(|| io::Error::other("target parent absent"))?;
        let value = stamp(file)?;
        let meta = metadata_file(file).map_err(|_| io::Error::other("target parent metadata"))?;
        if value.regular
            || Some(&value.identity) != self.identity.as_ref()
            || meta.kind != MetadataKind::Directory
            || meta.attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            return Err(io::Error::other("target parent identity/kind changed"));
        }
        let current = material_pin::guid(file, &self.resident).map_err(material_pin::into_io)?;
        if !self.guid.as_ref().is_some_and(|old| current.same_path(old)) {
            return Err(io::Error::other("target parent edge changed"));
        }
        Ok(())
    }
    pub(super) fn cleanup(
        &mut self,
        ancestor: &File,
        leaf: &[u16],
        work: &mut WorkBudget,
    ) -> Result<()> {
        if self.pending || !self.stopped.is_empty() {
            return Err(Error::CleanupUnknown);
        }
        if self.file.is_none() {
            return if self.witness.is_none() && self.delete.is_none() {
                Ok(())
            } else {
                Err(Error::CleanupUnknown)
            };
        }
        self.verify()
            .map_err(|e| io_error("targetParentBeforeCleanup", e))?;
        charge(work, 3 * records::BLOCK)?;
        let observed =
            directory::collect_budgeted_from(self, 0, &AtomicBool::new(false), &self.resident)
                .map_err(directory_error)?;
        if !observed.as_entries().is_empty() {
            return Err(Error::Changed);
        }
        drop(observed);
        let file = self.file.as_ref().ok_or(Error::Invalid)?;
        let mut basic: FILE_BASIC_INFO =
            info(file, FileBasicInfo).map_err(|e| io_error("targetParentCleanupBasic", e))?;
        basic.FileAttributes = FILE_ATTRIBUTE_NORMAL;
        set_basic(file, &basic)?;
        let status = open(
            ancestor,
            leaf,
            true,
            FILE_OPEN,
            FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            &mut self.witness,
        );
        if status != 0 {
            return Err(Error::NtStatus {
                phase: "targetParentWitness",
                status,
            });
        }
        let expected = self.identity.as_ref().ok_or(Error::CleanupUnknown)?;
        let witness = self.witness.as_ref().ok_or(Error::CleanupUnknown)?;
        if &stamp(witness)
            .map_err(|e| io_error("targetParentWitnessId", e))?
            .identity
            != expected
        {
            return Err(Error::Changed);
        }
        // Non-atomic access transition: the same-object witness survives the
        // no-DELETE handle's close. Reacquire only through its held ancestor.
        close(&mut self.file, &mut self.stopped)?;
        let before = stamp(witness).map_err(|e| io_error("targetParentPostClose", e))?;
        let version = metadata_file(witness).map_err(|_| Error::Invalid)?;
        let status = open(
            ancestor,
            leaf,
            true,
            FILE_OPEN,
            FILE_READ_ATTRIBUTES | DELETE | SYNCHRONIZE,
            FILE_SHARE_READ,
            &mut self.delete,
        );
        if status != 0 {
            return Err(Error::NtStatus {
                phase: "targetParentDeleteOpen",
                status,
            });
        }
        let actual = self.delete.as_ref().ok_or(Error::CleanupUnknown)?;
        if before.regular
            || &before.identity != expected
            || stamp(actual).map_err(|e| io_error("targetParentDeleteId", e))? != before
            || metadata_file(actual).map_err(|_| Error::Invalid)? != version
        {
            return Err(Error::Changed);
        }
        // A different returned FileObject is retained but never disposed.
        dispose(actual)?;
        close(&mut self.delete, &mut self.stopped)?;
        close(&mut self.witness, &mut self.stopped)
    }
}
impl directory::Owner for Parent {
    fn file(&self) -> &File {
        self.file
            .as_ref()
            .expect("verified target parent before scan")
    }
    fn verify(&self) -> io::Result<()> {
        Parent::verify(self)
    }
    fn directory_scan(&self) -> io::Result<MutexGuard<'_, ()>> {
        self.scan
            .lock()
            .map_err(|_| io::Error::other("target parent scan poisoned"))
    }
}
