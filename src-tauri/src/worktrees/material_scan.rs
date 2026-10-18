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
    entries: u64,
    bytes: u64,
    content_only: bool,
}
#[cfg(unix)]
impl Scan {
    fn field(&mut self, raw: &[u8]) {
        self.hash.update((raw.len() as u64).to_le_bytes());
        self.hash.update(raw);
    }
    fn count(&mut self, cancel: &AtomicBool) -> Result<()> {
        if cancel.load(Ordering::SeqCst) {
            return Err(error("cancelled"));
        }
        self.entries += 1;
        if self.entries > MAX_ENTRIES {
            return Err(error("materialLimit"));
        }
        Ok(())
    }
}
#[cfg(unix)]
fn names(dir: &File) -> Result<Vec<Vec<u8>>> {
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
        result.push(name.to_vec());
        if result.len() as u64 > MAX_ENTRIES {
            return Err(error("materialLimit"));
        }
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
    let children = names(dir)?;
    if depth > 0
        && (children.iter().any(|n| n == b".git")
            || (children.iter().any(|n| n == b"HEAD")
                && children.iter().any(|n| n == b"objects")
                && children.iter().any(|n| n == b"refs")))
    {
        return Err(error("nestedRepository"));
    }
    for raw in children {
        scan.count(cancel)?;
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
pub(super) fn capture(root: &Path, cancel: &AtomicBool) -> Result<MaterialSummary> {
    scan(root, cancel, false)
}
pub(super) fn content(root: &Path, cancel: &AtomicBool) -> Result<MaterialSummary> {
    scan(root, cancel, true)
}
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
            entries: 0,
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
            entries: scan.entries,
            bytes: scan.bytes,
            sha256: hex(scan.hash.finalize()),
        })
    }
}
