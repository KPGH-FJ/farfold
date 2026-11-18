//! Real locked official SDK + manager + owned stdio peer + actual Channel
//! serialization/callback. The file fence is native test consumption only,
//! never renderer consumption, byte credit, RSS or a real Agent receipt.
use super::{
    lifecycle::ConnectionLife, manager::AcpManager, pump::SessionSink,
    session_index::touch_session_row,
};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use std::{
    future::{Future, poll_fn},
    panic::{AssertUnwindSafe, catch_unwind, resume_unwind},
    path::Path,
    sync::{Arc, Mutex},
    task::Poll,
    time::Duration,
};
use tokio::sync::Notify;

const SESSION: &str = "concurrent-load-owned";
const COUNT: usize = 80;
const BYTES: usize = 16 * 1024;
const PEER: &str = r#"
import sys,json,pathlib,time
root=pathlib.Path(sys.argv[1]);mode=sys.argv[2];prompt=None
def send(v): print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def reply(m,r): send({'id':m['id'],'result':r})
def update(u,extra=None):
 p={'sessionId':'concurrent-load-owned','update':u}
 if extra: p.update(extra)
 send({'method':'session/update','params':p})
def raw(n):
 update({'sessionUpdate':'_fixture/full-unknown','sequence':n,'text':'x'*16384,'future':{'array':[None,False,n],'unicode':'中文🙂'}},
        {'unknownEnvelope':{'n':n,'nil':None},'kind':'turnEnd','stopReason':'cancelled'})
def options(value):
 return [{'id':'model','name':'Model','category':'model','type':'select','currentValue':value,'options':[{'value':v,'name':v} for v in ['m1','m2']]}]
def incident():
 return {'jetbrains':{'air':{'version':1,'sessionFailure':{'id':'history-incident','revision':1,'severity':'error','category':'service'}}}}
def permission():
 send({'id':901,'method':'session/request_permission','params':{'sessionId':'concurrent-load-owned',
       'toolCall':{'toolCallId':'actual-tool','title':'Controlled permission','kind':'read'},
       'options':[{'optionId':'yes','name':'Allow once','kind':'allow_once'}]}})
for line in sys.stdin:
 m=json.loads(line);method=m.get('method')
 if method=='initialize':
  reply(m,{'protocolVersion':1,'agentCapabilities':{'loadSession':True},'authMethods':[],
    '_meta':{'jetbrains':{'air':{'version':1,'capabilities':['asyncTasks']}}}})
 elif method=='session/new':
  raw(0)
  (root/'reply-published').write_text('actual-new-id-response')
  reply(m,{'sessionId':'concurrent-load-owned','configOptions':[]})
 elif method=='session/load':
  assert m['params']['sessionId']=='concurrent-load-owned'
  if mode in ('handoff','postreply'):
   update({'sessionUpdate':'tool_call','toolCallId':'history-tool','title':'Historical','status':'in_progress'})
   update({'sessionUpdate':'compaction_update','compactionId':'history-compaction','status':'in_progress'})
   update({'sessionUpdate':'async_task_spawned','asyncTaskId':'load-task','toolCallId':'load-tool','name':'Original load task','taskType':'shell','canStop':True})
   update({'sessionUpdate':'session_info_update','_meta':incident()})
  else:
   raw(0)
   if mode=='burst':
    for n in range(1,80): raw(n)
   elif mode=='configuration':
    update({'sessionUpdate':'config_option_update','configOptions':options('m2'),'unknownConfig':[None,False]})
    raw(1)
   elif mode=='request':
    send({'id':902,'method':'_fixture/unknown_request','params':{'sessionId':'concurrent-load-owned','unknown':[None,False]}})
    raw(1)
  if mode!='postreply':
   deadline=time.monotonic()+5
   while not (root/'consumed-prefix').exists() and time.monotonic()<deadline: time.sleep(.005)
   if not (root/'consumed-prefix').exists():
    send({'id':m['id'],'error':{'code':-32603,'message':'controlled prefix was not consumed before load reply'}})
    continue
  (root/'reply-published').write_text('actual-owned-peer-about-to-send-load-reply')
  reply(m,{'configOptions':options('m1') if mode=='configuration' else []})
 elif method=='_session/async_task/stop':
  assert m['params']['asyncTaskId']=='load-task'
  reply(m,{'stopped':True})
  update({'sessionUpdate':'async_task_state_update','asyncTaskId':'load-task','toolCallId':'load-tool','state':'completed'})
 elif method=='session/prompt':
  prompt=m
  if mode=='burst': permission()
  else:
   if mode in ('handoff','postreply'):
    update({'sessionUpdate':'compaction_update','compactionId':'history-compaction','status':'in_progress'})
    update({'sessionUpdate':'async_task_state_update','asyncTaskId':'load-task','toolCallId':'load-tool','state':'completed'})
    update({'sessionUpdate':'session_info_update','_meta':incident()})
   reply(prompt,{'stopReason':'end_turn'});prompt=None
 elif method is None and m.get('id')==901:
  assert m['result']['outcome']=={'outcome':'selected','optionId':'yes'},m
  reply(prompt,{'stopReason':'end_turn'});prompt=None
 elif method is None and m.get('id')==902:
  assert m['error']['code']==-32601,m
  (root/'unknown-request-answered').write_text('exact-original-method-not-found')
 elif method=='session/cancel':
  if prompt: reply(prompt,{'stopReason':'cancelled'});prompt=None
