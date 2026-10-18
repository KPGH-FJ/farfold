//! Handle-relative Windows filesystem operations. No pathname-only safety fallback.
use super::{Identity, Stamp};
use std::{
    ffi::OsStr,
    fs::File,
    io,
    mem::{offset_of, size_of},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::{Component, Path, Prefix},
    ptr,
    sync::atomic::{AtomicU64, Ordering},
};
use windows_sys::{
    Wdk::{
        Foundation::OBJECT_ATTRIBUTES,
        Storage::FileSystem::{
            FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN,
            FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT, NtCreateFile,
        },
    },
    Win32::{
        Foundation::{
            HANDLE, INVALID_HANDLE_VALUE, OBJ_CASE_INSENSITIVE, RtlNtStatusToDosError,
            UNICODE_STRING,
        },
        Globalization::{CSTR_EQUAL, CompareStringOrdinal},
        Storage::FileSystem::*,
        System::IO::IO_STATUS_BLOCK,
    },
};
mod pinned;
pub(crate) use pinned::PinnedPath;
#[cfg(test)]
mod pinned_tests;

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "invalid local file path")
}
fn denied() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "unsupported file object")
}
fn handle(file: &File) -> HANDLE {
    file.as_raw_handle()
}
fn name(name: &OsStr) -> io::Result<Vec<u16>> {
    let text = name.to_str().ok_or_else(invalid)?;
    if text.is_empty()
        || text.ends_with(['.', ' '])
        || text.chars().any(|c| {
            c.is_control() || matches!(c, ':' | '/' | '\\' | '?' | '*' | '"' | '<' | '>' | '|')
        })
    {
        return Err(invalid());
    }
    let stem = text
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM¹"
            | "COM²"
            | "COM³"
            | "LPT¹"
            | "LPT²"
            | "LPT³"
            | "CONIN$"
            | "CONOUT$"
    ) || (stem.len() == 4
        && (stem.starts_with("COM") || stem.starts_with("LPT"))
        && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        return Err(invalid());
    }
    let encoded: Vec<_> = name.encode_wide().collect();
    if encoded.len() > 255 || encoded.contains(&0) {
        return Err(invalid());
    }
    Ok(encoded)
}

