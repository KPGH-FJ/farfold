//! Synthetic protocol regression, not real-Agent acceptance.
use super::manager::AcpManager;
use super::pump::SessionSink;
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use std::sync::{Arc, mpsc};
use std::time::Duration;
const AGENT: &str = r#"
import sys,json
options=[{'id':'model','name':'Model','category':'model','type':'select','currentValue':'m1','options':[{'value':'m1','name':'M1'},{'value':'m2','name':'M2'}]}]
prompt=None
waiting=set()
def send(v): print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def reply(m,r): send({'id':m['id'],'result':r})
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); p=m.get('params',{})
 if method=='initialize': reply(m,{'protocolVersion':1,'agentInfo':{'name':'fixture','version':'1'},'agentCapabilities':{'loadSession':True},'authMethods':[]})
 elif method in ('session/new','session/load'): reply(m,dict(configOptions=options,**({'sessionId':'fixture-session'} if method=='session/new' else {})))
 elif method=='session/set_config_option':
  options[0]['currentValue']=p['value']; reply(m,{'configOptions':options})
 elif method=='session/prompt':
  prompt=m; waiting={100,101}
  for id in waiting: send({'id':id,'method':'session/request_permission','params':{'sessionId':p['sessionId'],'toolCall':{'toolCallId':str(id),'title':'test','kind':'execute'},'options':[{'optionId':'yes','name':'Allow','kind':'allow_once'},{'optionId':'no','name':'Deny','kind':'reject_once'}]}})
 elif method=='session/cancel':
  if prompt: reply(prompt,{'stopReason':'cancelled'}); prompt=None
 elif method=='session/close': reply(m,{})
 elif method is None and m.get('id') in waiting:
  waiting.remove(m['id'])
  if not waiting and prompt: reply(prompt,{'stopReason':'end_turn'}); prompt=None
"#;
struct Stop(Arc<AcpManager>);
impl Drop for Stop {
    fn drop(&mut self) {
        self.0.stop_for_shutdown();
    }
}
fn next(rx: &mpsc::Receiver<Value>, kind: &str) -> Value {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let event = rx
            .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
            .expect("bounded event");
        if event["kind"] == kind {
            return event;
        }
    }
}
#[test]
fn protocol_round_trip_locks_model_and_keeps_multiple_permissions() {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("agent.py");
    std::fs::write(&script, AGENT).unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
    let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
    let _stop = Stop(manager.clone());
    let row = AgentRow {
        id: "fixture".into(),
        name: "Fixture".into(),
        source: "custom".into(),
        command: "/usr/bin/python3".into(),
        args: vec!["-u".into(), script.to_string_lossy().into_owned()],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    };
    let (tx, rx) = mpsc::channel();
    let sink: SessionSink = Arc::new(move |v| {
        let _ = tx.send(v);
    });
    let opened = manager
        .open_session(&row, &cwd, None, vec![], sink.clone(), &store)
        .unwrap();
    let id = &opened.session_id;
    manager
        .session_set_config(&row.id, &cwd, id, "model", json!("m2"))
        .unwrap();
    manager
        .session_prompt(
            &row.id,
            &cwd,
            id,
            serde_json::from_value(json!([{"type":"text","text":"fixture"}])).unwrap(),
        )
        .unwrap();
    assert!(
        manager
            .session_set_config(&row.id, &cwd, id, "model", json!("m1"))
            .is_err()
    );
    let a = next(&rx, "permissionRequest");
    let b = next(&rx, "permissionRequest");
    assert!(
        manager
            .session_prompt(
                &row.id,
                &cwd,
                id,
                serde_json::from_value(json!([{"type":"text","text":"overlap"}])).unwrap()
            )
            .is_err()
    );
    let aid = a["requestId"].as_str().unwrap();
    let bid = b["requestId"].as_str().unwrap();
    assert_ne!(aid, bid);
    assert!(manager.permission_respond(aid, "invalid", id).is_err());
    assert!(
        manager
            .permission_respond(aid, "yes", "other-session")
            .is_err()
    );
    manager.permission_respond(bid, "yes", id).unwrap();
    manager.permission_respond(aid, "no", id).unwrap();
    assert!(manager.permission_respond(aid, "yes", id).is_err());
    assert_eq!(next(&rx, "turnEnd")["stopReason"], "end_turn");
    manager.disconnect(&row.id, &cwd).unwrap();
    super::session_index::touch_session_row(
        &store,
        &row.id,
        &cwd.to_string_lossy(),
        id,
        None,
        Some(json!({"model":"m2"})),
    )
    .unwrap();
    let resumed = manager
        .open_session(&row, &cwd, Some(id.clone()), vec![], sink.clone(), &store)
        .unwrap();
    assert!(
        manager
            .session_set_config(&row.id, &cwd, &resumed.session_id, "model", json!("m1"))
            .is_err()
    );
    // Fixture resets to m1 on a new process: a restored mismatch must be
    // rejected by the backend even if a caller bypasses the frontend.
    assert!(
        manager
            .session_prompt(
                &row.id,
                &cwd,
                id,
                serde_json::from_value(json!([{"type":"text","text":"cancel"}])).unwrap(),
            )
            .is_err()
    );
    manager.disconnect(&row.id, &cwd).unwrap();
    super::session_index::touch_session_row(
        &store,
        &row.id,
        &cwd.to_string_lossy(),
        id,
        None,
        Some(json!({"model":"m1"})),
    )
    .unwrap();
    manager
        .open_session(&row, &cwd, Some(id.clone()), vec![], sink.clone(), &store)
        .unwrap();
    manager
        .session_prompt(
            &row.id,
            &cwd,
            id,
            serde_json::from_value(json!([{"type":"text","text":"cancel"}])).unwrap(),
        )
        .unwrap();
    let a = next(&rx, "permissionRequest");
    let _b = next(&rx, "permissionRequest");
    manager.session_cancel(&row.id, &cwd, id).unwrap();
    assert_eq!(next(&rx, "turnEnd")["stopReason"], "cancelled");
    assert!(
        manager
            .permission_respond(a["requestId"].as_str().unwrap(), "yes", id)
            .is_err()
    );
    manager.disconnect(&row.id, &cwd).unwrap();
    assert!(
        manager
            .open_session(
                &row,
                &cwd,
                Some(id.clone()),
                vec![("model".into(), json!("m1"))],
                sink,
                &store
            )
            .is_err()
    );
}

