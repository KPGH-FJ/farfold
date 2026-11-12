//! Real stdio peers model two official fork activation shapes, never real Agents.
use super::*;
use crate::acp_client::session_fork::SourceFork;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};

#[path = "history_delivery_fork_manager_tests.rs"]
mod history_delivery_tests;

#[path = "session_fork/point_wire_tests.rs"]
mod point_wire_tests;

const FORK_PEER: &str = r#"
import sys,json,os,time,threading,pathlib
lock=threading.Lock(); active=set();answers={}
options=[{'id':'model','name':'Model','category':'model','type':'select','currentValue':'m','options':[{'value':'m','name':'m'}]}, {'id':'effort','name':'Effort','category':'thought_level','type':'select','currentValue':'high','options':[{'value':'high','name':'High'}]}]
def send(v):
 with lock: print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def reply(m,r):send({'id':m['id'],'result':r})
def trace(m):
 with open('trace.jsonl','a') as f:f.write(json.dumps({'pid':os.getpid(),'method':m.get('method'),'params':m.get('params',{})})+'\n')
def is_source():return pathlib.Path('source-pid').exists() and pathlib.Path('source-pid').read_text()==str(os.getpid())
def hold(name):
 while pathlib.Path(name).exists():time.sleep(.005)
def inquiry(m,id,flag):
 if not pathlib.Path(flag).exists():return
 event=threading.Event();answers[id]=event
 send({'id':id,'method':'elicitation/create','params':{'requestId':m['id'],'mode':'form','message':flag,'requestedSchema':{'type':'object','properties':{}},'_meta':{'exact':flag}}})
 event.wait()
def fork(m):
 hold('hold-fork')
 inquiry(m,801,'ask-fork')
 if pathlib.Path('fork-active').exists():active.add('child')
 child=pathlib.Path('returned-id').read_text() if pathlib.Path('returned-id').exists() else 'child'
 reply(m,{'sessionId':child,'configOptions':options,'_meta':{'exact':'fork-envelope'}})
