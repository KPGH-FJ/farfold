//! Real SDK + manager + two actor checks against an owned stdio peer.
use super::*;
use crate::acp_client::workspace_access::{
    OfferedDecision as D,
    decision::{Code, Effect, ExpectedScope},
};
use std::sync::Mutex;

const DECISION_PEER: &str = r#"
import sys,json,os,time,threading,pathlib,signal
lock=threading.Lock()
def send(m):
 with lock: print(json.dumps(dict(jsonrpc='2.0',**m)),flush=True)
def reply(m,v):send({'id':m['id'],'result':v})
def options(v):return [{'id':'model','name':'Model','category':'model','type':'select','currentValue':v,'options':[{'value':'m1','name':'M1'},{'value':'m2','name':'M2'}]}]
def status(m):
 pathlib.Path('status-started').write_text('1')
 while pathlib.Path('hold-status').exists():time.sleep(.005)
 if pathlib.Path('late-config').exists():send({'method':'session/update','params':{'sessionId':'owned-decision','update':{'sessionUpdate':'config_option_update','configOptions':options('m2')}}})
 offers=['trust_cwd','trust_repo','decline']
 if pathlib.Path('changed-offers').exists():offers=['decline']
 reply(m,{'trust_status':'untrusted','details':{'cwd':os.getcwd(),'repoRoot':os.getcwd(),'availableDecisions':offers}})
 pathlib.Path('status-replied').write_text('1')
def decision(m):
 pathlib.Path('decision-started').write_text('1')
 # The fixture effect precedes both error and success, like official reload.
 pathlib.Path('decision-effect').write_text(m['params']['decision'])
 while pathlib.Path('hold-decision').exists():time.sleep(.005)
 if pathlib.Path('transport-error').exists():
  signal.signal(signal.SIGTERM,lambda *a:None)
  os.close(1)
  while True:time.sleep(.1)
 if pathlib.Path('rpc-error').exists():send({'id':m['id'],'error':{'code':-32603,'message':'PRIVATE_SENTINEL','data':{'secret':'PRIVATE_SENTINEL'}}});return
 if pathlib.Path('unsupported-decision').exists():send({'id':m['id'],'error':{'code':-32601,'message':'PRIVATE_SENTINEL'}});return
 if pathlib.Path('invalid-decision').exists():reply(m,{'trust_status':'PRIVATE_SENTINEL'});return
 reply(m,{'trust_status':'trusted','details':{'cwd':os.getcwd(),'repoRoot':os.getcwd(),'availableDecisions':['trust_cwd','trust_repo','decline']}})
for line in sys.stdin:
 m=json.loads(line);method=m.get('method')
 with open('decision-trace.jsonl','a') as f:f.write(json.dumps({'method':method,'params':m.get('params')})+'\n')
 if method=='initialize':reply(m,{'protocolVersion':1,'agentCapabilities':{},'authMethods':[]})
 elif method=='session/new':reply(m,{'sessionId':'owned-decision','configOptions':options('m1')})
 elif method=='_trust/status':threading.Thread(target=status,args=(m,),daemon=True).start()
 elif method=='_trust/decision':threading.Thread(target=decision,args=(m,),daemon=True).start()
 else:send({'id':m.get('id'),'error':{'code':-32601,'message':'PRIVATE_SENTINEL'}})
"#;

