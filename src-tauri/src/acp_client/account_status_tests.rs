//! Controlled wire evidence, never a real account or authentication request.
use super::*;

fn account_peer(f: &Fixture, declared: bool) {
    let declaration = if declared {
        "'_meta':{'authStatus':{}}"
    } else {
        ""
    };
    let peer = format!(
        r#"
import sys,json
reply=lambda m,r: print(json.dumps(dict(jsonrpc='2.0',id=m['id'],result=r)),flush=True)
def report(kind):
 print(json.dumps(dict(jsonrpc='2.0',method='_auth/status_update',params={{'authStatus':{{'kind':kind,'label':'fixture-secret','detail':'fixture-secret','vendor':{{'token':'fixture-secret'}},'account':{{'email':'user@example.test','plan':'pro'}}}}}})),flush=True)
for line in sys.stdin:
 m=json.loads(line)
 if m.get('method')=='initialize':
  reply(m,{{'protocolVersion':1,'agentCapabilities':{{'sessionCapabilities':{{'list':{{}}}},{declaration}}},'authMethods':[]}})
  report('account')
 elif m.get('method')=='session/list':
  report('none')
  reply(m,{{'sessions':[]}})
 elif m.get('method')=='session/new':
  report('future-kind')
  reply(m,{{'sessionId':'account-fixture','configOptions':[]}})
"#
    );
    std::fs::write(f.cwd.join("peer.py"), peer).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn immediate_identity_push_logout_unknown_and_connection_scope_are_real_wire_events() {
    let f = Fixture::new();
    account_peer(&f, true);
    f.connect().await;
    until(|| {
        f.manager.status(&f.row.id).unwrap().iter().any(|s| {
            s.account
                .as_ref()
                .is_some_and(|a| a.email.as_deref() == Some("user@example.test"))
        })
    })
    .await;
    let prepared = f.manager.live_connection(&f.row.id, &f.cwd).unwrap();
    let opened = f
        .manager
        .open_session(&f.row, &f.cwd, None, vec![], Arc::new(|_| {}), &f.store)
        .await
        .unwrap();
    let conversation = f
        .manager
        .session_connection(&f.row.id, &f.cwd, &opened.session_id)
        .unwrap();
    until(|| conversation.account.lock().unwrap().is_none()).await;
    assert!(prepared.account.lock().unwrap().is_some());
    f.manager
        .agent_session_list(&f.row.id, &f.cwd)
        .await
        .unwrap();
    until(|| {
        prepared
            .account
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|a| a.kind == crate::acp_client::account_status::AccountKind::None)
    })
    .await;
    let handshake = f
        .store
        .get_agent(&f.row.id)
        .unwrap()
        .unwrap()
        .handshake
        .unwrap()
        .to_string();
    assert!(!handshake.contains("user@example.test"));
    for file in std::fs::read_dir(f.cwd.join("logs")).unwrap().flatten() {
        if file.path().extension().and_then(|s| s.to_str()) == Some("jsonl") {
            let log = std::fs::read_to_string(file.path()).unwrap();
            assert!(!log.contains("fixture-secret"));
            assert!(!log.contains("user@example.test"));
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn undeclared_notifications_never_become_a_reported_identity() {
    let f = Fixture::new();
    account_peer(&f, false);
    f.connect().await;
    f.manager
        .agent_session_list(&f.row.id, &f.cwd)
        .await
        .unwrap();
    assert!(
        f.manager
            .status(&f.row.id)
            .unwrap()
            .iter()
            .all(|s| s.account.is_none())
    );
}
