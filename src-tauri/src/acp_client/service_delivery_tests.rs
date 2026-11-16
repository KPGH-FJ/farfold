//! Owned JSON-RPC peer only: no installed Agent, account or model request.
use super::*;
use crate::{
    acp_client::{
        manager::AcpManager,
        service_connection::{PreparedService, ServiceContext},
    },
    credentials::ServiceIdentity,
    meta_store::{AgentRow, MetaStore},
};
use serde_json::json;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

const SECRET: &str = "delivery-secret-canary";
const PEER: &str = r#"
import json,sys,os,time
path,mode=sys.argv[1:3]
state={'calls':[],'setCount':0,'lists':0,'validDelivery':False}
def save():
 with open(path+'.tmp','w') as f: json.dump(state,f)
 os.replace(path+'.tmp',path)
def send(v): print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
for line in sys.stdin:
 m=json.loads(line);method=m.get('method');p=m.get('params',{})
 if method is None: continue
 state['calls'].append(method);save()
 if method=='initialize':
  caps={} if mode=='undeclared' else {'providers':{}}
  result={'protocolVersion':1,'agentCapabilities':caps,'authMethods':[]}
 elif method=='providers/list':
  state['lists']+=1;save()
  protocol='openai' if mode=='unsupported' else 'anthropic'
  route='https://selected.test/prefix' if state['setCount'] else 'https://old.test'
  identity='declared-slot'
  if state['setCount']:
   if mode=='wrong-route': route='https://wrong.test'
   if mode=='wrong-protocol': protocol='openai'
   if mode=='wrong-slot': identity='changed-slot'
  provider={'providerId':identity,'supported':[protocol],'required':False,
    'current':{'apiType':protocol,'baseUrl':route,'headers':{'x-api-key':'delivery-secret-canary'}},
    '_meta':{'sensitive':'delivery-secret-canary'}}
  values=[provider]
  if mode in ['ambiguous','duplicate']:
   values.append(dict(provider,providerId='second-slot' if mode=='ambiguous' else identity))
  result={'providers':values,'headers':{'Authorization':'delivery-secret-canary'}}
 elif method=='providers/set':
  state['setCount']+=1
  state['validDelivery']=(p=={'providerId':'declared-slot','apiType':'anthropic',
    'baseUrl':'https://selected.test/prefix','headers':{'x-api-key':'delivery-secret-canary'}})
  state['model']=os.getenv('ANTHROPIC_MODEL')
  state['secretInEnvironment']=any('delivery-secret-canary' in v for v in os.environ.values())
  save()
  if mode=='hold':
   while not os.path.exists(path+'.release'): time.sleep(.005)
  if mode=='disconnect': sys.exit(0)
  if mode=='reject':
   send({'id':m['id'],'error':{'code':-32602,'message':'delivery-secret-canary','data':{'key':'delivery-secret-canary'}}})
   continue
  result=None if mode=='null-receipt' else {}
 else: raise ValueError('unexpected fixture method '+str(method))
 if 'id' in m: send({'id':m['id'],'result':result})
"#;

fn selected() -> ServiceSnapshot {
    ServiceSnapshot {
        identity: ServiceIdentity {
            id: "selected".into(),
            fingerprint: "source-a".into(),
            model: "chosen-model".into(),
        },
        endpoint: "https://selected.test/prefix/v1".into(),
        api_type: "messages".into(),
        models: vec!["chosen-model".into()],
        secret: SECRET.into(),
        connection_revision: "revision-a".into(),
    }
}

struct Fixture {
    _directory: tempfile::TempDir,
    cwd: PathBuf,
    store: MetaStore,
    row: AgentRow,
    manager: Arc<AcpManager>,
    statuses: Arc<Mutex<Vec<Value>>>,
}