"#;

type Trace = Arc<Mutex<Vec<(Value, bool)>>>;

struct Stop(Arc<AcpManager>);
impl Drop for Stop {
    fn drop(&mut self) {
        self.0.stop_for_shutdown();
    }
}

fn expected(sequence: usize) -> Value {
    json!({"sessionId":SESSION,"update":{"sessionUpdate":"_fixture/full-unknown",
        "sequence":sequence,"text":"x".repeat(BYTES),
        "future":{"array":[null,false,sequence],"unicode":"中文🙂"}},
        "unknownEnvelope":{"n":sequence,"nil":null},"kind":"turnEnd","stopReason":"cancelled"})
}

async fn wait_event(trace: &Trace, changed: &Notify, matches: impl Fn(&Value) -> bool) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(value) = trace
                .lock()
                .unwrap()
                .iter()
                .find(|(value, _)| matches(value))
                .map(|(value, _)| value.clone())
            {
                return value;
            }
            changed.notified().await;
        }
    })
    .await
    .expect("finite actual owned peer event")
}

async fn wait_file(path: &Path) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !path.exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("finite actual owned peer response")
}

async fn run(mode: &'static str) {
    let directory = tempfile::tempdir().unwrap();
    let cwd = directory.path().canonicalize().unwrap();
    let script = cwd.join("peer.py");
    std::fs::write(&script, PEER).unwrap();
    let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
    let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
    let _stop = Stop(manager.clone());
    let row = AgentRow {
        id: format!("load-consumer-{mode}"),
        name: "Fixture".into(),
        source: "custom".into(),
        command: crate::platform_tests::python(),
        args: vec![
            "-u".into(),
            script.to_string_lossy().into(),
            cwd.to_string_lossy().into(),
            mode.into(),
        ],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    };
    store.insert_agent(&row).unwrap();
    // Explicit Farfold-owned saved selection, not an Agent config/history file.
    if mode != "newheader" {
        touch_session_row(
            &store,
            &row.id,
            &cwd.to_string_lossy(),
            SESSION,
            None,
            Some(json!({"_farfoldConfig":2,"choices":[],"_farfoldService":{"kind":"existing"}})),
        )
        .unwrap();
    }
    let trace: Trace = Default::default();
    let changed = Arc::new(Notify::new());
    let events = trace.clone();
    let signal = changed.clone();
    let fence = cwd.join("consumed-prefix");
    let reply = cwd.join("reply-published");
    let channel = tauri::ipc::Channel::<Value>::new(move |body| {
        let value = body.deserialize::<Value>().unwrap();
        let sequence = value.pointer("/update/sequence").and_then(Value::as_u64);
        let acknowledges = if matches!(mode, "handoff" | "postreply") {
            value.pointer("/update/sessionUpdate") == Some(&json!("session_info_update"))
        } else {
            sequence
                == Some(if mode == "burst" {
                    (COUNT - 1) as u64
                } else {
                    1
                })
        };
        events.lock().unwrap().push((value, reply.exists()));
        if acknowledges {
            std::fs::write(&fence, b"native-test-consumer-only").unwrap();
        }
        signal.notify_one();
        Ok(())
    });
    let sink: SessionSink = Arc::new(move |value| {
        channel.send(value).unwrap();
    });
    let result = {
        let body = async {
            let native = (mode != "newheader").then(|| SESSION.to_owned());
            let history = if let Some(id) = &native {
                Some(
                    manager
                        .admit_cold_history_for_test(&row, &cwd, id, &[], &store, None)
                        .await
                        .unwrap(),
                )
            } else {
                None
            };
            let opened = manager
                .open_session_admitted_with_mcp(
                    &row,
                    &cwd,
                    native,
                    vec![],
                    sink,
                    &store,
                    None,
                    None,
                    None,
                    history,
                    Some("owned-prefix-token".into()),
                    None,
                )
                .await
                .expect("load and its original notification consumer must progress concurrently");
            assert_eq!(opened.session_id, SESSION);
            {
                let observed = trace.lock().unwrap();
                let header = observed
                    .iter()
                    .position(|(value, _)| {
                        value.get("update").is_none() && value["kind"] == "sessionOpening"
                    })
                    .unwrap();
                assert_eq!(observed[header].0["connectionId"], opened.connection_id);
                assert_eq!(observed[header].0["sessionId"], SESSION);
                assert_eq!(observed[header].0["openToken"], "owned-prefix-token");
                assert_eq!(observed[header].0["cwd"], cwd.to_string_lossy().as_ref());
                assert!(
                    observed
                        .iter()
                        .position(|(value, _)| value.get("update").is_some())
                        .is_none_or(|first| header < first)
                );
            }
            let life = manager
                .session_connection(&row.id, &cwd, SESSION)
                .unwrap()
                .life
                .clone();
            if mode == "burst" {
                let received: Vec<_> = trace
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|(value, _)| value.pointer("/update/sequence").is_some())
                    .cloned()
                    .collect();
                assert_eq!(received.len(), COUNT);
                for (sequence, (value, after_reply)) in received.into_iter().enumerate() {
                    assert_eq!(value, expected(sequence));
                    assert!(
                        !after_reply,
                        "the peer could not reply before the real sink fence"
                    );
                }
                manager
                    .session_prompt(
                        &row.id,
                        &cwd,
                        SESSION,
                        serde_json::from_value(
                            json!([{"type":"text","text":"owned permission after load"}]),
                        )
                        .unwrap(),
                    )
                    .await
                    .unwrap();
                let permission = wait_event(&trace, &changed, |value| {
                    value.get("update").is_none() && value["kind"] == "permissionRequest"
                })
                .await;
                assert_eq!(
                    manager
                        .permission_respond(
                            permission["requestId"].as_str().unwrap(),
                            "yes",
                            SESSION
                        )
                        .unwrap()
                        .status,
                    "submitted"
                );
                let end = wait_event(&trace, &changed, |value| {
                    value.get("update").is_none() && value["kind"] == "turnEnd"
                })
                .await;
                assert_eq!(end["stopReason"], "end_turn");
            } else if mode == "newheader" {
                let value = wait_event(&trace, &changed, |value| {
                    value.pointer("/update/sequence") == Some(&json!(0))
                })
                .await;
                assert_eq!(value, expected(0));
                let values = trace.lock().unwrap();
                assert!(
                    values
                        .iter()
                        .filter(|(value, _)| value["kind"] == "sessionOpening"
                            || value.get("update").is_some())
                        .all(|(_, after)| *after),
                    "new identity and its pending prefix must wait for the actual ID response"
                );
            } else if mode == "configuration" || mode == "request" {
                let values = trace.lock().unwrap().clone();
                let first = values
                    .iter()
                    .position(|(value, _)| value.pointer("/update/sequence") == Some(&json!(0)))
                    .unwrap();
                let last = values
                    .iter()
                    .position(|(value, _)| value.pointer("/update/sequence") == Some(&json!(1)))
                    .unwrap();
                assert!(!values[first].1);
                assert!(
                    !values[last].1,
                    "the peer waits for the actual last-prefix consumer before replying"
                );
                assert_eq!(values[first].0, expected(0));
                assert_eq!(values[last].0, expected(1));
                let barrier = if mode == "configuration" {
                    let index = values
                        .iter()
                        .position(|(value, _)| {
                            value.pointer("/update/sessionUpdate")
                                == Some(&json!("config_option_update"))
                        })
                        .unwrap();
                    assert_eq!(
                        values[index].0["update"]["unknownConfig"],
                        json!([null, false])
                    );
                    assert!(opened.config_options.as_ref().unwrap().as_array().unwrap().iter().any(|option| option["id"] == "model" && option["currentValue"] == "m2"));
                    index
                } else {
                    wait_file(&cwd.join("unknown-request-answered")).await;
                    values
                        .iter()
                        .position(|(value, _)| value["kind"] == "elicitationUnavailable")
                        .unwrap()
                };
                assert!(first < barrier && barrier < last);
                assert!(
                    !values[barrier].1,
                    "configuration and original requests must not block the following raw prefix"
                );
            } else {
                assert!(matches!(mode, "handoff" | "postreply"));
                let initial = wait_event(&trace, &changed, |value| {
                    value["kind"] == "asyncTasks" && value["tasks"][0]["state"] == "running"
                })
                .await;
                assert_eq!(initial["connectionId"], opened.connection_id);
                assert_eq!(initial["tasks"][0]["name"], "Original load task");
                assert!(life.work.load(std::sync::atomic::Ordering::SeqCst) > 0);
                let stop = manager
                    .session_stop_task(&row.id, &cwd, SESSION, &opened.connection_id, "load-task")
                    .await
                    .unwrap();
                assert_eq!(stop["status"], "accepted"); // Method ACK is not completion.
                wait_event(&trace, &changed, |value| {
                    value["kind"] == "asyncTasks" && value["tasks"][0]["state"] == "completed"
                })
                .await;
                assert_eq!(life.work.load(std::sync::atomic::Ordering::SeqCst), 0);
                manager
                    .session_prompt(
                        &row.id,
                        &cwd,
                        SESSION,
                        serde_json::from_value(
                            json!([{"type":"text","text":"verify exact load state handoff"}]),
                        )
                        .unwrap(),
                    )
                    .await
                    .unwrap();
                let end = wait_event(&trace, &changed, |value| {
                    value.get("update").is_none() && value["kind"] == "turnEnd"
                })
                .await;
                assert_eq!(end["stopReason"], "end_turn");
                assert!(
                    end.get("failure").is_none(),
                    "history incident deduplication belongs to the same original tracker"
                );
                wait_event(&trace, &changed, |value| {
                    value["kind"] == "asyncTasks" && value["tasks"][0]["state"] == "completed"
                })
                .await;
                assert_eq!(life.work.load(std::sync::atomic::Ordering::SeqCst), 0);
                let values = trace.lock().unwrap();
                assert!(
                    values
                        .iter()
                        .filter(|(value, _)| value["kind"] == "toolActivity")
                        .all(|(value, _)| value["toolCallIds"] == json!([]))
                );
                assert!(
                    values
                        .iter()
                        .filter(|(value, _)| value["kind"] == "compactionActivity")
                        .all(|(value, _)| value["compactionIds"] == json!([]))
                );
            }
        };
        let mut body = std::pin::pin!(tokio::time::timeout(Duration::from_secs(15), body));
        poll_fn(
            |cx| match catch_unwind(AssertUnwindSafe(|| body.as_mut().poll(cx))) {
                Ok(Poll::Pending) => Poll::Pending,
                Ok(Poll::Ready(value)) => Poll::Ready(Ok(value)),
                Err(panic) => Poll::Ready(Err(panic)),
            },
        )
        .await
    };
    let lives: Vec<Arc<ConnectionLife>> = manager
        .lock()
        .unwrap()
        .values()
        .map(|connection| connection.life.clone())
        .collect();
    manager.stop_for_shutdown();
    let cleanup = tokio::time::timeout(Duration::from_secs(6), async {
        for life in &lives {
            life.closed().await?;
        }
        Ok::<(), String>(())
    })
    .await;
    eprintln!(
        "{}",
        json!({"phase":"owned-load-prefix-cleanup","mode":mode,"owners":lives.len(),
        "cleanupConfirmed":matches!(&cleanup,Ok(Ok(()))),"scope":"locked SDK and native Channel callback only; not renderer ACK or byte budget"})
    );
    assert!(
        matches!(cleanup, Ok(Ok(()))),
        "unknown cleanup cannot become a success"
    );
    match result {
        Ok(value) => value.expect("finite controlled load case"),
        Err(panic) => resume_unwind(panic),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn actual_load_future_and_unknown_prefix_consumer_progress_before_reply() {
    run("burst").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn actual_load_configuration_and_full_following_fifo_progress_before_response() {
    run("configuration").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn actual_load_original_unknown_request_and_following_fifo_progress_before_response() {
    run("request").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn actual_load_handoff_keeps_same_activity_task_and_incident_owners() {
    run("handoff").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ordinary_reply_first_load_preserves_the_existing_activity_and_prompt_control() {
    run("postreply").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn actual_new_identity_header_precedes_pending_prefix_only_after_real_id_response() {
    run("newheader").await;
}
