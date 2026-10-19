//! One fresh directory under the original private namespace. No destination path.
use super::*;
use crate::file_access::{
    ea_records::WorkBudget,
    material_carrier_records::{self as records, Resident, charge, check},
};
use std::sync::{Mutex, MutexGuard};
pub(super) struct State {
    file: Option<File>,
    identity: Option<Identity>,
    pending: bool,
    _create_status: Option<i32>,
    scan: Mutex<()>,
    stopped: Vec<StoppedHandle>,
}
impl State {
    pub fn reserved() -> Self {
        Self {
            file: None,
            identity: None,
            pending: false,
            _create_status: None,
            scan: Mutex::new(()),
            stopped: Vec::with_capacity(1),
        }
    }
    pub fn create(&mut self, root: &File, full: bool) -> Result<()> {
        const LEAF: &[u16] = &[114, 101, 115, 116, 111, 114, 101, 100, 45, 100, 105, 114];
        self.create_named(root, LEAF, full)
    }
    // Only the original Namespace-owned directory tree calls this raw leaf seam.
    pub(super) fn create_named(&mut self, root: &File, leaf: &[u16], full: bool) -> Result<()> {
        if self.file.is_some()
            || self.identity.is_some()
            || self._create_status.is_some()
            || self.pending
            || !self.stopped.is_empty()
        {
            return Err(Error::Invalid);
        }
        crate::file_access::material_raw_name::check(leaf).map_err(|_| Error::Unsupported)?;
        let unicode = UNICODE_STRING {
            Length: (leaf.len() * 2) as u16,
            MaximumLength: (leaf.len() * 2) as u16,
            Buffer: leaf.as_ptr().cast_mut(),
        };
        let object = OBJECT_ATTRIBUTES {
            Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: handle(root),
            ObjectName: &unicode,
            Attributes: OBJ_CASE_INSENSITIVE,
            ..Default::default()
        };
        let access = READ_CONTROL
            | FILE_LIST_DIRECTORY
            | FILE_ADD_FILE
            | FILE_ADD_SUBDIRECTORY
            | FILE_TRAVERSE
            | FILE_READ_EA
            | FILE_WRITE_EA
            | FILE_READ_ATTRIBUTES
            | FILE_WRITE_ATTRIBUTES
            | SYNCHRONIZE
            | DELETE
            | if full {
                WRITE_DAC | WRITE_OWNER | ACCESS_SYSTEM_SECURITY
            } else {
                0
            };
        let mut ios = IO_STATUS_BLOCK::default();
        let mut raw = ptr::null_mut();
        let status = unsafe {
            NtCreateFile(
                &mut raw,
                access,
                &object,
                &mut ios,
                ptr::null(),
                FILE_ATTRIBUTE_DIRECTORY,
                0,
                FILE_CREATE,
                FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
                ptr::null(),
                0,
            )
        };
        self._create_status = Some(status);
        if status >= 0 && !raw.is_null() && raw != INVALID_HANDLE_VALUE {
            self.file = Some(unsafe { File::from_raw_handle(raw) });
        }
        if status != 0 {
            self.pending = status >= 0;
            return Err(Error::NtStatus {
                phase: "ownedDirectoryCreate",
                status,
            });
        }
        if self.file.is_none() {
            self.pending = true;
            return Err(Error::Invalid);
        }
        let file = self.file.as_ref().ok_or(Error::Invalid)?;
        let value = stamp(file).map_err(|e| io_error("ownedDirectoryStamp", e))?;
        if value.regular || value.identity.inode == 0 {
            return Err(Error::Unsupported);
        }
        super::super::pinned::local_guid(file).map_err(|e| io_error("ownedDirectoryLocal", e))?;
        self.identity = Some(value.identity);
        self.verify()
            .map_err(|e| io_error("ownedDirectoryVerify", e))
    }
    pub fn file(&self) -> Result<&File> {
        if self.pending || !self.stopped.is_empty() {
            return Err(Error::CleanupUnknown);
        }
        self.file.as_ref().ok_or(Error::Invalid)
    }
    fn verify(&self) -> io::Result<()> {
        let file = self
            .file
            .as_ref()
            .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
        if self.pending
            || !self.stopped.is_empty()
            || Some(&stamp(file)?.identity) != self.identity.as_ref()
        {
            return Err(io::Error::other("owned directory identity changed"));
        }
        let meta = metadata_file(file).map_err(|_| io::Error::other("owned directory metadata"))?;
        if meta.kind != MetadataKind::Directory
            || meta.attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            return Err(io::Error::other("owned directory kind changed"));
        }
        super::super::pinned::local_guid(file)?;
        Ok(())
    }
    pub fn empty(
        &self,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
        resident: &Resident,
    ) -> Result<()> {
        check(cancel)?;
        charge(work, 2 * records::BLOCK)?;
        // Budgeted original collector, SAME FileObject/scan owner; 0 admits only EOF.
        let entries = super::super::directory::collect_budgeted_from(self, 0, cancel, resident)
            .map_err(|e| match e {
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
                _ => Error::Invalid,
            })?;
        if !entries.as_entries().is_empty() {
            return Err(Error::Changed);
        }
        Ok(())
    }
    pub fn cleanup(&mut self) -> Result<()> {
        if self.pending || !self.stopped.is_empty() {
            return Err(Error::CleanupUnknown);
        }
        if let Some(file) = self.file.as_ref() {
            // Successful FILE_CREATE owns this exact object even if later query failed.
            let mut basic: FILE_BASIC_INFO =
                info(file, FileBasicInfo).map_err(|e| io_error("directoryCleanupBasic", e))?;
            basic.FileAttributes = FILE_ATTRIBUTE_NORMAL;
            set_basic(file, &basic)?;
            dispose(file)?;
        }
        close(&mut self.file, &mut self.stopped)
    }
}
impl super::super::directory::Owner for State {
    fn file(&self) -> &File {
        self.file
            .as_ref()
            .expect("private state verified before directory enumeration")
    }
    fn verify(&self) -> io::Result<()> {
        State::verify(self)
    }
    fn directory_scan(&self) -> io::Result<MutexGuard<'_, ()>> {
        self.scan
            .lock()
            .map_err(|_| io::Error::other("owned directory scan poisoned"))
    }
}
