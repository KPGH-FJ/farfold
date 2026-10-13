//! Deterministic metadata-save/inbox ordering with an owned JSON-RPC peer.
//! No sleeps as ordering evidence, real Agent, account, or user database.
use super::{manager::AcpManager, pump::SessionSink, session_index::session_row_id};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use std::{
    future::{Future, poll_fn},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, atomic::Ordering},
    task::Poll,
    time::Duration,
};

const SESSION: &str = "prompt-save-race";
const PEER: &str = r#"
import sys,json,pathlib,threading,time
root=pathlib.Path(__file__).resolve().parent
output_lock=threading.Lock()
options=[
 {'id':'model','name':'Model','category':'model','type':'select','currentValue':'m1','options':[{'value':v,'name':v} for v in ['m1','m2']]},
 {'id':'mode','name':'Mode','category':'mode','type':'select','currentValue':'agent','options':[{'value':v,'name':v} for v in ['read-only','agent','agent-full-access']]}]
def send(v):
 with output_lock: print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def update_when_released():
 until=time.monotonic()+15
 while not (root/'fire-update').exists():
  assert time.monotonic()<until, 'fixture update trigger missing'
  time.sleep(.005)
 change=(root/'fire-update').read_text()
 if change=='model': options[0]['currentValue']='m2'
 if change=='permission': options[1]['currentValue']='agent-full-access'
 send({'method':'session/update','params':{'sessionId':'prompt-save-race','update':{'sessionUpdate':'config_option_update','configOptions':options}}})
 # The independent incoming actor must route the prior update before replying
 # to this unscoped request. stdout.flush alone would not establish that fence.
 send({'id':900,'method':'fixture/inbox_fence','params':{}})
for line in sys.stdin:
 m=json.loads(line);method=m.get('method');p=m.get('params',{});result={}
 if method=='initialize': result={'protocolVersion':1,'agentCapabilities':{},'authMethods':[]}
 elif method=='session/new':
  result={'sessionId':'prompt-save-race','configOptions':options}
  threading.Thread(target=update_when_released,daemon=True).start()
 elif method=='session/prompt':
  with (root/'prompts.jsonl').open('a') as f:f.write(json.dumps(p)+'\n')
  result={'stopReason':'end_turn'}
 elif method is None and m.get('id')==900:
  assert m.get('error',{}).get('code')==-32601,m
  ready=root/'inbox-ready.tmp';ready.write_text('prior-update-routed');ready.replace(root/'inbox-ready')
  continue
 if 'id' in m and method is not None:send({'id':m['id'],'result':result})
"#;

async fn until(message: &str, mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect(message);
}

