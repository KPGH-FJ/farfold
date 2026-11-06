use super::*;
use crate::acp_client::pump::{OpenedSession, StoppedToolCloseReceipt};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::json;
use std::sync::mpsc;

const PEER: &str = r#"
import json, os, sys, time
counter=0
prompts={}
cancelled=set()
modes={}
def send(**row):
 print(json.dumps(dict(jsonrpc='2.0',**row)),flush=True)
def tool(s, status, call='same-tool', update='tool_call'):
 send(method='session/update',params={'sessionId':s,'update':{'sessionUpdate':update,'toolCallId':call,'title':'fixture','status':status}})
def permission(s,ordinal):
 call={'toolCallId':'same-tool'}
 if modes[s]=='approval-text':
  call['status']='pending'
  call['content']=[{'type':'content','content':{'type':'text','text':'Approve this exact tool?'}}]
 send(id=f'perm:{s}:{ordinal}',method='session/request_permission',params={'sessionId':s,'toolCall':call,'options':[{'kind':'allow_once','optionId':'allow','name':'Allow once'}]})
for line in sys.stdin:
 msg=json.loads(line); method=msg.get('method'); params=msg.get('params',{}); ident=msg.get('id')
 sid=params.get('sessionId')
 if method:
  with open('calls.jsonl','a') as f: f.write(json.dumps([method,sid])+'\n')
 if method=='initialize':
  send(id=ident,result={'protocolVersion':1,'agentCapabilities':{'sessionCapabilities':{'close':{}}},'authMethods':[]})
 elif method=='session/new':
  counter+=1
  send(id=ident,result={'sessionId':f'session-{counter}'})
 elif method=='session/prompt':
  prompts[sid]=ident
  modes[sid]=params['prompt'][0]['text']
  tool(sid,'pending')
  permission(sid,1)
  if modes[sid]=='running': tool(sid,'in_progress',update='tool_call_update')
 elif method=='session/cancel':
  cancelled.add(sid)
 elif method=='session/close':
  if modes[sid]=='late': tool(sid,'in_progress',call='other-tool')
  if modes[sid]=='hold-close':
   until=time.monotonic()+5
   while not os.path.exists('finish-close') and time.monotonic()<until: time.sleep(.005)
  send(id=ident,result={'accepted':True} if modes[sid]=='weak' else {})
 elif isinstance(ident,str) and ident.startswith('perm:'):
  _,sid,ordinal=ident.split(':')
  outcome=msg.get('result',{}).get('outcome',{}).get('outcome')
  if outcome=='selected' and modes[sid]=='second' and ordinal=='1':
   permission(sid,2)
  elif outcome=='selected':
   tool(sid,'completed',update='tool_call_update')
   send(id=prompts.pop(sid),result={'stopReason':'end_turn'})
  elif outcome=='cancelled' and sid in cancelled:
   send(id=prompts.pop(sid),result={'stopReason':'cancelled'})
"#;

