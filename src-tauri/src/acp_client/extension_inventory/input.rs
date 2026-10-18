//! Fixed-exchange input only. No background writer and no outstanding OS write.
use super::{Code, Result};
use std::{
    io::{self, Write},
    process::{Child, Command, Stdio},
};

pub(super) struct Input {
    #[cfg(unix)]
    stream: std::process::ChildStdin,
    #[cfg(windows)]
    stream: std::fs::File,
}
impl Input {
    pub(super) fn configure(command: &mut Command, interactive: bool) -> Result<Option<Self>> {
        if !interactive {
            command.stdin(Stdio::null());
            return Ok(None);
        }
        #[cfg(unix)]
        {
            command.stdin(Stdio::piped());
            Ok(None)
        }
        #[cfg(windows)]
        {
            let (writer, reader) =
                crate::windows_pipe::stdin_pair().map_err(|_| Code::SpawnFailed)?;
            // ChildStdin::from(OwnedHandle) requires an asynchronous Windows
            // handle. Pass this synchronous blocking reader through Stdio/File.
            command.stdin(Stdio::from(reader));
            Ok(Some(Self { stream: writer }))
        }
    }
    #[cfg(unix)]
    pub(super) fn after_spawn(
        child: &mut Child,
        interactive: bool,
        input: &mut Option<Self>,
    ) -> Result<()> {
        use std::os::fd::AsRawFd;
        if interactive {
            let stream = child.stdin.take().ok_or(Code::SpawnFailed)?;
            let fd = stream.as_raw_fd();
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
            {
                return Err(Code::SpawnFailed.into());
            }
            *input = Some(Self { stream });
        }
        Ok(())
    }
    #[cfg(windows)]
    pub(super) fn after_spawn(
        _child: &mut Child,
        interactive: bool,
        input: &mut Option<Self>,
    ) -> Result<()> {
        if interactive && input.is_none() {
            return Err(Code::SpawnFailed.into());
        }
        Ok(())
    }
}
impl Write for Input {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        // One stdin attempt per owner-loop turn, matching each output quantum.
        let bytes = &bytes[..bytes.len().min(8192)];
        #[cfg(unix)]
        {
            self.stream.write(bytes)
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            crate::windows_pipe::write_handle(self.stream.as_raw_handle(), bytes)
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
