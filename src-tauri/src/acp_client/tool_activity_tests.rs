//! Tool-tail ownership uses only synthetic protocol peers and temporary storage.
use super::{
    manager::AcpManager,
    pump::{SessionControl, SessionSink},
};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use std::{
    sync::{Arc, atomic::Ordering, mpsc},
    time::Duration,
};

const PEER: &str = r#"
import sys,json
prompt=None
options=[{'id':'mode','name':'Mode','category':'mode','type':'select','currentValue':'agent','options':[{'value':v,'name':v} for v in ['read-only','agent','agent-full-access']]}]
def send(x): print(json.dumps(dict(jsonrpc='2.0',**x)),flush=True)
def tool(id,status=None,kind='tool_call_update'):
 u={'sessionUpdate':kind,'toolCallId':id,'_meta':{'fixture':'unchanged'}}
 if status is not None: u['status']=status
 send({'method':'session/update','params':{'sessionId':'tail','update':u}})
for line in sys.stdin:
 m=json.loads(line); p=m.get('params',{}); method=m.get('method'); result={}
 if method=='initialize': result={'protocolVersion':1,'agentCapabilities':{'loadSession':True},'authMethods':[]}
 elif method in ('session/new','session/load'):
  if method=='session/load': tool('old-history','in_progress','tool_call')
  result=dict(configOptions=options,**({'sessionId':'tail'} if method=='session/new' else {}))
 elif method=='session/prompt':
  text=p['prompt'][0]['text']
  if text=='start':
   tool('a','pending','tool_call');tool('a','pending','tool_call');tool('b','in_progress','tool_call');tool('a')
   prompt=m['id'];continue
  elif text=='unknown': tool('b','future-status')
  elif text=='complete-a': tool('a','completed')
  elif text=='complete-b': tool('b','failed')
  result={'stopReason':'end_turn'}
 elif method=='session/cancel':
  send({'id':prompt,'result':{'stopReason':'cancelled'}});prompt=None
 elif method=='session/set_config_option':
  if p['value']=='read-only': tool('late-history','in_progress','tool_call')
  options[0]['currentValue']=p['value'];result={'configOptions':options}
 if method and 'id' in m: send({'id':m['id'],'result':result})
"#;

struct Stop(Arc<AcpManager>);
impl Drop for Stop {
    fn drop(&mut self) {
        self.0.stop_for_shutdown();
    }
}
fn next(rx: &mpsc::Receiver<Value>, kind: &str) -> Value {
    loop {
        let event = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        if event["kind"] == kind {
            return event;
        }
    }
}
fn fixture(dir: &std::path::Path) -> (MetaStore, Arc<AcpManager>, AgentRow) {
    std::fs::write(dir.join("peer.py"), PEER).unwrap();
    let store = MetaStore::open(&dir.join("meta.db")).unwrap();
    let manager = Arc::new(AcpManager::new(dir.join("logs"), dir.to_path_buf()));
    let row = AgentRow {
        id: "codex".into(),
        name: "Fixture".into(),
        source: "registry".into(),
        command: crate::platform_tests::python(),
        args: vec!["-u".into(), dir.join("peer.py").to_string_lossy().into()],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    };
    store.insert_agent(&row).unwrap();
    (store, manager, row)
}

