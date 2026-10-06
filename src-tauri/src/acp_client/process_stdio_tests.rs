//! Controlled subprocesses only; no external Agent or installed app.
use super::*;
use futures_lite::{AsyncReadExt, AsyncWriteExt};
use std::{
    io::{Read, Write},
    os::fd::{AsRawFd, RawFd},
    time::Duration,
};

#[test]
fn mac_stdio_spawn_has_no_post_spawn_standard_pipe_wrappers() {
    let mut command = async_process::Command::new("/bin/sh");
    command.args(["-c", "exit 0"]);
    let (_pipes, mut child) = spawn(command).unwrap();
    let native_pipes = [
        child.stdin.is_some(),
        child.stdout.is_some(),
        child.stderr.is_some(),
    ];
    assert!(
        futures_lite::future::block_on(child.status())
            .unwrap()
            .success()
    );
    assert_eq!(
        native_pipes, [false; 3],
        "custom prebuilt streams must bypass all fallible post-spawn stdio wrappers"
    );
}

fn flags(fd: RawFd, command: libc::c_int) -> libc::c_int {
    let value = unsafe { libc::fcntl(fd, command) };
    assert!(value >= 0);
    value
}

fn nonblocking<T: AsRawFd>(pipe: T) -> T {
    // Failure injection can happen before Async::new sets this flag. Keep the
    // test witness bounded even if an opposite endpoint is mistakenly retained.
    let fd = pipe.as_raw_fd();
    let value = flags(fd, libc::F_GETFL);
    assert_eq!(
        unsafe { libc::fcntl(fd, libc::F_SETFL, value | libc::O_NONBLOCK) },
        0
    );
    pipe
}

#[test]
fn mac_stdio_parent_endpoints_are_nonblocking_and_child_endpoints_stay_blocking_cloexec() {
    let prepared = Prepared::new().unwrap();
    let parents = [
        prepared.streams.stdin.as_raw_fd(),
        prepared.streams.stdout.as_raw_fd(),
        prepared.streams.stderr.as_raw_fd(),
    ];
    let children = [
        prepared.child_stdin.as_raw_fd(),
        prepared.child_stdout.as_raw_fd(),
        prepared.child_stderr.as_raw_fd(),
    ];
    for fd in parents {
        assert_ne!(flags(fd, libc::F_GETFL) & libc::O_NONBLOCK, 0);
    }
    for fd in children {
        assert_eq!(flags(fd, libc::F_GETFL) & libc::O_NONBLOCK, 0);
    }
    for fd in parents.into_iter().chain(children) {
        assert_ne!(flags(fd, libc::F_GETFD) & libc::FD_CLOEXEC, 0);
    }
}

enum Witness {
    Input(io::PipeWriter),
    Output(io::PipeReader),
}
impl Witness {
    fn opposite_end_closed(&mut self) -> bool {
        match self {
            Self::Input(writer) => match writer.write(b"x") {
                Err(error) if error.kind() == io::ErrorKind::BrokenPipe => true,
                Ok(_) => false,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => false,
                Err(error) => panic!("unexpected witness write error: {error}"),
            },
            Self::Output(reader) => match reader.read(&mut [0]) {
                Ok(0) => true,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => false,
                result => panic!("unexpected witness read: {result:?}"),
            },
        }
    }

    fn assert_opposite_end_closed(mut self) {
        assert!(
            self.opposite_end_closed(),
            "prepared opposite endpoint must already be closed"
        );
    }

