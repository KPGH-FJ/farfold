//! Actual manager -> queue -> pump -> subprocess ACP requests, with a controlled
//! JSON-RPC peer. No official Agent, model, account, browser or MCP server runs.
use super::transient_mcp::{SessionMcpOwner, TransientMcpOpen, safe_open_error};
use super::{manager::AcpManager, pump::OpenedSession};
use crate::meta_store::{AgentRow, MetaStore};
use agent_client_protocol::schema::v1::{EnvVariable, McpServerStdio};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

const SYNTHETIC_CAP: &str = "synthetic-transient-acp-fixture-permission";

// The peer emits only sanitized request-shape receipts. Error mode intentionally
// echoes the synthetic credential on the ACP wire to exercise host redaction;
// assertions must never print that credential or a full request/error value.
const PEER: &str = r#"
import sys,json,os,time
mode,root=sys.argv[1:3]
counter=0
def send(v): print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def reply(m,r): send({'id':m['id'],'result':r})
for line in sys.stdin:
 m=json.loads(line); p=m.get('params',{}); method=m.get('method')
 if method=='initialize':
  reply(m,{'protocolVersion':1,'agentCapabilities':{'loadSession':True,'sessionCapabilities':{'close':{}}},'authMethods':[]})
 elif method in ('session/new','session/load'):
  servers=p.get('mcpServers',[])
  server=servers[0] if len(servers)==1 else {}
  env=server.get('env',[])
  actual=env[0].get('value','') if len(env)==1 else ''
  proof={
   'method':method,
   'cwdMatches':p.get('cwd')==root,
   'oneServer':len(servers)==1,
   'standardFields':set(server)=={'name','command','args','env'},
   'nameMatches':server.get('name')=='farfold-controlled-page',
   'commandMatches':server.get('command')=='/controlled/browser-helper',
   'argsMatch':server.get('args')==['--controlled-stdio'],
   'environmentMatches':len(env)==1 and env[0].get('name')=='FARFOLD_CONTROLLED_CAP' and actual=='synthetic-transient-acp-fixture-permission',
   'sessionIdMatches':('sessionId' not in p) if method=='session/new' else p.get('sessionId')=='restore-controlled'
  }
  with open(os.path.join(root,'request-receipt.json'),'w') as f: json.dump(proof,f)
  if mode=='delayed':
   with open(os.path.join(root,'request-entered'),'w') as f: f.write('entered')
   while not os.path.exists(os.path.join(root,'release-reply')): time.sleep(.005)
  if mode=='reject':
   send({'id':m['id'],'error':{'code':-32603,'message':actual,'data':{'echo':actual}}})
  else:
   counter+=1
   result={'configOptions':[],'farfoldFutureExtension':{'nested':['preserved',{'number':7}]},'farfoldRequestProof':proof}
   if method=='session/new': result['sessionId']='controlled-new-'+str(counter)
   reply(m,result)
 elif method=='session/close': reply(m,{})
 elif 'id' in m: send({'id':m['id'],'error':{'code':-32601,'message':'controlled unsupported request'}})
"#;

#[derive(Default)]
struct OwnerWitness {
    bound: Mutex<Vec<String>>,
    revoked: AtomicUsize,
}
impl SessionMcpOwner for OwnerWitness {
    fn bind_session(&self, id: &str) -> Result<(), String> {
        self.bound.lock().unwrap().push(id.into());
        Ok(())
    }
    fn revoke(&self) {
        self.revoked.fetch_add(1, Ordering::AcqRel);
    }
}

fn offer(owner: Arc<OwnerWitness>) -> TransientMcpOpen {
    TransientMcpOpen::new(
        McpServerStdio::new("farfold-controlled-page", "/controlled/browser-helper")
            .args(vec!["--controlled-stdio".into()])
            .env(vec![EnvVariable::new(
                "FARFOLD_CONTROLLED_CAP",
                SYNTHETIC_CAP,
            )]),
        owner,
    )
}

struct Fixture {
    _dir: tempfile::TempDir,
    cwd: PathBuf,
    store: MetaStore,
    manager: Arc<AcpManager>,
    row: AgentRow,
}
impl Fixture {
    fn new(mode: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().canonicalize().unwrap();
        let script = cwd.join("controlled-peer.py");
        std::fs::write(&script, PEER).unwrap();
        let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
        let row = AgentRow {
            id: "transient-mcp-controlled-peer".into(),
            name: "Controlled peer".into(),
            source: "custom".into(),
            command: "/usr/bin/python3".into(),
            args: vec![
                "-u".into(),
                script.to_string_lossy().into(),
                mode.into(),
                cwd.to_string_lossy().into(),
            ],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        store.insert_agent(&row).unwrap();
        let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
        Self {
            _dir: dir,
            cwd,
            store,
            manager,
            row,
        }
    }

    async fn open(
        &self,
        native: Option<&str>,
        owner: Arc<OwnerWitness>,
    ) -> Result<OpenedSession, String> {
        self.manager
            .open_session_selected_with_mcp(
                &self.row,
                &self.cwd,
                native.map(str::to_owned),
                vec![],
                Arc::new(|_| {}),
                &self.store,
                None,
                Some(offer(owner)),
            )
            .await
    }

    fn receipt(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.cwd.join("request-receipt.json")).unwrap())
            .unwrap()
    }

    async fn finish(&self) {
        let pid = self
            .manager
            .live_connection(&self.row.id, &self.cwd)
            .unwrap()
            .child_pid
            .load(Ordering::SeqCst);
        self.manager
            .disconnect(&self.row.id, &self.cwd)
            .await
            .unwrap();
        assert!(
            pid != 0 && unsafe { libc::kill(pid as i32, 0) } != 0,
            "the exact controlled peer must be reaped before fixture removal"
        );
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}

