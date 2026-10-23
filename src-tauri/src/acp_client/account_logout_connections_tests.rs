//! Account-copy regressions use only temporary peers and synthetic metadata.
use super::*;
use crate::acp_client::{
    manager::ManagedConnection,
    model_guard::ConfigStore,
    service_connection::{PreparedService, ServiceContext, ServiceRecord},
};

// A credential is read once at process startup. Removing the shared synthetic
// source clears only the logout process's copy, as in Vibe v2.25.8's dotenv path.
const MEMORY_PEER: &str = r#"#!/usr/bin/python3 -u
import sys,json,time,os
root=os.path.dirname(os.path.realpath(__file__))
def path(name): return os.path.join(root,name)
with open(path('state.json')) as source: credential=json.load(source)['authenticated']
def send(v): print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def reply(m,r): send({'id':m['id'],'result':r})
def gate(name):
 if os.path.exists(path(name)):
  open(path(name+'_started'),'w').write('started')
  while not os.path.exists(path(name+'_release')): time.sleep(.005)
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); p=m.get('params',{})
 with open(path('requests'),'a') as trace: trace.write(json.dumps({'pid':os.getpid(),'method':method,'params':p})+'\n')
 if method=='initialize': reply(m,{'protocolVersion':1,'agentCapabilities':{'loadSession':True},'authMethods':[]})
 elif method=='_auth/status':
  if not credential: gate('post_status_wait')
  source='process_env' if os.path.exists(path('status_denied')) else 'vibe_home_env_file'
  reply(m,{'authenticated':credential,'authState':source if credential else 'signed_out','signOutAvailable':credential})
 elif method=='_auth/signOut':
  gate('logout_wait')
  if not os.path.exists(path('keep_credential')):
   credential=False
   with open(path('state.json'),'w') as source: json.dump({'authenticated':False},source)
  if os.path.exists(path('partial_error')): send({'id':m['id'],'error':{'code':-32603,'message':'fixture-partial-failure'}})
  else: reply(m,{})
 elif method=='session/new': reply(m,{'sessionId':str(os.getpid()),'configOptions':[]})
 elif method=='session/load':
  send({'method':'session/update','params':{'sessionId':p['sessionId'],'update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'retained-history'}}}})
  reply(m,{'configOptions':[]})
 elif method=='session/prompt':
  if credential: reply(m,{'stopReason':'end_turn'})
  else: send({'id':m['id'],'error':{'code':-32000,'message':'fixture-account-required'}})
 elif method=='$/cancel_request': pass
 else: send({'id':m.get('id'),'error':{'code':-32601,'message':'fixture-unknown'}})
"#;

fn requests(f: &Fixture) -> Vec<Value> {
    std::fs::read_to_string(f.cwd.join("requests"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

async fn open_account_copy(
    f: &Fixture,
    row: &AgentRow,
) -> (String, Arc<std::sync::Mutex<Vec<Value>>>) {
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = events.clone();
    let opened = f
        .manager
        .open_session(
            row,
            &f.cwd,
            None,
            vec![],
            Arc::new(move |event| captured.lock().unwrap().push(event)),
            &f.store,
        )
        .await
        .unwrap();
    (opened.session_id, events)
}

async fn account_conversation() -> (Fixture, String, ManagedConnection) {
    let f = fixture();
    crate::platform_tests::python_peer(&f.cwd, "vibe-acp", MEMORY_PEER);
    ready(&f).await;
    let (id, _) = open_account_copy(&f, &f.row).await;
    let owner = f
        .manager
        .session_connection(&f.row.id, &f.cwd, &id)
        .unwrap();
    (f, id, owner)
}

fn assert_reaped(connection: &ManagedConnection) {
    assert!(connection.life.work().is_err());
    assert_ne!(
        crate::platform_tests::process_check(connection.child_pid.load(Ordering::SeqCst) as i32),
        0
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn review_regression_logout_reaps_idle_account_copies_and_preserves_api_and_history() {
    let f = fixture();
    crate::platform_tests::python_peer(&f.cwd, "vibe-acp", MEMORY_PEER);
    ready(&f).await;
    let (original, original_events) = open_account_copy(&f, &f.row).await;
    let original_owner = f
        .manager
        .session_connection(&f.row.id, &f.cwd, &original)
        .unwrap();
    let mut alias = f.row.clone();
    alias.id = "custom:same-account-program".into();
    alias.source = "custom".into();
    f.store.insert_agent(&alias).unwrap();
    f.manager.connect(&alias, &f.cwd, &f.store).await.unwrap();
    let alias_preparation = f.manager.live_connection(&alias.id, &f.cwd).unwrap();
    let (sibling, sibling_events) = open_account_copy(&f, &alias).await;
    let sibling_owner = f
        .manager
        .session_connection(&alias.id, &f.cwd, &sibling)
        .unwrap();

    // This same program also has an explicitly selected independent API source.
    let context = ServiceContext {
        identity: crate::credentials::ServiceIdentity {
            id: "independent-api".into(),
            fingerprint: "synthetic-service".into(),
            model: "fixture".into(),
        },
        revision: "synthetic-api-revision".into(),
        model_id: "fixture".into(),
    };
    f.manager
        .connect_launch(
            &f.row,
            &f.cwd,
            &f.store,
            false,
            Some(PreparedService {
                delivery: None,
                environment: crate::shell_env::command_env(),
                context,
            }),
        )
        .await
        .unwrap();
    let api = f
        .manager
        .lock()
        .unwrap()
        .values()
        .find(|connection| connection.service.is_some())
        .unwrap()
        .clone();
    let (result, receive) = tokio::sync::oneshot::channel();
    api.send(ManagerCommand::OpenSession {
        fork_owned: false,
        native_session_id: None,
        preview_token: None,
        opening_token: None,
        recorded_config: None,
        config_store: Box::new(ConfigStore {
            store: f.store.clone(),
            agent_id: f.row.id.clone(),
            cwd: f.cwd.to_string_lossy().into(),
            // Synthetic launch ownership is enough for this lifecycle check;
            // no credential or configured service is created in the store.
            service_record: Some(ServiceRecord::Existing),
            expected_model: None,
            verified_permission_option: false,
        }),
        config_options: vec![],
        mcp: None,
        browser_unavailable: None,
        events: Arc::new(|_| {}),
        result,
    })
    .unwrap();
    let api_session = receive.await.unwrap().unwrap().accept().unwrap().session_id;

    let retained = crate::meta_store::SessionRow {
        id: crate::acp_client::session_index::session_row_id(
            &f.row.id,
            &f.cwd.to_string_lossy(),
            &original,
        ),
        agent_id: f.row.id.clone(),
        cwd: f.cwd.to_string_lossy().into(),
        native_session_id: Some(original.clone()),
        title: Some("Original history".into()),
        config_options: Some(json!({"_farfoldService":{"kind":"existing"}})),
        pinned: true,
        archived: false,
        created_at: 1,
        updated_at: 1,
    };
    f.store.upsert_session(&retained).unwrap();
    let retained = f.store.get_session(&retained.id).unwrap().unwrap();
    let before = requests(&f);
    logout(&f, AuthenticationOperation::new()).await.unwrap();

    for connection in [&original_owner, &sibling_owner, &alias_preparation] {
        assert!(
            connection.life.work().is_err(),
            "a settled process retaining the signed-out account can still accept work"
        );
        assert_ne!(
            crate::platform_tests::process_check(connection.child_pid.load(Ordering::SeqCst) as i32),
            0
        );
    }
    assert!(
        f.manager
            .session_owner(&f.row.id, &f.cwd, &original)
            .unwrap()
            .is_none()
    );
    assert!(
        f.manager
            .session_owner(&alias.id, &f.cwd, &sibling)
            .unwrap()
            .is_none()
    );
    for events in [&original_events, &sibling_events] {
        assert!(
            events
                .lock()
                .unwrap()
                .iter()
                .any(|event| event["kind"] == "connectionLost")
        );
    }
    assert_eq!(f.store.get_session(&retained.id).unwrap(), Some(retained));
    assert!(api.life.work().is_ok());
    assert_eq!(
        crate::platform_tests::process_check(api.child_pid.load(Ordering::SeqCst) as i32),
        0
    );
    f.manager
        .session_prompt(
            &f.row.id,
            &f.cwd,
            &api_session,
            serde_json::from_value(json!([{"type":"text","text":"independent-api"}])).unwrap(),
        )
        .await
        .unwrap();
    until(|| {
        requests(&f).iter().any(|request| {
            request["method"] == "session/prompt" && request["params"]["sessionId"] == api_session
        })
    })
    .await;
    let after = requests(&f);
    for method in ["session/new", "session/load"] {
        assert_eq!(
            before
                .iter()
                .filter(|request| request["method"] == method)
                .count(),
            after
                .iter()
                .filter(|request| request["method"] == method)
                .count(),
            "logout must never replace or restore a conversation automatically"
        );
    }
    assert!(!after.iter().any(|request| {
        request["method"] == "session/prompt" && request["params"]["sessionId"] != api_session
    }));
}

#[tokio::test(flavor = "multi_thread")]
async fn logout_not_sent_preserves_account_conversation() {
    for cancelled in [true, false] {
        let (f, id, owner) = account_conversation().await;
        let operation = AuthenticationOperation::new();
        if cancelled {
            operation.abandon();
        } else {
            std::fs::write(f.cwd.join("status_denied"), "controlled").unwrap();
        }
        assert!(logout(&f, operation).await.is_err());
        assert!(
            !requests(&f)
                .iter()
                .any(|request| request["method"] == "_auth/signOut")
        );
        assert!(owner.life.work().is_ok());
        assert_eq!(
            crate::platform_tests::process_check(owner.child_pid.load(Ordering::SeqCst) as i32),
            0
        );
        assert!(
            f.manager
                .session_owner(&f.row.id, &f.cwd, &id)
                .unwrap()
                .is_some()
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn logout_dispatched_errors_reap_affected_account_copies() {
    for marker in ["partial_error", "keep_credential"] {
        let (f, id, owner) = account_conversation().await;
        let preparation = f.manager.live_connection(&f.row.id, &f.cwd).unwrap();
        let history = f.store.list_sessions().unwrap();
        std::fs::write(f.cwd.join(marker), "controlled").unwrap();
        assert!(logout(&f, AuthenticationOperation::new()).await.is_err());
        assert_eq!(
            requests(&f)
                .iter()
                .filter(|request| request["method"] == "_auth/signOut")
                .count(),
            1
        );
        assert_reaped(&owner);
        assert_reaped(&preparation);
        assert!(
            f.manager
                .session_owner(&f.row.id, &f.cwd, &id)
                .unwrap()
                .is_none()
        );
        assert_eq!(f.store.list_sessions().unwrap(), history);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn logout_acknowledged_but_unconfirmed_status_reaps_old_account_copies() {
    let (f, id, owner) = account_conversation().await;
    let preparation = f.manager.live_connection(&f.row.id, &f.cwd).unwrap();
    std::fs::write(f.cwd.join("post_status_wait"), "controlled").unwrap();
    let mut request = Box::pin(logout(&f, AuthenticationOperation::new()));
    tokio::select! {
        result = &mut request => panic!("completed before its status check: {result:?}"),
        _ = until(|| f.cwd.join("post_status_wait_started").exists()) => {}
    }
    assert!(owner.life.work().is_err());
    let mut alias = f.row.clone();
    alias.id = "custom:status-unknown-alias".into();
    alias.source = "custom".into();
    f.store.insert_agent(&alias).unwrap();
    assert!(f.manager.connect(&alias, &f.cwd, &f.store).await.is_err());
    assert!(
        tokio::time::timeout(Duration::from_secs(5), request)
            .await
            .unwrap()
            .is_err()
    );
    assert_reaped(&owner);
    assert_reaped(&preparation);
    assert!(
        f.manager
            .session_owner(&f.row.id, &f.cwd, &id)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        requests(&f)
            .iter()
            .filter(|request| request["method"] == "_auth/signOut")
            .count(),
        1
    );
    assert!(
        !requests(&f)
            .iter()
            .any(|request| request["method"] == "session/prompt")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelled_dispatched_logout_keeps_account_scope_until_real_reply_and_reap() {
    let (f, _, owner) = account_conversation().await;
    std::fs::write(f.cwd.join("logout_wait"), "controlled").unwrap();
    let operation = AuthenticationOperation::new();
    let mut request = Box::pin(logout(&f, operation.clone()));
    tokio::select! {
        result = &mut request => panic!("completed before its logout reply: {result:?}"),
        _ = until(|| f.cwd.join("logout_wait_started").exists()) => {}
    }
    operation.abandon();
    assert!(owner.life.work().is_err());
    assert!(f.manager.reserve_account_change(&f.row.id).is_err());
    std::fs::write(f.cwd.join("logout_wait_release"), "release").unwrap();
    request.await.unwrap();
    assert_reaped(&owner);
    assert_eq!(
        requests(&f)
            .iter()
            .filter(|request| request["method"] == "_auth/signOut")
            .count(),
        1
    );
}
