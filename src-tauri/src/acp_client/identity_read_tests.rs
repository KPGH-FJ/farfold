use super::*;
use crate::meta_store::{AgentRow, MetaStore};
use std::path::PathBuf;

impl Availability {
    fn enable_for_test(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
}
const PEER: &str = r#"
import sys,json,threading,pathlib,time,signal,os
lock=threading.Lock()
def send(v):
 with lock:print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def reply(m,v):send({'id':m['id'],'result':v})
def identity(m):
 pathlib.Path('identity-started').write_text('started')
 while pathlib.Path('hold').exists():time.sleep(.005)
 if pathlib.Path('unsupported').exists():send({'id':m['id'],'error':{'code':-32601,'message':'PRIVATE_SENTINEL'}});return
 if pathlib.Path('rpc-error').exists():send({'id':m['id'],'error':{'code':-32603,'message':'PRIVATE_SENTINEL'}});return
 if pathlib.Path('invalid').exists():reply(m,{'email':True});return
 if pathlib.Path('empty').exists():reply(m,{});return
 if pathlib.Path('updates').exists():
  for model in ['b','a']:
   send({'method':'session/update','params':{'sessionId':'owned-identity','update':{'sessionUpdate':'config_option_update','configOptions':[{'id':'model','name':'Model','type':'select','category':'model','currentValue':model,'options':[{'value':model,'name':model}]}]}}})
 if pathlib.Path('mode-update').exists():send({'method':'session/update','params':{'sessionId':'owned-identity','update':{'sessionUpdate':'current_mode_update','currentModeId':'second'}}})
 reply(m,{'id':'PRIVATE_SENTINEL','email':'owned@example.test','firstName':'First','lastName':'Last','workspace':{'id':'PRIVATE_SENTINEL','name':'Workspace'},'organization':{'id':'PRIVATE_SENTINEL','name':'Organization'},'token':'PRIVATE_SENTINEL','plan':'PRIVATE_SENTINEL'})
for line in sys.stdin:
 m=json.loads(line);method=m.get('method')
 with open('identity-trace.jsonl','a') as f:f.write(json.dumps({'method':method,'params':m.get('params')})+'\n')
 if method=='initialize':reply(m,{'protocolVersion':1,'agentCapabilities':{'loadSession':True,'sessionCapabilities':{'fork':{},'close':{}}} if pathlib.Path('fork-capable').exists() else {},'authMethods':[]})
 elif method=='session/new':reply(m,{'sessionId':'owned-identity','configOptions':[{'id':'model','name':'Model','type':'select','category':'model','currentValue':'a','options':[{'value':'a','name':'A'}]}] if pathlib.Path('fork-capable').exists() else []})
 elif method=='session/prompt':reply(m,{'stopReason':'end_turn'})
 elif method=='_identity/read':
  if pathlib.Path('transport-error').exists():
   signal.signal(signal.SIGTERM,lambda *a:None)
   os.close(1)
   while True:time.sleep(.1)
  threading.Thread(target=identity,args=(m,),daemon=True).start()
 else:send({'id':m.get('id'),'error':{'code':-32601,'message':'PRIVATE_SENTINEL'}})
"#;
struct Fixture {
    _dir: tempfile::TempDir,
    cwd: PathBuf,
    store: MetaStore,
    row: AgentRow,
    manager: Arc<AcpManager>,
    settled: Arc<AtomicBool>,
}
impl Fixture {
    async fn open() -> (Self, ManagedConnection) {
        Self::open_with_fork(false).await
    }
    async fn open_with_fork(fork: bool) -> (Self, ManagedConnection) {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().canonicalize().unwrap();
        std::fs::write(cwd.join("peer.py"), PEER).unwrap();
        if fork {
            std::fs::write(cwd.join("fork-capable"), "").unwrap();
        }
        let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
        let row = AgentRow {
            id: "identity-fixture".into(),
            name: "Fixture".into(),
            source: "custom".into(),
            command: crate::platform_tests::python(),
            args: vec!["-u".into(), cwd.join("peer.py").to_string_lossy().into()],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        store.insert_agent(&row).unwrap();
        let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
        let settled = Arc::new(AtomicBool::new(false));
        let observed = settled.clone();
        let opened = manager
            .open_session(
                &row,
                &cwd,
                None,
                vec![],
                Arc::new(move |event| {
                    if event["kind"] == "turnEnd" {
                        observed.store(true, Ordering::SeqCst);
                    }
                }),
                &store,
            )
            .await
            .unwrap();
        let connection = manager
            .session_connection(&row.id, &cwd, &opened.session_id)
            .unwrap();
        connection.identity_read.enable_for_test();
        (
            Self {
                _dir: dir,
                cwd,
                store,
                row,
                manager,
                settled,
            },
            connection,
        )
    }
    fn trace(&self) -> Vec<Value> {
        std::fs::read_to_string(self.cwd.join("identity-trace.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect()
    }
    async fn read(&self, c: &ManagedConnection) -> Reply {
        self.manager
            .identity_read(&self.row.id, &self.cwd, "owned-identity", &c.connection_id)
            .await
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn identity_read_pending_rejects_real_fork_before_preflight_can_drain() {
    let (f, c) = Fixture::open_with_fork(true).await;
    f.manager
        .session_prompt(
            &f.row.id,
            &f.cwd,
            "owned-identity",
            serde_json::from_value(json!([{"type":"text","text":"owned parent"}])).unwrap(),
        )
        .await
        .unwrap();
    until(|| f.settled.load(Ordering::SeqCst)).await;
    assert!(super::super::session_fork::capabilities(&c, "owned-identity").fork_current_context);
    let saved = f.store.list_sessions().unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(
        saved[0].config_options,
        Some(
            json!({"choices":[{"id":"model","category":"model","type":"select","value":"a"}],"_farfoldConfig":2,"_farfoldService":{"kind":"existing"}})
        )
    );
    std::fs::write(f.cwd.join("hold"), "").unwrap();
    let mut read = Box::pin(f.read(&c));
    tokio::select! {_=&mut read=>panic!("held identity finished"),_=until(||f.cwd.join("identity-started").exists())=>{}}
    let fork = f
        .manager
        .fork_current(
            f.row.clone(),
            &f.cwd,
            "owned-identity",
            &c.connection_id,
            "identity-fork".into(),
            "identity-fork-open".into(),
            Arc::new(|_| {}),
            Arc::new(AtomicBool::new(false)),
            &f.store,
            None,
        )
        .await
        .unwrap();
    assert_eq!(fork.status, "rejected");
    assert_eq!(fork.reason, Some("busy"));
    assert!(f.manager.reserve_account_change(&f.row.id).is_err());
    std::fs::remove_file(f.cwd.join("hold")).unwrap();
    assert!(read.await.unwrap().identity.is_some());
    assert_eq!(
        f.trace()
            .iter()
            .filter(|v| v["method"] == "session/fork")
            .count(),
        0
    );
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}
async fn until(mut f: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !f() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn identity_read_current_session_uses_only_exact_wire_and_whitelist() {
    let (f, c) = Fixture::open().await;
    let reply = f.read(&c).await.unwrap();
    assert_eq!(reply.connection_id, c.connection_id);
    assert_eq!(reply.native_session_id, "owned-identity");
    assert_eq!(reply.cwd, f.cwd.to_string_lossy());
    assert_eq!(
        serde_json::to_value(&reply.identity).unwrap(),
        json!({"email":"owned@example.test","displayName":"First Last","workspaceName":"Workspace","organizationName":"Organization"})
    );
    let calls = f.trace();
    assert_eq!(
        calls
            .iter()
            .map(|v| v["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["initialize", "session/new", "_identity/read"]
    );
    assert_eq!(calls[2]["params"], json!({"sessionId":"owned-identity"}));
    assert!(
        !serde_json::to_string(&reply)
            .unwrap()
            .contains("PRIVATE_SENTINEL")
    );
    assert!(c.account.lock().unwrap().is_none());
    assert!(f.store.list_sessions().unwrap().is_empty());
}
#[tokio::test(flavor = "multi_thread")]
async fn identity_read_empty_response_is_not_a_global_signed_out_or_plan() {
    let (f, c) = Fixture::open().await;
    std::fs::write(f.cwd.join("empty"), "").unwrap();
    let reply = f.read(&c).await.unwrap();
    assert_eq!(reply.identity, None);
    assert!(c.account.lock().unwrap().is_none());
    assert_eq!(
        f.trace()
            .iter()
            .filter(|v| v["method"] == "_identity/read")
            .count(),
        1
    );
}

#[test]
fn identity_read_projection_is_bounded_camel_case_only_and_never_a_plan() {
    assert!(Availability::new(None).capability().is_none());
    assert!(
        Availability::new(Some(super::super::account_query::AccountQuery::CodeBuddy))
            .capability()
            .is_none()
    );
    assert_eq!(
        Availability::new(Some(super::super::account_query::AccountQuery::Vibe))
            .capability()
            .unwrap()
            .provenance,
        "reviewed-official-supplement"
    );
    assert_eq!(parse(&json!({})).unwrap(), None);
    assert_eq!(
        parse(&json!({"id":"PRIVATE_SENTINEL","plan":"PRIVATE_SENTINEL"})).unwrap(),
        None
    );
    let first = parse(
        &json!({"firstName":"First","first_name":"PRIVATE_SENTINEL","email":"owned@example.test"}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(first.display_name.as_deref(), Some("First"));
    assert_eq!(first.workspace_name, None);
    for value in [
        Value::Null,
        json!([]),
        json!({"email":true}),
        json!({"email":"bad\n@example.test"}),
        json!({"email":"bad @example.test"}),
        json!({"firstName":"x".repeat(257)}),
        json!({"workspace":"PRIVATE_SENTINEL"}),
        json!({"organization":{"name":false}}),
        json!({"token":"x".repeat(16*1024)}),
    ] {
        assert_eq!(parse(&value).unwrap_err().code, Code::InvalidResponse);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn identity_read_missing_foreign_preview_and_unreviewed_send_no_query() {
    let (f, c) = Fixture::open().await;
    for (session, id) in [
        ("missing", c.connection_id.as_str()),
        ("owned-identity", "foreign"),
    ] {
        assert!(
            f.manager
                .identity_read(&f.row.id, &f.cwd, session, id)
                .await
                .is_err()
        );
    }
    let foreign = tempfile::tempdir().unwrap();
    assert!(
        f.manager
            .identity_read(
                &f.row.id,
                foreign.path(),
                "owned-identity",
                &c.connection_id
            )
            .await
            .is_err()
    );
    c.identity_read.0.store(false, Ordering::SeqCst);
    assert_eq!(f.read(&c).await.unwrap_err().code, Code::Unavailable);
    c.identity_read.enable_for_test();
    c.sessions
        .lock()
        .unwrap()
        .get_mut("owned-identity")
        .unwrap()
        .preview_token = Some("preview".into());
    assert_eq!(f.read(&c).await.unwrap_err().code, Code::Unavailable);
    assert_eq!(
        f.trace()
            .iter()
            .filter(|v| v["method"] == "_identity/read")
            .count(),
        0
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn identity_read_real_method_not_found_revokes_only_this_supplement() {
    let (f, c) = Fixture::open().await;
    std::fs::write(f.cwd.join("unsupported"), "").unwrap();
    for _ in 0..2 {
        assert_eq!(f.read(&c).await.unwrap_err().code, Code::Unavailable);
    }
    assert!(c.identity_read.capability().is_none());
    assert_eq!(
        f.trace()
            .iter()
            .filter(|v| v["method"] == "_identity/read")
            .count(),
        1
    );
    assert!(c.account.lock().unwrap().is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn identity_read_real_errors_and_bad_fields_are_safe_and_release_after_response() {
    for (flag, code) in [
        ("rpc-error", Code::QueryFailed),
        ("invalid", Code::InvalidResponse),
    ] {
        let (f, c) = Fixture::open().await;
        std::fs::write(f.cwd.join(flag), "").unwrap();
        let error = f.read(&c).await.unwrap_err();
        assert_eq!(error.code, code);
        assert!(
            !serde_json::to_string(&error)
                .unwrap()
                .contains("PRIVATE_SENTINEL")
        );
        assert!(f.manager.reserve_account_change(&f.row.id).is_ok());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn identity_read_accepts_immediate_responses_without_registration_gap() {
    let (f, c) = Fixture::open().await;
    for _ in 0..8 {
        assert!(f.read(&c).await.unwrap().identity.is_some());
    }
    assert_eq!(
        f.trace()
            .iter()
            .filter(|v| v["method"] == "_identity/read")
            .count(),
        8
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn identity_read_config_aba_and_legacy_mode_updates_discard_late_identity() {
    for flag in ["updates", "mode-update"] {
        let (f, c) = Fixture::open().await;
        std::fs::write(f.cwd.join(flag), "").unwrap();
        assert_eq!(f.read(&c).await.unwrap_err().code, Code::Changed);
        assert!(f.manager.reserve_account_change(&f.row.id).is_ok());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn identity_read_late_owner_replacement_cannot_publish_to_new_owner() {
    let (f, c) = Fixture::open().await;
    std::fs::write(f.cwd.join("hold"), "").unwrap();
    let read = f.read(&c);
    tokio::pin!(read);
    tokio::select! {_=&mut read=>panic!("held identity finished"),_=until(||f.cwd.join("identity-started").exists())=>{}}
    c.sessions
        .lock()
        .unwrap()
        .get_mut("owned-identity")
        .unwrap()
        .preview_token = Some("changed".into());
    std::fs::remove_file(f.cwd.join("hold")).unwrap();
    assert_eq!(read.await.unwrap_err().code, Code::Changed);
    assert_eq!(
        f.trace()
            .iter()
            .filter(|v| v["method"] == "_identity/read")
            .count(),
        1
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn identity_read_timeout_keeps_account_and_alias_admission_until_real_reply() {
    let (f, c) = Fixture::open().await;
    std::fs::write(f.cwd.join("hold"), "").unwrap();
    let read = f.manager.identity_read_until(
        &f.row.id,
        &f.cwd,
        "owned-identity",
        &c.connection_id,
        tokio::time::Instant::now() + Duration::from_millis(80),
    );
    assert_eq!(read.await.unwrap_err().code, Code::Timeout);
    assert!(f.cwd.join("identity-started").exists());
    assert!(f.manager.reserve_account_change(&f.row.id).is_err());
    assert!(c.life.operation("open:another".into()).is_err());
    let other = tempfile::tempdir().unwrap();
    assert!(
        f.manager
            .connect(&f.row, other.path(), &f.store)
            .await
            .is_err()
    );
    std::fs::remove_file(f.cwd.join("hold")).unwrap();
    until(|| f.manager.reserve_account_change(&f.row.id).is_ok()).await;
    assert!(c.account.lock().unwrap().is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn identity_read_closed_delivery_keeps_scope_and_rejects_config_confirmation() {
    let (f, c) = Fixture::open().await;
    std::fs::write(f.cwd.join("hold"), "").unwrap();
    let mut read = Box::pin(f.read(&c));
    tokio::select! {_=&mut read=>panic!("held identity finished"),_=until(||f.cwd.join("identity-started").exists())=>{}}
    let (send, receive) = oneshot::channel();
    c.sessions
        .lock()
        .unwrap()
        .get("owned-identity")
        .unwrap()
        .control
        .send(super::super::pump::SessionControl::ConfirmConfig {
            displayed: Value::Null,
            restore_selection: Some(json!({"model":"a"})),
            deadline: tokio::time::Instant::now() + Duration::from_secs(1),
            result: send,
        })
        .unwrap();
    assert_eq!(
        receive.await.unwrap().unwrap_err(),
        ReadError::from(Code::Busy).message
    );
    assert!(f.manager.reserve_account_change(&f.row.id).is_err());
    // Withdraw the local read interest, not its external operation.
    drop(read);
    assert!(f.manager.reserve_account_change(&f.row.id).is_err());
    std::fs::remove_file(f.cwd.join("hold")).unwrap();
    until(|| f.manager.reserve_account_change(&f.row.id).is_ok()).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn identity_read_expired_or_closed_before_first_poll_has_zero_wire() {
    let (f, c) = Fixture::open().await;
    for expired in [true, false] {
        let scope = f
            .manager
            .workspace_access_configuration_scope(&f.row.id, &c)
            .unwrap();
        let (send, receive) = oneshot::channel();
        let request = Request {
            connection_id: c.connection_id.clone(),
            session_id: "owned-identity".into(),
            cwd: f.cwd.to_string_lossy().into(),
            availability: c.identity_read.clone(),
            current_owner: Arc::new(|| true),
        };
        let deadline = if expired {
            tokio::time::Instant::now() - Duration::from_secs(1)
        } else {
            tokio::time::Instant::now() + Duration::from_secs(1)
        };
        let receive = if expired {
            Some(receive)
        } else {
            drop(receive);
            None
        };
        c.sessions
            .lock()
            .unwrap()
            .get("owned-identity")
            .unwrap()
            .control
            .send(super::super::pump::SessionControl::IdentityRead {
                request: Box::new(request),
                scope,
                result: send,
                deadline,
            })
            .unwrap();
        if let Some(receive) = receive {
            // The existing actor may drop an abandoned control before replying;
            // the public manager maps that closed channel to Changed.
            assert!(matches!(receive.await, Err(_) | Ok(Err(_))));
        }
        until(|| f.manager.reserve_account_change(&f.row.id).is_ok()).await;
    }
    assert_eq!(
        f.trace()
            .iter()
            .filter(|v| v["method"] == "_identity/read")
            .count(),
        0
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn identity_read_expired_manager_admission_has_safe_error_and_zero_wire() {
    let (f, c) = Fixture::open().await;
    let error = f
        .manager
        .identity_read_until(
            &f.row.id,
            &f.cwd,
            "owned-identity",
            &c.connection_id,
            tokio::time::Instant::now() - Duration::from_secs(1),
        )
        .await
        .unwrap_err();
    assert_eq!(error, ReadError::from(Code::Changed));
    assert!(f.manager.reserve_account_change(&f.row.id).is_ok());
    assert_eq!(
        f.trace()
            .iter()
            .filter(|v| v["method"] == "_identity/read")
            .count(),
        0
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn identity_read_unwitnessed_transport_error_survives_actor_end_until_actual_reap() {
    let (f, c) = Fixture::open().await;
    std::fs::write(f.cwd.join("transport-error"), "").unwrap();
    let error = f.read(&c).await.unwrap_err();
    assert!(
        matches!(error.code, Code::QueryFailed | Code::Changed),
        "unwitnessed transport error code={:?}",
        error.code
    );
    assert!(!c.life.finished());
    assert!(f.manager.reserve_account_change(&f.row.id).is_err());
    c.life.close(true, None).unwrap();
    assert!(!c.life.finished());
    assert!(f.manager.reserve_account_change(&f.row.id).is_err());
    tokio::time::timeout(Duration::from_secs(8), c.life.terminated())
        .await
        .unwrap();
    until(|| f.manager.reserve_account_change(&f.row.id).is_ok()).await;
    assert_eq!(
        f.trace()
            .iter()
            .filter(|v| v["method"] == "_identity/read")
            .count(),
        1
    );
}