#[test]
fn structured_failures_survive_real_protocol_dispatch() {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("failure.py");
    std::fs::write(&script, r#"
import sys,json
n=0
def send(v): print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def reply(m,r): send({'id':m['id'],'result':r})
for line in sys.stdin:
 m=json.loads(line);p=m.get('params',{});method=m.get('method')
 if method=='initialize':
  assert 'sessionFailure' in p['clientCapabilities']['_meta']['jetbrains']['air']['capabilities']
  reply(m,{'protocolVersion':1,'agentInfo':{'name':'fixture','version':'1'},'agentCapabilities':{},'authMethods':[]})
 elif method=='session/new': reply(m,{'sessionId':'failure-fixture'})
 elif method=='session/prompt':
  n+=1
  meta={'jetbrains':{'air':{'version':1,'sessionFailure':{'id':str(n),'revision':1,'category':'service','severity':'warning' if n==3 else 'error','title':'RAW-DETAIL'}}},'unknown-field':{'keep':True}}
  send({'method':'session/update','params':{'sessionId':p['sessionId'],'update':{'sessionUpdate':'session_info_update','_meta':meta}}})
  reply(m,dict(stopReason='end_turn',**({'_meta':meta} if n==2 else {})))
"#).unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
    let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
    let _stop = Stop(manager.clone());
    let row = AgentRow {
        id: "failure-fixture".into(),
        name: "Fixture".into(),
        source: "custom".into(),
        command: "/usr/bin/python3".into(),
        args: vec!["-u".into(), script.to_string_lossy().into_owned()],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    };
    let (tx, rx) = mpsc::channel();
    let sink: SessionSink = Arc::new(move |v| {
        let _ = tx.send(v);
    });
    let opened = manager
        .open_session(&row, &cwd, None, vec![], sink, &store)
        .unwrap();
    for round in 1..=3 {
        manager
            .session_prompt(
                &row.id,
                &cwd,
                &opened.session_id,
                serde_json::from_value(json!([{"type":"text","text":"fixture"}])).unwrap(),
            )
            .unwrap();
        let event = next(&rx, "turnEnd");
        assert_eq!(event["stopReason"], "end_turn");
        if round < 3 {
            assert_eq!(event["failure"], json!({"category":"service"}));
        } else {
            assert!(event.get("failure").is_none());
        }
        if round == 2 {
            assert_eq!(event["meta"]["unknown-field"]["keep"], true);
        }
    }
}
