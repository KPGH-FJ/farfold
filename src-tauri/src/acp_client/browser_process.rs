//! Runtime-only identity of the actual owned Child. No Agent executable hash,
//! version, self-reported PID, durable identity record or bearer credential.
#[cfg(target_os = "macos")]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct Identity {
    pid: u32,
    uid: u32,
    seconds: u64,
    micros: u64,
}

#[cfg(not(target_os = "macos"))]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct Identity;

impl Identity {
    #[cfg(target_os = "macos")]
    pub(crate) fn capture(pid: u32) -> Option<Self> {
        if pid == 0 {
            return None;
        }
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of_val(&info) as i32;
        let written = unsafe {
            libc::proc_pidinfo(
                pid as i32,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                size,
            )
        };
        (written == size).then_some(Self {
            pid,
            uid: info.pbi_uid,
            seconds: info.pbi_start_tvsec,
            micros: info.pbi_start_tvusec,
        })
    }
    #[cfg(not(target_os = "macos"))]
    pub(crate) fn capture(_: u32) -> Option<Self> {
        None
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn peer(&self, stream: &std::os::unix::net::UnixStream) -> bool {
        use std::os::fd::AsRawFd;
        let mut pid: libc::pid_t = 0;
        let mut size = std::mem::size_of_val(&pid) as libc::socklen_t;
        let mut uid = 0;
        let mut gid = 0;
        // LOCAL_PEERPID is supplied by the kernel for this accepted socket.
        let matched = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                0,
                0x002,
                (&mut pid as *mut libc::pid_t).cast(),
                &mut size,
            ) == 0
                && size as usize == std::mem::size_of_val(&pid)
                && libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) == 0
        };
        matched
            && pid > 0
            && pid as u32 == self.pid
            && uid == self.uid
            && Self::capture(self.pid).as_ref() == Some(self)
    }
}

#[cfg(all(test, target_os = "macos"))]
#[path = "browser_process_tests.rs"]
mod tests;
