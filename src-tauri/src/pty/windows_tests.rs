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
    let manager = Arc::new(PtyManager::new());
    let (sink, mut cursor) = CursorConsumer::new(true);
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
            sink,
        )
        .unwrap();
    terminal_cancel_phase("spawn.return", started);
    cursor.start(Arc::downgrade(&manager), id.clone(), true);
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
    // Keep the test-only legal cursor consumer alive through real master Drop.
    cursor.finish();
    cursor.phase("original-positive.fixture.complete", true, started);
    {
        let state = cursor.capture.lock().unwrap();
        assert!(!state.failed && state.pending == 0);
        assert_eq!(state.replies, state.queries);
    }
    // Original successful-path references retain their original drop order.
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

// Independent A/B diagnostics. The four original assertions above are retained;
// the positive body now uses the same legal cursor consumer. Both prior failed
// runs remain evidence and are not replaced by these new observations.
use crate::platform_tests::windows_cursor::{CursorCapture, CursorConsumer};

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
    if case == crate::platform_tests::windows_conpty::Case::TerminalPendingCursorClose {
        assert!(
            !observed,
            "a pending query must hold the fixture before readiness"
        );
        {
            let state = cursor.capture.lock().unwrap();
            assert_eq!(state.queries, 1);
            assert_eq!(state.replies, 0);
            assert!(!state.failed);
        }
        let pid = session.pid.unwrap();
        assert!(crate::windows_process::owns(pid));
        assert!(manager.close(&id).unwrap().is_some());
        assert!(!crate::windows_process::active(pid));
        assert!(!manager.lock().unwrap().contains_key(&id));
        assert_eq!(manager.close(&id).unwrap(), None);
        assert_eq!(cursor.capture.lock().unwrap().replies, 0);
        cursor.finish();
        eprintln!("FARFOLD_TERMINAL_PENDING_CURSOR_CLOSE confirmed=true");
        return;
    }
    if !observed {
        cursor.phase("marker.missing.close.enter", reply, started);
        let result = manager.close(&id);
        cursor.phase("marker.missing.close.return", reply, started);
        let master_taken = session.master.lock().unwrap().is_none();
        eprintln!(
            "FARFOLD_TERMINAL_CURSOR_OWNER_STATE {}",
            serde_json::json!({
                "masterTaken":master_taken,
                "jobActive":crate::windows_process::active(session.pid.unwrap()),
                "exitConfirmed":session.exit.0.lock().unwrap().is_some()
            })
        );
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
#[ignore = "executed only by the bounded owned isolation wrapper"]
fn terminal_close_pending_cursor_child() {
    terminal_cursor_case(
        crate::platform_tests::windows_conpty::Case::TerminalPendingCursorClose,
        false,
    );
}

#[test]
#[ignore = "manual native regression for runners with a blocking ConPTY cursor handshake"]
fn terminal_close_confirms_exit_with_unanswered_startup_cursor() {
    crate::platform_tests::windows_conpty::run(
        crate::platform_tests::windows_conpty::Case::TerminalPendingCursorClose,
    );
}

use crate::platform_tests::{held_process::HeldProcess, windows_conpty::Case};

type StartupChild = Arc<Mutex<Option<HeldProcess>>>;

struct CancelOnNativeSpawn {
    stop: Arc<AtomicBool>,
    observed_child: StartupChild,
}

impl portable_pty::PtySystem for CancelOnNativeSpawn {
    fn openpty(&self, size: PtySize) -> anyhow::Result<portable_pty::PtyPair> {
        let mut pair = native_pty_system().openpty(size)?;
        pair.slave = Box::new(CancelOnNativeSlave {
            inner: pair.slave,
            stop: self.stop.clone(),
            observed_child: self.observed_child.clone(),
        });
        Ok(pair)
    }
}

struct CancelOnNativeSlave {
    inner: Box<dyn portable_pty::SlavePty + Send>,
    stop: Arc<AtomicBool>,
    observed_child: StartupChild,
}

impl portable_pty::SlavePty for CancelOnNativeSlave {
    fn spawn_command(
        &self,
        command: CommandBuilder,
    ) -> anyhow::Result<Box<dyn portable_pty::Child + Send + Sync>> {
        let child = self.inner.spawn_command(command)?;
        let held = child
            .process_id()
            .and_then(|pid| HeldProcess::open(pid as i32).ok())
            .filter(|held| held.observe().is_running());
        let observed_running = held.is_some();
        *self.observed_child.lock().unwrap() = held;
        // After real ConPTY spawn, before startup_owner can attach and publish.
        self.stop.store(true, Ordering::SeqCst);
        eprintln!(
            "FARFOLD_TERMINAL_STARTUP_CANCEL nativeSpawnReturned=true heldRunning={observed_running}"
        );
        Ok(child)
    }
}

#[test]
#[ignore = "executed by the bounded native startup-cancellation wrapper"]
fn terminal_cancel_before_publication_child() {
    use super::startup_owner::{self, Engines, Launch};
    use std::sync::atomic::AtomicUsize;

    crate::platform_tests::windows_conpty::entered(Case::TerminalCancelBeforePublication);
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("terminal-started");
    let executable = crate::windows_process::helper_executable().unwrap();
    let manager = PtyManager::new();
    let stop = Arc::new(AtomicBool::new(false));
    let observed_child = StartupChild::default();
    let probe = CancelOnNativeSpawn {
        stop: stop.clone(),
        observed_child: observed_child.clone(),
    };
    let exits = Arc::new(AtomicUsize::new(0));
    let counted_exits = exits.clone();
    let (cursor_sink, cursor) = CursorConsumer::new(false);
    let capture = cursor.capture.clone();
    let mut engines = Engines::native();
    engines.system = Box::new(move || Box::new(probe));
    let result = startup_owner::begin(
        &manager,
        Launch {
            command: executable.to_str().unwrap().into(),
            args: vec!["wait".into(), marker.to_str().unwrap().into()],
            env: Vec::new(),
            cwd: directory.path().into(),
            size: PtySize::default(),
            output: Arc::new(move |frame| {
                if frame.get("exit").is_some() {
                    counted_exits.fetch_add(1, Ordering::SeqCst);
                }
                cursor_sink(frame);
            }),
        },
        stop.clone(),
        crate::managed_update::activity().unwrap(),
        CLOSE_TIMEOUT,
        engines,
    );
    let exited = observed_child
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|child| child.observe().is_exited());
    let published = !manager.lock().unwrap().is_empty();
    let quiescent = manager.startup.wait_quiescent(Duration::ZERO);
    let exit_frames = exits.load(Ordering::SeqCst);
    let cancelled = result
        .as_ref()
        .is_err_and(|error| error == "AUTH_CANCELLED");
    eprintln!(
        "FARFOLD_TERMINAL_STARTUP_CANCEL {}",
        serde_json::json!({
            "cancelledAfterCleanup": cancelled,
            "startupResult": result,
            "heldChildExited": exited,
            "terminalPublished": published,
            "startupQuiescent": quiescent,
            "exitFrames": exit_frames,
            "observedQueries": capture.lock().unwrap().queries,
        })
    );
    assert!(stop.load(Ordering::SeqCst));
    assert!(cancelled, "{result:?}");
    assert!(exited && !published && quiescent);
    assert_eq!(exit_frames, 1);
}