struct Fixture {
    manager: Arc<AcpManager>,
    store: MetaStore,
    row: AgentRow,
    cwd: std::path::PathBuf,
    _dir: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().canonicalize().unwrap();
        std::fs::write(cwd.join("peer.py"), PEER).unwrap();
        let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
        let row = AgentRow {
            id: "stopped-tool-fixture".into(),
            name: "Fixture".into(),
            source: "registry".into(),
            command: crate::platform_tests::python(),
            args: vec!["-u".into(), cwd.join("peer.py").to_string_lossy().into()],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        store.insert_agent(&row).unwrap();
        Self {
            manager: Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone())),
            store,
            row,
            cwd,
            _dir: dir,
        }
    }

    async fn open(&self) -> (OpenedSession, mpsc::Receiver<Value>) {
        let (tx, rx) = mpsc::channel();
        let events = Arc::new(move |event| {
            let _ = tx.send(event);
        });
        let opened = self
            .manager
            .open_session(&self.row, &self.cwd, None, vec![], events, &self.store)
            .await
            .unwrap();
        (opened, rx)
    }

    async fn open_on_connection(
        &self,
        owner: &OpenedSession,
    ) -> (OpenedSession, mpsc::Receiver<Value>) {
        use crate::acp_client::{
            model_guard::ConfigStore, open_purpose::OpenPurpose, service_connection::ServiceRecord,
        };
        let connection = self
            .manager
            .session_connection(&self.row.id, &self.cwd, &owner.session_id)
            .unwrap();
        let (tx, rx) = mpsc::channel();
        let (result, receive) = oneshot::channel();
        connection
            .send_reserved(
                ManagerCommand::OpenSession {
                    fork_owned: false,
                    purpose: OpenPurpose::Conversation,
                    native_session_id: None,
                    preview_token: None,
                    opening_token: None,
                    recorded_config: None,
                    config_store: Box::new(ConfigStore {
                        store: self.store.clone(),
                        agent_id: self.row.id.clone(),
                        cwd: self.cwd.to_string_lossy().into(),
                        service_record: Some(ServiceRecord::Existing),
                        expected_model: None,
                        verified_permission_option: false,
                    }),
                    config_options: vec![],
                    mcp: None,
                    browser_unavailable: None,
                    events: Arc::new(move |event| {
                        let _ = tx.send(event);
                    }),
                    result,
                },
                Some(
                    self.manager
                        .opening_sessions
                        .reserve_open(&self.row.id, &self.cwd, None)
                        .unwrap(),
                ),
            )
            .unwrap();
        (receive.await.unwrap().unwrap().accept().unwrap(), rx)
    }

    async fn prompt(&self, opened: &OpenedSession, text: &str) {
        let blocks = serde_json::from_value(json!([{"type":"text","text":text}])).unwrap();
        self.manager
            .session_prompt(&self.row.id, &self.cwd, &opened.session_id, blocks)
            .await
            .unwrap();
    }

    async fn stop(&self, opened: &OpenedSession, rx: &mpsc::Receiver<Value>) {
        self.manager
            .session_cancel(&self.row.id, &self.cwd, &opened.session_id)
            .await
            .unwrap();
        assert_eq!(next(rx, "turnEnd")["stopReason"], "cancelled");
    }

    async fn check(&self, opened: &OpenedSession) -> Option<StoppedToolCloseReceipt> {
        self.manager
            .check_unapproved_stopped_close(
                &self.row.id,
                &self.cwd,
                &opened.session_id,
                &opened.connection_id,
            )
            .await
            .unwrap()
    }

    async fn close(
        &self,
        opened: &OpenedSession,
        proof: &StoppedToolCloseReceipt,
    ) -> Result<StoppedToolCloseReceipt, String> {
        self.manager
            .close_unapproved_stopped(
                &self.row.id,
                &self.cwd,
                &opened.session_id,
                &opened.connection_id,
                proof.tool_call_id.clone(),
                proof.proof_id.clone(),
            )
            .await
    }

    fn closes(&self) -> Vec<Value> {
        std::fs::read_to_string(self.cwd.join("calls.jsonl"))
            .unwrap()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|call| call[0] == "session/close")
            .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}

fn next(rx: &mpsc::Receiver<Value>, kind: &str) -> Value {
    loop {
        let event = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        if event["kind"] == kind {
            return event;
        }
    }
}

fn allow(f: &Fixture, opened: &OpenedSession, request: &Value) {
    let reply = f
        .manager
        .permission_respond(
            request["requestId"].as_str().unwrap(),
            "allow",
            &opened.session_id,
        )
        .unwrap();
    assert_eq!(reply.status, "submitted");
}

#[tokio::test(flavor = "multi_thread")]
async fn stopped_tool_close_releases_exact_route_and_lease_while_other_approval_is_live() {
    let f = Fixture::new();
    let (a, a_events) = f.open().await;
    let (b, b_events) = f.open_on_connection(&a).await;
    assert_eq!(a.connection_id, b.connection_id);
    assert_ne!(a.session_id, b.session_id);
    f.prompt(&a, "approval-text").await;
    next(&a_events, "permissionRequest");
    assert!(f.check(&a).await.is_none());
    f.stop(&a, &a_events).await;
    let proof = f.check(&a).await.unwrap();
    assert_eq!(proof.tool_call_id, "same-tool");
    assert_eq!(proof.connection_id, a.connection_id);
    assert_eq!(proof.session_id, a.session_id);

    let mut stale = proof.clone();
    stale.proof_id.push('0');
    assert!(f.close(&a, &stale).await.is_err());
    assert!(
        f.manager
            .check_unapproved_stopped_close(&f.row.id, &f.cwd, &a.session_id, "stale-connection")
            .await
            .is_err()
    );
    assert!(
        f.manager
            .close_session(&f.row.id, &f.cwd, &a.session_id)
            .await
            .is_err()
    );
    assert!(f.closes().is_empty());

    f.prompt(&b, "first").await;
    let b_request = next(&b_events, "permissionRequest");
    let connection = f
        .manager
        .session_connection(&f.row.id, &f.cwd, &a.session_id)
        .unwrap();
    let work_before = connection.life.work.load(Ordering::SeqCst);
    assert_eq!(f.close(&a, &proof).await.unwrap(), proof);
    assert!(
        f.manager
            .session_connection(&f.row.id, &f.cwd, &a.session_id)
            .is_err()
    );
    assert!(
        f.manager
            .session_connection(&f.row.id, &f.cwd, &b.session_id)
            .is_ok()
    );
    assert_eq!(connection.life.work.load(Ordering::SeqCst), work_before - 1);
    allow(&f, &b, &b_request);
    assert_eq!(next(&b_events, "turnEnd")["stopReason"], "end_turn");
    assert_eq!(f.closes(), [json!(["session/close", a.session_id])]);
}

