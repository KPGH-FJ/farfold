//! Real controlled subprocesses; these do not execute an external Agent.
#![cfg(unix)]
use super::*;

const CANARY: &str = "fixture-sensitive-startup-canary";

fn startup_fixture(action: &str) -> Fixture {
    let fixture = Fixture::new();
    let code = PEER.replace(
        "  elif '--reject-init' in sys.argv: send({'id':m['id'],'error':{'code':-32602,'message':'incompatible fixture'}})",
        &format!("  elif '--reject-init' in sys.argv: {action}"),
    );
    assert_ne!(code, PEER);
    std::fs::write(fixture.cwd.join("peer.py"), code).unwrap();
    fixture
}

fn assert_old_target_and_safe_diagnostics(fixture: &Fixture) {
    assert_eq!(
        fixture.store.get_agent(&fixture.row.id).unwrap().unwrap(),
        fixture.row
    );
    assert!(!fixture.manager.candidate_pending(&fixture.row.id).unwrap());
    assert!(fixture.manager.status(&fixture.row.id).unwrap().is_empty());
    for path in std::fs::read_dir(fixture.cwd.join("logs")).unwrap() {
        let body = std::fs::read_to_string(path.unwrap().path()).unwrap();
        assert!(!body.contains(CANARY));
        assert!(!body.contains("sensitive-file.py"));
    }
}

async fn failed_candidate(fixture: &Fixture) -> String {
    let mut candidate = fixture.row.clone();
    candidate.args.push("--reject-init".into());
    fixture
        .manager
        .probe_launch(&candidate, &fixture.store, std::future::pending())
        .await
        .unwrap_err()
}

#[tokio::test(flavor = "multi_thread")]
async fn startup_failure_remote_error_is_safe_and_candidate_can_retry() {
    let fixture = startup_fixture(&format!(
        "send({{'id':m['id'],'error':{{'code':-32602,'message':'{CANARY}','data':{{'path':'sensitive-file.py'}}}}}})"
    ));
    assert_eq!(failed_candidate(&fixture).await, "AGENT_INITIALIZE_FAILED");
    assert_old_target_and_safe_diagnostics(&fixture);
    fixture
        .manager
        .probe_launch(&fixture.row, &fixture.store, std::future::pending())
        .await
        .unwrap();
    assert_old_target_and_safe_diagnostics(&fixture);
}

#[tokio::test(flavor = "multi_thread")]
async fn startup_failure_malformed_result_is_not_claimed_remote_rejection() {
    let fixture = startup_fixture(&format!(
        "reply(m,{{'protocolVersion':'{CANARY}','authMethods':[]}})"
    ));
    assert_eq!(failed_candidate(&fixture).await, "AGENT_INITIALIZE_FAILED");
    assert_old_target_and_safe_diagnostics(&fixture);
}

#[tokio::test(flavor = "multi_thread")]
async fn startup_failure_eof_before_response_has_safe_ended_code() {
    let fixture = startup_fixture(&format!(
        "sys.stderr.write('{CANARY}: sensitive-file.py\\n'); sys.stderr.flush(); sys.exit(3)"
    ));
    assert_eq!(failed_candidate(&fixture).await, "AGENT_CONNECTION_ENDED");
    assert_old_target_and_safe_diagnostics(&fixture);
}

#[tokio::test(flavor = "multi_thread")]
async fn startup_failure_spawn_is_classified_at_actual_spawn() {
    let fixture = Fixture::new();
    let mut candidate = fixture.row.clone();
    candidate.command = fixture.cwd.join(CANARY).to_string_lossy().into();
    let result = fixture
        .manager
        .probe_launch(&candidate, &fixture.store, std::future::pending())
        .await
        .unwrap_err();
    assert_eq!(result, "AGENT_START_FAILED");
    assert_old_target_and_safe_diagnostics(&fixture);
}

#[tokio::test(flavor = "multi_thread")]
async fn startup_failure_cancel_wins_and_late_success_does_not_select_candidate() {
    let fixture = startup_fixture(
        "signal.signal(signal.SIGTERM,signal.SIG_IGN); open(sys.argv[1]+'_waiting','w').write(str(os.getpid())); time.sleep(.2); reply(m,{'protocolVersion':1,'agentCapabilities':{},'authMethods':[]}); open(sys.argv[1]+'_late','w').write('late')",
    );
    let mut candidate = fixture.row.clone();
    candidate.args.push("--reject-init".into());
    let marker = fixture.cwd.join("listed_waiting");
    let result = fixture
        .manager
        .probe_launch(&candidate, &fixture.store, async {
            until(|| marker.exists()).await;
        })
        .await;
    assert!(result.unwrap_err().contains("取消"));
    assert!(fixture.cwd.join("listed_late").exists());
    let pid: i32 = std::fs::read_to_string(marker).unwrap().parse().unwrap();
    assert_ne!(unsafe { libc::kill(pid, 0) }, 0);
    assert_old_target_and_safe_diagnostics(&fixture);
}
