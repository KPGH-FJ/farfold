//! Unexecuted real manager/official-stdio controls. Owned public content only.
use super::{
    active_prompt::{Input, Phase, Progress, Request},
    history_admission::{Admission, Cancel, Policy},
    lifecycle::ConnectionLife,
    manager::AcpManager,
    pump::SessionSink,
};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    future::{Future, poll_fn},
    panic::{AssertUnwindSafe, catch_unwind, resume_unwind},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    task::Poll,
    time::Duration,
};
use tokio::{sync::mpsc, time::Instant};

// Source compatibility belongs wholly to this TEST FILE. Every old test call
// now enters the same mandatory global pool and actual ModelGuard checks.
impl AcpManager {
    pub(crate) async fn session_prompt(
        &self,
        agent: &str,
        cwd: &std::path::Path,
        session: &str,
        blocks: Vec<agent_client_protocol::schema::v1::ContentBlock>,
    ) -> Result<(), String> {
        let (connection_id, expected_current, store) = self.prompt_snapshot(agent, cwd, session)?;
        let owner = self.prompt_admission.fixture_owner(
            "owned-test-window",
            &super::manager::next_connection_id(),
            agent,
        );
        self.admit_prompt(Input {
            agent,
            cwd,
            session,
            blocks,
            store: &store,
            request: Request {
                owner,
                connection_id,
                expected_current,
                progress: Arc::new(|_| Ok(())),
                deadline: Instant::now() + Duration::from_secs(60),
            },
        })
        .await
    }
}
const TEXT_BYTES: usize = 64 * 1024;
const MAX_EVENTS: usize = 128;
#[cfg(windows)]
#[path = "active_prompt_eof_descendant_windows_tests.rs"]
mod eof_descendant_tests;
const PEER: &str = r#"
import sys,json,pathlib,threading,time,hashlib
count=int(sys.argv[1]); fence=pathlib.Path(sys.argv[2]); prompt=None
sid=sys.argv[4]; mode=sys.argv[5]; drift=fence.with_suffix('.drift')
idle_burst=sys.argv[3]=='idle'
def send(v): print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def reply(m,r): send({'id':m['id'],'result':r})
def update(text): send({'method':'session/update','params':{'sessionId':sid,'update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':text}}}})
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
def options():
 model=drift.read_text() if drift.exists() else 'm1'
 return [] if mode=='empty' else [{'id':'model','name':'Model','category':'model','type':'select','currentValue':model,'options':[{'value':'m1','name':'One'},{'value':'m2','name':'Two'}]}]
def observe_drift():
 until=time.monotonic()+20
 while not drift.exists() and time.monotonic()<until: time.sleep(.005)
 if drift.exists(): send({'method':'session/update','params':{'sessionId':sid,'update':{'sessionUpdate':'config_option_update','configOptions':options()}}})
if mode=='drift': threading.Thread(target=observe_drift,daemon=True).start()
for line in sys.stdin:
 m=json.loads(line); method=m.get('method')
 if method=='initialize': reply(m,{'protocolVersion':1,'agentCapabilities':{},'authMethods':[]})
 elif method=='session/new': reply(m,{'sessionId':sid,'configOptions':options()})
 elif method=='session/prompt':
  prompt=m
  digest=hashlib.sha256()
  for part in json.JSONEncoder(sort_keys=True,separators=(',',':'),ensure_ascii=False).iterencode(m.get('params',{}).get('prompt',[])):
   digest.update(part.encode('utf-8'))
  update('owned-start:'+digest.hexdigest())
  if idle_burst: update('prompt-started')
  else: burst()
  if mode=='pump-panic': update('owned-pump-panic')
  if mode=='matched-error':
   send({'id':'another-request','error':{'code':-32603,'message':'unrelated'}})
   send({'id':m['id'],'error':{'code':-32000,'message':'owned matched failure'}})
  if mode=='eof':
   import signal,os
   signal.signal(signal.SIGTERM,signal.SIG_IGN)
   os.close(1)
   time.sleep(5)
   sys.exit(7)
 elif method is None and m.get('id')==900:
  assert m.get('error',{}).get('code')==-32601, m
  ready=fence.with_suffix('.tmp'); ready.write_text('prior-updates-dispatched'); ready.replace(fence)
 elif method=='session/cancel':
  if prompt is None: update('cancel-without-prompt')
  else:
   update('cleanup-after-cancel')
   reply(prompt,{'stopReason':'cancelled'}); prompt=None
