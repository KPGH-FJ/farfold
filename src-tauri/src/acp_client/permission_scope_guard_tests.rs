//! Actual local JSON-RPC pump with synthetic data; no installed Agent/account.
use super::{manager::AcpManager, pump::SessionSink, transient_mcp::*};
use crate::meta_store::{AgentRow, MetaStore};
use agent_client_protocol::schema::v1::{ContentBlock, McpServerStdio};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, atomic::Ordering, mpsc},
    time::Duration,
};

const PEER: &str = r#"
import sys,json,os
root=os.path.dirname(os.path.realpath(__file__));pending=None
options=[{'id':'mode','name':'Mode','category':'mode','type':'select','currentValue':'agent','options':[{'value':v,'name':v} for v in ['read-only','agent','agent-full-access']]}]
def send(v): print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
for line in sys.stdin:
 m=json.loads(line);p=m.get('params',{});method=m.get('method');result={}
 if method=='initialize':result={'protocolVersion':1,'agentCapabilities':{'loadSession':True,'promptCapabilities':{'embeddedContext':True}},'authMethods':[]}
 elif method in ('session/new','session/load'):
  options[0]['currentValue']='agent';result={'configOptions':options}
  if method=='session/new':result['sessionId']='scope-'+str(os.getpid())
 elif method=='session/set_config_option':options[0]['currentValue']=p['value'];result={'configOptions':options}
 elif method=='session/prompt':
  with open(root+'/prompts.jsonl','a') as f:f.write(json.dumps(p)+'\n')
  if p['prompt'][0].get('text')=='wait':pending=m;continue
  result={'stopReason':'end_turn'}
 elif method=='session/cancel':
  if pending:send({'id':pending['id'],'result':{'stopReason':'cancelled'}});pending=None
  continue
 if 'id' in m:send({'id':m['id'],'result':result})
"#;

