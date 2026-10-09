//! Official v1 reverse requests, using only an isolated stdio protocol peer.
use super::{manager::AcpManager, pump::SessionSink};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::sync::mpsc;

const PEER: &str = r#"
import sys,json,pathlib
def send(v): print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def reply(m,r): send({'id':m['id'],'result':r})
prompt=None
reusing=False
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); p=m.get('params',{})
 if method=='initialize': reply(m,{'protocolVersion':1,'agentCapabilities':{'loadSession':True},'authMethods':[]})
 elif method=='session/new': reply(m,{'sessionId':'inquiry-fixture'})
 elif method=='session/load':
  prompt=m
  send({'id':501,'method':'elicitation/create','params':{'sessionId':p['sessionId'],'mode':'form','message':'Confirm load','requestedSchema':{'type':'object','properties':{}}}})
 elif m.get('id')==501:
  reply(prompt,{})
 elif method=='session/prompt':
  prompt=m; mode=p['prompt'][0]['text']
  if mode=='running':
   send({'method':'session/update','params':{'sessionId':p['sessionId'],'update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'running'}}}})
   continue
  if mode=='rejected-reuse':
   reusing=True
   send({'id':401,'method':'elicitation/create','params':{'sessionId':p['sessionId'],'mode':'url','message':'A rejected URL','url':'javascript:alert(1)','elicitationId':'reused-url'}})
   continue
  if mode=='url-no-complete': mode='url'
  if mode=='queued-complete':
   send({'method':'session/update','params':{'sessionId':p['sessionId'],'update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'fixture-gate'}}}})
   mode='url'
  send({'id':301,'method':'elicitation/create','params':{'sessionId':p['sessionId'],'mode':mode,'message':'Review this external step','url':'https://example.test/connect','elicitationId':'fixture-url','_meta':{'future':True}}})
  if p['prompt'][0]['text']=='queued-complete':
   send({'method':'elicitation/complete','params':{'elicitationId':'fixture-url'}})
   send({'id':302,'method':'_fixture/barrier','params':{}})
 elif method=='session/cancel':
  send({'id':601,'method':'elicitation/create','params':{'sessionId':p['sessionId'],'mode':'url','message':'Late cancelled inquiry','url':'https://example.test/cancel','elicitationId':'late-url'}})
 elif m.get('id')==601:
  assert m.get('result')=={'action':'cancel'}, m
  send({'method':'elicitation/complete','params':{'elicitationId':'late-url'}})
  reply(prompt,{'stopReason':'cancelled'})
 elif m.get('id')==401:
  send({'method':'elicitation/complete','params':{'elicitationId':'reused-url'}})
  send({'id':402,'method':'elicitation/create','params':{'sessionId':prompt['params']['sessionId'],'mode':'url','message':'B valid URL','url':'https://example.test/new','elicitationId':'reused-url'}})
 elif m.get('id')==402:
  send({'method':'session/update','params':{'sessionId':'inquiry-fixture','update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':json.dumps(m)}}}})
  reply(prompt,{'stopReason':'end_turn'})
 elif m.get('id')==302: pathlib.Path(sys.argv[1]).write_text('connection processed barrier')
 elif m.get('id')==301:
  send({'method':'session/update','params':{'sessionId':'inquiry-fixture','update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':json.dumps(m)}}}})
  if 'result' in m and m['result'].get('action')=='accept' and prompt['params']['prompt'][0]['text']!='url-no-complete':
   send({'method':'elicitation/complete','params':{'elicitationId':'fixture-url'}})
  reply(prompt,{'stopReason':'end_turn'})
"#;

struct Fixture {
    _root: tempfile::TempDir,
    cwd: std::path::PathBuf,
    manager: AcpManager,
    store: MetaStore,
    agent: AgentRow,
    session_id: String,
    events: mpsc::UnboundedReceiver<Value>,
    release: Option<std::sync::mpsc::Sender<()>>,
}

impl Fixture {
    async fn new() -> Self {
        Self::build(false).await
    }
    async fn build(gated: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().canonicalize().unwrap();
        let script = cwd.join("peer.py");
        std::fs::write(&script, PEER).unwrap();
        let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
        let agent = AgentRow {
            id: "elicitation-wire-fixture".into(),
            name: "Fixture".into(),
            source: "custom".into(),
            command: crate::platform_tests::python(),
            args: vec![
                "-u".into(),
                script.to_string_lossy().into(),
                cwd.join("barrier").to_string_lossy().into(),
            ],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        store.insert_agent(&agent).unwrap();
        let manager = AcpManager::new(cwd.join("logs"), cwd.clone());
        let (send, events) = mpsc::unbounded_channel();
        let (release, gate) = std::sync::mpsc::channel();
        let gate = std::sync::Mutex::new(gate);
        let sink: SessionSink = Arc::new(move |event| {
            let blocked =
                gated && event.pointer("/update/content/text") == Some(&json!("fixture-gate"));
            let _ = send.send(event);
            if blocked {
                let _ = gate.lock().unwrap().recv_timeout(Duration::from_secs(5));
            }
        });
        let opened = manager
            .open_session(&agent, &cwd, None, vec![], sink, &store)
            .await
            .unwrap();
        Self {
            _root: root,
            cwd,
            manager,
            store,
            agent,
            session_id: opened.session_id,
            events,
            release: Some(release),
        }
    }

    async fn prompt(&self, mode: &str) {
        self.manager
            .session_prompt(
                &self.agent.id,
                &self.cwd,
                &self.session_id,
                serde_json::from_value(json!([{"type":"text","text":mode}])).unwrap(),
            )
            .await
            .unwrap();
    }

    async fn next(&mut self) -> Value {
        tokio::time::timeout(Duration::from_secs(5), self.events.recv())
            .await
            .expect("bounded fixture event")
            .expect("fixture remains connected")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(release) = self.release.take() {
            let _ = release.send(());
        }
        self.manager.stop_for_shutdown();
    }
}

#[tokio::test]
async fn session_url_is_presented_and_accept_has_no_form_content() {
    let mut f = Fixture::new().await;
    f.prompt("url").await;
    let inquiry = loop {
        let e = f.next().await;
        if e["kind"] == "elicitation" || e["kind"] == "elicitationUnavailable" {
            break e;
        }
    };
    assert_eq!(
        inquiry["kind"], "elicitation",
        "a known URL mode must reach the user"
    );
    assert_eq!(inquiry["mode"], "url");
    assert_eq!(inquiry["request"]["_meta"]["future"], true);
    f.manager
        .elicitation_respond(
            inquiry["requestId"].as_str().unwrap(),
            &f.session_id,
            "accept",
            None,
        )
        .unwrap();
    let mut received_reply = false;
    let mut completed = false;
    loop {
        let e = f.next().await;
        if let Some(text) = e.pointer("/update/content/text").and_then(Value::as_str) {
            let wire: Value = serde_json::from_str(text).unwrap();
            assert_eq!(wire["result"], json!({"action":"accept"}));
            received_reply = true;
        }
        if e["kind"] == "elicitationComplete" {
            completed = true;
        }
        if e["kind"] == "turnEnd" {
            break;
        }
    }
    assert!(
        received_reply && completed,
        "reply and external completion are separate events"
    );
}

#[tokio::test]
async fn unadvertised_mode_is_invalid_params_not_a_user_cancel() {
    let mut f = Fixture::new().await;
    f.prompt("_controlled_future_mode").await;
    loop {
        let e = f.next().await;
        if let Some(text) = e.pointer("/update/content/text").and_then(Value::as_str) {
            let wire: Value = serde_json::from_str(text).unwrap();
            assert_eq!(wire.pointer("/error/code"), Some(&json!(-32602)));
            assert!(wire.get("result").is_none());
            break;
        }
    }
}

#[tokio::test]
async fn completion_after_a_received_inquiry_survives_the_session_dispatch_queue() {
    let mut f = Fixture::build(true).await;
    f.prompt("queued-complete").await;
    loop {
        let e = f.next().await;
        if e.pointer("/update/content/text") == Some(&json!("fixture-gate")) {
            break;
        }
    }
    tokio::time::timeout(Duration::from_secs(4), async {
        while !f.cwd.join("barrier").exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("peer received the connection-level barrier reply while the session sink is gated");
    f.release.take().unwrap().send(()).unwrap();
    let mut inquiry = None;
    let mut complete = None;
    loop {
        let e = f.next().await;
        if e["kind"] == "elicitation" {
            inquiry = Some(e.clone());
        }
        if e["kind"] == "elicitationComplete" {
            assert!(inquiry.is_some(), "creation must publish before completion");
            complete = Some(e.clone());
        }
        if e["kind"] == "turnEnd" {
            break;
        }
    }
    assert_eq!(
        complete.expect("a previously received inquiry is known even before pump dispatch")["requestId"],
        inquiry.unwrap()["requestId"]
    );
    assert!(f.manager.pending_elicitations.lock().unwrap().is_empty());
}

#[tokio::test]
async fn rejected_url_id_cannot_be_reused_by_a_later_inquiry() {
    let mut f = Fixture::new().await;
    f.prompt("rejected-reuse").await;
    let mut inquiries = 0;
    let mut completions = 0;
    let mut reply = None;
    loop {
        let e = f.next().await;
        if e["kind"] == "elicitation" {
            inquiries += 1;
        }
        if e["kind"] == "elicitationComplete" {
            completions += 1;
        }
        if let Some(text) = e.pointer("/update/content/text").and_then(Value::as_str) {
            reply = Some(serde_json::from_str::<Value>(text).unwrap());
        }
        if e["kind"] == "turnEnd" {
            break;
        }
    }
    assert_eq!(
        inquiries, 0,
        "a retired ID cannot identify a different inquiry"
    );
    assert_eq!(completions, 0, "A's stale completion must never complete B");
    assert_eq!(reply.unwrap().pointer("/error/code"), Some(&json!(-32602)));
    assert!(f.manager.pending_elicitations.lock().unwrap().is_empty());
}

#[tokio::test]
async fn session_scoped_load_inquiry_is_answerable_before_load_returns() {
    let f = Fixture::new().await;
    let (send, mut events) = mpsc::unbounded_channel();
    let sink: SessionSink = Arc::new(move |event| {
        let _ = send.send(event);
    });
    let run = f.manager.open_session(
        &f.agent,
        &f.cwd,
        Some("opening-load".into()),
        vec![],
        sink,
        &f.store,
    );
    tokio::pin!(run);
    let inquiry = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            tokio::select! {
                result = &mut run => panic!("load ended before asking the user; error={:?}", result.err()),
                event = events.recv() => { let event = event.unwrap(); if event["kind"] == "elicitation" { break event; } }
            }
        }
    }).await.expect("load must not park its required question behind its own response");
    assert_eq!(inquiry["owner"]["sessionId"], "opening-load");
    f.manager
        .elicitation_respond(
            inquiry["requestId"].as_str().unwrap(),
            "opening-load",
            "accept",
            Some(json!({})),
        )
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(3), &mut run)
            .await
            .unwrap()
            .is_ok()
    );
    assert!(f.manager.pending_elicitations.lock().unwrap().is_empty());
}

