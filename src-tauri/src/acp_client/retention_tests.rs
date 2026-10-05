//! Connection retention is tested with a controlled protocol peer, never an Agent.
use super::*;

#[tokio::test(flavor = "multi_thread")]
async fn idle_recycling_does_not_assume_load_capability_proves_recovery() {
    for supports_load in [false, true] {
        let f = Fixture::new();
        if !supports_load {
            std::fs::write(
                f.cwd.join("peer.py"),
                PEER.replace("'loadSession':True", "'loadSession':False"),
            )
            .unwrap();
        }
        let opened = f
            .manager
            .open_session(&f.row, &f.cwd, None, vec![], Arc::new(|_| {}), &f.store)
            .await
            .unwrap();
        let connection = f
            .manager
            .session_connection(&f.row.id, &f.cwd, &opened.session_id)
            .unwrap();
        assert!(
            connection
                .sessions
                .lock()
                .unwrap()
                .contains_key(&opened.session_id)
        );
        assert!(
            !connection.life.close(false, Some(Duration::ZERO)).unwrap(),
            "an open conversation must be retained even when loadSession={supports_load}"
        );
        f.manager
            .close_session(&f.row.id, &f.cwd, &opened.session_id)
            .await
            .unwrap();
        assert!(connection.sessions.lock().unwrap().is_empty());
        assert!(connection.life.close(false, Some(Duration::ZERO)).unwrap());
        connection.life.closed().await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn exact_page_hold_does_not_retain_another_directory_or_service() {
    let f = Fixture::new();
    f.connect().await;
    let connection = f.manager.live_connection(&f.row.id, &f.cwd).unwrap();
    assert!(
        !f.manager
            .hold_connection(
                &f.row.id,
                &f.cwd.join("elsewhere"),
                None,
                "main",
                "page",
                true
            )
            .unwrap()
    );
    assert!(
        !f.manager
            .hold_connection(
                &f.row.id,
                &f.cwd,
                Some("another-service"),
                "main",
                "page",
                true
            )
            .unwrap()
    );
    assert!(
        f.manager
            .hold_connection(&f.row.id, &f.cwd, None, "main", "page", true)
            .unwrap()
    );
    assert!(!connection.life.close(false, Some(Duration::ZERO)).unwrap());
    assert!(
        !f.manager
            .hold_connection(
                &f.row.id,
                &f.cwd,
                Some("another-service"),
                "main",
                "page",
                false
            )
            .unwrap()
    );
    assert!(!connection.life.close(false, Some(Duration::ZERO)).unwrap());
    assert!(
        f.manager
            .hold_connection(&f.row.id, &f.cwd, None, "main", "page", false)
            .unwrap()
    );
    assert!(connection.life.close(false, Some(Duration::ZERO)).unwrap());
    connection.life.closed().await.unwrap();
}

fn fixture_with_status() -> (
    Fixture,
    tokio::sync::mpsc::UnboundedReceiver<super::super::manager::AgentConnectionStatus>,
) {
    let mut f = Fixture::new();
    let (send, receive) = tokio::sync::mpsc::unbounded_channel();
    f.manager = Arc::new(
        AcpManager::new(f.cwd.join("logs"), f.cwd.clone()).with_status_sink(Arc::new(
            move |status| {
                let _ = send.send(status);
            },
        )),
    );
    (f, receive)
}

#[tokio::test(flavor = "multi_thread")]
async fn idle_status_is_published_before_replacement_ready_and_keeps_exact_scope() {
    use super::super::manager::CloseReason;
    let (f, mut statuses) = fixture_with_status();
    f.connect().await;
    assert_eq!(statuses.recv().await.unwrap().state, "ready");
    let connection = f.manager.live_connection(&f.row.id, &f.cwd).unwrap();
    assert!(connection.life.close(false, Some(Duration::ZERO)).unwrap());
    connection.life.closed().await.unwrap();
    f.connect().await;
    let closed = statuses.recv().await.unwrap();
    assert_eq!(closed.agent_id, f.row.id);
    assert_eq!(closed.cwd, f.cwd.to_string_lossy());
    assert!(closed.service_context.is_none());
    assert_eq!(closed.state, "closed");
    assert_eq!(closed.close_reason, Some(CloseReason::Idle));
    let ready = statuses.recv().await.unwrap();
    assert_eq!(ready.state, "ready");
    assert_eq!(ready.close_reason, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn explicit_and_unexpected_close_reasons_reach_status_and_the_conversation() {
    use super::super::manager::CloseReason;
    for unexpected in [false, true] {
        let (f, mut statuses) = fixture_with_status();
        let (send, mut events) = tokio::sync::mpsc::unbounded_channel();
        f.manager
            .open_session(
                &f.row,
                &f.cwd,
                None,
                vec![],
                Arc::new(move |event| {
                    let _ = send.send(event);
                }),
                &f.store,
            )
            .await
            .unwrap();
        assert_eq!(statuses.recv().await.unwrap().state, "ready");
        let connection = f
            .manager
            .session_connection(&f.row.id, &f.cwd, "fixture")
            .unwrap();
        let reason = if unexpected {
            let pid = connection
                .child_pid
                .load(std::sync::atomic::Ordering::SeqCst);
            assert_eq!(unsafe { libc::kill(pid as i32, libc::SIGTERM) }, 0);
            CloseReason::Unexpected
        } else {
            f.manager.disconnect(&f.row.id, &f.cwd).await.unwrap();
            CloseReason::User
        };
        let status = tokio::time::timeout(Duration::from_secs(5), statuses.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status.close_reason, Some(reason));
        let lost = tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(event) = events.recv().await {
                if event["kind"] == "connectionLost" {
                    return event;
                }
            }
            panic!("no conversation close event");
        })
        .await
        .unwrap();
        assert_eq!(lost["closeReason"], serde_json::to_value(reason).unwrap());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn initialization_failure_publishes_its_startup_reason() {
    use super::super::manager::CloseReason;
    let (f, mut statuses) = fixture_with_status();
    // Ordinary connect reloads the registered launch row, so vary the fixture
    // response itself instead of changing only the caller's copy of its args.
    std::fs::write(
        f.cwd.join("peer.py"),
        PEER.replace("elif '--reject-init' in sys.argv:", "elif True:"),
    )
    .unwrap();
    assert!(f.manager.connect(&f.row, &f.cwd, &f.store).await.is_err());
    let status = tokio::time::timeout(Duration::from_secs(5), statuses.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.close_reason, Some(CloseReason::StartupFailed));
    assert_ne!(status.state, "ready");
}
