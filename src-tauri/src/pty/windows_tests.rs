//! Actual ConPTY/Job behavior with a synthetic program on Windows.
use super::*;

fn terminal_cancel_phase(name: &str, started: Instant) {
    eprintln!(
        "FARFOLD_TERMINAL_CANCEL {{\"phase\":\"{name}\",\"elapsedMillis\":{}}}",
        started.elapsed().as_millis()
    );
}

#[test]
#[ignore = "executed by the bounded owned isolation wrapper"]
fn cancelling_a_windows_terminal_confirms_job_end_without_an_agent() {
    crate::platform_tests::windows_conpty::entered(
        crate::platform_tests::windows_conpty::Case::TerminalCancel,
    );
    let started = Instant::now();
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("terminal-started");
    let executable = crate::windows_process::helper_executable().unwrap();
    let manager = PtyManager::new();
    terminal_cancel_phase("spawn.enter", started);
    let id = manager
        .spawn(
            executable.to_str().unwrap(),
            &["wait".into(), marker.to_string_lossy().into_owned()],
            &[],
            dir.path(),
            PtySize {
                rows: 20,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            },
            Arc::new(|_| {}),
        )
        .unwrap();
    terminal_cancel_phase("spawn.return", started);
    terminal_cancel_phase("marker.wait.enter", started);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !marker.is_file() {
        if Instant::now() >= deadline {
            terminal_cancel_phase("marker.wait.deadline", started);
            terminal_cancel_phase("marker.missing.close.enter", started);
            let _ = manager.close(&id);
            terminal_cancel_phase("marker.missing.close.return", started);
            panic!("terminal fixture did not start");
        }
        thread::sleep(Duration::from_millis(20));
    }
    terminal_cancel_phase("marker.wait.observed", started);
    terminal_cancel_phase("session.lookup.enter", started);
    let session = manager.lock().unwrap().get(&id).unwrap().clone();
    terminal_cancel_phase("session.lookup.return", started);
    let pid = session.pid.unwrap();
    terminal_cancel_phase("job.owns.enter", started);
    assert!(crate::windows_process::owns(pid));
    terminal_cancel_phase("job.owns.return", started);
    terminal_cancel_phase("close.enter", started);
    assert!(manager.close(&id).unwrap().is_some());
    terminal_cancel_phase("close.return", started);
    terminal_cancel_phase("job.inactive.check.enter", started);
    assert!(!crate::windows_process::active(pid));
    terminal_cancel_phase("job.inactive.check.return", started);
    terminal_cancel_phase("registry.check.enter", started);
    assert!(!manager.lock().unwrap().contains_key(&id));
    terminal_cancel_phase("registry.check.return", started);
    // These are the original successful-path owners, in their original drop order.
    terminal_cancel_phase("session.drop.enter", started);
    drop(session);
    terminal_cancel_phase("session.drop.return", started);
    terminal_cancel_phase("manager.drop.enter", started);
    drop(manager);
    terminal_cancel_phase("manager.drop.return", started);
}

#[test]
fn cancelling_a_windows_terminal_confirms_job_end_without_an_agent_isolated() {
    crate::platform_tests::windows_conpty::run(
        crate::platform_tests::windows_conpty::Case::TerminalCancel,
    );
}

// Independent A/B diagnostics. The original ignored body and four assertions
// above remain byte-for-byte unchanged; neither failed original run is replaced.
#[derive(Default)]
struct CursorCapture {
    tail: Vec<u8>,
    bytes: usize,
    queries: usize,
    replies: usize,
    pending: usize,
    failed: bool,
}

impl CursorCapture {
    fn feed(&mut self, bytes: &[u8]) -> usize {
        let Some(total) = self.bytes.checked_add(bytes.len()) else {
            self.failed = true;
            return 0;
        };
        if total > 1024 * 1024 {
            self.failed = true;
            return 0;
        }
        self.bytes = total;
        let mut found = 0;
        for byte in bytes {
            self.tail.push(*byte);
            if self.tail.len() == 4 {
                if self.tail == b"\x1b[6n" {
                    self.queries += 1;
                    if self.queries > 8 {
                        self.failed = true;
                    } else {
                        found += 1;
                    }
                }
                self.tail.remove(0);
            }
        }
        found
    }
}

struct CursorConsumer {
    capture: Arc<Mutex<CursorCapture>>,
    stop: Arc<AtomicBool>,
    receiver: Option<std::sync::mpsc::Receiver<()>>,
    worker: Option<thread::JoinHandle<()>>,
}

