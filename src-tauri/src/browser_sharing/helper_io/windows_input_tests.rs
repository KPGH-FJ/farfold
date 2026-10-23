//! Real owned Windows pipes; blocking scenarios run only in fixed child tests.
use super::*;
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, Command, Stdio},
    sync::mpsc,
};
use windows_sys::Win32::{
    Foundation::{
        ERROR_ACCESS_DENIED, ERROR_NOT_FOUND, GENERIC_WRITE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    },
    Storage::FileSystem::{CreateFileW, FILE_FLAG_OVERLAPPED, OPEN_EXISTING, PIPE_ACCESS_INBOUND},
    System::{
        Console::{GetStdHandle, STD_INPUT_HANDLE},
        Pipes::{CreateNamedPipeW, PIPE_TYPE_BYTE, PIPE_WAIT},
        Threading::{GetThreadIOPendingFlag, WaitForSingleObject},
    },
};

const CHILD: &str = "browser_sharing::helper_io::windows::input::tests::owned_stdin_input_child";
const OBSERVE: Duration = Duration::from_secs(5);
const REJECTED_INPUT_STEP: &str = "FARFOLD_STDIN_REJECTED_INPUT_STEP";

fn until(mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + OBSERVE;
    while !check() {
        assert!(
            Instant::now() < deadline,
            "owned native condition not reached"
        );
        thread::sleep(Duration::from_millis(1));
    }
}

fn standard_input() -> HANDLE {
    unsafe { GetStdHandle(STD_INPUT_HANDLE) }
}

fn header() -> String {
    let mut bytes = Vec::new();
    loop {
        let mut byte = [0];
        let mut n = 0;
        assert_ne!(
            unsafe {
                ReadFile(
                    standard_input(),
                    byte.as_mut_ptr(),
                    1,
                    &mut n,
                    ptr::null_mut(),
                )
            },
            0,
            "owned setup read"
        );
        assert_eq!(n, 1, "owned setup EOF");
        if byte[0] == b'\n' {
            break;
        }
        assert!(bytes.len() < 32, "owned setup bound");
        bytes.push(byte[0]);
    }
    String::from_utf8(bytes).expect("fixed ASCII setup")
}

fn need(command: &str) {
    eprintln!("FARFOLD_STDIN_NEED {command}");
}

fn available() -> u32 {
    let mut value = 0;
    assert_ne!(
        unsafe {
            PeekNamedPipe(
                standard_input(),
                ptr::null_mut(),
                0,
                ptr::null_mut(),
                &mut value,
                ptr::null_mut(),
            )
        },
        0,
        "owned input peek"
    );
    value
}

fn phase(input: &Input, wanted: Phase) {
    until(|| input.shared.lock().expect("input state").phase == wanted);
}

