//! Actual selected helper/descendant processes in the executor's original Job.
//! These use only synthetic argv gates, never an Agent or production test hook.
use super::*;
use std::{
    cell::RefCell,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    sync::mpsc::{self, Receiver, RecvTimeoutError, Sender},
};
use windows_sys::Win32::Foundation::{GetLastError, WAIT_FAILED, WAIT_OBJECT_0};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    WaitForSingleObject,
};

// The executing test thread requests one observation of the real branch. This
// does not affect the production query, process ownership, bounds or behavior.
type ExitReceipt = (u32, Option<i32>);
thread_local! {
    static EXIT_OBSERVER: RefCell<Option<Sender<ExitReceipt>>> = const { RefCell::new(None) };
}
struct ExitObservation;
impl ExitObservation {
    fn new(sender: Sender<ExitReceipt>) -> Self {
        EXIT_OBSERVER.with(|slot| assert!(slot.replace(Some(sender)).is_none()));
        Self
    }
}
impl Drop for ExitObservation {
    fn drop(&mut self) {
        EXIT_OBSERVER.with(|slot| slot.take());
    }
}
pub(super) fn observed_active_after_original_exit(pid: u32, code: Option<i32>) {
    if let Some(sender) = EXIT_OBSERVER.with(|slot| slot.take()) {
        let _ = sender.send((pid, code));
    }
}