def load(m):
 if is_source():hold('hold-source-load')
 if not is_source():hold('hold-destination-load')
 inquiry(m,802 if is_source() else 803,'ask-source' if is_source() else 'ask-destination')
 if not is_source() and pathlib.Path('destination-reject').exists():
  send({'id':m['id'],'error':{'code':-32603,'message':'fixture load rejected'}});return
 active.add(m['params']['sessionId'])
 send({'method':'session/update','params':{'sessionId':m['params']['sessionId'],'update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'entire child history'},'_meta':{'exact':'replay'}}}})
 reply(m,{'configOptions':options})
for line in sys.stdin:
 m=json.loads(line);p=m.get('params',{});method=m.get('method');trace(m)
 if method=='initialize':reply(m,{'protocolVersion':1,'agentCapabilities':{'loadSession':True,'sessionCapabilities':{'fork':{},'close':{},'list':{}}},'authMethods':[]})
 elif method=='session/new':
  pathlib.Path('source-pid').write_text(str(os.getpid()));active.add('parent');reply(m,{'sessionId':'parent','configOptions':options})
 elif method=='session/prompt':
  text=p.get('prompt',[{}])[0].get('text','')
  if text=='compact':send({'method':'session/update','params':{'sessionId':p['sessionId'],'update':{'sessionUpdate':'compaction_update','compactionId':'live','status':'in_progress'}}})
  if text=='error':send({'id':m['id'],'error':{'code':-32603,'message':'fixture outcome unknown'}})
  else:send({'method':'session/update','params':{'sessionId':p['sessionId'],'update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'parent answer'}}}});reply(m,{'stopReason':'end_turn'})
 elif method=='session/fork':threading.Thread(target=fork,args=(m,),daemon=True).start()
 elif method=='session/load':threading.Thread(target=load,args=(m,),daemon=True).start()
 elif method=='session/close':
  hold('hold-close')
  if pathlib.Path('close-reject').exists() or p['sessionId'] not in active:
   active.discard(p['sessionId']);send({'id':m['id'],'error':{'code':-32603,'message':'fixture close not acknowledged'}})
  else:active.remove(p['sessionId']);reply(m,{})
 elif method=='session/set_config_option':reply(m,{'configOptions':options})
 elif method=='session/list':reply(m,{'sessions':[]})
 elif m.get('id') in answers and method is None:answers[m['id']].set()
"#;

type Events = Arc<Mutex<Vec<Value>>>;
fn sink(events: &Events) -> SessionSink {
    let saved = events.clone();
    Arc::new(move |event| saved.lock().unwrap().push(event))
}
fn trace(f: &Fixture) -> Vec<Value> {
    std::fs::read_to_string(f.cwd.join("trace.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}
fn count(f: &Fixture, method: &str) -> usize {
    trace(f).iter().filter(|v| v["method"] == method).count()
}
async fn parent(f: &Fixture) -> (String, Events) {
    std::fs::write(f.cwd.join("peer.py"), FORK_PEER).unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let opened = f
        .manager
        .open_session(&f.row, &f.cwd, None, vec![], sink(&events), &f.store)
        .await
        .unwrap();
    f.manager
        .session_prompt(
            &f.row.id,
            &f.cwd,
            &opened.session_id,
            serde_json::from_value(json!([{"type":"text","text":"parent"}])).unwrap(),
        )
        .await
        .unwrap();
    until(|| {
        events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "turnEnd")
    })
    .await;
    (opened.connection_id, events)
}
async fn begin(f: &Fixture, connection: &str, events: &Events) -> Arc<SourceFork> {
    f.manager
        .begin_fork(
            f.row.clone(),
            &f.cwd,
            "parent",
            connection,
            "copy-one".into(),
            "history-one".into(),
            sink(events),
            Arc::new(AtomicBool::new(false)),
            &f.store,
            None,
        )
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn fork_completed_operation_id_returns_original_without_a_second_official_mutation() {
    let f = Fixture::new();
    let (connection, events) = parent(&f).await;
    let first = begin(&f, &connection, &events).await;
    let result = first.wait(Duration::from_secs(10)).await;
    assert_eq!(result.status, "ready");
    until(|| {
        f.manager
            .opening_sessions
            .reserve(&f.row.id, &f.cwd, "parent")
            .is_ok()
    })
    .await;
    let second = begin(&f, &connection, &events).await;
    let same = Arc::ptr_eq(&first, &second);
    if !same {
        let _ = second.wait(Duration::from_secs(10)).await;
    }
    assert!(
        same,
        "the same operation ID must retain the original result"
    );
    assert_eq!(count(&f, "session/fork"), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn fork_current_context_loads_closes_then_hands_off_without_mutating_parent() {
    for active in [false, true] {
        let f = Fixture::new();
        if active {
            std::fs::write(f.cwd.join("fork-active"), "").unwrap();
        }
        let (connection, parent_events) = parent(&f).await;
        let before = f
            .store
            .get_session(&format!("{}:{}:parent", f.row.id, f.cwd.display()))
            .unwrap()
            .unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let fork = begin(&f, &connection, &events).await;
        let result = fork.wait(Duration::from_secs(5)).await;
        assert_eq!(result.status, "ready");
        assert!(result.source_released && result.indexed);
        let child = result.session.unwrap();
        assert!(child.resumed);
        assert_ne!(child.connection_id, connection);
        assert_eq!(child.native_session_id, "child");
        assert_eq!(
            f.store.get_session(&before.id).unwrap(),
            Some(before.clone())
        );
        let child_row = f
            .store
            .get_session(&format!("{}:{}:child", f.row.id, f.cwd.display()))
            .unwrap()
            .unwrap();
        assert_eq!(child_row.config_options, before.config_options);
        assert!(!child_row.pinned && !child_row.archived);
        let records = trace(&f);
        let stages: Vec<_> = records
            .iter()
            .filter(|v| {
                matches!(
                    v["method"].as_str(),
                    Some("session/fork" | "session/load" | "session/close")
                )
            })
            .collect();
        assert_eq!(
            stages
                .iter()
                .map(|v| v["method"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "session/fork",
                "session/load",
                "session/close",
                "session/load"
            ]
        );
        assert_eq!(stages[0]["pid"], stages[1]["pid"]);
        assert_eq!(stages[1]["pid"], stages[2]["pid"]);
        assert_ne!(stages[2]["pid"], stages[3]["pid"]);
        for v in [&stages[0], &stages[1], &stages[3]] {
            assert!(v["params"].get("additionalDirectories").is_none());
            assert_eq!(v["params"]["mcpServers"], json!([]));
        }
        assert_eq!(count(&f, "session/fork"), 1);
        {
            let delivered = events.lock().unwrap();
            assert_eq!(
                delivered
                    .iter()
                    .filter(|e| e.get("update").is_some())
                    .count(),
                1
            );
            assert!(delivered.iter().any(|e| e["kind"] == "forkSourceEvent"
                && e["event"]["update"]["_meta"]["exact"] == "replay"));
            let marker = delivered
                .iter()
                .position(|e| {
                    e["kind"] == "session_history_complete" && e["openToken"] == "history-one"
                })
                .unwrap();
            let ready = delivered
                .iter()
                .position(|e| {
                    e["kind"] == "forkResult"
                        && e["result"]["status"] == "ready"
                        && e["settled"] == true
                })
                .unwrap();
            assert!(marker < ready);
        }
        assert!(
            !parent_events
                .lock()
                .unwrap()
                .iter()
                .any(|e| e.get("update").is_some() && e["sessionId"] == "child")
        );
        assert!(
            f.manager
                .session_connection(&f.row.id, &f.cwd, "parent")
                .is_ok()
        );
        f.manager
            .disconnect_selected(&f.row.id, None, None)
            .await
            .unwrap();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn fork_inflight_barrier_blocks_parent_mutations_reaping_and_second_fork() {
    let f = Fixture::new();
    let (connection, _) = parent(&f).await;
    std::fs::write(f.cwd.join("hold-fork"), "").unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let fork = begin(&f, &connection, &events).await;
    until(|| count(&f, "session/fork") == 1).await;
    assert!(
        f.manager
            .session_prompt(&f.row.id, &f.cwd, "parent", vec![])
            .await
            .is_err()
    );
    assert!(
        f.manager
            .close_session(&f.row.id, &f.cwd, "parent")
            .await
            .is_err()
    );
    assert!(
        f.manager
            .detach_session_for_config_check(&f.row.id, &f.cwd, "parent", false)
            .await
            .is_err()
    );
    let owner = f
        .manager
        .session_connection(&f.row.id, &f.cwd, "parent")
        .unwrap();
    assert!(owner.life.work.load(Ordering::SeqCst) > 0);
    assert!(owner.life.operation("account_change".into()).is_err());
    assert!(!owner.life.close(false, Some(Duration::ZERO)).unwrap());
    assert!(owner.life.release_for_configuration().is_err());
    assert!(
        f.manager
            .begin_fork(
                f.row.clone(),
                &f.cwd,
                "parent",
                &connection,
                "copy-two".into(),
                "two".into(),
                sink(&events),
                Arc::new(AtomicBool::new(false)),
                &f.store,
                None,
            )
            .await
            .is_err()
    );
    std::fs::remove_file(f.cwd.join("hold-fork")).unwrap();
    assert_eq!(fork.wait(Duration::from_secs(5)).await.status, "ready");
    assert_eq!(count(&f, "session/fork"), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn fork_delivery_timeout_keeps_same_request_and_late_complete_result() {
    let f = Fixture::new();
    let (connection, _) = parent(&f).await;
    std::fs::write(f.cwd.join("hold-fork"), "").unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let fork = begin(&f, &connection, &events).await;
    let unknown = fork.wait(Duration::from_millis(20)).await;
    assert_eq!(unknown.status, "unknown");
    assert_eq!(unknown.reason, Some("pending"));
    assert!(!unknown.source_released);
    assert!(fork.busy.load(Ordering::SeqCst));
    std::fs::remove_file(f.cwd.join("hold-fork")).unwrap();
    until(|| {
        events.lock().unwrap().iter().any(|e| {
            e["kind"] == "forkResult" && e["settled"] == true && e["result"]["status"] == "ready"
        })
    })
    .await;
    assert_eq!(fork.wait(Duration::from_secs(1)).await.status, "ready");
    assert_eq!(count(&f, "session/fork"), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn fork_close_failure_retains_known_id_index_and_parent_without_second_controller() {
    let f = Fixture::new();
    let (connection, _) = parent(&f).await;
    std::fs::write(f.cwd.join("close-reject"), "").unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let fork = begin(&f, &connection, &events).await;
    let result = fork.wait(Duration::from_secs(5)).await;
    assert_eq!(result.status, "created_unavailable");
    assert_eq!(result.child_session_id.as_deref(), Some("child"));
    assert!(result.indexed && !result.source_released);
    assert_eq!(result.reason, Some("source_close_failed"));
    assert!(fork.busy.load(Ordering::SeqCst));
    assert_eq!(count(&f, "session/load"), 1);
    assert_eq!(count(&f, "session/fork"), 1);
    assert!(
        f.manager
            .opening_sessions
            .reserve(&f.row.id, &f.cwd, "child")
            .is_err()
    );
    assert!(
        f.manager
            .session_connection(&f.row.id, &f.cwd, "parent")
            .is_ok()
    );
    assert!(
        events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "forkResult"
                && e["settled"] == false
                && e["result"]["childSessionId"] == "child")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn fork_index_collision_is_insert_only_across_directories() {
    let f = Fixture::new();
    let (connection, _) = parent(&f).await;
    let old = crate::meta_store::SessionRow {
        id: "unrelated-index".into(),
        agent_id: f.row.id.clone(),
        cwd: "/other-project".into(),
        native_session_id: Some("child".into()),
        title: Some("keep old".into()),
        config_options: Some(json!({"keep":"all-fields"})),
        pinned: true,
        archived: true,
        created_at: 1,
        updated_at: 2,
    };
    f.store.touch_session(&old).unwrap();
    let before = f.store.get_session(&old.id).unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let result = begin(&f, &connection, &events)
        .await
        .wait(Duration::from_secs(5))
        .await;
    assert_eq!(result.reason, Some("identity_conflict"));
    assert!(!result.indexed && !result.source_released);
    assert_eq!(result.child_session_id.as_deref(), Some("child"));
    assert_eq!(f.store.get_session(&old.id).unwrap(), before);
    assert_eq!(count(&f, "session/load"), 0);
    assert_eq!(count(&f, "session/fork"), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn fork_destination_failure_keeps_child_index_and_releases_only_confirmed_source() {
    let f = Fixture::new();
    let (connection, _) = parent(&f).await;
    std::fs::write(f.cwd.join("destination-reject"), "").unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let fork = begin(&f, &connection, &events).await;
    let result = fork.wait(Duration::from_secs(5)).await;
    assert_eq!(result.reason, Some("destination_open_failed"));
    assert_eq!(result.status, "created_unavailable");
    assert!(result.indexed && result.source_released);
    assert!(!fork.busy.load(Ordering::SeqCst));
    assert!(
        f.store
            .get_session(&format!("{}:{}:child", f.row.id, f.cwd.display()))
            .unwrap()
            .is_some()
    );
    assert_eq!(count(&f, "session/fork"), 1);
    assert!(
        events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "forkResult"
                && e["settled"] == true
                && e["result"]["sourceReleased"] == true)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn fork_dropped_rpc_keeps_all_three_late_inquiries_and_final_replay() {
    let f = Fixture::new();
    let (connection, parent_events) = parent(&f).await;
    for flag in ["hold-fork", "ask-fork", "ask-source", "ask-destination"] {
        std::fs::write(f.cwd.join(flag), "").unwrap();
    }
    let events = Arc::new(Mutex::new(Vec::new()));
    let (manager, row, cwd, store, output) = (
        f.manager.clone(),
        f.row.clone(),
        f.cwd.clone(),
        f.store.clone(),
        sink(&events),
    );
    let copy = tokio::spawn(async move {
        manager
            .fork_current(
                row,
                &cwd,
                "parent",
                &connection,
                "copy-one".into(),
                "history-one".into(),
                output,
                Arc::new(AtomicBool::new(false)),
                &store,
                None,
            )
            .await
    });
    until(|| count(&f, "session/fork") == 1).await;
    copy.abort();
    let _ = copy.await;
    std::fs::remove_file(f.cwd.join("hold-fork")).unwrap();
    for (index, flag) in ["ask-fork", "ask-source", "ask-destination"]
        .iter()
        .enumerate()
    {
        until(|| {
            events.lock().unwrap().iter().any(|e| {
                e["kind"] == "elicitation" && e["message"] == *flag
                    || e["kind"] == "forkSourceEvent"
                        && e["event"]["kind"] == "elicitation"
                        && e["event"]["message"] == *flag
            })
        })
        .await;
        let delivered = events
            .lock()
            .unwrap()
            .iter()
            .find(|e| e["message"] == *flag || e["event"]["message"] == *flag)
            .unwrap()
            .clone();
        let inquiry = if index < 2 {
            assert_eq!(delivered["kind"], "forkSourceEvent");
            if index == 0 {
                assert!(delivered["childSessionId"].is_null());
            }
            delivered["event"].clone()
        } else {
            delivered
        };
        assert_eq!(inquiry["request"]["_meta"]["exact"], *flag);
        let reply = crate::acp_client::elicitation::respond(
            &f.manager.pending_elicitations,
            inquiry["requestId"].as_str().unwrap(),
            None,
            inquiry.get("owner"),
            "accept",
            Some(json!({})),
        )
        .unwrap();
        assert_eq!(reply.status, "submitted");
    }
    until(|| {
        events.lock().unwrap().iter().any(|e| {
            e["kind"] == "forkResult" && e["result"]["status"] == "ready" && e["settled"] == true
        })
    })
    .await;
    assert_eq!(count(&f, "session/fork"), 1);
    assert!(
        !parent_events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "elicitation")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn fork_source_actual_reap_settles_unknown_without_retry_or_lost_child_id() {
    let f = Fixture::new();
    let (connection, _) = parent(&f).await;
    std::fs::write(f.cwd.join("hold-source-load"), "").unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let fork = begin(&f, &connection, &events).await;
    until(|| count(&f, "session/load") == 1).await;
    let owner = f
        .manager
        .session_connection(&f.row.id, &f.cwd, "parent")
        .unwrap();
    let pid = owner.child_pid.load(Ordering::SeqCst) as i32;
    assert_eq!(crate::platform_tests::terminate(pid), 0);
    owner.life.terminated().await;
    assert!(owner.life.finished());
    until(|| !fork.busy.load(Ordering::SeqCst)).await;
    let result = fork.wait(Duration::from_secs(1)).await;
    assert_eq!(result.reason, Some("owner_ended"));
    assert_eq!(result.child_session_id.as_deref(), Some("child"));
    assert!(result.indexed && !result.source_released);
    assert_eq!(count(&f, "session/fork"), 1);
    assert_eq!(count(&f, "session/load"), 1);
    assert!(
        events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "forkResult"
                && e["settled"] == true
                && e["result"]["reason"] == "owner_ended")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn fork_safe_rejections_are_explicit_and_do_not_send_requests() {
    for cause in [
        "wrong-owner",
        "changed-config",
        "disabled-work",
        "compact",
        "error",
    ] {
        let f = Fixture::new();
        let (connection, parent_events) = parent(&f).await;
        if cause == "changed-config" {
            let id = format!("{}:{}:parent", f.row.id, f.cwd.display());
            let mut row = f.store.get_session(&id).unwrap().unwrap();
            row.config_options.as_mut().unwrap()["changed"] = json!(true);
            f.store.touch_session(&row).unwrap();
        }
        if cause == "disabled-work" {
            f.store.set_setting("agentWorkPolicy.v1",&json!({"version":1,"defaults":{f.row.id.clone():false},"projects":{},"locations":{}})).unwrap();
        }
        if matches!(cause, "compact" | "error") {
            let before = parent_events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| e["kind"] == "turnEnd")
                .count();
            f.manager
                .session_prompt(
                    &f.row.id,
                    &f.cwd,
                    "parent",
                    serde_json::from_value(json!([{"type":"text","text":cause}])).unwrap(),
                )
                .await
                .unwrap();
            until(|| {
                parent_events
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|e| e["kind"] == "turnEnd")
                    .count()
                    > before
            })
            .await;
        }
        let events = Arc::new(Mutex::new(Vec::new()));
        let result = f
            .manager
            .fork_current(
                f.row.clone(),
                &f.cwd,
                "parent",
                if cause == "wrong-owner" {
                    "wrong"
                } else {
                    &connection
                },
                "copy".into(),
                "history".into(),
                sink(&events),
                Arc::new(AtomicBool::new(false)),
                &f.store,
                None,
            )
            .await
            .unwrap();
        assert_eq!(result.status, "rejected", "{cause}");
        assert!(result.source_released && !result.indexed);
        assert!(result.child_session_id.is_none());
        assert_eq!(count(&f, "session/fork"), 0, "{cause}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn fork_rejects_malformed_or_parent_identity_without_touching_parent() {
    for id in ["", "parent", "bad\0id", "bad\nid", &"a".repeat(4097)] {
        let f = Fixture::new();
        let (connection, _) = parent(&f).await;
        let row_id = format!("{}:{}:parent", f.row.id, f.cwd.display());
        let before = f.store.get_session(&row_id).unwrap();
        std::fs::write(f.cwd.join("returned-id"), id).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let result = begin(&f, &connection, &events)
            .await
            .wait(Duration::from_secs(5))
            .await;
        assert_eq!(result.reason, Some("identity_conflict"));
        assert!(!result.indexed && !result.source_released);
        assert_eq!(count(&f, "session/load"), 0);
        assert_eq!(count(&f, "session/fork"), 1);
        assert_eq!(f.store.get_session(&row_id).unwrap(), before);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn fork_slow_live_owner_does_not_become_ended_at_five_second_wait_timeout() {
    let f = Fixture::new();
    let (connection, _) = parent(&f).await;
    std::fs::write(f.cwd.join("hold-fork"), "").unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let fork = begin(&f, &connection, &events).await;
    until(|| count(&f, "session/fork") == 1).await;
    tokio::time::sleep(Duration::from_millis(5300)).await;
    let owner = f
        .manager
        .session_connection(&f.row.id, &f.cwd, "parent")
        .unwrap();
    assert!(!owner.life.finished());
    assert!(
        fork.busy.load(Ordering::SeqCst),
        "a bounded observer timeout is not actual process termination"
    );
    assert!(
        f.manager
            .opening_sessions
            .reserve(&f.row.id, &f.cwd, "parent")
            .is_err()
    );
    assert!(
        !events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "forkResult" && e["settled"] == true)
    );
    std::fs::remove_file(f.cwd.join("hold-fork")).unwrap();
    assert_eq!(fork.wait(Duration::from_secs(5)).await.status, "ready");
}

#[tokio::test(flavor = "multi_thread")]
async fn fork_dismissed_identity_is_not_reimported_or_unhidden() {
    let f = Fixture::new();
    let (connection, _) = parent(&f).await;
    let child_row = format!("{}:{}:child", f.row.id, f.cwd.display());
    f.store.dismiss_session(&child_row).unwrap();
    let before = f.store.list_dismissed().unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let result = begin(&f, &connection, &events)
        .await
        .wait(Duration::from_secs(5))
        .await;
    assert_eq!(result.reason, Some("identity_conflict"));
    assert_eq!(result.child_session_id.as_deref(), Some("child"));
    assert!(!result.indexed && !result.source_released);
    assert_eq!(f.store.list_dismissed().unwrap(), before);
    assert!(f.store.get_session(&child_row).unwrap().is_none());
    assert_eq!(count(&f, "session/fork"), 1);
    assert_eq!(count(&f, "session/load"), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn fork_index_write_failure_retains_exact_child_without_loading_or_retrying() {
    let f = Fixture::new();
    let (connection, _) = parent(&f).await;
    rusqlite::Connection::open(f.cwd.join("meta.db")).unwrap().execute_batch("CREATE TRIGGER fork_insert_failure BEFORE INSERT ON sessions WHEN NEW.native_session_id = 'child' BEGIN SELECT RAISE(FAIL,'fixture index failure'); END;").unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let fork = begin(&f, &connection, &events).await;
    let result = fork.wait(Duration::from_secs(5)).await;
    assert_eq!(result.reason, Some("index_failed"));
    assert_eq!(result.child_session_id.as_deref(), Some("child"));
    assert!(!result.indexed && !result.source_released);
    assert!(fork.busy.load(Ordering::SeqCst));
    assert_eq!(count(&f, "session/fork"), 1);
    assert_eq!(count(&f, "session/load"), 0);
    assert!(
        f.manager
            .opening_sessions
            .reserve(&f.row.id, &f.cwd, "child")
            .is_err()
    );
}

struct ForkOffer(AtomicBool);
impl crate::acp_client::transient_mcp::SessionMcpOwner for ForkOffer {
    fn bind_session(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn set_prompt_active(&self, _: bool) {}
    fn fork_admissible(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
    fn revoke(&self) {}
}
#[tokio::test(flavor = "multi_thread")]
async fn fork_mcp_checks_actual_owner_admission_without_copying_offer() {
    fork_mcp_owner_admission(false).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn opencode_fork_mcp_preview_is_closed_before_independent_target_without_offer() {
    fork_mcp_owner_admission(true).await;
}

async fn fork_mcp_owner_admission(opencode: bool) {
    let mut f = Fixture::new();
    // The same controlled peer under an allowed executable launch shape. This
    // exercises offer admission, never an installed Agent or real browser tool.
    f.row.id = if opencode {
        "opencode"
    } else {
        "registry:codex-acp"
    }
    .into();
    f.row.source = if opencode { "discovered" } else { "registry" }.into();
    f.row.command = crate::platform_tests::python_peer(
        &f.cwd,
        if opencode { "opencode" } else { "codex-acp" },
        FORK_PEER,
    )
    .to_string_lossy()
    .into_owned();
    f.row.args.clear();
    if opencode {
        f.row.args.push("acp".into());
        f.row.env.extend([
            ("OPENCODE_AUTO_HEAP_SNAPSHOT".into(), "false".into()),
            ("OTEL_EXPORTER_OTLP_ENDPOINT".into(), "".into()),
        ]);
    }
    f.store.insert_agent(&f.row).unwrap();
    let owner = Arc::new(ForkOffer(AtomicBool::new(false)));
    let offer = crate::acp_client::transient_mcp::TransientMcpOpen::new(
        agent_client_protocol::schema::v1::McpServerStdio::new(
            "fixture-browser",
            "/fixture-only-unused",
        ),
        owner.clone(),
    );
    let events = Arc::new(Mutex::new(Vec::new()));
    let parent = f
        .manager
        .open_session_selected_with_mcp(
            &f.row,
            &f.cwd,
            None,
            vec![],
            sink(&events),
            &f.store,
            None,
            Some(offer),
            None,
        )
        .await
        .unwrap();
    f.manager
        .session_prompt(
            &f.row.id,
            &f.cwd,
            "parent",
            serde_json::from_value(json!([{"type":"text","text":"parent"}])).unwrap(),
        )
        .await
        .unwrap();
    until(|| {
        events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "turnEnd")
    })
    .await;
    let result = f
        .manager
        .fork_current(
            f.row.clone(),
            &f.cwd,
            "parent",
            &parent.connection_id,
            "first".into(),
            "one".into(),
            sink(&events),
            Arc::new(AtomicBool::new(false)),
            &f.store,
            None,
        )
        .await
        .unwrap();
    assert_eq!(result.status, "rejected");
    assert_eq!(result.reason, Some("browser_shared"));
    assert_eq!(count(&f, "session/fork"), 0);
    owner.0.store(true, Ordering::SeqCst);
    if opencode {
        std::fs::write(f.cwd.join("hold-source-load"), "").unwrap();
    }
    let pending = begin(&f, &parent.connection_id, &events).await;
    if opencode {
        until(|| count(&f, "session/load") == 1).await;
        let prompts = count(&f, "session/prompt");
        let refused = f
            .manager
            .session_prompt(
                &f.row.id,
                &f.cwd,
                "child",
                serde_json::from_value(
                    json!([{"type":"text","text":"must not reach source preview"}]),
                )
                .unwrap(),
            )
            .await;
        assert!(refused.is_err());
        assert_eq!(count(&f, "session/prompt"), prompts);
        std::fs::remove_file(f.cwd.join("hold-source-load")).unwrap();
    }
    let result = pending.wait(Duration::from_secs(5)).await;
    assert_eq!(result.status, "ready");
    assert_eq!(count(&f, "session/fork"), 1);
    let records = trace(&f);
    assert_eq!(
        records
            .iter()
            .find(|e| e["method"] == "session/new")
            .unwrap()["params"]["mcpServers"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        records
            .iter()
            .filter(|e| matches!(e["method"].as_str(), Some("session/fork" | "session/load")))
            .all(|e| e["params"]["mcpServers"] == json!([]))
    );
    assert!(result.source_released);
    assert_ne!(
        result.session.as_ref().unwrap().connection_id,
        parent.connection_id
    );
    let source_pid = records
        .iter()
        .find(|e| e["method"] == "session/new")
        .unwrap()["pid"]
        .clone();
    let loads: Vec<_> = records
        .iter()
        .filter(|e| e["method"] == "session/load")
        .collect();
    assert_eq!(loads.len(), 2);
    assert_eq!(loads[0]["pid"], source_pid);
    assert_ne!(loads[1]["pid"], source_pid);
    let source_closed = records
        .iter()
        .position(|e| {
            e["method"] == "session/close"
                && e["pid"] == source_pid
                && e["params"]["sessionId"] == "child"
        })
        .unwrap();
    let target_loaded = records
        .iter()
        .position(|e| e["method"] == "session/load" && e["pid"] != source_pid)
        .unwrap();
    assert!(source_closed < target_loaded);
    assert!(
        records
            .iter()
            .filter(|e| e["method"] == "session/prompt")
            .all(|e| e["params"]["sessionId"] == "parent")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn fork_source_close_late_ack_continues_same_handoff_without_second_close() {
    let f = Fixture::new();
    let (connection, _) = parent(&f).await;
    std::fs::write(f.cwd.join("hold-close"), "").unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let fork = begin(&f, &connection, &events).await;
    until(|| count(&f, "session/close") == 1).await;
    tokio::time::sleep(Duration::from_millis(15500)).await;
    assert!(fork.busy.load(Ordering::SeqCst));
    assert!(
        f.manager
            .opening_sessions
            .reserve(&f.row.id, &f.cwd, "child")
            .is_err()
    );
    assert!(
        !events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "forkResult" && e["result"]["sourceReleased"] == true)
    );
    std::fs::remove_file(f.cwd.join("hold-close")).unwrap();
    let result = fork.wait(Duration::from_secs(5)).await;
    assert_eq!(
        result.status, "ready",
        "late positive ACK must finish the same operation"
    );
    assert!(result.source_released && result.indexed);
    assert_eq!(count(&f, "session/fork"), 1);
    assert_eq!(count(&f, "session/close"), 1);
    assert_eq!(count(&f, "session/load"), 2);
}

fn tombstones(f: &Fixture) -> Vec<(String, i64)> {
    let connection = rusqlite::Connection::open(f.cwd.join("meta.db")).unwrap();
    let mut statement = connection
        .prepare("SELECT id,created_at FROM dismissed_sessions ORDER BY id")
        .unwrap();
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}
#[tokio::test(flavor = "multi_thread")]
async fn fork_cross_directory_tombstone_is_possible_collision_but_other_agent_is_not() {
    for same_source in [true, false] {
        let f = Fixture::new();
        let (connection, _) = parent(&f).await;
        let id = crate::meta_store::MetaStore::dismissed_id(
            if same_source {
                &f.row.id
            } else {
                "another-agent"
            },
            "/other:project",
            "child",
        );
        f.store.dismiss_session(&id).unwrap();
        let before = tombstones(&f);
        let parent_row = format!("{}:{}:parent", f.row.id, f.cwd.display());
        let parent_before = f.store.get_session(&parent_row).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let result = begin(&f, &connection, &events)
            .await
            .wait(Duration::from_secs(5))
            .await;
        if same_source {
            assert_eq!(result.reason, Some("identity_conflict"));
            assert!(!result.indexed && !result.source_released);
            assert_eq!(count(&f, "session/load"), 0);
        } else {
            assert_eq!(result.status, "ready");
            assert!(result.indexed && result.source_released);
            assert_eq!(count(&f, "session/load"), 2);
        }
        assert_eq!(result.child_session_id.as_deref(), Some("child"));
        assert_eq!(tombstones(&f), before);
        assert_eq!(f.store.get_session(&parent_row).unwrap(), parent_before);
        assert_eq!(count(&f, "session/fork"), 1);
    }
}

fn directory_requests(cwd: &std::path::Path, method: &str) -> usize {
    std::fs::read_to_string(cwd.join("trace.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|e| e["method"] == method)
        .count()
}
#[tokio::test(flavor = "multi_thread")]
async fn fork_cross_directory_opening_first_excludes_known_pending_id_only_for_same_agent() {
    for same_source in [true, false] {
        let f = Fixture::new();
        let (connection, _) = parent(&f).await;
        let other = f.cwd.join("other-project");
        std::fs::create_dir(&other).unwrap();
        std::fs::write(other.join("hold-destination-load"), "").unwrap();
        let mut other_agent = f.row.clone();
        if !same_source {
            other_agent.id = "another-agent".into();
            f.store.insert_agent(&other_agent).unwrap();
        }
        let (manager, row, cwd, store) = (
            f.manager.clone(),
            other_agent.clone(),
            other.clone(),
            f.store.clone(),
        );
        let preview = tokio::spawn(async move {
            manager
                .open_session_owned_for_purpose(
                    &row,
                    &cwd,
                    Some("child".into()),
                    vec![],
                    Arc::new(|_| {}),
                    &store,
                    None,
                    Some("preview".into()),
                    crate::acp_client::open_purpose::OpenPurpose::ImportPreview,
                    None,
                    None,
                )
                .await
        });
        until(|| directory_requests(&other, "session/load") == 1).await;
        let events = Arc::new(Mutex::new(Vec::new()));
        let result = begin(&f, &connection, &events)
            .await
            .wait(Duration::from_secs(5))
            .await;
        std::fs::remove_file(other.join("hold-destination-load")).unwrap();
        let _ = preview.await.unwrap();
        if same_source {
            assert_eq!(result.reason, Some("identity_conflict"));
            assert!(!result.indexed && !result.source_released);
            assert_eq!(count(&f, "session/load"), 0);
        } else {
            assert_eq!(result.status, "ready");
            assert!(result.indexed && result.source_released);
            assert_eq!(count(&f, "session/load"), 2);
        }
        assert_eq!(count(&f, "session/fork"), 1);
        assert_eq!(directory_requests(&other, "session/load"), 1);
    }
}
#[tokio::test(flavor = "multi_thread")]
async fn fork_cross_directory_opening_after_claim_cannot_bypass_same_child_holder() {
    let f = Fixture::new();
    let (connection, _) = parent(&f).await;
    std::fs::write(f.cwd.join("hold-source-load"), "").unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let fork = begin(&f, &connection, &events).await;
    until(|| count(&f, "session/load") == 1).await;
    let other = f.cwd.join("other-project");
    std::fs::create_dir(&other).unwrap();
    let preview = f
        .manager
        .open_session_owned_for_purpose(
            &f.row,
            &other,
            Some("child".into()),
            vec![],
            Arc::new(|_| {}),
            &f.store,
            None,
            Some("preview".into()),
            crate::acp_client::open_purpose::OpenPurpose::ImportPreview,
            None,
            None,
        )
        .await;
    std::fs::remove_file(f.cwd.join("hold-source-load")).unwrap();
    let result = fork.wait(Duration::from_secs(5)).await;
    assert_eq!(result.status, "ready");
    assert!(preview.is_err());
    assert_eq!(directory_requests(&other, "session/load"), 0);
    assert_eq!(count(&f, "session/fork"), 1);
    assert_eq!(count(&f, "session/load"), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn fork_late_id_after_closing_admission_is_indexed_without_followup_command() {
    let f = Fixture::new();
    let (connection, _) = parent(&f).await;
    std::fs::write(f.cwd.join("hold-fork"), "").unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let fork = begin(&f, &connection, &events).await;
    until(|| count(&f, "session/fork") == 1).await;
    let owner = f
        .manager
        .session_connection(&f.row.id, &f.cwd, "parent")
        .unwrap();
    // Isolate the accepted CLOSING state from driver teardown so the controlled
    // wire can deliver its late ID before the exact process actually ends.
    owner
        .life
        .state
        .store(crate::acp_client::lifecycle::CLOSING, Ordering::SeqCst);
    std::fs::remove_file(f.cwd.join("hold-fork")).unwrap();
    let result = fork.wait(Duration::from_secs(5)).await;
    let loads = count(&f, "session/load");
    let closes = count(&f, "session/close");
    let known = f
        .store
        .get_session(&format!("{}:{}:child", f.row.id, f.cwd.display()))
        .unwrap();
    let still_live = !owner.life.finished();
    let retained = fork.busy.load(Ordering::SeqCst);
    assert_eq!(
        crate::platform_tests::terminate(owner.child_pid.load(Ordering::SeqCst) as i32),
        0
    );
    owner.life.terminated().await;
    assert_eq!(result.child_session_id.as_deref(), Some("child"));
    assert!(result.indexed && !result.source_released);
    assert!(known.is_some());
    assert!(still_live && retained);
    assert_eq!(loads, 0, "CLOSING cannot admit a new source load");
    assert_eq!(closes, 0);
    assert_eq!(count(&f, "session/fork"), 1);
}