fn begin(input: &mut Input, output: &mut Vec<u8>, limit: usize) {
    assert_eq!(
        input.read_into(output, limit).unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
}

fn retire(input: &mut Input) {
    input.retire();
    until(|| unsafe { WaitForSingleObject(input.thread.as_raw_handle(), 0) } == WAIT_OBJECT_0);
}

struct Gate {
    target: fn(Step) -> bool,
    state: Mutex<(bool, bool, Vec<Step>)>,
    wake: Condvar,
}

impl Gate {
    fn new(target: fn(Step) -> bool) -> Arc<Self> {
        Arc::new(Self {
            target,
            state: Mutex::new((false, false, Vec::new())),
            wake: Condvar::new(),
        })
    }
    fn observer(self: &Arc<Self>) -> Observer {
        let gate = self.clone();
        Arc::new(move |step| {
            let mut state = gate.state.lock().expect("test gate");
            assert!(state.2.len() < 32, "no uncontrolled input prefetch");
            state.2.push(step);
            if !state.0 && (gate.target)(step) {
                state.0 = true;
                gate.wake.notify_all();
                let deadline = Instant::now() + OBSERVE;
                while !state.1 {
                    assert!(Instant::now() < deadline, "test gate not released");
                    state = gate
                        .wake
                        .wait_timeout(state, Duration::from_millis(10))
                        .unwrap()
                        .0;
                }
            }
        })
    }
    fn reached(&self) {
        until(|| self.state.lock().expect("gate").0);
    }
    fn release(&self) {
        self.state.lock().expect("gate").1 = true;
        self.wake.notify_all();
    }
}

fn contract() {
    // Same standard pipe access as the real Rust Stdio::piped producer. Never
    // grant FILE_WRITE_ATTRIBUTES to hide the old consumer incompatibility.
    let refused = crate::browser_sharing::channel::set_nowait(standard_input());
    assert_eq!(
        refused.unwrap_err().raw_os_error(),
        Some(ERROR_ACCESS_DENIED as i32)
    );
    let gate = Gate::new(|s| s == Step::DemandQueued);
    let mut input = Input::from_handle_observed(standard_input(), gate.observer()).unwrap();
    assert_eq!(input.stop_state().unwrap(), InputStop::Clear);
    let mut bytes = Vec::new();
    begin(&mut input, &mut bytes, 65_536);
    gate.reached();
    assert_eq!(input.shared.lock().unwrap().phase, Phase::Queued(CHUNK));
    need("DATA");
    until(|| available() == 4096);
    gate.release();
    phase(&input, Phase::Complete);
    assert_eq!(input.stop_state().unwrap(), InputStop::Dirty);
    assert!(!input.read_into(&mut bytes, 65_536).unwrap());
    assert!(bytes == vec![0x5a; 4096], "complete owned input bytes");
    let before = gate.state.lock().unwrap().2.clone();
    need("DATA");
    until(|| available() == 4096);
    assert_eq!(input.shared.lock().unwrap().phase, Phase::Idle);
    assert_eq!(
        gate.state.lock().unwrap().2,
        before,
        "no read or peek without demand"
    );
    let limit = bytes.len() + 3;
    begin(&mut input, &mut bytes, limit);
    phase(&input, Phase::Complete);
    assert!(!input.read_into(&mut bytes, limit).unwrap());
    assert_eq!(bytes.len(), limit);
    assert_eq!(
        available(),
        4093,
        "only admitted residual capacity consumed"
    );
    assert_eq!(
        input.read_into(&mut bytes, limit).unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
    assert_eq!(input.shared.lock().unwrap().phase, Phase::Idle);
    retire(&mut input);
}

fn phase_controls() {
    for target in [
        (|s| s == Step::DemandQueued) as fn(Step) -> bool,
        |s| s == Step::PeekingMarkedBeforePeek,
        |s| s == Step::PeekReturned(0),
    ] {
        let gate = Gate::new(target);
        let mut input = Input::from_handle_observed(standard_input(), gate.observer()).unwrap();
        let mut bytes = Vec::new();
        begin(&mut input, &mut bytes, 65_536);
        gate.reached();
        if target(Step::DemandQueued) {
            assert_eq!(input.pause().unwrap(), InputStop::Clear);
            gate.release();
            assert_eq!(input.stop_state().unwrap(), InputStop::Clear);
        } else {
            // No synchronous call exists yet at this exact held-thread phase.
            if target(Step::PeekingMarkedBeforePeek) {
                assert_eq!(
                    unsafe { CancelSynchronousIo(input.thread.as_raw_handle()) },
                    0
                );
                assert_eq!(
                    io::Error::last_os_error().raw_os_error(),
                    Some(ERROR_NOT_FOUND as i32)
                );
            }
            assert_eq!(input.pause().unwrap(), InputStop::Pending);
            assert_eq!(input.stop_state().unwrap(), InputStop::Pending);
            gate.release();
            phase(&input, Phase::Complete);
            assert_eq!(input.stop_state().unwrap(), InputStop::Clear);
        }
        input.resume().unwrap();
        retire(&mut input);
        assert!(bytes.is_empty());
    }
    for target in [
        (|s| matches!(s, Step::PeekReturned(n) if n > 0)) as fn(Step) -> bool,
        |s| s == Step::ReadingMarkedBeforeRead,
        |s| matches!(s, Step::CompletedBeforePublish(CompletionKind::Data(_))),
    ] {
        let gate = Gate::new(target);
        let mut input = Input::from_handle_observed(standard_input(), gate.observer()).unwrap();
        need("ONE");
        until(|| available() > 0);
        let mut bytes = Vec::new();
        begin(&mut input, &mut bytes, 65_536);
        gate.reached();
        let before = input.pause().unwrap();
        assert_ne!(
            before,
            InputStop::Clear,
            "unpublished observed input is not clear"
        );
        gate.release();
        phase(&input, Phase::Complete);
        assert_eq!(input.stop_state().unwrap(), InputStop::Dirty);
        assert!(input.resume().is_err());
        retire(&mut input);
        assert!(bytes.is_empty(), "no paused bytes forwarded");
        // Positive-Peek pause deliberately consumes no data; discard only this
        // test's known one-byte leftover before starting the next owned Input.
        if available() > 0 {
            let mut byte = [0];
            let mut n = 0;
            assert_ne!(
                unsafe {
                    ReadFile(
                        standard_input(),
                        byte.as_mut_ptr(),
                        1,
                        &mut n,
                        ptr::null_mut(),
                    )
                },
                0
            );
            assert_eq!(n, 1);
        }
    }
}

fn direct_eof() {
    let mut input = Input::from_handle(standard_input()).unwrap();
    need("EOF");
    until(|| {
        let mut count = 0;
        (unsafe {
            PeekNamedPipe(
                standard_input(),
                ptr::null_mut(),
                0,
                ptr::null_mut(),
                &mut count,
                ptr::null_mut(),
            )
        }) == 0
            && io::Error::last_os_error().raw_os_error() == Some(ERROR_BROKEN_PIPE as i32)
    });
    let mut bytes = Vec::new();
    begin(&mut input, &mut bytes, 65_536);
    phase(&input, Phase::Complete);
    assert_eq!(
        input.pause().unwrap(),
        InputStop::Clear,
        "Peek EOF contains no observed bytes"
    );
    input.resume().unwrap();
    assert!(input.read_into(&mut bytes, 65_536).unwrap());
    assert!(bytes.is_empty());
    retire(&mut input);
}

fn drained_read(eof: bool) {
    let gate = Gate::new(|s| s == Step::ReadingMarkedBeforeRead);
    let mut input = Input::from_handle_observed(standard_input(), gate.observer()).unwrap();
    need("ONE");
    until(|| available() == 1);
    let mut bytes = Vec::new();
    begin(&mut input, &mut bytes, 65_536);
    gate.reached();
    let mut byte = [0];
    let mut n = 0;
    assert_ne!(
        unsafe {
            ReadFile(
                standard_input(),
                byte.as_mut_ptr(),
                1,
                &mut n,
                ptr::null_mut(),
            )
        },
        0
    );
    assert_eq!(n, 1);
    gate.release();
    until(|| {
        let mut pending = 0;
        assert_ne!(
            unsafe { GetThreadIOPendingFlag(input.thread.as_raw_handle(), &mut pending) },
            0
        );
        pending != 0
    });
    if eof {
        need("EOF");
        phase(&input, Phase::Complete);
        assert_eq!(
            input.pause().unwrap(),
            InputStop::Dirty,
            "published Read EOF still follows positive Peek"
        );
        assert!(input.resume().is_err());
    } else {
        assert_eq!(input.pause().unwrap(), InputStop::Dirty);
        input.retire();
        need("ONE");
    }
    retire(&mut input);
    assert!(bytes.is_empty(), "late native completion not delivered");
}

fn rejected_before_data_io(handle: HANDLE) {
    let step_seen = Arc::new(Mutex::new(false));
    let observed = step_seen.clone();
    let observer = Arc::new(move |_step| {
        eprintln!("{REJECTED_INPUT_STEP}");
        *observed.lock().unwrap() = true;
    });
    assert!(Input::from_handle_observed(handle, observer).is_err());
    assert!(!*step_seen.lock().unwrap(), "rejected before data IO");
}

fn admission() {
    let file = tempfile::tempfile().unwrap();
    rejected_before_data_io(file.as_raw_handle());
    rejected_before_data_io(INVALID_HANDLE_VALUE);
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).unwrap();
    let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let name: Vec<u16> = format!(r"\\.\pipe\farfold-owned-stdin-{suffix}")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let raw = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_INBOUND | FILE_FLAG_OVERLAPPED,
            PIPE_TYPE_BYTE | PIPE_WAIT,
            1,
            4096,
            4096,
            0,
            ptr::null(),
        )
    };
    assert_ne!(raw, INVALID_HANDLE_VALUE);
    let server = unsafe { OwnedHandle::from_raw_handle(raw) };
    let raw_client = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_WRITE,
            0,
            ptr::null(),
            OPEN_EXISTING,
            0,
            ptr::null_mut(),
        )
    };
    assert_ne!(raw_client, INVALID_HANDLE_VALUE);
    let _client = unsafe { OwnedHandle::from_raw_handle(raw_client) };
    // The connected owned server has actual overlapped mode. No added
    // write-attribute authority or invented asynchronous completion.
    rejected_before_data_io(server.as_raw_handle());
}

