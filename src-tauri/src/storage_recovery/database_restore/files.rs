//! Bounded, no-follow material reads and the platform's no-replace file move.
use super::{Fact, Failure};
use crate::storage_recovery::{io_receipt, restore::candidate::read_file};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::Path,
};

pub(super) fn directory(path: &Path) -> Result<(), Failure> {
    let meta = path.symlink_metadata().map_err(storage)?;
    if !meta.is_dir()
        || meta.file_type().is_symlink()
        || path.canonicalize().map_err(storage)? != path
    {
        return Err(Failure::new("unsupported"));
    }
    Ok(())
}
pub(super) fn storage(error: std::io::Error) -> Failure {
    Failure::storage(io_receipt(error))
}
pub(super) fn exists(path: &Path) -> Result<bool, Failure> {
    match path.symlink_metadata() {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(storage(e)),
    }
}
pub(super) fn fact(path: &Path) -> Result<Fact, Failure> {
    let (bytes, digest) = read_file(path, None)?;
    Ok(Fact {
        bytes,
        sha256: digest.iter().map(|b| format!("{b:02x}")).collect(),
    })
}
pub(super) fn copy(source: &Path, destination: &Path) -> Result<Fact, Failure> {
    let mut target = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(storage)?;
    let (bytes, digest) = read_file(source, Some(&mut target))?;
    target.sync_all().map_err(storage)?;
    drop(target);
    let expected = Fact {
        bytes,
        sha256: digest.iter().map(|b| format!("{b:02x}")).collect(),
    };
    if fact(destination)? != expected || fact(source)? != expected {
        return Err(Failure::new("changed"));
    }
    Ok(expected)
}
pub(super) fn private_directory(path: &Path) -> Result<(), Failure> {
    std::fs::create_dir(path).map_err(storage)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(storage)?;
    }
    directory(path)
}
pub(super) fn small_file(path: &Path, limit: u64) -> Result<Vec<u8>, Failure> {
    let meta = path.symlink_metadata().map_err(storage)?;
    if !meta.is_file()
        || meta.file_type().is_symlink()
        || meta.len() > limit
        || path.canonicalize().map_err(storage)? != path
    {
        return Err(Failure::new("blocked"));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(storage)?;
    if !file.metadata().map_err(storage)?.is_file() {
        return Err(Failure::new("blocked"));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(storage)?;
    if bytes.len() as u64 > limit {
        return Err(Failure::new("blocked"));
    }
    Ok(bytes)
}

/// Filesystem durability is the injection boundary for temporary-database tests.
/// Tests implement failures here; production has no environment switches.
pub(super) trait FileOps {
    fn move_new(&self, source: &Path, destination: &Path) -> Result<(), Failure>;
    fn sync_directory(&self, path: &Path) -> Result<(), Failure>;
    fn save_record(&self, destination: &Path, bytes: &[u8], replace: bool) -> Result<(), Failure>;
}
pub(super) struct Native;
impl FileOps for Native {
    fn move_new(&self, source: &Path, destination: &Path) -> Result<(), Failure> {
        directory(source.parent().ok_or_else(|| Failure::new("blocked"))?)?;
        directory(
            destination
                .parent()
                .ok_or_else(|| Failure::new("blocked"))?,
        )?;
        if exists(destination)? {
            return Err(Failure::new("changed"));
        }
        #[cfg(target_os = "macos")]
        {
            use std::{ffi::CString, os::unix::ffi::OsStrExt};
            let source =
                CString::new(source.as_os_str().as_bytes()).map_err(|_| Failure::new("blocked"))?;
            let target = CString::new(destination.as_os_str().as_bytes())
                .map_err(|_| Failure::new("blocked"))?;
            if unsafe { libc::renamex_np(source.as_ptr(), target.as_ptr(), libc::RENAME_EXCL) } != 0
            {
                return Err(storage(std::io::Error::last_os_error()));
            }
            Ok(())
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(Failure::new("unsupported"))
        }
    }
    fn sync_directory(&self, path: &Path) -> Result<(), Failure> {
        directory(path)?;
        File::open(path)
            .and_then(|file| file.sync_all())
            .map_err(storage)
    }
    fn save_record(&self, destination: &Path, bytes: &[u8], replace: bool) -> Result<(), Failure> {
        let parent = destination
            .parent()
            .ok_or_else(|| Failure::new("blocked"))?;
        directory(parent)?;
        if replace {
            small_file(destination, 65536)?;
        } else if exists(destination)? {
            return Err(Failure::new("changed"));
        }
        let mut next = tempfile::NamedTempFile::new_in(parent).map_err(storage)?;
        next.write_all(bytes).map_err(storage)?;
        next.as_file().sync_all().map_err(storage)?;
        if replace {
            // Only a previously validated fixed record may be replaced.
            small_file(destination, 65536)?;
            next.persist(destination).map_err(|e| storage(e.error))?;
        } else {
            next.persist_noclobber(destination)
                .map_err(|e| storage(e.error))?;
        }
        self.sync_directory(parent)
    }
}
