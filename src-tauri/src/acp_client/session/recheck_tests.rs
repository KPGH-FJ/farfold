//! A configuration recheck releases only an idle local route, never history.
use super::*;
use crate::meta_store::MetaStore;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

const PEER: &str = r#"
import sys,json,os
path=sys.argv[1]+'.'+str(os.getpid())+'.json';can_load=sys.argv[2]=='yes';hold=sys.argv[3]=='yes'
calls=[];held=None
options=[{'id':'model','name':'Model','category':'model','type':'select','currentValue':'m1','options':[{'value':'m1','name':'M1'}]}]
def emit(value):
 print(json.dumps(dict(jsonrpc='2.0',**value)),flush=True)
for line in sys.stdin:
 message=json.loads(line);method=message.get('method');params=message.get('params',{})
 if method is None: continue
 calls.append({'method':method,'sessionId':params.get('sessionId')})
 with open(path+'.tmp','w') as output: json.dump(calls,output)
 os.replace(path+'.tmp',path)
 if method=='session/cancel':
  if held is not None: emit({'id':held,'result':{'stopReason':'cancelled'}});held=None
  continue
 result={}
 if method=='initialize':
  result={'protocolVersion':1,'agentCapabilities':{'loadSession':can_load,'sessionCapabilities':{'close':{}}},'authMethods':[]}
 elif method=='session/new': result={'sessionId':'recheck-proof','configOptions':options}
 elif method=='session/load':
  if params['sessionId']!='recheck-proof': raise ValueError('changed conversation')
  for kind in ['user_message_chunk','agent_message_chunk']:
   emit({'method':'session/update','params':{'sessionId':'recheck-proof','update':{'sessionUpdate':kind,'content':{'type':'text','text':'preserved recheck marker'}}}})
  result={'configOptions':options}
 elif method=='session/prompt':
  if hold: held=message['id'];continue
  result={'stopReason':'end_turn'}
 if 'id' in message: emit({'id':message['id'],'result':result})
"#;

struct Fixture {
    manager: Arc<AcpManager>,
    store: MetaStore,
    row: AgentRow,
    cwd: PathBuf,
    events: Arc<Mutex<Vec<Value>>>,
    sink: SessionSink,
    _directory: tempfile::TempDir,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}

