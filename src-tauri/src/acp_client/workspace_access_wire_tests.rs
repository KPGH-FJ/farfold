//! Controlled stdio peers exercise the real manager/session pump; no real Agent.
use super::*;
use crate::acp_client::workspace_access::{ErrorKind, OfferedDecision};

#[path = "workspace_access_decision_wire_tests.rs"]
mod decision_tests;

const PEER: &str = r#"
import sys,json,os,time,threading,pathlib
lock=threading.Lock()
def send(m):
 with lock:print(json.dumps(dict(jsonrpc='2.0',**m)),flush=True)
def reply(m,v):send({'id':m['id'],'result':v})
def status(m):
 pathlib.Path('status-started').write_text('started')
 while pathlib.Path('hold-status').exists():time.sleep(.005)
 if pathlib.Path('unsupported').exists():send({'id':m['id'],'error':{'code':-32601,'message':'PRIVATE_SENTINEL'}});return
 if pathlib.Path('invalid').exists():reply(m,{'trust_status':'PRIVATE_SENTINEL'});return
 if pathlib.Path('rpc-error').exists():send({'id':m['id'],'error':{'code':-32603,'message':'PRIVATE_SENTINEL','data':{'key':'PRIVATE_SENTINEL'}}});return
 if pathlib.Path('camel-details').exists():reply(m,{'trust_status':'untrusted','details':{'cwd':os.getcwd(),'repoRoot':os.getcwd(),'availableDecisions':['trust_cwd','decline'],'detectedFiles':['PRIVATE_SENTINEL'],'settingsPath':'PRIVATE_SENTINEL'}});return
 if pathlib.Path('camel-invalid').exists():reply(m,{'trust_status':'trusted','details':{'cwd':os.getcwd(),'availableDecisions':True}});return
 if pathlib.Path('camel-conflict').exists():reply(m,{'trust_status':'trusted','details':{'cwd':os.getcwd(),'availableDecisions':['trust_cwd'],'available_decisions':['decline']}});return
 if pathlib.Path('camel-foreign').exists():reply(m,{'trust_status':'trusted','details':{'cwd':os.getcwd(),'repoRoot':pathlib.Path('camel-foreign').read_text()}});return
 # This default is retained controlled snake_case compatibility, not official serialization.
 reply(m,{'trust_status':'untrusted','details':{'cwd':os.getcwd(),'available_decisions':[]},'extra':'PRIVATE_SENTINEL'})
for line in sys.stdin:
 m=json.loads(line);method=m.get('method')
 with open('trust-trace.jsonl','a') as f:f.write(json.dumps({'method':method,'params':m.get('params')})+'\n')
 if method=='initialize':
  caps={'_meta': {'dev.dirac/permissions.list':True}} if pathlib.Path('rules-supported').exists() else {}
  reply(m,{'protocolVersion':1,'agentCapabilities':caps,'authMethods':[]})
 elif method=='session/new':
  extra={'_meta':{'dev.dirac/worktree':{'path':'/other/worktree'}}} if pathlib.Path('rules-worktree').exists() else {}
  reply(m,{'sessionId':'owned-trust','configOptions':[],**extra})
 elif method=='_trust/status':threading.Thread(target=status,args=(m,),daemon=True).start()
 elif method=='dev.dirac/permissions.list':
  rules=[{'tool':'execute_command','pattern':'test-owned','action':'allow'}]
  reply(m,{'rules':rules})
 else:send({'id':m.get('id'),'error':{'code':-32601,'message':'PRIVATE_SENTINEL'}})
