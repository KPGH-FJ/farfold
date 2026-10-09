use super::{Identity, Stamp};
use std::{
    ffi::{CString, OsStr},
    fs::File,
    io,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Component, Path},
    sync::atomic::{AtomicU64, Ordering},
};
fn invalid() -> io::Error {
    io::Error::from(io::ErrorKind::InvalidInput)
}
fn name(value: &OsStr) -> io::Result<CString> {
    CString::new(value.as_bytes()).map_err(|_| invalid())
}
pub(crate) fn absolute(path: &Path) -> io::Result<()> {
    if !path.is_absolute() || path.as_os_str().as_bytes().contains(&0) {
        return Err(invalid());
    }
    Ok(())
}
pub(crate) fn stamp(file: &File) -> io::Result<Stamp> {
    let meta = file.metadata()?;
    Ok(Stamp {
        identity: Identity {
            device: meta.dev(),
            inode: meta.ino() as u128,
        },
        size: meta.len(),
        modified: (meta.mtime(), meta.mtime_nsec()),
        changed: (meta.ctime(), meta.ctime_nsec()),
        links: meta.nlink(),
        regular: meta.is_file(),
    })
}
const READ_DIRECTORY: libc::c_int = libc::O_RDONLY | libc::O_DIRECTORY;

#[cfg(target_os = "macos")]
fn directory_access_for_version(version: &[u8]) -> libc::c_int {
    let Ok(version) = std::ffi::CStr::from_bytes_with_nul(version) else {
        return READ_DIRECTORY;
    };
    let Ok(version) = version.to_str() else {
        return READ_DIRECTORY;
    };
    if !version
        .bytes()
        .all(|byte| byte.is_ascii_digit() || byte == b'.')
    {
        return READ_DIRECTORY;
    }
    let Ok(parts) = version
        .split('.')
        .map(str::parse::<u32>)
        .collect::<Result<Vec<_>, _>>()
    else {
        return READ_DIRECTORY;
    };
    // O_SEARCH/FSEARCH was added in macOS 13. Older or unknown versions keep
    // the existing directory-read requirement; never probe with unknown flags.
    if (2..=3).contains(&parts.len()) && parts[0] >= 13 {
        libc::O_SEARCH
    } else {
        READ_DIRECTORY
    }
}

fn directory_flags() -> libc::c_int {
    #[cfg(target_os = "macos")]
    let access = {
        static ACCESS: std::sync::OnceLock<libc::c_int> = std::sync::OnceLock::new();
        *ACCESS.get_or_init(|| {
            let mut version = [0u8; 48];
            let mut size = version.len();
            // SAFETY: fixed name, bounded writable buffer and size pointer;
            // null newp/zero newlen makes this a read-only system query.
            let result = unsafe {
                libc::sysctlbyname(
                    c"kern.osproductversion".as_ptr(),
                    version.as_mut_ptr().cast(),
                    &mut size,
                    std::ptr::null_mut(),
                    0,
                )
            };
            if result != 0 {
                return READ_DIRECTORY;
            }
            version
                .get(..size)
                .map_or(READ_DIRECTORY, directory_access_for_version)
        })
    };
    #[cfg(not(target_os = "macos"))]
    let access = READ_DIRECTORY;
    access | libc::O_NOFOLLOW | libc::O_CLOEXEC
}

fn open_at(parent: &File, value: &OsStr, directory: bool) -> io::Result<File> {
    let value = name(value)?;
    let flags = if directory {
        directory_flags()
    } else {
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK
    };
    // SAFETY: owned live directory and one terminated filename; the returned fd
    // has exactly one File owner. A replaced FIFO cannot block before fstat.
    let fd = unsafe { libc::openat(parent.as_raw_fd(), value.as_ptr(), flags) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
pub(crate) fn open_directory(path: &Path) -> io::Result<File> {
    absolute(path)?;
    // The filesystem root needs the same search/no-follow/close-on-exec
    // policy as every subsequent directory component.
    let fd = unsafe { libc::open(c"/".as_ptr(), directory_flags()) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful open returns an owned fd with exactly one File owner.
    let mut directory = unsafe { File::from_raw_fd(fd) };
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(value) => directory = open_at(&directory, value, true)?,
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
        let next = open_at(&directory, part, !last)?;
        if last {
            return Ok(next);
        }
        directory = next;
    }
}
static SEQUENCE: AtomicU64 = AtomicU64::new(1);
pub(crate) struct TemporaryExport {
    pub directory: File,
    name: CString,
    pub file: File,
    published: bool,
}
impl TemporaryExport {
    pub fn create(directory: File) -> io::Result<Self> {
        for _ in 0..16 {
            let name = CString::new(format!(
                ".farfold-export-{}-{}.tmp",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ))
            .map_err(|_| invalid())?;
            let fd = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o600,
                )
            };
            if fd >= 0 {
                return Ok(Self {
                    directory,
                    name,
                    file: unsafe { File::from_raw_fd(fd) },
                    published: false,
                });
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::AlreadyExists {
                return Err(error);
            }
        }
        Err(io::Error::from(io::ErrorKind::AlreadyExists))
    }
    pub fn publish(&mut self, destination: &OsStr) -> io::Result<()> {
        let destination = name(destination)?;
        // No replacement or copy fallback: an unsupported filesystem fails.
        let result = unsafe {
            libc::renameatx_np(
                self.directory.as_raw_fd(),
                self.name.as_ptr(),
                self.directory.as_raw_fd(),
                destination.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        self.published = true;
        Ok(())
    }
}
impl Drop for TemporaryExport {
    fn drop(&mut self) {
        if !self.published {
            unsafe {
                libc::unlinkat(self.directory.as_raw_fd(), self.name.as_ptr(), 0);
            }
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
#[path = "directory_search_tests.rs"]
mod directory_search_tests;
