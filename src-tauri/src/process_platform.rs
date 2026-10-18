//! Platform launch/pipe mechanics shared by official process entrypoints.
use std::io::{self, Read};
#[cfg(unix)]
use std::process::Command;

#[cfg(unix)]
pub(crate) struct PendingGroup;
#[cfg(unix)]
pub(crate) struct OwnedGroup;
#[cfg(windows)]
pub(crate) use crate::windows_process::OwnedGroup;

#[cfg(unix)]
impl PendingGroup {
    pub(crate) fn attach_or_reap(
        &self,
        _pid: Option<u32>,
        _reap: impl FnMut() -> bool,
    ) -> io::Result<OwnedGroup> {
        Ok(OwnedGroup)
    }
}
#[cfg(unix)]
pub(crate) fn prepare_command(command: &mut Command) -> io::Result<PendingGroup> {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
    Ok(PendingGroup)
}
#[cfg(windows)]
pub(crate) use crate::windows_process::prepare_command;

/// A single-owner pipe reader with bounded polling on both platforms. Peek is
/// used only for this pipe, never a named resource supplied by an Agent.
pub(crate) struct PipeReader<R>(R);
#[cfg(unix)]
impl<R: Read + std::os::fd::AsRawFd> PipeReader<R> {
    pub(crate) fn new(reader: R) -> io::Result<Self> {
        let fd = reader.as_raw_fd();
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(reader))
    }
}
#[cfg(unix)]
impl<R: Read> Read for PipeReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.0.read(buffer)
    }
}
#[cfg(windows)]
impl<R: Read + std::os::windows::io::AsRawHandle> PipeReader<R> {
    pub(crate) fn new(reader: R) -> io::Result<Self> {
        Ok(Self(reader))
    }
}
#[cfg(windows)]
impl<R: Read + std::os::windows::io::AsRawHandle> Read for PipeReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        use windows_sys::Win32::Foundation::{ERROR_BROKEN_PIPE, GetLastError};
        use windows_sys::Win32::System::Pipes::PeekNamedPipe;
        if buffer.is_empty() {
            return Ok(0);
        }
        let mut available = 0u32;
        let ok = unsafe {
            PeekNamedPipe(
                self.0.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return if unsafe { GetLastError() } == ERROR_BROKEN_PIPE {
                Ok(0)
            } else {
                Err(io::Error::last_os_error())
            };
        }
        if available == 0 {
            return Err(io::ErrorKind::WouldBlock.into());
        }
        let count = buffer.len().min(available as usize);
        self.0.read(&mut buffer[..count])
    }
}

pub(crate) fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(std::path::PathBuf::from)
}

/// Windows executable suffixes are launch syntax, not distinct Agent identities.
pub(crate) fn program_name(path: &std::path::Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    #[cfg(unix)]
    {
        Some(name.to_owned())
    }
    #[cfg(windows)]
    {
        let name = name.to_ascii_lowercase();
        Some(
            [".exe", ".com", ".cmd", ".bat"]
                .iter()
                .find_map(|suffix| name.strip_suffix(suffix))
                .unwrap_or(&name)
                .to_owned(),
        )
    }
}

pub(crate) fn executable(path: &std::path::Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(windows)]
    {
        path.extension()
            .and_then(std::ffi::OsStr::to_str)
            .is_some_and(|extension| {
                ["exe", "com", "cmd", "bat"]
                    .iter()
                    .any(|allowed| extension.eq_ignore_ascii_case(allowed))
            })
    }
}
pub(crate) fn permissions_stamp(metadata: &std::fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode()
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes()
    }
}
pub(crate) fn set_executable(path: &std::path::Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
    }
    #[cfg(windows)]
    {
        if path.is_file() {
            Ok(())
        } else {
            Err(io::Error::other("程序文件不存在"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_directory_is_never_an_executable() {
        let directory = tempfile::tempdir().unwrap();
        assert!(!executable(directory.path()));
    }
    #[cfg(windows)]
    #[test]
    fn windows_executables_require_a_directly_supported_extension() {
        let directory = tempfile::tempdir().unwrap();
        for (name, expected) in [
            ("program.EXE", true),
            ("npm.cmd", true),
            ("launch.BAT", true),
            ("script.ps1", false),
            ("document.txt", false),
            ("program", false),
        ] {
            let file = directory.path().join(name);
            std::fs::write(&file, "fixture").unwrap();
            assert_eq!(executable(&file), expected, "{name}");
        }
    }
}
