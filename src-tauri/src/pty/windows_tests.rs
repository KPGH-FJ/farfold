//! Actual ConPTY/Job behavior with a synthetic program on Windows.
use super::*;

#[test]
fn cancelling_a_windows_terminal_confirms_job_end_without_an_agent() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("terminal-started");
    let executable = crate::windows_process::helper_executable().unwrap();
    let manager = PtyManager::new();
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
    let deadline = Instant::now() + Duration::from_secs(5);
    while !marker.is_file() {
        if Instant::now() >= deadline {
            let _ = manager.close(&id);
            panic!("terminal fixture did not start");
        }
        thread::sleep(Duration::from_millis(20));
    }
    let session = manager.lock().unwrap().get(&id).unwrap().clone();
    let pid = session.pid.unwrap();
    assert!(crate::windows_process::owns(pid));
    assert!(manager.close(&id).unwrap().is_some());
    assert!(!crate::windows_process::active(pid));
    assert!(!manager.lock().unwrap().contains_key(&id));
}
