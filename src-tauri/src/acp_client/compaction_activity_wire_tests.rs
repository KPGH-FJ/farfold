//! A prompt receipt does not finish separately reported context compaction.
//! Every process, file and protocol event belongs to this temporary fixture.
use super::{
    manager::AcpManager,
    pump::{SessionControl, SessionSink},
};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use std::{
    sync::{Arc, atomic::Ordering},
    time::Duration,
};
use tokio::sync::mpsc;

const PEER: &str = r#"
import sys,json,pathlib,threading,time
lock=threading.Lock();loaded=False
options=[{'id':'format','name':'Format','type':'select','currentValue':'one','options':[{'value':v,'name':v} for v in ['one','two']]}]
def send(v):
 with lock: print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def update(status,id='c'):
 send({'method':'session/update','params':{'sessionId':'compact-tail','update':{'sessionUpdate':'compaction_update','compactionId':id,'status':status,'_meta':{'fixture':'unchanged'}}}})
def release():
 p=pathlib.Path('release')
 while True:
  if p.exists():
   value=p.read_text();p.unlink()
   if value.startswith('{'):send({'method':'session/update','params':{'sessionId':'compact-tail','update':json.loads(value)}})
   else:update(value)
  time.sleep(.01)
threading.Thread(target=release,daemon=True).start()
for line in sys.stdin:
 m=json.loads(line);method=m.get('method');p=m.get('params',{});result={}
 if method=='initialize': result={'protocolVersion':1,'agentCapabilities':{'loadSession':True,'sessionCapabilities':{'close':{},'delete':{}}},'authMethods':[]}
 elif method in ('session/new','session/load'):
  if method=='session/load': loaded=True;update('in_progress','history')
  result=dict(configOptions=options,**({'sessionId':'compact-tail'} if method=='session/new' else {}))
 elif method=='session/prompt':
  if p['prompt'][0]['text']=='start': update('in_progress')
  result={'stopReason':'end_turn'}
 elif method=='session/set_config_option':
  if loaded:update('in_progress','history')
  options[0]['currentValue']=p['value'];result={'configOptions':options}
 if method and 'id' in m:send({'id':m['id'],'result':result})
"#;

struct Fixture {
    _root: tempfile::TempDir,
    cwd: std::path::PathBuf,
    store: MetaStore,
    manager: AcpManager,
    agent: AgentRow,
    session_id: String,
    events: mpsc::UnboundedReceiver<Value>,
}
impl Fixture {
    async fn new(restored: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().canonicalize().unwrap();
        let script = cwd.join("peer.py");
        std::fs::write(&script, PEER).unwrap();
        let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
        let agent = AgentRow {
            id: "compaction-activity-fixture".into(),
            name: "Fixture".into(),
            source: "custom".into(),
            command: crate::platform_tests::python(),
            args: vec!["-u".into(), script.to_string_lossy().into()],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        store.insert_agent(&agent).unwrap();
        let manager = AcpManager::new(cwd.join("logs"), cwd.clone());
        let (send, events) = mpsc::unbounded_channel();
        let sink: SessionSink = Arc::new(move |event| {
            let _ = send.send(event);
        });
        if restored {
            super::session_index::touch_session_row(
                &store,
                &agent.id,
                &cwd.to_string_lossy(),
                "compact-tail",
                None,
                Some(json!({"_farfoldConfig":1,"model":null,"thoughtLevel":null})),
            )
            .unwrap();
        }
        let opened = manager
            .open_session(
                &agent,
                &cwd,
                restored.then(|| "compact-tail".into()),
                vec![],
                sink,
                &store,
            )
            .await
            .unwrap();
        Self {
            _root: root,
            cwd,
            store,
            manager,
            agent,
            session_id: opened.session_id,
            events,
        }
    }
    async fn next(&mut self, kind: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let event = self.events.recv().await.expect("fixture remains open");
                if event["kind"] == kind {
                    return event;
                }
            }
        })
        .await
        .expect("bounded event")
    }
    async fn prompt(&self, text: &str) -> Result<(), String> {
        self.manager
            .session_prompt(
                &self.agent.id,
                &self.cwd,
                &self.session_id,
                serde_json::from_value(json!([{"type":"text","text":text}])).unwrap(),
            )
            .await
    }
    async fn pending() -> Self {
        let mut f = Self::new(false).await;
        f.prompt("start").await.unwrap();
        f.next("turnEnd").await;
        f
    }
    async fn release(&mut self, status: &str) -> Value {
        std::fs::write(self.cwd.join("release"), status).unwrap();
        self.next("compactionActivity").await
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}

#[tokio::test]
async fn compaction_tail_retains_owner_against_idle_reap_and_account_change() {
    let f = Fixture::pending().await;
    let owner = f
        .manager
        .session_connection(&f.agent.id, &f.cwd, &f.session_id)
        .unwrap();
    assert!(
        owner.life.work.load(Ordering::SeqCst) > 0,
        "compaction survives prompt receipt"
    );
    assert!(!owner.life.close(false, Some(Duration::ZERO)).unwrap());
    assert!(owner.life.operation("account_change".into()).is_err());
}

