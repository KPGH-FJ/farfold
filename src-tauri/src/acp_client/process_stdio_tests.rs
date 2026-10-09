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

// A pipe witness proves EOF for the pipe object, not merely for this parent's
// descriptor. Concurrent tests may fork while preparation is in progress and
// retain CLOEXEC copies until exec. Run immediate-close assertions in one test
// process, retaining the original assertion instead of waiting out other tests.
fn in_isolated_test(name: &str, body: impl FnOnce()) {
    let args: Vec<_> = std::env::args().collect();
    let child_mode = args.iter().any(|arg| arg == name)
        && args.iter().any(|arg| arg == "--exact")
        && args.iter().any(|arg| arg == "--test-threads=1");
    let completion = format!("farfold-stdio-isolation-complete:{name}");
    if child_mode {
        body();
        eprintln!("{completion}");
        return;
    }
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command.args([name, "--exact", "--test-threads=1", "--nocapture"]);
    run_isolated_command(command, &completion, || {});
}

fn run_isolated_command(
    mut command: std::process::Command,
    completion: &str,
    after_reap: impl FnOnce(),
) {
    let stdout = tempfile::tempfile().unwrap();
    let stderr = tempfile::tempfile().unwrap();
    let mut child = command
        .stdin(std::process::Stdio::null())
        .stdout(stdout.try_clone().unwrap())
        .stderr(stderr.try_clone().unwrap())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(5));
            }
            result => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("isolated stdio test did not finish: {result:?}");
            }
        }
    };
    after_reap();
    let stdout = read_capture(&stdout);
    let stderr = read_capture(&stderr);
    assert!(
        status.success(),
        "isolated stdio test failed:\n{stdout}\n{stderr}"
    );
    assert!(
        stderr.lines().any(|line| line == completion),
        "isolated test body did not complete: {stdout}\n{stderr}"
    );
    eprintln!("{stderr}");
}

// A reaped child does not imply EOF on a pipe inherited by another process.
// Anonymous regular files have no writer-close wait. Positional reading also
// avoids moving the shared file offset of an inherited writer.
fn read_capture(file: &std::fs::File) -> String {
    use std::os::unix::fs::FileExt;
    let length = file.metadata().unwrap().len();
    assert!(
        length <= 64 * 1024,
        "isolated test output exceeds capture limit"
    );
    let mut bytes = vec![0; length as usize];
    file.read_exact_at(&mut bytes, 0).unwrap();
    String::from_utf8_lossy(&bytes).into_owned()
}

