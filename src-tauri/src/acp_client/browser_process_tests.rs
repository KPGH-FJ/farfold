//! Kernel peer evidence using an owned subprocess, not a self-reported PID.
use super::*;
use std::{
    io::Read,
    os::unix::net::UnixListener,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
#[test]
fn exact_owned_process_accepts_but_sibling_stale_birth_and_exited_owner_do_not() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("owned.sock");
    let listener = UnixListener::bind(&path).unwrap();
    listener.set_nonblocking(true).unwrap();
    let mut child=Command::new(crate::platform_tests::python()).args(["-u","-c",
        "import socket,sys;s=socket.socket(socket.AF_UNIX);s.connect(sys.argv[1]);s.sendall(b'x');sys.stdin.buffer.read();s.close()"])
        .arg(&path).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    let identity = Identity::capture(child.id()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let (mut stream, _) = loop {
        match listener.accept() {
            Ok(v) => break v,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(Instant::now() < deadline);
                std::thread::yield_now();
            }
            Err(e) => panic!("{e}"),
        }
    };
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut byte = [0u8; 1];
    stream.read_exact(&mut byte).unwrap();
    assert_eq!(byte, [b'x']);
    assert!(identity.peer(&stream));
    assert!(!Identity::capture(std::process::id()).unwrap().peer(&stream));
    let mut stale = identity;
    stale.micros = stale.micros.wrapping_add(1);
    assert!(!stale.peer(&stream));
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
    assert!(!identity.peer(&stream));
}

#[test]
fn helper_parent_birth_and_uid_are_checked_against_the_actual_live_owner() {
    let owner = Identity::capture(std::process::id()).unwrap();
    let mut child = Command::new(crate::platform_tests::python())
        .args(["-c", "import sys;sys.stdin.buffer.read()"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    assert!(owner.helper(child.id(), unsafe { libc::getuid() }));
    assert!(!owner.helper(std::process::id(), unsafe { libc::getuid() }));
    assert!(!owner.helper(child.id(), unsafe { libc::getuid() }.wrapping_add(1)));
    let mut stale = owner;
    stale.micros = stale.micros.wrapping_add(1);
    assert!(!stale.helper(child.id(), unsafe { libc::getuid() }));
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
    assert!(!owner.helper(child.id(), unsafe { libc::getuid() }));
}