"#;

struct Suite {
    _root: tempfile::TempDir,
    cwd: PathBuf,
    store: MetaStore,
    manager: Arc<AcpManager>,
    lives: Vec<Arc<ConnectionLife>>,
}
impl Drop for Suite {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}
struct Conversation {
    agent: String,
    pid: u32,
    session: String,
    connection: String,
    current: Value,
    events: mpsc::UnboundedReceiver<Value>,
    fence: PathBuf,
    panic_seen: Arc<AtomicBool>,
}
impl Suite {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().canonicalize().unwrap();
        let store = MetaStore::open(&cwd.join("metadata.db")).unwrap();
        std::fs::write(cwd.join("peer.py"), PEER).unwrap();
        let mut manager = AcpManager::new(cwd.join("logs"), cwd.clone());
        manager.prompt_admission = Admission::new(Policy {
            active: 2,
            pending: 4,
            bytes: 1024 * 1024,
        })
        .unwrap();
        Self {
            _root: root,
            cwd,
            store,
            manager: Arc::new(manager),
            lives: Vec::new(),
        }
    }
    async fn open(&mut self, index: usize, agent: &str, mode: &str) -> Conversation {
        let fence = self.cwd.join(format!("fence-{index}"));
        let sid = format!("owned-session-{index}");
        let row = AgentRow {
            id: agent.into(),
            name: "Fixture".into(),
            source: "custom".into(),
            command: crate::platform_tests::python(),
            args: vec![
                "-u".into(),
                self.cwd.join("peer.py").to_string_lossy().into(),
                "0".into(),
                fence.to_string_lossy().into(),
                "running".into(),
                sid.clone(),
                mode.into(),
            ],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        if self.store.get_agent(agent).unwrap().is_none() {
            self.store.insert_agent(&row).unwrap();
        }
        let (send, events) = mpsc::unbounded_channel();
        let panic_seen = Arc::new(AtomicBool::new(false));
        let observed = panic_seen.clone();
        let sink: SessionSink = Arc::new(move |event| {
            if event
                .pointer("/update/content/text")
                .and_then(Value::as_str)
                == Some("owned-pump-panic")
            {
                observed.store(true, Ordering::SeqCst);
                panic!("owned pump panic fixture");
            }
            let _ = send.send(event);
        });
        let opened = self
            .manager
            .open_session(&row, &self.cwd, None, vec![], sink, &self.store)
            .await
            .unwrap();
        let connection = self
            .manager
            .session_connection(agent, &self.cwd, &opened.session_id)
            .unwrap();
        assert!(
            self.lives
                .iter()
                .all(|life| !Arc::ptr_eq(life, &connection.life))
        );
        self.lives.push(connection.life.clone());
        let pid = connection.child_pid.load(Ordering::SeqCst);
        assert_ne!(pid, 0);
        Conversation {
            agent: agent.into(),
            pid,
            session: opened.session_id,
            connection: connection.connection_id,
            current: opened.config_check.current,
            events,
            fence,
            panic_seen,
        }
    }
    fn request(
        &self,
        c: &Conversation,
        token: &str,
        deadline: Instant,
    ) -> (Request, mpsc::UnboundedReceiver<Progress>) {
        let owner = self
            .manager
            .prompt_admission
            .fixture_owner("owned-window", token, &c.agent);
        let (send, receive) = mpsc::unbounded_channel();
        (
            Request {
                owner,
                connection_id: c.connection.clone(),
                expected_current: c.current.clone(),
                deadline,
                progress: Arc::new(move |event| {
                    send.send(event).map_err(|_| "owned receiver closed".into())
                }),
            },
            receive,
        )
    }
}
fn blocks(index: usize) -> (Vec<agent_client_protocol::schema::v1::ContentBlock>, String) {
    let prefix = format!("FARFOLD_PUBLIC_PROMPT_{index}:");
    let text = prefix.clone() + &"x".repeat(TEXT_BYTES - prefix.len());
    let canonical = [BTreeMap::from([("text", text.as_str()), ("type", "text")])];
    let digest = Sha256::digest(serde_json::to_vec(&canonical).unwrap())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    (
        serde_json::from_value(json!([{"type":"text","text":text}])).unwrap(),
        digest,
    )
}
async fn start(c: &mut Conversation, expected: &str) {
    for _ in 0..MAX_EVENTS {
        let event = c.events.recv().await.expect("owned channel");
        if let Some(text) = event
            .pointer("/update/content/text")
            .and_then(Value::as_str)
            && text.starts_with("owned-start:")
        {
            assert_eq!(text, &format!("owned-start:{expected}"));
            return;
        }
        assert_ne!(event["kind"], "turnEnd");
    }
    panic!("bounded selected events exceeded");
}
async fn terminal(c: &mut Conversation) {
    let mut cleanup = false;
    for _ in 0..MAX_EVENTS {
        let event = c.events.recv().await.expect("owned channel");
        if event
            .pointer("/update/content/text")
            .and_then(Value::as_str)
            == Some("cleanup-after-cancel")
        {
            cleanup = true;
        }
        if event["kind"] == "turnEnd" {
            assert!(cleanup);
            assert_eq!(event["stopReason"], "cancelled");
            return;
        }
    }
    panic!("bounded selected events exceeded");
}
async fn waiting(rx: &mut mpsc::UnboundedReceiver<Progress>) -> u64 {
    let event = rx.recv().await.unwrap();
    assert_eq!(event.phase, Phase::Waiting);
    event.receipt_id
}
async fn actor_fence(c: &Conversation) {
    loop {
        if let Ok(value) = std::fs::read_to_string(&c.fence) {
            assert_eq!(value, "prior-updates-dispatched");
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}
async fn cleanup(suite: &Suite) {
    suite.manager.stop_for_shutdown();
    let result = tokio::time::timeout(Duration::from_secs(6), async {
        for life in &suite.lives {
            life.closed().await?;
        }
        Ok::<(), String>(())
    })
    .await;
    assert!(matches!(result, Ok(Ok(()))), "owned cleanup pending/failed");
    assert_eq!(suite.manager.prompt_admission.counts(), (0, 0, 0));
}
async fn checked(
    run: impl for<'a> FnOnce(&'a mut Suite) -> std::pin::Pin<Box<dyn Future<Output = ()> + 'a>>,
) {
    let mut suite = Suite::new();
    let outcome = {
        let run = tokio::time::timeout(Duration::from_secs(30), run(&mut suite));
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
    cleanup(&suite).await;
    match outcome {
        Err(p) => resume_unwind(p),
        Ok(v) => v.expect("bounded owned body"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_active_third_waits_cancelled_queue_preserves_survivor_and_cwd_controls() {
    checked(|s| Box::pin(async move {
        let mut a=s.open(0,"agent-a","empty").await;
    let mut b=s.open(1,"agent-b","empty").await;let mut c=s.open(2,"agent-c","empty").await;
    // Actual no-configOptions snapshot stays legitimate; never invent a model.
    assert_eq!(a.current,json!({"choices":[]}));

        let (ba,da)=blocks(0);let (bb,db)=blocks(1);
        s.manager.session_prompt(&a.agent,&s.cwd,&a.session,ba).await.unwrap();
        s.manager.session_prompt(&b.agent,&s.cwd,&b.session,bb).await.unwrap();
        start(&mut a,&da).await;start(&mut b,&db).await;actor_fence(&a).await;actor_fence(&b).await;
        {
        let (request,mut progress)=s.request(&c,"cancelled-waiter",Instant::now()+Duration::from_secs(60));
        let owner=request.owner.clone();let (bc,_)=blocks(2);
        let pending=s.manager.admit_prompt(Input{agent:&c.agent,cwd:&s.cwd,session:&c.session,blocks:bc,request,store:&s.store});
        tokio::pin!(pending);
        let receipt=tokio::select!{r=waiting(&mut progress)=>r,_=&mut pending=>panic!("queued request resolved before cancel")};
        // A queued prompt must not hold the canonical-cwd work switch gate.
        tokio::time::timeout(Duration::from_secs(2),crate::work_policy::admit(&s.store,&c.agent,&s.cwd,||async{Ok(())})).await.unwrap().unwrap();
        assert_eq!(s.manager.prompt_admission.cancel(receipt,&owner),Ok(Cancel::CancelledWaiting));
        assert!(pending.await.unwrap_err().contains("PROMPT_QUEUE_CANCELLED"));
        }
        let dc={
        let (request,mut progress)=s.request(&c,"survivor",Instant::now()+Duration::from_secs(60));let (bc,dc)=blocks(3);
        let survivor=s.manager.admit_prompt(Input{agent:&c.agent,cwd:&s.cwd,session:&c.session,blocks:bc,request,store:&s.store});tokio::pin!(survivor);
        tokio::select!{_=waiting(&mut progress)=>{},_=&mut survivor=>panic!("third request must wait")}
        s.manager.session_cancel(&a.agent,&s.cwd,&a.session).await.unwrap();terminal(&mut a).await;
        survivor.await.unwrap();
        dc
        };
        start(&mut c,&dc).await;actor_fence(&c).await;
        s.manager.session_cancel(&b.agent,&s.cwd,&b.session).await.unwrap();terminal(&mut b).await;
        s.manager.session_cancel(&c.agent,&s.cwd,&c.session).await.unwrap();terminal(&mut c).await;
    })).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn original_deadline_and_queued_config_drift_cannot_dispatch_after_grant() {
    checked(|s| {
        Box::pin(async move {
            let mut a = s.open(0, "active-a", "empty").await;
            let mut b = s.open(1, "active-b", "empty").await;
            let mut c = s.open(2, "drift-c", "drift").await;

            let (ba, da) = blocks(0);
            let (bb, db) = blocks(1);
            s.manager
                .session_prompt(&a.agent, &s.cwd, &a.session, ba)
                .await
                .unwrap();
            s.manager
                .session_prompt(&b.agent, &s.cwd, &b.session, bb)
                .await
                .unwrap();
            start(&mut a, &da).await;
            start(&mut b, &db).await;
            let (request, mut progress) =
                s.request(&c, "expires", Instant::now() + Duration::from_millis(100));
            let (bc, _) = blocks(2);
            let pending = s.manager.admit_prompt(Input {
                agent: &c.agent,
                cwd: &s.cwd,
                session: &c.session,
                blocks: bc,
                request,
                store: &s.store,
            });
            tokio::pin!(pending);
            tokio::select! {_=waiting(&mut progress)=>{},_=&mut pending=>panic!("expected queue")}
            assert!(pending.await.unwrap_err().contains("PROMPT_QUEUE_TIMEOUT"));
            let (request, mut progress) =
                s.request(&c, "drift", Instant::now() + Duration::from_secs(60));
            let (bc, _) = blocks(3);
            let pending = s.manager.admit_prompt(Input {
                agent: &c.agent,
                cwd: &s.cwd,
                session: &c.session,
                blocks: bc,
                request,
                store: &s.store,
            });
            tokio::pin!(pending);
            tokio::select! {_=waiting(&mut progress)=>{},_=&mut pending=>panic!("expected queue")}
            std::fs::write(c.fence.with_extension("drift"), "m2").unwrap();
            loop {
                let event = c.events.recv().await.unwrap();
                assert!(
                    !event
                        .pointer("/update/content/text")
                        .and_then(Value::as_str)
                        .is_some_and(|v| v.starts_with("owned-start:"))
                );
                if event["kind"] == "configCheck"
                    && event
                        .pointer("/check/current/choices")
                        .and_then(Value::as_array)
                        .is_some_and(|choices| {
                            choices
                                .iter()
                                .any(|v| v["id"] == "model" && v["value"] == "m2")
                        })
                {
                    break;
                }
            }
            s.manager
                .session_cancel(&a.agent, &s.cwd, &a.session)
                .await
                .unwrap();
            terminal(&mut a).await;
            assert!(pending.await.unwrap_err().starts_with("FAILED: CONFIG_"));
            for _ in 0..MAX_EVENTS {
                let Ok(event) = c.events.try_recv() else {
                    break;
                };
                assert!(
                    !event
                        .pointer("/update/content/text")
                        .and_then(Value::as_str)
                        .is_some_and(|v| v.starts_with("owned-start:"))
                );
            }
            s.manager
                .session_cancel(&b.agent, &s.cwd, &b.session)
                .await
                .unwrap();
            terminal(&mut b).await;
        })
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn offered_pump_unwind_retains_capacity_until_exact_process_close() {
    checked(|s| {
        Box::pin(async move {
            let a = s.open(0, "panic-a", "pump-panic").await;

            let (ba, _) = blocks(0);
            let _ = s
                .manager
                .session_prompt(&a.agent, &s.cwd, &a.session, ba)
                .await;
            while !a.panic_seen.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
            let active = s.manager.prompt_admission.counts().0;
            let work = s.lives[0].work.load(Ordering::SeqCst);
            let before_reap = crate::supervisor::owned_group_alive(a.pid);
            eprintln!("owned-pump-unwind-before-reap-covered={before_reap}");
            if before_reap {
                assert_eq!(active, 1);
                assert_eq!(work, 1);
            }
        })
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn matched_failed_work_close_reaps_only_the_captured_connection() {
    checked(|s| {
        Box::pin(async move {
            let mut a = s.open(0, "failed-close-a", "matched-error").await;
            let mut b = s.open(1, "failed-close-b", "normal").await;
            let check = || {
                s.manager
                    .prepare_failed_work_close(&a.agent, &s.cwd, &a.session, &a.connection)
            };
            let close = |proof| {
                s.manager
                    .close_failed_work(&a.agent, &s.cwd, &a.session, &a.connection, proof)
            };
            assert!(check().await.unwrap().is_none());

            let (bb, db) = blocks(1);
            s.manager
                .session_prompt(&b.agent, &s.cwd, &b.session, bb)
                .await
                .unwrap();
            start(&mut b, &db).await;
            let (ba, _) = blocks(0);
            s.manager
                .session_prompt(&a.agent, &s.cwd, &a.session, ba)
                .await
                .unwrap();
            loop {
                let event = a.events.recv().await.unwrap();
                if event["kind"] == "turnEnd" {
                    assert_eq!(event["failedWorkCloseAvailable"], true);
                    assert!(event.get("error").is_some());
                    assert!(event.get("stopReason").is_none());
                    break;
                }
            }
            let proof = check().await.unwrap().unwrap();
            assert_eq!(proof.session_id, a.session);
            assert_eq!(proof.connection_id, a.connection);
            assert_eq!(s.manager.prompt_admission.counts().0, 2);
            assert!(close(format!("stale-{}", proof.proof_id)).await.is_err());
            assert!(
                s.manager
                    .close_failed_work(
                        &a.agent,
                        &s.cwd,
                        &a.session,
                        &b.connection,
                        proof.proof_id.clone()
                    )
                    .await
                    .is_err()
            );
            let other_operation = s.lives[0]
                .operation("fixture-other-operation".into())
                .unwrap();
            assert!(check().await.unwrap().is_none());
            assert!(close(proof.proof_id.clone()).await.is_err());
            drop(other_operation);
            let sibling = s.lives[0].session().unwrap().registered();
            assert!(check().await.unwrap().is_none());
            assert!(close(proof.proof_id.clone()).await.is_err());
            drop(sibling);
            assert!(crate::supervisor::owned_group_alive(a.pid));
            assert_eq!(s.lives[0].work.load(Ordering::SeqCst), 1);

            assert_eq!(close(proof.proof_id.clone()).await.unwrap(), proof);
            assert!(!crate::supervisor::owned_group_alive(a.pid));
            assert!(
                s.manager
                    .session_owner(&a.agent, &s.cwd, &a.session)
                    .unwrap()
                    .is_none()
            );
            assert_eq!(s.lives[0].work.load(Ordering::SeqCst), 0);
            assert_eq!(s.manager.prompt_admission.counts().0, 1);
            assert!(crate::supervisor::owned_group_alive(b.pid));
            s.manager
                .session_cancel(&b.agent, &s.cwd, &b.session)
                .await
                .unwrap();
            terminal(&mut b).await;
        })
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn real_stdio_eof_is_not_a_terminal_but_actual_reap_releases() {
    checked(|s| {
        Box::pin(async move {
            let mut a = s.open(0, "eof-a", "eof").await;
            #[cfg(windows)]
            let mut retirement_observations = {
                let (send, receive) = mpsc::unbounded_channel();
                assert!(
                    s.lives[0]
                        .retirement_observer
                        .set(Arc::new(move |value| {
                            let _ = send.send(value);
                        }))
                        .is_ok()
                );
                eprintln!(
                    "FARFOLD_ACP_EOF_CASE {}",
                    json!({"originalChildPid": a.pid, "case": "real_stdio_eof_is_not_a_terminal_but_actual_reap_releases", "phase": "beforePrompt", "scope": "PID copied from this live connection's exact process control; binds later owner records, not earlier unlabelled runs"})
                );
                receive
            };

            let (ba, da) = blocks(0);
            s.manager
                .session_prompt(&a.agent, &s.cwd, &a.session, ba)
                .await
                .unwrap();
            start(&mut a, &da).await;
            loop {
                let event = a.events.recv().await.expect("owned EOF observation");
                if event["kind"] == "turnEnd" {
                    assert!(event.get("error").is_some());
                    assert!(event.get("failedWorkCloseAvailable").is_none());
                    break;
                }
                if event["kind"] == "connectionLost" {
                    break;
                }
            }
            // Observe resources before the OS group probe: if that exact group
            // is still alive afterwards, the preceding samples predate reap.
            // ConnectionLife.finished() is later registry cleanup, not this
            // boundary. A fast exit means this interval is not covered.
            let active = s.manager.prompt_admission.counts().0;
            let work = s.lives[0].work.load(Ordering::SeqCst);
            let exit_blocked = crate::managed_update::quiet_exit().is_err();
            let before_reap = crate::supervisor::owned_group_alive(a.pid);
            eprintln!("owned-eof-before-reap-covered={before_reap}");
            if before_reap {
                assert_eq!(active, 1);
                assert_eq!(work, 1);
                assert!(exit_blocked);
            }
            let closed = s.lives[0].closed().await;
            #[cfg(windows)]
            {
                let mut completed = false;
                let mut observations = 0;
                while let Ok(value) = retirement_observations.try_recv() {
                    eprintln!("FARFOLD_ACP_EOF_RETIREMENT {value}");
                    assert_eq!(value["originalChildPid"], a.pid);
                    assert_eq!(value["sameOriginalChildPid"], true);
                    assert_eq!(value["retainedLeader"]["sameOriginalChildPid"], true);
                    if value["point"] == "actualOwnerCompletion" {
                        assert_eq!(value["originalChildReaped"], true);
                        completed = true;
                    }
                    observations += 1;
                }
                eprintln!(
                    "FARFOLD_ACP_EOF_CLOSE {}",
                    json!({"originalChildPid": a.pid, "closedSucceeded": closed.is_ok(), "ownerObservationCount": observations, "ownerCompletionObserved": completed, "promptAdmissionCounts": s.manager.prompt_admission.counts(), "work": s.lives[0].work.load(Ordering::SeqCst)})
                );
                assert!(observations > 0, "original owner observation must be associated");
                if closed.is_ok() {
                    assert!(completed, "successful close must follow exact owner completion");
                }
            }
            closed.unwrap();
            assert_eq!(s.manager.prompt_admission.counts(), (0, 0, 0));
        })
    })
    .await;
}

#[tokio::test]
async fn prompt_mode_keeps_same_agent_fifo_and_cross_agent_rotation() {
    let gate = Admission::new(Policy {
        active: 1,
        pending: 4,
        bytes: 4096,
    })
    .unwrap();
    let make = |agent: &str, token: &str| gate.fixture_owner("owned-fair-window", token, agent);
    let first = gate
        .enqueue_prompt(make("a", "1"), 128)
        .unwrap()
        .acquire()
        .await
        .unwrap();
    let a2 = gate.enqueue_prompt(make("a", "2"), 128).unwrap();
    let a3 = gate.enqueue_prompt(make("a", "3"), 128).unwrap();
    let b = gate.enqueue_prompt(make("b", "4"), 128).unwrap();
    drop(first);
    let b = b.acquire().await.unwrap();
    assert_eq!(gate.counts(), (1, 2, 384));
    drop(b);
    let a2 = a2.acquire().await.unwrap();
    drop(a2);
    drop(a3.acquire().await.unwrap());
    assert_eq!(gate.counts(), (0, 0, 0));
}
#[test]
fn same_wire_blocks_whole_charge_includes_metadata_and_boundary() {
    let gate = Admission::new(Policy {
        active: 1,
        pending: 1,
        bytes: 4096,
    })
    .unwrap();
    let owner = gate.fixture_owner("owned-window", "charge", "a");
    let blocks: Vec<agent_client_protocol::schema::v1::ContentBlock> =
        serde_json::from_value(json!([
            {"type":"text","text":"owned \u{1f642} text","_meta":{"future":{"kept":true}}}
        ]))
        .unwrap();
    let before = serde_json::to_value(&blocks).unwrap();
    let snapshot = json!({"choices":[]});
    let labels = ["/owned", "session", "connection"];
    let bytes =
        super::prompt_charge::whole_request(&owner, &blocks, &snapshot, labels, 128, 4096).unwrap();
    assert_eq!(
        super::prompt_charge::whole_request(&owner, &blocks, &snapshot, labels, 128, bytes),
        Ok(bytes)
    );
    assert!(
        super::prompt_charge::whole_request(&owner, &blocks, &snapshot, labels, 128, bytes - 1)
            .is_err()
    );
    assert_eq!(serde_json::to_value(&blocks).unwrap(), before);
}

#[path = "active_prompt_timeout_tests.rs"]
mod timeout_tests;
