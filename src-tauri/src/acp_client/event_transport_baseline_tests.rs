//! Controlled baseline: real manager/stdio + actual Channel serialization/callback.
//! Not WebView eval/fetch, renderer acknowledgement, memory/RSS or a production cap.
use super::{lifecycle::ConnectionLife, manager::AcpManager, pump::SessionSink};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    future::{Future, poll_fn},
    panic::{AssertUnwindSafe, catch_unwind, resume_unwind},
    path::Path,
    sync::{Arc, Condvar, Mutex},
    task::Poll,
    time::Duration,
};
use tokio::sync::mpsc;

const FRAMES: usize = 64;
const TEXT_BYTES: usize = 16 * 1024;
const PEER: &str = r#"
import sys,json,pathlib
fence=pathlib.Path(sys.argv[1]); mode=sys.argv[2]; prompt=None
def send(v): print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def reply(m,r): send({'id':m['id'],'result':r})
for line in sys.stdin:
 m=json.loads(line); method=m.get('method')
 if method=='initialize': reply(m,{'protocolVersion':1,'agentCapabilities':{},'authMethods':[]})
 elif method=='session/new': reply(m,{'sessionId':'transport-owned'})
 elif method=='session/prompt':
  assert prompt is None; prompt=m
  for n in range(64):
   send({'method':'session/update','params':{'sessionId':'transport-owned','update':{'sessionUpdate':'_fixture/raw-opaque','sequence':n,'text':'x'*16384,'unknown':{'array':[None,False,n],'extra':'preserve'}},'unknownEnvelope':{'n':n,'nil':None}}})
  if mode=='approval':
   send({'id':901,'method':'session/request_permission','params':{'sessionId':'transport-owned','toolCall':{'toolCallId':'owned-tool','title':'Controlled approval','kind':'read'},'options':[{'optionId':'yes','name':'Allow','kind':'allow_once'}]}})
  send({'id':900,'method':'fixture/transport_fence','params':{}})
 elif method is None and m.get('id')==900:
  assert m.get('error',{}).get('code')==-32601, m
  pending=fence.with_suffix('.pending'); pending.write_text('prior-frames-routed'); pending.replace(fence)
 elif method is None and m.get('id')==901:
  assert mode=='approval' and m['result']['outcome']['outcome']=='selected' and m['result']['outcome']['optionId']=='yes', m
  reply(prompt,{'stopReason':'end_turn'}); prompt=None
 elif method=='session/cancel':
  assert mode=='stop' and prompt is not None
  send({'method':'session/update','params':{'sessionId':'transport-owned','update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'owned-cancel-received'}}}})
  reply(prompt,{'stopReason':'cancelled'}); prompt=None
"#;

#[derive(Default)]
struct Gate {
    released: Mutex<bool>,
    changed: Condvar,
}
impl Gate {
    fn hold(&self) {
        let (released, _) = self
            .changed
            .wait_timeout_while(
                self.released.lock().unwrap(),
                Duration::from_secs(10),
                |v| !*v,
            )
            .unwrap();
        let signalled = *released;
        drop(released);
        assert!(
            signalled,
            "controlled callback must be released, not silently timed out"
        );
    }
    fn release(&self) {
        // Cleanup must not panic before requesting the same manager's stop,
        // even if a failed callback had poisoned this test-only gate.
        let mut released = self
            .released
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *released = true;
        drop(released);
        self.changed.notify_all();
    }
}
struct Stop {
    gate: Arc<Gate>,
    manager: Arc<AcpManager>,
}
impl Drop for Stop {
    fn drop(&mut self) {
        self.gate.release();
        self.manager.stop_for_shutdown();
    }
}
#[derive(Default)]
struct Trace {
    frames: Vec<(usize, [u8; 32])>,
    callbacks: usize,
    cancel_at: Option<usize>,
}
fn expected(sequence: usize) -> Value {
    json!({"sessionUpdate":"_fixture/raw-opaque","sequence":sequence,"text":"x".repeat(TEXT_BYTES),"unknown":{"array":[null,false,sequence],"extra":"preserve"}})
}
fn digest(value: &Value) -> [u8; 32] {
    Sha256::digest(serde_json::to_vec(value).unwrap()).into()
}
async fn fence(path: &Path) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match std::fs::read_to_string(path) {
                Ok(value) => {
                    assert_eq!(value, "prior-frames-routed");
                    break;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => panic!("owned fence read failed"),
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("actual incoming actor must acknowledge its routing prefix");
}

async fn observe(
    mode: &'static str,
    manager: &Arc<AcpManager>,
    gate: &Arc<Gate>,
    cwd: &Path,
    store: &MetaStore,
    lives: &mut Vec<Arc<ConnectionLife>>,
    controls: &mut (mpsc::UnboundedSender<Value>, mpsc::UnboundedReceiver<Value>),
) {
    let script = cwd.join("peer.py");
    let marker = cwd.join("routed");
    std::fs::write(&script, PEER).unwrap();
    let row = AgentRow {
        id: format!("public-transport-{mode}"),
        name: "Fixture".into(),
        source: "custom".into(),
        command: crate::platform_tests::python(),
        args: vec![
            "-u".into(),
            script.display().to_string(),
            marker.display().to_string(),
            mode.into(),
        ],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    };
    store.insert_agent(&row).unwrap();
    let trace = Arc::new(Mutex::new(Trace::default()));
    let observed = trace.clone();
    let callback_gate = gate.clone();
    let (send, receive) = controls;
    let send = send.clone();
    let channel = tauri::ipc::Channel::<Value>::new(move |body| {
        // Actual public Channel.send serialization + its controlled callback.
        // Only the fixture's 64 hashes/indices are retained; full payloads are dropped.
        let value = body.deserialize::<Value>().unwrap();
        let sequence = value.pointer("/update/sequence").and_then(Value::as_u64);
        if let Some(sequence) = sequence {
            assert!(sequence < FRAMES as u64);
            assert_eq!(
                value,
                json!({"sessionId":"transport-owned","update":expected(sequence as usize),"unknownEnvelope":{"n":sequence,"nil":null}})
            );
            let mut state = observed.lock().unwrap();
            assert_eq!(
                sequence as usize,
                state.frames.len(),
                "no missing/reordered unknown envelope"
            );
            state.frames.push((sequence as usize, digest(&value)));
            state.callbacks += 1;
            drop(state);
            if sequence == 0 {
                send.send(json!({"firstCallback":true})).unwrap();
                callback_gate.hold();
            }
        } else if value.get("kind").is_some() || value.pointer("/update/content/text").is_some() {
            if value["kind"] == "interactionsCancelled" {
                let mut state = observed.lock().unwrap();
                assert!(state.cancel_at.is_none());
                state.cancel_at = Some(state.frames.len());
            }
            // Small controls only. These do not implement a second event store.
            send.send(value).unwrap();
        }
        Ok(())
    });
    let sink: SessionSink = Arc::new(move |value| {
        channel.send(value).unwrap();
    });
    let opened = manager
        .open_session(&row, cwd, None, vec![], sink, store)
        .await
        .unwrap();
    lives.push(
        manager
            .session_connection(&row.id, cwd, &opened.session_id)
            .unwrap()
            .life
            .clone(),
    );
    manager
        .session_prompt(
            &row.id,
            cwd,
            &opened.session_id,
            serde_json::from_value(json!([{"type":"text","text":"owned baseline"}])).unwrap(),
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while receive.recv().await.unwrap().get("firstCallback") != Some(&Value::Bool(true)) {}
    })
    .await
    .expect("actual Channel callback reached");
    fence(&marker).await;
    assert_eq!(trace.lock().unwrap().frames.len(), 1);
    // The acknowledged SDK routing prefix and the blocked sole pump sink prove
    // at least63 still-undelivered updates, not an RSS or queue allocator count.
    eprintln!(
        "{}",
        json!({"phase":"callback-held-routing-fence","mode":mode,
        "ownedFrames":FRAMES,"textBytesPerFrame":TEXT_BYTES,"callbacksCompletedOrEntered":1,
        "undeliveredFrameLowerBound":FRAMES-1,"minimumTextBytesUndelivered":(FRAMES-1)*TEXT_BYTES,
        "scope":"real stdio and Tauri controlled callback; no WebView or memory measurement"})
    );
    if mode == "stop" {
        let mut cancel = std::pin::pin!(manager.session_cancel(&row.id, cwd, &opened.session_id));
        poll_fn(|cx| {
            assert!(cancel.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        gate.release();
        tokio::time::timeout(Duration::from_secs(5), cancel)
            .await
            .unwrap()
            .unwrap();
    } else {
        gate.release();
    }
    let mut approval = 0;
    let mut cancel = 0;
    let mut delivered_at_cancel = None;
    let mut cleanup = false;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let event = receive.recv().await.unwrap();
            if event["kind"] == "permissionRequest" {
                assert_eq!(mode, "approval");
                assert_eq!(approval, 0);
                assert_eq!(event["request"]["toolCall"]["toolCallId"], "owned-tool");
                let request = event["requestId"].as_str().unwrap();
                assert_eq!(
                    manager
                        .permission_respond(request, "yes", &opened.session_id)
                        .unwrap()
                        .status,
                    "submitted"
                );
                approval += 1;
            }
            if event["kind"] == "interactionsCancelled" {
                cancel += 1;
                delivered_at_cancel = Some(trace.lock().unwrap().frames.len());
            }
            if event.pointer("/update/content/text") == Some(&json!("owned-cancel-received")) {
                cleanup = true;
            }
            if event["kind"] == "turnEnd" {
                assert_eq!(
                    event["stopReason"],
                    if mode == "stop" {
                        "cancelled"
                    } else {
                        "end_turn"
                    }
                );
                break;
            }
        }
    })
    .await
    .expect("finite owned stop/approval result");
    let trace = trace.lock().unwrap();
    assert_eq!(trace.callbacks, FRAMES);
    assert_eq!(trace.frames,(0..FRAMES).map(|n|(n,digest(&json!({"sessionId":"transport-owned","update":expected(n),"unknownEnvelope":{"n":n,"nil":null}})))).collect::<Vec<_>>());
    if mode == "stop" {
        assert_eq!(cancel, 1);
        assert!(cleanup);
        assert_eq!(approval, 0);
        // Note: callback trace is sampled when the test receives this tiny event,
        // not at native publication; it is reported but not a false timing bound.
        assert!(delivered_at_cancel.is_some());
        assert!(
            trace.cancel_at.is_some_and(|count| count < FRAMES),
            "existing stop bypass must not wait for full sink backlog"
        );
    } else {
        assert_eq!(approval, 1);
        assert_eq!(cancel, 0);
    }
    eprintln!(
        "{}",
        json!({"phase":"consumed-controls-and-raw","mode":mode,
        "rawOrderedExact":trace.frames.len(),"approvalSubmitted":approval,"cancelDispatchReceipts":cancel,
        "callbackCountAtActualCancelCallback":trace.cancel_at,"callbackCountWhenTestObservedCancel":delivered_at_cancel,
        "scope":"not a latency target or render-consumed acknowledgement"})
    );
}

async fn baseline(mode: &'static str) {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
    let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
    let gate = Arc::new(Gate::default());
    let _stop = Stop {
        gate: gate.clone(),
        manager: manager.clone(),
    };
    let mut lives = Vec::new();
    // The small control observer belongs to the complete baseline, including
    // real process cleanup. Closing observe() must not make the actual sink
    // panic on its subsequent process-ended notifications.
    let mut controls = mpsc::unbounded_channel::<Value>();
    let outcome = {
        let run = tokio::time::timeout(
            Duration::from_secs(30),
            observe(
                mode,
                &manager,
                &gate,
                &cwd,
                &store,
                &mut lives,
                &mut controls,
            ),
        );
        let mut run = std::pin::pin!(run);
        poll_fn(
            |cx| match catch_unwind(AssertUnwindSafe(|| run.as_mut().poll(cx))) {
                Ok(Poll::Pending) => Poll::Pending,
                Ok(Poll::Ready(v)) => Poll::Ready(Ok(v)),
                Err(p) => Poll::Ready(Err(p)),
            },
        )
        .await
    };
    gate.release();
    manager.stop_for_shutdown();
    // Include any connection created before an open/setup error, rather than
    // only the successful route. Snapshot under lock, await real owners outside.
    let remaining: Vec<_> = manager
        .lock()
        .unwrap()
        .values()
        .map(|c| c.life.clone())
        .collect();
    for life in remaining {
        if !lives.iter().any(|old| Arc::ptr_eq(old, &life)) {
            lives.push(life);
        }
    }
    let cleanup = tokio::time::timeout(Duration::from_secs(6), async {
        for life in &lives {
            life.closed().await?;
        }
        Ok::<(), String>(())
    })
    .await;
    eprintln!(
        "{}",
        json!({"phase":"exact-owner-cleanup","mode":mode,"registeredOwners":lives.len(),
        "cleanupConfirmed":matches!(&cleanup,Ok(Ok(()))),"notProductComplete":true})
    );
    match outcome {
        Err(p) => resume_unwind(p),
        Ok(v) => v.expect("30s fixture observation budget"),
    }
    assert_eq!(lives.len(), 1);
    assert!(
        matches!(cleanup, Ok(Ok(()))),
        "unknown cleanup is failure, never closed proof"
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn real_stdio_tauri_callback_backlog_preserves_unknowns_and_stop() {
    baseline("stop").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn real_stdio_tauri_callback_backlog_preserves_unknowns_and_approval() {
    baseline("approval").await;
}
