//! Dedicated DELETE-purpose root; ordinary PinnedPath constructors are unchanged.
use super::super::worktree_delete_file::{DeleteStoppedHandle, close_deleted};
use super::*;
use crate::file_access::material_carrier_records::{Result, io_error};

pub(crate) struct WorktreeDeleteRoot {
    pin: PinnedPath,
    parent: PinnedPath,
    leaf: Vec<u16>,
}
impl WorktreeDeleteRoot {
    pub(crate) fn open_for(path: &Path, full: bool) -> io::Result<Self> {
        let purpose = if full {
            ReadPurpose::FullSecurity
        } else {
            ReadPurpose::Ordinary
        };
        let parent_path = path.parent().ok_or_else(invalid)?;
        let leaf = path.file_name().ok_or_else(invalid)?;
        let mut raw = name(leaf)?;
        let parent = PinnedPath::git_directory(parent_path)?;
        parent.verify()?;
        let unicode = UNICODE_STRING {
            Length: (raw.len() * 2) as u16,
            MaximumLength: (raw.len() * 2) as u16,
            Buffer: raw.as_mut_ptr(),
        };
        let object = OBJECT_ATTRIBUTES {
            Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: handle(parent.file()),
            ObjectName: &unicode,
            Attributes: OBJ_CASE_INSENSITIVE,
            ..Default::default()
        };
        let mut ios = IO_STATUS_BLOCK::default();
        let mut returned = ptr::null_mut();
        let status = unsafe {
            NtCreateFile(
                &mut returned,
                FILE_GENERIC_READ | DELETE | purpose.extra_access(),
                &object,
                &mut ios,
                ptr::null(),
                FILE_ATTRIBUTE_NORMAL,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                FILE_OPEN,
                FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT | FILE_DIRECTORY_FILE,
                ptr::null(),
                0,
            )
        };
        if status < 0 {
            return Err(io::Error::from_raw_os_error(
                unsafe { RtlNtStatusToDosError(status) } as i32,
            ));
        }
        if returned.is_null() || returned == INVALID_HANDLE_VALUE {
            return Err(invalid());
        }
        let file = unsafe { File::from_raw_handle(returned) };
        if status != 0 || stamp(&file)?.regular {
            return Err(denied());
        }
        let guid_path = local_guid(&file)?;
        if guid_path != parent.guid_path.join(leaf) {
            return Err(denied());
        }
        let actual_path = final_path(&file, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS)?;
        let mut files = parent
            .files
            .iter()
            .map(File::try_clone)
            .collect::<io::Result<Vec<_>>>()?;
        let mut identities = parent.identities.clone();
        identities.push(stamp(&file)?.identity);
        files.push(file);
        let pin = PinnedPath {
            files,
            identities,
            purpose,
            directory_scan: Mutex::new(()),
            path: actual_path,
            guid_path,
        };
        pin.verify()?;
        parent.verify()?;
        Ok(Self {
            pin,
            parent,
            leaf: raw,
        })
    }
    pub(crate) fn pin(&self) -> &PinnedPath {
        &self.pin
    }
    pub(crate) fn remove(mut self, stopped: &mut Vec<DeleteStoppedHandle>) -> Result<()> {
        self.pin
            .verify()
            .map_err(|e| io_error("removeRootVerify", e))?;
        self.parent
            .verify()
            .map_err(|e| io_error("removeParentVerify", e))?;
        let file = self
            .pin
            .files
            .pop()
            .ok_or(crate::file_access::material_carrier_records::Error::Invalid)?;
        // Only ancestor handles were duplicated. No root File clone is retained.
        drop(self.pin);
        close_deleted(file, self.parent.file(), &self.leaf, stopped)?;
        self.parent
            .verify()
            .map_err(|e| io_error("removeParentAfter", e))
    }
}
