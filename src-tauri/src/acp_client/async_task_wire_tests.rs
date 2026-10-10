//! AIR task capability passes through the real manager and controlled ACP peer.
//! The synthetic peer supplies protocol values; no real Agent or billing is used.
use super::{manager::AcpManager, pump::SessionSink};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::sync::mpsc;

const PEER: &str = r#"
import sys,json,threading,time,os
lock=threading.Lock()
def send(v):
 with lock: print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def reply(m,r): send({'id':m['id'],'result':r})
def update(value): send({'method':'session/update','params':{'sessionId':'async-task-fixture','update':value}})
def terminal(state): update({'sessionUpdate':'async_task_state_update','asyncTaskId':'task-1','toolCallId':'tool-1','state':state})
def finish_later():
 for i in range(500):
  if os.path.exists(os.path.join(os.path.dirname(__file__),'release')):
   terminal('stopped');return
  time.sleep(.01)
capability=None
mode='complete'
pending=None
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); p=m.get('params',{})
 if method=='initialize':
  capability=p.get('clientCapabilities',{}).get('_meta',{}).get('jetbrains',{}).get('air')
  reply(m,{'protocolVersion':1,'agentCapabilities':{'loadSession':True},'authMethods':[],
   '_meta':{'jetbrains':{'air':{'version':1,'capabilities':['asyncTasks'] if enabled else []}}}})
 elif method=='session/new': reply(m,{'sessionId':'async-task-fixture'})
 elif method=='session/load':
  update({'sessionUpdate':'async_task_spawned','asyncTaskId':'task-1','toolCallId':'tool-1','name':'Live task on load','taskType':'shell','canStop':True})
  reply(m,{})
 elif method=='session/prompt':
  mode=p['prompt'][0]['text']
  send({'method':'_fixture/capability','params':{'sessionId':p['sessionId'],'air':capability}})
  if mode!='complete': update({'sessionUpdate':'async_task_spawned','asyncTaskId':'task-1','toolCallId':'tool-1','name':'Controlled task','taskType':'shell','canStop':True})
  if mode=='in-flight': pending=m
  else: reply(m,{'stopReason':'end_turn'})
 elif method=='session/cancel':
  if pending: reply(pending,{'stopReason':'cancelled'});pending=None
 elif method=='_session/async_task/stop':
  send({'method':'_fixture/stop','params':p})
  if mode=='terminal-first': terminal('completed')
  if mode=='malformed': reply(m,{'stopped':'true'})
  elif mode=='error': send({'id':m['id'],'error':{'code':-32603,'message':'controlled refusal'}})
  else:
   reply(m,{'stopped':mode!='rejected'})
   if mode in ('accepted','in-flight'): threading.Thread(target=finish_later,daemon=True).start()
"#;

struct Fixture {
    _root: tempfile::TempDir,
    cwd: std::path::PathBuf,
    manager: AcpManager,
    agent: AgentRow,
    session_id: String,
    connection_id: String,
    events: mpsc::UnboundedReceiver<Value>,
}

