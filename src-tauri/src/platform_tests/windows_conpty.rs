//! Test-only Windows isolation. Original assertions execute in one owned child.
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) enum Case {
    Reservation,
    Cancellation,
    Manager,
    Drain,
    CursorReply,
    CloseDrain,
    TerminalCancel,
}

impl Case {
    fn test(self) -> &'static str {
        match self {
            Self::Reservation => "auth::tests::login_child_keeps_program_reserved_until_exit",
            Self::Cancellation => {
                "auth::terminal::tests::cancellation_after_spawn_keeps_the_original_exit_owner"
            }
            Self::TerminalCancel => {
                "pty::windows_tests::cancelling_a_windows_terminal_confirms_job_end_without_an_agent"
            }
            _ => "platform_tests::windows_conpty::diagnostic_child",
        }
    }
    fn budget(self) -> Duration {
        // Original cancellation body contains3s marker+1s result+5s close+1s
        // configuration waits, before ConPTY startup.8s cannot contain it.
        Duration::from_secs(match self {
            Self::Reservation | Self::Cancellation | Self::TerminalCancel => 20,
            Self::Manager => 12, // up to3s startup+3s readiness+5s close
            _ => 10,             //3s startup+3s readiness+2s exit+1s EOF; not a production cap
        })
    }
}

#[derive(Default)]
struct Capture {
    bytes: Vec<u8>,
    eof: bool,
    failed: bool,
    overflow: bool,
}

fn drain(mut input: impl Read + Send + 'static, limit: usize) -> Arc<Mutex<Capture>> {
    let capture = Arc::new(Mutex::new(Capture::default()));
    let received = capture.clone();
    std::thread::spawn(move || {
        let mut bytes = [0u8; 8192];
        loop {
            match input.read(&mut bytes) {
                Ok(0) => {
                    drop(input);
                    received.lock().unwrap().eof = true;
                    return;
                }
                Ok(n) => {
                    let mut value = received.lock().unwrap();
                    let keep = n.min(limit.saturating_sub(value.bytes.len()));
                    value.bytes.extend_from_slice(&bytes[..keep]);
                    value.overflow |= keep != n;
                }
                Err(_) => {
                    drop(input);
                    received.lock().unwrap().failed = true;
                    return;
                }
            }
        }
    });
    capture
}

fn show(capture: &Arc<Mutex<Capture>>, stderr: bool) {
    let value = capture.lock().unwrap();
    let text = String::from_utf8_lossy(&value.bytes);
    if stderr {
        eprint!("{text}");
    } else {
        print!("{text}");
    }
}