impl Fixture {
    async fn open(can_load: bool, hold: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let cwd = directory.path().canonicalize().unwrap();
        std::fs::write(cwd.join("peer.py"), PEER).unwrap();
        let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
        let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
        let row = AgentRow {
            id: "configuration-recheck-fixture".into(),
            name: "Fixture".into(),
            source: "custom".into(),
            command: "/usr/bin/python3".into(),
            args: vec![
                "-u".into(),
                cwd.join("peer.py").to_string_lossy().into(),
                cwd.join("calls.json").to_string_lossy().into(),
                if can_load { "yes" } else { "no" }.into(),
                if hold { "yes" } else { "no" }.into(),
            ],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        store.insert_agent(&row).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let capture = events.clone();
        let sink: SessionSink = Arc::new(move |event| capture.lock().unwrap().push(event));
        let fixture = Self {
            manager,
            store,
            row,
            cwd,
            events,
            sink,
            _directory: directory,
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
        assert_eq!(opened.session_id, "recheck-proof");
        fixture
    }

    async fn prompt(&self) {
        let blocks = serde_json::from_value(serde_json::json!([
            {"type":"text","text":"controlled recheck marker"}
        ]))
        .unwrap();
        self.manager
            .session_prompt(&self.row.id, &self.cwd, "recheck-proof", blocks)
            .await
            .unwrap();
    }

    async fn settled(&self) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !self
                .events
                .lock()
                .unwrap()
                .iter()
                .any(|event| event["kind"] == "turnEnd")
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    }

    fn row(&self) -> crate::meta_store::SessionRow {
        let id = super::super::session_index::session_row_id(
            &self.row.id,
            &self.cwd.to_string_lossy(),
            "recheck-proof",
        );
        self.store.get_session(&id).unwrap().unwrap()
    }

    fn calls(&self) -> Vec<Value> {
        std::fs::read_dir(&self.cwd)
            .unwrap()
            .filter_map(|entry| {
                let path = entry.unwrap().path();
                let name = path.file_name().unwrap().to_string_lossy();
                if name.starts_with("calls.json.") && name.ends_with(".json") {
                    Some(
                        serde_json::from_slice::<Vec<Value>>(&std::fs::read(path).unwrap())
                            .unwrap(),
                    )
                } else {
                    None
                }
            })
            .flatten()
            .collect()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn configuration_recheck_detaches_locally_even_when_remote_close_is_declared() {
    let fixture = Fixture::open(true, false).await;
    fixture.prompt().await;
    fixture.settled().await;
    let prior = fixture.row();
    fixture
        .manager
        .detach_session_for_config_check(&fixture.row.id, &fixture.cwd, "recheck-proof", false)
        .await
        .unwrap();
    fixture.events.lock().unwrap().clear();
    let reopened = fixture
        .manager
        .open_session(
            &fixture.row,
            &fixture.cwd,
            Some("recheck-proof".into()),
            vec![],
            fixture.sink.clone(),
            &fixture.store,
        )
        .await
        .unwrap();
    assert_eq!(reopened.session_id, "recheck-proof");
    assert_eq!(reopened.config_check.status, "ready");
    let after = fixture.row();
    assert_eq!(after.id, prior.id);
    assert_eq!(after.agent_id, prior.agent_id);
    assert_eq!(after.native_session_id, prior.native_session_id);
    assert_eq!(after.config_options, prior.config_options);
    assert!(
        fixture
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event.pointer("/update/content/text")
                == Some(&Value::String("preserved recheck marker".into())))
    );
    let calls = fixture.calls();
    for forbidden in ["session/close", "session/delete"] {
        assert!(!calls.iter().any(|call| call["method"] == forbidden));
    }
    for (method, count) in [
        ("session/new", 1),
        ("session/load", 1),
        ("session/prompt", 1),
    ] {
        assert_eq!(
            calls.iter().filter(|call| call["method"] == method).count(),
            count
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn configuration_recheck_rejects_missing_load_support_before_detaching() {
    let fixture = Fixture::open(false, false).await;
    fixture.prompt().await;
    fixture.settled().await;
    let prior = fixture.row();
    assert!(
        fixture
            .manager
            .detach_session_for_config_check(&fixture.row.id, &fixture.cwd, "recheck-proof", false)
            .await
            .is_err()
    );
    assert!(
        fixture
            .manager
            .session_connection(&fixture.row.id, &fixture.cwd, "recheck-proof")
            .is_ok()
    );
    assert_eq!(fixture.row().config_options, prior.config_options);
    assert!(!fixture.calls().iter().any(|call| matches!(
        call["method"].as_str(),
        Some("session/close" | "session/load" | "session/delete")
    )));
}

#[tokio::test(flavor = "multi_thread")]
async fn configuration_recheck_rejects_a_real_in_flight_prompt_and_keeps_its_owner() {
    let fixture = Fixture::open(true, true).await;
    fixture.prompt().await;
    let prior = fixture.row();
    assert!(
        fixture
            .manager
            .detach_session_for_config_check(&fixture.row.id, &fixture.cwd, "recheck-proof", true)
            .await
            .is_err()
    );
    assert!(
        fixture
            .manager
            .session_connection(&fixture.row.id, &fixture.cwd, "recheck-proof")
            .is_ok()
    );
    assert_eq!(fixture.row().config_options, prior.config_options);
    fixture
        .manager
        .session_cancel(&fixture.row.id, &fixture.cwd, "recheck-proof")
        .await
        .unwrap();
    fixture.settled().await;
    assert!(!fixture.calls().iter().any(|call| matches!(
        call["method"].as_str(),
        Some("session/close" | "session/load" | "session/delete")
    )));
}

#[tokio::test(flavor = "multi_thread")]
async fn configuration_recheck_retry_requires_confirmed_absence_and_no_opening_owner() {
    let fixture = Fixture::open(true, false).await;
    fixture.prompt().await;
    fixture.settled().await;
    let prior = fixture.row();
    fixture
        .manager
        .detach_session_for_config_check(&fixture.row.id, &fixture.cwd, "recheck-proof", false)
        .await
        .unwrap();
    assert!(
        fixture
            .manager
            .detach_session_for_config_check(&fixture.row.id, &fixture.cwd, "recheck-proof", false)
            .await
            .is_err()
    );
    let opening = fixture
        .manager
        .opening_sessions
        .reserve(&fixture.row.id, &fixture.cwd, "recheck-proof")
        .unwrap();
    assert!(
        fixture
            .manager
            .detach_session_for_config_check(&fixture.row.id, &fixture.cwd, "recheck-proof", true)
            .await
            .is_err()
    );
    drop(opening);
    fixture
        .manager
        .detach_session_for_config_check(&fixture.row.id, &fixture.cwd, "recheck-proof", true)
        .await
        .unwrap();
    assert_eq!(fixture.row().config_options, prior.config_options);
    assert!(!fixture.calls().iter().any(|call| matches!(
        call["method"].as_str(),
        Some("session/close" | "session/load" | "session/delete")
    )));
}
