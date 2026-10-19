//! Sealed fresh namespace: never accepts an arbitrary destination path.
use super::material_carrier_native::Basic;
use super::*;
use crate::file_access::material_carrier_records::{Error, Result, io_error};
use std::os::windows::io::IntoRawHandle;
use std::sync::atomic::AtomicBool;
use windows_sys::Win32::System::SystemServices::ACCESS_SYSTEM_SECURITY;
use windows_sys::Win32::{
    Foundation::{CloseHandle, LocalFree},
    Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    },
};

pub(super) struct Namespace {
    parent: Option<File>,
    parent_id: Option<Identity>,
    root: Option<File>,
    root_id: Option<Identity>,
    cleaned: bool,
    links: Option<owned_link::State>,
    directory: Option<owned_directory::State>,
    tree: Option<owned_directory_tree::State>,
    stopped_handles: Vec<StoppedHandle>,
    stopped_allocations: Vec<StoppedAllocation>,
    _creation: Option<CreationOutcome>,
    pub source_carrier: Option<File>,
    pub target: Option<File>,
    pub target_carrier: Option<File>,
    pub tree_carrier: Option<File>,
}
impl Namespace {
    // Caller installs this owner in its retirement sink before any API call.
    pub fn reserve() -> Result<Self> {
        Ok(Self {
            parent: None,
            parent_id: None,
            root: None,
            root_id: None,
            cleaned: false,
            links: None,
            directory: None,
            tree: None,
            stopped_handles: Vec::with_capacity(5),
            stopped_allocations: Vec::with_capacity(1),
            _creation: None,
            source_carrier: None,
            target: None,
            target_carrier: None,
            tree_carrier: None,
        })
    }
    pub fn open(&mut self) -> Result<()> {
        // OS temporary-directory selection is not a new product env flag. It
        // selects ONLY a parent; authority to delete is NEVER given for it.
        let path = std::env::temp_dir()
            .canonicalize()
            .map_err(|e| io_error("tempCanonical", e))?;
        absolute(&path).map_err(|e| io_error("tempPath", e))?;
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let raw = unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_TRAVERSE | FILE_ADD_SUBDIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                ptr::null_mut(),
            )
        };
        if raw == INVALID_HANDLE_VALUE {
            return Err(io_error("tempParentOpen", io::Error::last_os_error()));
        }
        self.parent = Some(unsafe { File::from_raw_handle(raw) });
        let parent = self.parent.as_ref().ok_or(Error::Invalid)?;
        let value = stamp(parent).map_err(|e| io_error("tempParentStamp", e))?;
        if value.regular {
            return Err(Error::Unsupported);
        }
        super::pinned::local_guid(parent).map_err(|e| io_error("tempParentLocal", e))?;
        self.parent_id = Some(value.identity);
        let mut random = [0u8; 24];
        getrandom::fill(&mut random).map_err(|_| Error::Unsupported)?;
        let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let leaf = format!("farfold-owned-carrier-{suffix}");
        let mut security = PrivateDescriptor::new(&mut self.stopped_allocations)?;
        let mut encoded = name(OsStr::new(&leaf)).map_err(|e| io_error("namespaceName", e))?;
        let unicode = UNICODE_STRING {
            Length: (encoded.len() * 2) as u16,
            MaximumLength: (encoded.len() * 2) as u16,
            Buffer: encoded.as_mut_ptr(),
        };
        let object = OBJECT_ATTRIBUTES {
            Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: handle(parent),
            ObjectName: &unicode,
            Attributes: OBJ_CASE_INSENSITIVE,
            SecurityDescriptor: security.0.cast(),
            ..Default::default()
        };
        let mut ios = IO_STATUS_BLOCK::default();
        let mut raw = ptr::null_mut();
        let status = unsafe {
            NtCreateFile(
                &mut raw,
                FILE_LIST_DIRECTORY | FILE_ADD_FILE | FILE_READ_ATTRIBUTES | DELETE | SYNCHRONIZE,
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
        // Capture a successful handle BEFORE fallible descriptor disposal.
        if status == 0 {
            self.root = Some(unsafe { File::from_raw_handle(raw) });
        }
        let mapped_error = if status != 0 {
            Some(unsafe { RtlNtStatusToDosError(status) } as i32)
        } else {
            None
        };
        self._creation = Some(CreationOutcome {
            _status: status,
            _mapped_error: mapped_error,
        });
        let descriptor_freed = security.finish();
        drop(security);
        // Preserve the original create failure EVEN IF descriptor cleanup also
        // failed. The outer cleanup sees stopped_allocations and retires both.
        if let Some(code) = mapped_error {
            return Err(Error::Io {
                phase: "namespaceCreate",
                code: Some(code),
            });
        }
        if !descriptor_freed {
            return Err(Error::CleanupUnknown);
        }
        // Only the actual newly-created handle becomes the delete capability.
        let root = self.root.as_ref().ok_or(Error::Invalid)?;
        let value = stamp(root).map_err(|e| io_error("namespaceStamp", e))?;
        if value.regular {
            return Err(Error::Unsupported);
        }
        super::pinned::local_guid(root).map_err(|e| io_error("namespaceLocal", e))?;
        self.root_id = Some(value.identity);
        self.source_carrier = Some(self.create("capture.bin", false)?);
        self.target_carrier = Some(self.create("recapture.bin", false)?);
        Ok(())
    }
    pub fn open_directory_namespace(&mut self) -> Result<()> {
        // OS temporary-directory selection is not a new product env flag. It
        // selects ONLY a parent; authority to delete is NEVER given for it.
        let path = std::env::temp_dir()
            .canonicalize()
            .map_err(|e| io_error("tempCanonical", e))?;
        absolute(&path).map_err(|e| io_error("tempPath", e))?;
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let raw = unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_TRAVERSE | FILE_ADD_SUBDIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                ptr::null_mut(),
            )
        };
        if raw == INVALID_HANDLE_VALUE {
            return Err(io_error("tempParentOpen", io::Error::last_os_error()));
        }
        self.parent = Some(unsafe { File::from_raw_handle(raw) });
        let parent = self.parent.as_ref().ok_or(Error::Invalid)?;
        let value = stamp(parent).map_err(|e| io_error("tempParentStamp", e))?;
        if value.regular {
            return Err(Error::Unsupported);
        }
        super::pinned::local_guid(parent).map_err(|e| io_error("tempParentLocal", e))?;
        self.parent_id = Some(value.identity);
        let mut random = [0u8; 24];
        getrandom::fill(&mut random).map_err(|_| Error::Unsupported)?;
        let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let leaf = format!("farfold-owned-carrier-{suffix}");
        let mut security = PrivateDescriptor::new(&mut self.stopped_allocations)?;
        let mut encoded = name(OsStr::new(&leaf)).map_err(|e| io_error("namespaceName", e))?;
        let unicode = UNICODE_STRING {
            Length: (encoded.len() * 2) as u16,
            MaximumLength: (encoded.len() * 2) as u16,
            Buffer: encoded.as_mut_ptr(),
        };
        let object = OBJECT_ATTRIBUTES {
            Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: handle(parent),
            ObjectName: &unicode,
            Attributes: OBJ_CASE_INSENSITIVE,
            SecurityDescriptor: security.0.cast(),
            ..Default::default()
        };
        let mut ios = IO_STATUS_BLOCK::default();
        let mut raw = ptr::null_mut();
        let status = unsafe {
            NtCreateFile(
                &mut raw,
                FILE_LIST_DIRECTORY
                    | FILE_ADD_FILE
                    | FILE_ADD_SUBDIRECTORY
                    | FILE_READ_ATTRIBUTES
                    | DELETE
                    | SYNCHRONIZE,
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
        // Capture a successful handle BEFORE fallible descriptor disposal.
        if status == 0 {
            self.root = Some(unsafe { File::from_raw_handle(raw) });
        }
        let mapped_error = if status != 0 {
            Some(unsafe { RtlNtStatusToDosError(status) } as i32)
        } else {
            None
        };
        self._creation = Some(CreationOutcome {
            _status: status,
            _mapped_error: mapped_error,
        });
        let descriptor_freed = security.finish();
        drop(security);
        // Preserve the original create failure EVEN IF descriptor cleanup also
        // failed. The outer cleanup sees stopped_allocations and retires both.
        if let Some(code) = mapped_error {
            return Err(Error::Io {
                phase: "namespaceCreate",
                code: Some(code),
            });
        }
        if !descriptor_freed {
            return Err(Error::CleanupUnknown);
        }
        // Only the actual newly-created handle becomes the delete capability.
        let root = self.root.as_ref().ok_or(Error::Invalid)?;
        let value = stamp(root).map_err(|e| io_error("namespaceStamp", e))?;
        if value.regular {
            return Err(Error::Unsupported);
        }
        super::pinned::local_guid(root).map_err(|e| io_error("namespaceLocal", e))?;
        self.root_id = Some(value.identity);
        self.source_carrier = Some(self.create("capture.bin", false)?);
        self.target_carrier = Some(self.create("recapture.bin", false)?);
        Ok(())
    }
    pub fn create_directory_target(&mut self, full: bool) -> Result<()> {
        if self.directory.is_some() {
            return Err(Error::Invalid);
        }
        self.verify()?;
        // Installed before the first directory-create syscall.
        self.directory = Some(owned_directory::State::reserved());
        let root = self.root.as_ref().ok_or(Error::Invalid)?;
        self.directory
            .as_mut()
            .ok_or(Error::Invalid)?
            .create(root, full)
    }
    pub fn directory_target(&self) -> Result<&File> {
        self.directory.as_ref().ok_or(Error::Invalid)?.file()
    }
    pub fn verify_directory_empty(
        &self,
        work: &mut crate::file_access::ea_records::WorkBudget,
        cancel: &AtomicBool,
        resident: &crate::file_access::material_carrier_records::Resident,
    ) -> Result<()> {
        self.directory
            .as_ref()
            .ok_or(Error::Invalid)?
            .empty(work, cancel, resident)
    }
    pub fn prepare_directory_tree(
        &mut self,
        resident: &crate::file_access::material_carrier_records::Resident,
    ) -> Result<()> {
        if self.tree.is_some()
            || self.directory.is_some()
            || self.target.is_some()
            || self.tree_carrier.is_some()
        {
            return Err(Error::Invalid);
        }
        self.verify()?;
        self.tree = Some(owned_directory_tree::State::reserve(resident)?);
        self.tree_carrier = Some(self.create("directory-tree.bin", false)?);
        Ok(())
    }
    pub fn create_tree_directory(
        &mut self,
        parent: u32,
        leaf: &[u16],
        full: bool,
    ) -> Result<usize> {
        self.verify()?;
        let root = self.root.as_ref().ok_or(Error::Invalid)?;
        self.tree
            .as_mut()
            .ok_or(Error::Invalid)?
            .create(root, parent, leaf, full)
    }
    pub fn tree_directory(&self, index: usize) -> Result<&File> {
        self.tree.as_ref().ok_or(Error::Invalid)?.file(index)
    }
    pub fn tree_directory_empty(
        &self,
        index: usize,
        work: &mut crate::file_access::ea_records::WorkBudget,
        cancel: &AtomicBool,
        resident: &crate::file_access::material_carrier_records::Resident,
    ) -> Result<()> {
        self.tree
            .as_ref()
            .ok_or(Error::Invalid)?
            .empty(index, work, cancel, resident)
    }
    pub fn verify_tree_edges(
        &self,
        work: &mut crate::file_access::ea_records::WorkBudget,
        cancel: &AtomicBool,
        resident: &crate::file_access::material_carrier_records::Resident,
    ) -> Result<()> {
        self.tree
            .as_ref()
            .ok_or(Error::Invalid)?
            .verify_edges(work, cancel, resident)
    }
    pub fn create_target(&mut self) -> Result<()> {
        if self.target.is_some() {
            return Err(Error::Invalid);
        }
        self.target = Some(self.create("restored.bin", true)?);
        Ok(())
    }
    fn create(&self, leaf: &str, restore: bool) -> Result<File> {
        let root = self.root.as_ref().ok_or(Error::Invalid)?;
        self.verify()?;
        let mut encoded = name(OsStr::new(leaf)).map_err(|e| io_error("ownedLeaf", e))?;
        let unicode = UNICODE_STRING {
            Length: (encoded.len() * 2) as u16,
            MaximumLength: (encoded.len() * 2) as u16,
            Buffer: encoded.as_mut_ptr(),
        };
        let object = OBJECT_ATTRIBUTES {
            Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: handle(root),
            ObjectName: &unicode,
            Attributes: OBJ_CASE_INSENSITIVE,
            ..Default::default()
        };
        let mut ios = IO_STATUS_BLOCK::default();
        let mut raw = ptr::null_mut();
        // Target-only security setter rights. No source/readonly PinnedPath
        // constructor is widened. DELETE is only for these owned temp leaves.
        let access = FILE_GENERIC_READ
            | FILE_GENERIC_WRITE
            | DELETE
            | if restore {
                WRITE_DAC | WRITE_OWNER | ACCESS_SYSTEM_SECURITY
            } else {
                0
            };
        let status = unsafe {
            NtCreateFile(
                &mut raw,
                access,
                &object,
                &mut ios,
                ptr::null(),
                FILE_ATTRIBUTE_NORMAL,
                0,
                FILE_CREATE,
                FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
                ptr::null(),
                0,
            )
        };
        if status != 0 {
            return Err(io_error(
                "ownedCreate",
                io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(status) } as i32),
            ));
        }
        let file = unsafe { File::from_raw_handle(raw) };
        Ok(file)
    }
    pub fn verify(&self) -> Result<()> {
        let parent = self.parent.as_ref().ok_or(Error::Invalid)?;
        if self.parent_id.as_ref()
            != Some(
                &stamp(parent)
                    .map_err(|e| io_error("tempParentVerify", e))?
                    .identity,
            )
        {
            return Err(Error::Changed);
        }
        let root = self.root.as_ref().ok_or(Error::Invalid)?;
        if self.root_id.as_ref()
            != Some(
                &stamp(root)
                    .map_err(|e| io_error("namespaceVerify", e))?
                    .identity,
            )
        {
            return Err(Error::Changed);
        }
        Ok(())
    }
    pub fn cleanup(&mut self) -> Result<()> {
        if self.cleaned {
            return Ok(());
        }
        if !self.stopped_handles.is_empty() || !self.stopped_allocations.is_empty() {
            return Err(Error::CleanupUnknown);
        }
        // No-op for every original carrier/restore caller (links == None).
        // The link-purpose owner closes each verified alias before its primary.
        if let Some(links) = self.links.as_mut() {
            links.cleanup()?;
        }
        if let Some(tree) = self.tree.as_mut() {
            tree.cleanup()?;
        }
        if let Some(directory) = self.directory.as_mut() {
            directory.cleanup()?;
        }
        // Retire on any failed disposition; no pathname cleanup/fallback/retry.
        // Backup contexts must already have successfully aborted before here.
        for leaf in [
            &mut self.source_carrier,
            &mut self.target_carrier,
            &mut self.tree_carrier,
            &mut self.target,
        ] {
            if let Some(file) = leaf.as_ref() {
                let mut basic: FILE_BASIC_INFO =
                    info(file, FileBasicInfo).map_err(|e| io_error("cleanupBasic", e))?;
                basic.FileAttributes = FILE_ATTRIBUTE_NORMAL;
                set_basic(file, &basic)?; // own object only; never the source.
                dispose(file)?;
            }
            // No aliases are made. share=0 excludes external DATA/write/delete
            // opens, not every metadata-only FileObject. Namespace disposition
            // and our exact closes are separately acknowledged below.
            close(leaf, &mut self.stopped_handles)?;
        }
        if let Some(root) = self.root.as_ref() {
            // A root exists only after FILE_CREATE returned its own handle.
            // Even an intermediate stamp/validation failure never deletes the
            // existing OS temp parent or any name-based replacement.
            dispose(root)?;
            close(&mut self.root, &mut self.stopped_handles)?;
        }
        close(&mut self.parent, &mut self.stopped_handles)?;
        self.cleaned = true;
        Ok(())
    }
}
struct CreationOutcome {
    _status: i32,
    _mapped_error: Option<i32>,
}
struct StoppedHandle {
    _opaque: usize,
    _close_error: Option<i32>,
}
struct StoppedAllocation {
    _input: usize,
    _returned_token: usize,
    _free_error: Option<i32>,
    _phase: &'static str,
}
struct PrivateDescriptor<'a>(*mut std::ffi::c_void, &'a mut Vec<StoppedAllocation>);
impl<'a> PrivateDescriptor<'a> {
    fn new(stopped: &'a mut Vec<StoppedAllocation>) -> Result<Self> {
        // Actual TokenLogonSid (existing shared helper), not TokenUser and not
        // a claim that a pathname/TempDir prefix creates a private namespace.
        let sid = crate::windows_pipe::logon_sid().map_err(|e| io_error("namespaceLogonSid", e))?;
        let text: Vec<u16> = format!("D:P(A;OICI;FA;;;{sid})")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut descriptor = ptr::null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                text.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                ptr::null_mut(),
            )
        } == 0
        {
            return Err(io_error("namespacePrivateDacl", io::Error::last_os_error()));
        }
        Ok(Self(descriptor, stopped))
    }
    fn finish(&mut self) -> bool {
        if self.0.is_null() {
            return self.1.is_empty();
        }
        let pointer = std::mem::replace(&mut self.0, ptr::null_mut());
        let returned = unsafe { LocalFree(pointer) };
        if !returned.is_null() {
            // LocalFree documents GetLastError on failure. Capture it before
            // other native work, retaining both opaque input and returned token.
            let free_error = io::Error::last_os_error().raw_os_error();
            self.1.push(StoppedAllocation {
                _input: pointer as usize,
                _returned_token: returned as usize,
                _free_error: free_error,
                _phase: "namespaceDescriptorFree",
            });
            false
        } else {
            true
        }
    }
}
impl Drop for PrivateDescriptor<'_> {
    fn drop(&mut self) {
        self.finish();
    }
}
fn close(slot: &mut Option<File>, stopped: &mut Vec<StoppedHandle>) -> Result<()> {
    if let Some(file) = slot.take() {
        let raw = file.into_raw_handle();
        if unsafe { CloseHandle(raw) } == 0 {
            // One failed close permanently retires this namespace. Its actual
            // returned opaque HANDLE is not reused or interpreted as closed.
            let close_error = io::Error::last_os_error().raw_os_error();
            stopped.push(StoppedHandle {
                _opaque: raw as usize,
                _close_error: close_error,
            });
            return Err(Error::Io {
                phase: "ownedClose",
                code: close_error,
            });
        }
    }
    Ok(())
}
fn dispose(file: &File) -> Result<()> {
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    if unsafe {
        SetFileInformationByHandle(
            handle(file),
            FileDispositionInfo,
            (&disposition as *const FILE_DISPOSITION_INFO).cast(),
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    } == 0
    {
        return Err(io_error("ownedDisposition", io::Error::last_os_error()));
    }
    Ok(())
}
fn set_basic(file: &File, basic: &FILE_BASIC_INFO) -> Result<()> {
    if unsafe {
        SetFileInformationByHandle(
            handle(file),
            FileBasicInfo,
            (basic as *const FILE_BASIC_INFO).cast(),
            size_of::<FILE_BASIC_INFO>() as u32,
        )
    } == 0
    {
        return Err(io_error("ownedBasic", io::Error::last_os_error()));
    }
    Ok(())
}
pub(super) fn finalize(file: &File, value: &Basic) -> Result<()> {
    // ChangeTime/allocation/fullID describe the NEW object, not restored identity.
    // Source access time is finalized after recapture because reading can change it.
    set_basic(
        file,
        &FILE_BASIC_INFO {
            CreationTime: value.created,
            LastAccessTime: value.accessed,
            LastWriteTime: value.modified,
            ChangeTime: 0,
            FileAttributes: value.attributes,
        },
    )
}
pub(super) fn flushed(file: &File) -> Result<()> {
    if unsafe { FlushFileBuffers(handle(file)) } == 0 {
        return Err(io_error("ownedFlush", io::Error::last_os_error()));
    }
    Ok(())
}

#[path = "material_owned_directory_tree.rs"]
mod owned_directory_tree;

#[path = "material_owned_directory.rs"]
mod owned_directory;

#[path = "material_owned_link.rs"]
pub(super) mod owned_link;

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Seek, SeekFrom, Write};
    #[test]
    fn owned_file_create_collision_preserves_original_and_disposes_namespace() {
        let mut namespace = Namespace::reserve().unwrap();
        namespace.open().unwrap();
        let mut file = namespace.source_carrier.as_ref().unwrap();
        file.write_all(b"owned-sentinel").unwrap();
        let failure = namespace.create("capture.bin", false).err().unwrap();
        assert!(matches!(
            failure,
            Error::Io {
                code: Some(80 | 183),
                ..
            }
        ));
        file.seek(SeekFrom::Start(0)).unwrap();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"owned-sentinel");
        namespace.cleanup().unwrap();
        assert!(namespace.cleaned);
        assert!(namespace.root.is_none());
    }
}