fn observed_handle(directory: &Path, name: &str) -> (u32, OwnedHandle) {
    let deadline = Instant::now() + Duration::from_secs(5);
    let pid = loop {
        if let Ok(pid) = std::fs::read_to_string(directory.join(name))
            .unwrap_or_default()
            .parse::<u32>()
        {
            break pid;
        }
        assert!(
            Instant::now() < deadline,
            "fixture readiness expired: {name}"
        );
        thread::sleep(Duration::from_millis(5));
    };
    // Both selected processes are still behind actual fixture gates. Hold the
    // exact process object before releasing either, never reopen a dead PID.
    let raw = unsafe {
        OpenProcess(
            PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            pid,
        )
    };
    assert!(!raw.is_null());
    (pid, unsafe { OwnedHandle::from_raw_handle(raw) })
}
fn exited(process: &OwnedHandle) -> bool {
    unsafe { WaitForSingleObject(process.as_raw_handle(), 0) == 0 }
}
fn finish_exited(process: &OwnedHandle, role: &'static str) -> bool {
    // Observe the SAME previously held object once, at the original assertion
    // boundary. A false bool alone cannot distinguish TIMEOUT from WAIT_FAILED.
    let wait = unsafe { WaitForSingleObject(process.as_raw_handle(), 0) };
    if wait == WAIT_OBJECT_0 {
        return true;
    }
    let wait_error = (wait == WAIT_FAILED).then(|| unsafe { GetLastError() });
    let mut exit_code = 0;
    let queried = unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut exit_code) };
    let query_error = (queried == 0).then(|| unsafe { GetLastError() });
    eprintln!(
        "FARFOLD_WINDOWS_GIT_FINISH_HELD_PROCESS {}",
        serde_json::json!({
            "phase": "executorReturnedBeforeHeldProcessSignaled",
            "role": role,
            "waitReturn": wait,
            "waitError": wait_error,
            "exitCodeQuerySucceeded": queried != 0,
            "exitCode": (queried != 0).then_some(exit_code),
            "exitCodeQueryError": query_error,
            "scope": "single zero-wait of the original test-held process handle; no reopen or retry",
        })
    );
    false
}
struct Running<'a> {
    directory: &'a Path,
    result: Receiver<Result<Output>>,
    descendant: OwnedHandle,
    original: OwnedHandle,
    cancel: &'a AtomicBool,
}
impl Running<'_> {
    fn release(&self, gate: &str) {
        std::fs::write(self.directory.join(gate), "release").unwrap();
    }
    fn still_owned(&self) {
        assert!(exited(&self.original));
        assert!(!exited(&self.descendant));
        assert!(
            matches!(
                self.result.recv_timeout(Duration::from_millis(150)),
                Err(RecvTimeoutError::Timeout)
            ),
            "executor returned while the original Job descendant was held"
        );
        assert!(!exited(&self.descendant));
    }
    fn finish(&self) -> Result<Output> {
        let result = self.result.recv_timeout(Duration::from_secs(10)).unwrap();
        // A result (including errors) cannot release the caller while either
        // original observed process still runs. No guessed PID is terminated.
        assert!(finish_exited(&self.original, "original"));
        assert!(finish_exited(&self.descendant, "descendant"));
        result
    }
}
struct CancelOnDrop<'a>(&'a AtomicBool);
impl Drop for CancelOnDrop<'_> {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}
fn after_original_exit(action: &str, code: i32, timeout: Duration, test: impl FnOnce(Running<'_>)) {
    let directory = tempfile::tempdir().unwrap();
    let cancel = AtomicBool::new(false);
    thread::scope(|scope| {
        let (sender, result) = mpsc::channel();
        let (stage_sender, stage_receiver) = mpsc::channel();
        let path = directory.path();
        let cancel = &cancel;
        scope.spawn(move || {
            let _observation = ExitObservation::new(stage_sender);
            let mut command = Command::new(crate::windows_process::helper_executable().unwrap());
            command
                .arg("settlement-parent")
                .arg(path)
                .arg(action)
                .arg(code.to_string());
            let input = Input::from_bytes(b"finite input", 64, cancel).unwrap();
            let output = execute_command_input(command, input, cancel, timeout);
            // The scope always joins after its exact owner is cancelled; a
            // failed assertion cannot leave a synthetic process behind.
            let _ = sender.send(output);
        });
        let _cancel_on_drop = CancelOnDrop(cancel);
        let (original_pid, original) = observed_handle(path, "helper-pid");
        let (_, descendant) = observed_handle(path, "descendant-pid");
        assert!(!exited(&original));
        assert!(!exited(&descendant));
        std::fs::write(path.join("parent-release"), "release").unwrap();
        assert_eq!(
            unsafe { WaitForSingleObject(original.as_raw_handle(), 5_000) },
            0
        );
        // A sleep alone cannot prove the executor reached the original bug.
        // This receipt follows its actual original-child exit and same-Job
        // active query. Until here the descendant remains behind its gate.
        assert_eq!(
            stage_receiver.recv_timeout(Duration::from_secs(5)).unwrap(),
            (original_pid, Some(code))
        );
        eprintln!("FARFOLD_WINDOWS_GIT_ORIGINAL_EXITED_WITH_HELD_DESCENDANT action={action}");
        test(Running {
            directory: path,
            result,
            descendant,
            original,
            cancel,
        });
    });
}

#[test]
fn original_exit_waits_for_same_job_natural_end_and_collects_descendant_tail() {
    after_original_exit("tail", 0, Duration::from_secs(10), |run| {
        run.still_owned();
        run.release("descendant-release");
        run.release("finish-release");
        let output = run.finish().unwrap();
        assert!(output.success);
        assert_eq!(output.code, Some(0));
        assert_eq!(output.bytes, b"selected-output\ndescendant-output\n");
    });
}

#[test]
fn naturally_settled_job_preserves_original_nonzero_exit_code() {
    after_original_exit("tail", 13, Duration::from_secs(10), |run| {
        run.still_owned();
        run.release("descendant-release");
        run.release("finish-release");
        let output = run.finish().unwrap();
        assert!(!output.success);
        assert_eq!(output.code, Some(13));
        assert_eq!(output.bytes, b"selected-output\ndescendant-output\n");
    });
}

#[test]
fn cancellation_after_original_exit_reaps_same_job_before_return() {
    after_original_exit("tail", 0, Duration::from_secs(10), |run| {
        run.still_owned();
        run.cancel.store(true, Ordering::SeqCst);
        assert_eq!(run.finish().err().unwrap().code, "cancelled");
    });
}

#[test]
fn original_deadline_still_limits_live_job_after_original_exit() {
    let started = Instant::now();
    after_original_exit("tail", 0, Duration::from_secs(3), |run| {
        run.still_owned();
        assert_eq!(run.finish().err().unwrap().code, "waitExpired");
    });
    assert!(started.elapsed() >= Duration::from_secs(3));
}

#[test]
fn late_stdout_over_limit_after_original_exit_is_not_success() {
    after_original_exit("stdout", 0, Duration::from_secs(10), |run| {
        run.still_owned();
        run.release("descendant-release");
        assert_eq!(run.finish().err().unwrap().code, "tooLarge");
    });
}

#[test]
fn late_stderr_over_limit_after_original_exit_is_not_success() {
    after_original_exit("stderr", 0, Duration::from_secs(10), |run| {
        run.still_owned();
        run.release("descendant-release");
        assert_eq!(run.finish().err().unwrap().code, "tooLarge");
    });
}

#[test]
fn changed_finite_input_after_original_exit_is_not_success() {
    after_original_exit("input", 0, Duration::from_secs(10), |run| {
        run.still_owned();
        run.release("descendant-release");
        assert_eq!(run.finish().err().unwrap().code, "changed");
    });
}