struct Owner {
    child: std::process::Child,
    group: crate::windows_process::OwnedGroup,
    closed: bool,
}
impl Drop for Owner {
    fn drop(&mut self) {
        if self.closed {
            return;
        }
        // Unwind must not drop the last exact owner after a partial setup.
        loop {
            self.group.terminate();
            let _ = self.child.kill();
            if matches!(self.child.try_wait(), Ok(Some(_))) && !self.group.active() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

pub(crate) fn run(case: Case) {
    // Only these seven owned cases share this lock; unrelated tests keep running.
    static SERIAL: Mutex<()> = Mutex::new(());
    static CLEANUP_PENDING: AtomicBool = AtomicBool::new(false);
    let _serial = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
    assert!(
        !CLEANUP_PENDING.load(Ordering::SeqCst),
        "case {case:?} not covered: a prior owner is still unconfirmed; no new child launched"
    );
    let stop = Arc::new(AtomicBool::new(false));
    let cancel = stop.clone();
    let (send, receive) = mpsc::channel();
    let (captures, capture_ready) = mpsc::channel();
    let started = Instant::now();
    std::thread::spawn(move || {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args([
            "--exact",
            case.test(),
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ]);
        let pending = crate::windows_process::prepare_command(&mut command).unwrap();
        // prepare_command rebuilds Command: stdio must be configured afterwards.
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        drop(command);
        let group = pending
            .attach_or_reap(Some(child.id()), || {
                let _ = child.kill();
                matches!(child.try_wait(), Ok(Some(_)))
            })
            .unwrap();
        let mut owner = Owner {
            child,
            group,
            closed: false,
        };
        let stdout = drain(owner.child.stdout.take().unwrap(), 1024 * 1024);
        let stderr = drain(owner.child.stderr.take().unwrap(), 64 * 1024);
        let _ = captures.send((stdout.clone(), stderr.clone()));
        let mut stdin = owner.child.stdin.take().unwrap();
        let payload = serde_json::to_vec(&case).unwrap();
        assert!(payload.len() <= 64);
        let (input_done, input_result) = mpsc::channel();
        std::thread::spawn(move || {
            let result = stdin
                .write_all(&payload)
                .and_then(|()| stdin.flush())
                .is_ok();
            drop(stdin);
            let _ = input_done.send(result);
        });
        let mut status = None;
        let mut input = None;
        let mut terminated = false;
        loop {
            if input.is_none() {
                input = input_result.try_recv().ok();
            }
            let invalid_pipe = [&stdout, &stderr].iter().any(|p| {
                let value = p.lock().unwrap();
                value.overflow || value.failed
            });
            if started.elapsed() >= case.budget()
                || cancel.load(Ordering::SeqCst)
                || invalid_pipe
                || input == Some(false)
            {
                terminated = true;
            }
            if terminated {
                owner.group.terminate();
                let _ = owner.child.kill();
            }
            if status.is_none() {
                match owner.child.try_wait() {
                    Ok(value) => status = value,
                    Err(_) => terminated = true,
                }
            }
            let streams_terminal = [&stdout, &stderr].iter().all(|p| {
                let value = p.lock().unwrap();
                value.eof || value.failed
            });
            if let Some(status) = status
                && !owner.group.active()
                && streams_terminal
                && input.is_some()
            {
                owner.closed = true;
                let _ = send.send((status.success(), input == Some(true), terminated));
                return;
            }
            // The original Child and direct Job remain in this sole owner until
            // reap+inactivity+EOF. Unknown cleanup is never converted to success.
            std::thread::sleep(Duration::from_millis(10));
        }
    });
    let result = receive.recv_timeout(case.budget() + Duration::from_secs(5));
    stop.store(true, Ordering::SeqCst);
    let captured = capture_ready.try_recv().ok();
    if let Some((stdout, stderr)) = &captured {
        show(stdout, false);
        show(stderr, true);
    }
    let (success, input, terminated) = match result {
        Ok(value) => value,
        Err(error) => {
            // Seal admission before this parent's SERIAL guard can unwind.
            // The cleanup owner continues; no later case may start a child.
            CLEANUP_PENDING.store(true, Ordering::SeqCst);
            panic!(
                "owned ConPTY case {case:?} failed: cleanup unconfirmed ({error}); no closed proof and no further child admission"
            );
        }
    };
    assert!(
        !terminated,
        "owned case {case:?} exceeded its budget or output/input failed; child was terminated, not successful"
    );
    let (stdout, stderr) = captured.expect("child pipes were registered");
    let out = stdout.lock().unwrap();
    let err = stderr.lock().unwrap();
    assert!(
        success && input && out.eof && err.eof,
        "original case {case:?} must exit successfully with both EOFs and input closed"
    );
    assert!(!out.overflow && !err.overflow && !out.failed && !err.failed);
    let stdout = String::from_utf8_lossy(&out.bytes);
    let stderr = String::from_utf8_lossy(&err.bytes);
    assert_eq!(
        stdout.matches("running 1 test").count(),
        1,
        "must execute exactly one original test"
    );
    assert_eq!(
        stdout
            .matches("test result: ok. 1 passed; 0 failed; 0 ignored;")
            .count(),
        1
    );
    assert_eq!(
        stderr
            .matches(&format!("FARFOLD_CONPTY_BEGIN {case:?}\n"))
            .count(),
        1
    );
    eprintln!(
        "FARFOLD_CONPTY_OWNER {{\"case\":\"{case:?}\",\"childExit\":0,\"stdoutEOF\":true,\"stderrEOF\":true,\"directJobInactive\":true}}"
    );
}

fn read_case() -> Case {
    let mut payload = Vec::new();
    std::io::stdin().take(65).read_to_end(&mut payload).unwrap();
    assert!(payload.len() <= 64);
    serde_json::from_slice(&payload).expect("one controlled stdin case, no environment switch")
}

pub(crate) fn entered(expected: Case) {
    assert_eq!(read_case(), expected);
    eprintln!("FARFOLD_CONPTY_BEGIN {expected:?}");
    environment();
    // If native spawn stalls before it returns, still attempt a public module
    // observation from this isolated child. This thread owns no subprocess.
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(500));
        environment();
    });
}