async fn until(mut predicate: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !predicate() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("controlled peer did not reach the expected lifecycle point");
}

fn check_receipt(proof: &Value, method: &str) {
    assert_eq!(proof.get("method").and_then(Value::as_str), Some(method));
    for key in [
        "cwdMatches",
        "oneServer",
        "standardFields",
        "nameMatches",
        "commandMatches",
        "argsMatch",
        "environmentMatches",
        "sessionIdMatches",
    ] {
        assert!(
            proof.get(key).and_then(Value::as_bool) == Some(true),
            "controlled peer rejected request-shape field {key}"
        );
    }
}

async fn actual_request(resumed: bool) {
    let f = Fixture::new("ok");
    let owner = Arc::new(OwnerWitness::default());
    let opened = f
        .open(resumed.then_some("restore-controlled"), owner.clone())
        .await
        .unwrap();
    let method = if resumed {
        "session/load"
    } else {
        "session/new"
    };
    check_receipt(&f.receipt(), method);
    check_receipt(&opened.response["farfoldRequestProof"], method);
    assert_eq!(
        opened.response["farfoldFutureExtension"],
        json!({"nested":["preserved",{"number":7}]})
    );
    assert_eq!(*owner.bound.lock().unwrap(), [opened.session_id.clone()]);
    assert_eq!(owner.revoked.load(Ordering::Acquire), 0);
    f.manager
        .close_session(&f.row.id, &f.cwd, &opened.session_id)
        .await
        .unwrap();
    assert_eq!(owner.revoked.load(Ordering::Acquire), 1);
    f.finish().await;
    assert_eq!(owner.revoked.load(Ordering::Acquire), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn transient_mcp_real_new_request_keeps_standard_fields_and_unknown_response() {
    actual_request(false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn transient_mcp_real_load_request_keeps_standard_fields_and_unknown_response() {
    actual_request(true).await;
}

async fn rejected_request(resumed: bool) {
    let f = Fixture::new("reject");
    let owner = Arc::new(OwnerWitness::default());
    let error = f
        .open(resumed.then_some("restore-controlled"), owner.clone())
        .await
        .err()
        .expect("the controlled peer must reject this request");
    check_receipt(
        &f.receipt(),
        if resumed {
            "session/load"
        } else {
            "session/new"
        },
    );
    assert!(
        !error.contains(SYNTHETIC_CAP),
        "remote permission credential must not reach the error result"
    );
    assert!(
        error == safe_open_error(),
        "MCP opening must return the fixed safe error"
    );
    assert!(owner.bound.lock().unwrap().is_empty());
    assert_eq!(owner.revoked.load(Ordering::Acquire), 1);
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn transient_mcp_real_new_failure_does_not_echo_permission_credential() {
    rejected_request(false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn transient_mcp_real_load_failure_does_not_echo_permission_credential() {
    rejected_request(true).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn transient_mcp_two_real_routes_close_and_connection_drop_revoke_independently() {
    let f = Fixture::new("ok");
    let one = Arc::new(OwnerWitness::default());
    let two = Arc::new(OwnerWitness::default());
    let first = f.open(None, one.clone()).await.unwrap();
    let second = f.open(None, two.clone()).await.unwrap();
    assert_ne!(first.session_id, second.session_id);
    f.manager
        .close_session(&f.row.id, &f.cwd, &first.session_id)
        .await
        .unwrap();
    assert_eq!(one.revoked.load(Ordering::Acquire), 1);
    assert_eq!(two.revoked.load(Ordering::Acquire), 0);
    assert!(
        f.manager
            .session_owner(&f.row.id, &f.cwd, &second.session_id)
            .unwrap()
            .is_some()
    );
    f.finish().await;
    assert_eq!(one.revoked.load(Ordering::Acquire), 1);
    assert_eq!(two.revoked.load(Ordering::Acquire), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn transient_mcp_abandoned_real_open_revokes_after_late_reply_cleanup() {
    let f = Fixture::new("delayed");
    let owner = Arc::new(OwnerWitness::default());
    let mut opening = Box::pin(f.open(None, owner.clone()));
    tokio::select! {
        _ = until(|| f.cwd.join("request-entered").exists()) => {},
        _ = &mut opening => panic!("controlled opening completed before the peer release"),
    }
    check_receipt(&f.receipt(), "session/new");
    drop(opening);
    std::fs::write(f.cwd.join("release-reply"), "release").unwrap();
    until(|| owner.revoked.load(Ordering::Acquire) == 1).await;
    let connection = f.manager.live_connection(&f.row.id, &f.cwd).unwrap();
    assert!(
        connection.sessions.lock().unwrap().is_empty(),
        "late reply left an orphan route"
    );
    f.finish().await;
    assert_eq!(owner.revoked.load(Ordering::Acquire), 1);
}
