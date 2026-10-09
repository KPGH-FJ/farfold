//! Compaction reports through the official typed ACP client and session pump.
//! The synthetic peer supplies protocol values; no real Agent or billing is used.
use super::{manager::AcpManager, pump::SessionSink};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::sync::mpsc;

const PEER: &str = r#"
import sys,json
def send(v): print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def reply(m,r): send({'id':m['id'],'result':r})
capability=None
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); p=m.get('params',{})
 if method=='initialize':
  capability=p.get('clientCapabilities',{}).get('session',{}).get('compaction')
  reply(m,{'protocolVersion':1,'agentCapabilities':{},'authMethods':[]})
 elif method=='session/new': reply(m,{'sessionId':'compaction-fixture'})
 elif method=='session/prompt':
  send({'method':'_fixture/capability','params':{'sessionId':p['sessionId'],'compaction':capability}})
  if isinstance(capability,dict):
   for update in [
    {'sessionUpdate':'compaction_update','compactionId':'c','status':'in_progress','_meta':{'future':1}},
    {'sessionUpdate':'compaction_summary_chunk','compactionId':'c','content':{'type':'text','text':'retained'},'_meta':{'chunk':True}},
    {'sessionUpdate':'compaction_update','compactionId':'c','status':'completed','summary':None,'_meta':None},
    {'sessionUpdate':'compaction_update','compactionId':'future','status':'_future','future':{'intact':True}}]:
    send({'method':'session/update','params':{'sessionId':p['sessionId'],'update':update}})
  reply(m,{'stopReason':'end_turn'})
"#;

struct Fixture {
    _root: tempfile::TempDir,
    cwd: std::path::PathBuf,
    manager: AcpManager,
    agent: AgentRow,
    session_id: String,
    events: mpsc::UnboundedReceiver<Value>,
}

impl Fixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().canonicalize().unwrap();
        let script = cwd.join("peer.py");
        std::fs::write(&script, PEER).unwrap();
        let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
        let agent = AgentRow {
            id: "compaction-wire-fixture".into(),
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
        let opened = manager
            .open_session(&agent, &cwd, None, vec![], sink, &store)
            .await
            .unwrap();
        Self {
            _root: root,
            cwd,
            manager,
            agent,
            session_id: opened.session_id,
            events,
        }
    }

    async fn prompt(&mut self, mode: &str) -> Vec<Value> {
        self.manager
            .session_prompt(
                &self.agent.id,
                &self.cwd,
                &self.session_id,
                serde_json::from_value(json!([{"type":"text","text":mode}])).unwrap(),
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut received = Vec::new();
            loop {
                let event = self.events.recv().await.expect("fixture remains open");
                let complete = event["kind"] == "turnEnd";
                received.push(event);
                if complete {
                    return received;
                }
            }
        })
        .await
        .expect("bounded fixture prompt completion")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}

#[tokio::test]
async fn compaction_capability_is_the_official_object_on_the_live_handshake() {
    let mut f = Fixture::new().await;
    let events = f.prompt("complete").await;
    let report = events
        .iter()
        .find(|e| e["method"] == "_fixture/capability")
        .unwrap();
    assert_eq!(report["params"]["compaction"], json!({}));
}

#[tokio::test]
async fn compaction_patches_chunks_nulls_and_unknown_status_reach_the_session_unchanged() {
    let mut f = Fixture::new().await;
    let events = f.prompt("complete").await;
    let updates: Vec<_> = events.iter().filter_map(|e| e.get("update")).collect();
    assert_eq!(
        updates,
        vec![
            &json!({"sessionUpdate":"compaction_update","compactionId":"c","status":"in_progress","_meta":{"future":1}}),
            &json!({"sessionUpdate":"compaction_summary_chunk","compactionId":"c","content":{"type":"text","text":"retained"},"_meta":{"chunk":true}}),
            &json!({"sessionUpdate":"compaction_update","compactionId":"c","status":"completed","summary":null,"_meta":null}),
            &json!({"sessionUpdate":"compaction_update","compactionId":"future","status":"_future","future":{"intact":true}}),
        ]
    );
    assert_eq!(events.last().unwrap()["stopReason"], "end_turn");
}
