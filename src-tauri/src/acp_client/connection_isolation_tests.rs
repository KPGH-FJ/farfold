//! Actual stdio peers exercise process ownership; no installed Agent is launched.
use super::*;
use crate::acp_client::manager::ConnectionPurpose;
use std::sync::atomic::Ordering;

fn distinct_sessions(f: &Fixture) {
    std::fs::write(
        f.cwd.join("peer.py"),
        PEER.replace(
            "os.environ.get('FIXTURE_SESSION','fixture')",
            "str(os.getpid())",
        ),
    )
    .unwrap();
}

async fn open(f: &Fixture) -> (String, Arc<std::sync::Mutex<Vec<Value>>>) {
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = events.clone();
    let opened = f
        .manager
        .open_session(
            &f.row,
            &f.cwd,
            None,
            vec![],
            Arc::new(move |value| captured.lock().unwrap().push(value)),
            &f.store,
        )
        .await
        .unwrap();
    (opened.session_id, events)
}

#[tokio::test(flavor = "multi_thread")]
async fn same_agent_directory_and_source_isolate_processes_stop_and_preparation() {
    let f = Fixture::new();
    distinct_sessions(&f);
    f.connect().await;
    let preparation = f.manager.live_connection(&f.row.id, &f.cwd).unwrap();
    let (a, events_a) = open(&f).await;
    let (b, events_b) = open(&f).await;
    let first = f.manager.session_connection(&f.row.id, &f.cwd, &a).unwrap();
    let second = f.manager.session_connection(&f.row.id, &f.cwd, &b).unwrap();
    assert_ne!(first.connection_id, second.connection_id);
    assert_ne!(
        first.child_pid.load(Ordering::SeqCst),
        second.child_pid.load(Ordering::SeqCst)
    );
    assert_ne!(first.connection_id, preparation.connection_id);
    let statuses = f.manager.status(&f.row.id).unwrap();
    assert_eq!(statuses.len(), 3);
    assert_eq!(
        statuses
            .iter()
            .filter(|status| status.purpose == ConnectionPurpose::Conversation)
            .count(),
        2
    );
    for (id, events) in [(&a, &events_a), (&b, &events_b)] {
        f.manager
            .session_prompt(
                &f.row.id,
                &f.cwd,
                id,
                serde_json::from_value(json!([{"type":"text","text":"ask"}])).unwrap(),
            )
            .await
            .unwrap();
        until(|| {
            events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| event["kind"] == "elicitation")
                .count()
                == 2
        })
        .await;
    }
    assert_eq!(f.manager.pending_elicitations.lock().unwrap().len(), 4);
    assert!(
        f.manager
            .disconnect_selected(&f.row.id, None, None)
            .await
            .is_err()
    );
    // Refreshing account information only replaces the preparation process.
    f.manager
        .recheck_authentication(&f.row.id, &f.cwd, &f.store)
        .await
        .unwrap();
    assert_ne!(
        unsafe { libc::kill(preparation.child_pid.load(Ordering::SeqCst) as i32, 0) },
        0
    );
    for connection in [&first, &second] {
        assert_eq!(
            connection.state.load(Ordering::SeqCst),
            crate::acp_client::manager::STATE_READY
        );
        assert_eq!(connection.life.work.load(Ordering::SeqCst), 3);
    }
    f.manager
        .session_cancel(&f.row.id, &f.cwd, &a)
        .await
        .unwrap();
    until(|| {
        events_a
            .lock()
            .unwrap()
            .iter()
            .any(|event| event["kind"] == "turnEnd")
    })
    .await;
    assert!(
        !events_b
            .lock()
            .unwrap()
            .iter()
            .any(|event| event["kind"] == "turnEnd")
    );
    assert_eq!(f.manager.pending_elicitations.lock().unwrap().len(), 2);
    assert!(
        f.manager
            .disconnect_selected(&f.row.id, None, Some(&first.connection_id))
            .await
            .unwrap()
    );
    assert_eq!(
        unsafe { libc::kill(second.child_pid.load(Ordering::SeqCst) as i32, 0) },
        0
    );
    assert!(f.manager.live_connection(&f.row.id, &f.cwd).is_ok());
    f.manager
        .session_cancel(&f.row.id, &f.cwd, &b)
        .await
        .unwrap();
    until(|| {
        events_b
            .lock()
            .unwrap()
            .iter()
            .any(|event| event["kind"] == "turnEnd")
    })
    .await;
    assert!(
        f.manager
            .disconnect_selected(&f.row.id, None, None)
            .await
            .unwrap()
    );
    assert!(f.manager.status(&f.row.id).unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn pending_new_retains_its_process_and_blocks_another_new_until_response() {
    let f = Fixture::new();
    distinct_sessions(&f);
    let script = std::fs::read_to_string(f.cwd.join("peer.py")).unwrap().replace(
        "elif method=='session/new': reply(m,",
        "elif method=='session/new':\n  open(sys.argv[1]+'_new','w').write(str(os.getpid()))\n  while not os.path.exists(sys.argv[1]+'_release'): time.sleep(.005)\n  reply(m,",
    );
    std::fs::write(f.cwd.join("peer.py"), script).unwrap();
    let mut opening =
        Box::pin(
            f.manager
                .open_session(&f.row, &f.cwd, None, vec![], Arc::new(|_| {}), &f.store),
        );
    tokio::select! {
        result = &mut opening => panic!("unexpected completion: {}", result.is_ok()),
        _ = until(|| f.cwd.join("listed_new").exists()) => {}
    }
    drop(opening);
    let pid: i32 = std::fs::read_to_string(f.cwd.join("listed_new"))
        .unwrap()
        .parse()
        .unwrap();
    let connection = f.manager.lock().unwrap().values().next().unwrap().clone();
    assert!(!connection.life.close(false, Some(Duration::ZERO)).unwrap());
    assert!(
        f.manager
            .open_session(&f.row, &f.cwd, None, vec![], Arc::new(|_| {}), &f.store)
            .await
            .is_err()
    );
    assert_eq!(f.manager.status(&f.row.id).unwrap().len(), 1);
    assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
    std::fs::write(f.cwd.join("listed_release"), "release").unwrap();
    until(|| {
        f.manager
            .opening_sessions
            .reserve_open(&f.row.id, &f.cwd, None)
            .is_ok()
    })
    .await;
    // The abandoned successful creation remains owned until explicit shutdown.
    assert!(!connection.life.close(false, Some(Duration::ZERO)).unwrap());
    assert!(
        f.manager
            .open_session(
                &f.row,
                &f.cwd,
                Some(pid.to_string()),
                vec![],
                Arc::new(|_| {}),
                &f.store,
            )
            .await
            .is_err()
    );
    let (next, _) = open(&f).await;
    assert_ne!(next, pid.to_string());
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
    assert_ne!(unsafe { libc::kill(pid, 0) }, 0);
    let restored = f
        .manager
        .open_session(
            &f.row,
            &f.cwd,
            Some(pid.to_string()),
            vec![],
            Arc::new(|_| {}),
            &f.store,
        )
        .await
        .unwrap();
    assert_eq!(restored.session_id, pid.to_string());
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn colliding_native_id_cannot_replace_existing_route_or_index() {
    let f = Fixture::new();
    let (id, _) = open(&f).await;
    let first = f
        .manager
        .session_connection(&f.row.id, &f.cwd, &id)
        .unwrap();
    let row_id =
        crate::acp_client::session_index::session_row_id(&f.row.id, &f.cwd.to_string_lossy(), &id);
    let before = f.store.get_session(&row_id).unwrap();
    let failure = f
        .manager
        .open_session(&f.row, &f.cwd, None, vec![], Arc::new(|_| {}), &f.store)
        .await;
    assert!(failure.err().unwrap().contains("标识已被使用"));
    assert_eq!(f.store.get_session(&row_id).unwrap(), before);
    assert_eq!(
        f.manager
            .session_connection(&f.row.id, &f.cwd, &id)
            .unwrap()
            .connection_id,
        first.connection_id
    );
    let owners: Vec<_> = f.manager.lock().unwrap().values().cloned().collect();
    assert_eq!(owners.len(), 2);
    for owner in &owners {
        assert!(!owner.life.close(false, Some(Duration::ZERO)).unwrap());
    }
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn cold_new_collision_preserves_history_and_keeps_remote_creation_owned() {
    let f = Fixture::new();
    let (id, _) = open(&f).await;
    let row_id =
        crate::acp_client::session_index::session_row_id(&f.row.id, &f.cwd.to_string_lossy(), &id);
    crate::acp_client::session_index::touch_session_row(
        &f.store,
        &f.row.id,
        &f.cwd.to_string_lossy(),
        &id,
        Some("preserved history"),
        None,
    )
    .unwrap();
    let before = f.store.get_session(&row_id).unwrap();
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
    assert!(f.manager.status(&f.row.id).unwrap().is_empty());
    let failure = f
        .manager
        .open_session(&f.row, &f.cwd, None, vec![], Arc::new(|_| {}), &f.store)
        .await
        .err()
        .unwrap();
    assert!(failure.contains("已有历史记录"));
    assert_eq!(f.store.get_session(&row_id).unwrap(), before);
    assert!(
        f.manager
            .session_owner(&f.row.id, &f.cwd, &id)
            .unwrap()
            .is_none()
    );
    let connection = f.manager.lock().unwrap().values().next().unwrap().clone();
    let pid = connection.child_pid.load(Ordering::SeqCst);
    assert!(!connection.life.close(false, Some(Duration::ZERO)).unwrap());
    assert_eq!(unsafe { libc::kill(pid as i32, 0) }, 0);
    f.manager
        .disconnect_selected(&f.row.id, None, Some(&connection.connection_id))
        .await
        .unwrap();
    assert_ne!(unsafe { libc::kill(pid as i32, 0) }, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn failed_new_validation_keeps_known_identity_until_exact_process_reaping() {
    let f = Fixture::new();
    f.connect().await;
    let connection = f.manager.live_connection(&f.row.id, &f.cwd).unwrap();
    let (result, receive) = tokio::sync::oneshot::channel();
    connection
        .send_reserved(
            crate::acp_client::manager::ManagerCommand::OpenSession {
                native_session_id: None,
                preview_token: None,
                recorded_config: None,
                config_store: Box::new(crate::acp_client::model_guard::ConfigStore {
                    store: f.store.clone(),
                    agent_id: f.row.id.clone(),
                    cwd: f.cwd.to_string_lossy().into(),
                    service_record: None,
                    expected_model: None,
                    verified_permission_option: true,
                }),
                config_options: vec![],
                mcp: None,
                browser_unavailable: None,
                events: Arc::new(|_| {}),
                result,
            },
            Some(
                f.manager
                    .opening_sessions
                    .reserve_open(&f.row.id, &f.cwd, None)
                    .unwrap(),
            ),
        )
        .unwrap();
    let failure = receive.await.unwrap().unwrap().accept();
    assert!(failure.is_err());
    assert!(
        f.manager
            .session_owner(&f.row.id, &f.cwd, "fixture")
            .unwrap()
            .is_none()
    );
    let mut alias = f.row.clone();
    alias.id = "failed-open-alias".into();
    f.store.insert_agent(&alias).unwrap();
    f.manager.connect(&alias, &f.cwd, &f.store).await.unwrap();
    assert!(f.manager.reserve_account_change(&alias.id).is_err());
    let before = f.manager.status(&f.row.id).unwrap();
    assert_eq!(before.len(), 1);
    assert!(
        f.manager
            .open_session(
                &f.row,
                &f.cwd,
                Some("fixture".into()),
                vec![],
                Arc::new(|_| {}),
                &f.store,
            )
            .await
            .is_err()
    );
    assert_eq!(f.manager.status(&f.row.id).unwrap(), before);
    f.manager
        .disconnect_selected(&f.row.id, None, Some(&before[0].connection_id))
        .await
        .unwrap();
    assert!(f.manager.reserve_account_change(&alias.id).is_ok());
    let restored = f
        .manager
        .open_session(
            &f.row,
            &f.cwd,
            Some("fixture".into()),
            vec![],
            Arc::new(|_| {}),
            &f.store,
        )
        .await
        .unwrap();
    assert_eq!(restored.session_id, "fixture");
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn precise_view_hold_and_restore_keep_connection_purposes_separate() {
    let f = Fixture::new();
    distinct_sessions(&f);
    f.connect().await;
    let preparation = f.manager.live_connection(&f.row.id, &f.cwd).unwrap();
    let (id, _) = open(&f).await;
    let original = f
        .manager
        .session_connection(&f.row.id, &f.cwd, &id)
        .unwrap();
    assert!(
        f.manager
            .hold_connection_exact(
                &f.row.id,
                &f.cwd,
                None,
                Some(&original.connection_id),
                "main",
                "thread",
                true
            )
            .unwrap()
    );
    f.manager
        .close_session(&f.row.id, &f.cwd, &id)
        .await
        .unwrap();
    assert!(!original.life.close(false, Some(Duration::ZERO)).unwrap());
    assert!(
        f.manager
            .hold_connection(&f.row.id, &f.cwd, None, "main", "setup", true)
            .unwrap()
    );
    assert!(
        !f.manager
            .hold_connection_exact(
                &f.row.id,
                &f.cwd,
                Some("wrong-source"),
                Some(&original.connection_id),
                "main",
                "thread",
                false
            )
            .unwrap()
    );
    assert!(
        f.manager
            .hold_connection_exact(
                &f.row.id,
                &f.cwd,
                None,
                Some(&original.connection_id),
                "main",
                "thread",
                false
            )
            .unwrap()
    );
    assert!(original.life.close(false, Some(Duration::ZERO)).unwrap());
    original.life.closed().await.unwrap();
    assert!(!preparation.life.close(false, Some(Duration::ZERO)).unwrap());
    let restored = f
        .manager
        .open_session(
            &f.row,
            &f.cwd,
            Some(id.clone()),
            vec![],
            Arc::new(|_| {}),
            &f.store,
        )
        .await
        .unwrap();
    assert_eq!(restored.session_id, id);
    let owner = f
        .manager
        .session_connection(&f.row.id, &f.cwd, &id)
        .unwrap();
    assert_ne!(owner.connection_id, original.connection_id);
    assert_ne!(owner.connection_id, preparation.connection_id);
    f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
}
