use crate::browser_sharing::channel::{self, Stream};
use std::io;
pub(crate) fn prepare() -> io::Result<()> {
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
    Ok(())
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
pub(crate) fn read_stdin(bytes: &mut [u8]) -> io::Result<usize> {
    let n = unsafe { libc::read(0, bytes.as_mut_ptr().cast(), bytes.len()) };
    if n < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(n as usize)
    }
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
