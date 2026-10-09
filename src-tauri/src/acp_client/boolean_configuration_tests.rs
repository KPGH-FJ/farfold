//! Negotiated boolean configuration through the real manager and JSON-RPC transport.
//! The peer and storage are owned fixtures; no real Agent or model is contacted.
use super::{manager::AcpManager, pump::SessionSink};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc, time::Duration};

const SESSION: &str = "boolean-configuration-fixture";
const PEER: &str = r#"
import sys,json,os
path,mode=sys.argv[1:3]
session='boolean-configuration-fixture'
state={'calls':[],'flag':False,'verbosity':'brief','rejections':0}
advertised=False
def save():
 with open(path+'.tmp','w') as f: json.dump(state,f)
 os.replace(path+'.tmp',path)
def send(v): print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def options():
 values=[{'id':'verbosity','name':'Verbosity','type':'select','currentValue':state['verbosity'],'options':[{'value':v,'name':v} for v in ['brief','detailed']]}]
 if advertised and mode!='select-only':
  values.append({'id':'feature-enabled','name':'Optional feature','type':'boolean','currentValue':state['flag']})
 return values
for line in sys.stdin:
 m=json.loads(line);p=m.get('params',{});method=m.get('method')
 if method is None: continue
 state['calls'].append({'method':method,'params':p});save()
 if method=='initialize':
  capability=p.get('clientCapabilities',{}).get('session',{}).get('configOptions',{}).get('boolean')
  advertised=isinstance(capability,dict)
  result={'protocolVersion':1,'agentCapabilities':{},'authMethods':[]}
 elif method=='session/new': result={'sessionId':session,'configOptions':options()}
 elif method=='session/set_config_option':
  assert p['sessionId']==session, p
  if p['configId']=='feature-enabled':
   assert advertised and mode!='select-only', 'boolean was not negotiated'
   assert p.get('type')=='boolean' and isinstance(p['value'],bool), p
   if mode=='reject-once' and state['rejections']==0:
    state['rejections']+=1;save()
    send({'id':m['id'],'error':{'code':-32602,'message':'Fixture rejected boolean choice'}})
    continue
   state['flag']=p['value']
  else:
   assert p['configId']=='verbosity' and isinstance(p['value'],str), p
   assert p['value'] in ['brief','detailed'], p
   state['verbosity']=p['value']
  save()
  send({'method':'session/update','params':{'sessionId':session,'update':{'sessionUpdate':'config_option_update','configOptions':options()}}})
  result={'configOptions':options()}
 elif method=='session/cancel': continue
 else: raise ValueError('unexpected fixture method '+str(method))
 if 'id' in m: send({'id':m['id'],'result':result})
"#;

struct Fixture {
    manager: Arc<AcpManager>,
    row: AgentRow,
    cwd: PathBuf,
    initial: Value,
    _store: MetaStore,
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
            id: "boolean-configuration-fixture".into(),
            name: "Fixture".into(),
            source: "custom".into(),
            command: crate::platform_tests::python(),
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
        let mut fixture = Self {
            manager,
            row,
            cwd,
            initial: Value::Null,
            _store: store,
            _directory: directory,
        };
        let sink: SessionSink = Arc::new(|_| {});
        let opened = tokio::time::timeout(
            Duration::from_secs(5),
            fixture.manager.open_session(
                &fixture.row,
                &fixture.cwd,
                None,
                vec![],
                sink,
                &fixture._store,
            ),
        )
        .await
        .expect("bounded synthetic initialization")
        .unwrap();
        assert_eq!(opened.session_id, SESSION);
        assert_eq!(opened.config_check.status, "ready");
        fixture.initial = opened.config_options.unwrap();
        fixture
    }

    fn state(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.cwd.join("state.json")).unwrap()).unwrap()
    }

    fn setters(&self) -> Vec<Value> {
        self.state()["calls"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|call| call["method"] == "session/set_config_option")
            .map(|call| call["params"].clone())
            .collect()
    }

    async fn set(&self, id: &str, value: Value) -> Result<Value, String> {
        tokio::time::timeout(
            Duration::from_secs(5),
            self.manager
                .session_set_config(&self.row.id, &self.cwd, SESSION, id, value),
        )
        .await
        .expect("bounded synthetic setter")
    }
}

fn current(options: &Value, id: &str) -> Option<Value> {
    options
        .as_array()?
        .iter()
        .find(|option| option["id"] == id)
        .map(|option| option["currentValue"].clone())
}

#[tokio::test(flavor = "multi_thread")]
async fn negotiated_boolean_is_visible_and_round_trips_without_losing_existing_capabilities() {
    let fixture = Fixture::open("boolean").await;
    assert_eq!(
        current(&fixture.initial, "feature-enabled"),
        Some(json!(false)),
        "a capability-gated peer must expose boolean options"
    );
    let state = fixture.state();
    let capabilities = &state["calls"][0]["params"]["clientCapabilities"];
    assert_eq!(
        capabilities["session"]["configOptions"]["boolean"],
        json!({})
    );
    assert_eq!(capabilities["auth"]["terminal"], true);
    assert_eq!(capabilities["elicitation"]["form"], json!({}));
    assert_eq!(capabilities["_meta"]["terminal-auth"], true);
    assert_eq!(
        capabilities["_meta"]["jetbrains"]["air"],
        super::failures::capability()
    );
    for value in [true, false] {
        let reply = fixture.set("feature-enabled", json!(value)).await.unwrap();
        assert_eq!(
            current(&reply["configOptions"], "feature-enabled"),
            Some(json!(value))
        );
        assert_eq!(
            current(&reply["configOptions"], "verbosity"),
            Some(json!("brief"))
        );
        assert_eq!(reply["configCheck"]["status"], "ready");
    }
    assert_eq!(
        fixture.setters(),
        vec![
            json!({"sessionId":SESSION,"configId":"feature-enabled","type":"boolean","value":true}),
            json!({"sessionId":SESSION,"configId":"feature-enabled","type":"boolean","value":false}),
        ]
    );
    assert!(
        fixture.state()["calls"]
            .as_array()
            .unwrap()
            .iter()
            .all(|call| call["method"] != "session/prompt")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn rejected_boolean_is_not_retried_and_next_explicit_choice_can_succeed() {
    let fixture = Fixture::open("reject-once").await;
    assert_eq!(
        current(&fixture.initial, "feature-enabled"),
        Some(json!(false))
    );
    assert!(fixture.set("feature-enabled", json!(true)).await.is_err());
    assert_eq!(fixture.setters().len(), 1);
    assert_eq!(fixture.state()["flag"], false);
    let reply = fixture.set("feature-enabled", json!(true)).await.unwrap();
    assert_eq!(
        current(&reply["configOptions"], "feature-enabled"),
        Some(json!(true))
    );
    assert_eq!(fixture.setters().len(), 2);
    assert_eq!(fixture.state()["rejections"], 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn select_only_peer_ignores_boolean_capability_and_keeps_its_existing_setter() {
    let fixture = Fixture::open("select-only").await;
    assert_eq!(current(&fixture.initial, "feature-enabled"), None);
    assert_eq!(current(&fixture.initial, "verbosity"), Some(json!("brief")));
    let reply = fixture.set("verbosity", json!("detailed")).await.unwrap();
    assert_eq!(
        current(&reply["configOptions"], "verbosity"),
        Some(json!("detailed"))
    );
    assert_eq!(current(&reply["configOptions"], "feature-enabled"), None);
    assert_eq!(
        fixture.setters(),
        vec![json!({"sessionId":SESSION,"configId":"verbosity","value":"detailed"})]
    );
}