#[test]
#[ignore = "manual native regression for cancellation during real ConPTY startup"]
fn terminal_cancel_after_native_spawn_before_publication_isolated() {
    crate::platform_tests::windows_conpty::run(Case::TerminalCancelBeforePublication);
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

// New manual diagnostic for the master-owner contract. Old CI2 A/B arms above
// remain unchanged. This body deliberately stays alive after a valid unknown
// observation so the exact isolation owner must prove bounded external cleanup.
#[derive(serde::Serialize)]
struct BoundedUnknownReceipt {
    case: &'static str,
    marker_observed: bool,
    cursor_queries: usize,
    cursor_replies: usize,
    cursor_pending: usize,
    cursor_failed: bool,
    close_returned_error: bool,
    close_elapsed_millis: u128,
    registry_retained: bool,
    registry_reference_count: usize,
    exit_receipt_absent: bool,
    exit_frames_observed: usize,
    master_transferred: bool,
    activity_blocked: bool,
    stop_requested: bool,
    group_owner_known: bool,
    group_inactive: bool,
    process_not_running: bool,
}
#[test]
#[ignore = "new bounded-unknown body; only its manual exact isolation wrapper"]
fn terminal_master_drop_retains_bounded_unknown_child() {
    use crate::platform_tests::windows_conpty::Case;
    use std::sync::atomic::AtomicUsize;
    crate::platform_tests::windows_conpty::entered(Case::TerminalMasterBoundedUnknown);
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("terminal-started");
    let executable = crate::windows_process::helper_executable().unwrap();
    let manager = Arc::new(PtyManager::new());
    let exits = Arc::new(AtomicUsize::new(0));
    let observed_exits = exits.clone();
    let (observe_cursor, mut cursor) = CursorConsumer::new(false);
    let sink: PtySink = Arc::new(move |frame| {
        if frame.get("exit").is_some() {
            observed_exits.fetch_add(1, Ordering::SeqCst);
        }
        observe_cursor(frame);
    });
    let id = manager
        .spawn(
            executable.to_str().unwrap(),
            &["wait".into(), marker.to_string_lossy().into_owned()],
            &[],
            directory.path(),
            PtySize::default(),
            sink,
        )
        .unwrap();
    cursor.start(Arc::downgrade(&manager), id.clone(), false);
    let query_deadline = Instant::now() + Duration::from_secs(5);
    while cursor.capture.lock().unwrap().queries == 0 && Instant::now() < query_deadline {
        thread::sleep(Duration::from_millis(10));
    }
    // No extra PtySession Arc crosses close: the registry is the only UI owner.
    let pid = manager.lock().unwrap().get(&id).unwrap().pid.unwrap();
    let began = Instant::now();
    let close = manager.close(&id);
    let close_elapsed = began.elapsed();
    let (registry_retained, refs, exit_absent, transferred, stop_requested) = {
        let sessions = manager.lock().unwrap();
        match sessions.get(&id) {
            Some(session) => (
                true,
                Arc::strong_count(session),
                session.exit.0.try_lock().is_ok_and(|v| v.is_none()),
                session.master.try_lock().is_ok_and(|v| v.is_none()),
                session.stop.load(Ordering::SeqCst),
            ),
            None => (false, 0, false, false, false),
        }
    };
    let state = cursor.capture.lock().unwrap();
    let receipt = BoundedUnknownReceipt {
        case: "TerminalMasterBoundedUnknown",
        marker_observed: marker.is_file(),
        cursor_queries: state.queries,
        cursor_replies: state.replies,
        cursor_pending: state.pending,
        cursor_failed: state.failed,
        close_returned_error: close.is_err(),
        close_elapsed_millis: close_elapsed.as_millis(),
        registry_retained,
        registry_reference_count: refs,
        exit_receipt_absent: exit_absent,
        exit_frames_observed: exits.load(Ordering::SeqCst),
        master_transferred: transferred,
        activity_blocked: crate::managed_update::exclusive().is_err(),
        stop_requested,
        group_owner_known: crate::windows_process::owns(pid),
        group_inactive: !crate::windows_process::active(pid),
        process_not_running: crate::platform_tests::process_check(pid as i32) != 0,
    };
    drop(state);
    eprintln!(
        "FARFOLD_TERMINAL_BOUNDED_UNKNOWN {}",
        serde_json::to_string(&receipt).unwrap()
    );
    // A missing query, fast unrelated error, premature exit/sink or extra owner
    // is not the bounded-unknown observation and must fail before parking.
    assert!(!receipt.marker_observed && receipt.cursor_queries > 0 && receipt.cursor_queries <= 8);
    assert!(receipt.cursor_replies == 0 && receipt.cursor_pending == 0 && !receipt.cursor_failed);
    assert!(
        receipt.close_returned_error
            && close_elapsed >= CLOSE_TIMEOUT.saturating_sub(Duration::from_millis(100))
            && close_elapsed <= CLOSE_TIMEOUT + Duration::from_secs(2)
    );
    assert!(receipt.registry_retained && receipt.registry_reference_count == 1);
    assert!(receipt.exit_receipt_absent && receipt.exit_frames_observed == 0);
    assert!(receipt.master_transferred && receipt.activity_blocked && receipt.stop_requested);
    assert!(receipt.group_owner_known && receipt.group_inactive && receipt.process_not_running);
    eprintln!("FARFOLD_TERMINAL_BOUNDED_UNKNOWN_PARK TerminalMasterBoundedUnknown");
    // The real owner remains blocked with its ActivityPermit, not a test-held
    // substitute permit. The existing isolated parent owns this process+Job.
    loop {
        thread::park();
    }
}
#[test]
#[ignore = "manual selected bounded-unknown diagnostic; expected observation is not test pass"]
fn terminal_master_drop_retains_bounded_unknown_isolated() {
    crate::platform_tests::windows_conpty::run(
        crate::platform_tests::windows_conpty::Case::TerminalMasterBoundedUnknown,
    );
}