#[tokio::test]
async fn compaction_tail_refuses_a_second_prompt() {
    let f = Fixture::pending().await;
    assert!(
        f.prompt("second").await.is_err(),
        "active compaction must refuse another prompt"
    );
}

#[tokio::test]
async fn compaction_tail_refuses_configuration() {
    let f = Fixture::pending().await;
    assert!(
        f.manager
            .session_set_config(&f.agent.id, &f.cwd, &f.session_id, "format", json!("two"))
            .await
            .is_err(),
        "active compaction must refuse configuration"
    );
}

#[tokio::test]
async fn compaction_tail_refuses_all_destructive_controls() {
    let mut outcomes = Vec::new();
    for variant in 0..3 {
        let f = Fixture::pending().await;
        let owner = f
            .manager
            .session_connection(&f.agent.id, &f.cwd, &f.session_id)
            .unwrap();
        let control = owner
            .sessions
            .lock()
            .unwrap()
            .get(&f.session_id)
            .unwrap()
            .control
            .clone();
        let (result, receive) = tokio::sync::oneshot::channel();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        control
            .send(match variant {
                0 => SessionControl::Close {
                    deadline,
                    result,
                    require_idle_interactions: false,
                },
                1 => SessionControl::Delete { deadline, result },
                _ => SessionControl::Detach { deadline, result },
            })
            .unwrap();
        outcomes.push(receive.await.unwrap().is_err());
    }
    assert_eq!(
        outcomes,
        vec![true; 3],
        "close/delete/detach must all retain active compaction"
    );
}

#[tokio::test]
async fn compaction_tail_refuses_archive_without_changing_the_index() {
    let f = Fixture::pending().await;
    let id =
        super::session_index::session_row_id(&f.agent.id, &f.cwd.to_string_lossy(), &f.session_id);
    let before = f.store.get_session(&id).unwrap();
    assert!(
        f.manager
            .archive_session(&f.store, id.clone(), true)
            .await
            .is_err()
    );
    assert_eq!(f.store.get_session(&id).unwrap(), before);
}

#[tokio::test]
async fn actual_terminal_compaction_releases_only_its_live_owner() {
    for terminal in ["completed", "failed", "cancelled"] {
        let mut f = Fixture::pending().await;
        let owner = f
            .manager
            .session_connection(&f.agent.id, &f.cwd, &f.session_id)
            .unwrap();
        assert!(owner.life.work.load(Ordering::SeqCst) > 0);
        let released = f.release(terminal).await;
        assert_eq!(released["connectionId"], owner.connection_id);
        assert_eq!(released["sessionId"], f.session_id);
        assert_eq!(released["compactionIds"], json!([]));
        assert_eq!(released["uncertain"], false);
        assert_eq!(owner.life.work.load(Ordering::SeqCst), 0);
        f.manager
            .session_set_config(&f.agent.id, &f.cwd, &f.session_id, "format", json!("two"))
            .await
            .unwrap();
        f.prompt("second").await.unwrap();
        f.next("turnEnd").await;
    }
}

#[tokio::test]
async fn unresolved_compaction_is_cleared_only_after_actual_process_end() {
    let mut f = Fixture::pending().await;
    let owner = f
        .manager
        .session_connection(&f.agent.id, &f.cwd, &f.session_id)
        .unwrap();
    f.manager.stop_for_shutdown();
    let ended = f.next("compactionActivity").await;
    assert_eq!(ended["reason"], "process_ended");
    assert_eq!(ended["connectionId"], owner.connection_id);
    assert_eq!(ended["sessionId"], f.session_id);
    assert_eq!(ended["compactionIds"], json!([]));
    f.next("connectionLost").await;
    owner.life.closed().await.unwrap();
    assert_eq!(owner.life.work.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn malformed_terminal_never_reopens_prompt_admission() {
    let mut refused = Vec::new();
    for extra in [
        json!({"summary":17}),
        json!({"error":"oops"}),
        json!({"_meta":[]}),
    ] {
        let mut f = Fixture::pending().await;
        let mut update =
            json!({"sessionUpdate":"compaction_update","compactionId":"c","status":"completed"});
        update
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        std::fs::write(f.cwd.join("release"), serde_json::to_vec(&update).unwrap()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let event = f.events.recv().await.unwrap();
                if event.get("update") == Some(&update) {
                    break;
                }
            }
        })
        .await
        .expect("raw malformed terminal arrives unchanged");
        refused.push(f.prompt("second").await.is_err());
    }
    assert_eq!(
        refused,
        vec![true; 3],
        "raw malformed terminal cannot reopen prompt admission"
    );
}

#[tokio::test]
async fn historical_compaction_does_not_become_current_work() {
    let f = Fixture::new(true).await;
    let owner = f
        .manager
        .session_connection(&f.agent.id, &f.cwd, &f.session_id)
        .unwrap();
    assert_eq!(owner.life.work.load(Ordering::SeqCst), 0);
    f.manager
        .session_set_config(&f.agent.id, &f.cwd, &f.session_id, "format", json!("two"))
        .await
        .unwrap();
    f.manager
        .close_session(&f.agent.id, &f.cwd, &f.session_id)
        .await
        .unwrap();
}
