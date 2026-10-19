//! Fixed child metadata only; handles never escape the individual observation.
use super::*;
use windows_sys::Win32::{
    Foundation::STATUS_OBJECT_NAME_NOT_FOUND, System::SystemServices::IO_REPARSE_TAG_SYMLINK,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MetadataKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EntryMetadata {
    pub kind: MetadataKind,
    identity: Identity,
    attributes: u32,
    reparse_tag: u32,
    size: i64,
    allocation_size: i64,
    links: u32,
    created: i64,
    modified: i64,
    changed: i64,
}

impl EntryMetadata {
    // Fixed-width observation fields, not security/EA/ADS contents or restore data.
    pub(crate) fn version_fields(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend(self.identity.device.to_le_bytes());
        out.extend(self.identity.inode.to_le_bytes());
        out.extend(self.attributes.to_le_bytes());
        out.extend(self.reparse_tag.to_le_bytes());
        out.extend(self.size.to_le_bytes());
        out.extend(self.allocation_size.to_le_bytes());
        out.extend(self.links.to_le_bytes());
        out.extend(self.created.to_le_bytes());
        out.extend(self.modified.to_le_bytes());
        out.extend(self.changed.to_le_bytes());
        out
    }
    pub(crate) fn matches_directory_entry(
        &self,
        listed: &crate::file_access::DirectoryObservation,
    ) -> bool {
        self.identity == listed.identity
            && self.attributes == listed.attributes
            && self.reparse_tag == listed.reparse_tag.unwrap_or(0)
            && self.size == listed.size
            && self.allocation_size == listed.allocation_size
            && self.created == listed.created
            && self.modified == listed.modified
            && self.changed == listed.changed
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MetadataFailure {
    phase: &'static str,
    kind: io::ErrorKind,
    code: Option<i32>,
    nt_status: Option<i32>,
}
impl MetadataFailure {
    fn io(phase: &'static str, error: io::Error) -> Self {
        Self {
            phase,
            kind: error.kind(),
            code: error.raw_os_error(),
            nt_status: None,
        }
    }
    fn invalid(phase: &'static str) -> Self {
        Self::io(phase, io::Error::from(io::ErrorKind::InvalidData))
    }
}

fn open(parent: &File, component: &OsStr) -> Result<Option<File>, MetadataFailure> {
    let mut encoded = name(component).map_err(|e| MetadataFailure::io("name", e))?;
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
        ..Default::default()
    };
    let mut status = IO_STATUS_BLOCK::default();
    let mut result = ptr::null_mut();
    // SAFETY: one validated component, relative to an already-held directory.
    // No data, enumeration, write, create, delete or backup rights are requested.
    let code = unsafe {
        NtCreateFile(
            &mut result,
            FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            &object,
            &mut status,
            ptr::null(),
            FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            FILE_OPEN,
            FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
            ptr::null(),
            0,
        )
    };
    if code == STATUS_OBJECT_NAME_NOT_FOUND {
        // Only this exact open-time leaf absence is Missing. Query errors below
        // never pass through this branch, even if mapped to ERROR_FILE_NOT_FOUND.
        return Ok(None);
    }
    if code < 0 {
        let mut failure = MetadataFailure::io(
            "open",
            io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(code) } as i32),
        );
        failure.nt_status = Some(code);
        return Err(failure);
    }
    // SAFETY: successful NtCreateFile transferred this single owned handle.
    Ok(Some(unsafe { File::from_raw_handle(result) }))
}

fn exact_name(file: &File, component: &OsStr) -> Result<(), MetadataFailure> {
    // FILE_NAME_INFO has a four-byte length followed by UTF-16. The allocation
    // is aligned, bounded by the Windows maximum path, and contains no file data.
    const MAX_UNITS: usize = 32768;
    let bytes = offset_of!(FILE_NAME_INFO, FileName) + MAX_UNITS * 2;
    let mut buffer = vec![0u32; bytes.div_ceil(size_of::<u32>())];
    if unsafe {
        GetFileInformationByHandleEx(
            handle(file),
            FileNameInfo,
            buffer.as_mut_ptr().cast(),
            bytes as u32,
        )
    } == 0
    {
        return Err(MetadataFailure::io("finalName", io::Error::last_os_error()));
    }
    let length = buffer[0] as usize;
    if length == 0 || !length.is_multiple_of(2) || length > MAX_UNITS * 2 {
        return Err(MetadataFailure::invalid("finalName"));
    }
    // SAFETY: checked API byte length is within this aligned allocation.
    let name = unsafe {
        std::slice::from_raw_parts(
            buffer
                .as_ptr()
                .cast::<u8>()
                .add(offset_of!(FILE_NAME_INFO, FileName))
                .cast::<u16>(),
            length / 2,
        )
    };
    let actual = name
        .rsplit(|c| matches!(*c, 47 | 92))
        .next()
        .unwrap_or_default();
    let expected = component.encode_wide().collect::<Vec<_>>();
    if unsafe {
        CompareStringOrdinal(
            actual.as_ptr(),
            actual.len() as i32,
            expected.as_ptr(),
            expected.len() as i32,
            1,
        )
    } != CSTR_EQUAL
    {
        return Err(MetadataFailure::invalid("finalName"));
    }
    Ok(())
}

