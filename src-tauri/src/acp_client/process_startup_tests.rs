//! Actual OS spawn failure must not pre-empt the caller's chosen cancellation.
use super::*;

fn nonzero_child() -> async_process::Child {
    #[cfg(unix)]
    let mut command = {
        let mut command = async_process::Command::new("/bin/sh");
        command.args(["-c", "exit 17"]);
        command
    };
    #[cfg(windows)]
    let mut command = {
        let mut command =
            async_process::Command::new(crate::windows_process::helper_executable().unwrap());
        // This synthetic fixture rejects unknown modes without spawning work.
        command.arg("nonzero-exit-observation");
        command
    };
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap()
}

#[tokio::test]
async fn exit_observation_respects_already_ready_process_and_connection_stop() {
    for connection in [false, true] {
        let (stop_tx, mut stop) = watch::channel(false);
        let (connection_tx, mut connection_stop) = watch::channel(false);
        let mut child = nonzero_child();
        let exited = tokio::time::timeout(Duration::from_secs(5), child.status())
            .await
            .unwrap()
            .unwrap();
        assert!(!exited.success());
        if connection {
            connection_tx.send_replace(true);
        } else {
            stop_tx.send_replace(true);
        }
        assert!(stop.has_changed().unwrap() || connection_stop.has_changed().unwrap());
        // Both futures are ready; deterministically exercise the exit branch
        // that an unbiased production select may also choose after user stop.
        let observed = tokio::select! {
            biased;
            value = child.status() => observe_exit(value, &stop, &connection_stop),
            _ = stop.changed() => panic!("cached child exit must be ready"),
            _ = connection_stop.changed() => panic!("cached child exit must be ready"),
        };
        assert!(!observed.0.unwrap().success());
        assert!(
            !observed.1,
            "an already visible stop makes this exit expected"
        );
    }
}

#[tokio::test]
async fn later_stop_does_not_erase_an_already_observed_unexpected_exit() {
    let (stop_tx, stop) = watch::channel(false);
    let (connection_tx, connection_stop) = watch::channel(false);
    let mut child = nonzero_child();
    let status = tokio::time::timeout(Duration::from_secs(5), child.status())
        .await
        .unwrap();
    let observed = observe_exit(status, &stop, &connection_stop);
    assert!(!observed.0.as_ref().unwrap().success());
    assert!(observed.1);
    stop_tx.send_replace(true);
    connection_tx.send_replace(true);
    assert!(
        observed.1,
        "cleanup intent cannot rewrite the earlier exit observation"
    );
}

#[test]
fn startup_diagnostics_cancel_selected_after_spawn_failure_keeps_cancelled_outcome() {
    let dir = tempfile::tempdir().unwrap();
    let logs = dir.path().join("logs");
    let diagnostics = Diagnostics::open(&logs, "fixture");
    let control = ProcessControl::new(diagnostics.clone());
    let agent = AcpAgent::new(agent_client_protocol::AcpAgentConfig::new(
        dir.path().join("missing-canary"),
    ));
    assert!(spawn_process_in(&agent, dir.path(), &control).is_err());
    assert!(control.start_failed());
    // The probe's biased branch selects cancellation when both are ready.
    diagnostics.outcome(super::super::startup_diagnostics::Outcome::Cancelled);
    let until = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        let mut observed = None;
        for file in std::fs::read_dir(&logs).unwrap() {
            let text = std::fs::read_to_string(file.unwrap().path()).unwrap();
            assert!(!text.contains("missing-canary"));
            for line in text.lines() {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(line)
                    && v["event"] == "startup"
                    && v["startupOutcome"] != "unknown"
                {
                    observed = Some(v);
                }
            }
        }
        if let Some(value) = observed {
            assert_eq!(value["startupOutcome"], "cancelled");
            assert_eq!(value["childStarted"], false);
            break;
        }
        assert!(std::time::Instant::now() < until);
        std::thread::sleep(Duration::from_millis(5));
    }
}
