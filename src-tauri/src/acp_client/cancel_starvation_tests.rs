//! A real manager/pump/stdio queue-order counterexample using a synthetic peer.
//! No real Agent, account, model, installed application, or extra runtime loop.
use super::{
    manager::AcpManager,
    pump::{SessionControl, SessionSink},
};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use std::{
    future::{Future, poll_fn},
    path::Path,
    sync::{Arc, Condvar, Mutex},
    task::Poll,
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};

const BACKLOG: usize = 32;
const PEER: &str = r#"
import sys,json,pathlib,threading,time
count=int(sys.argv[1]); fence=pathlib.Path(sys.argv[2]); prompt=None
idle_burst=sys.argv[3]=='idle'
def send(v): print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def reply(m,r): send({'id':m['id'],'result':r})
def update(text): send({'method':'session/update','params':{'sessionId':'backlog','update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':text}}}})
def burst():
 for n in range(count): update('queued-'+str(n))
 # No sessionId: the incoming actor must handle this after routing all prior
 # updates, without entering the blocked session pump. Its error response is
 # an inbox fence, whereas stdout.flush() alone would not prove dispatch.
 send({'id':900,'method':'fixture/inbox_fence','params':{}})
def idle_updates():
 until=time.monotonic()+10
 while not fence.with_name('start-idle-burst').exists():
  assert time.monotonic()<until, 'fixture idle trigger timed out'
  time.sleep(.005)
 burst()
if idle_burst: threading.Thread(target=idle_updates,daemon=True).start()
for line in sys.stdin:
 m=json.loads(line); method=m.get('method')
 if method=='initialize': reply(m,{'protocolVersion':1,'agentCapabilities':{},'authMethods':[]})
 elif method=='session/new': reply(m,{'sessionId':'backlog'})
 elif method=='session/prompt':
  prompt=m
  if idle_burst: update('prompt-started')
  else: burst()
 elif method is None and m.get('id')==900:
  assert m.get('error',{}).get('code')==-32601, m
  ready=fence.with_suffix('.tmp'); ready.write_text('prior-updates-dispatched'); ready.replace(fence)
 elif method=='session/cancel':
  if prompt is None: update('cancel-without-prompt')
  else:
   update('cleanup-after-cancel')
   reply(prompt,{'stopReason':'cancelled'}); prompt=None
"#;

#[derive(Default)]
struct FirstUpdateGate {
    released: Mutex<bool>,
    changed: Condvar,
}

impl FirstUpdateGate {
    fn wait(&self) {
        // Bound fixture failures so this cannot permanently pin a shared
        // runtime worker even when the test panics before reaching release.
        let (released, _) = self
            .changed
            .wait_timeout_while(
                self.released.lock().unwrap(),
                Duration::from_secs(10),
                |released| !*released,
            )
            .unwrap();
        assert!(*released, "fixture must release the first update");
    }

    fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.changed.notify_all();
    }
}

struct Cleanup {
    gate: Arc<FirstUpdateGate>,
    manager: Arc<AcpManager>,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        self.gate.release();
        self.manager.stop_for_shutdown();
    }
}

async fn next_update(rx: &mut mpsc::UnboundedReceiver<Value>) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = rx.recv().await.expect("fixture session remains open");
            if event.get("update").is_some() {
                return event;
            }
        }
    })
    .await
    .expect("bounded fixture event")
}

