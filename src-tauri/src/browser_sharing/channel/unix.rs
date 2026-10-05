use super::Endpoint;
use std::{
    io,
    mem::{self, size_of},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::{
            ffi::OsStrExt,
            fs::{FileTypeExt, MetadataExt, PermissionsExt},
            net::{UnixListener, UnixStream},
        },
    },
    path::Path,
    ptr,
    time::{Duration, Instant},
};
pub(crate) type Stream = UnixStream;
pub(crate) type Listener = UnixListener;
pub(crate) type Guard = tempfile::TempDir;
pub(crate) type Handle = RawFd;
pub(crate) const READ: i16 = libc::POLLIN;
pub(crate) const WRITE: i16 = libc::POLLOUT;
const TIMEOUT: Duration = Duration::from_secs(1);
pub(crate) fn token(stream: &Stream) -> Handle {
    stream.as_raw_fd()
}
pub(crate) fn listener_token(listener: &Listener) -> Handle {
    listener.as_raw_fd()
}
pub(crate) fn create() -> io::Result<Endpoint> {
    let guard = tempfile::Builder::new()
        .prefix("ff-page-")
        .tempdir_in("/tmp")?;
    std::fs::set_permissions(guard.path(), std::fs::Permissions::from_mode(0o700))?;
    let path = guard.path().join("mcp.sock");
    let listener = Listener::bind(&path)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    listener.set_nonblocking(true)?;
    let name = guard
        .path()
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?
        .replace('-', "_");
    Ok(Endpoint {
        guard,
        path,
        name,
        listener,
    })
}
pub(crate) fn read_nowait(stream: &Stream, bytes: &mut [u8]) -> io::Result<usize> {
    let n = unsafe {
        libc::recv(
            token(stream),
            bytes.as_mut_ptr().cast(),
            bytes.len(),
            libc::MSG_DONTWAIT,
        )
    };
    if n < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(n as usize)
    }
}
pub(crate) fn write_nowait(stream: &Stream, bytes: &[u8]) -> io::Result<usize> {
    let n = unsafe {
        libc::send(
            token(stream),
            bytes.as_ptr().cast(),
            bytes.len(),
            libc::MSG_DONTWAIT,
        )
    };
    if n < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(n as usize)
    }
}
pub(crate) fn poll_ready(fd: Handle, interests: i16) -> bool {
    let mut descriptor = libc::pollfd {
        fd,
        events: interests,
        revents: 0,
    };
    unsafe { libc::poll(&mut descriptor, 1, 0) > 0 }
}
pub(crate) fn wait_fd(fd: Handle, interests: i16, timeout: i32) {
    let mut descriptor = libc::pollfd {
        fd,
        events: interests,
        revents: 0,
    };
    unsafe {
        libc::poll(&mut descriptor, 1, timeout);
    }
}
fn set_nonblocking(fd: RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
pub(crate) fn connect(path: &Path) -> io::Result<UnixStream> {
    let bytes = path.as_os_str().as_bytes();
    let mut address: libc::sockaddr_un = unsafe { mem::zeroed() };
    if !path.is_absolute()
        || bytes.is_empty()
        || bytes.len() >= address.sun_path.len()
        || bytes.contains(&0)
    {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    let uid = unsafe { libc::getuid() };
    let metadata = std::fs::symlink_metadata(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
    let parent_metadata = std::fs::symlink_metadata(parent)?;
    if !metadata.file_type().is_socket()
        || metadata.uid() != uid
        || metadata.mode() & 0o7777 != 0o600
        || !parent_metadata.file_type().is_dir()
        || parent_metadata.uid() != uid
        || parent_metadata.mode() & 0o7777 != 0o700
    {
        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
    }
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    address.sun_len = size_of::<libc::sockaddr_un>() as u8;
    unsafe {
        ptr::copy_nonoverlapping(
            bytes.as_ptr(),
            address.sun_path.as_mut_ptr().cast(),
            bytes.len(),
        );
    }
    let raw = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if raw < 0 {
        return Err(io::Error::last_os_error());
    }
    let socket = unsafe { OwnedFd::from_raw_fd(raw) };
    let flags = unsafe { libc::fcntl(raw, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(raw, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    set_nonblocking(raw)?;
    let enabled: libc::c_int = 1;
    if unsafe {
        libc::setsockopt(
            raw,
            libc::SOL_SOCKET,
            libc::SO_NOSIGPIPE,
            (&enabled as *const libc::c_int).cast(),
            size_of::<libc::c_int>() as libc::socklen_t,
        )
    } < 0
    {
        return Err(io::Error::last_os_error());
    }
    let result = unsafe {
        libc::connect(
            raw,
            (&address as *const libc::sockaddr_un).cast(),
            size_of::<libc::sockaddr_un>() as libc::socklen_t,
        )
    };
    if result < 0 {
        let error = io::Error::last_os_error();
        if !matches!(
            error.raw_os_error(),
            Some(libc::EINPROGRESS | libc::EINTR | libc::EAGAIN)
        ) {
            return Err(error);
        }
        wait_ready(raw, libc::POLLOUT, Instant::now() + TIMEOUT)?;
        let mut error: libc::c_int = 0;
        let mut length = size_of::<libc::c_int>() as libc::socklen_t;
        if unsafe {
            libc::getsockopt(
                raw,
                libc::SOL_SOCKET,
                libc::SO_ERROR,
                (&mut error as *mut libc::c_int).cast(),
                &mut length,
            )
        } < 0
        {
            return Err(io::Error::last_os_error());
        }
        if length as usize != size_of::<libc::c_int>() || error != 0 {
            return Err(io::Error::from(io::ErrorKind::ConnectionRefused));
        }
    }
    let stream = UnixStream::from(socket);
    stream.peer_addr()?;
    let mut peer_uid: libc::uid_t = 0;
    let mut peer_gid: libc::gid_t = 0;
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut peer_uid, &mut peer_gid) } != 0
        || peer_uid != uid
    {
        return Err(io::Error::from(io::ErrorKind::PermissionDenied));
    }
    Ok(stream)
}
pub(crate) fn wait_ready(fd: RawFd, events: libc::c_short, deadline: Instant) -> io::Result<()> {
    loop {
        let left = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| io::Error::from(io::ErrorKind::TimedOut))?;
        let mut descriptor = libc::pollfd {
            fd,
            events,
            revents: 0,
        };
        let result = unsafe {
            libc::poll(
                &mut descriptor,
                1,
                (left.as_millis() + 1).min(i32::MAX as u128) as i32,
            )
        };
        if result < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if result > 0 {
            if descriptor.revents & libc::POLLNVAL != 0 {
                return Err(io::Error::from(io::ErrorKind::InvalidInput));
            }
            if descriptor.revents & (events | libc::POLLERR | libc::POLLHUP) != 0 {
                return Ok(());
            }
        }
    }
}