async fn setup(
    f: &Fixture,
) -> (
    String,
    crate::acp_client::manager::ManagedConnection,
    Arc<Mutex<Vec<Value>>>,
) {
    std::fs::write(f.cwd.join("peer.py"), DECISION_PEER).unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let opened = f
        .manager
        .open_session(
            &f.row,
            &f.cwd,
            None,
            vec![],
            Arc::new(move |v| sink.lock().unwrap().push(v)),
            &f.store,
        )
        .await
        .unwrap();
    let c = f
        .manager
        .session_connection(&f.row.id, &f.cwd, "owned-decision")
        .unwrap();
    c.workspace_access.enable_for_test();
    (opened.connection_id, c, events)
}
fn scope(f: &Fixture) -> ExpectedScope {
    ExpectedScope {
        cwd: f.cwd.to_string_lossy().into(),
        repo_root: Some(f.cwd.to_string_lossy().into()),
        repo_scope_verified: true,
        offered_decisions: vec![D::TrustCwd, D::TrustRepo, D::Decline],
    }
}
fn calls(f: &Fixture) -> Vec<Value> {
    std::fs::read_to_string(f.cwd.join("decision-trace.jsonl"))
        .unwrap_or_default()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect()
}
fn decisions(f: &Fixture) -> usize {
    calls(f)
        .iter()
        .filter(|v| v["method"] == "_trust/decision")
        .count()
}
async fn wait_file(f: &Fixture, name: &str) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !f.cwd.join(name).exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}
async fn choose(
    f: &Fixture,
    id: &str,
    d: D,
) -> Result<
    crate::acp_client::workspace_access::WorkspaceAccessStatus,
    crate::acp_client::workspace_access::decision::DecisionError,
> {
    f.manager
        .workspace_access_decide(&f.row.id, &f.cwd, "owned-decision", id, d, scope(f))
        .await
}
fn start(
    f: &Fixture,
    id: &str,
    d: D,
) -> tokio::task::JoinHandle<
    Result<
        crate::acp_client::workspace_access::WorkspaceAccessStatus,
        crate::acp_client::workspace_access::decision::DecisionError,
    >,
