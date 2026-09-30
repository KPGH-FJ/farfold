//! Actual OS spawn failure must not pre-empt the caller's chosen cancellation.
use super::*;
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
