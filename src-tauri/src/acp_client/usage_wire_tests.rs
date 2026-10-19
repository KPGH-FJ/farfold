//! Usage reports through the official typed ACP client and session pump.
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
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); p=m.get('params',{})
 if method=='initialize': reply(m,{'protocolVersion':1,'agentCapabilities':{},'authMethods':[]})
 elif method=='session/new': reply(m,{'sessionId':'usage-fixture'})
 elif method=='session/prompt':
  mode=p['prompt'][0]['text']
  usage={'totalTokens':61,'inputTokens':31,'outputTokens':30,'thoughtTokens':7,'cachedReadTokens':11,'cachedWriteTokens':13,'_meta':{'future':'token-report'}}
  update={'sessionUpdate':'usage_update','used':12,'size':100,'cost':{'amount':0.000001,'currency':'USD','_meta':{'future':'cost-report'}},'_meta':{'future':'context-report'}}
  result={'stopReason':'end_turn','_meta':{'future':'prompt-report'}}
  if mode=='zero':
   usage={k:0 for k in usage if k!='_meta'}
   update={'sessionUpdate':'usage_update','used':0,'size':100,'cost':{'amount':0,'currency':'USD'}}
  elif mode=='invalid-required': usage['totalTokens']='invalid'
  elif mode=='invalid-optional': usage['thoughtTokens']=-1
  elif mode=='failure':
   send({'id':m['id'],'error':{'code':-32603,'message':'fixture prompt failed'}})
   continue
  if mode!='missing': result['usage']=usage
  if mode in ['complete','zero']:
   send({'method':'session/update','params':{'sessionId':p['sessionId'],'update':update}})
  reply(m,result)
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
            id: "usage-wire-fixture".into(),
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
async fn official_prompt_usage_and_context_cost_keep_every_field_and_metadata() {
    let mut f = Fixture::new().await;
    let events = f.prompt("complete").await;
    let receipt = events.last().unwrap()["promptReceiptId"]
        .as_u64()
        .filter(|id| *id > 0)
        .expect("owned prompt receipt");
    assert_eq!(
        events.last().unwrap(),
        &json!({"kind":"turnEnd","promptReceiptId":receipt,"stopReason":"end_turn", "usage":{
            "totalTokens":61,"inputTokens":31,"outputTokens":30,"thoughtTokens":7,
            "cachedReadTokens":11,"cachedWriteTokens":13,"_meta":{"future":"token-report"}
        },"meta":{"future":"prompt-report"}})
    );
    let usage = events
        .iter()
        .find(|event| event.pointer("/update/sessionUpdate") == Some(&json!("usage_update")))
        .expect("context update reaches the session event channel");
    assert_eq!(
        usage["update"],
        json!({"sessionUpdate":"usage_update","used":12,"size":100,
            "cost":{"amount":0.000001,"currency":"USD","_meta":{"future":"cost-report"}},
            "_meta":{"future":"context-report"}})
    );
}

#[tokio::test]
async fn official_zero_reports_remain_zero_without_rounding_or_omission() {
    let mut f = Fixture::new().await;
    let events = f.prompt("zero").await;
    assert_eq!(
        events.last().unwrap()["usage"],
        json!({"totalTokens":0,"inputTokens":0,"outputTokens":0,"thoughtTokens":0,
            "cachedReadTokens":0,"cachedWriteTokens":0})
    );
    let update = events
        .iter()
        .find_map(|event| event.get("update"))
        .expect("zero context report");
    assert_eq!(update["used"], 0);
    assert_eq!(update["cost"]["amount"], 0.0);
}

#[tokio::test]
async fn missing_invalid_and_failed_reports_never_reuse_prior_prompt_usage() {
    let mut f = Fixture::new().await;
    let complete = f.prompt("complete").await;
    assert!(complete.last().unwrap().get("usage").is_some());
    for mode in ["missing", "invalid-required", "failure"] {
        let events = f.prompt(mode).await;
        let end = events.last().unwrap();
        assert!(end.get("usage").is_none(), "{mode}: {end}");
        if mode == "failure" {
            assert!(end.get("error").is_some());
        } else {
            assert_eq!(end["stopReason"], "end_turn");
        }
    }
}

#[tokio::test]
async fn official_invalid_optional_count_does_not_discard_valid_required_usage() {
    let mut f = Fixture::new().await;
    let events = f.prompt("invalid-optional").await;
    let usage = &events.last().unwrap()["usage"];
    assert!(usage.get("thoughtTokens").is_none());
    assert_eq!(usage["totalTokens"], 61);
    assert_eq!(usage["inputTokens"], 31);
    assert_eq!(usage["outputTokens"], 30);
    assert_eq!(usage["cachedReadTokens"], 11);
    assert_eq!(usage["cachedWriteTokens"], 13);
    assert_eq!(usage["_meta"]["future"], "token-report");
}
