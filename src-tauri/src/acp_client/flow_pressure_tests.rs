//! Real original manager/stdio/pump; controlled peer only, no installed Agent.
use super::{
    manager::AcpManager,
    pump::SessionSink,
    transient_pressure::{Budget, Lease},
};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
const COUNT: usize = 2048;
const PEER: &str = r#"
import sys,json,pathlib,threading
root=pathlib.Path(sys.argv[1]); lock=threading.Lock(); cancelled=threading.Event(); prompt=None
def send(v):
 with lock: print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def reply(m,r): send({'id':m['id'],'result':r})
def burst():
 for n in range(2048):
  send({'method':'session/update','params':{'sessionId':'flow','update':{'sessionUpdate':'_flow/raw','sequence':n,'unknown':[None,False,n]},'_meta':{'preserve':True}}})
 assert cancelled.wait(8), 'original cancel not received'
 send({'method':'session/update','params':{'sessionId':'flow','update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'actual-cancel-received'}}}})
 reply(prompt,{'stopReason':'cancelled'})
for line in sys.stdin:
 m=json.loads(line); method=m.get('method')
 if method=='initialize': reply(m,{'protocolVersion':1,'agentCapabilities':{},'authMethods':[]})
 elif method=='session/new': reply(m,{'sessionId':'flow'})
 elif method=='session/prompt':
  prompt=m
  send({'id':901,'method':'session/request_permission','params':{'sessionId':'flow','toolCall':{'toolCallId':'owned','title':'Controlled permission','kind':'read'},'options':[{'optionId':'yes','name':'Allow','kind':'allow_once'}]}})
  threading.Thread(target=burst,daemon=True).start()
 elif method is None and m.get('id')==901:
  assert m['result']['outcome']=={'outcome':'selected','optionId':'yes'},m
  (root/'approved').write_text('original-stdin-approval')
 elif method=='session/cancel':
  (root/'cancelled').write_text('original-stdin-cancel')
  cancelled.set()
"#;
struct Sink {
    hold: bool,
    values: Vec<Value>,
    credits: Vec<Lease>,
}
impl Sink {
    fn release(&mut self) {
        self.hold = false;
        self.credits.clear();
    }
}
struct Cleanup {
    sink: Arc<Mutex<Sink>>,
    manager: Arc<AcpManager>,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        self.sink
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .release();
        self.manager.stop_for_shutdown();
    }
}
async fn wait(condition: impl Fn() -> bool, message: &str) {
    tokio::time::timeout(Duration::from_secs(8), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect(message);
}
async fn marker(root: &Path, name: &str, content: &str) {
    wait(
        || std::fs::read_to_string(root.join(name)).is_ok_and(|value| value == content),
        "actual stdin receipt",
    )
    .await;
}
#[tokio::test]
async fn actual_ingress_pressure_keeps_original_cancel_and_permission_outgoing_then_drains_all_raw_events()
 {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    let script = cwd.join("peer.py");
    std::fs::write(&script, PEER).unwrap();
    let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
    let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
    let state = Arc::new(Mutex::new(Sink {
        hold: true,
        values: Vec::new(),
        credits: Vec::new(),
    }));
    let _cleanup = Cleanup {
        sink: state.clone(),
        manager: manager.clone(),
    };
    let capture = state.clone();
    let sink: SessionSink = Arc::new(move |event| {
        let mut state = capture.lock().unwrap();
        if state.hold && event.pointer("/update/sequence").is_some() {
            state.credits.push(Budget::shared().json(&event));
        }
        state.values.push(event);
    });
    let row = AgentRow {
        id: "owned-flow-fixture".into(),
        name: "Fixture".into(),
        source: "custom".into(),
        command: crate::platform_tests::python(),
        args: vec![
            "-u".into(),
            script.to_string_lossy().into(),
            cwd.to_string_lossy().into(),
        ],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    };
    store.insert_agent(&row).unwrap();
    let opened = manager
        .open_session(&row, &cwd, None, vec![], sink, &store)
        .await
        .unwrap();
    manager
        .session_prompt(
            &row.id,
            &cwd,
            &opened.session_id,
            serde_json::from_value(json!([{"type":"text","text":"controlled"}])).unwrap(),
        )
        .await
        .unwrap();
    wait(
        || state.lock().unwrap().credits.len() >= 256,
        "queued bodies must reach actual admission watermark",
    )
    .await;
    let request = state
        .lock()
        .unwrap()
        .values
        .iter()
        .find(|event| event["kind"] == "permissionRequest")
        .unwrap()["requestId"]
        .as_str()
        .unwrap()
        .to_owned();
    manager
        .permission_respond(&request, "yes", &opened.session_id)
        .unwrap();
    manager
        .session_cancel(&row.id, &cwd, &opened.session_id)
        .await
        .unwrap();
    marker(&cwd, "approved", "original-stdin-approval").await;
    marker(&cwd, "cancelled", "original-stdin-cancel").await;
    {
        let mut retained = state.lock().unwrap();
        assert!(
            retained.credits.len() < COUNT,
            "pressure must keep later raw input unadmitted"
        );
        assert!(
            !retained
                .values
                .iter()
                .any(|event| event["kind"] == "turnEnd"),
            "outgoing cancel receipt is not confirmed stop"
        );
        retained.release();
    }
    wait(
        || {
            state
                .lock()
                .unwrap()
                .values
                .iter()
                .any(|event| event["kind"] == "turnEnd")
        },
        "original cancelled result after pressure release",
    )
    .await;
    let captured = state.lock().unwrap();
    let updates: Vec<_> = captured
        .values
        .iter()
        .filter(|event| event.pointer("/update/sequence").is_some())
        .collect();
    assert_eq!(updates.len(), COUNT);
    for (n, event) in updates.into_iter().enumerate() {
        assert_eq!(event["sessionId"], "flow");
        assert_eq!(
            event["update"],
            json!({"sessionUpdate":"_flow/raw","sequence":n,"unknown":[null,false,n]})
        );
        assert_eq!(event["_meta"], json!({"preserve":true}));
    }
    assert!(
        captured
            .values
            .iter()
            .any(|event| event["kind"] == "turnEnd" && event["stopReason"] == "cancelled")
    );
}
