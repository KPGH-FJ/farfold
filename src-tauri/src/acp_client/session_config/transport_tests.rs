//! Real JSON-RPC transport against a local controlled peer, not a real Agent.
use super::*;
use crate::acp_client::{
    manager::AcpManager,
    pump::{OpenedSession, SessionSink},
    session_index::session_row_id,
};
use crate::meta_store::{AgentRow, MetaStore};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::mpsc;

const SESSION: &str = "legacy-proof";
const PEER: &str = r#"
import sys,json,os,time
path,mode=sys.argv[1:3];root=os.path.dirname(path)
state=json.load(open(path)) if os.path.exists(path) else {'calls':[],'prompts':[]}
model='m1';effort='low'
def save():
 with open(path+'.tmp','w') as f: json.dump(state,f)
 os.replace(path+'.tmp',path)
def send(m): print(json.dumps(dict(jsonrpc='2.0',**m)),flush=True)
def options():
 result=[]
 if mode=='modern-empty': result.append({'id':'model','name':'Model','category':'model','type':'select','currentValue':model,'options':[{'value':v,'name':v} for v in ['m1','m2']]})
 if mode=='thinking': result.append({'id':'effort','name':'Thinking','category':'thought_level','type':'select','currentValue':effort,'options':[{'value':v,'name':v} for v in ['low','high']]})
 return result
