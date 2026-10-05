//! Real stdio with a synthetic peer; no real Agent or credentials involved.
use super::*;

fn peer(f: &Fixture, declared: bool, malformed: bool) {
    let capabilities = if declared {
        "{'_meta':{'kimchi.dev':{'auth_status':True}}}"
    } else {
        "{}"
    };
    let result = if malformed {
        "{'authenticated':'true'}"
    } else {
        "{'authenticated':authenticated,'token':'fixture-secret'}"
    };
    std::fs::write(f.cwd.join("peer.py"),format!(r#"
import sys,json,os
authenticated=False
def reply(m,r): print(json.dumps(dict(jsonrpc='2.0',id=m['id'],result=r)),flush=True)
for line in sys.stdin:
 m=json.loads(line); method=m.get('method')
 with open(sys.argv[1]+'_methods','a') as trace: trace.write(str(method)+'\n')
 if method=='initialize': reply(m,{{'protocolVersion':1,'agentCapabilities':{capabilities},'authMethods':[{{'id':'login','name':'Fixture login'}}]}})
 elif method=='_kimchi.dev/auth_status': reply(m,{result})
 elif method=='authenticate': authenticated=True; reply(m,{{}})
 elif method=='session/new': reply(m,{{'sessionId':'query-'+str(os.getpid()),'configOptions':[]}})
 else: print(json.dumps(dict(jsonrpc='2.0',id=m.get('id'),error={{'code':-32601,'message':'fixture-unknown'}})),flush=True)
"#)).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn same_process_authentication_check_preserves_memory_and_keeps_new_child_distinct() {
    use crate::acp_client::{account_status::AccountKind, manager::AuthenticationOperation};
    let f = Fixture::new();
    peer(&f, true, false);
    f.connect().await;
    let before = f.manager.live_connection(&f.row.id, &f.cwd).unwrap();
    until(|| {
        before
            .account
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|a| a.kind == AccountKind::MissingCredential)
    })
    .await;
    let pid = before.child_pid.load(std::sync::atomic::Ordering::SeqCst);
    f.manager
        .authenticate(
            &f.row.id,
            &f.cwd,
            "login",
            AuthenticationOperation::new(),
            Arc::new(|| {}),
        )
        .await
        .unwrap();
    let refreshed = f
        .manager
        .refresh_authentication(&f.row.id, &f.cwd)
        .await
        .unwrap();
    assert_eq!(refreshed.connection_id, before.connection_id);
    assert_eq!(refreshed.account.unwrap().kind, AccountKind::Credential);
    assert_eq!(
        before.child_pid.load(std::sync::atomic::Ordering::SeqCst),
        pid
    );
    let opened = f
        .manager
        .open_session(&f.row, &f.cwd, None, vec![], Arc::new(|_| {}), &f.store)
        .await
        .unwrap();
    let child = f
        .manager
        .session_connection(&f.row.id, &f.cwd, &opened.session_id)
        .unwrap();
    assert_ne!(child.connection_id, before.connection_id);
    assert_eq!(
        child.account.lock().unwrap().as_ref().unwrap().kind,
        AccountKind::MissingCredential
    );
    let methods = std::fs::read_to_string(f.cwd.join("listed_methods")).unwrap();
    assert_eq!(methods.lines().filter(|m| *m == "authenticate").count(), 1);
    for log in std::fs::read_dir(f.cwd.join("logs")).unwrap().flatten() {
        if log.path().extension().is_some_and(|e| e == "jsonl") {
            assert!(
                !std::fs::read_to_string(log.path())
                    .unwrap()
                    .contains("fixture-secret")
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn undeclared_query_never_runs_and_malformed_query_never_becomes_login() {
    for (declared, malformed) in [(false, false), (true, true)] {
        let f = Fixture::new();
        peer(&f, declared, malformed);
        f.connect().await;
        // An explicit refresh is a bounded live read, not authenticate or restart.
        let status = f
            .manager
            .refresh_authentication(&f.row.id, &f.cwd)
            .await
            .unwrap();
        assert!(status.account.is_none());
        let methods = std::fs::read_to_string(f.cwd.join("listed_methods")).unwrap();
        assert_eq!(methods.lines().filter(|m| *m == "initialize").count(), 1);
        assert!(!methods.lines().any(|m| m == "authenticate"));
        assert_eq!(
            methods.lines().any(|m| m == "_kimchi.dev/auth_status"),
            declared
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn query_declaration_does_not_authorize_an_early_undeclared_account_push() {
    use crate::acp_client::account_status::AccountKind;
    let f = Fixture::new();
    std::fs::write(f.cwd.join("peer.py"), r#"
import sys,json,time,os
def reply(m,r): print(json.dumps(dict(jsonrpc='2.0',id=m['id'],result=r)),flush=True)
for line in sys.stdin:
 m=json.loads(line)
 if m.get('method')=='initialize':
  reply(m,{'protocolVersion':1,'agentCapabilities':{'_meta':{'kimchi.dev':{'auth_status':True}}},'authMethods':[]})
  print(json.dumps(dict(jsonrpc='2.0',method='_auth/status_update',params={'authStatus':{'kind':'account','account':{'email':'undeclared@example.test'}}})),flush=True)
 elif m.get('method')=='_kimchi.dev/auth_status':
  open(sys.argv[1]+'_query','w').write('started')
  while not os.path.exists(sys.argv[1]+'_release'): time.sleep(.005)
  reply(m,{'authenticated':True})
"#).unwrap();
    f.connect().await;
    until(|| f.cwd.join("listed_query").exists()).await;
    assert!(
        f.manager
            .status(&f.row.id)
            .unwrap()
            .iter()
            .all(|s| s.account.is_none())
    );
    std::fs::write(f.cwd.join("listed_release"), "continue").unwrap();
    until(|| {
        f.manager.status(&f.row.id).unwrap().iter().any(|s| {
            s.account
                .as_ref()
                .is_some_and(|a| a.kind == AccountKind::Credential)
        })
    })
    .await;
    assert!(
        f.manager
            .status(&f.row.id)
            .unwrap()
            .iter()
            .all(|s| s.account.as_ref().is_none_or(|a| a.email.is_none()))
    );
}
