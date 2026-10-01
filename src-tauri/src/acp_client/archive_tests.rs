//! Archive admission uses temporary metadata and a synthetic protocol peer.
use super::{manager::AcpManager, pump::SessionSink, session_index::touch_session_row};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use std::{
    sync::{Arc, mpsc},
    time::Duration,
};

const PEER: &str = r#"
import sys,json
n=0; prompts={}
def send(x): print(json.dumps(dict(jsonrpc='2.0',**x)),flush=True)
for line in sys.stdin:
 m=json.loads(line); p=m.get('params',{}); method=m.get('method'); result={}
 if method=='initialize': result={'protocolVersion':1,'agentCapabilities':{'loadSession':True},'authMethods':[]}
 elif method=='session/new':
  n+=1;result={'sessionId':str(n)}
 elif method=='session/prompt':
  prompts[p['sessionId']]=m['id'];continue
 elif method=='session/cancel':
  send({'id':prompts.pop(p['sessionId']),'result':{'stopReason':'cancelled'}})
 elif method=='session/set_mode':
  if p['modeId']=='permission': send({'id':100,'method':'session/request_permission','params':{'sessionId':p['sessionId'],'toolCall':{'toolCallId':'test','title':'fixture','kind':'execute'},'options':[{'optionId':'yes','name':'Allow','kind':'allow_once'}]}})
  if p['modeId']=='form': send({'id':101,'method':'elicitation/create','params':{'sessionId':p['sessionId'],'mode':'form','message':'fixture','requestedSchema':{'type':'object','properties':{'name':{'type':'string'}}}}})
 if method and 'id' in m: send({'id':m['id'],'result':result})