def update(v): send({'method':'session/update','params':{'sessionId':'legacy-proof','update':v}})
for line in sys.stdin:
 m=json.loads(line);p=m.get('params',{});method=m.get('method')
 if method is None: continue
 state['calls'].append({'method':method,'params':p});save();result={}
 if method=='initialize': result={'protocolVersion':1,'agentCapabilities':{'loadSession':True},'authMethods':[]}
 elif method in ['session/new','session/load']:
  if method=='session/load':
   if p['sessionId']!='legacy-proof': raise ValueError('changed original conversation')
   update({'sessionUpdate':'user_message_chunk','content':{'type':'text','text':'Previous fixture question'}})
   update({'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'Previous fixture answer'}})
  result={'models':{'currentModelId':model,'availableModels':[{'modelId':v,'name':v.upper()} for v in ['m1','m2']]},'configOptions':options()}
  if method=='session/new': result['sessionId']='legacy-proof'
 elif method=='session/set_model':
  if p['sessionId']!='legacy-proof': raise ValueError('changed original conversation')
  model=p['modelId'];effort='high'
  fault=open(os.path.join(root,'fault')).read() if os.path.exists(os.path.join(root,'fault')) else ''
  if mode=='thinking':
   notification={'sessionUpdate':'config_option_update','configOptions':options()}
   if fault=='missing-options': del notification['configOptions']
   elif fault=='null-options': notification['configOptions']=None
   elif fault=='object-options': notification['configOptions']={}
   update(notification)
  if mode!='silent': update({'sessionUpdate':'current_model_update','currentModelId':'m1' if fault=='conflict' else model,'_meta':{'kept':True}})
  if os.path.exists(os.path.join(root,'hold')):
   with open(os.path.join(root,'waiting'),'w') as f: f.write('applied')
   until=time.monotonic()+5
   while not os.path.exists(os.path.join(root,'release')):
    if time.monotonic()>until: raise TimeoutError('fixture never released the acknowledgement')
    time.sleep(.005)
 elif method=='session/set_config_option':
  if mode!='modern-empty':
   if p['configId']!='effort': raise ValueError('legacy model sent to modern setter')
   effort=p['value'];result={'configOptions':options()}
   update({'sessionUpdate':'config_option_update','configOptions':options()})
 elif method=='session/prompt':
  state['prompts'].append({'model':model,'effort':effort});save()
  update({'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'Fixture answer'}})
  result={'stopReason':'end_turn'}
 elif method=='session/cancel': continue
 if 'id' in m: send({'id':m['id'],'result':result})
"#;

struct Fixture {
    manager: Arc<AcpManager>,
    store: MetaStore,
    row: AgentRow,
    cwd: PathBuf,
    sink: SessionSink,
    events: mpsc::UnboundedReceiver<Value>,
    _directory: tempfile::TempDir,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}
impl Fixture {
    async fn open(mode: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let cwd = directory.path().canonicalize().unwrap();
        std::fs::write(cwd.join("peer.py"), PEER).unwrap();
        let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
        let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
        let row = AgentRow {
            id: "legacy-model-fixture".into(),
            name: "Fixture".into(),
            source: "custom".into(),
            command: "/usr/bin/python3".into(),
            args: vec![
                "-u".into(),
                cwd.join("peer.py").to_string_lossy().into(),
                cwd.join("state.json").to_string_lossy().into(),
                mode.into(),
            ],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        store.insert_agent(&row).unwrap();
        let (tx, events) = mpsc::unbounded_channel();
        let sink: SessionSink = Arc::new(move |event| {
            let _ = tx.send(event);
        });
        let fixture = Self {
            manager,
            store,
            row,
            cwd,
            sink,
            events,
            _directory: directory,
        };
        let opened = fixture.load(None).await;
        assert_eq!(opened.config_check.status, "ready");
        assert_eq!(
            opened
                .config_options
                .unwrap()
                .as_array()
                .unwrap()
                .iter()
                .filter(|o| o["category"] == "model")
                .count(),
            1
        );
        fixture
    }
    async fn load(&self, id: Option<String>) -> OpenedSession {
        self.manager
            .open_session(
                &self.row,
                &self.cwd,
                id,
                vec![],
                self.sink.clone(),
                &self.store,
            )
            .await
            .unwrap()
    }
    async fn next(&mut self, kind: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(4), async {
            loop {
                let event = self.events.recv().await.unwrap();
                if event["kind"] == kind {
                    return event;
                }
            }
        })
        .await
        .expect("fixture event deadline")
    }
    async fn prompt(&mut self) {
        self.manager
            .session_prompt(
                &self.row.id,
                &self.cwd,
                SESSION,
                serde_json::from_value(json!([{"type":"text","text":"fixture"}])).unwrap(),
            )
            .await
            .unwrap();
        self.next("turnEnd").await;
    }
    async fn set(&self, id: &str, value: &str) -> Result<Value, String> {
        self.manager
            .session_set_config(&self.row.id, &self.cwd, SESSION, id, json!(value))
            .await
    }
    fn state(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.cwd.join("state.json")).unwrap()).unwrap()
    }
    fn record(&self) -> Value {
        let id = session_row_id(&self.row.id, &self.cwd.to_string_lossy(), SESSION);
        self.store
            .get_session(&id)
            .unwrap()
            .unwrap()
            .config_options
            .unwrap()
    }
    fn model(snapshot: &Value) -> &Value {
        &snapshot["choices"]
            .as_array()
            .unwrap()
            .iter()
            .find(|choice| choice["category"] == "model")
            .unwrap()["value"]
    }
    async fn cold(&self) -> OpenedSession {
        self.manager
            .disconnect(&self.row.id, &self.cwd)
            .await
            .unwrap();
        self.load(Some(SESSION.into())).await
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn legacy_transport_empty_ack_updates_original_session_and_cold_restores_before_next_prompt()
{
    for mode in ["silent", "thinking"] {
        let mut f = Fixture::open(mode).await;
        f.prompt().await;
        let changed = f.set(LEGACY_MODEL_ID, "m2").await.unwrap();
        assert_eq!(changed["configCheck"]["status"], "ready");
        assert_eq!(Fixture::model(&f.record()), "m2");
        if mode == "thinking" {
            f.set("effort", "low").await.unwrap();
        }
        let restored = f.cold().await;
        assert_eq!(restored.session_id, SESSION);
        assert_eq!(restored.config_check.status, "ready");
        assert!(
            f.state()["calls"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|call| call["method"] == "session/new")
                .count()
                == 1
        );
        assert_eq!(
            f.state()["prompts"].as_array().unwrap().len(),
            1,
            "cold restore must not prompt"
        );
        f.prompt().await;
        assert_eq!(f.state()["prompts"][1]["model"], "m2");
        if mode == "thinking" {
            assert_eq!(f.state()["prompts"][1]["effort"], "low");
        }
        let calls = f.state()["calls"].as_array().unwrap().clone();
        assert_eq!(
            calls
                .iter()
                .filter(|call| call["method"] == "session/set_model")
                .count(),
            2
        );
        assert!(
            calls
                .iter()
                .filter(|call| call["method"] == "session/set_config_option")
                .all(|call| call["params"]["configId"] == "effort")
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn legacy_transport_conflicting_notification_blocks_without_overwriting_saved_model() {
    let mut f = Fixture::open("legacy").await;
    f.prompt().await;
    let record = f.record();
    std::fs::write(f.cwd.join("fault"), "conflict").unwrap();
    assert!(f.set(LEGACY_MODEL_ID, "m2").await.is_err());
    assert_eq!(f.record(), record);
    assert!(
        f.manager
            .session_prompt(
                &f.row.id,
                &f.cwd,
                SESSION,
                serde_json::from_value(json!([{"type":"text","text":"must remain unsent"}]))
                    .unwrap()
            )
            .await
            .is_err()
    );
    assert_eq!(f.state()["prompts"].as_array().unwrap().len(), 1);
    let mut raw = false;
    while let Ok(event) = f.events.try_recv() {
        if event.pointer("/update/sessionUpdate") == Some(&json!("current_model_update")) {
            assert_eq!(event.pointer("/update/_meta/kept"), Some(&json!(true)));
            raw = true;
        }
    }
    assert!(raw, "preserve the original extension envelope");
}

#[tokio::test(flavor = "multi_thread")]
async fn legacy_transport_modern_empty_result_does_not_fallback_to_set_model() {
    let mut f = Fixture::open("modern-empty").await;
    f.prompt().await;
    let record = f.record();
    assert!(f.set("model", "m2").await.is_err());
    assert_eq!(f.record(), record);
    assert!(
        !f.state()["calls"]
            .as_array()
            .unwrap()
            .iter()
            .any(|call| call["method"] == "session/set_model")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn legacy_transport_malformed_configuration_cannot_remove_saved_reasoning_or_confirm() {
    for fault in ["missing-options", "null-options", "object-options"] {
        let mut f = Fixture::open("thinking").await;
        f.prompt().await;
        let record = f.record();
        while f.events.try_recv().is_ok() {}
        std::fs::write(f.cwd.join("fault"), fault).unwrap();
        assert!(f.set(LEGACY_MODEL_ID, "m2").await.is_err(), "{fault}");
        assert_eq!(f.record(), record, "{fault}");
        let mut unknown = None;
        let mut raw = false;
        while let Ok(event) = f.events.try_recv() {
            if event["kind"] == "configCheck" {
                assert_ne!(event["check"]["status"], "ready", "{fault}");
                if event["check"]["issues"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|issue| issue["reason"] == "unknown")
                {
                    unknown = Some(event["check"]["current"].clone());
                }
            }
            if event.pointer("/update/sessionUpdate") == Some(&json!("config_option_update")) {
                assert_eq!(
                    event.pointer("/update/configOptions").cloned(),
                    match fault {
                        "missing-options" => None,
                        "null-options" => Some(Value::Null),
                        _ => Some(json!({})),
                    }
                );
                raw = true;
            }
        }
        assert!(
            raw,
            "{fault}: original invalid envelope must remain available"
        );
        assert!(
            f.manager
                .confirm_config(&f.row.id, &f.cwd, SESSION, unknown.expect("unknown change"))
                .await
                .is_err()
        );
        assert!(
            f.manager
                .session_prompt(
                    &f.row.id,
                    &f.cwd,
                    SESSION,
                    serde_json::from_value(json!([{"type":"text","text":"must remain unsent"}]))
                        .unwrap()
                )
                .await
                .is_err()
        );
        assert_eq!(f.record(), record, "{fault}");
        assert_eq!(f.state()["prompts"].as_array().unwrap().len(), 1, "{fault}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn legacy_transport_save_failure_retains_old_baseline_and_exact_retry() {
    let mut f = Fixture::open("silent").await;
    f.prompt().await;
    let record = f.record();
    let sql = rusqlite::Connection::open(f.cwd.join("meta.db")).unwrap();
    sql.execute_batch("CREATE TRIGGER fail_change BEFORE UPDATE ON sessions BEGIN SELECT RAISE(FAIL, 'fixture'); END;").unwrap();
    assert!(
        f.set(LEGACY_MODEL_ID, "m2")
            .await
            .unwrap_err()
            .contains("未能保存")
    );
    assert_eq!(f.record(), record);
    let displayed = loop {
        let check = f.next("configCheck").await;
        if check["check"]["status"] == "record_failed" {
            break check["check"]["current"].clone();
        }
    };
    sql.execute_batch("DROP TRIGGER fail_change").unwrap();
    let saved = f
        .manager
        .confirm_config(&f.row.id, &f.cwd, SESSION, displayed)
        .await
        .unwrap();
    assert_eq!(saved["status"], "ready");
    assert_eq!(Fixture::model(&f.record()), "m2");
    assert_eq!(
        f.state()["calls"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|call| call["method"] == "session/set_model")
            .count(),
        1
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn legacy_transport_late_empty_ack_cannot_authorize_an_unknown_change() {
    let mut f = Fixture::open("legacy").await;
    f.prompt().await;
    let record = f.record();
    while f.events.try_recv().is_ok() {}
    std::fs::write(f.cwd.join("hold"), "").unwrap();
    let connection = f
        .manager
        .session_connection(&f.row.id, &f.cwd, SESSION)
        .unwrap();
    let control = connection
        .sessions
        .lock()
        .unwrap()
        .get(SESSION)
        .unwrap()
        .control
        .clone();
    let (result, receive) = tokio::sync::oneshot::channel();
    control
        .send(crate::acp_client::pump::SessionControl::SetConfig {
            config_id: LEGACY_MODEL_ID.into(),
            value: json!("m2"),
            deadline: tokio::time::Instant::now() + Duration::from_millis(120),
            result,
        })
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !f.cwd.join("waiting").exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(3), receive)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    async fn unknown(f: &mut Fixture) -> Value {
        loop {
            let event = f.next("configCheck").await;
            assert_ne!(event["check"]["status"], "ready");
            if event["check"]["issues"]
                .as_array()
                .unwrap()
                .iter()
                .any(|issue| issue["reason"] == "unknown")
            {
                return event["check"]["current"].clone();
            }
        }
    }
    unknown(&mut f).await;
    assert_eq!(f.record(), record);
    std::fs::write(f.cwd.join("release"), "").unwrap();
    let late = unknown(&mut f).await;
    assert!(
        f.manager
            .confirm_config(&f.row.id, &f.cwd, SESSION, late)
            .await
            .is_err()
    );
    assert_eq!(f.record(), record);
    assert_eq!(
        f.state()["calls"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|call| call["method"] == "session/set_model")
            .count(),
        1
    );
    assert_eq!(f.state()["prompts"].as_array().unwrap().len(), 1);
}