#[derive(Default)]
struct Owner(Mutex<Vec<bool>>);
impl SessionMcpOwner for Owner {
    fn fork_admissible(&self) -> bool {
        true
    }
    fn bind_session(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn set_prompt_active(&self, active: bool) {
        self.0.lock().unwrap().push(active);
    }
    fn revoke(&self) {}
}
struct Fixture {
    _dir: tempfile::TempDir,
    cwd: PathBuf,
    store: MetaStore,
    manager: Arc<AcpManager>,
    row: AgentRow,
    owner: Arc<Owner>,
    sink: SessionSink,
    events: mpsc::Receiver<Value>,
}
impl Fixture {
    fn new(verified: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().canonicalize().unwrap();
        let script = crate::platform_tests::python_peer(&cwd, "codex-acp", PEER);
        let row = AgentRow {
            id: if verified { "codex" } else { "scope-custom" }.into(),
            name: "Controlled peer".into(),
            source: if verified { "registry" } else { "custom" }.into(),
            command: script.to_string_lossy().into(),
            args: vec![],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        let store = MetaStore::open(&cwd.join("metadata.sqlite3")).unwrap();
        store.insert_agent(&row).unwrap();
        let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
        let (tx, events) = mpsc::channel();
        let sink: SessionSink = Arc::new(move |v| {
            let _ = tx.send(v);
        });
        Self {
            _dir: dir,
            cwd,
            store,
            manager,
            row,
            owner: Arc::default(),
            sink,
            events,
        }
    }
    async fn open(&self, id: Option<String>) -> super::pump::OpenedSession {
        self.manager
            .connect(&self.row, &self.cwd, &self.store)
            .await
            .unwrap();
        self.manager
            .open_session_selected_with_mcp(
                &self.row,
                &self.cwd,
                id,
                vec![],
                self.sink.clone(),
                &self.store,
                None,
                Some(TransientMcpOpen::new(
                    McpServerStdio::new("controlled-page", "/controlled/page"),
                    self.owner.clone(),
                )),
                None,
            )
            .await
            .unwrap()
    }
    fn end(&self) {
        loop {
            if self.events.recv_timeout(Duration::from_secs(5)).unwrap()["kind"] == "turnEnd" {
                return;
            }
        }
    }
    fn prompts(&self) -> Vec<Value> {
        std::fs::read_to_string(self.cwd.join("prompts.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}
fn blocks(text: &str) -> Vec<ContentBlock> {
    serde_json::from_value(json!([{"type":"text","text":text}])).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn permission_scope_actual_pump_rejects_before_work_save_and_mcp_and_never_promotes() {
    let f = Fixture::new(true);
    let opened = f.open(None).await;
    let c = f
        .manager
        .session_connection(&f.row.id, &f.cwd, &opened.session_id)
        .unwrap();
    let activity = c.life.operation("account_change".into()).unwrap();
    let sql = rusqlite::Connection::open(f.cwd.join("metadata.sqlite3")).unwrap();
    sql.execute_batch("CREATE TRIGGER deny_insert BEFORE INSERT ON sessions BEGIN SELECT RAISE(FAIL, 'unexpected source save'); END; CREATE TRIGGER deny_update BEFORE UPDATE ON sessions BEGIN SELECT RAISE(FAIL, 'unexpected source save'); END;").unwrap();
    for text in [
        "/review",
        "\u{feff} /ReViEw",
        "/review\u{feff}foo",
        "/review\u{a0}foo",
        "/review\u{2028}foo",
        "/review-branch main",
        "/review-commit abc",
        "/compact extra",
        "/goal RESUME",
        "/goal objective",
        "/goal PaUsE\u{85}",
    ] {
        let result = f
            .manager
            .session_prompt(&f.row.id, &f.cwd, &opened.session_id, blocks(text))
            .await;
        assert_eq!(
            result,
            Err("FAILED: PROMPT_PERMISSION_SCOPE_UNVERIFIED".into()),
            "{text:?}"
        );
    }
    assert!(f.prompts().is_empty());
    assert!(f.owner.0.lock().unwrap().is_empty());
    assert_eq!(c.life.work.load(Ordering::SeqCst), 0);
    drop(activity);
    // A separate save-denying control prevents the work barrier from hiding a
    // mistakenly attempted source/configuration write before rejection.
    assert_eq!(
        f.manager
            .session_prompt(&f.row.id, &f.cwd, &opened.session_id, blocks("/review"))
            .await,
        Err("FAILED: PROMPT_PERMISSION_SCOPE_UNVERIFIED".into())
    );
    sql.execute_batch("DROP TRIGGER deny_insert; DROP TRIGGER deny_update;")
        .unwrap();
    for text in [
        "ordinary",
        "/goal PaUsE",
        "/goal CLEAR",
        "/goal",
        "/review\u{85}foo",
    ] {
        f.manager
            .session_prompt(&f.row.id, &f.cwd, &opened.session_id, blocks(text))
            .await
            .unwrap();
        f.end();
    }
    let options = f
        .manager
        .session_set_config(
            &f.row.id,
            &f.cwd,
            &opened.session_id,
            "mode",
            json!("read-only"),
        )
        .await
        .unwrap();
    assert_eq!(options["permissionState"], "ready");
    assert_eq!(
        options["permissionEffect"],
        json!({"configId":"mode","appliesAt":"next_ordinary_prompt","currentScope":"unknown"})
    );
    assert_eq!(
        f.manager
            .session_prompt(&f.row.id, &f.cwd, &opened.session_id, blocks("/review"))
            .await,
        Err("FAILED: PROMPT_PERMISSION_SCOPE_UNVERIFIED".into())
    );
    assert_eq!(f.prompts().len(), 5);
    // These control calls retain their existing route; scope safety must not block cancellation.
    f.manager
        .session_prompt(&f.row.id, &f.cwd, &opened.session_id, blocks("wait"))
        .await
        .unwrap();
    f.manager
        .session_cancel(&f.row.id, &f.cwd, &opened.session_id)
        .await
        .unwrap();
    f.end();
    assert_eq!(f.prompts().len(), 6);
}

#[tokio::test(flavor = "multi_thread")]
async fn permission_scope_custom_agent_and_first_resource_keep_original_forwarding() {
    let custom = Fixture::new(false);
    let opened = custom.open(None).await;
    custom
        .manager
        .session_prompt(
            &custom.row.id,
            &custom.cwd,
            &opened.session_id,
            blocks("/review"),
        )
        .await
        .unwrap();
    custom.end();
    assert_eq!(custom.prompts().len(), 1);
    let f = Fixture::new(true);
    let opened = f.open(None).await;
    let first:Vec<ContentBlock>=serde_json::from_value(json!([{"type":"resource","resource":{"uri":"farfold-context:fixture","mimeType":"text/plain","text":"/review"}},{"type":"text","text":"/review"}])).unwrap();
    f.manager
        .session_prompt(&f.row.id, &f.cwd, &opened.session_id, first.clone())
        .await
        .unwrap();
    f.end();
    assert_eq!(
        f.prompts()[0]["prompt"],
        serde_json::to_value(first).unwrap()
    );
    let second: Vec<ContentBlock> = serde_json::from_value(
        json!([{"type":"text","text":"ordinary"},{"type":"text","text":"/review"}]),
    )
    .unwrap();
    f.manager
        .session_prompt(&f.row.id, &f.cwd, &opened.session_id, second.clone())
        .await
        .unwrap();
    f.end();
    assert_eq!(
        f.prompts()[1]["prompt"],
        serde_json::to_value(second).unwrap()
    );
}