"#;
struct Stop(Arc<AcpManager>);
impl Drop for Stop {
    fn drop(&mut self) {
        self.0.stop_for_shutdown();
    }
}
fn next(rx: &mpsc::Receiver<Value>, kind: &str) -> Value {
    loop {
        let event = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        if event["kind"] == kind {
            return event;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn archive_rejects_running_target_but_allows_idle_sibling() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    std::fs::write(cwd.join("peer.py"), PEER).unwrap();
    let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
    let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
    let _stop = Stop(manager.clone());
    let agent = AgentRow {
        id: "archive-fixture".into(),
        name: "Fixture".into(),
        source: "custom".into(),
        command: "/usr/bin/python3".into(),
        args: vec!["-u".into(), cwd.join("peer.py").to_string_lossy().into()],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    };
    store.insert_agent(&agent).unwrap();
    let (tx, rx) = mpsc::channel();
    let sink: SessionSink = Arc::new(move |v| {
        let _ = tx.send(v);
    });
    let busy = manager
        .open_session(&agent, &cwd, None, vec![], sink.clone(), &store)
        .await
        .unwrap();
    let idle = manager
        .open_session(&agent, &cwd, None, vec![], sink, &store)
        .await
        .unwrap();
    let busy_row = touch_session_row(
        &store,
        &agent.id,
        &cwd.to_string_lossy(),
        &busy.session_id,
        None,
        None,
    )
    .unwrap();
    let idle_row = touch_session_row(
        &store,
        &agent.id,
        &cwd.to_string_lossy(),
        &idle.session_id,
        None,
        None,
    )
    .unwrap();
    let blocks = serde_json::from_value(json!([{"type":"text","text":"hold"}])).unwrap();
    manager
        .session_prompt(&agent.id, &cwd, &busy.session_id, blocks)
        .await
        .unwrap();
    assert!(
        manager
            .archive_session(&store, busy_row.id.clone(), true)
            .await
            .is_err(),
        "active target must not be archived"
    );
    assert!(!store.get_session(&busy_row.id).unwrap().unwrap().archived);
    assert!(
        manager
            .archive_session(&store, idle_row.id.clone(), true)
            .await
            .unwrap()
            .archived
    );
    manager
        .session_cancel(&agent.id, &cwd, &busy.session_id)
        .await
        .unwrap();
    next(&rx, "turnEnd");
    assert!(
        manager
            .archive_session(&store, busy_row.id.clone(), true)
            .await
            .unwrap()
            .archived
    );
    manager
        .archive_session(&store, busy_row.id.clone(), false)
        .await
        .unwrap();

    // These requests exist without a running prompt, so each pending map
    // must protect the exact target independently from prompt_in_flight.
    manager
        .session_set_mode(&agent.id, &cwd, &busy.session_id, "permission")
        .await
        .unwrap();
    let approval = next(&rx, "permissionRequest");
    assert!(
        manager
            .archive_session(&store, busy_row.id.clone(), true)
            .await
            .is_err()
    );
    assert!(
        manager
            .archive_session(&store, idle_row.id.clone(), true)
            .await
            .is_ok()
    );
    // Another live Agent may return the same native session id. Its idle
    // conversation must not inherit this connection's pending approval.
    let mut other = agent.clone();
    other.id = "other-fixture".into();
    store.insert_agent(&other).unwrap();
    let peer = manager
        .open_session(&other, &cwd, None, vec![], Arc::new(|_| {}), &store)
        .await
        .unwrap();
    assert_eq!(peer.session_id, busy.session_id);
    let peer_row = touch_session_row(
        &store,
        &other.id,
        &cwd.to_string_lossy(),
        &peer.session_id,
        None,
        None,
    )
    .unwrap();
    assert!(
        manager
            .archive_session(&store, peer_row.id, true)
            .await
            .unwrap()
            .archived
    );
    manager
        .permission_respond(
            approval["requestId"].as_str().unwrap(),
            "yes",
            &busy.session_id,
        )
        .unwrap();
    manager
        .session_set_mode(&agent.id, &cwd, &busy.session_id, "form")
        .await
        .unwrap();
    let form = next(&rx, "elicitation");
    assert!(
        manager
            .archive_session(&store, busy_row.id.clone(), true)
            .await
            .is_err()
    );
    assert!(
        manager
            .archive_session(&store, idle_row.id, true)
            .await
            .is_ok()
    );
    manager
        .elicitation_respond(
            form["requestId"].as_str().unwrap(),
            &busy.session_id,
            "cancel",
            None,
        )
        .unwrap();
    assert!(
        manager
            .archive_session(&store, busy_row.id, true)
            .await
            .unwrap()
            .archived
    );
}

#[tokio::test]
async fn archive_rejects_saved_unsent_work_without_opening_an_agent() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_string_lossy().into_owned();
    let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
    let manager = AcpManager::new(dir.path().join("logs"), dir.path().into());
    let row = touch_session_row(&store, "fixture", &cwd, "native", Some("keep"), None).unwrap();
    let key = &row.id;
    store.set_setting("unsentWork.v1",&json!({"version":1,"composers":{format!("session:{key}"):{"text":"keep me","attachments":[]}},"queues":{},"feedback":{}})).unwrap();
    assert!(
        manager
            .archive_session(&store, row.id.clone(), true)
            .await
            .is_err(),
        "saved draft must prevent direct archive"
    );
    assert!(!store.get_session(&row.id).unwrap().unwrap().archived);
    store
        .set_setting(
            "unsentWork.v1",
            &json!({"version":1,"composers":{},"queues":{},"feedback":{}}),
        )
        .unwrap();
    let opening = manager
        .opening_sessions
        .reserve("fixture", std::path::Path::new(&cwd), "native")
        .unwrap();
    assert!(
        manager
            .archive_session(&store, row.id.clone(), true)
            .await
            .is_err()
    );
    assert!(!store.get_session(&row.id).unwrap().unwrap().archived);
    drop(opening);
    assert!(
        manager
            .archive_session(&store, row.id, true)
            .await
            .unwrap()
            .archived
    );
}

#[path = "archive_alias_tests.rs"]
mod alias_tests;
