use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

async fn owner(agent: &str) -> Ownership {
    let attempt = crate::auth::attempts::reserve(agent, "first").unwrap();
    let configuration = attempt
        .configuration_guard(&crate::meta_store::MetaStore::test_memory())
        .await
        .unwrap();
    Ownership {
        output: Channel::new(|_| Ok(())),
        configuration,
        scope: crate::acp_client::manager::AccountScope::empty_for_test(),
        attempt,
    }
}

#[tokio::test]
async fn cancellation_before_configuration_acquisition_does_not_take_the_lock() {
    let agent = "cancel-before-auth-guard";
    crate::auth::attempts::auth_cancel(agent.into(), "first".into()).unwrap();
    let attempt = crate::auth::attempts::reserve(agent, "first").unwrap();
    let result = attempt
        .configuration_guard(&crate::meta_store::MetaStore::test_memory())
        .await;
    assert_eq!(result.err().as_deref(), Some("AUTH_CANCELLED"));
    drop(attempt);
    let _available = crate::install_job::configuration_guard(agent).await;
}

#[tokio::test]
async fn cancellation_while_waiting_for_configuration_ends_the_same_attempt() {
    let agent = "cancel-waiting-auth-guard";
    let held = crate::install_job::configuration_guard(agent).await;
    let attempt = crate::auth::attempts::reserve(agent, "first").unwrap();
    let store = crate::meta_store::MetaStore::test_memory();
    let waiting = attempt.configuration_guard(&store);
    tokio::pin!(waiting);
    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut waiting)
            .await
            .is_err()
    );
    crate::auth::attempts::auth_cancel(agent.into(), "first".into()).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(1), &mut waiting).await;
    drop(held);
    assert!(matches!(result, Ok(Err(ref error)) if error == "AUTH_CANCELLED"));
}

#[tokio::test]
async fn cancelled_declared_or_manual_login_does_not_read_environment_or_spawn() {
    for phase in ["before-environment", "after-environment"] {
        let agent = format!("cancel-terminal-{phase}");
        let owned = owner(&agent).await;
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("must-not-exist");
        let pty = crate::pty::PtyManager::new();
        let calls = AtomicUsize::new(0);
        if phase == "before-environment" {
            crate::auth::attempts::auth_cancel(agent.clone(), "first".into()).unwrap();
        }
        let result = run(
            &pty,
            &crate::platform_tests::python(),
            &[
                "-c".into(),
                "import pathlib,sys;pathlib.Path(sys.argv[1]).write_text('created')".into(),
                marker.display().to_string(),
            ],
            directory.path(),
            owned,
            || {
                calls.fetch_add(1, Ordering::SeqCst);
                crate::auth::attempts::auth_cancel(agent.clone(), "first".into()).unwrap();
                Ok(vec![])
            },
        );
        if let Ok(id) = &result {
            pty.await_exit(id).unwrap();
            pty.close(id).unwrap();
        }
        assert_eq!(result.err().as_deref(), Some("AUTH_CANCELLED"), "{phase}");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            usize::from(phase == "after-environment")
        );
        assert!(!marker.exists());
    }
}

