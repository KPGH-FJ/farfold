//! Bounded public-stdio manager controls. No real Agent/account or RSS claim.
use super::*;
use crate::acp_client::history_admission::{Admission, Policy};
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};
const GATED: &str = r#"
import sys,json,time,threading,os
base=sys.argv[1]
lock=threading.Lock()
def send(v):
 with lock: print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def wait(path):
 end=time.monotonic()+20
 while not os.path.exists(path):
  if time.monotonic()>end: raise RuntimeError('controlled gate expired')
  time.sleep(.005)
def loaded(m):
 native=m['params']['sessionId']
 open(base+'_load_'+native,'wb').write(b'load\n')
 wait(base+'_release_'+native)
 for i in range(32): send({'method':'session/update','params':{'sessionId':native,'update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':native+':'+str(i)+':'+'x'*64}}}})
 options=[{'id':'option'+str(i),'name':'Option '+str(i),'type':'select','currentValue':'one','options':[{'value':'one','name':'One'}]} for i in range(16)]
 send({'id':m['id'],'result':{'configOptions':options}})
for line in sys.stdin:
 m=json.loads(line); method=m.get('method')
 if method=='initialize':
  open(base+'_init_'+str(os.getpid()),'wb').write(b'initialize\n')
  wait(base+'_initialize')
  send({'id':m['id'],'result':{'protocolVersion':1,'agentCapabilities':{'loadSession':True},'authMethods':[]}})
 elif method=='session/load': threading.Thread(target=loaded,args=(m,),daemon=True).start()