#[tokio::test(flavor = "multi_thread")]
async fn stopped_tool_close_blocks_prior_approval_even_if_second_approval_is_held() {
    let f = Fixture::new();
    let (a, events) = f.open().await;
    f.prompt(&a, "second").await;
    let first = next(&events, "permissionRequest");
    allow(&f, &a, &first);
    next(&events, "permissionRequest");
    f.stop(&a, &events).await;
    assert!(f.check(&a).await.is_none());
    assert!(f.closes().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn stopped_tool_close_blocks_running_evidence_even_before_an_approval() {
    let f = Fixture::new();
    let (a, events) = f.open().await;
    f.prompt(&a, "running").await;
    next(&events, "permissionRequest");
    f.stop(&a, &events).await;
    assert!(f.check(&a).await.is_none());
    assert!(f.closes().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn stopped_tool_close_keeps_route_and_work_for_weak_ack_or_late_other_work() {
    for mode in ["weak", "late"] {
        let f = Fixture::new();
        let (a, events) = f.open().await;
        f.prompt(&a, mode).await;
        next(&events, "permissionRequest");
        f.stop(&a, &events).await;
        let proof = f.check(&a).await.unwrap();
        let connection = f
            .manager
            .session_connection(&f.row.id, &f.cwd, &a.session_id)
            .unwrap();
        let work_before = connection.life.work.load(Ordering::SeqCst);
        assert!(f.close(&a, &proof).await.is_err());
        assert!(f.check(&a).await.is_none());
        assert!(f.close(&a, &proof).await.is_err());
        assert!(
            f.manager
                .session_connection(&f.row.id, &f.cwd, &a.session_id)
                .is_ok()
        );
        assert_eq!(connection.life.work.load(Ordering::SeqCst), work_before);
        assert_eq!(f.closes(), [json!(["session/close", a.session_id])]);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn stopped_tool_close_dropped_waiter_retains_route_after_late_exact_ack() {
    let f = Fixture::new();
    let (a, events) = f.open().await;
    f.prompt(&a, "hold-close").await;
    next(&events, "permissionRequest");
    f.stop(&a, &events).await;
    let proof = f.check(&a).await.unwrap();
    let connection = f
        .manager
        .session_connection(&f.row.id, &f.cwd, &a.session_id)
        .unwrap();
    let work_before = connection.life.work.load(Ordering::SeqCst);
    let entry = connection
        .sessions
        .lock()
        .unwrap()
        .get(&a.session_id)
        .unwrap()
        .control
        .clone();
    let (result, receive) = oneshot::channel();
    entry
        .send(SessionControl::CloseUnapprovedStopped {
            tool_call_id: proof.tool_call_id.clone(),
            proof_id: proof.proof_id.clone(),
            deadline: tokio::time::Instant::now() + std::time::Duration::from_secs(4),
            result,
        })
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while f.closes().is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    drop(receive);
    std::fs::write(f.cwd.join("finish-close"), "").unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if connection
                .life
                .operation(format!("open:{}", a.session_id))
                .is_ok()
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(f.check(&a).await.is_none());
    assert!(f.close(&a, &proof).await.is_err());
    assert!(
        f.manager
            .session_connection(&f.row.id, &f.cwd, &a.session_id)
            .is_ok()
    );
    assert_eq!(connection.life.work.load(Ordering::SeqCst), work_before);
    assert_eq!(f.closes(), [json!(["session/close", a.session_id])]);
}
