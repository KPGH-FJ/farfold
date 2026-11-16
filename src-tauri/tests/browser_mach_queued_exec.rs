//! A real foreign Mach packet queued before exec reaches the exact production
//! Server/authenticate. The current PID/code comparator is deliberately only an
//! observation: it never substitutes for the production send-time audit check.
#![cfg(target_os = "macos")]

#[path = "../src/browser_sharing/mach_channel.rs"]
mod mach_channel;

use serde_json::{Value, json};
use std::{
    cell::Cell,
    io::{Read, Write},
    os::fd::AsRawFd,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    time::{Duration, Instant},
};

const WAIT: Duration = Duration::from_secs(10);
const CHILD: &str = "trusted_after_exec_child";

fn bounded_line(fd: i32) -> std::io::Result<String> {
    let end = Instant::now() + WAIT;
    let mut bytes = Vec::new();
    loop {
        let remaining = end.saturating_duration_since(Instant::now());
        if remaining.is_zero() || bytes.len() >= 4096 {
            return Err(std::io::ErrorKind::TimedOut.into());
        }
        let mut input = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        let mut byte = 0_u8;
        if unsafe { libc::poll(&mut input, 1, remaining.as_millis() as i32) } != 1 {
            return Err(std::io::ErrorKind::TimedOut.into());
        }
        if unsafe { libc::read(fd, (&mut byte as *mut u8).cast(), 1) } != 1 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        if byte == b'\n' {
            return String::from_utf8(bytes).map_err(|_| std::io::ErrorKind::InvalidData.into());
        }
        bytes.push(byte);
    }
}

fn wait(child: &mut Child) -> Option<ExitStatus> {
    let end = Instant::now() + WAIT;
    while Instant::now() < end {
        if let Some(status) = child.try_wait().expect("observe owned child") {
            return Some(status);
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    None
}

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        self.0.stdin.take();
        // EOF lets either the C poll or Rust bootstrap finish. Never signal a
        // failed/unobserved process and never claim an unobserved exit.
        if wait(&mut self.0).is_none() {
            eprintln!("queued-exec-owned-child-exit-unconfirmed:{}", self.0.id());
        }
    }
}

fn build_foreign(directory: &Path) -> PathBuf {
    let binary = directory.join("foreign-queued-request");
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/queued_before_exec.c");
    let compiled = Command::new("/usr/bin/clang")
        .args(["-std=c11", "-Wall", "-Wextra", "-Werror"])
        .arg(source)
        .args([
            "-framework",
            "Security",
            "-framework",
            "CoreFoundation",
            "-o",
        ])
        .arg(&binary)
        .output()
        .expect("compile private foreign fixture");
    assert!(
        compiled.status.success(),
        "private fixture compile: {}",
        String::from_utf8_lossy(&compiled.stderr)
    );
    assert!(
        Command::new("/usr/bin/codesign")
            .args(["--force", "--sign", "-"])
            .arg(&binary)
            .output()
            .expect("sign private fixture")
            .status
            .success()
    );
    binary
}

fn identity(binary: &Path, pid: u32, broker: u32) -> Value {
    let result = Command::new(binary)
        .arg("inspect")
        .arg(pid.to_string())
        .arg(broker.to_string())
        .output()
        .expect("read owned child identity");
    assert!(result.status.success(), "owned child identity read failed");
    serde_json::from_slice(&result.stdout).expect("public identity JSON")
}

