//! Synthetic protocol evidence only; no real Agent or command is executed.
use super::{manager::AcpManager, pump::SessionSink};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use std::sync::{Arc, mpsc};
use std::time::Duration;

struct Stop(Arc<AcpManager>);
impl Drop for Stop {
    fn drop(&mut self) {
        self.0.stop_for_shutdown();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn permission_request_preserves_full_params_and_compatibility_fields() {
    let request = json!({
        "sessionId": "fixture-session",
        "toolCall": {
            "toolCallId": "fixture-tool",
            "title": "Fixture request",
            "kind": "execute",
            "rawInput": {"command": "fixture only; never executed", "cwd": "/fixture/path", "future": [1, {"literal": true}]},
            "_meta": {"futureToolField": {"nested": "untouched"}},
            "futureToolField": "retain"
        },
        "options": [{"optionId": "yes", "name": "Allow once", "kind": "allow_once", "_meta": {"futureOptionField": 42}}],
        "_meta": {"futureRootField": {"nested": [null, false, "untouched"]}},
        "futureRootField": {"arbitrary": ["unchanged", 23]}
    });
    exercise_request(request, "yes", &[]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn ambiguous_permission_option_cannot_consume_the_original_responder() {
    let request = json!({
        "sessionId": "fixture-session",
        "toolCall": {"toolCallId": "ambiguous", "title": "Fixture only", "kind": "execute"},
        "options": [
            {"optionId": "same", "name": "Allow", "kind": "allow_once"},
            {"optionId": "same", "name": "Reject", "kind": "reject_once"},
            {"optionId": "safe", "name": "Separate rejection", "kind": "reject_once"}
        ],
        "_meta": {"opaque": [null, "unchanged"]}
    });
    exercise_request(request, "safe", &["same", "same"]).await;
}

async fn exercise_request(request: Value, selected: &str, blocked: &[&str]) {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("permission.py");
    std::fs::write(
        &script,
        r#"
import sys,json
permission=json.loads('__REQUEST__')
def send(v): print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def reply(m,r): send({'id':m['id'],'result':r})
prompt=None
for line in sys.stdin:
 m=json.loads(line); method=m.get('method')
 if method=='initialize': reply(m,{'protocolVersion':1,'agentInfo':{'name':'fixture','version':'1'},'agentCapabilities':{},'authMethods':[]})
 elif method=='session/new': reply(m,{'sessionId':'fixture-session'})
 elif method=='session/prompt':
  prompt=m
  send({'id':100,'method':'session/request_permission','params':permission})
 elif method is None and m.get('id')==100:
  assert m['result']['outcome']['optionId']=='__SELECTED__'
  reply(prompt,{'stopReason':'end_turn'})
"#
        .replace("__REQUEST__", &request.to_string())
        .replace("__SELECTED__", selected),
    )
    .unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
    let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
    let _stop = Stop(manager.clone());
    let row = AgentRow {
        id: "permission-fixture".into(),
        name: "Fixture".into(),
        source: "custom".into(),
        command: crate::platform_tests::python(),
        args: vec!["-u".into(), script.to_string_lossy().into_owned()],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    };
    store.insert_agent(&row).unwrap();
    let (tx, rx) = mpsc::channel();
    let sink: SessionSink = Arc::new(move |value| {
        let _ = tx.send(value);
    });
    let opened = manager
        .open_session(&row, &cwd, None, vec![], sink, &store)
        .await
        .unwrap();
    manager
        .session_prompt(
            &row.id,
            &cwd,
            &opened.session_id,
            serde_json::from_value(json!([{"type":"text","text":"fixture"}])).unwrap(),
        )
        .await
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let event: Value = loop {
        let event = rx
            .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
            .expect("bounded permission event");
        if event["kind"] == "permissionRequest" {
            break event;
        }
    };
    assert_eq!(event["request"], request);
    assert_eq!(event["toolCall"], request["toolCall"]);
    assert_eq!(event["options"], request["options"]);
    let owner = &event["owner"];
    assert_eq!(owner["sessionId"], opened.session_id);
    assert_eq!(owner["connectionId"], opened.connection_id);
    assert_eq!(owner["requestId"], event["requestId"]);
    let mut foreign_owner = owner.clone();
    foreign_owner["connectionId"] = json!("different-connection");
    assert_eq!(
        manager
            .permission_respond_owned(
                event["requestId"].as_str().unwrap(),
                Some(selected),
                None,
                Some(&foreign_owner),
            )
            .unwrap()
            .status,
        "expired"
    );
    for option in blocked {
        assert_eq!(
            manager
                .permission_respond_owned(
                    event["requestId"].as_str().unwrap(),
                    Some(option),
                    None,
                    Some(owner),
                )
                .unwrap()
                .status,
            "retryable"
        );
        assert_eq!(manager.pending_permissions.lock().unwrap().len(), 1);
    }
    assert_eq!(
        manager
            .permission_respond_owned(
                event["requestId"].as_str().unwrap(),
                Some(selected),
                None,
                Some(owner),
            )
            .unwrap()
            .status,
        "submitted"
    );
}
