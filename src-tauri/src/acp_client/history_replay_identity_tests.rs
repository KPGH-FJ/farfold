//! Official load replay identity and error boundaries through synthetic stdio.
//! This proves host transport behavior, never real Agent history completeness.
use super::{manager::AcpManager, session_discovery::open_import_preview};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

const PEER: &str = r#"
import sys,json
def send(v): print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def reply(m,r): send({'id':m['id'],'result':r})
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); p=m.get('params',{})
 if method=='initialize': reply(m,{'protocolVersion':1,'agentCapabilities':{'loadSession':True},'authMethods':[]})
 elif method=='session/load':
  chunks=[('user_message_chunk','user-1','First '),('user_message_chunk','user-1','message'),('user_message_chunk','user-2','First message'),('agent_message_chunk','agent-1','First answer'),('agent_message_chunk','agent-2','Second answer')]
  for role,id,text in chunks:
   send({'method':'session/update','params':{'sessionId':p['sessionId'],'update':{'sessionUpdate':role,'messageId':id,'content':{'type':'text','text':text},'_meta':{'futureField':id}}}})
  if p['sessionId']=='fails-after-prefix': send({'id':m['id'],'error':{'code':-32603,'message':'fixture history read failed'}})
  else: reply(m,{'_meta':{'fixture':'load-response-is-the-protocol-boundary'}})
 elif method=='session/new': raise AssertionError('history must never silently become a new session')
"#;

struct Fixture {
    _root: tempfile::TempDir,
    cwd: std::path::PathBuf,
    store: MetaStore,
    manager: AcpManager,
    agent: AgentRow,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().canonicalize().unwrap();
        let script = cwd.join("peer.py");
        std::fs::write(&script, PEER).unwrap();
        let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
        let agent = AgentRow {
            id: "replay-identity-fixture".into(),
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
        Self {
            manager: AcpManager::new(cwd.join("logs"), cwd.clone()),
            _root: root,
            cwd,
            store,
            agent,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}

#[tokio::test]
async fn load_replay_preserves_official_message_ids_and_unknown_fields_before_local_marker() {
    let f = Fixture::new();
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let received = events.clone();
    let channel = tauri::ipc::Channel::new(move |body| {
        received.lock().unwrap().push(body.deserialize::<Value>()?);
        Ok(())
    });
    let preview = open_import_preview(
        &f.manager,
        &f.store,
        &f.agent,
        &f.cwd,
        "history".into(),
        "owned-preview".into(),
        channel,
        None,
    )
    .await
    .unwrap();
    let events = events.lock().unwrap();
    let updates = events
        .iter()
        .filter_map(|event| event.get("update"))
        .collect::<Vec<_>>();
    assert_eq!(updates.len(), 5);
    for (update, expected_id) in updates
        .iter()
        .zip(["user-1", "user-1", "user-2", "agent-1", "agent-2"])
    {
        assert_eq!(update["messageId"], expected_id);
        assert_eq!(update["_meta"]["futureField"], expected_id);
    }
    assert_eq!(
        events.last(),
        Some(&json!({"kind":"history_preview_complete","previewToken":"owned-preview"}))
    );
    assert_eq!(preview.session.native_session_id, "history");
    assert!(f.store.list_sessions().unwrap().is_empty());
}

#[tokio::test]
async fn failed_load_after_partial_replay_never_publishes_a_completion_marker_or_index() {
    let f = Fixture::new();
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let received = events.clone();
    let channel = tauri::ipc::Channel::new(move |body| {
        received.lock().unwrap().push(body.deserialize::<Value>()?);
        Ok(())
    });
    let result = open_import_preview(
        &f.manager,
        &f.store,
        &f.agent,
        &f.cwd,
        "fails-after-prefix".into(),
        "failed-preview".into(),
        channel,
        None,
    )
    .await;
    assert!(result.is_err());
    assert!(
        events
            .lock()
            .unwrap()
            .iter()
            .all(|event| event["kind"] != "history_preview_complete")
    );
    assert!(f.store.list_sessions().unwrap().is_empty());
}
