use crate::browser_sharing::channel::{self, Stream};
use std::io;
pub(crate) struct Input;

pub(crate) fn prepare() -> io::Result<Input> {
    for fd in [0, 1] {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    // Public macOS fcntl.h, not exported by cached libc.
    if unsafe { libc::fcntl(1, 73, 1) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Input)
}
pub(crate) fn close_stdout() -> io::Result<()> {
    if unsafe { libc::close(1) } != 0
        && !((unsafe { libc::fcntl(1, libc::F_GETFD) }) == -1
            && io::Error::last_os_error().raw_os_error() == Some(libc::EBADF))
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
impl Input {
    pub(crate) fn read_into(&mut self, bytes: &mut Vec<u8>, limit: usize) -> io::Result<bool> {
        let mut buffer = [0_u8; 8192];
        let capacity = buffer.len().min(limit.saturating_sub(bytes.len()));
        if capacity == 0 {
            return Err(io::ErrorKind::WouldBlock.into());
        }
        let n = unsafe { libc::read(0, buffer.as_mut_ptr().cast(), capacity) };
        if n < 0 {
            return Err(io::Error::last_os_error());
        }
        bytes.extend_from_slice(&buffer[..n as usize]);
        Ok(n == 0)
    }
    pub(crate) fn pause(&mut self) -> io::Result<super::InputStop> {
        Ok(super::InputStop::Clear)
    }
    pub(crate) fn stop_state(&self) -> io::Result<super::InputStop> {
        Ok(super::InputStop::Clear)
    }
    pub(crate) fn resume(&mut self) -> io::Result<()> {
        Ok(())
    }
    pub(crate) fn retire(&mut self) {}
}
pub(crate) fn write_stdout(bytes: &[u8]) -> io::Result<usize> {
    let n = unsafe { libc::write(1, bytes.as_ptr().cast(), bytes.len()) };
    if n < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(n as usize)
    }
}
pub(crate) fn wait(
    stream: &Stream,
    controls: bool,
    stdin: bool,
    stdout: bool,
    millis: i32,
) -> io::Result<()> {
    let mut fds = [
        libc::pollfd {
            fd: channel::token(stream),
            events: libc::POLLIN | if controls { libc::POLLOUT } else { 0 },
            revents: 0,
        },
        libc::pollfd {
            fd: if stdin { 0 } else { -1 },
            events: libc::POLLIN,
            revents: 0,
        },
        libc::pollfd {
            fd: if stdout { 1 } else { -1 },
            events: libc::POLLOUT,
            revents: 0,
        },
    ];
    if unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, millis) } < 0
        && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