pub(crate) fn metadata_file(file: &File) -> Result<EntryMetadata, MetadataFailure> {
    if unsafe { GetFileType(handle(file)) } != FILE_TYPE_DISK {
        return Err(MetadataFailure::invalid("fileType"));
    }
    let id: FILE_ID_INFO =
        info(file, FileIdInfo).map_err(|e| MetadataFailure::io("identity", e))?;
    let basic: FILE_BASIC_INFO =
        info(file, FileBasicInfo).map_err(|e| MetadataFailure::io("basic", e))?;
    let standard: FILE_STANDARD_INFO =
        info(file, FileStandardInfo).map_err(|e| MetadataFailure::io("standard", e))?;
    let tag: FILE_ATTRIBUTE_TAG_INFO =
        info(file, FileAttributeTagInfo).map_err(|e| MetadataFailure::io("tag", e))?;
    if standard.DeletePending
        || standard.EndOfFile < 0
        || standard.AllocationSize < 0
        || basic.FileAttributes != tag.FileAttributes
        || standard.Directory != (basic.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0)
        || u128::from_le_bytes(id.FileId.Identifier) == 0
    {
        return Err(MetadataFailure::invalid("inconsistent"));
    }
    let reparse = basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    let kind = if reparse {
        if tag.ReparseTag == IO_REPARSE_TAG_SYMLINK {
            MetadataKind::Symlink
        } else {
            // Junctions and unknown tags are metadata, never followed targets.
            MetadataKind::Other
        }
    } else if standard.Directory {
        MetadataKind::Directory
    } else {
        MetadataKind::File
    };
    Ok(EntryMetadata {
        kind,
        identity: Identity {
            device: id.VolumeSerialNumber,
            inode: u128::from_le_bytes(id.FileId.Identifier),
        },
        attributes: basic.FileAttributes,
        reparse_tag: if reparse { tag.ReparseTag } else { 0 },
        size: standard.EndOfFile,
        allocation_size: standard.AllocationSize,
        links: standard.NumberOfLinks,
        created: basic.CreationTime,
        modified: basic.LastWriteTime,
        changed: basic.ChangeTime,
    })
}

pub(crate) fn metadata_child(
    parent: &File,
    component: &OsStr,
) -> Result<Option<EntryMetadata>, MetadataFailure> {
    let Some(file) = open(parent, component)? else {
        return Ok(None);
    };
    let value = metadata_file(&file)?;
    exact_name(&file, component)?;
    Ok(Some(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn metadata_handle_cannot_read_body_and_observation_retains_full_identity() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("package.json");
        std::fs::write(&path, "PRIVATE_CONTROLLED_CONTENT").unwrap();
        let parent = PinnedPath::directory(root.path()).unwrap();
        let first = metadata_child(parent.file(), OsStr::new("package.json"))
            .unwrap()
            .unwrap();
        assert_eq!(first.kind, MetadataKind::File);
        let mut file = open(parent.file(), OsStr::new("package.json"))
            .unwrap()
            .unwrap();
        assert_eq!(
            file.read(&mut [0u8; 1]).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        drop(file);
        std::fs::rename(&path, root.path().join("previous")).unwrap();
        std::fs::write(&path, "PRIVATE_CONTROLLED_CONTENT").unwrap();
        let second = metadata_child(parent.file(), OsStr::new("package.json"))
            .unwrap()
            .unwrap();
        assert_eq!(first.size, second.size);
        assert_ne!(first.identity, second.identity);
        assert_ne!(first, second);
    }

    #[test]
    fn only_a_proven_missing_child_is_none_and_non_leaf_names_are_errors() {
        let root = tempfile::tempdir().unwrap();
        let parent = PinnedPath::directory(root.path()).unwrap();
        assert!(
            metadata_child(parent.file(), OsStr::new("package.json"))
                .unwrap()
                .is_none()
        );
        for name in ["../package.json", "a/b", "a\\b", "C:package.json", "NUL"] {
            let failure = metadata_child(parent.file(), OsStr::new(name)).unwrap_err();
            assert_eq!(failure.phase, "name");
            assert_eq!(failure.kind, io::ErrorKind::InvalidInput);
        }
        std::fs::create_dir(root.path().join("node_modules")).unwrap();
        assert_eq!(
            metadata_child(parent.file(), OsStr::new("node_modules"))
                .unwrap()
                .unwrap()
                .kind,
            MetadataKind::Directory
        );
    }
}
#[cfg(test)]
#[path = "ci5_native_phase_tests.rs"]
mod ci5_native_phase_tests;

#[cfg(test)]
#[path = "rename_publication_diagnostics.rs"]
mod rename_publication_diagnostics;
