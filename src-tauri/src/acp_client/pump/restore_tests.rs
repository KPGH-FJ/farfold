//! Controlled cold-load recovery, never installed-Agent acceptance.
use crate::acp_client::{
    manager::AcpManager,
    pump::{OpenedSession, SessionSink},
    session_index::session_row_id,
};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

const SESSION: &str = "restore-proof";
const PEER: &str = r#"
import sys,json,os,copy
path=sys.argv[1];root=os.path.dirname(path)
if os.path.exists(path):
 with open(path) as f: calls=json.load(f)
else: calls=[]
restoring=False
options=[
 {'id':'model','name':'Model','category':'model','type':'select','currentValue':'m1','options':[{'value':v,'name':v} for v in ['m1','m2']]},
 {'id':'reasoning_effort','name':'Thinking','category':'thought_level','type':'select','currentValue':'low','options':[{'value':v,'name':v} for v in ['low','high']]}]
def save():
 with open(path+'.tmp','w') as f: json.dump(calls,f)
 os.replace(path+'.tmp',path)
def update():
 return {'method':'session/update','params':{'sessionId':'restore-proof','update':{'sessionUpdate':'config_option_update','configOptions':copy.deepcopy(options)}}}
def send_batch(messages):
 sys.stdout.write(''.join(json.dumps(dict(jsonrpc='2.0',**m))+'\n' for m in messages));sys.stdout.flush()