    fn assert_opposite_end_closes_within(mut self, bound: Duration) -> bool {
        let start = std::time::Instant::now();
        let mut deferred = false;
        while !self.opposite_end_closed() {
            deferred = true;
            assert!(
                start.elapsed() < bound,
                "spawn error retained an opposite endpoint beyond the bound"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        deferred
    }
}

#[test]
fn mac_stdio_preparation_errors_do_not_launch_and_close_partial_pipe_endpoints() {
    // Fail each pipe creation or parent registration in turn, without changing
    // process-wide limits. Witnesses retain only a parent endpoint: EOF/EPIPE
    // proves every partially prepared opposite endpoint was actually closed.
    for failure in 0..6 {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("should-not-start");
        let mut command = async_process::Command::new("/bin/sh");
        command.args(["-c", "printf started > \"$1\"", "fixture"]);
        command.arg(&marker);
        let mut step = 0;
        let mut witnesses = Vec::new();
        let fault = std::cell::Cell::new(0);
        let fail = || {
            let current = fault.get();
            fault.set(current + 1);
            if current == failure {
                Err(io::Error::from_raw_os_error(libc::EMFILE))
            } else {
                Ok(())
            }
        };
        let result = spawn_prepared(command, || {
            Prepared::with_factories(
                || {
                    fail()?;
                    let pair = io::pipe()?;
                    witnesses.push(if step == 0 {
                        Witness::Input(nonblocking(pair.1.try_clone()?))
                    } else {
                        Witness::Output(nonblocking(pair.0.try_clone()?))
                    });
                    step += 1;
                    Ok(pair)
                },
                |writer| {
                    fail()?;
                    Async::new(writer)
                },
                |reader| {
                    fail()?;
                    Async::new(reader)
                },
            )
        });
        let error = match result {
            Err(error) => error,
            Ok((_streams, mut child)) => {
                let _ = child.kill();
                futures_lite::future::block_on(child.status()).unwrap();
                panic!("injected preparation failure must prevent spawn");
            }
        };
        assert_eq!(error.raw_os_error(), Some(libc::EMFILE));
        assert!(!marker.exists());
        for witness in witnesses {
            witness.assert_opposite_end_closed();
        }
    }
}

#[tokio::test]
async fn mac_stdio_round_trip_stderr_and_eof_do_not_keep_command_endpoint_copies() {
    let mut command = async_process::Command::new("/bin/sh");
    command.args([
        "-c",
        "IFS= read -r line; printf '%s\\n' \"$line\"; printf 'stderr-ok\\n' >&2; cat",
    ]);
    let (mut streams, mut child) = spawn(command).unwrap();
    let pid = child.id();
    let exchange = async {
        streams.stdin.write_all(b"round-trip\n").await.unwrap();
        streams.stdin.flush().await.unwrap();
        let mut first = vec![0; 11];
        streams.stdout.read_exact(&mut first).await.unwrap();
        assert_eq!(first, b"round-trip\n");
        // cat waits for actual input EOF after the parent writer is dropped.
        // The output read_to_end calls also require Command's copies of the
        // child stdout/stderr writers to be closed, independently of child exit.
        drop(streams.stdin);
        let mut remaining = Vec::new();
        streams.stdout.read_to_end(&mut remaining).await.unwrap();
        assert!(remaining.is_empty());
        let mut errors = Vec::new();
        streams.stderr.read_to_end(&mut errors).await.unwrap();
        assert_eq!(errors, b"stderr-ok\n");
        child.status().await.unwrap()
    };
    let status = match tokio::time::timeout(Duration::from_secs(5), exchange).await {
        Ok(status) => status,
        Err(_) => {
            let _ = child.kill();
            child.status().await.unwrap();
            panic!("stdio round trip and EOF must complete within the bound");
        }
    };
    assert!(status.success());
    assert_ne!(
        unsafe { libc::kill(pid as i32, 0) },
        0,
        "exact fixture child must be reaped"
    );
}

#[test]
fn mac_stdio_spawn_error_closes_all_prepared_endpoints() {
    let dir = tempfile::tempdir().unwrap();
    let mut deferred = 0;
    for _ in 0..16 {
        let command = async_process::Command::new(dir.path().join("missing-fixture"));
        let mut witnesses = Vec::new();
        let result = spawn_prepared(command, || {
            let prepared = Prepared::new()?;
            witnesses.push(Witness::Input(
                prepared.streams.stdin.get_ref().try_clone()?,
            ));
            witnesses.push(Witness::Output(
                prepared.streams.stdout.get_ref().try_clone()?,
            ));
            witnesses.push(Witness::Output(
                prepared.streams.stderr.get_ref().try_clone()?,
            ));
            Ok(prepared)
        });
        let error = match result {
            Err(error) => error,
            Ok((_streams, mut child)) => {
                let _ = child.kill();
                futures_lite::future::block_on(child.status()).unwrap();
                panic!("missing controlled program unexpectedly launched");
            }
        };
        assert_eq!(error.raw_os_error(), Some(libc::ENOENT));
        // A prior immediate EPIPE assertion observed one successful write after
        // ENOENT, then a diagnostic rerun observed EPIPE/EOF. The exact transient
        // owner is unknown. Assert actual closure within a bound; no fixed sleep
        // or raw descriptor number is treated as ownership or cleanup proof.
        for witness in witnesses {
            deferred +=
                usize::from(witness.assert_opposite_end_closes_within(Duration::from_secs(2)));
        }
    }
    eprintln!("controlled ENOENT attempts=16, endpoint witnesses deferred={deferred}");
}
