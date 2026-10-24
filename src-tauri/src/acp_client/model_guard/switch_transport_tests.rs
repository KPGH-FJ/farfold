//! Controlled transport/metadata boundaries, not installed-Agent acceptance.
use crate::acp_client::{
    manager::AcpManager,
    pump::{SessionControl, SessionSink},
    session_index::session_row_id,
};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::mpsc;

const SESSION: &str = "switch-proof";
const PEER: &str = r#"
import sys,json,time,os,threading
state_path=sys.argv[1]
root=os.path.dirname(state_path)
if os.path.exists(state_path):
 with open(state_path) as f: state=json.load(f)
else:
 state={'counts':{},'options':[
  {'id':'model','name':'Model','category':'model','type':'select','currentValue':'m1','options':[{'value':v,'name':v} for v in ['m1','m2']]},
  {'id':'reasoning_effort','name':'Thinking','category':'thought_level','type':'select','currentValue':'low','options':[{'value':v,'name':v} for v in ['low','high']]}]}
def save():
 with open(state_path+'.tmp','w') as f: json.dump(state,f)
 os.replace(state_path+'.tmp',state_path)
send_lock=threading.Lock()
def send(x):
 with send_lock: print(json.dumps(dict(jsonrpc='2.0',**x)),flush=True)
def notifications():
 while True:
  path=os.path.join(root,'inject-update.json')
  if os.path.exists(path):
   with open(path) as f: update=json.load(f)
   options=json.loads(json.dumps(update.get('options',state['options'])))
   for option in options:
    if option['id'] in update['values']: option['currentValue']=update['values'][option['id']]
   session=update.get('sessionId','switch-proof')
   if session=='switch-proof': state['options']=options;save()
   send({'method':'session/update','params':{'sessionId':session,'update':{'sessionUpdate':'config_option_update','configOptions':options}}})
   os.remove(path)
  time.sleep(.005)
threading.Thread(target=notifications,daemon=True).start()
for line in sys.stdin:
 m=json.loads(line); p=m.get('params',{}); method=m.get('method'); result={}
 if method is None: continue
 state['counts'][method]=state['counts'].get(method,0)+1
 if method=='initialize':
  result={'protocolVersion':1,'agentCapabilities':{'loadSession':True},'authMethods':[]}
 elif method in ('session/new','session/load'):
  if method=='session/load' and p['sessionId']!='switch-proof': raise ValueError('wrong session')
  result=dict(configOptions=state['options'],**({'sessionId':'switch-proof'} if method=='session/new' else {}))
 elif method=='session/set_config_option':
  if p['sessionId']!='switch-proof': raise ValueError('changed session')
  for o in state['options']:
   if o['id']==p['configId']: o['currentValue']=p['value']
   if p['configId']=='model' and o['id']=='reasoning_effort':
    o['currentValue']='high' if p['value']=='m2' else 'low'
  save()
  send({'method':'session/update','params':{'sessionId':'switch-proof','update':{'sessionUpdate':'config_option_update','configOptions':state['options']}}})
  if os.path.exists(os.path.join(root,'request-permission')):
   send({'id':'held-permission','method':'session/request_permission','params':{'sessionId':'switch-proof','toolCall':{'toolCallId':'pending-tool','title':'Fixture approval','kind':'read','status':'pending'},'options':[{'optionId':'allow','name':'Allow','kind':'allow_once'}]}})
  if os.path.exists(os.path.join(root,'hold-set')):
   with open(os.path.join(root,'waiting'),'w') as f: f.write('applied')
   until=time.monotonic()+5
   while not os.path.exists(os.path.join(root,'release-set')):
    if time.monotonic()>until: raise TimeoutError('test never released reply')
    time.sleep(.005)
  result={'configOptions':state['options']}
 elif method=='session/prompt': result={'stopReason':'end_turn'}
 elif method=='session/cancel':
  save();continue
 save()
 if 'id' in m: send({'id':m['id'],'result':result})
"#;

