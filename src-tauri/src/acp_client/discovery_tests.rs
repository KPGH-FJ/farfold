//! Subprocess protocol and in-memory ownership checks, not installed-Agent acceptance.
use super::{manager::AcpManager, pump::SessionSink};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

#[path = "discovery_readonly_tests.rs"]
mod readonly;

const PEER: &str = r#"
import sys,json,os,time
base=os.path.dirname(os.path.abspath(__file__))
def send(v): print(json.dumps(dict(jsonrpc='2.0',**v)),flush=True)
def reply(m,r): send({'id':m['id'],'result':r})
options=[{'id':'model','name':'Model','category':'model','type':'select','currentValue':'m','options':[{'value':'m','name':'M'}]}]
for line in sys.stdin:
 m=json.loads(line); method=m.get('method'); p=m.get('params',{})
 if method=='initialize':
  caps={'loadSession':'--no-load' not in sys.argv}
  if sys.argv[1]=='supported': caps['sessionCapabilities']={'list':{}}
  if '--remote-close' in sys.argv: caps.setdefault('sessionCapabilities',{})['close']={}
  reply(m,{'protocolVersion':1,'agentCapabilities':caps,'authMethods':[]})
 elif method=='session/list':
  with open(os.path.join(base,'list-requests'),'a') as f: f.write(json.dumps(p)+'\n')
  cursor=p.get('cursor')
  failures={'failure':(-32603,'listing failed'),'startup-text':(-32603,'AGENT_INITIALIZE_TIMEOUT'),
            'auth-text':(-32603,'AUTH_REQUIRED'),'auth-code':(-32000,'fixture authentication required')}
  if cursor in failures:
   code,message=failures[cursor]
   send({'id':m['id'],'error':{'code':code,'message':message}})
  elif cursor=='next': reply(m,{'sessions':[{'sessionId':'second','cwd':'/missing/history-location'}]})
  else: reply(m,{'sessions':[{'sessionId':'first','cwd':base,'title':'Original history'}],'nextCursor':'next'})
 elif method in ('session/new','session/load'):
  with open(os.path.join(base,'open-requests'),'ab') as f: f.write((method+'\n').encode('utf-8'))
  id=p.get('sessionId','live')
  if id=='failure': send({'id':m['id'],'error':{'code':-32603,'message':'load failed'}}); continue
  if method=='session/load' and id=='replay-batch':
   batch=[{'jsonrpc':'2.0','method':'session/update','params':{'sessionId':id,'update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'Batch '+str(n)},'_meta':{'fixture':n}}}} for n in range(32)]
   batch.append({'jsonrpc':'2.0','id':m['id'],'result':{'configOptions':options,'models':{'fixture':'untyped-models'},'_meta':{'fixture':'untyped-meta'}}})
   print(json.dumps(batch),flush=True); continue
  time.sleep(.03)
  if method=='session/load' and id!='empty':
   for n in range(32 if id=='replay-many' else 1): send({'method':'session/update','params':{'sessionId':id,'update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'Original body '+str(n)}}}})
  reply(m,dict(configOptions=options,**({'sessionId':id} if method=='session/new' else {})))
 elif method=='session/prompt':
  send({'method':'session/update','params':{'sessionId':p['sessionId'],'update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'still-open'}}}})
  reply(m,{'stopReason':'end_turn'})
 elif method=='session/close':
  if p['sessionId']=='refuse-close': send({'id':m['id'],'error':{'code':-32603,'message':'close refused'}}); continue
  open(os.path.join(base,'close-started'),'w').write(p['sessionId'])
  while not os.path.exists(os.path.join(base,'close-release')): time.sleep(.01)
  reply(m,{})
 elif method=='session/cancel': continue
 elif 'id' in m: reply(m,{})
"#;

struct Fixture {
    _root: tempfile::TempDir,
    cwd: std::path::PathBuf,
    manager: AcpManager,
    store: MetaStore,
    agent: AgentRow,
}
impl Fixture {
    fn new(supported: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().canonicalize().unwrap();
        let script = cwd.join("peer.py");
        std::fs::write(&script, PEER).unwrap();
        let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
        let agent = AgentRow {
            id: "history-fixture".into(),
            name: "History fixture".into(),
            source: "custom".into(),
            command: crate::platform_tests::python(),
            args: vec![
                "-u".into(),
                script.to_string_lossy().into_owned(),
                if supported {
                    "supported"
                } else {
                    "unsupported"
                }
                .into(),
            ],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        store.insert_agent(&agent).unwrap();
        Self {
            _root: root,
            manager: AcpManager::new(cwd.join("logs"), cwd.clone()),
            cwd,
            store,
            agent,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}

fn reserve_after_open_completes(
    reservations: &super::lifecycle::OpenReservations,
    agent_id: &str,
    cwd: &std::path::Path,
    session_id: &str,
) -> super::lifecycle::OpenReservation {
    // The oneshot reply can wake its caller before the operation drops its
    // reservation. Wait for that exact ownership boundary, never a time delay.
    // The operation runs on the separate manager executor, including when this
    // helper is used inside a synchronous test Channel callback.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        match reservations.reserve(agent_id, cwd, session_id) {
            Ok(reservation) => return reservation,
            Err(error) => {
                assert!(std::time::Instant::now() < deadline, "{error}");
                std::thread::yield_now();
            }
        }
    }
}

#[tokio::test]
async fn import_preview_channel_marks_complete_after_the_entire_replay() {
    let f = Fixture::new(true);
    for (session_id, expected_updates) in [("replay-many", 32), ("replay-batch", 32), ("empty", 0)]
    {
        let received = Arc::new(Mutex::new(Vec::<Value>::new()));
        let sink = received.clone();
        let channel = tauri::ipc::Channel::new(move |body| {
            sink.lock().unwrap().push(body.deserialize::<Value>()?);
            Ok(())
        });
        let preview = super::session_discovery::open_import_preview(
            &f.manager,
            &f.store,
            &f.agent,
            &f.cwd,
            session_id.into(),
            "ordered".into(),
            "owned-preview-open",
            channel,
            None,
        )
        .await
        .unwrap();
        let events = received.lock().unwrap().clone();
        assert_eq!(
            events.last(),
            Some(
                &json!({"kind":"history_preview_complete","previewToken":"ordered","openToken":"owned-preview-open"})
            )
        );
        let updates: Vec<_> = events
            .iter()
            .filter_map(|event| event.get("update"))
            .collect();
        assert_eq!(updates.len(), expected_updates);
        assert_eq!(events.first().unwrap()["kind"], "sessionOpening");
        assert_eq!(events.first().unwrap()["openToken"], "owned-preview-open");
        assert_eq!(events.first().unwrap()["sessionId"], session_id);
        assert_eq!(preview.preview_token, "ordered");
        if session_id == "replay-batch" {
            assert_eq!(
                preview.session.models,
                Some(json!({"fixture":"untyped-models"}))
            );
            assert_eq!(
                preview.session.meta,
                Some(json!({"fixture":"untyped-meta"}))
            );
            for (index, update) in updates.iter().enumerate() {
                assert_eq!(update["_meta"]["fixture"], index);
            }
        }
        assert!(f.store.list_sessions().unwrap().is_empty());
        f.manager
            .close_session_owned(&f.agent.id, &f.cwd, session_id, Some("ordered"))
            .await
            .unwrap();
    }
    f.manager.disconnect(&f.agent.id, &f.cwd).await.unwrap();
}

#[tokio::test]
async fn failed_preview_delivery_releases_only_its_own_route() {
    let f = Fixture::new(true);
    f.manager
        .open_session(&f.agent, &f.cwd, None, vec![], Arc::new(|_| {}), &f.store)
        .await
        .unwrap();
    for fail_marker in [false, true] {
        let deliveries = Arc::new(Mutex::new(Vec::new()));
        let delivered = deliveries.clone();
        let failure = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let failed = failure.clone();
        let channel = tauri::ipc::Channel::new(move |body| {
            let value = body.deserialize::<Value>()?;
            if (fail_marker && value["kind"] == "history_preview_complete")
                || (!fail_marker && value.get("update").is_some())
            {
                failed.store(true, std::sync::atomic::Ordering::SeqCst);
                return Err(std::io::Error::other("fixture channel unavailable").into());
            }
            delivered.lock().unwrap().push(value);
            Ok(())
        });
        let result = super::session_discovery::open_import_preview(
            &f.manager,
            &f.store,
            &f.agent,
            &f.cwd,
            "history".into(),
            "failed-delivery".into(),
            "owned-preview-open",
            channel,
            None,
        )
        .await;
        assert!(failure.load(std::sync::atomic::Ordering::SeqCst));
        // An invoke result alone cannot publish a successful preview. This
        // matches the renderer's replayComplete gate for both failure branches.
        assert!(
            deliveries
                .lock()
                .unwrap()
                .iter()
                .all(|event| event["kind"] != "history_preview_complete")
        );
        match result {
            Err(error) => assert_eq!(error, "未能完整读取对话，请重试"),
            Ok(incomplete) => {
                assert_eq!(incomplete.preview_token, "failed-delivery");
                assert_eq!(incomplete.session.native_session_id, "history");
                assert_eq!(incomplete.session.cwd, f.cwd.to_string_lossy());
                let owner = f
                    .manager
                    .session_owner(&f.agent.id, &f.cwd, "history")
                    .unwrap()
                    .expect("incomplete preview must retain its cleanup owner");
                assert_eq!(
                    owner.sessions.lock().unwrap()["history"]
                        .preview_token
                        .as_deref(),
                    Some("failed-delivery")
                );
                drop(reserve_after_open_completes(
                    &f.manager.opening_sessions,
                    &f.agent.id,
                    &f.cwd,
                    "history",
                ));
                f.manager
                    .close_session_owned(
                        &f.agent.id,
                        &f.cwd,
                        "history",
                        Some(&incomplete.preview_token),
                    )
                    .await
                    .unwrap();
            }
        }
        assert!(
            f.manager
                .session_owner(&f.agent.id, &f.cwd, "history")
                .unwrap()
                .is_none()
        );
        assert!(
            f.manager
                .session_owner(&f.agent.id, &f.cwd, "live")
                .unwrap()
                .is_some()
        );
        assert!(f.store.list_sessions().unwrap().is_empty());
    }
    let preview = super::session_discovery::open_import_preview(
        &f.manager,
        &f.store,
        &f.agent,
        &f.cwd,
        "history".into(),
        "retry".into(),
        "owned-preview-open",
        tauri::ipc::Channel::new(|_| Ok(())),
        None,
    )
    .await
    .unwrap();
    drop(reserve_after_open_completes(
        &f.manager.opening_sessions,
        &f.agent.id,
        &f.cwd,
        "history",
    ));
    assert!(
        super::session_discovery::discard_unpublished_preview(
            &f.manager,
            &f.agent.id,
            &f.cwd,
            "history",
            "stale"
        )
        .is_err()
    );
    assert!(
        super::session_discovery::discard_unpublished_preview(
            &f.manager,
            &f.agent.id,
            &f.cwd,
            "live",
            "retry"
        )
        .is_err()
    );
    assert!(
        f.manager
            .session_owner(&f.agent.id, &f.cwd, "history")
            .unwrap()
            .is_some()
    );
    f.manager
        .close_session_owned(&f.agent.id, &f.cwd, "history", Some(&preview.preview_token))
        .await
        .unwrap();
    f.manager.disconnect(&f.agent.id, &f.cwd).await.unwrap();
}

#[tokio::test]
async fn failed_preview_rollback_retains_the_cleanup_token() {
    let f = Fixture::new(true);
    let reservations = f.manager.opening_sessions.clone();
    let agent_id = f.agent.id.clone();
    let cwd = f.cwd.clone();
    let reservation = Arc::new(Mutex::new(None));
    let reserved = reservation.clone();
    let failed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let failure = failed.clone();
    let deliveries = Arc::new(Mutex::new(Vec::new()));
    let delivered = deliveries.clone();
    let channel = tauri::ipc::Channel::new(move |body| {
        let value = body.deserialize::<Value>()?;
        if value["kind"] == "history_preview_complete" {
            *reserved.lock().unwrap() = Some(reserve_after_open_completes(
                &reservations,
                &agent_id,
                &cwd,
                "history",
            ));
            failure.store(true, std::sync::atomic::Ordering::SeqCst);
            return Err(std::io::Error::other("fixture marker unavailable").into());
        }
        delivered.lock().unwrap().push(value);
        Ok(())
    });
    let incomplete = super::session_discovery::open_import_preview(
        &f.manager,
        &f.store,
        &f.agent,
        &f.cwd,
        "history".into(),
        "cleanup-retained".into(),
        "owned-preview-open",
        channel,
        None,
    )
    .await
    .unwrap();
    assert!(failed.load(std::sync::atomic::Ordering::SeqCst));
    assert_eq!(incomplete.preview_token, "cleanup-retained");
    assert_eq!(incomplete.session.native_session_id, "history");
    assert_eq!(incomplete.session.cwd, f.cwd.to_string_lossy());
    assert!(reservation.lock().unwrap().is_some());
    assert!(
        deliveries
            .lock()
            .unwrap()
            .iter()
            .all(|event| event["kind"] != "history_preview_complete")
    );
    assert!(
        f.manager
            .session_owner(&f.agent.id, &f.cwd, "history")
            .unwrap()
            .is_some()
    );
    assert!(f.store.list_sessions().unwrap().is_empty());
    reservation.lock().unwrap().take();
    f.manager
        .close_session_owned(
            &f.agent.id,
            &f.cwd,
            "history",
            Some(&incomplete.preview_token),
        )
        .await
        .unwrap();
    assert!(
        f.manager
            .session_owner(&f.agent.id, &f.cwd, "history")
            .unwrap()
            .is_none()
    );
    assert!(f.store.list_sessions().unwrap().is_empty());
    f.manager.disconnect(&f.agent.id, &f.cwd).await.unwrap();
}

#[tokio::test]
async fn explicit_discovery_sends_global_cursor_and_preserves_remote_failure() {
    let f = Fixture::new(true);
    f.manager.connect(&f.agent, &f.cwd, &f.store).await.unwrap();
    let (first, can_load) = f
        .manager
        .discover_session_page(&f.agent.id, &f.cwd, None, None)
        .await
        .unwrap();
    assert!(can_load);
    assert_eq!(first.unwrap()["sessions"][0]["sessionId"], "first");
    let (next, _) = f
        .manager
        .discover_session_page(&f.agent.id, &f.cwd, None, Some("next".into()))
        .await
        .unwrap();
    assert_eq!(
        next.unwrap()["sessions"][0]["cwd"],
        "/missing/history-location"
    );
    for (cursor, expected) in [
        ("failure", "Agent 未返回有效的对话列表，请重试"),
        ("startup-text", "Agent 未返回有效的对话列表，请重试"),
        ("auth-text", "Agent 未返回有效的对话列表，请重试"),
        ("auth-code", "AUTH_REQUIRED"),
    ] {
        let error = f
            .manager
            .discover_session_page(&f.agent.id, &f.cwd, None, Some(cursor.into()))
            .await
            .unwrap_err();
        assert_eq!(error, expected);
    }
    let requests: Vec<Value> = std::fs::read_to_string(f.cwd.join("list-requests"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(requests[0], json!({}));
    assert_eq!(requests[1], json!({"cursor":"next"}));
    assert!(f.store.list_sessions().unwrap().is_empty());
    f.manager.disconnect(&f.agent.id, &f.cwd).await.unwrap();

    let unsupported = Fixture::new(false);
    unsupported
        .manager
        .connect(&unsupported.agent, &unsupported.cwd, &unsupported.store)
        .await
        .unwrap();
    let (page, can_load) = unsupported
        .manager
        .discover_session_page(&unsupported.agent.id, &unsupported.cwd, None, None)
        .await
        .unwrap();
    assert!(page.is_none());
    assert!(
        can_load,
        "a missing list declaration must not hide explicit load support"
    );
    assert!(!unsupported.cwd.join("list-requests").exists());
    unsupported
        .manager
        .disconnect(&unsupported.agent.id, &unsupported.cwd)
        .await
        .unwrap();
}

#[tokio::test]
async fn preview_ownership_rejects_live_sessions_and_stale_cleanup() {
    let f = Fixture::new(true);
    let received = Arc::new(Mutex::new(Vec::<Value>::new()));
    let sink = received.clone();
    let events: SessionSink = Arc::new(move |event| sink.lock().unwrap().push(event));
    f.manager
        .open_session(&f.agent, &f.cwd, None, vec![], events.clone(), &f.store)
        .await
        .unwrap();
    assert!(
        f.manager
            .open_session_owned_for_purpose(
                &f.agent,
                &f.cwd,
                Some("live".into()),
                vec![],
                events.clone(),
                &f.store,
                None,
                Some("preview-live".into()),
                super::open_purpose::OpenPurpose::ImportPreview,
                None,
                None,
            )
            .await
            .is_err()
    );
    assert!(
        f.manager
            .close_session_owned(&f.agent.id, &f.cwd, "live", Some("wrong"))
            .await
            .is_err()
    );
    f.manager
        .session_prompt(
            &f.agent.id,
            &f.cwd,
            "live",
            serde_json::from_value(json!([{"type":"text","text":"continue"}])).unwrap(),
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if received
                .lock()
                .unwrap()
                .iter()
                .any(|event| event["kind"] == "turnEnd")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(
        received
            .lock()
            .unwrap()
            .iter()
            .any(|event| event.to_string().contains("still-open"))
    );

    let first = f.manager.open_session_owned_for_purpose(
        &f.agent,
        &f.cwd,
        Some("history".into()),
        vec![],
        events.clone(),
        &f.store,
        None,
        Some("first".into()),
        super::open_purpose::OpenPurpose::ImportPreview,
        None,
        None,
    );
    let second = f.manager.open_session_owned_for_purpose(
        &f.agent,
        &f.cwd,
        Some("history".into()),
        vec![],
        events.clone(),
        &f.store,
        None,
        Some("second".into()),
        super::open_purpose::OpenPurpose::ImportPreview,
        None,
        None,
    );
    let (a, b) = tokio::join!(first, second);
    assert_ne!(a.is_ok(), b.is_ok());
    let token = if a.is_ok() { "first" } else { "second" };
    assert!(
        f.manager
            .open_session(
                &f.agent,
                &f.cwd,
                Some("history".into()),
                vec![],
                events.clone(),
                &f.store
            )
            .await
            .is_err()
    );
    assert!(
        f.manager
            .close_session_owned(&f.agent.id, &f.cwd, "history", Some("stale"))
            .await
            .is_err()
    );
    assert_eq!(
        f.store.list_sessions().unwrap().len(),
        1,
        "only the real prompted conversation is indexed"
    );
    f.manager
        .close_session_owned(&f.agent.id, &f.cwd, "history", Some(token))
        .await
        .unwrap();
    f.manager
        .open_session(
            &f.agent,
            &f.cwd,
            Some("history".into()),
            vec![],
            events.clone(),
            &f.store,
        )
        .await
        .unwrap();
    assert!(
        f.manager
            .close_session_owned(&f.agent.id, &f.cwd, "history", Some(token))
            .await
            .is_err()
    );
    assert!(
        f.manager
            .session_connection(&f.agent.id, &f.cwd, "history")
            .is_ok()
    );
    assert!(
        f.manager
            .open_session_owned_for_purpose(
                &f.agent,
                &f.cwd,
                Some("failure".into()),
                vec![],
                events,
                &f.store,
                None,
                Some("failed".into()),
                super::open_purpose::OpenPurpose::ImportPreview,
                None,
                None,
            )
            .await
            .is_err()
    );
    assert_eq!(f.store.list_sessions().unwrap().len(), 1);
    f.manager.disconnect(&f.agent.id, &f.cwd).await.unwrap();
}

#[tokio::test]
async fn preview_cleanup_is_idempotent_after_detach_and_agent_exit() {
    let f = Fixture::new(true);
    let events: SessionSink = Arc::new(|_| {});
    f.manager
        .open_session_owned_for_purpose(
            &f.agent,
            &f.cwd,
            Some("history".into()),
            vec![],
            events.clone(),
            &f.store,
            None,
            Some("first".into()),
            super::open_purpose::OpenPurpose::ImportPreview,
            None,
            None,
        )
        .await
        .unwrap();
    for _ in 0..2 {
        f.manager
            .close_session_owned(&f.agent.id, &f.cwd, "history", Some("first"))
            .await
            .unwrap();
    }
    assert!(
        f.manager
            .close_session(&f.agent.id, &f.cwd, "history")
            .await
            .is_err()
    );
    f.manager
        .open_session_owned_for_purpose(
            &f.agent,
            &f.cwd,
            Some("history".into()),
            vec![],
            events,
            &f.store,
            None,
            Some("second".into()),
            super::open_purpose::OpenPurpose::ImportPreview,
            None,
            None,
        )
        .await
        .unwrap();
    assert!(
        f.manager
            .close_session_owned(&f.agent.id, &f.cwd, "history", Some("first"))
            .await
            .is_err()
    );
    let owner = f
        .manager
        .session_owner(&f.agent.id, &f.cwd, "history")
        .unwrap()
        .unwrap();
    let pid = owner.child_pid.load(std::sync::atomic::Ordering::SeqCst);
    assert!(pid > 0);
    assert_eq!(crate::platform_tests::terminate(pid as i32), 0);
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), owner.life.closed())
        .await
        .unwrap();
    assert!(
        f.manager
            .session_owner(&f.agent.id, &f.cwd, "history")
            .unwrap()
            .is_none()
    );
    f.manager
        .close_session_owned(&f.agent.id, &f.cwd, "history", Some("second"))
        .await
        .unwrap();
}

#[tokio::test]
async fn preview_cleanup_after_late_close_keeps_real_close_failures() {
    let mut f = Fixture::new(true);
    f.agent.args.push("--remote-close".into());
    f.store.replace_agent_launch(&f.agent).unwrap();
    let events: SessionSink = Arc::new(|_| {});
    f.manager
        .open_session_owned_for_purpose(
            &f.agent,
            &f.cwd,
            Some("history".into()),
            vec![],
            events.clone(),
            &f.store,
            None,
            Some("late".into()),
            super::open_purpose::OpenPurpose::ImportPreview,
            None,
            None,
        )
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            f.manager
                .close_session_owned(&f.agent.id, &f.cwd, "history", Some("late")),
        )
        .await
        .is_err()
    );
    assert!(f.cwd.join("close-started").exists());
    assert!(
        f.manager
            .close_session_owned(&f.agent.id, &f.cwd, "history", Some("late"))
            .await
            .is_err(),
        "unconfirmed close must remain an error"
    );
    std::fs::write(f.cwd.join("close-release"), "confirm").unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while f
            .manager
            .session_owner(&f.agent.id, &f.cwd, "history")
            .unwrap()
            .is_some()
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    f.manager
        .close_session_owned(&f.agent.id, &f.cwd, "history", Some("late"))
        .await
        .unwrap();
    f.manager
        .open_session_owned_for_purpose(
            &f.agent,
            &f.cwd,
            Some("refuse-close".into()),
            vec![],
            events,
            &f.store,
            None,
            Some("refused".into()),
            super::open_purpose::OpenPurpose::ImportPreview,
            None,
            None,
        )
        .await
        .unwrap();
    assert!(
        f.manager
            .close_session_owned(&f.agent.id, &f.cwd, "refuse-close", Some("refused"))
            .await
            .is_err()
    );
    assert!(
        f.manager
            .session_owner(&f.agent.id, &f.cwd, "refuse-close")
            .unwrap()
            .is_some()
    );
    f.manager.disconnect(&f.agent.id, &f.cwd).await.unwrap();
}
