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
