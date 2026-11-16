//! macOS-only, audited rendezvous for a fresh private channel. The bootstrap
//! name is public metadata, never a credential or page permission. No stdin is
//! accepted here; the helper creates its reply receive right after exec.
use std::ffi::CString;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::net::UnixStream;
use std::time::Duration;

#[path = "mach_channel/ffi.rs"]
mod ffi;
#[path = "mach_channel/identity.rs"]
mod identity;
#[path = "mach_channel/message.rs"]
mod message;

const PREFIX: &str = "ai.farfold.browser.";
const HANDSHAKE_WAIT: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PeerIdentity {
    pub(crate) pid: u32,
    pub(crate) uid: u32,
    pub(crate) pid_version: i32,
}

pub(crate) struct Server {
    port: message::ReceivePort,
    name: String,
    pid: u32,
}

impl Server {
    pub(crate) fn bind() -> Result<Self, ()> {
        identity::ready()?;
        let mut nonce = [0_u8; 16];
        getrandom::fill(&mut nonce).map_err(|_| ())?;
        let name = format!(
            "{PREFIX}{}",
            nonce.iter().map(|b| format!("{b:02x}")).collect::<String>()
        );
        let port = message::ReceivePort::new()?;
        let c_name = CString::new(name.as_str()).map_err(|_| ())?;
        // This receive right owns only this random, transient service. Destroying
        // it on Drop makes old names dead; bootstrap_register(NULL) is not used.
        unsafe {
            if ffi::mach_port_insert_right(ffi::task(), port.raw(), port.raw(), ffi::MAKE_SEND) != 0
                || ffi::bootstrap_register(ffi::bootstrap_port, c_name.as_ptr(), port.raw()) != 0
            {
                return Err(());
            }
        }
        Ok(Self {
            port,
            name,
            pid: std::process::id(),
        })
    }

    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    pub(crate) fn broker_pid(&self) -> u32 {
        self.pid
    }

    /// The caller checks the actual Agent Child's birth, direct parent, native
    /// conversation and live controller. A rejected candidate does not retire
    /// the listener. `timeout` bounds receive; the reply send is separately bounded.
    pub(crate) fn accept(
        &self,
        authorize: &dyn Fn(PeerIdentity) -> bool,
        timeout: Duration,
    ) -> Result<Option<UnixStream>, ()> {
        let Some(mut request) = self.port.receive(timeout)? else {
            return Ok(None);
        };
        let Some(token) = request.request_token() else {
            return Ok(None);
        };
        let Ok(peer) = identity::authenticate(token) else {
            return Ok(None);
        };
        if !authorize(peer) {
            let _ = request.reply(None);
            return Ok(None);
        }
        // Never accept an FD or client-created socket as the private channel.
        let (local, remote) = UnixStream::pair().map_err(|_| ())?;
        cloexec(&local)?;
        cloexec(&remote)?;
        let fdport = message::SendRight::from_fd(remote.as_raw_fd())?;
        // Recheck after allocation and immediately before granting a fileport.
        if identity::authenticate(token).ok() != Some(peer) || !authorize(peer) {
            let _ = request.reply(None);
            return Ok(None);
        }
        if request.reply(Some(fdport)).is_err() {
            return Ok(None);
        }
        Ok(Some(local))
    }
}

pub(crate) fn connect(name: &str, broker_pid: u32) -> Result<UnixStream, ()> {
    if !valid_name(name) || broker_pid == 0 || broker_pid > i32::MAX as u32 {
        return Err(());
    }
    identity::ready()?;
    let service = message::SendRight::lookup(name)?;
    let reply = message::ReceivePort::new()?;
    message::request(&service, &reply)?;
    let response = reply.receive(HANDSHAKE_WAIT)?.ok_or(())?;
    let (token, fdport) = response.grant()?;
    let sender = identity::authenticate(token)?;
    if sender.pid != broker_pid {
        return Err(());
    }
    // Authentication is complete before any conversion or application bytes.
    let fd = unsafe { ffi::fileport_makefd(fdport) };
    if fd < 0 {
        return Err(());
    }
    // SAFETY: fileport_makefd returned a new, owned descriptor.
    let stream = unsafe { UnixStream::from_raw_fd(fd) };
    cloexec(&stream)?;
    Ok(stream)
}

fn valid_name(name: &str) -> bool {
    name.strip_prefix(PREFIX).is_some_and(|suffix| {
        suffix.len() == 32
            && suffix
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}

fn cloexec(stream: &UnixStream) -> Result<(), ()> {
    let fd = stream.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        return Err(());
    }
    Ok(())
}

#[cfg(test)]
#[path = "mach_channel/tests.rs"]
mod tests;