struct Fixture {
    manager: Arc<AcpManager>,
    store: MetaStore,
    row: AgentRow,
    cwd: PathBuf,
    sink: SessionSink,
    events: mpsc::UnboundedReceiver<Value>,
    event_hook: Arc<std::sync::Mutex<Option<EventHook>>>,
    _dir: tempfile::TempDir,
}
type EventHook = Box<dyn Fn(&Value) + Send + Sync>;
impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}
impl Fixture {
    async fn open() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().canonicalize().unwrap();
        std::fs::write(cwd.join("peer.py"), PEER).unwrap();
        let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
        let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
        let row = AgentRow {
            id: "configuration-change-fixture".into(),
            name: "Fixture".into(),
            source: "custom".into(),
            command: crate::platform_tests::python(),
            args: vec![
                "-u".into(),
                cwd.join("peer.py").to_string_lossy().into(),
                cwd.join("peer-state.json").to_string_lossy().into(),
            ],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        store.insert_agent(&row).unwrap();
        let (tx, events) = mpsc::unbounded_channel();
        let event_hook: Arc<std::sync::Mutex<Option<EventHook>>> =
            Arc::new(std::sync::Mutex::new(None));
        let hook = event_hook.clone();
        let sink: SessionSink = Arc::new(move |value| {
            if let Some(callback) = hook.lock().unwrap().as_ref() {
                callback(&value);
            }
            let _ = tx.send(value);
        });
        let fixture = Self {
            manager,
            store,
            row,
            cwd,
            sink,
            events,
            event_hook,
            _dir: dir,
        };
        let opened = fixture
            .manager
            .open_session(
                &fixture.row,
                &fixture.cwd,
                None,
                vec![],
                fixture.sink.clone(),
                &fixture.store,
            )
            .await
            .unwrap();
        assert_eq!(opened.session_id, SESSION);
        assert_eq!(opened.config_check.status, "ready");
        fixture
    }
    async fn next(&mut self, kind: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let value = self.events.recv().await.expect("fixture event channel");
                if value["kind"] == kind {
                    return value;
                }
            }
        })
        .await
        .expect("fixture event deadline")
    }
    async fn check(&mut self, status: &str) -> Value {
        loop {
            let event = self.next("configCheck").await;
            if event["check"]["status"] == status {
                return event["check"].clone();
            }
        }
    }
    async fn unknown_without_ready(&mut self) -> Value {
        loop {
            let check = self.next("configCheck").await["check"].clone();
            assert_ne!(
                check["status"], "ready",
                "late success must not release the guard"
            );
            if check["issues"]
                .as_array()
                .unwrap()
                .iter()
                .any(|issue| issue["reason"] == "unknown")
            {
                assert_eq!(check["status"], "blocked");
                return check;
            }
        }
    }
    fn drain(&mut self) {
        while self.events.try_recv().is_ok() {}
    }
    async fn admit(&mut self) {
        self.manager
            .session_prompt(&self.row.id, &self.cwd, SESSION, blocks())
            .await
            .unwrap();
        self.next("turnEnd").await;
        self.assert_record("m1", "low");
        self.drain();
    }
    fn state(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.cwd.join("peer-state.json")).unwrap()).unwrap()
    }
    fn assert_calls(&self, new: u64, load: u64, set: u64, prompt: u64) {
        let counts = &self.state()["counts"];
        for (method, expected) in [
            ("session/new", new),
            ("session/load", load),
            ("session/set_config_option", set),
            ("session/prompt", prompt),
        ] {
            assert_eq!(counts[method].as_u64().unwrap_or(0), expected, "{method}");
        }
    }
    fn sql(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.cwd.join("meta.db")).unwrap()
    }
    fn assert_record(&self, model: &str, effort: &str) {
        let id = session_row_id(&self.row.id, &self.cwd.to_string_lossy(), SESSION);
        let row = self.store.get_session(&id).unwrap().unwrap();
        assert_eq!(row.native_session_id.as_deref(), Some(SESSION));
        let record = row.config_options.unwrap();
        assert_eq!(record["_farfoldConfig"], 2);
        assert_choices(&record, model, effort);
        let count: i64 = self
            .sql()
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            count, 1,
            "changing settings must update the existing index row"
        );
    }
    async fn cold_check(&mut self, status: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Ok(reservation) =
                    self.manager
                        .opening_sessions
                        .reserve(&self.row.id, &self.cwd, SESSION)
                {
                    drop(reservation);
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("open reservation cleanup");
        self.manager
            .disconnect(&self.row.id, &self.cwd)
            .await
            .unwrap();
        self.drain();
        let restored = self
            .manager
            .open_session(
                &self.row,
                &self.cwd,
                Some(SESSION.into()),
                vec![],
                self.sink.clone(),
                &self.store,
            )
            .await
            .unwrap();
        assert_eq!(restored.session_id, SESSION);
        assert_eq!(restored.config_check.status, status);
        serde_json::to_value(restored.config_check).unwrap()
    }
}
fn blocks() -> Vec<agent_client_protocol::schema::v1::ContentBlock> {
    serde_json::from_value(json!([{"type":"text","text":"fixture"}])).unwrap()
}
fn assert_choices(snapshot: &Value, model: &str, effort: &str) {
    let choices = snapshot["choices"].as_array().unwrap();
    assert_eq!(choices.len(), 2);
    for (id, category, expected) in [
        ("model", "model", model),
        ("reasoning_effort", "thought_level", effort),
    ] {
        let choice = choices.iter().find(|choice| choice["id"] == id).unwrap();
        assert_eq!(choice["value"], expected);
        assert_eq!(choice["category"], category);
        assert_eq!(choice["type"], "select");
    }
}