"#;
async fn owned(
    f: &Fixture,
    enabled: bool,
) -> (String, crate::acp_client::manager::ManagedConnection) {
    std::fs::write(f.cwd.join("peer.py"), PEER).unwrap();
    let opened = f
        .manager
        .open_session(&f.row, &f.cwd, None, vec![], Arc::new(|_| {}), &f.store)
        .await
        .unwrap();
    let c = f
        .manager
        .session_connection(&f.row.id, &f.cwd, &opened.session_id)
        .unwrap();
    if enabled {
        c.workspace_access.enable_for_test();
    }
    (opened.connection_id, c)
}
fn trace(f: &Fixture) -> Vec<Value> {
    std::fs::read_to_string(f.cwd.join("trust-trace.jsonl"))
        .unwrap_or_default()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect()
}
fn queries(f: &Fixture) -> usize {
    trace(f)
        .iter()
        .filter(|v| v["method"] == "_trust/status")
        .count()
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_access_saved_rules_respects_advertisement_owner_and_folder() {
    let unsupported = Fixture::new();
    let (id, connection) = owned(&unsupported, false).await;
    assert!(
        !crate::acp_client::session_fork::capabilities(&connection, "owned-trust")
            .permission_rules_read
    );
    assert!(matches!(
        unsupported.manager.permission_rules(&unsupported.row.id, &unsupported.cwd, "owned-trust", &id).await,
        Err(error) if error.code == ErrorKind::Unavailable
    ));
    assert_eq!(trace(&unsupported).len(), 2);

    let changed_folder = Fixture::new();
    std::fs::write(changed_folder.cwd.join("rules-supported"), "").unwrap();
    std::fs::write(changed_folder.cwd.join("rules-worktree"), "").unwrap();
    let (id, connection) = owned(&changed_folder, false).await;
    assert!(
        !crate::acp_client::session_fork::capabilities(&connection, "owned-trust")
            .permission_rules_read
    );
    assert!(matches!(
        changed_folder.manager.permission_rules(&changed_folder.row.id, &changed_folder.cwd, "owned-trust", &id).await,
        Err(error) if error.code == ErrorKind::Changed
    ));
    assert_eq!(trace(&changed_folder).len(), 2);

    let f = Fixture::new();
    std::fs::write(f.cwd.join("rules-supported"), "").unwrap();
    let (id, connection) = owned(&f, false).await;
    assert!(
        crate::acp_client::session_fork::capabilities(&connection, "owned-trust")
            .permission_rules_read
    );
    assert!(matches!(
        f.manager.permission_rules(&f.row.id, &f.cwd, "owned-trust", "wrong-connection").await,
        Err(error) if error.code == ErrorKind::Changed
    ));
    let result = f
        .manager
        .permission_rules(&f.row.id, &f.cwd, "owned-trust", &id)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(result).unwrap(),
        json!({
            "connectionId":id, "nativeSessionId":"owned-trust", "cwd":f.cwd,
            "rules":[{"tool":"execute_command","pattern":"test-owned","action":"allow"}]
        })
    );
    let calls = trace(&f);
    assert_eq!(calls.len(), 3);
    assert_eq!(
        calls[2],
        json!({
            "method":"dev.dirac/permissions.list","params":{"sessionId":"owned-trust"}
        })
    );
    #[cfg(unix)]
    {
        let foreign = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(foreign.path(), f.cwd.join(".dirac")).unwrap();
        assert!(matches!(
            f.manager.permission_rules(&f.row.id, &f.cwd, "owned-trust", &id).await,
            Err(error) if error.code == ErrorKind::Changed
        ));
        assert_eq!(trace(&f).len(), 3);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_access_uses_exact_current_connection_session_cwd_and_no_other_rpc() {
    let f = Fixture::new();
    let (id, _) = owned(&f, true).await;
    let status = f
        .manager
        .workspace_access_status(&f.row.id, &f.cwd, "owned-trust", &id)
        .await
        .unwrap();
    assert_eq!(status.connection_id, id);
    assert_eq!(status.native_session_id, "owned-trust");
    assert_eq!(status.cwd, f.cwd.to_string_lossy());
    let calls = trace(&f);
    assert_eq!(
        calls
            .iter()
            .map(|v| v["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["initialize", "session/new", "_trust/status"]
    );
    assert_eq!(
        calls[2]["params"],
        json!({"sessionId":"owned-trust","cwd":f.cwd})
    );
    assert_eq!(status.details.unwrap().offered_decisions, Some(vec![]));
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_access_official_camel_wire_keeps_scope_and_finite_offers_without_extra_rpc() {
    let f = Fixture::new();
    let (id, _) = owned(&f, true).await;
    std::fs::write(f.cwd.join("camel-details"), "").unwrap();
    let reply = f
        .manager
        .workspace_access_status(&f.row.id, &f.cwd, "owned-trust", &id)
        .await
        .unwrap();
    let details = reply.details.as_ref().unwrap();
    assert!(details.repo_scope_verified);
    assert_eq!(details.repo_root.as_deref(), f.cwd.to_str());
    assert_eq!(
        details.offered_decisions,
        Some(vec![OfferedDecision::TrustCwd, OfferedDecision::Decline])
    );
    assert!(
        !serde_json::to_string(&reply)
            .unwrap()
            .contains("PRIVATE_SENTINEL")
    );
    assert_eq!(
        trace(&f)
            .iter()
            .map(|v| v["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["initialize", "session/new", "_trust/status"]
    );
    assert_eq!(queries(&f), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_access_official_camel_wire_invalid_conflicting_or_foreign_scope_is_not_trusted()
{
    for flag in ["camel-invalid", "camel-conflict", "camel-foreign"] {
        let f = Fixture::new();
        let foreign = tempfile::tempdir().unwrap();
        let (id, _) = owned(&f, true).await;
        std::fs::write(
            f.cwd.join(flag),
            foreign.path().to_string_lossy().as_bytes(),
        )
        .unwrap();
        let error = f
            .manager
            .workspace_access_status(&f.row.id, &f.cwd, "owned-trust", &id)
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorKind::InvalidResponse);
        assert_eq!(queries(&f), 1);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_access_foreign_connection_session_directory_and_preview_send_nothing() {
    let f = Fixture::new();
    let (id, c) = owned(&f, true).await;
    for (session, connection) in [("owned-trust", "foreign"), ("foreign", id.as_str())] {
        assert_eq!(
            f.manager
                .workspace_access_status(&f.row.id, &f.cwd, session, connection)
                .await
                .unwrap_err()
                .code,
            ErrorKind::Changed
        );
    }
    let other = tempfile::tempdir().unwrap();
    assert_eq!(
        f.manager
            .workspace_access_status(&f.row.id, other.path(), "owned-trust", &id)
            .await
            .unwrap_err()
            .code,
        ErrorKind::Changed
    );
    c.sessions
        .lock()
        .unwrap()
        .get_mut("owned-trust")
        .unwrap()
        .preview_token = Some("preview".into());
    assert_eq!(
        f.manager
            .workspace_access_status(&f.row.id, &f.cwd, "owned-trust", &id)
            .await
            .unwrap_err()
            .code,
        ErrorKind::Changed
    );
    assert_eq!(queries(&f), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_access_unreviewed_and_method_not_found_do_not_retry_or_infer_trust() {
    let f = Fixture::new();
    let (id, c) = owned(&f, false).await;
    assert_eq!(
        f.manager
            .workspace_access_status(&f.row.id, &f.cwd, "owned-trust", &id)
            .await
            .unwrap_err()
            .code,
        ErrorKind::Unavailable
    );
    assert_eq!(queries(&f), 0);
    c.workspace_access.enable_for_test();
    std::fs::write(f.cwd.join("unsupported"), "").unwrap();
    for _ in 0..2 {
        assert_eq!(
            f.manager
                .workspace_access_status(&f.row.id, &f.cwd, "owned-trust", &id)
                .await
                .unwrap_err()
                .code,
            ErrorKind::Unavailable
        );
    }
    assert_eq!(queries(&f), 1);
    assert!(c.workspace_access.capability().is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_access_invalid_shape_and_rpc_error_never_leak_raw_or_return_trusted() {
    for (flag, kind) in [
        ("invalid", ErrorKind::InvalidResponse),
        ("rpc-error", ErrorKind::QueryFailed),
    ] {
        let f = Fixture::new();
        let (id, _) = owned(&f, true).await;
        std::fs::write(f.cwd.join(flag), "").unwrap();
        let error = f
            .manager
            .workspace_access_status(&f.row.id, &f.cwd, "owned-trust", &id)
            .await
            .unwrap_err();
        assert_eq!(error.code, kind);
        assert!(
            !serde_json::to_string(&error)
                .unwrap()
                .contains("PRIVATE_SENTINEL")
        );
        assert_eq!(queries(&f), 1);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn workspace_access_late_owner_change_discards_actual_reply_and_never_queries_replacement() {
    let f = Fixture::new();
    let (id, c) = owned(&f, true).await;
    std::fs::write(f.cwd.join("hold-status"), "").unwrap();
    let request = f
        .manager
        .workspace_access_status(&f.row.id, &f.cwd, "owned-trust", &id);
    tokio::pin!(request);
    tokio::select! { _=&mut request=>panic!("held reply completed"),_ = until(||f.cwd.join("status-started").exists())=>{} }
    c.state.store(3, std::sync::atomic::Ordering::SeqCst);
    std::fs::remove_file(f.cwd.join("hold-status")).unwrap();
    assert_eq!(request.await.unwrap_err().code, ErrorKind::Changed);
    assert_eq!(queries(&f), 1);
}
