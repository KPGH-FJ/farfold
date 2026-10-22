//! Bounded handle-relative inventory, including ignored/untracked files. No
//! traversal through symlinks, no helper programs, and no content in metadata.
use super::{
    recycle_types::MaterialSummary,
    types::{Result, error},
};
#[cfg(unix)]
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::{
    fd::{AsRawFd, FromRawFd},
    unix::fs::MetadataExt,
};
#[cfg(unix)]
use std::{ffi::CString, fs::File, io::Read, sync::atomic::Ordering};
use std::{path::Path, sync::atomic::AtomicBool};

#[cfg(unix)]
const MAX_ENTRIES: u64 = 100_000;
#[cfg(unix)]
const MAX_BYTES: u64 = 1024 * 1024 * 1024;
#[cfg(unix)]
const MAX_FILE: u64 = 256 * 1024 * 1024;
pub(super) fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}
#[cfg(unix)]
struct Scan {
    hash: Sha256,
    entries: ListingBudget,
    bytes: u64,
    content_only: bool,
}
#[cfg(unix)]
impl Scan {
    fn field(&mut self, raw: &[u8]) {
        self.hash.update((raw.len() as u64).to_le_bytes());
        self.hash.update(raw);
    }
}
#[cfg(unix)]
fn names(dir: &File, remaining: u64, cancel: &AtomicBool) -> Result<Vec<Vec<u8>>> {
    if cancel.load(Ordering::SeqCst) {
        return Err(error("cancelled"));
    }
    // O_SEARCH descriptors cannot enumerate; reopen exactly this held directory.
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            c".".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(error("unavailable"));
    }
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        unsafe { libc::close(fd) };
        return Err(error("unavailable"));
    }
    struct Entries(*mut libc::DIR);
    impl Drop for Entries {
        fn drop(&mut self) {
            unsafe {
                libc::closedir(self.0);
            }
        }
    }
    let stream = Entries(stream);
    let mut result = Vec::new();
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(error("cancelled"));
        }
        #[cfg(target_os = "macos")]
        unsafe {
            *libc::__error() = 0;
        }
        #[cfg(not(target_os = "macos"))]
        unsafe {
            *libc::__errno_location() = 0;
        }
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            if std::io::Error::last_os_error().raw_os_error() != Some(0) {
                return Err(error("unavailable"));
            }
            break;
        }
        let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if name == b"." || name == b".." {
            continue;
        }
        if name.is_empty() || name.contains(&b'/') || name.len() > 255 {
            return Err(error("unsafePath"));
        }
        // Refuse before retaining another name; dot entries never consume
        // capacity, but the linked root .git pointer keeps its historical count.
        if u64::try_from(result.len()).map_err(|_| error("materialLimit"))? >= remaining {
            return Err(error("materialLimit"));
        }
        result.push(name.to_vec());
    }
    result.sort();
    Ok(result)
}
#[cfg(unix)]
fn metadata(parent: &File, name: &CString) -> Result<libc::stat> {
    let mut meta = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            meta.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(error("materialChanged"));
    }
    Ok(unsafe { meta.assume_init() })
}
#[cfg(unix)]
fn walk(
    scan: &mut Scan,
    dir: &File,
    prefix: &[u8],
    depth: usize,
    cancel: &AtomicBool,
) -> Result<()> {
    if depth > 64 {
        return Err(error("materialLimit"));
    }
    let before = crate::file_access::stamp(dir).map_err(|_| error("unavailable"))?;
    // Ancestor name vectors remain live while a first child is traversed.
    // Reserve every returned name before any descendant or content processing.
    let (children, _) = scan.entries.collect(
        cancel,
        |remaining| names(dir, remaining, cancel),
        |children| children.len(),
    )?;
    if depth > 0
        && (children.iter().any(|n| n == b".git")
            || (children.iter().any(|n| n == b"HEAD")
                && children.iter().any(|n| n == b"objects")
                && children.iter().any(|n| n == b"refs")))
    {
        return Err(error("nestedRepository"));
    }
    for raw in children {
        if cancel.load(Ordering::SeqCst) {
            return Err(error("cancelled"));
        }
        let name = CString::new(raw.as_slice()).map_err(|_| error("unsafePath"))?;
        let meta = metadata(dir, &name)?;
        if depth == 0 && raw == b".git" {
            if meta.st_mode & libc::S_IFMT != libc::S_IFREG
                && !(scan.content_only && meta.st_mode & libc::S_IFMT == libc::S_IFDIR)
            {
                return Err(error("notLinked"));
            }
            continue; // Git itself updates this pointer on move; exact gitDir is separately checked.
        }
        if raw == b".gitmodules" {
            return Err(error("submodules"));
        }
        let mut relative = prefix.to_vec();
        if !relative.is_empty() {
            relative.push(b'/');
        }
        relative.extend(&raw);
        scan.field(&relative);
        if scan.content_only {
            let kind = meta.st_mode & libc::S_IFMT;
            let mode = kind
                | if kind == libc::S_IFREG {
                    meta.st_mode & 0o111
                } else {
                    0
                };
            scan.field(&(mode as u32).to_le_bytes());
        } else {
            scan.field(&(meta.st_mode as u32).to_le_bytes());
            scan.field(&(meta.st_dev as u64).to_le_bytes());
            scan.field(&meta.st_ino.to_le_bytes());
        }
        match meta.st_mode & libc::S_IFMT {
            libc::S_IFDIR | libc::S_IFREG => {
                let directory = meta.st_mode & libc::S_IFMT == libc::S_IFDIR;
                let fd = unsafe {
                    libc::openat(
                        dir.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY
                            | libc::O_NOFOLLOW
                            | libc::O_CLOEXEC
                            | libc::O_NONBLOCK
                            | if directory { libc::O_DIRECTORY } else { 0 },
                    )
                };
                if fd < 0 {
                    return Err(error("unavailable"));
                }
                let mut file = unsafe { File::from_raw_fd(fd) };
                let opened = file.metadata().map_err(|_| error("unavailable"))?;
                if opened.dev() != meta.st_dev as u64
                    || opened.ino() != meta.st_ino
                    || opened.mode() != meta.st_mode as u32
                {
                    return Err(error("materialChanged"));
                }
                if directory {
                    walk(scan, &file, &relative, depth + 1, cancel)?;
                } else {
                    let stamp =
                        crate::file_access::stamp(&file).map_err(|_| error("unavailable"))?;
                    if stamp.size > MAX_FILE {
                        return Err(error("materialLimit"));
                    }
                    scan.bytes = scan
                        .bytes
                        .checked_add(stamp.size)
                        .ok_or(error("materialLimit"))?;
                    if scan.bytes > MAX_BYTES {
                        return Err(error("materialLimit"));
                    }
                    let mut hash = Sha256::new();
                    let mut bytes = 0u64;
                    let mut buffer = [0u8; 65536];
                    loop {
                        if cancel.load(Ordering::SeqCst) {
                            return Err(error("cancelled"));
                        }
                        let n = file.read(&mut buffer).map_err(|_| error("unavailable"))?;
                        if n == 0 {
                            break;
                        }
                        bytes += n as u64;
                        if bytes > stamp.size {
                            return Err(error("materialChanged"));
                        }
                        hash.update(&buffer[..n]);
                    }
                    if bytes != stamp.size
                        || crate::file_access::stamp(&file).map_err(|_| error("unavailable"))?
                            != stamp
                    {
                        return Err(error("materialChanged"));
                    }
                    scan.field(&hash.finalize());
                }
                let after = metadata(dir, &name)?;
                if after.st_dev != meta.st_dev
                    || after.st_ino != meta.st_ino
                    || after.st_mode != meta.st_mode
                {
                    return Err(error("materialChanged"));
                }
            }
            libc::S_IFLNK => {
                let mut target = [0u8; 4097];
                let n = unsafe {
                    libc::readlinkat(
                        dir.as_raw_fd(),
                        name.as_ptr(),
                        target.as_mut_ptr().cast(),
                        target.len(),
                    )
                };
                if n < 0 || n as usize >= target.len() {
                    return Err(error("unavailable"));
                }
                scan.field(&target[..n as usize]);
                let after = metadata(dir, &name)?;
                if after.st_dev != meta.st_dev
                    || after.st_ino != meta.st_ino
                    || after.st_size != meta.st_size
                {
                    return Err(error("materialChanged"));
                }
            }
            _ => return Err(error("specialFile")),
        }
    }
    if crate::file_access::stamp(dir).map_err(|_| error("unavailable"))? != before {
        return Err(error("materialChanged"));
    }
    Ok(())
}
// Counts every first complete listing before descendants can be queried.
// The lifetime of a returned map is not a memory/RSS measurement. The first
// maps have at most limit entries in aggregate; a recheck may add another map
// bounded by that level's original query capacity, plus bounded parser pages.
#[cfg(any(unix, windows, test))]
struct ListingBudget {
    limit: u64,
    reserved: u64,
}
#[cfg(any(unix, windows, test))]
impl ListingBudget {
    fn new(limit: u64) -> Self {
        Self { limit, reserved: 0 }
    }
    fn remaining(&self) -> u64 {
        self.limit - self.reserved
    }
    fn reserve(&mut self, entries: usize) -> Result<()> {
        let entries = u64::try_from(entries).map_err(|_| error("materialLimit"))?;
        let next = self
            .reserved
            .checked_add(entries)
            .ok_or(error("materialLimit"))?;
        if next > self.limit {
            return Err(error("materialLimit"));
        }
        self.reserved = next;
        Ok(())
    }
    fn collect<T>(
        &mut self,
        cancel: &AtomicBool,
        query: impl FnOnce(u64) -> Result<T>,
        len: impl FnOnce(&T) -> usize,
    ) -> Result<(T, u64)> {
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(error("cancelled"));
        }
        let capacity = self.remaining();
        let listed = query(capacity)?;
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(error("cancelled"));
        }
        self.reserve(len(&listed))?;
        Ok((listed, capacity))
    }
}
#[cfg(any(windows, test))]
#[path = "material_links.rs"]
mod links;
#[cfg(windows)]
#[path = "material_windows.rs"]
mod windows;
#[cfg(not(windows))]
pub(super) fn capture(root: &Path, cancel: &AtomicBool) -> Result<MaterialSummary> {
    scan(root, cancel, false)
}
#[cfg(all(windows, test))]
pub(super) fn capture(root: &Path, cancel: &AtomicBool) -> Result<MaterialSummary> {
    super::material_owner::Owner::default().capture(root, cancel)
}
#[cfg(all(windows, test))]
pub(super) fn capture_owned(
    root: &Path,
    cancel: &AtomicBool,
    retired: &mut Option<crate::file_access::RetiredBackup>,
) -> Result<MaterialSummary> {
    windows::capture(root, cancel, retired)
}
#[cfg(windows)]
pub(super) fn capture_archive_owned(
    root: &Path,
    expected: &super::inspect::Stamp,
    cancel: &AtomicBool,
    retired: &mut Option<crate::file_access::RetiredBackup>,
) -> Result<MaterialSummary> {
    windows::capture_archive(root, expected, cancel, retired)
}
#[cfg(windows)]
pub(super) fn capture_archive_pin_owned(
    root: crate::file_access::PinnedPath,
    cancel: &AtomicBool,
    retired: &mut Option<crate::file_access::RetiredBackup>,
) -> Result<(crate::file_access::PinnedPath, MaterialSummary)> {
    windows::capture_archive_pin(root, cancel, retired)
}
#[cfg(windows)]
pub(super) fn capture_security_complete_owned(
    root: &Path,
    expected: &super::inspect::Stamp,
    cancel: &AtomicBool,
    retired: &mut Option<crate::file_access::RetiredBackup>,
) -> Result<MaterialSummary> {
    windows::capture_security_complete(root, expected, cancel, retired)
}
#[cfg(windows)]
pub(super) fn capture_security_complete_pin_owned(
    root: crate::file_access::PinnedPath,
    cancel: &AtomicBool,
    retired: &mut Option<crate::file_access::RetiredBackup>,
) -> Result<(crate::file_access::PinnedPath, MaterialSummary)> {
    windows::capture_security_complete_pin(root, cancel, retired)
}
#[cfg(any(unix, test))]
pub(super) fn content(root: &Path, cancel: &AtomicBool) -> Result<MaterialSummary> {
    scan(root, cancel, true)
}
#[cfg(any(unix, test))]
fn scan(root: &Path, cancel: &AtomicBool, content_only: bool) -> Result<MaterialSummary> {
    #[cfg(not(unix))]
    {
        let _ = (root, cancel, content_only);
        Err(error("unsupportedGit"))
    }
    #[cfg(unix)]
    {
        let dir = crate::file_access::open_directory(root).map_err(|_| error("unsafePath"))?;
        let mut scan = Scan {
            hash: Sha256::new(),
            entries: ListingBudget::new(MAX_ENTRIES),
            bytes: 0,
            content_only,
        };
        if !content_only {
            scan.field(
                &dir.metadata()
                    .map_err(|_| error("unavailable"))?
                    .mode()
                    .to_le_bytes(),
            );
        }
        walk(&mut scan, &dir, b"", 0, cancel)?;
        let fresh =
            crate::file_access::open_directory(root).map_err(|_| error("materialChanged"))?;
        if !crate::file_access::same_object(&dir, &fresh).map_err(|_| error("materialChanged"))? {
            return Err(error("materialChanged"));
        }
        Ok(MaterialSummary {
            profile: None,
            entries: scan.entries.reserved,
            bytes: scan.bytes,
            sha256: hex(scan.hash.finalize()),
        })
    }
}

#[cfg(test)]
#[path = "material_profile_tests.rs"]
mod profile_tests;