#[path = "saved_restore_tests.rs"]
mod saved_restore_tests;

#[tokio::test(flavor = "multi_thread")]
async fn configuration_change_transport_notifies_before_ack_persists_and_cold_loads_same_session() {
    let mut fixture = Fixture::open().await;
    fixture.admit().await;
    let changed = fixture
        .manager
        .session_set_config(&fixture.row.id, &fixture.cwd, SESSION, "model", json!("m2"))
        .await
        .unwrap();
    assert!(changed.is_object());
    for key in [
        "configOptions",
        "configCheck",
        "service",
        "permissionState",
        "permissionConfigId",
    ] {
        assert!(changed.get(key).is_some(), "atomic response missing {key}");
    }
    assert_eq!(changed["service"], Value::Null);
    assert_eq!(changed["configCheck"]["status"], "ready");
    assert_choices(&changed["configCheck"]["current"], "m2", "high");
    assert_eq!(changed["configOptions"][0]["currentValue"], "m2");
    assert_eq!(changed["configOptions"][1]["currentValue"], "high");
    let early = fixture.check("blocked").await;
    assert_choices(&early["current"], "m2", "high");
    let confirmed = fixture.check("ready").await;
    assert_choices(&confirmed["current"], "m2", "high");
    fixture.assert_record("m2", "high");
    fixture.assert_calls(1, 0, 1, 1);
    let cold = fixture.cold_check("ready").await;
    assert_choices(&cold["current"], "m2", "high");
    fixture.assert_record("m2", "high");
    fixture.assert_calls(1, 1, 1, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn configuration_change_transport_save_failure_keeps_exact_retry_without_resending() {
    let mut fixture = Fixture::open().await;
    fixture.admit().await;
    fixture.sql().execute_batch(
        "CREATE TRIGGER fail_change BEFORE UPDATE ON sessions BEGIN SELECT RAISE(FAIL, 'fixture'); END;",
    ).unwrap();
    let error = fixture
        .manager
        .session_set_config(&fixture.row.id, &fixture.cwd, SESSION, "model", json!("m2"))
        .await
        .unwrap_err();
    assert!(error.contains("未能保存"));
    let failed = fixture.check("record_failed").await;
    assert_choices(&failed["current"], "m2", "high");
    fixture.assert_record("m1", "low");
    assert_eq!(
        fixture
            .manager
            .session_prompt(&fixture.row.id, &fixture.cwd, SESSION, blocks(),)
            .await
            .unwrap_err(),
        "FAILED: CONFIG_RECORD_FAILED"
    );
    let displayed = failed["current"].clone();
    assert!(
        fixture
            .manager
            .confirm_config(&fixture.row.id, &fixture.cwd, SESSION, displayed.clone(),)
            .await
            .unwrap_err()
            .contains("未能保存")
    );
    fixture.assert_record("m1", "low");
    fixture.assert_calls(1, 0, 1, 1);
    fixture
        .sql()
        .execute_batch("DROP TRIGGER fail_change")
        .unwrap();
    let confirmed = fixture
        .manager
        .confirm_config(&fixture.row.id, &fixture.cwd, SESSION, displayed)
        .await
        .unwrap();
    assert_eq!(confirmed["status"], "ready");
    assert_choices(&confirmed["current"], "m2", "high");
    fixture.assert_record("m2", "high");
    fixture.assert_calls(1, 0, 1, 1);
    let cold = fixture.cold_check("ready").await;
    assert_choices(&cold["current"], "m2", "high");
    fixture.assert_calls(1, 1, 1, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn configuration_change_transport_timeout_and_late_ack_never_confirm_or_overwrite_baseline() {
    let mut fixture = Fixture::open().await;
    fixture.admit().await;
    let record_id = session_row_id(&fixture.row.id, &fixture.cwd.to_string_lossy(), SESSION);
    let saved = fixture
        .store
        .get_session(&record_id)
        .unwrap()
        .unwrap()
        .config_options
        .unwrap();
    assert_eq!(saved["_farfoldService"]["kind"], "existing");
    std::fs::write(fixture.cwd.join("hold-set"), "").unwrap();
    let connection = fixture
        .manager
        .session_connection(&fixture.row.id, &fixture.cwd, SESSION)
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
        .send(SessionControl::SetConfig {
            config_id: "model".into(),
            value: json!("m2"),
            deadline: tokio::time::Instant::now() + Duration::from_millis(120),
            result,
        })
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !fixture.cwd.join("waiting").exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("peer applied held request");
    assert!(
        fixture
            .manager
            .session_set_config(&fixture.row.id, &fixture.cwd, SESSION, "model", json!("m1"),)
            .await
            .is_err(),
        "reentry while the original mutation is pending"
    );
    let timed_out = tokio::time::timeout(Duration::from_secs(3), receive)
        .await
        .unwrap()
        .unwrap();
    assert!(timed_out.unwrap_err().contains("尚未确认"));
    let unknown = fixture.unknown_without_ready().await;
    assert_choices(&unknown["current"], "m2", "high");
    fixture.assert_record("m1", "low");
    std::fs::write(fixture.cwd.join("release-set"), "").unwrap();
    let late = fixture.unknown_without_ready().await;
    assert_choices(&late["current"], "m2", "high");
    assert_eq!(
        fixture
            .manager
            .session_prompt(&fixture.row.id, &fixture.cwd, SESSION, blocks(),)
            .await
            .unwrap_err(),
        "FAILED: CONFIG_BLOCKED"
    );
    assert!(
        fixture
            .manager
            .confirm_config(
                &fixture.row.id,
                &fixture.cwd,
                SESSION,
                late["current"].clone(),
            )
            .await
            .is_err(),
        "an unknown outcome cannot authorize a baseline save"
    );
    fixture.assert_record("m1", "low");
    fixture.assert_calls(1, 0, 1, 1);
    let cold = fixture.cold_check("ready").await;
    assert_choices(&cold["current"], "m1", "low");
    assert!(cold["issues"].as_array().unwrap().is_empty());
    fixture.assert_record("m1", "low");
    assert_eq!(
        fixture
            .store
            .get_session(&record_id)
            .unwrap()
            .unwrap()
            .config_options
            .unwrap(),
        saved,
        "explicit cold replay must preserve the saved source and full baseline"
    );
    fixture.assert_calls(1, 1, 2, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn configuration_change_transport_pending_approval_blocks_an_idle_model_change() {
    let mut fixture = Fixture::open().await;
    fixture.admit().await;
    std::fs::write(fixture.cwd.join("request-permission"), "").unwrap();
    fixture
        .manager
        .session_set_config(&fixture.row.id, &fixture.cwd, SESSION, "model", json!("m2"))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let event = fixture.events.recv().await.unwrap();
            if event["kind"] == "permissionRequest" {
                break;
            }
        }
    })
    .await
    .expect("peer permission request must be registered");
    assert!(
        fixture
            .manager
            .session_set_config(&fixture.row.id, &fixture.cwd, SESSION, "model", json!("m1"),)
            .await
            .is_err(),
        "an approval can remain pending while no prompt is running"
    );
    fixture.assert_record("m2", "high");
    fixture.assert_calls(1, 0, 1, 1);
}