pub(crate) fn environment() {
    // These three metadata declarations do not implement or replace ConPTY.
    #[repr(C)]
    struct Version {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        service: [u16; 128],
    }
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn RtlGetVersion(value: *mut Version) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetModuleHandleW(name: *const u16) -> windows_sys::Win32::Foundation::HMODULE;
        fn GetModuleFileNameW(
            module: windows_sys::Win32::Foundation::HMODULE,
            path: *mut u16,
            size: u32,
        ) -> u32;
    }
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VS_FIXEDFILEINFO, VerQueryValueW,
    };
    let mut version: Version = unsafe { std::mem::zeroed() };
    version.size = std::mem::size_of::<Version>() as u32;
    let os = (unsafe { RtlGetVersion(&mut version) } == 0).then_some([
        version.major,
        version.minor,
        version.build,
    ]);
    let modules: Vec<_> = ["conpty.dll", "kernel32.dll"]
        .into_iter()
        .map(|name| {
            let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
            let module = unsafe { GetModuleHandleW(wide.as_ptr()) };
            let mut path = [0u16; 32768];
            let count = if module.is_null() {
                0
            } else {
                unsafe { GetModuleFileNameW(module, path.as_mut_ptr(), path.len() as u32) }
            };
            let fixed = if count == 0 || count as usize >= path.len() {
                None
            } else {
                let size = unsafe { GetFileVersionInfoSizeW(path.as_ptr(), std::ptr::null_mut()) };
                if size == 0 || size > 1024 * 1024 {
                    None
                } else {
                    let mut bytes = vec![0u8; size as usize];
                    let mut value = std::ptr::null_mut();
                    let mut length = 0;
                    let root = [b'\\' as u16, 0];
                    if unsafe {
                        GetFileVersionInfoW(path.as_ptr(), 0, size, bytes.as_mut_ptr().cast())
                    } == 0
                        || unsafe {
                            VerQueryValueW(
                                bytes.as_ptr().cast(),
                                root.as_ptr(),
                                &mut value,
                                &mut length,
                            )
                        } == 0
                        || value.is_null()
                        || (length as usize) < std::mem::size_of::<VS_FIXEDFILEINFO>()
                    {
                        None
                    } else {
                        let info =
                            unsafe { std::ptr::read_unaligned(value.cast::<VS_FIXEDFILEINFO>()) };
                        (info.dwSignature == 0xfeef04bd).then_some([
                            info.dwFileVersionMS >> 16,
                            info.dwFileVersionMS & 0xffff,
                            info.dwFileVersionLS >> 16,
                            info.dwFileVersionLS & 0xffff,
                        ])
                    }
                }
            };
            serde_json::json!({"module":name,"loaded":!module.is_null(),"version":fixed})
        })
        .collect();
    // No module paths, command/args/env, terminal bodies or user data emitted.
    eprintln!(
        "FARFOLD_CONPTY_ENV {}",
        serde_json::json!({"os":os,"modules":modules,"selection":"loaded candidates; actual DLL choice not inferred from runner label"})
    );
}

const READY: &[u8] = b"FARFOLD_CONPTY_READY";
const PEER: &str = "import sys;print('FARFOLD_CONPTY_READY',flush=True);input();sys.stdout.buffer.write(b'Q'*262144 if sys.argv[1]=='burst' else b'');sys.stdout.buffer.flush()";