fn prompts(root: &Path) -> Vec<Value> {
    std::fs::read_to_string(root.join("prompts.jsonl"))
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

struct Fixture {
    manager: Arc<AcpManager>,
    store: MetaStore,
    row: AgentRow,
    cwd: PathBuf,
    events: Arc<Mutex<Vec<Value>>>,
    _dir: tempfile::TempDir,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}
impl Fixture {
    async fn open() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().canonicalize().unwrap();
        let script = crate::platform_tests::python_peer(&cwd, "codex-acp", PEER);
        let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
        let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
        // The registered identity exercises its existing verified mode shape;
        // this executable remains a synthetic local peer, never installed Codex.
        let row = AgentRow {
            id: "codex".into(),
            name: "Controlled prompt peer".into(),
            source: "registry".into(),
            command: script.to_string_lossy().into(),
            args: vec![],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        store.insert_agent(&row).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let sink: SessionSink = Arc::new(move |v| captured.lock().unwrap().push(v));
        let opened = manager
            .open_session(&row, &cwd, None, vec![], sink, &store)
            .await
            .unwrap();
        assert_eq!(opened.session_id, SESSION);
        assert_eq!(opened.permission_state, "ready");
        assert_eq!(opened.config_check.status, "ready");
        Self {
            manager,
            store,
            row,
            cwd,
            events,
            _dir: dir,
        }
    }
    async fn end(&self) {
        until("bounded prompt completion", || {
            self.events
                .lock()
                .unwrap()
                .iter()
                .any(|v| v["kind"] == "turnEnd")
        })
        .await;
    }
}

async fn check_prompt_save_race(change: &str, established: bool) {
    let f = Fixture::open().await;
    let blocks =
        || serde_json::from_value(json!([{"type":"text","text":"controlled message"}])).unwrap();
    if established {
        f.manager
            .session_prompt(&f.row.id, &f.cwd, SESSION, blocks())
            .await
            .unwrap();
        f.end().await;
    }
    f.events.lock().unwrap().clear();
    let baseline_prompts = usize::from(established);
    let connection = f
        .manager
        .session_connection(&f.row.id, &f.cwd, SESSION)
        .unwrap();
    assert_eq!(connection.life.work.load(Ordering::SeqCst), 0);
    let database = rusqlite::Connection::open(f.cwd.join("meta.db")).unwrap();
    database.execute_batch("BEGIN IMMEDIATE").unwrap();
    let mut prompt = std::pin::pin!(
        f.manager
            .session_prompt(&f.row.id, &f.cwd, SESSION, blocks())
    );
    // First poll enqueues the exact product request before observing its lease.
    poll_fn(|cx| {
        assert!(matches!(prompt.as_mut().poll(cx), Poll::Pending));
        Poll::Ready(())
    })
    .await;
    until("pump entered prompt before blocked metadata save", || {
        connection.life.work.load(Ordering::SeqCst) == 1
    })
    .await;
    assert_eq!(prompts(&f.cwd).len(), baseline_prompts);
    std::fs::write(f.cwd.join("fire-update"), change).unwrap();
    until("incoming actor routed update while save is held", || {
        std::fs::read_to_string(f.cwd.join("inbox-ready")).is_ok_and(|v| v == "prior-update-routed")
    })
    .await;
    assert!(
        f.events
            .lock()
            .unwrap()
            .iter()
            .all(|v| v.get("update").is_none()),
        "update is queued, not yet consumed by the blocked pump"
    );
    database.execute_batch("ROLLBACK").unwrap();
    let result = prompt.await;
    if result.is_ok() {
        f.end().await;
    }
    let actual_prompts = prompts(&f.cwd).len();
    println!(
        "{}",
        json!({"case":change,"established":established,"inboxFence":"prior-update-routed","result":result,"baselinePrompts":baseline_prompts,"actualPrompts":actual_prompts})
    );
    let expected = match change {
        "model" => Err("FAILED: CONFIG_BLOCKED".to_owned()),
        "permission" => Err("FAILED: 请重新确认权限后再发送".to_owned()),
        "matching" => Ok(()),
        _ => unreachable!(),
    };
    assert_eq!(
        result, expected,
        "queued drift must be checked before ACP prompt admission"
    );
    assert_eq!(
        actual_prompts,
        baseline_prompts + usize::from(change == "matching")
    );
    if change == "model" && !established {
        let check_after_refusal = f
            .events
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|v| v["kind"] == "configCheck")
            .unwrap()["check"]
            .clone();
        let repeated = f
            .manager
            .session_prompt(&f.row.id, &f.cwd, SESSION, blocks())
            .await;
        if repeated.is_ok() {
            f.end().await;
        }
        let saved = f
            .store
            .get_session(&session_row_id(
                &f.row.id,
                &f.cwd.to_string_lossy(),
                SESSION,
            ))
            .unwrap()
            .unwrap()
            .config_options
            .unwrap();
        println!(
            "{}",
            json!({"case":"first-model-immediate-retry", "checkAfterRefusal":check_after_refusal,
                "retryResult":repeated,"actualPrompts":prompts(&f.cwd).len(),"saved":saved})
        );
        assert_eq!(check_after_refusal["status"], "blocked");
        assert_eq!(repeated, Err("FAILED: CONFIG_BLOCKED".to_owned()));
        assert_eq!(prompts(&f.cwd).len(), 0);
        assert_eq!(saved["choices"][0]["value"], "m1");
    }
    let row = f
        .store
        .get_session(&session_row_id(
            &f.row.id,
            &f.cwd.to_string_lossy(),
            SESSION,
        ))
        .unwrap()
        .unwrap();
    assert_eq!(
        row.config_options.unwrap()["choices"][0]["value"],
        "m1",
        "a refused drift cannot replace the saved selection"
    );
    assert_eq!(connection.life.work.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn prompt_config_race_established_model_update_during_save_is_not_sent() {
    check_prompt_save_race("model", true).await;
}
#[tokio::test(flavor = "multi_thread")]
async fn prompt_config_race_permission_update_during_save_is_not_sent() {
    check_prompt_save_race("permission", true).await;
}
#[tokio::test(flavor = "multi_thread")]
async fn prompt_config_race_first_model_update_during_save_is_not_sent() {
    check_prompt_save_race("model", false).await;
}
#[tokio::test(flavor = "multi_thread")]
async fn prompt_config_race_matching_update_keeps_ordinary_prompt_working() {
    check_prompt_save_race("matching", true).await;
}
#[tokio::test(flavor = "multi_thread")]
async fn prompt_config_race_matching_update_keeps_first_prompt_working() {
    check_prompt_save_race("matching", false).await;
}
