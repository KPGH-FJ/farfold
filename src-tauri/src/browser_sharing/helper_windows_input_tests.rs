//! Dedicated native stdin controls. No Tauri, Agent, page or user data.
use super::*;
use crate::browser_sharing::helper_io::{CompletionKind, Step};
use std::{
    io::{BufRead, BufReader, Read, Write},
    os::windows::io::AsRawHandle,
    process::{Child, Command, Stdio},
    sync::{Arc, Condvar, Mutex, mpsc},
    thread,
};
use windows_sys::Win32::{
    Foundation::WAIT_OBJECT_0,
    Storage::FileSystem::ReadFile,
    System::{
        Console::{GetStdHandle, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE},
        Pipes::PeekNamedPipe,
        Threading::WaitForSingleObject,
    },
};

const CHILD: &str = "browser_sharing::helper::windows_input_tests::owned_worker_stdin_child";
const OBSERVE: Duration = Duration::from_secs(5);

fn until(mut condition: impl FnMut() -> bool) {
    let end = Instant::now() + OBSERVE;
    while !condition() {
        assert!(Instant::now() < end, "owned worker condition not reached");
        thread::sleep(Duration::from_millis(1));
    }
}

fn read_json(stream: &mut Stream) -> Value {
    let end = Instant::now() + TIMEOUT;
    let mut bytes = Vec::new();
    loop {
        let mut byte = [0u8];
        match stream.read(&mut byte) {
            Ok(1) => {
                assert!(
                    bytes.len() < INPUT_LIMIT + 1024,
                    "owned broker record bound"
                );
                bytes.push(byte[0]);
                if byte[0] == b'\n' {
                    return serde_json::from_slice(&bytes).expect("actual helper JSON");
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                assert!(Instant::now() < end, "owned broker record deadline");
                thread::sleep(Duration::from_millis(1));
            }
            _ => panic!("owned broker ended before record"),
        }
    }
}

fn send_json(stream: &Stream, value: Value) {
    send_bytes(
        stream,
        &line(&value, INPUT_LIMIT + 1024).unwrap(),
        Instant::now() + TIMEOUT,
    )
    .unwrap();
}

fn pair() -> (channel::Endpoint, Stream, Stream) {
    let endpoint = channel::create().unwrap();
    let client = channel::connect(&endpoint.path).unwrap();
    let mut accepted = None;
    until(|| match endpoint.listener.accept() {
        Ok((stream, ())) => {
            accepted = Some(stream);
            true
        }
        Err(e) if e.kind() == io::ErrorKind::WouldBlock => false,
        Err(_) => panic!("owned broker accept"),
    });
    (endpoint, client, accepted.unwrap())
}

fn stdin() -> windows_sys::Win32::Foundation::HANDLE {
    unsafe { GetStdHandle(STD_INPUT_HANDLE) }
}

fn header() -> String {
    let mut bytes = Vec::new();
    loop {
        let mut byte = [0u8];
        let mut n = 0;
        assert_ne!(
            unsafe { ReadFile(stdin(), byte.as_mut_ptr(), 1, &mut n, std::ptr::null_mut()) },
            0
        );
        assert_eq!(n, 1);
        if byte[0] == b'\n' {
            break;
        }
        assert!(bytes.len() < 32);
        bytes.push(byte[0]);
    }
    String::from_utf8(bytes).unwrap()
}

struct Gate {
    target: fn(Step) -> bool,
    state: Mutex<(bool, bool)>,
    wake: Condvar,
}
impl Gate {
    fn new(target: fn(Step) -> bool) -> Arc<Self> {
        Arc::new(Self {
            target,
            state: Mutex::new((false, false)),
            wake: Condvar::new(),
        })
    }
    fn observer(self: &Arc<Self>) -> Arc<dyn Fn(Step) + Send + Sync> {
        let gate = self.clone();
        Arc::new(move |step| {
            if !(gate.target)(step) {
                return;
            }
            let mut state = gate.state.lock().unwrap();
            if state.0 {
                return;
            }
            state.0 = true;
            gate.wake.notify_all();
            let end = Instant::now() + OBSERVE;
            while !state.1 {
                assert!(Instant::now() < end, "owned worker gate release");
                state = gate
                    .wake
                    .wait_timeout(state, Duration::from_millis(10))
                    .unwrap()
                    .0;
            }
        })
    }
    fn reached(&self) {
        until(|| self.state.lock().unwrap().0);
    }
    fn release(&self) {
        self.state.lock().unwrap().1 = true;
        self.wake.notify_all();
    }
}

fn assert_stdout_closed(worker: &Worker) {
    assert!(worker.stdout_closed);
    assert!(
        unsafe { GetStdHandle(STD_OUTPUT_HANDLE) }.is_null(),
        "actual standard stdout cleared before ACK"
    );
    eprintln!("FARFOLD_STDIN_WORKER_STDOUT_CLOSED");
}

fn worker_pending(deadline: bool) {
    let (_endpoint, stream, mut broker) = pair();
    let gate = Gate::new(|s| s == Step::PeekingMarkedBeforePeek);
    let input = helper_io::Input::from_handle_observed(stdin(), gate.observer()).unwrap();
    let mut worker = Worker::new(stream, input);
    worker.read_stdin().unwrap();
    gate.reached();
    assert!(
        worker
            .queue(json!({"kind":"written","delivery":99}), false, false)
            .unwrap()
    );
    worker.stop(11, false).unwrap();
    let first = worker
        .controls
        .iter()
        .find(|f| f.stop.is_some())
        .unwrap()
        .deadline;
    worker.stop(12, false).unwrap();
    assert_eq!(
        worker
            .controls
            .iter()
            .find(|f| f.stop.is_some())
            .unwrap()
            .deadline,
        first
    );
    worker.write_controls().unwrap();
    assert_eq!(
        read_json(&mut broker),
        json!({"kind":"written","delivery":99})
    );
    let mut byte = [0];
    assert_eq!(
        broker.read(&mut byte).unwrap_err().kind(),
        io::ErrorKind::WouldBlock,
        "pending read cannot fabricate false ACK"
    );
    if deadline {
        while Instant::now() < first {
            thread::sleep(Duration::from_millis(1));
        }
        assert!(worker.expired());
        worker.fail().unwrap();
        assert_stdout_closed(&worker);
        assert_eq!(
            worker.controls.front().unwrap().deadline,
            first,
            "original deadline never restarts"
        );
        assert!(
            worker.write_controls().is_err(),
            "expired false ACK cannot be written"
        );
        assert_eq!(
            broker.read(&mut byte).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
        gate.release();
    } else {
        gate.release();
        until(|| worker.input.stop_state().unwrap() == helper_io::InputStop::Clear);
        worker.write_controls().unwrap();
        assert_eq!(
            read_json(&mut broker),
            json!({"kind":"stopped","barrier":11,"stdoutClosed":false})
        );
        assert_eq!(
            read_json(&mut broker),
            json!({"kind":"stopped","barrier":12,"stdoutClosed":false})
        );
        assert!(!worker.stdin_paused && !worker.stdout_closed);
    }
    drop(worker);
}

fn worker_dirty(mode: &str) {
    let target: fn(Step) -> bool = match mode {
        "dirty-positive" => |s| matches!(s, Step::PeekReturned(n) if n > 0),
        "dirty-data" => |s| matches!(s, Step::CompletedBeforePublish(CompletionKind::Data(_))),
        "dirty-reading" => |s| s == Step::ReadingMarkedBeforeRead,
        _ => panic!("fixed dirty phase"),
    };
    let (_endpoint, stream, mut broker) = pair();
    let gate = Gate::new(target);
    let input = helper_io::Input::from_handle_observed(stdin(), gate.observer()).unwrap();
    let mut worker = Worker::new(stream, input);
    eprintln!("FARFOLD_STDIN_NEED ONE");
    until(|| {
        let mut n = 0;
        (unsafe {
            PeekNamedPipe(
                stdin(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut n,
                std::ptr::null_mut(),
            )
        }) != 0
            && n == 1
    });
    worker.read_stdin().unwrap();
    gate.reached();
    worker.stop(21, false).unwrap();
    let was_pending = worker.pending_input_stop();
    if was_pending {
        assert!(!worker.stdout_closed);
        worker.write_controls().unwrap();
        let mut byte = [0];
        assert_eq!(
            broker.read(&mut byte).unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
    } else {
        assert_stdout_closed(&worker);
    }
    gate.release();
    until(|| {
        worker.advance_input_stop().unwrap();
        worker.stdout_closed
    });
    assert_stdout_closed(&worker);
    worker.write_controls().unwrap();
    assert_eq!(
        read_json(&mut broker),
        json!({"kind":"stopped","barrier":21,"stdoutClosed":true})
    );
    assert!(worker.stdin_input.is_empty() && worker.inflight.is_none());
    for _ in 0..3 {
        worker.read_stdin().unwrap();
    }
    assert!(
        worker.stdin_input.is_empty() && worker.inflight.is_none(),
        "old bytes never forwarded"
    );
    drop(worker);
}

#[test]
#[ignore = "fixed owned Worker stdin child; only its parent supplies setup"]
fn owned_worker_stdin_child() {
    thread::spawn(|| {
        thread::sleep(Duration::from_secs(15));
        std::process::exit(92);
    });
    let mode = header();
    match mode.as_str() {
        "pending-clear" => worker_pending(false),
        "pending-deadline" => worker_pending(true),
        "dirty-positive" | "dirty-data" | "dirty-reading" => worker_dirty(&mode),
        _ => panic!("unknown fixed worker scenario"),
    }
    eprintln!("FARFOLD_STDIN_WORKER_COMPLETED");
    // Production helper entry immediately exits after Worker returns. These
    // child-only controls deliberately close stdout, so no libtest summary is
    // written to that closed handle. Parent observes this original process exit.
    std::process::exit(0);
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
    let mut owner = OriginalChild(Some(child));
    let child = owner.0.as_mut().unwrap();
    let mut input = child.stdin.take().unwrap();
    writeln!(input, "{mode}").unwrap();
    let (writes, receive) = mpsc::channel::<()>();
    let writer = thread::spawn(move || {
        while receive.recv().is_ok() {
            let _ = input.write_all(&[0x5a]);
        }
    });
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let output = thread::spawn(move || {
        let mut b = Vec::new();
        stdout.take(65_537).read_to_end(&mut b).unwrap();
        b
    });
    let send = writes.clone();
    let errors = thread::spawn(move || {
        let mut b = Vec::new();
        for l in BufReader::new(stderr.take(65_537)).lines() {
            let l = l.unwrap();
            if l == "FARFOLD_STDIN_NEED ONE" {
                send.send(()).unwrap();
            }
            b.extend_from_slice(l.as_bytes());
            b.push(b'\n');
        }
        b
    });
    let deadline = Instant::now() + Duration::from_secs(20);
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        assert!(Instant::now() < deadline, "owned Worker child deadline");
        thread::sleep(Duration::from_millis(5));
    };
    drop(writes);
    let stderr = errors.join().unwrap();
    writer.join().unwrap();
    let stdout = output.join().unwrap();
    eprintln!(
        "FARFOLD_STDIN_WORKER_TERMINAL case={mode} pid={} exit={:?}",
        child.id(),
        status.code()
    );
    assert!(stdout.len() <= 65_536 && stderr.len() <= 65_536);
    if !status.success() {
        eprintln!(
            "FARFOLD_STDIN_WORKER_DIAGNOSTIC {}",
            String::from_utf8_lossy(&stderr)
        );
    }
    assert!(status.success(), "owned Worker failed; see fixed terminal");
    assert_eq!(
        stderr
            .windows(b"FARFOLD_STDIN_WORKER_COMPLETED".len())
            .filter(|b| *b == b"FARFOLD_STDIN_WORKER_COMPLETED")
            .count(),
        1
    );
}

#[test]
fn real_worker_pending_peek_keeps_fifo_and_original_one_second_deadline() {
    for mode in ["pending-clear", "pending-deadline"] {
        isolate(mode);
    }
}
#[test]
fn real_worker_positive_unpublished_and_reading_stop_close_before_ack() {
    for mode in ["dirty-positive", "dirty-data", "dirty-reading"] {
        isolate(mode);
    }
}

#[test]
#[ignore = "same-build farfold.exe required; dedicated actual stdin CI, not default libtest"]
fn same_binary_helper_idle_stop_keeps_mcp_and_fifo() {
    let executable = std::env::current_exe().unwrap();
    let helper = executable
        .parent()
        .and_then(Path::parent)
        .unwrap()
        .join("farfold.exe");
    assert!(
        helper.is_file(),
        "same-build helper binary required; absence is not skip"
    );
    let mut entropy = [0u8; 32];
    getrandom::fill(&mut entropy).unwrap();
    let capability: String = entropy.iter().map(|b| format!("{b:02x}")).collect();
    entropy.fill(0);
    let endpoint = channel::create().unwrap();
    let child = Command::new(&helper)
        .arg(MODE)
        .arg(&endpoint.path)
        .env(CAPABILITY_ENV, &capability)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut owner = OriginalChild(Some(child));
    let child = owner.0.as_mut().unwrap();
    let pid = child.id();
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let error = child.stderr.take().unwrap();
    let (send, receive) = mpsc::channel();
    let reader = thread::spawn(move || {
        let mut count = 0;
        for l in BufReader::new(output.take(65_537)).lines() {
            let l = l.unwrap();
            count += l.len() + 1;
            send.send(l).unwrap();
        }
        count
    });
    let errors = thread::spawn(move || {
        let mut b = Vec::new();
        error.take(65_537).read_to_end(&mut b).unwrap();
        b
    });
    let mut broker = None;
    until(|| match endpoint.listener.accept() {
        Ok((stream, ())) => {
            broker = Some(stream);
            true
        }
        Err(e) if e.kind() == io::ErrorKind::WouldBlock => false,
        _ => panic!("actual helper accept"),
    });
    let mut broker = broker.unwrap();
    let hello = read_json(&mut broker);
    assert!(
        hello["kind"] == "hello" && hello["capability"] == capability,
        "original capability handshake"
    );
    send_json(&broker, json!({"kind":"hello_ack"}));
    for id in 1u64..=2 {
        let method = if id == 1 { "initialize" } else { "tools/list" };
        let params = if id == 1 {
            json!({"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"owned-stdio-control","version":"1"}})
        } else {
            json!({})
        };
        let message = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        input
            .write_all(&line(&message, INPUT_LIMIT).unwrap())
            .unwrap();
        input.flush().unwrap();
        let original = read_json(&mut broker);
        assert!(
            original["kind"] == "request" && original["message"] == message,
            "exact owned request forwarding"
        );
        let result = if id == 1 {
            json!({"protocolVersion":"2025-06-18","serverInfo":{"name":"owned-stdio-control","version":"1"},"capabilities":{"tools":{}}})
        } else {
            json!({"tools":[]})
        };
        let reply = json!({"jsonrpc":"2.0","id":id,"result":result});
        send_json(
            &broker,
            json!({"kind":"response","delivery":id,"page":false,"control":false,"message":reply}),
        );
        let actual: Value = serde_json::from_str(
            &receive
                .recv_timeout(OBSERVE)
                .expect("actual helper MCP reply"),
        )
        .unwrap();
        assert!(actual == reply, "exact same helper reply");
        assert_eq!(
            read_json(&mut broker),
            json!({"kind":"written","delivery":id})
        );
        if id == 1 {
            for barrier in [31u64, 32] {
                send_json(
                    &broker,
                    json!({"kind":"stop","barrier":barrier,"close":false}),
                );
                assert_eq!(
                    read_json(&mut broker),
                    json!({"kind":"stopped","barrier":barrier,"stdoutClosed":false})
                );
            }
            assert!(
                child.try_wait().unwrap().is_none(),
                "preserved exact original helper alive"
            );
        }
    }
    drop(input);
    drop(broker);
    drop(endpoint);
    let mut status = None;
    until(|| {
        status = child.try_wait().unwrap();
        status.is_some()
    });
    let output_bytes = reader.join().unwrap();
    let stderr = errors.join().unwrap();
    eprintln!(
        "FARFOLD_STDIN_HELPER_TERMINAL pid={pid} exit={:?}",
        status.unwrap().code()
    );
    assert!(
        status.unwrap().success() && stderr.is_empty() && output_bytes <= 65_536,
        "original helper natural terminal and bounded output"
    );
}