#[test]
fn queued_foreign_request_is_rejected_after_trusted_exec() {
    let directory = tempfile::tempdir().expect("private fixture directory");
    let foreign = build_foreign(directory.path());
    let server = mach_channel::Server::bind().expect("production broker");
    let executable = std::env::current_exe().expect("current trusted test binary");
    let mut child = OwnedChild(
        Command::new(&foreign)
            .arg("queue")
            .arg(server.name())
            .arg(&executable)
            .arg(CHILD)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("owned foreign child"),
    );
    let stdout = child.0.stdout.as_ref().unwrap().as_raw_fd();
    assert_eq!(
        bounded_line(stdout).unwrap(),
        "FOREIGN_QUEUED_VALID_44_BYTE_REQUEST"
    );
    let before = identity(&foreign, child.0.id(), server.broker_pid());
    assert_ne!(before["currentTrustedCodeStatus"], 0);
    child.0.stdin.as_mut().unwrap().write_all(b"E").unwrap();
    // libtest emits an empty line and one test-count line before the exact
    // private entry; no arbitrary child output is ignored.
    for expected in ["", "running 1 test", "TRUSTED_AFTER_EXEC_READY"] {
        assert_eq!(bounded_line(stdout).unwrap(), expected);
    }
    let after = identity(&foreign, child.0.id(), server.broker_pid());
    for field in ["pid", "uid", "parent", "seconds", "micros"] {
        assert_eq!(before[field], after[field], "identity changed: {field}");
    }
    assert_eq!(after["uid"], unsafe { libc::geteuid() });
    assert_eq!(after["parent"], std::process::id());
    assert_eq!(after["currentTrustedCodeStatus"], 0);

    let authorizations = Cell::new(0);
    let rejected = server
        .accept(
            &|_| {
                authorizations.set(authorizations.get() + 1);
                true
            },
            WAIT,
        )
        .expect("production receive must succeed");
    assert!(
        rejected.is_none(),
        "queued foreign request granted a channel"
    );
    assert_eq!(
        authorizations.get(),
        0,
        "foreign request passed authenticate"
    );

    // The same now-trusted process submits a fresh production request. This
    // proves neither a dead listener nor an always-reject policy made us pass.
    writeln!(
        child.0.stdin.as_mut().unwrap(),
        "{} {}",
        server.name(),
        server.broker_pid()
    )
    .unwrap();
    let mut channel = server
        .accept(
            &|peer| {
                authorizations.set(authorizations.get() + 1);
                peer.pid == child.0.id() && peer.uid == unsafe { libc::geteuid() }
            },
            WAIT,
        )
        .expect("fresh production receive")
        .expect("fresh trusted channel must be granted");
    assert_eq!(authorizations.get(), 2);
    channel.set_read_timeout(Some(WAIT)).unwrap();
    channel.set_write_timeout(Some(WAIT)).unwrap();
    let mut ping = [0; 4];
    channel.read_exact(&mut ping).unwrap();
    assert_eq!(&ping, b"PING");
    channel.write_all(b"PONG").unwrap();
    assert_eq!(channel.read(&mut ping).unwrap(), 0);
    child.0.stdin.take();
    let status = wait(&mut child.0).expect("owned child natural exit");
    assert_eq!(status.code(), Some(0));
    println!(
        "QUEUED_EXEC_RESULT {}",
        json!({"packetSize":44,"productionRequestCode":1,
            "before":before,"after":after,"queuedRequestRejected":true,
            "foreignAuthorizationCalls":0,"foreignFileportsGranted":0,
            "freshAuthorizationCalls":authorizations.get(),
            "freshTrustedChannelAndEof":true,"childExit":status.code(),
            "signalsSent":0,"agentOrModelRequests":0})
    );
}

#[test]
#[ignore = "private exact subprocess entry; parent supplies bounded public bootstrap"]
fn trusted_after_exec_child() {
    println!("TRUSTED_AFTER_EXEC_READY");
    std::io::stdout().flush().unwrap();
    let run = || -> Result<(), ()> {
        let line = bounded_line(libc::STDIN_FILENO).map_err(|_| ())?;
        let parts: Vec<_> = line.split(' ').collect();
        if parts.len() != 2 {
            return Err(());
        }
        let mut channel = mach_channel::connect(parts[0], parts[1].parse().map_err(|_| ())?)?;
        channel.set_read_timeout(Some(WAIT)).map_err(|_| ())?;
        channel.set_write_timeout(Some(WAIT)).map_err(|_| ())?;
        channel.write_all(b"PING").map_err(|_| ())?;
        let mut pong = [0; 4];
        channel.read_exact(&mut pong).map_err(|_| ())?;
        (pong == *b"PONG").then_some(()).ok_or(())
    };
    std::process::exit(if run().is_ok() { 0 } else { 23 });
}
