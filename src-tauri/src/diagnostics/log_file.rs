//! A directory entry may change between enumeration and open. Never follow a
//! replacement link or wait on a pipe; only a regular file may reach the parser.
use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;

pub(super) fn open_log(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT: inspect the entry, never its target.
        options.custom_flags(0x0020_0000);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        }
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_regular_files_can_enter_diagnostics() {
        let dir = tempfile::tempdir().unwrap();
        assert!(open_log(dir.path()).is_err());
        let path = dir.path().join("protocol-v1-fixture.jsonl");
        std::fs::write(&path, "fixture").unwrap();
        assert_eq!(open_log(&path).unwrap().metadata().unwrap().len(), 7);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_link_or_pipe_swapped_after_directory_enumeration() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("protocol-v1-fixture.jsonl");
        let target = dir.path().join("private-fixture");
        std::fs::write(&path, "listed earlier").unwrap();
        std::fs::write(&target, "not a log").unwrap();
        let listed = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .find(|entry| entry.path() == path)
            .unwrap();
        assert!(listed.file_type().unwrap().is_file());
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        assert!(open_log(&listed.path()).is_err());
        std::fs::remove_file(&path).unwrap();
        let name = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(open_log(&listed.path()).is_err());
    }
}
