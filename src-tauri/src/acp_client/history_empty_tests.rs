//! Actual locked SDK/manager with an owned peer, never a real Agent.
use super::{manager::AcpManager, session_index::touch_session_row};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use std::{
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

const PEER: &str = r#"#!/usr/bin/env python3
import json,pathlib,sys,time,os
root=pathlib.Path(__file__).parent
mode=(root/'mode').read_text()
def reply(m,r): print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':r}),flush=True)
def update(kind):
 u={'sessionUpdate':kind}
 if kind=='agent_message_chunk': u['content']={'type':'text','text':'owned body'}
 if kind=='agent_thought_chunk': u['content']={'type':'text','text':'owned thought'}
 if kind=='tool_call': u.update({'toolCallId':'owned-tool','title':'Owned tool','status':'completed'})
 if kind=='available_commands_update': u['availableCommands']=[]
 print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':'owned-empty','update':u}}),flush=True)
for line in sys.stdin:
 m=json.loads(line); method=m.get('method')
 with (root/'trace').open('a') as f: f.write(json.dumps({'method':method})+'\n')
 if method=='initialize': reply(m,{'protocolVersion':1,'agentCapabilities':{'loadSession':True},'authMethods':[]})
 elif method in ('session/new','session/load'):
  if mode=='content': update('agent_message_chunk')
  if mode=='unknown': update('future_history_content')
  if mode=='tool': update('tool_call')
  if mode=='thought': update('agent_thought_chunk')
  if mode=='metadata': update('available_commands_update')
  if mode.startswith('usage'):
   usage={'sessionUpdate':'usage_update','used':0,'contextLimit':1000000,'accumulatedInputTokens':0,'accumulatedOutputTokens':0}
   if mode=='usage-invalid': usage['used']='0'
   if mode=='usage-unknown': usage['future']='owned opaque'
   print(json.dumps({'jsonrpc':'2.0','method':'_goose/unstable/session/update','params':{'sessionId':'owned-empty','update':usage}}),flush=True)
   if mode=='usage':
    print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':'owned-empty','update':{'sessionUpdate':'usage_update','used':0,'size':1000000}}}),flush=True)
  if mode=='permission':
   print(json.dumps({'jsonrpc':'2.0','id':912,'method':'session/request_permission','params':{'sessionId':'owned-empty','toolCall':{'toolCallId':'owned-inquiry','title':'Owned inquiry'},'options':[]}}),flush=True)
  reply(m,{'sessionId':'owned-empty','configOptions':[], '_meta':{'messageCount':0,'historyEmptyConfirmed':True}})
 elif method=='_goose/unstable/session/info':
  (root/'info-started.tmp').write_text('owned exact query started')
  (root/'info-started.tmp').replace(root/'info-started')
  if mode=='late-content': update('agent_message_chunk')
  if mode=='unsupported':
   print(json.dumps({'jsonrpc':'2.0','id':m['id'],'error':{'code':-32601,'message':'not supported'}}),flush=True);continue
  if mode=='hold':
   while not (root/'release').exists(): time.sleep(.01)
  if mode=='lost':
   os.close(1)
   while not (root/'release').exists(): time.sleep(.01)
   break
  s={'sessionId':'wrong' if mode=='wrong-id' else 'owned-empty', 'cwd':'/wrong' if mode=='wrong-cwd' else str(root), '_meta':{'messageCount':1 if mode=='nonzero' else '0' if mode=='string' else 0}}
  if mode=='missing': s['_meta']={}
  reply(m,{'session':s})
 elif method=='session/close': reply(m,{})
 elif method=='session/cancel': pass
 elif 'id' in m: reply(m,{})
"#;

struct Fixture {
    _dir: tempfile::TempDir,
    cwd: PathBuf,
    manager: AcpManager,
    store: MetaStore,
    agent: AgentRow,
    events: Arc<Mutex<Vec<Value>>>,
}
impl Fixture {
    fn new(mode: &str, reviewed: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().canonicalize().unwrap();
        let script = cwd.join("goose");
        // An owned executable with the reviewed argv shape exercises the actual
        // supplement gate. It is not a claim about any installed program.
        std::fs::write(
            &script,
            PEER.replacen(
                "#!/usr/bin/env python3",
                &format!("#!{}", crate::platform_tests::python()),
                1,
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(cwd.join("mode"), mode).unwrap();
        let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
        let agent = AgentRow {
            id: if reviewed {
                "registry:goose"
            } else {
                "custom-peer"
            }
            .into(),
            name: "Owned fixture".into(),
            source: if reviewed { "registry" } else { "custom" }.into(),
            command: script.to_string_lossy().into_owned(),
            args: vec!["acp".into()],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        store.insert_agent(&agent).unwrap();
        touch_session_row(
            &store,
            &agent.id,
            &cwd.to_string_lossy(),
            "owned-empty",
            None,
            Some(json!({"_farfoldConfig":2,"choices":[],"_farfoldService":{"kind":"existing"}})),
        )
        .unwrap();
        Self {
            manager: AcpManager::new(cwd.join("logs"), cwd.clone()),
            _dir: dir,
            cwd,
            store,
            agent,
            events: Default::default(),
        }
    }
    async fn open(&self) -> super::pump::OpenedSession {
        self.try_open().await.unwrap()
    }
    async fn try_open(&self) -> Result<super::pump::OpenedSession, String> {
        let events = self.events.clone();
        self.manager
            .open_session(
                &self.agent,
                &self.cwd,
                Some("owned-empty".into()),
                vec![],
                Arc::new(move |e| events.lock().unwrap().push(e)),
                &self.store,
            )
            .await
    }
    fn queries(&self) -> usize {
        std::fs::read_to_string(self.cwd.join("trace"))
            .unwrap_or_default()
            .lines()
            .filter(|s| {
                serde_json::from_str::<Value>(s).unwrap()["method"]
                    == "_goose/unstable/session/info"
            })
            .count()
    }
    async fn finish(&self) {
        let lives: Vec<_> = self
            .manager
            .lock()
            .unwrap()
            .values()
            .map(|c| c.life.clone())
            .collect();
        self.manager.stop_for_shutdown();
        for life in lives {
            tokio::time::timeout(Duration::from_secs(6), life.closed())
                .await
                .unwrap()
                .unwrap();
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn official_empty_history_is_confirmed_by_exact_read_only_info() {
    for mode in ["empty", "metadata", "usage"] {
        let f = Fixture::new(mode, true);
        let opened = f.open().await;
        let result = (opened.history_empty_confirmed, f.queries());
        let stored = f.store.list_sessions().unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(
            stored[0].config_options,
            Some(json!({"_farfoldConfig":2,"choices":[],"_farfoldService":{"kind":"existing"}}))
        );
        f.finish().await;
        assert_eq!(result, (true, 1), "{mode}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn official_empty_history_unknown_or_conflicting_info_never_confirms() {
    for mode in [
        "unsupported",
        "wrong-id",
        "wrong-cwd",
        "nonzero",
        "string",
        "missing",
        "late-content",
    ] {
        let f = Fixture::new(mode, true);
        let opened = f.open().await;
        let result = (opened.history_empty_confirmed, f.queries());
        f.finish().await;
        assert_eq!(result, (false, 1), "{mode}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn official_empty_history_does_not_query_normal_or_unknown_content_or_unreviewed_peer() {
    for (mode, reviewed) in [
        ("content", true),
        ("unknown", true),
        ("tool", true),
        ("thought", true),
        ("permission", true),
        ("usage-invalid", true),
        ("usage-unknown", true),
        ("usage", false),
        ("empty", false),
    ] {
        let f = Fixture::new(mode, reviewed);
        let opened = f.open().await;
        let result = (opened.history_empty_confirmed, f.queries());
        f.finish().await;
        assert_eq!(result, (false, 0), "{mode}/{reviewed}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn official_empty_history_read_deadline_keeps_original_owner_without_retry() {
    let mode = "hold";
    {
        let f = Fixture::new(mode, true);
        let started = std::time::Instant::now();
        let open = f.open();
        tokio::pin!(open);
        // Initialization and load share the test suite's scheduling pressure;
        // observe the actual query before applying its separate bounded wait.
        tokio::time::timeout(Duration::from_secs(30), async {
            while !f.cwd.join("info-started").exists() {
                tokio::select! {
                    _ = &mut open => panic!("open completed before the owned info request"),
                    _ = tokio::time::sleep(Duration::from_millis(5)) => {}
                }
            }
        })
        .await
        .expect("owned peer must reach its single info request");
        let request_observed_after = started.elapsed();
        let opened = tokio::time::timeout(Duration::from_secs(15), &mut open)
            .await
            .expect("the bounded info observer must return without a peer reply");
        eprintln!(
            "{}",
            json!({"case":"owned-info-deadline", "requestObservedAfterMs":request_observed_after.as_millis(), "returnedAfterMs":started.elapsed().as_millis()})
        );
        assert!(!opened.history_empty_confirmed);
        if mode == "hold" {
            assert!(started.elapsed() >= Duration::from_secs(5));
        }
        let connection = f
            .manager
            .session_connection(&f.agent.id, &f.cwd, "owned-empty")
            .unwrap();
        assert!(
            connection
                .life
                .operation("history-info:owned-empty".into())
                .is_err(),
            "original read remains owned"
        );
        assert_eq!(f.queries(), 1);
        std::fs::write(f.cwd.join("release"), b"owned release").unwrap();
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if connection.life.finished()
                    || connection
                        .life
                        .operation("history-info:owned-empty".into())
                        .is_ok()
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(f.queries(), 1);
        f.finish().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn official_empty_history_local_transport_end_cannot_publish_confirmation() {
    let f = Fixture::new("lost", true);
    let result = tokio::time::timeout(Duration::from_secs(9), f.try_open())
        .await
        .unwrap();
    std::fs::write(f.cwd.join("release"), b"owned release").unwrap();
    assert!(result.is_err());
    assert_eq!(f.queries(), 1);
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn official_empty_history_preview_does_not_query_and_public_flag_has_exact_optional_shape() {
    let f = Fixture::new("empty", true);
    let channel = tauri::ipc::Channel::<Value>::new(|_| Ok(()));
    let mut preview = super::session_discovery::open_import_preview(
        &f.manager,
        &f.store,
        &f.agent,
        &f.cwd,
        "owned-empty".into(),
        "owned-preview".into(),
        "owned-open",
        channel,
        None,
    )
    .await
    .unwrap();
    assert_eq!(f.queries(), 0);
    let before = serde_json::to_value(&preview.session).unwrap();
    assert!(before.get("historyEmptyConfirmed").is_none());
    preview.session.history_empty_confirmed = true;
    let after = serde_json::to_value(&preview.session).unwrap();
    assert_eq!(after["historyEmptyConfirmed"], true);
    assert!(after.get("history_empty_confirmed").is_none());
    f.finish().await;
}
