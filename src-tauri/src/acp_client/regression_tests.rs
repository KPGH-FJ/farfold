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
    let resumed = manager
        .open_session(&row, &cwd, Some(id.clone()), vec![], sink.clone(), &store)
        .unwrap();
    assert!(
        manager
            .session_set_config(&row.id, &cwd, &resumed.session_id, "model", json!("m1"))
            .is_err()
    );
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