#[test]
#[ignore = "fixed owned stdin child; parent supplies setup and holds the original process"]
fn owned_stdin_input_child() {
    thread::spawn(|| {
        thread::sleep(Duration::from_secs(15));
        std::process::exit(92);
    });
    match header().as_str() {
        "contract" => contract(),
        "phases" => phase_controls(),
        "eof" => direct_eof(),
        "read-eof" => drained_read(true),
        "read-retire" => drained_read(false),
        "admission" => admission(),
        _ => panic!("unknown fixed owned child scenario"),
    }
    eprintln!("FARFOLD_STDIN_CHILD_COMPLETED");
}

struct OriginalChild(Option<Child>);
impl Drop for OriginalChild {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take()
            && child.try_wait().ok().flatten().is_none()
        {
            let _ = child.kill();
            if unsafe { WaitForSingleObject(child.as_raw_handle(), 5000) } == WAIT_OBJECT_0 {
                let _ = child.try_wait();
            } else {
                eprintln!("FARFOLD_STDIN_ORIGINAL_CHILD_UNSETTLED");
                std::mem::forget(child); // Do not close the only unresolved owner.
            }
        }
    }
}

fn isolate(mode: &str) {
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            CHILD,
            "--exact",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut original = OriginalChild(Some(child));
    let child = original.0.as_mut().unwrap();
    let pid = child.id();
    let mut input = child.stdin.take().unwrap();
    writeln!(input, "{mode}").unwrap();
    let (writes, writer) = mpsc::channel::<&'static str>();
    let writer_thread = thread::spawn(move || {
        let mut input = Some(input);
        while let Ok(command) = writer.recv() {
            match command {
                "EOF" => {
                    input.take();
                }
                "ONE" | "DATA" => {
                    let data = vec![0x5a; if command == "ONE" { 1 } else { 4096 }];
                    if let Some(pipe) = input.as_mut() {
                        let _ = pipe.write_all(&data);
                    }
                }
                _ => panic!("unknown fixed stdin command"),
            }
        }
    });
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let out = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.take(65_537).read_to_end(&mut bytes).unwrap();
        bytes
    });
    let (events, received) = mpsc::channel();
    let err = thread::spawn(move || {
        let mut bytes = Vec::new();
        for line in BufReader::new(stderr.take(65_537)).lines() {
            let line = line.unwrap();
            bytes.extend_from_slice(line.as_bytes());
            bytes.push(b'\n');
            if let Some(command) = line.strip_prefix("FARFOLD_STDIN_NEED ") {
                events.send(command.to_owned()).unwrap();
            }
        }
        bytes
    });
    let deadline = Instant::now() + Duration::from_secs(20);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            panic!("owned stdin child timed out");
        }
        match received.recv_timeout(Duration::from_millis(5)) {
            Ok(command) => {
                writes
                    .send(match command.as_str() {
                        "EOF" => "EOF",
                        "ONE" => "ONE",
                        "DATA" => "DATA",
                        _ => panic!("invalid owned child command"),
                    })
                    .unwrap();
            }
            Err(mpsc::RecvTimeoutError::Timeout | mpsc::RecvTimeoutError::Disconnected) => {}
        }
    };
    drop(writes);
    writer_thread.join().unwrap();
    let stdout = out.join().unwrap();
    let stderr = err.join().unwrap();
    eprintln!(
        "FARFOLD_STDIN_CHILD_TERMINAL case={mode} pid={pid} exit={:?}",
        status.code()
    );
    assert!(
        stdout.len() <= 65_536 && stderr.len() <= 65_536,
        "owned child output bound"
    );
    if !status.success() {
        eprintln!(
            "FARFOLD_STDIN_CHILD_DIAGNOSTIC {}",
            String::from_utf8_lossy(&stderr)
        );
    }
    assert!(
        status.success(),
        "owned stdin child failed (see fixed case/terminal)"
    );
    if mode == "admission" {
        assert!(
            !stderr
                .windows(REJECTED_INPUT_STEP.len())
                .any(|bytes| bytes == REJECTED_INPUT_STEP.as_bytes()),
            "rejected input produced a data IO step before child exit"
        );
    }
    assert_eq!(
        stderr
            .windows(b"FARFOLD_STDIN_CHILD_COMPLETED".len())
            .filter(|b| *b == b"FARFOLD_STDIN_CHILD_COMPLETED")
            .count(),
        1
    );
}

#[test]
fn standard_readonly_pipe_preserves_single_chunk_demand_and_limit() {
    isolate("contract");
}
#[test]
fn paused_native_phases_keep_real_completion_and_dirty_ownership() {
    isolate("phases");
}
#[test]
fn eof_and_inflight_retirement_do_not_fabricate_completion() {
    for mode in ["eof", "read-eof", "read-retire"] {
        isolate(mode);
    }
}
#[test]
fn overlapped_and_non_pipe_inputs_are_rejected_before_data_io() {
    isolate("admission");
}
