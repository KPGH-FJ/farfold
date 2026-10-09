//! Cancellation races against synthetic protocol peers, never real Agents.
use super::{manager::AcpManager, pump::SessionSink};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::sync::mpsc;

const PEER: &str = r#"
import sys,json,os
kind=sys.argv[1]
session='cancel-fixture-'+str(os.getpid())
prompt=None
def send(v): print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def reply(m,r): send({'id':m['id'],'result':r})
def update(text): send({'method':'session/update','params':{'sessionId':session,'update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':text},'_meta':{'fixture':'preserved'}}}})
def ask(id):
 if kind=='permission':
  send({'id':id,'method':'session/request_permission','params':{'sessionId':session,'toolCall':{'toolCallId':str(id),'title':'Fixture only','kind':'other'},'options':[{'optionId':'yes','name':'Allow','kind':'allow_once'}]}})
 else:
  send({'id':id,'method':'elicitation/create','params':{'sessionId':session,'mode':'form','message':'Fixture only','requestedSchema':{'type':'object','properties':{}}}})
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); p=m.get('params',{})
 if method=='initialize': reply(m,{'protocolVersion':1,'agentCapabilities':{},'authMethods':[]})
 elif method=='session/new': reply(m,{'sessionId':session})
 elif method=='session/prompt':
  prompt=m
  if p['prompt'][0]['text']=='run': update('running')
  else: ask(100)
 elif method=='session/cancel':
  # Deliver an in-transit interaction only after cancellation is known to
  # have reached the wire, then await its response before acknowledging stop.
  ask(200)
 elif method is None and m.get('id')==200:
  expected={'outcome':{'outcome':'cancelled'}} if kind=='permission' else {'action':'cancel'}
  assert m.get('result')==expected, m
  update('cleanup-after-cancel')
  reply(prompt,{'stopReason':'cancelled'}); prompt=None
 elif method is None and m.get('id')==100:
  if kind=='permission': assert m['result']['outcome']['optionId']=='yes', m
  else: assert m['result']['action']=='accept', m
  reply(prompt,{'stopReason':'end_turn'}); prompt=None
"#;

struct Stop(Arc<AcpManager>);
impl Drop for Stop {
    fn drop(&mut self) {
        self.0.stop_for_shutdown();
    }
}

async fn next(rx: &mut mpsc::UnboundedReceiver<Value>, kind: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = rx.recv().await.expect("fixture session remains open");
            if event["kind"] == kind {
                return event;
            }
        }
    })
    .await
    .expect("bounded fixture event")
}

async fn late_interaction_is_cancelled(kind: &str) {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    let script = cwd.join("peer.py");
    std::fs::write(&script, PEER).unwrap();
    let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
    let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
    let _stop = Stop(manager.clone());
    let row = AgentRow {
        id: "cancel-fixture".into(),
        name: "Fixture".into(),
        source: "custom".into(),
        command: crate::platform_tests::python(),
        args: vec!["-u".into(), script.to_string_lossy().into(), kind.into()],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    };
    store.insert_agent(&row).unwrap();
    let (a_tx, mut a_rx) = mpsc::unbounded_channel();
    let (b_tx, mut b_rx) = mpsc::unbounded_channel();
    let sink = |tx: mpsc::UnboundedSender<Value>| -> SessionSink {
        Arc::new(move |event| {
            let _ = tx.send(event);
        })
    };
    let a = manager
        .open_session(&row, &cwd, None, vec![], sink(a_tx), &store)
        .await
        .unwrap();
    let b = manager
        .open_session(&row, &cwd, None, vec![], sink(b_tx), &store)
        .await
        .unwrap();
    let blocks = |text: &str| serde_json::from_value(json!([{"type":"text","text":text}])).unwrap();
    manager
        .session_prompt(&row.id, &cwd, &b.session_id, blocks("ask"))
        .await
        .unwrap();
    let event_kind = if kind == "permission" {
        "permissionRequest"
    } else {
        "elicitation"
    };
    let b_request = next(&mut b_rx, event_kind).await;
    manager
        .session_prompt(&row.id, &cwd, &a.session_id, blocks("run"))
        .await
        .unwrap();
    manager
        .session_cancel(&row.id, &cwd, &a.session_id)
        .await
        .unwrap();

    let mut saw_cleanup = false;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = a_rx.recv().await.unwrap();
            assert_ne!(
                event["kind"], event_kind,
                "stopping must not reopen a late interaction"
            );
            if event.pointer("/update/content/text") == Some(&json!("cleanup-after-cancel")) {
                assert_eq!(event["update"]["_meta"]["fixture"], "preserved");
                saw_cleanup = true;
            }
            if event["kind"] == "turnEnd" {
                assert_eq!(event["stopReason"], "cancelled");
                break;
            }
        }
    })
    .await
    .expect("late interaction must not hold cancellation open");
    assert!(saw_cleanup, "updates after cancel must precede turnEnd");

    let respond = |event: &Value, session: &str| {
        let id = event["requestId"].as_str().unwrap();
        let result = if kind == "permission" {
            manager.permission_respond(id, "yes", session)
        } else {
            manager.elicitation_respond(id, session, "accept", Some(json!({})))
        };
        assert_eq!(result.unwrap().status, "submitted");
    };
    // Cancellation is scoped to A. B's existing interaction remains usable.
    respond(&b_request, &b.session_id);
    assert_eq!(next(&mut b_rx, "turnEnd").await["stopReason"], "end_turn");
    // A's next explicit prompt is not poisoned by the preceding cancellation.
    manager
        .session_prompt(&row.id, &cwd, &a.session_id, blocks("ask"))
        .await
        .unwrap();
    respond(&next(&mut a_rx, event_kind).await, &a.session_id);
    assert_eq!(next(&mut a_rx, "turnEnd").await["stopReason"], "end_turn");
}

#[tokio::test(flavor = "multi_thread")]
async fn late_permission_after_cancel_is_cancelled_without_affecting_other_or_next_turn() {
    late_interaction_is_cancelled("permission").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn late_form_after_cancel_is_cancelled_without_affecting_other_or_next_turn() {
    late_interaction_is_cancelled("form").await;
}