#[tokio::test(flavor = "multi_thread")]
async fn configuration_change_tool_tail_retains_work_after_stop_without_blocking_later_prompts() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    let (store, manager, row) = fixture(&cwd);
    let _stop = Stop(manager.clone());
    let (tx, rx) = mpsc::channel();
    let sink: SessionSink = Arc::new(move |v| {
        let _ = tx.send(v);
    });
    let opened = manager
        .open_session(&row, &cwd, None, vec![], sink, &store)
        .await
        .unwrap();
    let id = &opened.session_id;
    let blocks = |text: &str| serde_json::from_value(json!([{"type":"text","text":text}])).unwrap();
    manager
        .session_prompt(&row.id, &cwd, id, blocks("start"))
        .await
        .unwrap();
    manager.session_cancel(&row.id, &cwd, id).await.unwrap();
    next(&rx, "turnEnd");
    let connection = manager.session_connection(&row.id, &cwd, id).unwrap();
    assert!(
        connection.life.work.load(Ordering::SeqCst) > 0,
        "tool tail remains active after prompt cancellation"
    );
    assert!(!connection.life.close(false, Some(Duration::ZERO)).unwrap());
    assert!(connection.life.operation("account_change".into()).is_err());
    let row_id = super::session_index::session_row_id(&row.id, &cwd.to_string_lossy(), id);
    assert!(
        manager
            .archive_session(&store, row_id.clone(), true)
            .await
            .is_err()
    );
    assert!(
        manager
            .session_set_config(&row.id, &cwd, id, "mode", json!("agent"))
            .await
            .is_err()
    );
    let control = connection
        .sessions
        .lock()
        .unwrap()
        .get(id)
        .unwrap()
        .control
        .clone();
    for variant in 0..3 {
        let (result, receive) = tokio::sync::oneshot::channel();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        control
            .send(match variant {
                0 => SessionControl::Detach { deadline, result },
                1 => SessionControl::Close {
                    deadline,
                    result,
                    require_idle_interactions: false,
                },
                _ => SessionControl::Delete { deadline, result },
            })
            .unwrap();
        assert!(
            receive.await.unwrap().is_err(),
            "tool tail must block destructive control {variant}"
        );
    }
    for text in ["unknown", "complete-a"] {
        manager
            .session_prompt(&row.id, &cwd, id, blocks(text))
            .await
            .unwrap();
        next(&rx, "turnEnd");
        assert!(connection.life.work.load(Ordering::SeqCst) > 0);
    }
    manager
        .session_prompt(&row.id, &cwd, id, blocks("complete-b"))
        .await
        .unwrap();
    next(&rx, "turnEnd");
    assert_eq!(connection.life.work.load(Ordering::SeqCst), 0);
    manager
        .session_set_config(&row.id, &cwd, id, "mode", json!("agent"))
        .await
        .unwrap();
    assert!(manager.archive_session(&store, row_id, true).await.is_ok());
    manager.close_session(&row.id, &cwd, id).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn tool_activity_does_not_count_cold_or_delayed_replay_as_new_work() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    let (store, manager, row) = fixture(&cwd);
    super::session_index::touch_session_row(
        &store,
        &row.id,
        &cwd.to_string_lossy(),
        "tail",
        None,
        Some(json!({"_farfoldConfig":1,"model":null,"thoughtLevel":null})),
    )
    .unwrap();
    let _stop = Stop(manager.clone());
    let (tx, rx) = mpsc::channel();
    let sink: SessionSink = Arc::new(move |v| {
        let _ = tx.send(v);
    });
    let opened = manager
        .open_session(&row, &cwd, Some("tail".into()), vec![], sink, &store)
        .await
        .unwrap();
    let initial = next(&rx, "toolActivity");
    assert_eq!(initial["toolCallIds"], json!([]));
    let connection = manager
        .session_connection(&row.id, &cwd, &opened.session_id)
        .unwrap();
    assert_eq!(connection.life.work.load(Ordering::SeqCst), 0);
    // This response sends another historical pending tool after open's prefix.
    manager
        .session_set_config(
            &row.id,
            &cwd,
            &opened.session_id,
            "mode",
            json!("read-only"),
        )
        .await
        .unwrap();
    assert_eq!(connection.life.work.load(Ordering::SeqCst), 0);
    assert!(rx.try_iter().all(|event| event["kind"] != "toolActivity"));
    manager
        .close_session(&row.id, &cwd, &opened.session_id)
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn tool_activity_is_released_only_with_real_process_termination() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    let (store, manager, row) = fixture(&cwd);
    let _stop = Stop(manager.clone());
    let (tx, rx) = mpsc::channel();
    let sink: SessionSink = Arc::new(move |v| {
        let _ = tx.send(v);
    });
    let opened = manager
        .open_session(&row, &cwd, None, vec![], sink, &store)
        .await
        .unwrap();
    let blocks = serde_json::from_value(json!([{"type":"text","text":"start"}])).unwrap();
    manager
        .session_prompt(&row.id, &cwd, &opened.session_id, blocks)
        .await
        .unwrap();
    manager
        .session_cancel(&row.id, &cwd, &opened.session_id)
        .await
        .unwrap();
    next(&rx, "turnEnd");
    let connection = manager
        .session_connection(&row.id, &cwd, &opened.session_id)
        .unwrap();
    assert!(connection.life.work.load(Ordering::SeqCst) > 0);
    manager.stop_for_shutdown();
    let ended = next(&rx, "toolActivity");
    assert_eq!(ended["toolCallIds"], json!([]));
    assert_eq!(ended["reason"], "process_ended");
    next(&rx, "connectionLost");
    connection.life.closed().await.unwrap();
    assert_eq!(connection.life.work.load(Ordering::SeqCst), 0);
}