impl Fixture {
    fn new(mode: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let cwd = directory.path().canonicalize().unwrap();
        std::fs::write(cwd.join("peer.py"), PEER).unwrap();
        let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
        let statuses = Arc::new(Mutex::new(vec![]));
        let events = statuses.clone();
        let manager = Arc::new(
            AcpManager::new(cwd.join("logs"), cwd.clone()).with_status_sink(Arc::new(
                move |value| {
                    events
                        .lock()
                        .unwrap()
                        .push(serde_json::to_value(value).unwrap());
                },
            )),
        );
        let row = AgentRow {
            id: "registry:claude-acp".into(),
            name: "Fixture".into(),
            source: "registry".into(),
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
        Self {
            _directory: directory,
            cwd,
            store,
            row,
            manager,
            statuses,
        }
    }

    fn prepared(&self) -> PreparedService {
        let service = selected();
        // Exercise ACP transport against the synthetic peer. Production
        // Claude credential admission is covered separately and remains closed.
        let delivery = ServiceDelivery::anthropic(&service).unwrap();
        let mut environment = crate::shell_env::command_env();
        environment.insert("ANTHROPIC_MODEL".into(), service.identity.model.clone());
        PreparedService {
            environment,
            delivery: Some(delivery),
            context: ServiceContext {
                model_id: service.identity.model.clone(),
                identity: service.identity,
                revision: service.connection_revision,
            },
        }
    }

    async fn connect(&self) -> Result<crate::acp_client::manager::AgentConnectionStatus, String> {
        tokio::time::timeout(
            Duration::from_secs(5),
            self.manager.connect_launch(
                &self.row,
                &self.cwd,
                &self.store,
                false,
                Some(self.prepared()),
            ),
        )
        .await
        .expect("bounded fixture connection")
    }

    fn state(&self) -> Value {
        std::fs::read(self.cwd.join("state.json"))
            .ok()
            .and_then(|v| serde_json::from_slice(&v).ok())
            .unwrap_or(Value::Null)
    }

    fn no_public_secret(&self) {
        let statuses = serde_json::to_string(&*self.statuses.lock().unwrap()).unwrap();
        assert!(!statuses.contains(SECRET));
        let stored = self.store.get_agent(&self.row.id).unwrap().unwrap();
        assert!(!serde_json::to_string(&stored).unwrap().contains(SECRET));
        fn scan(path: &std::path::Path) {
            if path.is_dir() {
                for entry in std::fs::read_dir(path).unwrap() {
                    scan(&entry.unwrap().path());
                }
            } else {
                assert!(!String::from_utf8_lossy(&std::fs::read(path).unwrap()).contains(SECRET));
            }
        }
        if self.cwd.join("logs").exists() {
            scan(&self.cwd.join("logs"));
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}

async fn until(mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn declared_delivery_confirms_source_before_ready_and_drops_response_secrets() {
    let f = Fixture::new("success");
    let ready = f.connect().await.unwrap();
    assert_eq!(ready.state, "ready");
    let state = f.state();
    assert_eq!(
        state["calls"],
        json!([
            "initialize",
            "providers/list",
            "providers/set",
            "providers/list"
        ])
    );
    assert_eq!(state["validDelivery"], true);
    assert_eq!(state["model"], "chosen-model");
    assert_eq!(state["secretInEnvironment"], false);
    f.no_public_secret();
}

#[tokio::test(flavor = "multi_thread")]
async fn existing_source_keeps_its_settings_and_never_calls_provider_configuration() {
    let f = Fixture::new("success");
    let ready = f
        .manager
        .connect_launch(&f.row, &f.cwd, &f.store, false, None)
        .await
        .unwrap();
    assert_eq!(ready.state, "ready");
    assert_eq!(f.state()["calls"], json!(["initialize"]));
    assert_eq!(f.state()["setCount"], 0);
    f.no_public_secret();
}

#[tokio::test(flavor = "multi_thread")]
async fn absent_unsupported_and_ambiguous_declarations_never_receive_the_key() {
    for mode in ["undeclared", "unsupported", "ambiguous", "duplicate"] {
        let f = Fixture::new(mode);
        assert!(f.connect().await.is_err(), "{mode} must not become ready");
        assert_eq!(f.state()["setCount"], 0, "{mode}");
        assert!(
            !f.statuses
                .lock()
                .unwrap()
                .iter()
                .any(|s| s["state"] == "ready")
        );
        f.no_public_secret();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn rejected_missing_wrong_and_disconnected_receipts_never_become_ready() {
    for mode in [
        "reject",
        "null-receipt",
        "wrong-route",
        "wrong-protocol",
        "wrong-slot",
        "disconnect",
    ] {
        let f = Fixture::new(mode);
        let error = f.connect().await.expect_err("unconfirmed source must fail");
        assert!(!error.contains(SECRET));
        assert_eq!(f.state()["setCount"], 1, "{mode}: no automatic retry");
        assert!(
            !f.statuses
                .lock()
                .unwrap()
                .iter()
                .any(|s| s["state"] == "ready")
        );
        f.no_public_secret();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn pending_delivery_blocks_ready_until_the_readback_and_shutdown_cannot_revive_it() {
    for stop in [false, true] {
        let f = Fixture::new("hold");
        let mut connect = Box::pin(f.connect());
        tokio::select! {
            result = &mut connect => panic!("ready before delivery: {}", result.is_ok()),
            _ = until(||f.state()["setCount"]==1) => {}
        }
        assert!(
            !f.statuses
                .lock()
                .unwrap()
                .iter()
                .any(|s| s["state"] == "ready")
        );
        if stop {
            f.manager.stop_for_shutdown();
        }
        std::fs::write(f.cwd.join("state.json.release"), "release").unwrap();
        assert_eq!(connect.await.is_err(), stop);
        if stop {
            assert!(
                !f.statuses
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|s| s["state"] == "ready")
            );
        }
        f.no_public_secret();
    }
}

#[test]
fn anthropic_conversion_preserves_the_saved_messages_request_path() {
    for (endpoint, expected) in [
        ("https://api.anthropic.com", "https://api.anthropic.com"),
        ("https://api.anthropic.com/v1/", "https://api.anthropic.com"),
        (
            "https://gateway.test/prefix/v1/",
            "https://gateway.test/prefix",
        ),
    ] {
        let mut service = selected();
        service.endpoint = endpoint.into();
        let delivery = ServiceDelivery::anthropic(&service).unwrap();
        assert_eq!(delivery.base_url, expected);
        assert_eq!(service.endpoint, endpoint);
    }
    for endpoint in [
        "https://gateway.test/prefix",
        "https://gateway.test",
        "https://user:secret@host/v1",
        "https://host/v1?key=secret",
    ] {
        let mut service = selected();
        service.endpoint = endpoint.into();
        assert!(ServiceDelivery::anthropic(&service).is_err());
    }
}