async fn await_inbox_fence(path: &Path) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match std::fs::read_to_string(path) {
                Ok(receipt) => {
                    assert_eq!(receipt, "prior-updates-dispatched");
                    return;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => panic!("reading fixture fence: {error}"),
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("protocol actor must acknowledge queued updates while pump is gated");
}

#[derive(Clone, Copy, PartialEq)]
enum QueueOrder {
    RunningPrompt,
    PromptThenCancel,
    CancelThenPrompt,
    AbandonedThenCancel,
    ExpiredThenCancel,
}

async fn cancellation_with_backlog(order: QueueOrder) {
    let prompt_queued_behind_updates = matches!(
        order,
        QueueOrder::PromptThenCancel | QueueOrder::CancelThenPrompt
    );
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    let script = cwd.join("peer.py");
    let fence = cwd.join("inbox-ready");
    std::fs::write(&script, PEER).unwrap();
    let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
    let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
    let gate = Arc::new(FirstUpdateGate::default());
    let _cleanup = Cleanup {
        gate: gate.clone(),
        manager: manager.clone(),
    };
    let row = AgentRow {
        id: "cancel-backlog-fixture".into(),
        name: "Fixture".into(),
        source: "custom".into(),
        command: crate::platform_tests::python(),
        args: vec![
            "-u".into(),
            script.to_string_lossy().into(),
            BACKLOG.to_string(),
            fence.to_string_lossy().into(),
            if prompt_queued_behind_updates {
                "idle"
            } else {
                "running"
            }
            .into(),
        ],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    };
    store.insert_agent(&row).unwrap();
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    let sink_gate = gate.clone();
    let sink: SessionSink = Arc::new(move |event| {
        let first = event.pointer("/update/content/text") == Some(&json!("queued-0"));
        let _ = event_tx.send(event);
        if first {
            sink_gate.wait();
        }
    });
    let opened = manager
        .open_session(&row, &cwd, None, vec![], sink, &store)
        .await
        .unwrap();
    // These two controls test ordering AFTER admission, at the real pump
    // queue. A first Pending of outer admission now may be its policy read,
    // which does not prove a Prompt has entered that queue. Acquire the real
    // pool permit first, before gating the sink, then poll the actual enqueue.
    // The conservative fixture ticket is not a whole-request charge proof.
    let granted = if prompt_queued_behind_updates {
        let (connection_id, expected_current, _) = manager
            .prompt_snapshot(&row.id, &cwd, &opened.session_id)
            .unwrap();
        let owner = manager
            .prompt_admission
            .fixture_owner("owned-pump-order", "queued", &row.id);
        let waiting = manager
            .prompt_admission
            .enqueue_prompt(owner.clone(), 4096)
            .unwrap();
        let receipt_id = waiting.receipt_id();
        Some(super::active_prompt::Granted {
            permit: waiting.acquire().await.unwrap(),
            owner,
            connection_id,
            session_id: opened.session_id.clone(),
            expected_current,
            progress: Arc::new(|_| Ok(())),
            deadline: tokio::time::Instant::now() + Duration::from_secs(60),
            receipt_id,
        })
    } else {
        None
    };
    let mut prompt = std::pin::pin!(async {
        let blocks = serde_json::from_value(json!([{"type":"text","text":"run"}])).unwrap();
        if let Some(granted) = granted {
            manager
                .send_granted_prompt(&row.id, &cwd, &opened.session_id, blocks, granted)
                .await
                .map_err(|error| match error {
                    super::active_prompt::DispatchFailure::Error(error) => error,
                    super::active_prompt::DispatchFailure::Deadline => {
                        "session prompt deadline elapsed".into()
                    }
                })
        } else {
            manager
                .session_prompt(&row.id, &cwd, &opened.session_id, blocks)
                .await
        }
    });
    if prompt_queued_behind_updates {
        std::fs::write(fence.with_file_name("start-idle-burst"), "start").unwrap();
    } else {
        prompt.as_mut().await.unwrap();
    }
    assert_eq!(
        next_update(&mut event_rx).await["update"]["content"]["text"],
        "queued-0"
    );
    await_inbox_fence(&fence).await;

    if order == QueueOrder::AbandonedThenCancel {
        let mut abandoned = Box::pin(manager.session_cancel(&row.id, &cwd, &opened.session_id));
        poll_fn(|context| {
            assert!(matches!(abandoned.as_mut().poll(context), Poll::Pending));
            Poll::Ready(())
        })
        .await;
        drop(abandoned);
    }
    let mut expired_reply = None;
    if order == QueueOrder::ExpiredThenCancel {
        // Inject an already expired control while retaining its receiver to
        // distinguish deadline rejection from caller-disappearance rejection.
        let connection = manager
            .session_connection(&row.id, &cwd, &opened.session_id)
            .unwrap();
        let (result, receive) = oneshot::channel();
        connection.sessions.lock().unwrap()[&opened.session_id]
            .control
            .send(SessionControl::Cancel {
                deadline: tokio::time::Instant::now(),
                result,
            })
            .unwrap();
        expired_reply = Some(receive);
    }

    if order == QueueOrder::PromptThenCancel {
        poll_fn(|context| {
            assert!(matches!(prompt.as_mut().poll(context), Poll::Pending));
            Poll::Ready(())
        })
        .await;
    }

    let mut cancel = std::pin::pin!(manager.session_cancel(&row.id, &cwd, &opened.session_id));
    // Poll the product entrypoint once while the pump is gated. Its first
    // Pending follows the synchronous enqueue and starts awaiting the reply.
    // Merely spawning this future would leave an enqueue scheduling race.
    poll_fn(|context| {
        assert!(matches!(cancel.as_mut().poll(context), Poll::Pending));
        Poll::Ready(())
    })
    .await;
    if order == QueueOrder::CancelThenPrompt {
        poll_fn(|context| {
            assert!(matches!(prompt.as_mut().poll(context), Poll::Pending));
            Poll::Ready(())
        })
        .await;
    }
    gate.release();
    if prompt_queued_behind_updates {
        tokio::time::timeout(Duration::from_secs(5), prompt)
            .await
            .expect("bounded queued prompt admission")
            .unwrap();
    }
    tokio::time::timeout(Duration::from_secs(5), cancel)
        .await
        .expect("bounded cancel dispatch")
        .unwrap();
    if let Some(receive) = expired_reply {
        assert!(receive.await.is_err(), "expired control must be discarded");
    }
    if order == QueueOrder::CancelThenPrompt {
        // This later Prompt represents a distinct explicit request. It must
        // start after the first Cancel, then accept its own later cancellation.
        manager
            .session_cancel(&row.id, &cwd, &opened.session_id)
            .await
            .unwrap();
    }

    let (delivered_at_cancel, delivered) = tokio::time::timeout(Duration::from_secs(5), async {
        let mut delivered = vec!["queued-0".to_string()];
        let mut delivered_at_cancel = None;
        let mut cancellations_sent = 0;
        let mut cleanup_seen = false;
        let mut wire_order = Vec::new();
        loop {
            let event = event_rx.recv().await.unwrap();
            if let Some(text) = event
                .pointer("/update/content/text")
                .and_then(Value::as_str)
            {
                if text == "cancel-without-prompt" {
                    assert!(
                        order == QueueOrder::CancelThenPrompt,
                        "Cancel overtook an earlier queued Prompt and allowed work to start after stopping"
                    );
                    wire_order.push("cancel");
                } else if text == "prompt-started" {
                    wire_order.push("prompt");
                }
                if text.starts_with("queued-") {
                    delivered.push(text.to_string());
                } else if text == "cleanup-after-cancel" {
                    cleanup_seen = true;
                    wire_order.push("cancel");
                }
            }
            if event["kind"] == "interactionsCancelled" {
                delivered_at_cancel = Some(delivered.len());
                cancellations_sent += 1;
            }
            if event["kind"] == "turnEnd" {
                assert_eq!(event["stopReason"], "cancelled");
                assert!(cleanup_seen, "post-cancel update must precede turnEnd");
                assert_eq!(cancellations_sent, if order == QueueOrder::CancelThenPrompt { 2 } else { 1 });
                match order {
                    QueueOrder::RunningPrompt | QueueOrder::AbandonedThenCancel | QueueOrder::ExpiredThenCancel => assert_eq!(wire_order, ["cancel"]),
                    QueueOrder::PromptThenCancel => assert_eq!(wire_order, ["prompt", "cancel"]),
                    QueueOrder::CancelThenPrompt => assert_eq!(wire_order, ["cancel", "prompt", "cancel"]),
                }
                break;
            }
        }
        (
            delivered_at_cancel.expect("actual cancel was sent"),
            delivered,
        )
    })
    .await
    .expect("synthetic peer must confirm cancellation");
    assert_eq!(
        delivered,
        (0..BACKLOG)
            .map(|n| format!("queued-{n}"))
            .collect::<Vec<_>>(),
        "fair cancellation must still preserve every update and its order"
    );
    if !prompt_queued_behind_updates {
        assert!(
            delivered_at_cancel < BACKLOG,
            "Cancel was already queued with {} inbox updates ready, but the pump delivered all {delivered_at_cancel} updates before sending it",
            BACKLOG - 1
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn cancellation_is_serviced_before_a_ready_update_backlog_is_drained() {
    cancellation_with_backlog(QueueOrder::RunningPrompt).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn cancellation_does_not_overtake_an_earlier_queued_prompt() {
    cancellation_with_backlog(QueueOrder::PromptThenCancel).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_later_explicit_prompt_does_not_overtake_queued_cancellation() {
    cancellation_with_backlog(QueueOrder::CancelThenPrompt).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn abandoned_cancellation_is_not_sent_by_the_fast_path() {
    cancellation_with_backlog(QueueOrder::AbandonedThenCancel).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn expired_cancellation_is_not_sent_by_the_fast_path() {
    cancellation_with_backlog(QueueOrder::ExpiredThenCancel).await;
}