pub(crate) fn absolute(path: &Path) -> io::Result<()> {
    if !path.is_absolute() {
        return Err(invalid());
    }
    let mut parts = path.components();
    if !matches!(parts.next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
        || !matches!(parts.next(), Some(Component::RootDir))
    {
        return Err(invalid());
    }
    for part in parts {
        match part {
            Component::Normal(value) => {
                name(value)?;
            }
            _ => return Err(invalid()),
        }
    }
    Ok(())
}

fn info<T: Default>(file: &File, class: FILE_INFO_BY_HANDLE_CLASS) -> io::Result<T> {
    let mut result = T::default();
    // SAFETY: result has the exact documented layout selected at each call site.
    if unsafe {
        GetFileInformationByHandleEx(
            handle(file),
            class,
            (&mut result as *mut T).cast(),
            size_of::<T>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(result)
}
pub(crate) fn stamp(file: &File) -> io::Result<Stamp> {
    if unsafe { GetFileType(handle(file)) } != FILE_TYPE_DISK {
        return Err(denied());
    }
    let id: FILE_ID_INFO = info(file, FileIdInfo)?;
    let basic: FILE_BASIC_INFO = info(file, FileBasicInfo)?;
    let standard: FILE_STANDARD_INFO = info(file, FileStandardInfo)?;
    if basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || standard.DeletePending
        || standard.EndOfFile < 0
    {
        return Err(denied());
    }
    Ok(Stamp {
        identity: Identity {
            device: id.VolumeSerialNumber,
            inode: u128::from_le_bytes(id.FileId.Identifier),
        },
        size: standard.EndOfFile as u64,
        modified: (
            basic.LastWriteTime / 10_000_000,
            (basic.LastWriteTime % 10_000_000) * 100,
        ),
        changed: (
            basic.ChangeTime / 10_000_000,
            (basic.ChangeTime % 10_000_000) * 100,
        ),
        links: standard.NumberOfLinks as u64,
        regular: !standard.Directory,
    })
}
fn open_at(parent: &File, component: &OsStr, directory: bool, create: bool) -> io::Result<File> {
    open_at_shared(
        parent,
        component,
        directory,
        create,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    )
}
fn open_at_shared(
    parent: &File,
    component: &OsStr,
    directory: bool,
    create: bool,
    share: u32,
) -> io::Result<File> {
    let mut encoded = name(component)?;
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
    let access = FILE_GENERIC_READ
        | if create {
            FILE_GENERIC_WRITE | DELETE
        } else {
            0
        };
    // SAFETY: every component is a single validated filename relative to a held
    // directory handle; native open refuses reparse traversal before returning.
    let code = unsafe {
        NtCreateFile(
            &mut result,
            access,
            &object,
            &mut status,
            ptr::null(),
            FILE_ATTRIBUTE_NORMAL,
            share,
            if create { FILE_CREATE } else { FILE_OPEN },
            FILE_OPEN_REPARSE_POINT
                | FILE_SYNCHRONOUS_IO_NONALERT
                | if directory {
                    FILE_DIRECTORY_FILE
                } else {
                    FILE_NON_DIRECTORY_FILE
                },
            ptr::null(),
            0,
        )
    };
    if code < 0 {
        return Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(code) } as i32,
        ));
    }
    // SAFETY: successful NtCreateFile returns one owned kernel handle.
    let file = unsafe { File::from_raw_handle(result) };
    let current = stamp(&file)?;
    // A legal-looking 8.3 (or explicitly assigned short) alias must not bypass
    // the preview's protected filename policy. Compare the actual normalized
    // final component, obtained from this very handle, before returning it.
    let mut length = unsafe {
        GetFinalPathNameByHandleW(
            handle(&file),
            ptr::null_mut(),
            0,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    };
    if length == 0 || length > 32768 {
        return Err(denied());
    }
    let mut resolved = vec![0u16; length as usize + 1];
    length = unsafe {
        GetFinalPathNameByHandleW(
            handle(&file),
            resolved.as_mut_ptr(),
            resolved.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    };
    if length == 0 || length as usize >= resolved.len() {
        return Err(denied());
    }
    let actual = resolved[..length as usize]
        .rsplit(|c| *c == u16::from(b'\\') || *c == u16::from(b'/'))
        .next()
        .ok_or_else(denied)?;
    // Use the OS ordinal uppercase table, not ASCII-only case folding. The
    // handle's normalized long name must still match; short aliases are denied.
    if unsafe {
        CompareStringOrdinal(
            actual.as_ptr(),
            actual.len() as i32,
            encoded.as_ptr(),
            encoded.len() as i32,
            1,
        )
    } != CSTR_EQUAL
    {
        return Err(denied());
    }
    if current.regular == directory {
        return Err(denied());
    }
    Ok(file)
}
pub(crate) fn open_directory(path: &Path) -> io::Result<File> {
    absolute(path)?;
    let mut parts = path.components();
    let Component::Prefix(prefix) = parts.next().ok_or_else(invalid)? else {
        return Err(invalid());
    };
    let drive = match prefix.kind() {
        Prefix::Disk(d) | Prefix::VerbatimDisk(d) => d,
        _ => return Err(invalid()),
    };
    let root: Vec<u16> = format!("\\\\?\\{}:\\", drive as char)
        .encode_utf16()
        .chain(Some(0))
        .collect();
    // SAFETY: a validated local volume root and NUL-terminated UTF-16 path.
    let result = unsafe {
        CreateFileW(
            root.as_ptr(),
            FILE_GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            ptr::null_mut(),
        )
    };
    if result == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let mut directory = unsafe { File::from_raw_handle(result) };
    if stamp(&directory)?.regular {
        return Err(denied());
    }
    for component in parts {
        match component {
            Component::RootDir => {}
            Component::Normal(part) => directory = open_at(&directory, part, true, false)?,
            _ => return Err(invalid()),
        }
    }
    Ok(directory)
}
pub(crate) fn open_relative(root: &File, relative: &Path) -> io::Result<File> {
    let mut parts = relative.components().peekable();
    let mut directory = root.try_clone()?;
    loop {
        let Component::Normal(part) = parts.next().ok_or_else(invalid)? else {
            return Err(invalid());
        };
        let last = parts.peek().is_none();
        let next = open_at(&directory, part, !last, false)?;
        if last {
            return Ok(next);
        }
        directory = next;
    }
}

static SEQUENCE: AtomicU64 = AtomicU64::new(1);
pub(crate) struct TemporaryExport {
    pub directory: File,
    pub file: File,
    published: bool,
}
impl TemporaryExport {
    pub fn create(directory: File) -> io::Result<Self> {
        for _ in 0..16 {
            let filename = format!(
                ".farfold-export-{}-{}.tmp",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            );
            match open_at(&directory, OsStr::new(&filename), false, true) {
                Ok(file) => {
                    return Ok(Self {
                        directory,
                        file,
                        published: false,
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "temporary name unavailable",
        ))
    }
    pub fn publish(&mut self, destination: &OsStr) -> io::Result<()> {
        let destination = name(destination)?;
        let count = offset_of!(FILE_RENAME_INFO, FileName) + destination.len() * 2;
        // usize storage gives FILE_RENAME_INFO its required pointer alignment.
        let mut allocation = vec![0usize; count.div_ceil(size_of::<usize>())];
        let rename = allocation.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        unsafe {
            (*rename).RootDirectory = handle(&self.directory);
            (*rename).FileNameLength = (destination.len() * 2) as u32;
            // The zeroed union means ReplaceIfExists=false. Never retry with replacement.
            ptr::copy_nonoverlapping(
                destination.as_ptr(),
                (*rename).FileName.as_mut_ptr(),
                destination.len(),
            );
            if SetFileInformationByHandle(
                handle(&self.file),
                FileRenameInfo,
                rename.cast(),
                count as u32,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        self.published = true;
        Ok(())
    }
    pub fn discard(&mut self) -> io::Result<()> {
        if self.published {
            return Err(invalid());
        }
        self.published = true;
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        if unsafe {
            SetFileInformationByHandle(
                handle(&self.file),
                FileDispositionInfo,
                (&disposition as *const FILE_DISPOSITION_INFO).cast(),
                size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    pub fn retain_unknown(&mut self) {
        self.published = true;
    }
}
impl Drop for TemporaryExport {
    fn drop(&mut self) {
        if !self.published {
            // Delete only the exact temporary object we own, even if its parent
            // was replaced or renamed. A failed delete is never widened to a path sweep.
            let _ = self.discard();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn held_handles_accept_unicode_case_variants() {
        use std::io::Read;
        let fixture = tempfile::tempdir().unwrap();
        std::fs::create_dir(fixture.path().join("Étage")).unwrap();
        std::fs::write(fixture.path().join("Étage/Évidence.txt"), b"document").unwrap();
        let directory = open_directory(&fixture.path().join("étage")).unwrap();
        let mut file = open_relative(&directory, Path::new("évidence.txt")).unwrap();
        let mut body = String::new();
        file.read_to_string(&mut body).unwrap();
        assert_eq!(body, "document");
    }
    #[test]
    fn reserved_shell_names_and_alternate_streams_are_rejected() {
        for value in [
            "CON",
            "nul.txt",
            "COM1.png",
            "com¹.txt",
            "COM²",
            "lpt³.pdf",
            "CONIN$",
            "file.txt:secret",
            "name.",
            "name ",
        ] {
            assert!(name(OsStr::new(value)).is_err(), "{value}");
        }
        assert!(name(OsStr::new("report 1.txt")).is_ok());
    }
}
