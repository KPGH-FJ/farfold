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

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn external_peer_exit_emits_ordered_receipts_for_its_owner_only() {
    use super::{lifecycle::CloseReason, pump::ProcessEndedReceipt};

    const SELF_EXIT: &str = r#"
import os, pathlib, threading, time
def exit_after_fence():
    fence = pathlib.Path.cwd() / 'fixture-exit'
    while not fence.is_file():
        time.sleep(0.01)
    os._exit(0)
threading.Thread(target=exit_after_fence, daemon=True).start()
"#;

    enum Observation {
        Raw(Value),
        Ended(ProcessEndedReceipt, bool),
    }

    tokio::time::timeout(Duration::from_secs(15), async {
        let root = tempfile::tempdir().unwrap();
        let root_path = root.path().canonicalize().unwrap();
        let target_cwd = root_path.join("target");
        let sibling_cwd = root_path.join("sibling");
        std::fs::create_dir(&target_cwd).unwrap();
        std::fs::create_dir(&sibling_cwd).unwrap();
        let (store, manager, row) = fixture(&root_path);
        let _stop = Stop(manager.clone());
        std::fs::write(root_path.join("peer.py"), format!("{SELF_EXIT}{PEER}")).unwrap();
        let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
        let mut owners = Vec::new();
        for (scope, cwd) in [("target", &target_cwd), ("sibling", &sibling_cwd)] {
            let events = send.clone();
            let sink: SessionSink = Arc::new(move |event| {
                let _ = events.send((scope, Observation::Raw(event)));
            });
            let opened = manager
                .open_session(&row, cwd, None, vec![], sink, &store)
                .await
                .unwrap();
            let owner = manager
                .session_connection(&row.id, cwd, &opened.session_id)
                .unwrap();
            let pid = owner.child_pid.load(Ordering::SeqCst);
            assert_ne!(pid, 0);
            let receipts = send.clone();
            owner
                .sessions
                .lock()
                .unwrap()
                .get_mut(&opened.session_id)
                .unwrap()
                .observe_process_end(
                    &opened.connection_id,
                    Arc::new(move |receipt| {
                        let group_alive = crate::supervisor::owned_group_alive(pid);
                        let _ = receipts.send((scope, Observation::Ended(receipt, group_alive)));
                    }),
                )
                .unwrap();
            owners.push((opened, owner, pid));
        }
        let [
            (opened, target, target_pid),
            (sibling_open, sibling, sibling_pid),
        ] = owners.as_slice()
        else {
            unreachable!()
        };
        assert_ne!(opened.connection_id, sibling_open.connection_id);
        assert_ne!(target_pid, sibling_pid);

        let blocks = serde_json::from_value(json!([{"type":"text","text":"start"}])).unwrap();
        manager
            .session_prompt(&row.id, &target_cwd, &opened.session_id, blocks)
            .await
            .unwrap();
        manager
            .session_cancel(&row.id, &target_cwd, &opened.session_id)
            .await
            .unwrap();
        let mut active_tool_observed = false;
        loop {
            let (scope, observation) = receive.recv().await.unwrap();
            let Observation::Raw(event) = observation else {
                panic!("received a process receipt before the child exit trigger");
            };
            assert_ne!(event["kind"], "connectionLost");
            assert_ne!(event["reason"], "process_ended");
            if scope != "target" {
                continue;
            }
            assert!(!matches!(
                event.pointer("/update/status").and_then(Value::as_str),
                Some("completed" | "failed")
            ));
            if event["kind"] == "toolActivity" && event["toolCallIds"] == json!(["a", "b"]) {
                active_tool_observed = true;
            }
            if event["kind"] == "turnEnd" {
                assert_eq!(event["stopReason"], "cancelled");
                break;
            }
        }
        assert!(active_tool_observed);
        assert!(target.life.work.load(Ordering::SeqCst) > 0);
        assert!(crate::supervisor::owned_group_alive(*target_pid));

        // Only the temporary peer reads this fence and exits itself. Farfold
        // learns about it through its ordinary transport and process observers.
        std::fs::write(target_cwd.join("fixture-exit"), b"exit normally").unwrap();
        let mut ordered = Vec::new();
        loop {
            let (scope, observation) = receive.recv().await.unwrap();
            match observation {
                Observation::Raw(event) => {
                    assert!(!matches!(
                        event.pointer("/update/status").and_then(Value::as_str),
                        Some("completed" | "failed")
                    ));
                    match event["kind"].as_str() {
                        Some("toolActivity") if event["reason"] == "process_ended" => {
                            assert_eq!(scope, "target");
                            assert_eq!(event["toolCallIds"], json!([]));
                            ordered.push("toolActivity");
                        }
                        Some("compactionActivity") if event["reason"] == "process_ended" => {
                            assert_eq!(scope, "target");
                            assert_eq!(event["connectionId"], opened.connection_id);
                            ordered.push("compactionActivity");
                        }
                        Some("connectionLost") => {
                            assert_eq!(scope, "target");
                            assert_eq!(event["closeReason"], "unexpected");
                            ordered.push("connectionLost");
                        }
                        _ => {}
                    }
                }
                Observation::Ended(receipt, group_alive) => {
                    assert_eq!(scope, "target");
                    assert_eq!(receipt.connection_id, opened.connection_id);
                    assert_eq!(receipt.close_reason, CloseReason::Unexpected);
                    assert!(!group_alive);
                    ordered.push("typedReceipt");
                    break;
                }
            }
        }
        assert_eq!(
            ordered,
            [
                "toolActivity",
                "compactionActivity",
                "connectionLost",
                "typedReceipt"
            ]
        );
        target.life.closed().await.unwrap();
        let work_at_closed = target.life.work.load(Ordering::SeqCst);
        assert!(
            manager
                .session_connection(&row.id, &target_cwd, &opened.session_id)
                .is_err()
        );
        // Process and registry completion do not join the separately spawned
        // session pump. It can still be dropping its tool work lease.
        let release_started = tokio::time::Instant::now();
        tokio::time::timeout(Duration::from_secs(1), async {
            while target.life.work.load(Ordering::SeqCst) != 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("local tool work did not release after the exact process ended");
        eprintln!(
            "owned-peer-exit work_at_closed={work_at_closed} local_release_ms={}",
            release_started.elapsed().as_millis()
        );
        assert!(crate::supervisor::owned_group_alive(*sibling_pid));
        let remaining = manager
            .session_connection(&row.id, &sibling_cwd, &sibling_open.session_id)
            .unwrap();
        assert_eq!(remaining.connection_id, sibling_open.connection_id);
        assert!(Arc::ptr_eq(&remaining.life, &sibling.life));
        while let Ok((_, observation)) = receive.try_recv() {
            let Observation::Raw(event) = observation else {
                panic!("received an extra process receipt");
            };
            assert_ne!(event["kind"], "connectionLost");
            assert_ne!(event["reason"], "process_ended");
        }

        std::fs::write(sibling_cwd.join("fixture-exit"), b"cleanup").unwrap();
        sibling.life.closed().await.unwrap();
    })
    .await
    .unwrap();
}