impl CursorConsumer {
    fn new(reply: bool) -> (PtySink, Self) {
        let capture = Arc::new(Mutex::new(CursorCapture::default()));
        let observed = capture.clone();
        let (send, receiver) = std::sync::mpsc::sync_channel(8);
        let sink: PtySink = Arc::new(move |value| {
            let Some(data) = value.get("data").and_then(serde_json::Value::as_str) else {
                return;
            };
            let Ok(bytes) = base64::Engine::decode(&BASE64, data) else {
                observed.lock().unwrap().failed = true;
                return;
            };
            let mut state = observed.lock().unwrap();
            if bytes.len() > 8192 {
                state.failed = true;
                return;
            }
            let queries = state.feed(&bytes);
            if reply {
                for _ in 0..queries {
                    // Reader callback never waits on manager registry, writer,
                    // response thread or a full queue, including during spawn.
                    if send.try_send(()).is_ok() {
                        state.pending += 1;
                    } else {
                        state.failed = true;
                    }
                }
            }
        });
        (
            sink,
            Self {
                capture,
                stop: Arc::new(AtomicBool::new(false)),
                receiver: Some(receiver),
                worker: None,
            },
        )
    }

    fn start(&mut self, manager: std::sync::Weak<PtyManager>, id: String, reply: bool) {
        let receiver = self.receiver.take().unwrap();
        if !reply {
            drop(receiver);
            return;
        }
        let capture = self.capture.clone();
        let stop = self.stop.clone();
        self.worker = Some(thread::spawn(move || {
            loop {
                match receiver.recv_timeout(Duration::from_millis(20)) {
                    Ok(()) => {
                        // Only the ordinary public input operation is used. No
                        // production hooks, native handles or output rewrite.
                        let sent = manager
                            .upgrade()
                            .is_some_and(|manager| manager.write(&id, b"\x1b[1;1R").is_ok());
                        let mut state = capture.lock().unwrap();
                        state.pending -= 1;
                        if sent {
                            state.replies += 1;
                        } else {
                            state.failed = true;
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        if stop.load(Ordering::SeqCst) {
                            return;
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
        }));
    }

    fn phase(&self, phase: &str, reply: bool, started: Instant) {
        let state = self.capture.lock().unwrap();
        eprintln!(
            "FARFOLD_TERMINAL_CURSOR {}",
            serde_json::json!({
                "phase":phase,"replyEnabled":reply,"elapsedMillis":started.elapsed().as_millis(),
                "bytes":state.bytes,"queries":state.queries,"replies":state.replies,
                "pending":state.pending,"failed":state.failed,
                "cursorCoverage":if state.queries == 0 { "notCovered" } else { "observed" }
            })
        );
    }

    fn finish(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}

impl Drop for CursorConsumer {
    fn drop(&mut self) {
        // A panic never synthesizes cleanup. The existing parent still owns
        // the original child+Job+pipes and enforces the same 20s test budget.
        self.stop.store(true, Ordering::SeqCst);
    }
}

fn terminal_cursor_case(case: crate::platform_tests::windows_conpty::Case, reply: bool) {
    crate::platform_tests::windows_conpty::entered(case);
    let started = Instant::now();
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("terminal-started");
    let executable = crate::windows_process::helper_executable().unwrap();
    let manager = Arc::new(PtyManager::new());
    let (sink, mut cursor) = CursorConsumer::new(reply);
    cursor.phase("spawn.enter", reply, started);
    let id = manager
        .spawn(
            executable.to_str().unwrap(),
            &["wait".into(), marker.to_string_lossy().into_owned()],
            &[],
            dir.path(),
            PtySize {
                rows: 20,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            },
            sink,
        )
        .unwrap();
    cursor.phase("spawn.return", reply, started);
    // Spawn held the registry lock. Start the responder only after it returned;
    // already observed queries remain in its bounded queue.
    cursor.start(Arc::downgrade(&manager), id.clone(), reply);
    cursor.phase("session.lookup.enter", reply, started);
    let session = manager.lock().unwrap().get(&id).unwrap().clone();
    cursor.phase("session.lookup.return", reply, started);
    // This independent A/B holds the SAME extra owner in both arms. It lets
    // close.return and the later final master drop be observed separately.
    cursor.phase("marker.wait.enter", reply, started);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !marker.is_file() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    let observed = marker.is_file();
    cursor.phase(
        if observed {
            "marker.wait.observed"
        } else {
            "marker.wait.deadline"
        },
        reply,
        started,
    );
    if !observed {
        cursor.phase("marker.missing.close.enter", reply, started);
        let result = manager.close(&id);
        cursor.phase("marker.missing.close.return", reply, started);
        eprintln!(
            "FARFOLD_TERMINAL_CURSOR_CLOSE {}",
            serde_json::json!({
                "confirmedExisting":matches!(result,Ok(Some(_))),"error":result.is_err(),
                "sessionHeldAcrossClose":true
            })
        );
        cursor.phase("cursor.worker.finish.enter", reply, started);
        cursor.finish();
        cursor.phase("cursor.worker.finish.return", reply, started);
        cursor.phase("held.session.drop.enter", reply, started);
        drop(session);
        cursor.phase("held.session.drop.return", reply, started);
        cursor.phase("manager.drop.enter", reply, started);
        drop(manager);
        cursor.phase("manager.drop.return", reply, started);
        panic!("terminal fixture did not start; no successful cancellation proof");
    }
    let pid = session.pid.unwrap();
    cursor.phase("job.owns.enter", reply, started);
    assert!(crate::windows_process::owns(pid));
    cursor.phase("job.owns.return", reply, started);
    cursor.phase("close.enter", reply, started);
    assert!(manager.close(&id).unwrap().is_some());
    cursor.phase("close.return", reply, started);
    cursor.phase("job.inactive.check.enter", reply, started);
    assert!(!crate::windows_process::active(pid));
    cursor.phase("job.inactive.check.return", reply, started);
    cursor.phase("registry.check.enter", reply, started);
    assert!(!manager.lock().unwrap().contains_key(&id));
    cursor.phase("registry.check.return", reply, started);
    cursor.phase("cursor.worker.finish.enter", reply, started);
    cursor.finish();
    cursor.phase("cursor.worker.finish.return", reply, started);
    cursor.phase("held.session.drop.enter", reply, started);
    drop(session);
    cursor.phase("held.session.drop.return", reply, started);
    cursor.phase("manager.drop.enter", reply, started);
    drop(manager);
    cursor.phase("manager.drop.return", reply, started);
    let state = cursor.capture.lock().unwrap();
    assert!(!state.failed && state.pending == 0);
    if reply {
        assert!(
            state.queries > 0,
            "cursor response hypothesis not covered without a query"
        );
        assert_eq!(state.replies, state.queries);
    } else {
        assert_eq!(state.replies, 0);
    }
}

#[test]
#[ignore = "executed only by its owned A/B isolation wrapper"]
fn terminal_cancel_cursor_no_reply_child() {
    terminal_cursor_case(
        crate::platform_tests::windows_conpty::Case::TerminalCursorNoReply,
        false,
    );
}

#[test]
#[ignore = "executed only by its owned A/B isolation wrapper"]
fn terminal_cancel_cursor_reply_child() {
    terminal_cursor_case(
        crate::platform_tests::windows_conpty::Case::TerminalCursorReply,
        true,
    );
}

#[test]
#[ignore = "manual selected diagnostic; not part of the default Windows suite"]
fn terminal_cancel_cursor_no_reply_isolated() {
    crate::platform_tests::windows_conpty::run(
        crate::platform_tests::windows_conpty::Case::TerminalCursorNoReply,
    );
}

#[test]
#[ignore = "manual selected diagnostic; not part of the default Windows suite"]
fn terminal_cancel_cursor_reply_isolated() {
    crate::platform_tests::windows_conpty::run(
        crate::platform_tests::windows_conpty::Case::TerminalCursorReply,
    );
}

#[test]
fn terminal_cursor_query_recognizes_every_chunk_partition() {
    let input = b"x\x1b[6ny\x1b[6nz";
    for first in 0..=input.len() {
        for second in first..=input.len() {
            let mut state = CursorCapture::default();
            let count = state.feed(&input[..first])
                + state.feed(&input[first..second])
                + state.feed(&input[second..]);
            assert_eq!(count, 2);
            assert_eq!(state.queries, 2);
            assert!(state.tail.len() <= 3 && !state.failed);
        }
    }
    let mut state = CursorCapture::default();
    assert_eq!(input.iter().map(|b| state.feed(&[*b])).sum::<usize>(), 2);
}

#[test]
fn terminal_cursor_query_does_not_reply_to_unrelated_or_partial_sequences() {
    let mut state = CursorCapture::default();
    assert_eq!(state.feed(b"\x1b[5n\x1b[?6n6n\x1b[1;1R\x1b[6"), 0);
    assert_eq!(state.feed(b"X\x1b[6n"), 1);
    assert_eq!(state.queries, 1);
}

#[test]
fn terminal_cursor_query_limits_are_failures_not_successful_truncation() {
    let mut state = CursorCapture::default();
    assert_eq!(state.feed(&b"\x1b[6n".repeat(9)), 8);
    assert!(state.failed);
    let mut state = CursorCapture::default();
    assert_eq!(state.feed(&vec![b'x'; 1024 * 1024]), 0);
    assert!(!state.failed);
    assert_eq!(state.feed(b"x"), 0);
    assert!(state.failed);
}