for line in sys.stdin:
 m=json.loads(line);p=m.get('params',{});method=m.get('method')
 if method is None: continue
 if method=='session/load': restoring=True
 calls.append({'method':method,'restoring':restoring,'params':p});save()
 result={};prefix=[];suffix=[]
 if method=='initialize': result={'protocolVersion':1,'agentCapabilities':{'loadSession':True},'authMethods':[],'_meta':{'jetbrains':{'air':{'version':1,'capabilities':['asyncTasks']}}}}
 elif method in ('session/new','session/load'):
  if method=='session/load':
   if p['sessionId']!='restore-proof': raise ValueError('wrong native session')
   options[0]['currentValue']='m1';options[1]['currentValue']='low'
   prefix=[update()];suffix=[update()]
   if os.path.exists(os.path.join(root,'fault')):
    with open(os.path.join(root,'fault')) as f: mode=f.read()
    if mode=='flow-load-prefix':
     prefix.extend({'method':'session/update','params':{'sessionId':'restore-proof','update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'row-'+str(i)},'futureIndex':i},'_meta':{'exact':True}}} for i in range(1024))
    if mode in ('load-async-running','load-async-completed','load-async-unknown'):
     prefix.append({'method':'session/update','params':{'sessionId':'restore-proof','update':{'sessionUpdate':'async_task_spawned','asyncTaskId':'load-task','name':'Live load task','taskType':'shell','canStop':True,'toolCallId':'load-tool'}}})
     if mode!='load-async-running': prefix.append({'method':'session/update','params':{'sessionId':'restore-proof','update':{'sessionUpdate':'async_task_state_update','asyncTaskId':'load-task','toolCallId':'load-tool','state':'completed' if mode=='load-async-completed' else 'future-state'}}})
  result=dict(configOptions=copy.deepcopy(options),**({'sessionId':'restore-proof'} if method=='session/new' else {}))
 elif method=='session/set_config_option':
  if p['sessionId']!='restore-proof': raise ValueError('changed native session')
  mode=''
  if restoring and os.path.exists(os.path.join(root,'fault')):
   with open(os.path.join(root,'fault')) as f: mode=f.read()
  if mode=='error':
   send_batch([{'id':m['id'],'error':{'code':-32602,'message':'fixture refused recovery'}}]);continue
  for option in options:
   if option['id']==p['configId']: option['currentValue']=p['value']
   if p['configId']=='model' and option['id']=='reasoning_effort': option['currentValue']='high'
  if mode=='wrong': options[0]['currentValue']='m1'
  prefix=[update()];result={'configOptions':copy.deepcopy(options)}
  if mode=='late-drift' and p['configId']=='reasoning_effort':
   options[0]['currentValue']='m1';suffix=[update()]
   suffix[0]['params']['update']['_fixtureRestorePhase']='thought-post-reply-drift'
  if mode=='thought-before-stale-reply' and p['configId']=='reasoning_effort':
   options[0]['currentValue']='m1';prefix=[update()]
  if mode=='model-late-drift' and p['configId']=='model':
   options[0]['currentValue']='m1';suffix=[update()]
   suffix[0]['params']['update']['_fixtureRestorePhase']='model-post-reply-drift'
  if mode=='model-before-stale-reply' and p['configId']=='model':
   options[0]['currentValue']='m1';prefix=[update()]
  if mode=='active-tool':
   prefix.append({'method':'session/update','params':{'sessionId':'restore-proof','update':{'sessionUpdate':'tool_call','toolCallId':'restore-tool','title':'Fixture running tool','kind':'read','status':'in_progress'}}})
  if mode=='new-model':
   options.append({'id':'unexpected-model','category':'model','type':'select','currentValue':'other','options':[{'value':'other','name':'Other'}]})
   prefix=[update()];result={'configOptions':copy.deepcopy(options)}
 elif method=='session/prompt': result={'stopReason':'end_turn'}
 elif method=='session/cancel': continue
 if 'id' in m: send_batch(prefix+[{'id':m['id'],'result':result}]+suffix)
"#;

struct Fixture {
    manager: Arc<AcpManager>,
    store: MetaStore,
    row: AgentRow,
    cwd: PathBuf,
    events: Arc<Mutex<Vec<Value>>>,
    sink: SessionSink,
    _dir: tempfile::TempDir,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}
impl Fixture {
    async fn established() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().canonicalize().unwrap();
        std::fs::write(cwd.join("peer.py"), PEER).unwrap();
        let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
        let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
        let row = AgentRow {
            id: "configuration-restore-fixture".into(),
            name: "Fixture".into(),
            source: "custom".into(),
            command: crate::platform_tests::python(),
            args: vec![
                "-u".into(),
                cwd.join("peer.py").to_string_lossy().into(),
                cwd.join("calls.json").to_string_lossy().into(),
            ],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        store.insert_agent(&row).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let sink: SessionSink = Arc::new(move |event| captured.lock().unwrap().push(event));
        let fixture = Self {
            manager,
            store,
            row,
            cwd,
            events,
            sink,
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
        let blocks = serde_json::from_value(json!([{"type":"text","text":"fixture"}])).unwrap();
        fixture
            .manager
            .session_prompt(&fixture.row.id, &fixture.cwd, SESSION, blocks)
            .await
            .unwrap();
        fixture.wait_event("turnEnd").await;
        fixture
            .manager
            .session_set_config(&fixture.row.id, &fixture.cwd, SESSION, "model", json!("m2"))
            .await
            .unwrap();
        fixture
            .manager
            .session_set_config(
                &fixture.row.id,
                &fixture.cwd,
                SESSION,
                "reasoning_effort",
                json!("low"),
            )
            .await
            .unwrap();
        assert_choices(&fixture.record(), "m2", "low");
        fixture
    }
    async fn wait_event(&self, kind: &str) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !self
                .events
                .lock()
                .unwrap()
                .iter()
                .any(|event| event["kind"] == kind)
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("fixture event deadline");
    }
    fn record(&self) -> Value {
        let id = session_row_id(&self.row.id, &self.cwd.to_string_lossy(), SESSION);
        let row = self.store.get_session(&id).unwrap().unwrap();
        assert_eq!(row.native_session_id.as_deref(), Some(SESSION));
        row.config_options.unwrap()
    }
    fn calls(&self) -> Vec<Value> {
        serde_json::from_slice(&std::fs::read(self.cwd.join("calls.json")).unwrap()).unwrap()
    }
    fn restore_sets(&self) -> Vec<(String, String)> {
        self.calls()
            .into_iter()
            .filter(|call| {
                call["restoring"] == true && call["method"] == "session/set_config_option"
            })
            .map(|call| {
                (
                    call["params"]["configId"].as_str().unwrap().into(),
                    call["params"]["value"].as_str().unwrap().into(),
                )
            })
            .collect()
    }
    fn assert_identity_and_no_prompt(&self) {
        let calls = self.calls();
        assert_eq!(
            calls
                .iter()
                .filter(|call| call["method"] == "session/new")
                .count(),
            1
        );
        assert_eq!(
            calls
                .iter()
                .filter(|call| call["method"] == "session/load")
                .count(),
            1
        );
        assert_eq!(
            calls
                .iter()
                .filter(|call| call["method"] == "session/prompt")
                .count(),
            1
        );
        for call in calls
            .iter()
            .filter(|call| call["restoring"] == true && call["method"] != "initialize")
        {
            assert_eq!(call["params"]["sessionId"], SESSION);
        }
        let sql = rusqlite::Connection::open(self.cwd.join("meta.db")).unwrap();
        let count: i64 = sql
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
    async fn cold(&self) -> Result<OpenedSession, String> {
        self.manager
            .disconnect(&self.row.id, &self.cwd)
            .await
            .unwrap();
        self.events.lock().unwrap().clear();
        self.manager
            .open_session(
                &self.row,
                &self.cwd,
                Some(SESSION.into()),
                vec![],
                self.sink.clone(),
                &self.store,
            )
            .await
    }
}
fn assert_choices(snapshot: &Value, model: &str, effort: &str) {
    let choices = snapshot["choices"].as_array().unwrap();
    assert_eq!(choices.len(), 2);
    for (id, expected) in [("model", model), ("reasoning_effort", effort)] {
        assert_eq!(
            choices.iter().find(|choice| choice["id"] == id).unwrap()["value"],
            expected
        );
    }
}

async fn assert_not_ready(fixture: &Fixture, opened: Result<OpenedSession, String>) {
    match opened {
        Ok(opened) => {
            assert!(matches!(
                opened.config_check.status,
                "blocked" | "record_failed"
            ));
            let blocks =
                serde_json::from_value(json!([{"type":"text","text":"must remain unsent"}]))
                    .unwrap();
            assert!(
                fixture
                    .manager
                    .session_prompt(&fixture.row.id, &fixture.cwd, SESSION, blocks)
                    .await
                    .is_err()
            );
        }
        Err(error) => assert!(!error.is_empty()),
    }
    assert!(
        !fixture
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event["kind"] == "configCheck" && event["check"]["status"] == "ready"),
        "unconfirmed recovery must never publish ready"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn configuration_restore_load_defaults_replays_model_then_saved_thought_on_same_session() {
    let fixture = Fixture::established().await;
    let baseline = fixture.record();
    let restored = fixture.cold().await.unwrap();
    assert_eq!(restored.session_id, SESSION);
    assert_eq!(restored.config_check.status, "ready");
    assert_choices(&restored.config_check.current, "m2", "low");
    let options = restored.config_options.unwrap();
    assert_eq!(options[0]["currentValue"], "m2");
    assert_eq!(options[1]["currentValue"], "low");
    assert_eq!(
        fixture.restore_sets(),
        vec![
            ("model".into(), "m2".into()),
            ("reasoning_effort".into(), "low".into())
        ]
    );
    assert_eq!(fixture.record(), baseline);
    fixture.assert_identity_and_no_prompt();
    for event in fixture
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|event| event["kind"] == "configCheck" && event["check"]["status"] == "ready")
    {
        assert_choices(&event["check"]["current"], "m2", "low");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn configuration_restore_rejected_or_wrong_reply_keeps_saved_baseline_and_blocks_prompt() {
    for mode in [
        "error",
        "wrong",
        "model-before-stale-reply",
        "active-tool",
        "new-model",
    ] {
        let fixture = Fixture::established().await;
        let baseline = fixture.record();
        std::fs::write(fixture.cwd.join("fault"), mode).unwrap();
        let opened = fixture.cold().await;
        assert_not_ready(&fixture, opened).await;
        assert_eq!(
            fixture.restore_sets(),
            vec![("model".into(), "m2".into())],
            "{mode}: stop after an unconfirmed model reply"
        );
        assert_eq!(
            fixture.record(),
            baseline,
            "{mode}: never accept returned defaults as a saved choice"
        );
        fixture.assert_identity_and_no_prompt();
    }
}

async fn assert_post_reply_drift(fault: &str, phase: &'static str, thought_sent: bool) {
    let mut fixture = Fixture::established().await;
    let baseline = fixture.record();
    let seen = Arc::new(tokio::sync::Notify::new());
    let notify = seen.clone();
    let previous = fixture.sink.clone();
    fixture.sink = Arc::new(move |event| {
        let drift = event
            .pointer("/update/_fixtureRestorePhase")
            .and_then(Value::as_str)
            == Some(phase);
        previous(event);
        if drift {
            notify.notify_one();
        }
    });
    // This preserves the original post-response suffix. A single write does
    // not promise when it reaches the pump relative to the next setter.
    std::fs::write(fixture.cwd.join("fault"), fault).unwrap();
    let _opened = fixture.cold().await;
    tokio::time::timeout(Duration::from_secs(5), seen.notified())
        .await
        .expect("the actual post-reply drift must reach the original sink");
    let check = fixture
        .events
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|event| event["kind"] == "configCheck")
        .cloned()
        .unwrap();
    assert!(matches!(
        check["check"]["status"].as_str(),
        Some("blocked" | "record_failed")
    ));
    let blocks =
        serde_json::from_value(json!([{"type":"text","text":"must remain unsent"}])).unwrap();
    assert!(
        fixture
            .manager
            .session_prompt(&fixture.row.id, &fixture.cwd, SESSION, blocks)
            .await
            .is_err()
    );
    let sets = fixture.restore_sets();
    let model = ("model".into(), "m2".into());
    let thought = ("reasoning_effort".into(), "low".into());
    if thought_sent {
        assert_eq!(sets, vec![model, thought]);
    } else {
        assert!(sets == vec![model.clone()] || sets == vec![model, thought]);
    }
    assert_eq!(fixture.record(), baseline);
    fixture.assert_identity_and_no_prompt();
}

#[tokio::test(flavor = "multi_thread")]
async fn configuration_restore_post_reply_model_drift_blocks_after_receiving_it() {
    assert_post_reply_drift("model-late-drift", "model-post-reply-drift", false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn configuration_restore_post_reply_thought_drift_blocks_after_receiving_it() {
    assert_post_reply_drift("late-drift", "thought-post-reply-drift", true).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn configuration_restore_last_reply_followed_by_drift_never_publishes_stale_ready() {
    let fixture = Fixture::established().await;
    let baseline = fixture.record();
    // The incompatible notification precedes the stale final receipt, so
    // never-ready is a received-input requirement rather than a future guess.
    std::fs::write(fixture.cwd.join("fault"), "thought-before-stale-reply").unwrap();
    let opened = fixture.cold().await;
    assert_not_ready(&fixture, opened).await;
    assert_eq!(
        fixture.restore_sets(),
        vec![
            ("model".into(), "m2".into()),
            ("reasoning_effort".into(), "low".into())
        ]
    );
    assert_eq!(fixture.record(), baseline);
    fixture.assert_identity_and_no_prompt();
}

#[tokio::test(flavor = "multi_thread")]
async fn configuration_restore_confirmed_replay_save_failure_keeps_baseline_and_never_ready() {
    let fixture = Fixture::established().await;
    let baseline = fixture.record();
    let sql = rusqlite::Connection::open(fixture.cwd.join("meta.db")).unwrap();
    sql.execute_batch("CREATE TRIGGER fail_restore BEFORE UPDATE ON sessions BEGIN SELECT RAISE(FAIL, 'fixture recovery save'); END;").unwrap();
    let opened = fixture.cold().await;
    assert_not_ready(&fixture, opened).await;
    assert_eq!(
        fixture.restore_sets(),
        vec![
            ("model".into(), "m2".into()),
            ("reasoning_effort".into(), "low".into())
        ]
    );
    assert_eq!(fixture.record(), baseline);
    fixture.assert_identity_and_no_prompt();
}

#[tokio::test(flavor = "multi_thread")]
async fn configuration_restore_async_task_busy_blocks_automatic_mutation() {
    for mode in ["load-async-running", "load-async-unknown"] {
        let fixture = Fixture::established().await;
        let baseline = fixture.record();
        std::fs::write(fixture.cwd.join("fault"), mode).unwrap();
        let opened = fixture.cold().await;
        assert!(
            fixture.restore_sets().is_empty(),
            "{mode}: task work must block automatic model mutation"
        );
        assert_not_ready(&fixture, opened).await;
        assert_eq!(fixture.record(), baseline);
        fixture.assert_identity_and_no_prompt();
    }
}
#[tokio::test(flavor = "multi_thread")]
async fn configuration_restore_async_task_terminal_still_allows_saved_selection() {
    let fixture = Fixture::established().await;
    let baseline = fixture.record();
    std::fs::write(fixture.cwd.join("fault"), "load-async-completed").unwrap();
    let opened = fixture.cold().await.unwrap();
    assert_eq!(opened.config_check.status, "ready");
    assert_eq!(
        fixture.restore_sets(),
        vec![
            ("model".into(), "m2".into()),
            ("reasoning_effort".into(), "low".into())
        ]
    );
    assert_eq!(fixture.record(), baseline);
    fixture.assert_identity_and_no_prompt();
}

#[tokio::test(flavor = "multi_thread")]
async fn flow_load_configuration_before_long_prefix_reaches_original_reply_without_losing_raw_events()
 {
    let fixture = Fixture::established().await;
    let baseline = fixture.record();
    std::fs::write(fixture.cwd.join("fault"), "flow-load-prefix").unwrap();
    let restored = tokio::time::timeout(Duration::from_secs(10), fixture.cold())
        .await
        .expect("finite load must not wait on its own future reply")
        .unwrap();
    assert_eq!(restored.session_id, SESSION);
    assert_eq!(restored.config_check.status, "ready");
    let events = fixture.events.lock().unwrap();
    let raw = events
        .iter()
        .filter(|event| event.pointer("/update/futureIndex").is_some())
        .collect::<Vec<_>>();
    assert_eq!(raw.len(), 1024);
    for (index, event) in raw.iter().enumerate() {
        assert_eq!(event["sessionId"], SESSION);
        assert_eq!(event["update"]["futureIndex"], index);
        assert_eq!(event["update"]["content"]["text"], format!("row-{index}"));
        assert_eq!(event["_meta"]["exact"], true);
    }
    drop(events);
    assert_eq!(fixture.record(), baseline);
    fixture.assert_identity_and_no_prompt();
}

#[path = "restore_readonly_tests.rs"]
mod readonly;