> {
    let (m, a, c, id, expected) = (
        f.manager.clone(),
        f.row.id.clone(),
        f.cwd.clone(),
        id.to_owned(),
        scope(f),
    );
    tokio::spawn(async move {
        m.workspace_access_decide(&a, &c, "owned-decision", &id, d, expected)
            .await
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_access_decision_exact_wire_single_effect_and_grant_never_confirms_configuration()
{
    let f = Fixture::new();
    let (id, _, events) = setup(&f).await;
    let result = choose(&f, &id, D::TrustCwd).await.unwrap();
    assert_eq!(
        result.status,
        crate::acp_client::workspace_access::TrustStatus::Trusted
    );
    assert_eq!(
        calls(&f)
            .iter()
            .map(|v| v["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "initialize",
            "session/new",
            "_trust/status",
            "_trust/decision"
        ]
    );
    assert_eq!(
        calls(&f)[3]["params"],
        json!({"sessionId":"owned-decision","cwd":f.cwd,"decision":"trust_cwd"})
    );
    assert_eq!(decisions(&f), 1);
    let e = events.lock().unwrap().clone();
    assert!(e.iter().any(|v| {
        v["kind"] == "configCheck"
            && v["check"]["status"] == "blocked"
            && v["check"]["issues"]
                .as_array()
                .unwrap()
                .iter()
                .any(|i| i["reason"] == "unknown")
    }));
    assert!(
        e.iter()
            .any(|v| v["kind"] == "permissionState" && v["permissionState"] == "unknown")
    );
    assert!(f.manager.reserve_preparation_change(&f.row.id).is_ok());
    let error = choose(&f, &id, D::TrustCwd).await.unwrap_err();
    assert_eq!(
        (error.code, error.effect),
        (Code::Busy, Effect::NotDispatched)
    );
    assert_eq!(decisions(&f), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_access_decision_decline_is_a_real_effect_not_cancel_and_does_not_reload_guard() {
    let f = Fixture::new();
    let (id, _, events) = setup(&f).await;
    choose(&f, &id, D::Decline).await.unwrap();
    assert_eq!(
        std::fs::read_to_string(f.cwd.join("decision-effect")).unwrap(),
        "decline"
    );
    assert!(
        !events
            .lock()
            .unwrap()
            .iter()
            .any(|v| v["kind"] == "permissionState" && v["permissionState"] == "unknown")
    );
    assert!(f.manager.reserve_preparation_change(&f.row.id).is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_access_decision_prewrite_foreign_cap_missing_offer_and_changed_scope_do_not_dispatch()
 {
    let f = Fixture::new();
    let (id, c, _) = setup(&f).await;
    let err = choose(&f, "foreign", D::TrustCwd).await.unwrap_err();
    assert_eq!(err.code, Code::Changed);
    let mut expected = scope(&f);
    expected.offered_decisions.clear();
    assert_eq!(
        f.manager
            .workspace_access_decide(
                &f.row.id,
                &f.cwd,
                "owned-decision",
                &id,
                D::TrustCwd,
                expected
            )
            .await
            .unwrap_err()
            .code,
        Code::NotOffered
    );
    std::fs::write(f.cwd.join("changed-offers"), "").unwrap();
    assert_eq!(
        choose(&f, &id, D::TrustCwd).await.unwrap_err().code,
        Code::ScopeChanged
    );
    c.workspace_access.disable_decisions_for_test();
    assert_eq!(
        choose(&f, &id, D::TrustCwd).await.unwrap_err().code,
        Code::Unavailable
    );
    assert_eq!(decisions(&f), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_access_decision_late_config_between_read_and_commit_is_not_overwritten_or_sent()
{
    let f = Fixture::new();
    let (id, _, events) = setup(&f).await;
    std::fs::write(f.cwd.join("late-config"), "").unwrap();
    let error = choose(&f, &id, D::TrustCwd).await.unwrap_err();
    assert_eq!(
        (error.code, error.effect),
        (Code::Busy, Effect::NotDispatched)
    );
    assert_eq!(decisions(&f), 0);
    assert!(
        !events
            .lock()
            .unwrap()
            .iter()
            .any(|v| v["kind"] == "permissionState" && v["permissionState"] == "unknown")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_access_decision_real_peer_error_after_write_is_unconfirmed_but_releases_actual_rpc_scope()
 {
    let f = Fixture::new();
    let (id, _, _) = setup(&f).await;
    std::fs::write(f.cwd.join("rpc-error"), "").unwrap();
    let error = choose(&f, &id, D::TrustCwd).await.unwrap_err();
    assert_eq!(
        (error.code, error.effect),
        (Code::QueryFailed, Effect::Unconfirmed)
    );
    assert!(f.cwd.join("decision-effect").exists());
    assert_eq!(decisions(&f), 1);
    assert!(
        !serde_json::to_string(&error)
            .unwrap()
            .contains("PRIVATE_SENTINEL")
    );
    assert!(f.manager.reserve_preparation_change(&f.row.id).is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_access_decision_immediate_peer_error_witness_has_no_send_registration_race() {
    for _ in 0..8 {
        let f = Fixture::new();
        let (id, _, _) = setup(&f).await;
        std::fs::write(f.cwd.join("rpc-error"), "").unwrap();
        assert_eq!(
            choose(&f, &id, D::Decline).await.unwrap_err().effect,
            Effect::Unconfirmed
        );
        assert!(f.manager.reserve_preparation_change(&f.row.id).is_ok());
        assert_eq!(decisions(&f), 1);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_access_decision_caller_drop_then_actor_shutdown_retains_scope_to_actual_response()
 {
    let f = Fixture::new();
    let (id, c, _) = setup(&f).await;
    std::fs::write(f.cwd.join("hold-decision"), "").unwrap();
    let task = start(&f, &id, D::TrustCwd);
    wait_file(&f, "decision-started").await;
    task.abort();
    let _ = task.await;
    let control = c
        .sessions
        .lock()
        .unwrap()
        .get("owned-decision")
        .unwrap()
        .control
        .clone();
    control
        .send(crate::acp_client::pump::SessionControl::Shutdown)
        .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(f.manager.reserve_preparation_change(&f.row.id).is_err());
    std::fs::remove_file(f.cwd.join("hold-decision")).unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Ok(scope) = f.manager.reserve_preparation_change(&f.row.id) {
                drop(scope);
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(decisions(&f), 1);
    assert!(!c.life.finished());
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_access_decision_prewrite_read_caller_drop_releases_scope_without_cancelling_read_or_writing()
 {
    let f = Fixture::new();
    let (id, c, _) = setup(&f).await;
    std::fs::write(f.cwd.join("hold-status"), "").unwrap();
    let task = start(&f, &id, D::TrustCwd);
    wait_file(&f, "status-started").await;
    task.abort();
    let _ = task.await;
    assert!(f.cwd.join("hold-status").exists());
    assert!(!f.cwd.join("status-replied").exists());
    assert_eq!(decisions(&f), 0);
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if let Ok(scope) = f.manager.reserve_preparation_change(&f.row.id) {
                drop(scope);
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("abandoned prewrite read must release the shared effect scope");
    let work = c
        .life
        .work()
        .expect("read-only observation must not block new work");
    drop(work);
    assert!(f.cwd.join("hold-status").exists());
    std::fs::remove_file(f.cwd.join("hold-status")).unwrap();
    wait_file(&f, "status-replied").await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(decisions(&f), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_access_decision_invalid_response_and_unsupported_do_not_return_trusted_or_retry()
{
    for flag in ["invalid-decision", "unsupported-decision"] {
        let f = Fixture::new();
        let (id, c, _) = setup(&f).await;
        std::fs::write(f.cwd.join(flag), "").unwrap();
        let error = choose(&f, &id, D::TrustCwd).await.unwrap_err();
        assert_eq!(error.effect, Effect::Unconfirmed);
        assert_eq!(decisions(&f), 1);
        assert_eq!(
            c.workspace_access.capability().unwrap().decision_management,
            flag != "unsupported-decision"
        );
        assert!(c.workspace_access.capability().unwrap().status_query);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_access_decision_busy_work_and_duplicate_do_not_make_a_second_query_or_effect() {
    let f = Fixture::new();
    let (id, c, _) = setup(&f).await;
    let work = c.life.work().unwrap();
    assert_eq!(
        choose(&f, &id, D::Decline).await.unwrap_err().code,
        Code::Busy
    );
    assert_eq!(calls(&f).len(), 2);
    drop(work);
    std::fs::write(f.cwd.join("hold-decision"), "").unwrap();
    let task = start(&f, &id, D::Decline);
    wait_file(&f, "decision-started").await;
    let error = choose(&f, &id, D::Decline).await.unwrap_err();
    assert_eq!(
        (error.code, error.effect),
        (Code::Busy, Effect::NotDispatched)
    );
    assert_eq!(decisions(&f), 1);
    assert_eq!(calls(&f).len(), 4);
    std::fs::remove_file(f.cwd.join("hold-decision")).unwrap();
    task.await.unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_access_decision_actor_ends_before_commit_is_known_unsent_not_transport_unknown()
{
    let f = Fixture::new();
    let (id, c, _) = setup(&f).await;
    std::fs::write(f.cwd.join("hold-status"), "").unwrap();
    let task = start(&f, &id, D::TrustCwd);
    wait_file(&f, "status-started").await;
    c.sessions
        .lock()
        .unwrap()
        .get("owned-decision")
        .unwrap()
        .control
        .send(crate::acp_client::pump::SessionControl::Shutdown)
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !c
            .sessions
            .lock()
            .unwrap()
            .get("owned-decision")
            .unwrap()
            .control
            .is_closed()
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    std::fs::remove_file(f.cwd.join("hold-status")).unwrap();
    let error = task.await.unwrap().unwrap_err();
    assert_eq!(
        (error.code, error.effect),
        (Code::Changed, Effect::NotDispatched)
    );
    assert_eq!(decisions(&f), 0);
    assert!(f.manager.reserve_preparation_change(&f.row.id).is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_access_decision_prewrite_read_expiry_releases_scope_without_cancelling_read_or_writing()
 {
    let f = Fixture::new();
    let (id, c, _) = setup(&f).await;
    std::fs::write(f.cwd.join("hold-status"), "").unwrap();
    let task = start(&f, &id, D::TrustCwd);
    wait_file(&f, "status-started").await;
    let error = tokio::time::timeout(Duration::from_secs(23), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(
        (error.code, error.effect),
        (Code::Timeout, Effect::NotDispatched)
    );
    assert_eq!(decisions(&f), 0);
    assert!(f.cwd.join("hold-status").exists());
    assert!(!f.cwd.join("status-replied").exists());
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if let Ok(scope) = f.manager.reserve_preparation_change(&f.row.id) {
                drop(scope);
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("expired prewrite read must release the shared effect scope");
    let work = c
        .life
        .work()
        .expect("read-only observation must not block new work");
    drop(work);
    assert!(f.cwd.join("hold-status").exists());
    std::fs::remove_file(f.cwd.join("hold-status")).unwrap();
    wait_file(&f, "status-replied").await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(decisions(&f), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_access_decision_effect_expiry_is_unknown_and_scope_ends_only_at_actual_reply() {
    let f = Fixture::new();
    let (id, _, _) = setup(&f).await;
    std::fs::write(f.cwd.join("hold-decision"), "").unwrap();
    let task = start(&f, &id, D::TrustCwd);
    wait_file(&f, "decision-started").await;
    let error = tokio::time::timeout(Duration::from_secs(23), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(
        (error.code, error.effect),
        (Code::Timeout, Effect::Unconfirmed)
    );
    assert!(f.manager.reserve_preparation_change(&f.row.id).is_err());
    assert_eq!(decisions(&f), 1);
    std::fs::remove_file(f.cwd.join("hold-decision")).unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Ok(scope) = f.manager.reserve_preparation_change(&f.row.id) {
                drop(scope);
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(decisions(&f), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_access_decision_transport_error_after_write_keeps_scope_until_original_process_reap()
 {
    let f = Fixture::new();
    let (id, c, _) = setup(&f).await;
    std::fs::write(f.cwd.join("transport-error"), "").unwrap();
    let error = choose(&f, &id, D::TrustCwd).await.unwrap_err();
    assert_eq!(error.effect, Effect::Unconfirmed);
    assert!(f.cwd.join("decision-effect").exists());
    assert!(!c.life.finished());
    assert!(f.manager.reserve_preparation_change(&f.row.id).is_err());
    // Local SDK/transport failure does not prove reap. Explicitly end this
    // controlled peer; even that intent must not release the held scope.
    c.life.close(true, None).unwrap();
    assert!(!c.life.finished());
    assert!(f.manager.reserve_preparation_change(&f.row.id).is_err());
    tokio::time::timeout(Duration::from_secs(8), c.life.terminated())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Ok(scope) = f.manager.reserve_preparation_change(&f.row.id) {
                drop(scope);
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(decisions(&f), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_access_decision_unpolled_or_closed_owner_has_no_status_or_write() {
    let f = Fixture::new();
    let (id, c, _) = setup(&f).await;
    let future = choose(&f, &id, D::TrustCwd);
    drop(future);
    assert_eq!(calls(&f).len(), 2);
    c.sessions
        .lock()
        .unwrap()
        .get("owned-decision")
        .unwrap()
        .control
        .send(crate::acp_client::pump::SessionControl::Shutdown)
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !c
            .sessions
            .lock()
            .unwrap()
            .get("owned-decision")
            .unwrap()
            .control
            .is_closed()
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let error = choose(&f, &id, D::TrustCwd).await.unwrap_err();
    assert_eq!(
        (error.code, error.effect),
        (Code::Changed, Effect::NotDispatched)
    );
    assert_eq!(calls(&f).len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_access_decision_actual_reply_after_actor_ended_is_not_published_as_current_trusted()
 {
    let f = Fixture::new();
    let (id, c, _) = setup(&f).await;
    std::fs::write(f.cwd.join("hold-decision"), "").unwrap();
    let task = start(&f, &id, D::TrustCwd);
    wait_file(&f, "decision-started").await;
    let control = c
        .sessions
        .lock()
        .unwrap()
        .get("owned-decision")
        .unwrap()
        .control
        .clone();
    control
        .send(crate::acp_client::pump::SessionControl::Shutdown)
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !control.is_closed() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(f.manager.reserve_preparation_change(&f.row.id).is_err());
    std::fs::remove_file(f.cwd.join("hold-decision")).unwrap();
    let error = task.await.unwrap().unwrap_err();
    assert_eq!(error.effect, Effect::Unconfirmed);
    assert!(f.manager.reserve_preparation_change(&f.row.id).is_ok());
    assert_eq!(decisions(&f), 1);
}