"#;
fn configured(c: usize) -> Fixture {
    let mut f = Fixture::new();
    std::fs::write(f.cwd.join("peer.py"), GATED).unwrap();
    Arc::get_mut(&mut f.manager).unwrap().history_admission = Admission::new(Policy {
        active: c,
        pending: 4,
        bytes: 65536,
    })
    .unwrap();
    f
}
fn count_prefix(f: &Fixture, prefix: &str) -> usize {
    std::fs::read_dir(&f.cwd)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().starts_with(prefix))
        .count()
}
async fn bounded_case(c: usize) {
    let f = configured(c);
    let mut second = f.row.clone();
    second.id = "lifecycle-second".into();
    f.store.insert_agent(&second).unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let count = Arc::new(AtomicUsize::new(0));
    let mut jobs = Vec::new();
    for i in 0..4 {
        let manager = f.manager.clone();
        let row = if i % 2 == 0 {
            f.row.clone()
        } else {
            second.clone()
        };
        let cwd = f.cwd.clone();
        let store = f.store.clone();
        let seen = seen.clone();
        let count = count.clone();
        jobs.push(tokio::spawn(async move {
            let events: SessionSink = Arc::new(move |value| {
                count.fetch_add(1, Ordering::SeqCst);
                seen.lock().unwrap().push(value);
            });
            let opened = manager
                .open_session_selected_with_mcp(
                    &row,
                    &cwd,
                    Some(format!("target{i}")),
                    vec![],
                    events,
                    &store,
                    None,
                    None,
                    None,
                )
                .await?;
            // The actual command also keeps the returned identity through its
            // final local history marker. This controlled caller consumes it.
            Ok::<_, String>(
                opened
                    .config_options
                    .as_ref()
                    .unwrap()
                    .as_array()
                    .unwrap()
                    .len(),
            )
        }));
        until(|| {
            let (active, pending, _) = f.manager.history_admission.counts();
            active + pending == i + 1
        })
        .await;
    }
    // Actual initialize is blocked; no load can be dispatched yet.
    eprintln!(
        "C={c} awaiting initialize counts={:?}",
        f.manager.history_admission.counts()
    );
    until(|| {
        f.manager.history_admission.counts().0 == c
            && f.manager.history_admission.counts().1 == 4 - c
            && count_prefix(&f, "listed_init_") == c
    })
    .await;
    assert_eq!(count_prefix(&f, "listed_load_"), 0);
    eprintln!("C={c} initialize blocked confirmed");
    std::fs::write(f.cwd.join("listed_initialize"), b"release\n").unwrap();
    until(|| count_prefix(&f, "listed_load_") == c).await;
    eprintln!("C={c} load blocked confirmed");
    assert_eq!(f.manager.history_admission.counts().0, c);
    // Release only known started work. Newly admitted processes encounter the
    // already-open initialize gate and their own independently gated load.
    let mut released = std::collections::HashSet::new();
    until(|| {
        for entry in std::fs::read_dir(&f.cwd).unwrap().filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(native) = name.strip_prefix("listed_load_")
                && released.insert(native.to_string())
            {
                std::fs::write(f.cwd.join(format!("listed_release_{native}")), b"release\n")
                    .unwrap();
            }
        }
        released.len() == 4
    })
    .await;
    eprintln!("C={c} all four load gates released");
    for job in jobs {
        let result = tokio::time::timeout(Duration::from_secs(10), job)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(result, 16);
    }
    until(|| f.manager.history_admission.counts() == (0, 0, 0)).await;
    // Every accepted route remains usable after its opening slot is released.
    for i in 0..4 {
        let row = if i % 2 == 0 { &f.row } else { &second };
        assert!(
            f.manager
                .session_connection(&row.id, &f.cwd, &format!("target{i}"))
                .is_ok()
        );
    }
    let chunks = {
        let events = seen.lock().unwrap();
        events
            .iter()
            .filter(|v| {
                v.pointer("/update/sessionUpdate").and_then(Value::as_str)
                    == Some("agent_message_chunk")
            })
            .count()
    };
    assert_eq!(
        chunks, 128,
        "all 32 raw chunks from each of four histories survive"
    );
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
    f.manager.disconnect(&second.id, &f.cwd).await.unwrap();
    eprintln!("cold-history controlled C={c} targets=4 chunks=128 configuredOptions=16 retained=0");
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bounded_public_peer_c1_c2() {
    tokio::time::timeout(Duration::from_secs(45), async {
        bounded_case(1).await;
        bounded_case(2).await;
    })
    .await
    .unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ready_startup_wakes_next_opener_outside_connection_and_activity_locks() {
    use crate::acp_client::lifecycle::ConnectionLife;
    use std::{
        future::Future,
        pin::Pin,
        sync::atomic::AtomicBool,
        task::{Context, Wake, Waker},
    };
    struct ReadyWake {
        manager: Arc<AcpManager>,
        life: Arc<ConnectionLife>,
        locks_free: AtomicBool,
        notified: tokio::sync::Notify,
    }
    impl Wake for ReadyWake {
        fn wake(self: Arc<Self>) {
            self.wake_by_ref();
        }
        fn wake_by_ref(self: &Arc<Self>) {
            self.locks_free.store(
                self.manager.history_connections_unlocked()
                    && self.life.history_activity_unlocked(),
                Ordering::SeqCst,
            );
            self.notified.notify_one();
        }
    }
    let f = configured(1);
    let history = f
        .manager
        .history_admission
        .enqueue(
            f.manager
                .history_admission
                .fixture_owner("window", "first", &f.row.id),
            1,
        )
        .unwrap()
        .acquire()
        .await
        .unwrap();
    let manager = f.manager.clone();
    let row = f.row.clone();
    let cwd = f.cwd.clone();
    let store = f.store.clone();
    let opening = tokio::spawn(async move {
        // Move the sole permit into the real startup. No observer keeps an
        // extra clone that could conceal release under the connection lock.
        manager
            .connect_launch_owned(&row, &cwd, &store, false, None, None, None, Some(history))
            .await
    });
    until(|| count_prefix(&f, "listed_init_") == 1).await;
    let connection = f.manager.lock().unwrap().values().next().unwrap().clone();
    let mut next = Box::pin(
        f.manager
            .history_admission
            .enqueue(
                f.manager
                    .history_admission
                    .fixture_owner("window", "second", "b"),
                1,
            )
            .unwrap()
            .acquire(),
    );
    let wake = Arc::new(ReadyWake {
        manager: f.manager.clone(),
        life: connection.life.clone(),
        locks_free: AtomicBool::new(false),
        notified: tokio::sync::Notify::new(),
    });
    assert!(
        Pin::new(&mut next)
            .poll(&mut Context::from_waker(&Waker::from(wake.clone())))
            .is_pending()
    );
    std::fs::write(f.cwd.join("listed_initialize"), b"release\n").unwrap();
    // Waiting on `next` here would replace the custom synchronous wake.
    tokio::time::timeout(Duration::from_secs(10), wake.notified.notified())
        .await
        .unwrap();
    assert!(wake.locks_free.load(Ordering::SeqCst));
    drop(next.await.unwrap());
    tokio::time::timeout(Duration::from_secs(10), opening)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(f.manager.history_admission.counts(), (0, 0, 0));
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
    connection.life.terminated().await;
}

#[tokio::test]
async fn cancelling_queued_caller_never_dispatches_its_peer() {
    let f = configured(1);
    let held = f
        .manager
        .history_admission
        .enqueue(
            f.manager
                .history_admission
                .fixture_owner("control", "hold", "other"),
            1,
        )
        .unwrap()
        .acquire()
        .await
        .unwrap();
    let mut open = Box::pin(f.manager.open_session_selected_with_mcp(
        &f.row,
        &f.cwd,
        Some("never-start".into()),
        vec![],
        Arc::new(|_| {}),
        &f.store,
        None,
        None,
        None,
    ));
    tokio::select! { result=&mut open=>panic!("unexpected early result: {}",result.is_ok()), _=until(||f.manager.history_admission.counts().1==1)=>{} }
    drop(open);
    drop(held);
    assert_eq!(f.manager.history_admission.counts(), (0, 0, 0));
    assert_eq!(count_prefix(&f, "listed_init_"), 0);
}
#[tokio::test]
async fn changed_launch_while_waiting_is_not_started() {
    let f = configured(1);
    let held = f
        .manager
        .history_admission
        .enqueue(
            f.manager
                .history_admission
                .fixture_owner("control", "hold", "other"),
            1,
        )
        .unwrap()
        .acquire()
        .await
        .unwrap();
    let mut open = Box::pin(f.manager.open_session_selected_with_mcp(
        &f.row,
        &f.cwd,
        Some("stale".into()),
        vec![],
        Arc::new(|_| {}),
        &f.store,
        None,
        None,
        None,
    ));
    tokio::select! { result=&mut open=>panic!("unexpected early result: {}",result.is_ok()), _=until(||f.manager.history_admission.counts().1==1)=>{} }
    let mut changed = f.row.clone();
    changed.args.push("changed".into());
    f.store.replace_agent_launch(&changed).unwrap();
    drop(held);
    assert!(open.await.err().unwrap().contains("设置已变化"));
    assert_eq!(count_prefix(&f, "listed_init_"), 0);
    assert_eq!(f.manager.history_admission.counts(), (0, 0, 0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn active_approval_and_cancel_bypass_a_full_cold_queue() {
    let mut f = configured(1);
    Arc::get_mut(&mut f.manager).unwrap().history_admission = Admission::new(Policy {
        active: 1,
        pending: 1,
        bytes: 65536,
    })
    .unwrap();
    let peer = PEER
        .replace(" time.sleep(.2)", "\n open(sys.argv[1]+'_loading','wb').write(b'load\\n')\n end=time.monotonic()+20\n while not os.path.exists(sys.argv[1]+'_release'):\n  if time.monotonic()>end: raise RuntimeError('controlled gate expired')\n  time.sleep(.005)")
        .replace("for i in [100,101]: send({'id':i,'method':'elicitation/create','params':{'sessionId':p['sessionId'],'mode':'form','message':'question','requestedSchema':{'type':'object','properties':{}}}})", "for i in [100,101]: send({'id':i,'method':'session/request_permission','params':{'sessionId':p['sessionId'],'toolCall':{'toolCallId':str(i),'title':'Controlled approval','kind':'read'},'options':[{'optionId':'yes','name':'Allow','kind':'allow_once'}]}})")
        .replace(" elif m.get('id')==101 and method is None and expire:", " elif m.get('id')==101 and method is None: open(sys.argv[1]+'_approved','wb').write(b'approved\\n')\n elif m.get('id')==101 and method is None and expire:");
    assert_ne!(peer, PEER);
    std::fs::write(f.cwd.join("peer.py"), peer).unwrap();
    // One already-active process; fresh open is intentionally outside this cap.
    let active = f
        .manager
        .open_session_selected_with_mcp(
            &f.row,
            &f.cwd,
            None,
            vec![],
            Arc::new(|_| {}),
            &f.store,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    let active_id = active.session_id.clone();
    drop(active);
    let start = |native: &str| {
        let manager = f.manager.clone();
        let row = f.row.clone();
        let cwd = f.cwd.clone();
        let store = f.store.clone();
        let native = native.to_owned();
        tokio::spawn(async move {
            manager
                .open_session_selected_with_mcp(
                    &row,
                    &cwd,
                    Some(native),
                    vec![],
                    Arc::new(|_| {}),
                    &store,
                    None,
                    None,
                    None,
                )
                .await
        })
    };
    let a = start("cold-a");
    until(|| f.cwd.join("listed_loading").exists()).await;
    let b = start("cold-b");
    until(|| f.manager.history_admission.counts().1 == 1).await;
    // C=1 is occupied and Q=1 is full. Existing protocol control still runs.
    f.manager
        .session_prompt(
            &f.row.id,
            &f.cwd,
            &active_id,
            serde_json::from_value(json!([{"type":"text","text":"controlled approval then stop"}]))
                .unwrap(),
        )
        .await
        .unwrap();
    until(|| f.manager.pending_permissions.lock().unwrap().len() == 2).await;
    let requests: Vec<_> = f
        .manager
        .pending_permissions
        .lock()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    for request in requests {
        assert_eq!(
            f.manager
                .permission_respond(&request, "yes", &active_id)
                .unwrap()
                .status,
            "submitted"
        );
    }
    until(|| f.cwd.join("listed_approved").exists()).await;
    f.manager
        .session_cancel(&f.row.id, &f.cwd, &active_id)
        .await
        .unwrap();
    let connection = f
        .manager
        .session_connection(&f.row.id, &f.cwd, &active_id)
        .unwrap();
    until(|| connection.life.work.load(Ordering::SeqCst) == 0).await;
    assert_eq!(
        (
            f.manager.history_admission.counts().0,
            f.manager.history_admission.counts().1
        ),
        (1, 1)
    );
    b.abort();
    assert!(matches!(b.await,Err(error) if error.is_cancelled()));
    std::fs::write(f.cwd.join("listed_release"), b"release\n").unwrap();
    drop(a.await.unwrap().unwrap());
    until(|| f.manager.history_admission.counts() == (0, 0, 0)).await;
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn abandoned_startup_holds_slot_until_the_real_process_owner_finishes() {
    use crate::acp_client::lifecycle::{CLOSED, ConnectionLife, FAILED};
    use std::{
        future::Future,
        pin::Pin,
        sync::atomic::AtomicBool,
        task::{Context, Wake, Waker},
    };
    struct ReapWake {
        life: Arc<ConnectionLife>,
        after_finish: AtomicBool,
        notified: tokio::sync::Notify,
    }
    impl Wake for ReapWake {
        fn wake(self: Arc<Self>) {
            self.wake_by_ref();
        }
        fn wake_by_ref(self: &Arc<Self>) {
            // Only the real process owner publishes these states after reaping.
            self.after_finish.store(
                matches!(self.life.state.load(Ordering::SeqCst), CLOSED | FAILED),
                Ordering::SeqCst,
            );
            self.notified.notify_one();
        }
    }
    let f = configured(1);
    let manager = f.manager.clone();
    let row = f.row.clone();
    let cwd = f.cwd.clone();
    let store = f.store.clone();
    let opening = tokio::spawn(async move {
        manager
            .open_session_selected_with_mcp(
                &row,
                &cwd,
                Some("startup-orphan".into()),
                vec![],
                Arc::new(|_| {}),
                &store,
                None,
                None,
                None,
            )
            .await
    });
    until(|| count_prefix(&f, "listed_init_") == 1).await;
    let connection = f.manager.lock().unwrap().values().next().unwrap().clone();
    let pid = connection.child_pid.load(Ordering::SeqCst);
    let mut next = Box::pin(
        f.manager
            .history_admission
            .enqueue(
                f.manager
                    .history_admission
                    .fixture_owner("control", "survivor", "b"),
                1,
            )
            .unwrap()
            .acquire(),
    );
    let wake = Arc::new(ReapWake {
        life: connection.life.clone(),
        after_finish: AtomicBool::new(false),
        notified: tokio::sync::Notify::new(),
    });
    assert!(
        Pin::new(&mut next)
            .poll(&mut Context::from_waker(&Waker::from(wake.clone())))
            .is_pending()
    );
    opening.abort();
    assert!(matches!(opening.await,Err(error) if error.is_cancelled()));
    // Await the observer's notification, not `next`: polling `next` with the
    // task waker here would replace the exact synchronous wake being tested.
    tokio::time::timeout(Duration::from_secs(10), wake.notified.notified())
        .await
        .unwrap();
    drop(next.await.unwrap());
    assert!(wake.after_finish.load(Ordering::SeqCst));
    connection.life.terminated().await;
    assert_ne!(crate::platform_tests::process_check(pid as i32), 0);
    assert_eq!(f.manager.history_admission.counts(), (0, 0, 0));
}

#[tokio::test]
async fn deferred_preparation_runs_once_after_grant_and_never_after_queued_cancel() {
    use crate::acp_client::history_admission_commands::{HistoryAdmissionState, HistoryRequest};
    for cancel in [false, true] {
        let f = configured(1);
        let held = f
            .manager
            .history_admission
            .enqueue(
                f.manager
                    .history_admission
                    .fixture_owner("hold", "active", "b"),
                1,
            )
            .unwrap()
            .acquire()
            .await
            .unwrap();
        let calls = AtomicUsize::new(0);
        let phases = Arc::new(Mutex::new(Vec::new()));
        let observed = phases.clone();
        let request = HistoryRequest {
            owner: f
                .manager
                .history_admission
                .fixture_owner("controlled", "deferred", &f.row.id),
            preparation_bytes: 0,
            progress: Arc::new(move |phase| {
                observed.lock().unwrap().push(phase);
                Ok(())
            }),
        };
        let mut open = Box::pin(f.manager.prepare_history_open(
            &f.row,
            &f.cwd,
            Some("deferred"),
            &[],
            &f.store,
            None,
            Some(request),
            || {
                calls.fetch_add(1, Ordering::SeqCst);
            },
        ));
        tokio::select! { result=&mut open=>panic!("preparation unexpectedly finished: {}",result.is_ok()), _=until(||f.manager.history_admission.counts().1==1)=>{} }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            *phases.lock().unwrap(),
            vec![HistoryAdmissionState::Waiting]
        );
        if cancel {
            assert_eq!(
                f.manager
                    .history_admission
                    .fixture_cancel("controlled", "deferred"),
                Ok(crate::acp_client::history_admission::Cancel::CancelledWaiting)
            );
        }
        drop(held);
        if cancel {
            assert!(open.await.is_err());
            assert_eq!(calls.load(Ordering::SeqCst), 0);
        } else {
            drop(open.await.unwrap());
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            assert_eq!(
                *phases.lock().unwrap(),
                vec![
                    HistoryAdmissionState::Waiting,
                    HistoryAdmissionState::Starting
                ]
            );
        }
        assert_eq!(f.manager.history_admission.counts(), (0, 0, 0));
        assert_eq!(count_prefix(&f, "listed_init_"), 0); // This helper prepares; it does not connect.
    }
}

#[tokio::test]
async fn queued_saved_configuration_is_rechecked_but_title_and_clock_do_not_change_the_target() {
    use crate::{
        acp_client::{history_admission_commands::HistoryRequest, session_index::session_row_id},
        meta_store::SessionRow,
    };
    for changed_config in [false, true] {
        let f = configured(1);
        let mut row = SessionRow {
            id: session_row_id(&f.row.id, &f.cwd.to_string_lossy(), "saved"),
            agent_id: f.row.id.clone(),
            cwd: f.cwd.to_string_lossy().into(),
            native_session_id: Some("saved".into()),
            title: Some("before".into()),
            config_options: Some(json!({"future":{"value":1}})),
            pinned: false,
            archived: false,
            created_at: 1,
            updated_at: 1,
        };
        f.store.upsert_session(&row).unwrap();
        let held = f
            .manager
            .history_admission
            .enqueue(
                f.manager
                    .history_admission
                    .fixture_owner("hold", "active", "other"),
                1,
            )
            .unwrap()
            .acquire()
            .await
            .unwrap();
        let calls = AtomicUsize::new(0);
        let request = HistoryRequest {
            owner: f
                .manager
                .history_admission
                .fixture_owner("controlled", "saved", &f.row.id),
            preparation_bytes: 0,
            progress: Arc::new(|_| Ok(())),
        };
        let mut open = Box::pin(f.manager.prepare_history_open(
            &f.row,
            &f.cwd,
            Some("saved"),
            &[],
            &f.store,
            None,
            Some(request),
            || {
                calls.fetch_add(1, Ordering::SeqCst);
            },
        ));
        tokio::select! { result=&mut open=>panic!("unexpected early result: {}",result.is_ok()), _=until(||f.manager.history_admission.counts().1==1)=>{} }
        row.title = Some("after".into());
        row.pinned = true;
        row.updated_at = 2;
        if changed_config {
            row.config_options = Some(json!({"future":{"value":2}}));
        }
        f.store.upsert_session(&row).unwrap();
        drop(held);
        let result = open.await;
        assert_eq!(result.is_err(), changed_config);
        assert_eq!(calls.load(Ordering::SeqCst), usize::from(!changed_config));
        drop(result);
        assert_eq!(f.manager.history_admission.counts(), (0, 0, 0));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn production_policy_keeps_mixed_raw_values_and_phase_token_collision_separate() {
    use crate::acp_client::history_admission_commands::{HistoryAdmissionState, HistoryRequest};
    let f = Fixture::new();
    let policy = f.manager.history_admission.policy();
    assert_eq!(
        (policy.active, policy.pending, policy.bytes),
        (2, 32, 8 * 1024 * 1024)
    );
    let original = " for i in range(32): send({'method':'session/update','params':{'sessionId':native,'update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':native+':'+str(i)+':'+'x'*64}}}})";
    let mixed = r#" for i in range(32):
  text=native+':'+str(i)
  if i%4==0: update={'sessionUpdate':'user_message_chunk','messageId':text,'content':{'type':'text','text':text},'_meta':{'future':i}}
  elif i%4==1: update={'sessionUpdate':'agent_message_chunk','messageId':text,'content':{'type':'text','text':text},'_meta':{'future':i}}
  elif i%4==2: update={'sessionUpdate':'tool_call','toolCallId':text,'title':'Fixture read','kind':'read','status':'completed','future':i}
  else: update={'sessionUpdate':'fixture_future_state','future':[None,True,{'emoji':'🙂','index':i}]}
  send({'method':'session/update','params':{'sessionId':native,'kind':'session_history_admission','openToken':'mixed-token','phase':'waiting','update':update}})"#;
    let peer = GATED.replace(original, mixed);
    assert_ne!(peer, GATED);
    std::fs::write(f.cwd.join("peer.py"), peer).unwrap();
    std::fs::write(f.cwd.join("listed_initialize"), b"release\n").unwrap();
    std::fs::write(f.cwd.join("listed_release_mixed"), b"release\n").unwrap();
    let phases = Arc::new(Mutex::new(Vec::new()));
    let observed = phases.clone();
    let request = HistoryRequest {
        owner: f
            .manager
            .history_admission
            .fixture_owner("controlled", "mixed-token", &f.row.id),
        preparation_bytes: 0,
        progress: Arc::new(move |phase| {
            observed.lock().unwrap().push(phase);
            Ok(())
        }),
    };
    let (history, (mcp, unavailable)) = f
        .manager
        .prepare_history_open(
            &f.row,
            &f.cwd,
            Some("mixed"),
            &[],
            &f.store,
            None,
            Some(request),
            || (None, None),
        )
        .await
        .unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let opened = f
        .manager
        .open_session_admitted_with_mcp(
            &f.row,
            &f.cwd,
            Some("mixed".into()),
            vec![],
            Arc::new(move |v| sink.lock().unwrap().push(v)),
            &f.store,
            None,
            mcp,
            unavailable,
            history,
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        *phases.lock().unwrap(),
        vec![HistoryAdmissionState::Starting]
    );
    let raw: Vec<_> = events
        .lock()
        .unwrap()
        .iter()
        .filter(|event| {
            event.get("sessionId").and_then(Value::as_str) == Some("mixed")
                && event.get("update").is_some()
        })
        .cloned()
        .collect();
    let expected:Vec<_>=(0..32).map(|i|{
        let text=format!("mixed:{i}");
        let update=match i%4 {
            0=>json!({"sessionUpdate":"user_message_chunk","messageId":text,"content":{"type":"text","text":text},"_meta":{"future":i}}),
            1=>json!({"sessionUpdate":"agent_message_chunk","messageId":text,"content":{"type":"text","text":text},"_meta":{"future":i}}),
            2=>json!({"sessionUpdate":"tool_call","toolCallId":text,"title":"Fixture read","kind":"read","status":"completed","future":i}),
            _=>json!({"sessionUpdate":"fixture_future_state","future":[null,true,{"emoji":"🙂","index":i}]}),
        };
        json!({"sessionId":"mixed","kind":"session_history_admission","openToken":"mixed-token","phase":"waiting","update":update})
    }).collect();
    assert_eq!(
        raw, expected,
        "all mixed raw values and order, including a matching control kind/token, remain untouched"
    );
    drop(opened);
    until(|| f.manager.history_admission.counts() == (0, 0, 0)).await;
    assert!(
        f.manager
            .session_connection(&f.row.id, &f.cwd, "mixed")
            .is_ok()
    );
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
}

#[tokio::test]
async fn queued_service_identity_endpoint_and_model_changes_reject_before_preparation() {
    use crate::{
        acp_client::{history_admission_commands::HistoryRequest, session_index::session_row_id},
        meta_store::SessionRow,
    };
    use sha2::{Digest, Sha256};
    for change in ["label", "endpoint", "models"] {
        let f = configured(1);
        let endpoint = "https://controlled.invalid/v1";
        let fingerprint: String =
            Sha256::digest(serde_json::to_vec(&(endpoint, "responses")).unwrap())
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
        // Public metadata only: the fake reference is never resolved/read.
        let mut pool = json!([{"id":"controlled-api","label":"Fixture","provider":"custom","endpoint":endpoint,"apiType":"responses","models":["saved-model"],"secretRef":"not-read-fixture-reference","retired":[],"grants":[],"deleting":false}]);
        f.store.set_setting("credentials.v1", &pool).unwrap();
        let saved = SessionRow {
            id: session_row_id(&f.row.id, &f.cwd.to_string_lossy(), "model"),
            agent_id: f.row.id.clone(),
            cwd: f.cwd.to_string_lossy().into(),
            native_session_id: Some("model".into()),
            title: None,
            config_options: Some(
                json!({"_farfoldService":{"kind":"configured","identity":{"id":"controlled-api","fingerprint":fingerprint,"model":"saved-model"}}}),
            ),
            pinned: false,
            archived: false,
            created_at: 0,
            updated_at: 0,
        };
        f.store.upsert_session(&saved).unwrap();
        let hold = f
            .manager
            .history_admission
            .enqueue(
                f.manager
                    .history_admission
                    .fixture_owner("hold", "active", "b"),
                1,
            )
            .unwrap()
            .acquire()
            .await
            .unwrap();
        let request = HistoryRequest {
            owner: f
                .manager
                .history_admission
                .fixture_owner("controlled", "model", &f.row.id),
            preparation_bytes: 0,
            progress: Arc::new(|_| Ok(())),
        };
        let selection = crate::credentials::ServiceSelection {
            id: "controlled-api".into(),
            model: "saved-model".into(),
            revision: None,
        };
        let calls = AtomicUsize::new(0);
        let mut open = Box::pin(f.manager.prepare_history_open(
            &f.row,
            &f.cwd,
            Some("model"),
            &[],
            &f.store,
            Some(&selection),
            Some(request),
            || {
                calls.fetch_add(1, Ordering::SeqCst);
            },
        ));
        tokio::select! { result=&mut open=>panic!("unexpected early result: {}",result.is_ok()), _=until(||f.manager.history_admission.counts().1==1)=>{} }
        pool[0][change] = match change {
            "endpoint" => json!("https://changed.invalid/v1"),
            "models" => json!(["different-model"]),
            _ => json!("Renamed"),
        };
        f.store.set_setting("credentials.v1", &pool).unwrap();
        drop(hold);
        let outcome = open.await;
        let rejected = change != "label";
        assert_eq!(outcome.is_err(), rejected);
        assert_eq!(calls.load(Ordering::SeqCst), usize::from(!rejected));
        drop(outcome);
        assert_eq!(count_prefix(&f, "listed_init_"), 0);
        assert_eq!(f.manager.history_admission.counts(), (0, 0, 0));
    }
}

#[tokio::test]
async fn read_admission_rechecks_saved_configured_source_without_current_selection() {
    use crate::{
        acp_client::{history_admission_commands::HistoryRequest, session_index::session_row_id},
        meta_store::SessionRow,
    };
    use sha2::{Digest, Sha256};

    for change in [
        "unchanged",
        "unrelated-b",
        "label",
        "removed",
        "deleting",
        "endpoint",
        "api-type",
        "models",
        "saved-to-b",
        "malformed-record",
    ] {
        let f = configured(1);
        let endpoint = "https://controlled-a.invalid/v1";
        let fingerprint: String =
            Sha256::digest(serde_json::to_vec(&(endpoint, "responses")).unwrap())
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
        // These are test-owned public source records. Neither fake secret
        // reference may be resolved during admission or this preparation probe.
        let mut pool = json!([
            {"id":"controlled-a","label":"A","provider":"custom","endpoint":endpoint,"apiType":"responses","models":["saved-model"],"secretRef":"unread-a-reference","retired":[],"grants":[],"deleting":false},
            {"id":"controlled-b","label":"B","provider":"custom","endpoint":"https://controlled-b.invalid/v1","apiType":"responses","models":["other-model"],"secretRef":"unread-b-reference","retired":[],"grants":[],"deleting":false}
        ]);
        f.store.set_setting("credentials.v1", &pool).unwrap();
        let saved = SessionRow {
            id: session_row_id(&f.row.id, &f.cwd.to_string_lossy(), "saved-a"),
            agent_id: f.row.id.clone(),
            cwd: f.cwd.to_string_lossy().into(),
            native_session_id: Some("saved-a".into()),
            title: None,
            config_options: Some(json!({"_farfoldService":{"kind":"configured","identity":{
                "id":"controlled-a","fingerprint":fingerprint,"model":"saved-model"
            }}})),
            pinned: false,
            archived: false,
            created_at: 0,
            updated_at: 0,
        };
        f.store.upsert_session(&saved).unwrap();
        let hold = f
            .manager
            .history_admission
            .enqueue(
                f.manager
                    .history_admission
                    .fixture_owner("hold-read", "active", "b"),
                1,
            )
            .unwrap()
            .acquire()
            .await
            .unwrap();
        let request = HistoryRequest {
            owner: f
                .manager
                .history_admission
                .fixture_owner("saved-read", "saved-a", &f.row.id),
            preparation_bytes: 0,
            progress: Arc::new(|_| Ok(())),
        };
        let preparations = AtomicUsize::new(0);
        let mut read = Box::pin(f.manager.prepare_history_open(
            &f.row,
            &f.cwd,
            Some("saved-a"),
            &[],
            &f.store,
            None, // The fixed read wrapper never passes the UI's current service.
            Some(request),
            || {
                preparations.fetch_add(1, Ordering::SeqCst);
            },
        ));
        tokio::select! {
            result = &mut read => panic!("unexpected early read result: {}", result.is_ok()),
            _ = until(|| f.manager.history_admission.counts().1 == 1) => {}
        }
        match change {
            "unrelated-b" => pool[1]["deleting"] = json!(true),
            "label" => pool[0]["label"] = json!("Renamed A"),
            "removed" => {
                pool.as_array_mut().unwrap().remove(0);
            }
            "deleting" => pool[0]["deleting"] = json!(true),
            "endpoint" => pool[0]["endpoint"] = json!("https://changed-a.invalid/v1"),
            "api-type" => pool[0]["apiType"] = json!("messages"),
            "models" => pool[0]["models"] = json!(["different-model"]),
            "saved-to-b" | "malformed-record" => {
                let mut changed = saved.clone();
                changed.config_options.as_mut().unwrap()["_farfoldService"] = if change
                    == "saved-to-b"
                {
                    let b_fingerprint: String = Sha256::digest(
                        serde_json::to_vec(&("https://controlled-b.invalid/v1", "responses"))
                            .unwrap(),
                    )
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect();
                    json!({"kind":"configured","identity":{"id":"controlled-b","fingerprint":b_fingerprint,"model":"other-model"}})
                } else {
                    json!({"kind":"configured"})
                };
                f.store.upsert_session(&changed).unwrap();
            }
            _ => {}
        }
        f.store.set_setting("credentials.v1", &pool).unwrap();
        drop(hold);
        let outcome = read.await;
        let admitted = matches!(change, "unchanged" | "unrelated-b" | "label");
        assert_eq!(
            (outcome.is_ok(), preparations.load(Ordering::SeqCst)),
            (admitted, usize::from(admitted)),
            "{change}: only the saved source may authorize read preparation"
        );
        drop(outcome);
        assert_eq!(count_prefix(&f, "listed_init_"), 0);
        assert_eq!(count_prefix(&f, "listed_load_"), 0);
        assert_eq!(f.manager.history_admission.counts(), (0, 0, 0));
    }
}