#[tokio::test(flavor = "multi_thread")]
#[cfg_attr(windows, ignore = "Executed by the active owned Windows parent")]
async fn cancellation_after_spawn_keeps_the_original_exit_owner() {
    #[cfg(windows)]
    crate::platform_tests::windows_conpty::entered(
        crate::platform_tests::windows_conpty::Case::Cancellation,
    );
    let agent = "cancel-live-auth-terminal";
    let owned = owner(agent).await;
    #[cfg(windows)]
    let cursor_started = std::time::Instant::now();
    #[cfg(windows)]
    let (owned, mut cursor) = {
        let (output, cursor) = crate::platform_tests::windows_cursor::CursorConsumer::channel(true);
        (Ownership { output, ..owned }, cursor)
    };
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("pid");
    let pty = Arc::new(crate::pty::PtyManager::new());
    let id = run(
        &pty,
        &crate::platform_tests::python(),
        &[
            "-c".into(),
            "import pathlib,os,sys;pathlib.Path(sys.argv[1]).write_text(str(os.getpid()));input()"
                .into(),
            marker.display().to_string(),
        ],
        directory.path(),
        owned,
        || Ok(vec![]),
    )
    .unwrap();
    #[cfg(windows)]
    cursor.start(Arc::downgrade(&pty), id.clone(), true);
    #[cfg(windows)]
    crate::platform_tests::windows_conpty::environment();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !marker.exists() || std::fs::read_to_string(&marker).unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let pid: i32 = std::fs::read_to_string(marker).unwrap().parse().unwrap();
    #[cfg(windows)]
    let helper_pid = pty.retained_child_pid_for_test(&id);
    #[cfg(windows)]
    let job_witness = helper_pid
        .as_ref()
        .ok()
        .map(|pid| crate::windows_process::read_only_job_witness_for_test(*pid));
    #[cfg(windows)]
    let target =
        crate::platform_tests::held_process::HeldProcess::open(pid).unwrap_or_else(|error| {
            eprintln!(
                "FARFOLD_AUTH_CANCELLATION_TARGET {}",
                serde_json::json!({
                    "phase": "before_cancel.open_failed",
                    "pid": pid,
                    "requestedAccess": "SYNCHRONIZE|QUERY_LIMITED_INFORMATION",
                    "errorKind": format!("{:?}", error.kind()),
                    "nativeError": error.raw_os_error(),
                })
            );
            panic!("owned target process must be held before cancellation");
        });
    #[cfg(windows)]
    let before_job_complete = {
        let observed = target.observe();
        let exit_code = target.exit_code();
        use std::os::windows::io::AsRawHandle;
        let membership = job_witness
            .as_ref()
            .and_then(|result| result.as_ref().ok())
            .map(|witness| witness.observe(target.as_raw_handle()));
        let complete = membership.as_ref().is_some_and(|value| value.complete());
        eprintln!(
            "FARFOLD_AUTH_CANCELLATION_SAME_OWNER {}",
            serde_json::json!({
                "phase":"before_cancel.same_owner", "markerTargetPid":pid,
                "retainedChildHelperPid":helper_pid.as_ref().ok(),
                "helperPidAvailable":helper_pid.is_ok(),
                "jobWitnessCaptured":matches!(&job_witness,Some(Ok(_))),
                "jobWitnessCaptureError":job_witness.as_ref().and_then(|r|r.as_ref().err()).map(|e| {
                    serde_json::json!({"kind":format!("{:?}",e.kind()),"nativeError":e.raw_os_error()})
                }),
                "originalJob":membership,
                "targetExitCode":exit_code,
                "observationElapsedMicros":cursor_started.elapsed().as_micros().to_string(),
                "observationsAtomic":false,
                "targetWaitReturn":observed.return_code,"targetNativeError":observed.native_error,
                "authority":"same pre-cancel captured Job and same single held target; failed query is unknown"
            })
        );
        eprintln!(
            "FARFOLD_AUTH_CANCELLATION_TARGET {}",
            serde_json::json!({
                "phase": "before_cancel.held",
                "pid": pid,
                "requestedAccess": "SYNCHRONIZE|QUERY_LIMITED_INFORMATION",
                "waitReturn": observed.return_code,
                "nativeError": observed.native_error,
            })
        );
        assert!(
            observed.is_running(),
            "the owned target must still be running before cancellation: {observed:?}"
        );
        complete
    };
    crate::auth::attempts::auth_cancel(agent.into(), "first".into()).unwrap();
    let (finished, receive) = std::sync::mpsc::channel();
    let waiter = pty.clone();
    let waiting_id = id.clone();
    let thread = std::thread::spawn(move || {
        let _ = finished.send(waiter.await_exit(&waiting_id));
    });
    let outcome = receive.recv_timeout(Duration::from_secs(1));
    let close_outcome = pty.close(&id);
    thread.join().unwrap();
    // Capture this zero-time target wait BEFORE the new diagnostic logging or
    // Job queries; no diagnostic delay is inserted to make the target signaled.
    #[cfg(windows)]
    let after_wait = target.observe();
    #[cfg(windows)]
    let after_job_complete = {
        // The ORIGINAL after_wait above is already captured. This call and all
        // following diagnostics must never replace it in the original assert.
        let exit_code = target.exit_code();
        use std::os::windows::io::AsRawHandle;
        let membership = job_witness
            .as_ref()
            .and_then(|result| result.as_ref().ok())
            .map(|witness| witness.observe(target.as_raw_handle()));
        let complete = membership.as_ref().is_some_and(|value| value.complete());
        let await_result = match &outcome {
            Ok(Ok(code)) => serde_json::json!({"delivered":true,"inner":"exit","exitCode":code}),
            Ok(Err(error)) => serde_json::json!({"delivered":true,"inner":"error","error":error}),
            Err(error) => {
                serde_json::json!({"delivered":false,"receiveError":format!("{error:?}")})
            }
        };
        let close_result = match &close_outcome {
            Ok(code) => serde_json::json!({"result":"ok","exitCode":code}),
            Err(error) => serde_json::json!({"result":"error","error":error}),
        };
        eprintln!(
            "FARFOLD_AUTH_CANCELLATION_SAME_OWNER {}",
            serde_json::json!({
                "phase":"after_original_wait_and_join.same_owner", "markerTargetPid":pid,
                "retainedChildHelperPid":helper_pid.as_ref().ok(),
                "jobWitnessCaptured":matches!(&job_witness,Some(Ok(_))),
                "originalJob":membership,"awaitResult":await_result,"closeResult":close_result,
                "targetExitCode":exit_code,
                "observationElapsedMicros":cursor_started.elapsed().as_micros().to_string(),
                "observationsAtomic":false,
                "targetWaitReturn":after_wait.return_code,"targetNativeError":after_wait.native_error,
                "targetWaitCapturedBeforeNewLogging":true,
                "authority":"read-only witness, no new stop/reopen/retry; unknown never means ended"
            })
        );
        complete
    };
    #[cfg(not(windows))]
    let _ = close_outcome;
    assert!(
        outcome.is_ok(),
        "the same operation flag must reach the existing PTY owner"
    );
    #[cfg(not(windows))]
    assert_ne!(crate::platform_tests::process_check(pid), 0);
    #[cfg(windows)]
    {
        let observed = after_wait;
        eprintln!(
            "FARFOLD_AUTH_CANCELLATION_TARGET {}",
            serde_json::json!({
                "phase": "after_original_wait_and_join.held",
                "pid": pid,
                "waitReturn": observed.return_code,
                "nativeError": observed.native_error,
            })
        );
        // Preserve the old PID reopen as a companion value, never authority
        // for this held target. Its0 can mean either still live or denied.
        let pid_companion = crate::platform_tests::process_check(pid);
        eprintln!(
            "FARFOLD_AUTH_CANCELLATION_PID_COMPANION {}",
            serde_json::json!({
                "phase": "after_original_wait_and_join.pid_reopen",
                "value": pid_companion,
                "authority": "companion_only",
            })
        );
        assert!(
            observed.is_exited(),
            "the same held target must have exited after cancellation: {observed:?}"
        );
    }
    let _available = tokio::time::timeout(
        Duration::from_secs(1),
        crate::install_job::configuration_guard(agent),
    )
    .await
    .unwrap();
    #[cfg(windows)]
    {
        cursor.finish();
        cursor.phase("auth-cancellation.fixture.complete", true, cursor_started);
        cursor.assert_settled();
        // Keep all original cleanup/assertions first. Missing/failed queries
        // are explicitly incomplete, never an automatic diagnostic pass.
        if !before_job_complete || !after_job_complete {
            panic!("same-owner diagnostic incomplete: session/Job/membership/accounting unknown");
        }
    }
}

#[cfg(windows)]
#[test]
fn windows_cancellation_after_spawn_keeps_the_original_exit_owner_isolated() {
    crate::platform_tests::windows_conpty::run(
        crate::platform_tests::windows_conpty::Case::Cancellation,
    );
}

#[tokio::test]
async fn cancellation_during_failed_environment_read_keeps_cancelled_status() {
    let agent = "cancel-failed-environment-read";
    let owned = owner(agent).await;
    let directory = tempfile::tempdir().unwrap();
    let pty = crate::pty::PtyManager::new();
    let result = run(
        &pty,
        &crate::platform_tests::python(),
        &[],
        directory.path(),
        owned,
        || {
            crate::auth::attempts::auth_cancel(agent.into(), "first".into()).unwrap();
            Err("controlled environment read failure".into())
        },
    );
    assert_eq!(result.err().as_deref(), Some("AUTH_CANCELLED"));
    let _available = crate::install_job::configuration_guard(agent).await;
}