#[tokio::test]
async fn accepted_url_without_completion_expires_when_the_prompt_ends() {
    let mut f = Fixture::new().await;
    f.prompt("url-no-complete").await;
    let question = loop {
        let e = f.next().await;
        if e["kind"] == "elicitation" {
            break e;
        }
    };
    f.manager
        .elicitation_respond(
            question["requestId"].as_str().unwrap(),
            &f.session_id,
            "accept",
            None,
        )
        .unwrap();
    let mut expired = false;
    loop {
        let e = f.next().await;
        assert_ne!(e["kind"], "elicitationComplete");
        if e["kind"] == "interactionExpired" {
            expired = true;
        }
        if e["kind"] == "turnEnd" {
            break;
        }
    }
    assert!(expired);
    assert!(f.manager.pending_elicitations.lock().unwrap().is_empty());
}

#[tokio::test]
async fn url_received_after_session_cancel_is_cancelled_without_a_card_or_completion() {
    let mut f = Fixture::new().await;
    f.prompt("running").await;
    f.manager
        .session_cancel(&f.agent.id, &f.cwd, &f.session_id)
        .await
        .unwrap();
    loop {
        let e = f.next().await;
        assert_ne!(e["kind"], "elicitation");
        assert_ne!(e["kind"], "elicitationComplete");
        if e["kind"] == "turnEnd" {
            assert_eq!(e["stopReason"], "cancelled");
            break;
        }
    }
    assert!(f.manager.pending_elicitations.lock().unwrap().is_empty());
}
