//! Controlled subprocess receipts. No official Agent, account or user data.
#![cfg(unix)]
use super::*;

fn fixture(action: &str) -> Fixture {
    let f = Fixture::new();
    let peer = PEER.replace(
        "  elif '--reject-init' in sys.argv: send({'id':m['id'],'error':{'code':-32602,'message':'incompatible fixture'}})",
        &format!("  elif '--reject-init' in sys.argv: {action}"),
    );
    assert_ne!(peer, PEER);
    std::fs::write(f.cwd.join("peer.py"), peer).unwrap();
    f
}

async fn summary(f: &Fixture) -> serde_json::Value {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let mut latest = None;
            for entry in std::fs::read_dir(f.cwd.join("logs")).unwrap() {
                let body = std::fs::read_to_string(entry.unwrap().path()).unwrap();
                assert!(!body.contains("startup-sensitive-canary"));
                assert!(!body.contains("peer.py"));
                for line in body.lines() {
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(line)
                        && value["event"] == "startup"
                        && value["connectionRemoved"] == true
                        && value["startupOutcome"] != "unknown"
                    {
                        latest = Some(value);
                    }
                }
            }
            if let Some(value) = latest {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("bounded final startup summary")
}

async fn probe(f: &Fixture) -> Result<(), String> {
    let mut row = f.row.clone();
    row.args.push("--reject-init".into());
    let result = f
        .manager
        .probe_launch(&row, &f.store, std::future::pending())
        .await;
    assert_eq!(f.store.get_agent(&f.row.id).unwrap().unwrap(), f.row);
    assert!(!f.manager.candidate_pending(&f.row.id).unwrap());
    result
}

#[tokio::test(flavor = "multi_thread")]
async fn startup_diagnostics_instant_result_is_matched_and_decode_is_separate() {
    let f = fixture("reply(m,{'protocolVersion':1,'agentCapabilities':{},'authMethods':[]})");
    probe(&f).await.unwrap();
    let value = summary(&f).await;
    assert_eq!(value["initializeResponse"], "matched_result");
    assert_eq!(value["initializeAccepted"], true);
    assert_eq!(value["startupOutcome"], "success");
    assert_eq!(value["childReaped"], true);
    assert_eq!(value["groupEnded"], true);
    assert!(value.get("id").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn startup_diagnostics_error_response_has_no_error_body() {
    let f = fixture(
        "send({'id':m['id'],'error':{'code':-32602,'message':'startup-sensitive-canary','data':{'path':'startup-sensitive-canary'}}})",
    );
    assert_eq!(probe(&f).await.unwrap_err(), "AGENT_INITIALIZE_FAILED");
    let value = summary(&f).await;
    assert_eq!(value["initializeResponse"], "matched_error");
    assert_eq!(value["initializeAccepted"], false);
    assert_eq!(value["startupOutcome"], "failed");
}

#[tokio::test(flavor = "multi_thread")]
async fn startup_diagnostics_malformed_result_is_observed_but_not_accepted() {
    let f = fixture("reply(m,{'protocolVersion':'startup-sensitive-canary'})");
    assert_eq!(probe(&f).await.unwrap_err(), "AGENT_INITIALIZE_FAILED");
    let value = summary(&f).await;
    assert_eq!(value["initializeResponse"], "matched_result");
    assert_eq!(value["initializeAccepted"], false);
    assert_eq!(value["failurePhase"], "initialize");
}

#[tokio::test(flavor = "multi_thread")]
async fn startup_diagnostics_observes_actual_exit_code_without_stderr() {
    let f =
        fixture("sys.stderr.write('startup-sensitive-canary'); sys.stderr.flush(); sys.exit(3)");
    assert_eq!(probe(&f).await.unwrap_err(), "AGENT_CONNECTION_ENDED");
    let value = summary(&f).await;
    assert_eq!(value["initializeResponse"], "not_observed");
    assert_eq!(value["exitCode"], 3);
    assert_eq!(value["exitSignal"], serde_json::Value::Null);
    assert_eq!(value["childReaped"], true);
}

#[tokio::test(flavor = "multi_thread")]
async fn startup_diagnostics_spawn_failure_is_not_reap_or_signal() {
    let f = Fixture::new();
    let mut row = f.row.clone();
    row.command = f.cwd.join("startup-sensitive-canary").display().to_string();
    assert_eq!(
        f.manager
            .probe_launch(&row, &f.store, std::future::pending())
            .await
            .unwrap_err(),
        "AGENT_START_FAILED"
    );
    let value = summary(&f).await;
    assert_eq!(value["startupOutcome"], "start_failed");
    assert_eq!(value["failurePhase"], "spawn");
    assert_eq!(value["childReaped"], false);
    assert_eq!(value["termRequested"], false);
    assert_eq!(value["killRequested"], false);
    assert_eq!(value["exitCode"], serde_json::Value::Null);
    assert_eq!(value["exitSignal"], serde_json::Value::Null);
}

#[tokio::test(flavor = "multi_thread")]
async fn startup_diagnostics_actual_signal_is_distinct_from_our_cleanup_request() {
    let f = fixture("os.kill(os.getpid(),signal.SIGUSR1)");
    assert_eq!(probe(&f).await.unwrap_err(), "AGENT_CONNECTION_ENDED");
    let value = summary(&f).await;
    assert_eq!(value["exitSignal"], libc::SIGUSR1);
    assert_eq!(value["exitCode"], serde_json::Value::Null);
    assert_eq!(value["termRequested"], true);
    assert_eq!(value["killRequested"], false);
    // EOF/stop may win before the owner observes status. The actual signal is
    // evidence; its relationship to our TERM request must not be inferred.
    assert!(value["exitObservedBeforeTerm"].is_boolean());
}

#[tokio::test(flavor = "multi_thread")]
async fn startup_diagnostics_cancel_is_not_changed_by_late_reply_or_kill() {
    let f = fixture(
        "signal.signal(signal.SIGTERM,signal.SIG_IGN); open(sys.argv[1]+'_waiting','w').write(str(os.getpid())); time.sleep(.2); reply(m,{'protocolVersion':1,'agentCapabilities':{},'authMethods':[]}); open(sys.argv[1]+'_late','w').write('late')",
    );
    let mut row = f.row.clone();
    row.args.push("--reject-init".into());
    let marker = f.cwd.join("listed_waiting");
    assert!(
        f.manager
            .probe_launch(&row, &f.store, async {
                until(|| marker.exists()).await;
            })
            .await
            .unwrap_err()
            .contains("取消")
    );
    assert!(f.cwd.join("listed_late").exists());
    let value = summary(&f).await;
    assert_eq!(value["startupOutcome"], "cancelled");
    // A late decode remains an observation, not a successful caller outcome.
    assert_eq!(value["initializeAccepted"], true);
    assert_eq!(value["initializeResponse"], "matched_result");
    assert_eq!(value["termRequested"], true);
    assert_eq!(value["killRequested"], true);
    assert_eq!(value["exitSignal"], libc::SIGKILL);
    assert_eq!(f.store.get_agent(&f.row.id).unwrap().unwrap(), f.row);
}

#[tokio::test(flavor = "multi_thread")]
async fn startup_diagnostics_reusing_ready_connection_does_not_create_another_tap() {
    let f = Fixture::new();
    f.connect().await;
    let count = || std::fs::read_dir(f.cwd.join("logs")).unwrap().count();
    let before = count();
    assert_eq!(before, 1);
    for _ in 0..40 {
        f.manager.connect(&f.row, &f.cwd, &f.store).await.unwrap();
    }
    assert_eq!(count(), before);
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
    let mut initializes = 0;
    for entry in std::fs::read_dir(f.cwd.join("logs")).unwrap() {
        for line in std::fs::read_to_string(entry.unwrap().path())
            .unwrap()
            .lines()
        {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line)
                && v["event"] == "initialize"
                && v["dir"] == "out"
            {
                initializes += 1;
            }
        }
    }
    assert_eq!(initializes, 1);
}