impl Fixture {
    async fn new() -> Self {
        Self::with_capability(true, false).await
    }
    async fn with_capability(enabled: bool, load: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().canonicalize().unwrap();
        let script = cwd.join("peer.py");
        std::fs::write(
            &script,
            format!("enabled={}\n{PEER}", if enabled { "True" } else { "False" }),
        )
        .unwrap();
        let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
        let agent = AgentRow {
            id: "async-task-wire-fixture".into(),
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
            .open_session(
                &agent,
                &cwd,
                load.then(|| "async-task-fixture".to_owned()),
                vec![],
                sink,
                &store,
            )
            .await
            .unwrap();
        Self {
            _root: root,
            cwd,
            manager,
            agent,
            session_id: opened.session_id,
            connection_id: opened.connection_id,
            events,
        }
    }

    async fn stop(&self, id: &str) -> Value {
        self.manager
            .session_stop_task(
                &self.agent.id,
                &self.cwd,
                &self.session_id,
                &self.connection_id,
                id,
            )
            .await
            .unwrap()
    }
    async fn until(&mut self, mut check: impl FnMut(&Value) -> bool) -> Vec<Value> {
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut all = Vec::new();
            loop {
                let e = self.events.recv().await.unwrap();
                let done = check(&e);
                all.push(e);
                if done {
                    return all;
                }
            }
        })
        .await
        .expect("bounded controlled event")
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
async fn async_task_capability_is_negotiated_on_actual_initialize() {
    let mut f = Fixture::new().await;
    let events = f.prompt("complete").await;
    let report = events
        .iter()
        .find(|e| e["method"] == "_fixture/capability")
        .unwrap();
    assert_eq!(report["params"]["air"]["version"], 1);
    let values = report["params"]["air"]["capabilities"].as_array().unwrap();
    assert!(values.contains(&json!("sessionFailure")));
    assert!(
        values.contains(&json!("asyncTasks")),
        "official optional task control is not negotiated"
    );
}

#[tokio::test]
async fn async_task_stop_is_exact_and_ack_is_not_terminal() {
    let mut f = Fixture::new().await;
    let initial = f.prompt("accepted").await;
    assert!(
        initial
            .iter()
            .any(|e| e["kind"] == "asyncTasks" && e["tasks"][0]["state"] == "running")
    );
    assert!(
        f.manager
            .session_stop_task(&f.agent.id, &f.cwd, &f.session_id, "wrong", "task-1")
            .await
            .is_err()
    );
    assert_eq!(f.stop("unreported-id").await["status"], "rejected");
    assert_eq!(f.stop("task-1").await["status"], "accepted");
    assert_eq!(f.stop("task-1").await["status"], "rejected");
    let (mut accepted, mut dispatched) = (false, false);
    let reports = f
        .until(|e| {
            accepted |= e["kind"] == "asyncTasks" && e["tasks"][0]["stopRequest"] == "accepted";
            dispatched |= e["method"] == "_fixture/stop";
            accepted && dispatched
        })
        .await;
    assert_eq!(
        reports
            .iter()
            .filter(|e| e["method"] == "_fixture/stop")
            .count(),
        1
    );
    let raw = reports
        .iter()
        .find(|e| e["method"] == "_fixture/stop")
        .unwrap();
    assert_eq!(
        raw["params"],
        json!({"sessionId":f.session_id,"asyncTaskId":"task-1"})
    );
    assert!(reports.iter().any(|e| e["kind"] == "asyncTasks"
        && e["tasks"][0]["stopRequest"] == "accepted"
        && e["tasks"][0]["state"] == "running"));
    assert!(
        f.manager
            .close_session(&f.agent.id, &f.cwd, &f.session_id)
            .await
            .is_err()
    );
    std::fs::write(f.cwd.join("release"), b"go").unwrap();
    let ended = f
        .until(|e| e["kind"] == "asyncTasks" && e["tasks"][0]["state"] == "stopped")
        .await;
    assert!(
        ended
            .iter()
            .any(|e| e["update"]["sessionUpdate"] == "async_task_state_update")
    );
    assert!(!ended.iter().any(|e| e["kind"] == "turnEnd"));
}
#[tokio::test]
async fn async_task_stop_after_reply_cancel_retains_independent_task() {
    let mut f = Fixture::new().await;
    f.manager
        .session_prompt(
            &f.agent.id,
            &f.cwd,
            &f.session_id,
            serde_json::from_value(json!([{"type":"text","text":"in-flight"}])).unwrap(),
        )
        .await
        .unwrap();
    f.until(|e| e["kind"] == "asyncTasks" && e["tasks"][0]["state"] == "running")
        .await;
    f.manager
        .session_cancel(&f.agent.id, &f.cwd, &f.session_id)
        .await
        .unwrap();
    let ended = f.until(|e| e["kind"] == "turnEnd").await;
    assert_eq!(ended.last().unwrap()["stopReason"], "cancelled");
    assert_eq!(f.stop("task-1").await["status"], "accepted");
    std::fs::write(f.cwd.join("release"), b"go").unwrap();
    f.until(|e| e["kind"] == "asyncTasks" && e["tasks"][0]["state"] == "stopped")
        .await;
}
#[tokio::test]
async fn async_task_false_error_malformed_and_natural_completion_are_distinct() {
    for (mode, expected) in [
        ("rejected", "rejected"),
        ("malformed", "unknown"),
        ("error", "unknown"),
        ("terminal-first", "accepted"),
    ] {
        let mut f = Fixture::new().await;
        f.prompt(mode).await;
        assert_eq!(f.stop("task-1").await["status"], expected);
        let events = f
            .until(|e| {
                e["kind"] == "asyncTasks"
                    && e["tasks"][0]["stopRequest"] == expected
                    && (mode != "terminal-first" || e["tasks"][0]["state"] == "completed")
            })
            .await;
        assert_eq!(
            events.last().unwrap()["tasks"][0]["state"],
            if mode == "terminal-first" {
                "completed"
            } else {
                "running"
            }
        );
    }
}
#[tokio::test]
async fn async_task_no_agent_advertisement_keeps_raw_without_granting_control() {
    let mut f = Fixture::with_capability(false, false).await;
    let events = f.prompt("accepted").await;
    assert!(
        events
            .iter()
            .any(|e| e["update"]["sessionUpdate"] == "async_task_spawned")
    );
    assert!(
        !events
            .iter()
            .any(|e| e["kind"] == "asyncTasks"
                && e["tasks"].as_array().is_some_and(|a| !a.is_empty()))
    );
    assert_eq!(f.stop("task-1").await["status"], "rejected");
}
#[tokio::test]
async fn async_task_load_uses_current_connection_announcements() {
    let mut f = Fixture::with_capability(true, true).await;
    let events = f
        .until(|e| e["kind"] == "asyncTasks" && e["tasks"][0]["state"] == "running")
        .await;
    assert_eq!(events.last().unwrap()["connectionId"], f.connection_id);
    assert_eq!(
        events.last().unwrap()["tasks"][0]["name"],
        "Live task on load"
    );
    assert_eq!(f.stop("task-1").await["status"], "accepted");
}