#[test]
fn mac_stdio_preparation_errors_do_not_launch_and_close_partial_pipe_endpoints() {
    in_isolated_test(
        "acp_client::process::stdio::tests::mac_stdio_preparation_errors_do_not_launch_and_close_partial_pipe_endpoints",
        || {
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
        },
    );
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

#[test]
fn mac_stdio_other_pre_exec_can_temporarily_inherit_a_preparation_endpoint() {
    in_isolated_test(
        "acp_client::process::stdio::tests::mac_stdio_other_pre_exec_can_temporarily_inherit_a_preparation_endpoint",
        || {
            use std::os::unix::process::CommandExt;
            let (mut ready_read, ready_write) = io::pipe().unwrap();
            let (release_read, mut release_write) = io::pipe().unwrap();
            let ready_read_fd = ready_read.as_raw_fd();
            let release_write_fd = release_write.as_raw_fd();
            std::thread::scope(|scope| {
                let mut child = None;
                let mut witness = None;
                let command = async_process::Command::new("/bin/sh");
                let result = spawn_prepared(command, || {
                    Prepared::with_factories(
                        || {
                            let pair = io::pipe()?;
                            witness = Some(Witness::Input(nonblocking(pair.1.try_clone()?)));
                            let ready_write = ready_write.try_clone()?;
                            let release_read = release_read.try_clone()?;
                            child = Some(scope.spawn(move || {
                                let mut command = std::process::Command::new("/bin/sh");
                                command.args(["-c", "exit 0"]);
                                // The only child-side work is async-signal-safe libc I/O.
                                // The parent releases the gate before any assertion; a
                                // deadline exits only this exact fixture child on failure.
                                unsafe {
                                    command.pre_exec(move || {
                                        libc::close(ready_read_fd);
                                        libc::close(release_write_fd);
                                        let byte = [1u8];
                                        if libc::write(
                                            ready_write.as_raw_fd(),
                                            byte.as_ptr().cast(),
                                            1,
                                        ) != 1
                                        {
                                            libc::_exit(90);
                                        }
                                        let mut poll = libc::pollfd {
                                            fd: release_read.as_raw_fd(),
                                            events: libc::POLLIN,
                                            revents: 0,
                                        };
                                        if libc::poll(&mut poll, 1, 3000) != 1 {
                                            libc::_exit(91);
                                        }
                                        let mut byte = [0u8];
                                        if libc::read(
                                            release_read.as_raw_fd(),
                                            byte.as_mut_ptr().cast(),
                                            1,
                                        ) != 1
                                        {
                                            libc::_exit(92);
                                        }
                                        Ok(())
                                    });
                                }
                                let mut child = command.spawn().unwrap();
                                child.wait().unwrap()
                            }));
                            let mut poll = libc::pollfd {
                                fd: ready_read.as_raw_fd(),
                                events: libc::POLLIN,
                                revents: 0,
                            };
                            if unsafe { libc::poll(&mut poll, 1, 2000) } != 1 {
                                return Err(io::Error::from_raw_os_error(libc::ETIMEDOUT));
                            }
                            ready_read.read_exact(&mut [0u8])?;
                            Ok(pair)
                        },
                        |_writer| Err(io::Error::from_raw_os_error(libc::EMFILE)),
                        Async::new,
                    )
                });
                let error = result.err().unwrap();
                let mut witness = witness.unwrap();
                let closed_before_exec = witness.opposite_end_closed();
                release_write.write_all(&[1]).unwrap();
                assert!(child.unwrap().join().unwrap().success());
                let closed_after_exec = witness.opposite_end_closed();
                eprintln!(
                    "controlled fork witness before_exec={closed_before_exec}, after_exec={closed_after_exec}"
                );
                assert_eq!(error.raw_os_error(), Some(libc::EMFILE));
                assert!(
                    !closed_before_exec,
                    "pre-exec child still owns its forked endpoint"
                );
                assert!(
                    closed_after_exec,
                    "exec must close the inherited CLOEXEC endpoint"
                );
            });
        },
    );
}

#[test]
fn mac_stdio_isolated_capture_does_not_wait_for_inherited_output_writers() {
    use std::os::unix::{ffi::OsStrExt, fs::OpenOptionsExt};
    let dir = tempfile::tempdir().unwrap();
    let gate_path = dir.path().join("owned-gate");
    let gate_name = std::ffi::CString::new(gate_path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(gate_name.as_ptr(), 0o600) }, 0);
    let mut gate = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(&gate_path)
        .unwrap();
    let opened = dir.path().join("gate-opened");
    let completed = dir.path().join("holder-completed");
    let mut command = std::process::Command::new("/bin/sh");
    command
        .args([
            "-c",
            "(exec 3<> \"$1\"; printf ready > \"$3\"; IFS= read -t 8 -r ignored <&3; printf done > \"$4\") & printf '%s\\n' \"$2\" >&2; exit 0",
            "fixture",
        ])
        .arg(&gate_path)
        .arg("owned-output-complete")
        .arg(&opened)
        .arg(&completed);
    let (reaped_send, reaped_recv) = std::sync::mpsc::channel();
    let (done_send, done_recv) = std::sync::mpsc::channel();
    std::thread::scope(|scope| {
        let capture = scope.spawn(move || {
            run_isolated_command(command, "owned-output-complete", || {
                reaped_send.send(()).unwrap();
            });
            done_send.send(()).unwrap();
        });
        let reaped = reaped_recv.recv_timeout(Duration::from_secs(5));
        let opened_by = std::time::Instant::now() + Duration::from_secs(5);
        while !opened.exists() && std::time::Instant::now() < opened_by {
            std::thread::sleep(Duration::from_millis(5));
        }
        let holder_opened = opened.exists();
        let captured_while_writer_alive = reaped.is_ok()
            && holder_opened
            && done_recv.recv_timeout(Duration::from_secs(1)).is_ok()
            && !completed.exists();
        // Release and join before asserting even on the old blocking behavior.
        // Opening the gate read/write plus read's deadline avoids a background
        // child waiting forever if the parent exits before FIFO open finishes.
        gate.write_all(b"release\n").unwrap();
        drop(gate);
        capture.join().unwrap();
        let completed_by = std::time::Instant::now() + Duration::from_secs(5);
        while !completed.exists() && std::time::Instant::now() < completed_by {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            holder_opened && completed.exists(),
            "owned writer holder must open and finish its gate"
        );
        assert!(reaped.is_ok(), "controlled primary child must have exited");
        assert!(
            captured_while_writer_alive,
            "reaped child output must be readable while another child still owns a writer"
        );
    });
}
