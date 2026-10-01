//! Controlled subprocess lifecycle regressions, never real-Agent acceptance.
use super::{manager::AcpManager, pump::SessionSink};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc, time::Duration};

const PEER: &str = r#"
import sys,json,time,threading,os,signal
def send(v): print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def reply(m,r): send({'id':m['id'],'result':r})
def loaded(m):
 time.sleep(.2)
 send({'method':'session/update','params':{'sessionId':m['params']['sessionId'],'update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'old-load'}}}})
 reply(m,{'configOptions':[]})
prompt=None
expire=False
for line in sys.stdin:
 m=json.loads(line); p=m.get('params',{}); method=m.get('method')
 if method=='initialize':
  if '--hang-init' in sys.argv:
   open(sys.argv[1]+'_probe','w').write(str(os.getpid()))
   time.sleep(120)
  elif '--reject-init' in sys.argv: send({'id':m['id'],'error':{'code':-32602,'message':'incompatible fixture'}})
  else: reply(m,{'protocolVersion':1,'agentCapabilities':{'loadSession':True,'sessionCapabilities':{'list':{}}},'authMethods':[]})
 elif method=='session/new': reply(m,{'sessionId':os.environ.get('FIXTURE_SESSION','fixture'),'configOptions':[]})
 elif method=='session/list': open(sys.argv[1],'w').write('listed')
 elif method=='session/load': threading.Thread(target=loaded,args=(m,),daemon=True).start()
 elif method=='session/set_mode': open(sys.argv[1]+'_mode','w').write('sent')
 elif method=='session/prompt':
  prompt=m
  expire=p.get('prompt',[{}])[0].get('text')=='expire'
  for i in [100,101]: send({'id':i,'method':'elicitation/create','params':{'sessionId':p['sessionId'],'mode':'form','message':'question','requestedSchema':{'type':'object','properties':{}}}})
 elif m.get('id')==101 and method is None and expire: send({'method':'$/cancel_request','params':{'requestId':100}})
 elif method=='session/cancel' and not prompt: send({'method':'$/cancel_request','params':{'requestId':100}})
 elif method=='session/cancel' and prompt: reply(prompt,{'stopReason':'cancelled'}); prompt=None
"#;

#[path = "startup_tests.rs"]
mod startup_tests;

#[path = "startup_diagnostics_tests.rs"]
mod startup_diagnostics_tests;

#[path = "protocol_error_tests.rs"]
mod protocol_error_tests;

#[path = "open_delivery_tests.rs"]
mod open_delivery_tests;

struct Fixture {
    _dir: tempfile::TempDir,
    cwd: PathBuf,
    store: MetaStore,
    manager: Arc<AcpManager>,
    row: AgentRow,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().canonicalize().unwrap();
        let script = cwd.join("peer.py");
        std::fs::write(&script, PEER).unwrap();
        let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
        let row = AgentRow {
            id: "lifecycle-fixture".into(),
            name: "Fixture".into(),
            source: "custom".into(),
            command: "/usr/bin/python3".into(),
            args: vec![
                "-u".into(),
                script.to_string_lossy().into(),
                cwd.join("listed").to_string_lossy().into(),
            ],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        store.insert_agent(&row).unwrap();
        let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
        Self {
            _dir: dir,
            cwd,
            store,
            manager,
            row,
        }
    }
    async fn connect(&self) {
        self.manager
            .connect(&self.row, &self.cwd, &self.store)
            .await
            .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}
async fn until(mut predicate: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !predicate() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn auth_cleanup_retries_only_after_late_close_unregisters_the_route() {
    let f = Fixture::new();
    let script = f.cwd.join("peer.py");
    let peer = PEER
        .replace("'sessionCapabilities':{'list':{}}", "'sessionCapabilities':{'list':{},'close':{}}")
        .replace(" elif method=='session/list':", " elif method=='session/close':\n  open(sys.argv[1]+'_closing','w').write('closing')\n  while not os.path.exists(sys.argv[1]+'_release'): time.sleep(.005)\n  reply(m,{})\n elif method=='session/list':");
    std::fs::write(script, peer).unwrap();
    f.manager
        .open_session(&f.row, &f.cwd, None, vec![], Arc::new(|_| {}), &f.store)
        .await
        .unwrap();
    let mut close = Box::pin(
        f.manager
            .close_session_for_auth(&f.row.id, &f.cwd, "fixture"),
    );
    tokio::select! {
        result = &mut close => panic!("close completed before its controlled response: {result:?}"),
        _ = until(|| f.cwd.join("listed_closing").exists()) => {}
    }
    drop(close);
    assert!(f.manager.reserve_account_change(&f.row.id).is_err());
    assert!(
        f.manager
            .close_session_for_auth(&f.row.id, &f.cwd, "fixture")
            .await
            .is_err()
    );
    assert!(
        f.manager
            .session_owner(&f.row.id, &f.cwd, "fixture")
            .unwrap()
            .is_some()
    );
    std::fs::write(f.cwd.join("listed_release"), "release").unwrap();
    until(|| {
        f.manager
            .session_owner(&f.row.id, &f.cwd, "fixture")
            .unwrap()
            .is_none()
    })
    .await;
    assert!(
        f.manager
            .close_session_for_auth(&f.row.id, &f.cwd, "fixture")
            .await
            .is_ok()
    );
    assert!(
        f.manager
            .close_session(&f.row.id, &f.cwd, "fixture")
            .await
            .is_err()
    );
    assert!(f.manager.reserve_account_change(&f.row.id).is_ok());
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn disconnect_interrupts_hung_list_and_reaps_its_exact_child() {
    let f = Fixture::new();
    f.connect().await;
    let pid = f
        .manager
        .live_connection(&f.row.id, &f.cwd)
        .unwrap()
        .child_pid
        .load(std::sync::atomic::Ordering::SeqCst);
    let (manager, agent, cwd) = (f.manager.clone(), f.row.id.clone(), f.cwd.clone());
    let listing = tokio::spawn(async move { manager.agent_session_list(&agent, &cwd).await });
    until(|| f.cwd.join("listed").exists()).await;
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
    until(|| unsafe { libc::kill(pid as i32, 0) != 0 }).await;
    assert!(listing.await.unwrap().is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn account_recheck_keeps_other_directories_and_api_work_connected() {
    use super::service_connection::{PreparedService, ServiceContext};
    use std::sync::atomic::Ordering;
    let f = Fixture::new();
    f.connect().await;
    let original = f.manager.live_connection(&f.row.id, &f.cwd).unwrap();
    let original_pid = original.child_pid.load(Ordering::SeqCst);
    let elsewhere = f.cwd.join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    f.manager
        .connect(&f.row, &elsewhere, &f.store)
        .await
        .unwrap();
    let other = f.manager.live_connection(&f.row.id, &elsewhere).unwrap();
    let _other_work = other.life.work().unwrap();
    f.manager
        .connect_launch(
            &f.row,
            &f.cwd,
            &f.store,
            false,
            Some(PreparedService {
                environment: crate::shell_env::command_env(),
                context: ServiceContext {
                    identity: crate::credentials::ServiceIdentity {
                        id: "api".into(),
                        fingerprint: "fixture".into(),
                        model: "model".into(),
                    },
                    revision: "api-revision".into(),
                    model_id: "model".into(),
                },
            }),
        )
        .await
        .unwrap();
    let api = f
        .manager
        .lock()
        .unwrap()
        .iter()
        .find(|(key, _)| key.service.as_deref() == Some("api-revision"))
        .unwrap()
        .1
        .clone();
    let _api_work = api.life.work().unwrap();
    f.manager
        .recheck_authentication(&f.row.id, &f.cwd, &f.store)
        .await
        .unwrap();
    assert_ne!(unsafe { libc::kill(original_pid as i32, 0) }, 0);
    let replacement = f.manager.live_connection(&f.row.id, &f.cwd).unwrap();
    assert_ne!(replacement.child_pid.load(Ordering::SeqCst), original_pid);
    for connection in [other, api] {
        assert_eq!(
            connection.state.load(Ordering::SeqCst),
            super::manager::STATE_READY
        );
        assert_eq!(
            unsafe { libc::kill(connection.child_pid.load(Ordering::SeqCst) as i32, 0) },
            0
        );
        assert_eq!(connection.life.work.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn account_recheck_refuses_work_in_its_exact_connection_without_closing_it() {
    use std::sync::atomic::Ordering;
    let f = Fixture::new();
    f.connect().await;
    let original = f.manager.live_connection(&f.row.id, &f.cwd).unwrap();
    let pid = original.child_pid.load(Ordering::SeqCst);
    let work = original.life.work().unwrap();
    let error = f
        .manager
        .recheck_authentication(&f.row.id, &f.cwd, &f.store)
        .await
        .unwrap_err();
    assert!(error.contains("任务"));
    assert_eq!(
        original.state.load(Ordering::SeqCst),
        super::manager::STATE_READY
    );
    assert_eq!(unsafe { libc::kill(pid as i32, 0) }, 0);
    drop(work);
    f.manager
        .recheck_authentication(&f.row.id, &f.cwd, &f.store)
        .await
        .unwrap();
    assert_ne!(unsafe { libc::kill(pid as i32, 0) }, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn account_recheck_preserves_an_unfinished_effectful_operation() {
    use std::sync::atomic::Ordering;
    let f = Fixture::new();
    f.connect().await;
    let original = f.manager.live_connection(&f.row.id, &f.cwd).unwrap();
    let pid = original.child_pid.load(Ordering::SeqCst);
    let _pending = original.life.operation("open:pending".into()).unwrap();
    assert!(
        f.manager
            .recheck_authentication(&f.row.id, &f.cwd, &f.store)
            .await
            .is_err()
    );
    assert_eq!(
        original.state.load(Ordering::SeqCst),
        super::manager::STATE_READY
    );
    assert_eq!(unsafe { libc::kill(pid as i32, 0) }, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn confirmed_cancel_clears_every_pending_form() {
    let f = Fixture::new();
    let events = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let captured = events.clone();
    let sink: SessionSink = Arc::new(move |v| captured.lock().unwrap().push(v));
    let opened = f
        .manager
        .open_session(&f.row, &f.cwd, None, vec![], sink, &f.store)
        .await
        .unwrap();
    f.manager
        .session_prompt(
            &f.row.id,
            &f.cwd,
            &opened.session_id,
            serde_json::from_value(json!([{"type":"text","text":"ask"}])).unwrap(),
        )
        .await
        .unwrap();
    until(|| {
        events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e["kind"] == "elicitation")
            .count()
            == 2
    })
    .await;
    f.manager
        .session_cancel(&f.row.id, &f.cwd, &opened.session_id)
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
    assert!(f.manager.pending_elicitations.lock().unwrap().is_empty());
    assert_eq!(
        f.manager
            .live_connection(&f.row.id, &f.cwd)
            .unwrap()
            .life
            .work
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn abandoned_mode_change_keeps_ownership_but_does_not_block_stop() {
    let f = Fixture::new();
    let opened = f
        .manager
        .open_session(&f.row, &f.cwd, None, vec![], Arc::new(|_| {}), &f.store)
        .await
        .unwrap();
    let change = f
        .manager
        .session_set_mode(&f.row.id, &f.cwd, &opened.session_id, "plan");
    assert!(
        tokio::time::timeout(Duration::from_millis(30), change)
            .await
            .is_err()
    );
    until(|| f.cwd.join("listed_mode").exists()).await;
    assert!(
        !f.manager
            .live_connection(&f.row.id, &f.cwd)
            .unwrap()
            .life
            .close(false, Some(Duration::ZERO))
            .unwrap()
    );
    assert!(
        f.manager
            .session_set_mode(&f.row.id, &f.cwd, &opened.session_id, "plan")
            .await
            .is_err()
    );
    tokio::time::timeout(
        Duration::from_secs(1),
        f.manager
            .session_cancel(&f.row.id, &f.cwd, &opened.session_id),
    )
    .await
    .unwrap()
    .unwrap();
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn expired_queued_prompt_never_reaches_the_agent() {
    let f = Fixture::new();
    let opened = f
        .manager
        .open_session(&f.row, &f.cwd, None, vec![], Arc::new(|_| {}), &f.store)
        .await
        .unwrap();
    let connection = f.manager.live_connection(&f.row.id, &f.cwd).unwrap();
    let control = connection
        .sessions
        .lock()
        .unwrap()
        .get(&opened.session_id)
        .unwrap()
        .control
        .clone();
    let (result, receive) = tokio::sync::oneshot::channel();
    control
        .send(super::pump::SessionControl::Prompt {
            blocks: serde_json::from_value(json!([{"type":"text","text":"expired"}])).unwrap(),
            deadline: tokio::time::Instant::now() - Duration::from_secs(1),
            result,
        })
        .unwrap();
    assert!(
        receive.await.is_err(),
        "expired queue item must be dropped before dispatch"
    );
    assert_eq!(
        connection
            .life
            .work
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn forms_validate_before_consuming_and_expire_individually() {
    let f = Fixture::new();
    let events = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let captured = events.clone();
    let opened = f
        .manager
        .open_session(
            &f.row,
            &f.cwd,
            None,
            vec![],
            Arc::new(move |v| captured.lock().unwrap().push(v)),
            &f.store,
        )
        .await
        .unwrap();
    f.manager
        .session_prompt(
            &f.row.id,
            &f.cwd,
            &opened.session_id,
            serde_json::from_value(json!([{"type":"text","text":"expire"}])).unwrap(),
        )
        .await
        .unwrap();
    until(|| f.manager.pending_elicitations.lock().unwrap().len() == 2).await;
    let ids = events
        .lock()
        .unwrap()
        .iter()
        .filter(|e| e["kind"] == "elicitation")
        .map(|e| e["requestId"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        f.manager
            .elicitation_respond(&ids[0], &opened.session_id, "invalid", None)
            .unwrap()
            .status,
        "retryable"
    );
    assert_eq!(
        f.manager
            .elicitation_respond(&ids[0], "different", "accept", None)
            .unwrap()
            .status,
        "expired"
    );
    assert_eq!(f.manager.pending_elicitations.lock().unwrap().len(), 2);
    assert_eq!(
        f.manager
            .elicitation_respond(&ids[1], &opened.session_id, "accept", Some(json!({})))
            .unwrap()
            .status,
        "submitted"
    );
    assert_eq!(
        f.manager
            .elicitation_respond(&ids[1], &opened.session_id, "accept", None)
            .unwrap()
            .status,
        "expired"
    );
    until(|| {
        events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "interactionExpired" && e["requestId"] == ids[0])
    })
    .await;
    f.manager
        .session_cancel(&f.row.id, &f.cwd, &opened.session_id)
        .await
        .unwrap();
    until(|| f.manager.pending_elicitations.lock().unwrap().is_empty()).await;
    assert_eq!(
        f.manager
            .elicitation_respond(&ids[0], &opened.session_id, "accept", None)
            .unwrap()
            .status,
        "expired"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn failed_process_registration_still_reaps_the_exact_child() {
    use std::os::unix::{ffi::OsStrExt, fs::OpenOptionsExt};

    let mut f = Fixture::new();
    // This observer must not queue behind unrelated fixtures sharing the global
    // per-Agent configuration reservation while its observation deadline runs.
    f.row.id = "failed-registration-fixture".into();
    f.store.insert_agent(&f.row).unwrap();
    let blocked = f.cwd.join("not-a-directory");
    let pending = f.cwd.join("registration-pending");
    std::fs::create_dir(&pending).unwrap();
    std::os::unix::fs::symlink(&pending, &blocked).unwrap();
    let failure = f.cwd.join("registration-failure");
    std::fs::write(&failure, "fixture").unwrap();
    let registry = pending.join("pids.json");
    let fifo = std::ffi::CString::new(registry.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    // Keep a writer open so registration cannot finish before this test retains
    // the exact PID. Polling the manager alone can miss an already-reaped owner.
    let registration_gate = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(&registry)
        .unwrap();
    f.manager = Arc::new(AcpManager::new(f.cwd.join("logs"), blocked.clone()));
    let manager = f.manager.clone();
    let row = f.row.clone();
    let cwd = f.cwd.clone();
    let store = f.store.clone();
    let connecting = tokio::spawn(async move { manager.connect(&row, &cwd, &store).await });
    // The owner publishes its exact child before attempting the registry write.
    let pid = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let found = f
                .manager
                .lock()
                .unwrap()
                .values()
                .map(|entry| entry.child_pid.load(std::sync::atomic::Ordering::SeqCst))
                .find(|pid| *pid > 0);
            if let Some(pid) = found {
                break pid;
            }
            if connecting.is_finished() {
                break 0;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("fixture must publish its exact child within the observation deadline");
    // Replace the path with the original failing input before releasing read.
    // Registration either already reads the FIFO or sees this ordinary file;
    // both paths reach the same failed create_dir_all after PID observation.
    // Atomic rename avoids a gap in which registration could recreate a directory.
    std::fs::rename(&failure, &blocked).unwrap();
    drop(registration_gate);
    assert!(connecting.await.unwrap().is_err());
    until(|| f.manager.status(&f.row.id).unwrap().is_empty()).await;
    assert_ne!(pid, 0, "fixture must observe the exact spawned Child");
    assert_ne!(unsafe { libc::kill(pid as i32, 0) }, 0);
    assert!(!f.cwd.join("not-a-directory/pids.json").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn stdout_eof_does_not_wait_for_stderr_or_a_living_child() {
    let f = Fixture::new();
    std::fs::write(
        f.cwd.join("peer.py"),
        PEER.replace(
            "elif method=='session/list': open(sys.argv[1],'w').write('listed')",
            "elif method=='session/list': os.close(1); time.sleep(60)",
        ),
    )
    .unwrap();
    f.connect().await;
    let pid = f
        .manager
        .live_connection(&f.row.id, &f.cwd)
        .unwrap()
        .child_pid
        .load(std::sync::atomic::Ordering::SeqCst);
    let listing = f.manager.agent_session_list(&f.row.id, &f.cwd);
    assert!(
        tokio::time::timeout(Duration::from_secs(3), listing)
            .await
            .unwrap()
            .is_err()
    );
    until(|| unsafe { libc::kill(pid as i32, 0) != 0 }).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn app_exit_waits_for_exact_owner_and_term_ignoring_descendant() {
    let f = Fixture::new();
    let peer = PEER.replace("prompt=None", "child=os.fork()\nif child==0:\n signal.signal(signal.SIGTERM, signal.SIG_IGN)\n open(sys.argv[1]+'_child','w').write(str(os.getpid()))\n time.sleep(60)\n sys.exit(0)\nwhile not os.path.exists(sys.argv[1]+'_child') or not open(sys.argv[1]+'_child').read(): time.sleep(.005)\nprompt=None");
    std::fs::write(f.cwd.join("peer.py"), peer).unwrap();
    f.connect().await;
    let child: i32 = std::fs::read_to_string(f.cwd.join("listed_child"))
        .unwrap()
        .parse()
        .unwrap();
    let started = std::time::Instant::now();
    f.manager.stop_for_shutdown();
    assert!(f.manager.status(&f.row.id).unwrap().is_empty());
    assert!(started.elapsed() >= Duration::from_secs(2));
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_ne!(unsafe { libc::kill(child, 0) }, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn candidate_probe_uses_candidate_without_replacing_registered_launch() {
    let f = Fixture::new();
    let mut candidate = f.row.clone();
    candidate.args.push("--reject-init".into());
    let _configuration = crate::install_job::configuration_guard(&f.row.id).await;
    assert!(
        f.manager
            .probe_launch(&candidate, &f.store, std::future::pending())
            .await
            .is_err()
    );
    assert_eq!(f.store.get_agent(&f.row.id).unwrap().unwrap(), f.row);
    assert!(!f.manager.candidate_pending(&f.row.id).unwrap());
    assert!(f.manager.status(&f.row.id).unwrap().is_empty());
    f.manager
        .probe_launch(&f.row, &f.store, std::future::pending())
        .await
        .unwrap();
    assert_eq!(f.store.get_agent(&f.row.id).unwrap().unwrap(), f.row);
    assert!(!f.manager.candidate_pending(&f.row.id).unwrap());
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelled_candidate_reaps_child_before_allowing_another_launch() {
    let f = Fixture::new();
    let mut candidate = f.row.clone();
    candidate.args.push("--hang-init".into());
    let marker = f.cwd.join("listed_probe");
    let cancel = async {
        until(|| marker.exists()).await;
    };
    let _configuration = crate::install_job::configuration_guard(&f.row.id).await;
    let result = f.manager.probe_launch(&candidate, &f.store, cancel).await;
    assert!(result.unwrap_err().contains("取消"));
    let pid: i32 = std::fs::read_to_string(marker).unwrap().parse().unwrap();
    assert_ne!(unsafe { libc::kill(pid, 0) }, 0);
    assert!(!f.manager.candidate_pending(&f.row.id).unwrap());
    assert_eq!(f.store.get_agent(&f.row.id).unwrap().unwrap(), f.row);
}

#[tokio::test(flavor = "multi_thread")]
async fn two_service_connections_route_stop_and_interactions_to_their_own_session() {
    use super::{
        manager::ManagerCommand,
        model_guard::ConfigStore,
        service_connection::{PreparedService, ServiceContext, ServiceRecord},
    };
    use crate::credentials::ServiceIdentity;
    let f = Fixture::new();
    let mut opened = Vec::new();
    for name in ["source-a", "source-b"] {
        let context = ServiceContext {
            identity: ServiceIdentity {
                id: name.into(),
                fingerprint: "fixture".into(),
                model: "model".into(),
            },
            revision: name.into(),
            model_id: "model".into(),
        };
        let mut environment = crate::shell_env::command_env();
        environment.insert("FIXTURE_SESSION".into(), name.into());
        f.manager
            .connect_launch(
                &f.row,
                &f.cwd,
                &f.store,
                false,
                Some(PreparedService {
                    environment,
                    context,
                }),
            )
            .await
            .unwrap();
        let connection = f
            .manager
            .lock()
            .unwrap()
            .iter()
            .find(|(key, _)| key.service.as_deref() == Some(name))
            .unwrap()
            .1
            .clone();
        let captured = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let sink = captured.clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        connection
            .send(ManagerCommand::OpenSession {
                native_session_id: None,
                preview_token: None,
                recorded_config: None,
                config_store: Box::new(ConfigStore {
                    store: f.store.clone(),
                    agent_id: f.row.id.clone(),
                    cwd: f.cwd.to_string_lossy().into(),
                    service_record: Some(ServiceRecord::Existing),
                    expected_model: None,
                    verified_permission_option: false,
                }),
                config_options: vec![],
                events: Arc::new(move |v| sink.lock().unwrap().push(v)),
                result: tx,
            })
            .unwrap();
        let session = rx.await.unwrap().unwrap().accept().unwrap();
        assert_eq!(session.session_id, name);
        f.manager
            .session_prompt(
                &f.row.id,
                &f.cwd,
                name,
                serde_json::from_value(json!([{"type":"text","text":"ask"}])).unwrap(),
            )
            .await
            .unwrap();
        until(|| {
            captured
                .lock()
                .unwrap()
                .iter()
                .filter(|v| v["kind"] == "elicitation")
                .count()
                == 2
        })
        .await;
        opened.push((connection, captured));
    }
    assert_eq!(f.manager.pending_elicitations.lock().unwrap().len(), 4);
    f.manager
        .session_cancel(&f.row.id, &f.cwd, "source-a")
        .await
        .unwrap();
    until(|| {
        opened[0]
            .1
            .lock()
            .unwrap()
            .iter()
            .any(|v| v["kind"] == "turnEnd")
    })
    .await;
    assert!(
        !opened[1]
            .1
            .lock()
            .unwrap()
            .iter()
            .any(|v| v["kind"] == "turnEnd")
    );
    assert_eq!(f.manager.pending_elicitations.lock().unwrap().len(), 2);
    assert!(
        f.manager
            .pending_elicitations
            .lock()
            .unwrap()
            .values()
            .all(|v| v.session_id == "source-b")
    );
    f.manager
        .session_cancel(&f.row.id, &f.cwd, "source-b")
        .await
        .unwrap();
    until(|| {
        opened[1]
            .1
            .lock()
            .unwrap()
            .iter()
            .any(|value| value["kind"] == "turnEnd")
    })
    .await;
    assert!(f.manager.pending_elicitations.lock().unwrap().is_empty());
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
    assert!(f.manager.status(&f.row.id).unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn abandoned_restore_blocks_other_service_until_actual_load_finishes() {
    use super::{
        manager::ManagerCommand,
        model_guard::ConfigStore,
        service_connection::{PreparedService, ServiceContext},
    };
    use crate::credentials::{ServiceIdentity, ServiceSelection};
    let f = Fixture::new();
    let peer = PEER.replace(" time.sleep(.2)", "\n if m['params']['sessionId']=='restored':\n  while not os.path.exists(sys.argv[1]+'_release'): time.sleep(.005)\n else: time.sleep(.01)")
        .replace("elif method=='session/load': threading.Thread(target=loaded,args=(m,),daemon=True).start()", "elif method=='session/load':\n  with open(sys.argv[1]+'_loads','a') as record: record.write(os.environ.get('FIXTURE_SESSION','default')+':'+p['sessionId']+'\\n')\n  threading.Thread(target=loaded,args=(m,),daemon=True).start()");
    std::fs::write(f.cwd.join("peer.py"), peer).unwrap();
    let mut connections = Vec::new();
    for source in ["source-a", "source-b"] {
        let mut environment = crate::shell_env::command_env();
        environment.insert("FIXTURE_SESSION".into(), source.into());
        let context = ServiceContext {
            identity: ServiceIdentity {
                id: "same-service".into(),
                fingerprint: "same-endpoint".into(),
                model: "model".into(),
            },
            revision: source.into(),
            model_id: "model".into(),
        };
        f.manager
            .connect_launch(
                &f.row,
                &f.cwd,
                &f.store,
                false,
                Some(PreparedService {
                    environment,
                    context,
                }),
            )
            .await
            .unwrap();
        connections.push(
            f.manager
                .lock()
                .unwrap()
                .iter()
                .find(|(key, _)| key.service.as_deref() == Some(source))
                .unwrap()
                .1
                .clone(),
        );
    }
    let send_load = |connection: &super::manager::ManagedConnection, id: &str| {
        let opening = f
            .manager
            .opening_sessions
            .reserve(&f.row.id, &f.cwd, id)
            .unwrap();
        let (result, receive) = tokio::sync::oneshot::channel();
        connection
            .send_reserved(
                ManagerCommand::OpenSession {
                    native_session_id: Some(id.into()),
                    preview_token: None,
                    recorded_config: None,
                    config_store: Box::new(ConfigStore {
                        store: f.store.clone(),
                        agent_id: f.row.id.clone(),
                        cwd: f.cwd.to_string_lossy().into(),
                        service_record: None,
                        expected_model: None,
                        verified_permission_option: false,
                    }),
                    config_options: vec![],
                    events: Arc::new(|_| {}),
                    result,
                },
                Some(opening),
            )
            .unwrap();
        receive
    };
    let first = send_load(&connections[0], "restored");
    let marker = f.cwd.join("listed_loads");
    until(|| marker.exists()).await;
    drop(first); // The caller no longer waits; the external load is still active.
    let retry = f
        .manager
        .open_session_selected(
            &f.row,
            &f.cwd,
            Some("restored".into()),
            vec![],
            Arc::new(|_| {}),
            &f.store,
            Some(ServiceSelection {
                id: "same-service".into(),
                model: "model".into(),
            }),
        )
        .await;
    assert!(retry.err().unwrap().contains("上次打开尚未结束"));
    assert!(
        f.manager
            .opening_sessions
            .reserve(&f.row.id, &f.cwd, "restored")
            .is_err()
    );
    let other = send_load(&connections[1], "unrelated");
    assert_eq!(
        other.await.unwrap().unwrap().accept().unwrap().session_id,
        "unrelated"
    );
    assert_eq!(std::fs::read_to_string(&marker).unwrap().lines().count(), 2);
    std::fs::write(f.cwd.join("listed_release"), "release").unwrap();
    until(|| {
        f.manager
            .opening_sessions
            .reserve(&f.row.id, &f.cwd, "restored")
            .is_ok()
    })
    .await;
    assert!(connections[0].sessions.lock().unwrap().is_empty());
    assert_eq!(
        send_load(&connections[1], "restored")
            .await
            .unwrap()
            .unwrap()
            .accept()
            .unwrap()
            .session_id,
        "restored"
    );
    let loads = std::fs::read_to_string(marker).unwrap();
    assert_eq!(
        loads.lines().collect::<Vec<_>>(),
        [
            "source-a:restored",
            "source-b:unrelated",
            "source-b:restored"
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn first_prompt_never_reaches_agent_when_source_metadata_cannot_be_saved() {
    let f = Fixture::new();
    std::fs::write(
        f.cwd.join("peer.py"),
        PEER.replace(
            "  prompt=m",
            "  open(sys.argv[1]+'_prompt','w').write('sent')\n  prompt=m",
        ),
    )
    .unwrap();
    let captured = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let events = captured.clone();
    let opened = f
        .manager
        .open_session(
            &f.row,
            &f.cwd,
            None,
            vec![],
            Arc::new(move |value| events.lock().unwrap().push(value)),
            &f.store,
        )
        .await
        .unwrap();
    let database = rusqlite::Connection::open(f.cwd.join("meta.db")).unwrap();
    database.execute_batch("CREATE TRIGGER reject_source_record BEFORE INSERT ON sessions BEGIN SELECT RAISE(FAIL, 'controlled storage failure'); END;").unwrap();
    let blocks = serde_json::from_value(json!([{"type":"text","text":"ask"}])).unwrap();
    let error = f
        .manager
        .session_prompt(&f.row.id, &f.cwd, &opened.session_id, blocks)
        .await
        .unwrap_err();
    assert!(error.contains("CONFIG_RECORD_FAILED"));
    assert!(!f.cwd.join("listed_prompt").exists());
    assert!(f.manager.pending_elicitations.lock().unwrap().is_empty());
    let current = captured
        .lock()
        .unwrap()
        .iter()
        .find(|v| v["kind"] == "configCheck" && v["check"]["status"] == "record_failed")
        .unwrap()["check"]["current"]
        .clone();
    database
        .execute_batch("DROP TRIGGER reject_source_record;")
        .unwrap();
    f.manager
        .confirm_config(&f.row.id, &f.cwd, &opened.session_id, current)
        .await
        .unwrap();
    f.manager
        .session_prompt(
            &f.row.id,
            &f.cwd,
            &opened.session_id,
            serde_json::from_value(json!([{"type":"text","text":"ask"}])).unwrap(),
        )
        .await
        .unwrap();
    until(|| f.cwd.join("listed_prompt").exists()).await;
    let id = super::session_index::session_row_id(
        &f.row.id,
        &f.cwd.to_string_lossy(),
        &opened.session_id,
    );
    let row = f.store.get_session(&id).unwrap().unwrap();
    assert_eq!(
        row.config_options.unwrap()["_farfoldService"]["kind"],
        "existing"
    );
    f.manager
        .session_cancel(&f.row.id, &f.cwd, &opened.session_id)
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn local_close_checks_live_prompt_in_pump_before_releasing_route() {
    let f = Fixture::new();
    let captured = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let events = captured.clone();
    let opened = f
        .manager
        .open_session(
            &f.row,
            &f.cwd,
            None,
            vec![],
            Arc::new(move |value| events.lock().unwrap().push(value)),
            &f.store,
        )
        .await
        .unwrap();
    f.manager
        .session_prompt(
            &f.row.id,
            &f.cwd,
            &opened.session_id,
            serde_json::from_value(json!([{"type":"text","text":"ask"}])).unwrap(),
        )
        .await
        .unwrap();
    assert!(
        f.manager
            .close_session(&f.row.id, &f.cwd, &opened.session_id)
            .await
            .is_err()
    );
    assert!(
        f.manager
            .session_connection(&f.row.id, &f.cwd, &opened.session_id)
            .is_ok()
    );
    f.manager
        .session_cancel(&f.row.id, &f.cwd, &opened.session_id)
        .await
        .unwrap();
    until(|| {
        captured
            .lock()
            .unwrap()
            .iter()
            .any(|value| value["kind"] == "turnEnd")
    })
    .await;
    f.manager
        .close_session(&f.row.id, &f.cwd, &opened.session_id)
        .await
        .unwrap();
    assert!(
        f.manager
            .session_connection(&f.row.id, &f.cwd, &opened.session_id)
            .is_err()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_process_keeps_its_session_owner_until_reaped() {
    let f = Fixture::new();
    let script = std::path::Path::new(&f.row.args[1]);
    std::fs::write(
        script,
        PEER.replacen(
            "prompt=None",
            "signal.signal(signal.SIGTERM, signal.SIG_IGN)\nprompt=None",
            1,
        ),
    )
    .unwrap();
    let opened = f
        .manager
        .open_session(&f.row, &f.cwd, None, vec![], Arc::new(|_| {}), &f.store)
        .await
        .unwrap();
    let owner = f
        .manager
        .session_owner(&f.row.id, &f.cwd, &opened.session_id)
        .unwrap()
        .unwrap();
    owner.life.close(true, None).unwrap();
    assert!(
        f.manager
            .session_connection(&f.row.id, &f.cwd, &opened.session_id)
            .is_err()
    );
    assert!(
        f.manager
            .session_owner(&f.row.id, &f.cwd, &opened.session_id)
            .unwrap()
            .is_some()
    );
    owner.life.closed().await.unwrap();
    assert!(
        f.manager
            .session_owner(&f.row.id, &f.cwd, &opened.session_id)
            .unwrap()
            .is_none()
    );
}