fn await_flag(flag: &AtomicBool, budget: Duration) -> bool {
    let deadline = Instant::now() + budget;
    while !flag.load(Ordering::SeqCst) {
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    true
}

fn manager_probe() {
    use base64::Engine;
    let directory = tempfile::tempdir().unwrap();
    let manager = crate::pty::PtyManager::new();
    let ready = Arc::new(AtomicBool::new(false));
    let seen = ready.clone();
    let tail = Mutex::new(Vec::<u8>::new());
    let bytes = Arc::new(AtomicUsize::new(0));
    let count = bytes.clone();
    eprintln!("FARFOLD_CONPTY_PHASE manager.spawn.enter");
    let id = manager
        .spawn(
            &super::python(),
            &["-u".into(), "-c".into(), PEER.into(), "wait".into()],
            &[],
            directory.path(),
            portable_pty::PtySize::default(),
            Arc::new(move |frame| {
                if let Some(data) = frame.get("data").and_then(serde_json::Value::as_str) {
                    let decoded = base64::engine::general_purpose::STANDARD
                        .decode(data)
                        .unwrap();
                    count.fetch_add(decoded.len(), Ordering::SeqCst);
                    let mut tail = tail.lock().unwrap();
                    tail.extend_from_slice(&decoded);
                    if tail.windows(READY.len()).any(|s| s == READY) {
                        seen.store(true, Ordering::SeqCst);
                    }
                    let discard = tail.len().saturating_sub(READY.len());
                    tail.drain(..discard);
                }
            }),
        )
        .unwrap();
    eprintln!("FARFOLD_CONPTY_PHASE manager.spawn.return");
    environment();
    assert!(
        await_flag(&ready, Duration::from_secs(3)),
        "valid Python peer must actually start"
    );
    manager.write(&id, b"finish\r").unwrap();
    eprintln!("FARFOLD_CONPTY_PHASE manager.close.enter");
    let exit = manager
        .close(&id)
        .unwrap()
        .expect("existing terminal must close");
    eprintln!("FARFOLD_CONPTY_PHASE manager.close.return");
    assert!(manager.close(&id).unwrap().is_none());
    eprintln!(
        "FARFOLD_CONPTY_RESULT {}",
        serde_json::json!({"case":"Manager","bytes":bytes.load(Ordering::SeqCst),"fixtureExit":exit,"rootCause":"unknown","internalPtyEOF":"notObservableViaPublicSink"})
    );
}

fn raw_probe(case: Case) {
    use portable_pty::{CommandBuilder, PtySize, native_pty_system};
    let directory = tempfile::tempdir().unwrap();
    eprintln!("FARFOLD_CONPTY_PHASE raw.openpty.enter");
    let pair = native_pty_system().openpty(PtySize::default()).unwrap();
    eprintln!("FARFOLD_CONPTY_PHASE raw.openpty.return");
    environment();
    let mut reader = pair.master.try_clone_reader().unwrap();
    let writer = Arc::new(Mutex::new(pair.master.take_writer().unwrap()));
    let write = writer.clone();
    let ready = Arc::new(AtomicBool::new(false));
    let ready_read = ready.clone();
    let pause = Arc::new(AtomicBool::new(false));
    let pause_read = pause.clone();
    let paused = Arc::new(AtomicBool::new(false));
    let paused_read = paused.clone();
    let queries = Arc::new(AtomicUsize::new(0));
    let query_read = queries.clone();
    let replies = Arc::new(AtomicUsize::new(0));
    let reply_read = replies.clone();
    let (eof, closed) = mpsc::channel();
    let reader_thread = std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        let mut tail = Vec::<u8>::new();
        let mut total = 0usize;
        loop {
            while pause_read.load(Ordering::SeqCst) {
                paused_read.store(true, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(2));
            }
            match reader.read(&mut buffer) {
                Ok(0) => {
                    let _ = eof.send((true, total, "zero"));
                    return;
                }
                Err(e) => {
                    let broken = e.raw_os_error() == Some(109);
                    let _ = eof.send((
                        broken,
                        total,
                        if broken { "brokenPipe" } else { "readError" },
                    ));
                    return;
                }
                Ok(n) => {
                    total += n;
                    if total > 1024 * 1024 {
                        let _ = eof.send((false, total, "outputLimit"));
                        return;
                    }
                    let previous = tail.len();
                    tail.extend_from_slice(&buffer[..n]);
                    if tail.windows(READY.len()).any(|s| s == READY) {
                        ready_read.store(true, Ordering::SeqCst);
                    }
                    let new_queries = tail
                        .windows(4)
                        .enumerate()
                        .filter(|(i, s)| i + 4 > previous && *s == b"\x1b[6n")
                        .count();
                    query_read.fetch_add(new_queries, Ordering::SeqCst);
                    if case != Case::Drain && new_queries != 0 {
                        assert!(reply_read.load(Ordering::SeqCst) + new_queries <= 8);
                        let mut writer = write.lock().unwrap();
                        for _ in 0..new_queries {
                            writer.write_all(b"\x1b[1;1R").unwrap();
                        }
                        writer.flush().unwrap();
                        reply_read.fetch_add(new_queries, Ordering::SeqCst);
                    }
                    // Keep only possible split-query prefix; READY is19bytes.
                    let retain = READY.len().max(3);
                    let discard = tail.len().saturating_sub(retain);
                    tail.drain(..discard);
                }
            }
        }
    });
    let pending = crate::windows_process::pending().unwrap();
    let helper = crate::windows_process::helper_executable().unwrap();
    let python = super::python();
    let args = ["-u", "-c", PEER, "burst"];
    let mut command = CommandBuilder::new(helper);
    command.args(pending.helper_argv(
        std::ffi::OsStr::new(&python),
        args.map(std::ffi::OsString::from),
        true,
    ));
    command.cwd(directory.path());
    eprintln!("FARFOLD_CONPTY_PHASE raw.spawn.enter");
    let mut child = pair.slave.spawn_command(command).unwrap();
    let group = pending
        .attach_or_reap(child.process_id(), || {
            let _ = child.kill();
            matches!(child.try_wait(), Ok(Some(_)))
        })
        .unwrap();
    drop(pair.slave);
    eprintln!("FARFOLD_CONPTY_PHASE raw.spawn.return");
    assert!(
        await_flag(&ready, Duration::from_secs(3)),
        "valid Python peer must actually start"
    );
    if case == Case::CloseDrain {
        pause.store(true, Ordering::SeqCst);
    }
    writer.lock().unwrap().write_all(b"finish\r").unwrap();
    writer.lock().unwrap().flush().unwrap();
    let pause_observed =
        case == Case::CloseDrain && await_flag(&paused, Duration::from_millis(500));
    let close_returned = Arc::new(AtomicBool::new(false));
    let returned = close_returned.clone();
    let resume = pause.clone();
    let close_entered = Arc::new(AtomicBool::new(false));
    let entered = close_entered.clone();
    let pause_thread = std::thread::spawn(move || {
        let entered = await_flag(&entered, Duration::from_millis(500));
        if pause_observed && entered {
            std::thread::sleep(Duration::from_millis(250));
        }
        let observed_block = pause_observed && entered && !returned.load(Ordering::SeqCst);
        resume.store(false, Ordering::SeqCst);
        observed_block
    });
    eprintln!("FARFOLD_CONPTY_PHASE raw.close.enter");
    close_entered.store(true, Ordering::SeqCst);
    drop(pair.master);
    close_returned.store(true, Ordering::SeqCst);
    eprintln!("FARFOLD_CONPTY_PHASE raw.close.return");
    let block_observed = pause_thread.join().unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut status = None;
    let mut forced = false;
    loop {
        if status.is_none() {
            status = child.try_wait().unwrap();
        }
        if status.is_some() && !group.active() {
            break;
        }
        if Instant::now() >= deadline {
            forced = true;
            group.terminate();
            let _ = child.kill();
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let (actual_eof, total, eof_kind) = closed.recv_timeout(Duration::from_secs(1)).unwrap();
    reader_thread.join().unwrap();
    assert!(
        actual_eof && !forced,
        "native close/EOF must complete, not be turned green by a kill"
    );
    let cursor = if queries.load(Ordering::SeqCst) == 0 {
        "notcovered"
    } else {
        "observed"
    };
    let close = if block_observed {
        "observedPausedOverlap"
    } else {
        "notcovered"
    };
    eprintln!(
        "FARFOLD_CONPTY_RESULT {}",
        serde_json::json!({"case":format!("{case:?}"),"cursorCoverage":cursor,"cursorQueries":queries.load(Ordering::SeqCst),"cursorReplies":replies.load(Ordering::SeqCst),"closePauseCoverage":close,"ptyEOF":eof_kind,"bytes":total,"fixtureExit":status.unwrap().exit_code(),"rootCause":"unknown"})
    );
}

#[test]
#[ignore = "Executed only by the active owned parent with controlled stdin"]
fn diagnostic_child() {
    let case = read_case();
    assert!(matches!(
        case,
        Case::Manager | Case::Drain | Case::CursorReply | Case::CloseDrain
    ));
    eprintln!("FARFOLD_CONPTY_BEGIN {case:?}");
    environment();
    if case == Case::Manager {
        manager_probe();
    } else {
        raw_probe(case);
    }
}

#[test]
fn actual_manager_with_valid_windows_python_is_bounded() {
    run(Case::Manager);
}
#[test]
fn raw_conpty_draining_without_cursor_reply_is_bounded() {
    run(Case::Drain);
}
#[test]
fn raw_conpty_replies_only_to_an_observed_query() {
    run(Case::CursorReply);
}
#[test]
fn raw_conpty_close_pause_resumes_drain_and_records_coverage() {
    run(Case::CloseDrain);
}
