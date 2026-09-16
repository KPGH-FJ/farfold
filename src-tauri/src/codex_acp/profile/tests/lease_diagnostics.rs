//! Explicit, bounded diagnostics; only temporary files and child processes we own.
use super::*;
use std::{
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::{net::UnixStream, process::CommandExt},
    },
    process::{Command, Stdio},
    sync::{Arc, Barrier},
    time::{Duration, Instant},
};

#[test]
#[ignore = "explicit one-shot pre-exec inheritance diagnostic, not native Runtime acceptance"]
fn lease_probe_pre_exec_inheritance_has_exact_errno_and_owned_fd() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let first = lock_profile(&root, true).unwrap();
    let fd = first.as_raw_fd();
    let original = first.metadata().unwrap();
    assert_ne!(
        unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC,
        0
    );
    let (mut parent, child_socket) = UnixStream::pair().unwrap();
    parent
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let child_fd = child_socket.as_raw_fd();
    let spawn = std::thread::spawn(move || {
        let mut command = Command::new("/bin/cat");
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // No allocation/formatting/locks after fork. Socket handshake fixes the window;
        // poll bounds cleanup even if the parent panics. CLOEXEC closes both on exec.
        unsafe {
            command.pre_exec(move || {
                let info = [libc::getpid(), fd, libc::fcntl(fd, libc::F_GETFD)];
                if libc::write(child_fd, info.as_ptr().cast(), std::mem::size_of_val(&info))
                    != std::mem::size_of_val(&info) as isize
                {
                    return Err(std::io::Error::from_raw_os_error(libc::EIO));
                }
                let mut poll = libc::pollfd {
                    fd: child_fd,
                    events: libc::POLLIN,
                    revents: 0,
                };
                if libc::poll(&mut poll, 1, 3000) != 1 {
                    return Err(std::io::Error::from_raw_os_error(libc::ETIMEDOUT));
                }
                let mut byte = 0u8;
                if libc::read(child_fd, (&mut byte as *mut u8).cast(), 1) != 1 {
                    return Err(std::io::Error::from_raw_os_error(libc::EIO));
                }
                Ok(())
            });
        }
        let child = command.spawn();
        drop(child_socket);
        child
    });
    let mut wire = [0u8; 12];
    parent.read_exact(&mut wire).unwrap();
    let child_pid = i32::from_ne_bytes(wire[0..4].try_into().unwrap());
    let child_flags = i32::from_ne_bytes(wire[8..12].try_into().unwrap());
    drop(first);
    let blocked = lock_profile(&root, false);
    let attempt = last_lock_attempt();
    // Exact target only. No general user-process or real-profile inventory.
    let holders = Command::new("/usr/sbin/lsof")
        .args(["-a", "-p", &child_pid.to_string(), "-Fpfain"])
        .arg(root.join(".farfold-launch.lock"))
        .output()
        .unwrap();
    parent.write_all(&[1]).unwrap();
    let mut child = spawn.join().unwrap().unwrap();
    let alive_after_exec = child.try_wait().unwrap().is_none();
    let after_exec = lock_profile(&root, false);
    let released = last_lock_attempt();
    drop(child.stdin.take());
    let exit = child.wait().unwrap();
    eprintln!(
        "pre_exec child={child_pid} inherited_flags={child_flags} original_inode={} blocked={attempt} after_exec={released} child_alive_after_exec={alive_after_exec} scoped_lsof={}",
        original.ino(),
        String::from_utf8_lossy(&holders.stdout)
    );
    assert!(blocked.is_err());
    assert_eq!(attempt["errno"], libc::EWOULDBLOCK);
    assert_eq!(attempt["inode"], original.ino());
    assert_eq!(attempt["regular"], true);
    assert_eq!(attempt["links"], 1);
    assert_ne!(child_flags & libc::FD_CLOEXEC, 0);
    assert!(holders.status.success());
    assert!(alive_after_exec && exit.success());
    drop(after_exec.unwrap());
}

#[test]
#[ignore = "explicit fixed 128-sample concurrent ordinary-spawn diagnostic; never retry-to-green"]
fn lease_probe_bounded_ordinary_spawn_overlap() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    drop(lock_profile(&root, true).unwrap());
    let barrier = Arc::new(Barrier::new(2));
    let other = barrier.clone();
    let spawn = std::thread::spawn(move || {
        for _ in 0..128 {
            other.wait();
            // Same ordinary process-group/stdio setup as AcpTransport; no pre_exec.
            let mut child = Command::new("/bin/cat")
                .process_group(0)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            drop(child.stdin.take());
            assert!(child.wait().unwrap().success());
            other.wait();
        }
    });
    let mut failures = Vec::new();
    let began = Instant::now();
    for sample in 0..128 {
        let lease = lock_profile(&root, false).unwrap();
        barrier.wait();
        // Fixed schedule strata, not delays added to production or retrying a failure.
        let offset = [0, 10, 50, 100][sample % 4];
        if offset != 0 {
            std::thread::sleep(Duration::from_micros(offset));
        }
        drop(lease);
        let result = lock_profile(&root, false);
        if result.is_err() {
            failures
                .push(json!({"sample":sample,"offsetMicros":offset,"attempt":last_lock_attempt()}));
        }
        drop(result);
        barrier.wait();
    }
    spawn.join().unwrap();
    eprintln!(
        "ordinary_spawn samples=128 elapsed_ms={} failures={}",
        began.elapsed().as_millis(),
        serde_json::to_string(&failures).unwrap()
    );
    for failure in failures {
        assert_eq!(failure["attempt"]["errno"], libc::EWOULDBLOCK);
    }
}
