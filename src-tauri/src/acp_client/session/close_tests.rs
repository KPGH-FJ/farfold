use super::*;
use crate::acp_client::lifecycle::{CLOSING, CONNECTING, ConnectionLife};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock, atomic::AtomicU32},
};

fn register(manager: &AcpManager, key: ConnectionKey, state: u8) -> ManagedConnection {
    let life = ConnectionLife::new();
    life.state.store(state, Ordering::SeqCst);
    let (command_tx, _receive) = mpsc::unbounded_channel();
    let connection = ManagedConnection {
        command_tx,
        state: life.state.clone(),
        handshake: Arc::new(OnceLock::new()),
        sessions: Arc::new(Mutex::new(HashMap::new())),
        child_pid: Arc::new(AtomicU32::new(0)),
        life,
        service: None,
    };
    manager.lock().unwrap().insert(key, connection.clone());
    connection
}

fn key(cwd: &Path) -> ConnectionKey {
    ConnectionKey {
        agent_id: "close-retry-fixture".into(),
        cwd: cwd.into(),
        candidate: false,
        service: None,
    }
}

#[tokio::test]
async fn auth_cleanup_can_retry_confirmed_absence_without_changing_default_close() {
    let dir = tempfile::tempdir().unwrap();
    let manager = AcpManager::new(dir.path().join("logs"), dir.path().into());
    assert!(
        manager
            .close_session("close-retry-fixture", dir.path(), "gone")
            .await
            .is_err()
    );
    assert!(
        manager
            .close_session_for_auth("close-retry-fixture", dir.path(), "gone")
            .await
            .is_ok()
    );
    register(&manager, key(dir.path()), STATE_READY);
    assert!(
        manager
            .close_session_for_auth("close-retry-fixture", dir.path(), "gone")
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn connecting_or_closing_process_owner_is_not_confirmed_absence() {
    for state in [CONNECTING, CLOSING] {
        let dir = tempfile::tempdir().unwrap();
        let manager = AcpManager::new(dir.path().join("logs"), dir.path().into());
        let mut same_source = key(dir.path());
        same_source.service = Some("other-existing-source".into());
        register(&manager, same_source, state);
        assert!(
            manager
                .close_session_for_auth("close-retry-fixture", dir.path(), "gone")
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn unrelated_directory_or_candidate_does_not_replace_the_exact_absence_check() {
    let dir = tempfile::tempdir().unwrap();
    let manager = AcpManager::new(dir.path().join("logs"), dir.path().into());
    let mut candidate = key(dir.path());
    candidate.candidate = true;
    register(&manager, candidate, CLOSING);
    register(&manager, key(&dir.path().join("elsewhere")), CONNECTING);
    assert!(
        manager
            .close_session_for_auth("close-retry-fixture", dir.path(), "gone")
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn failed_route_lookup_is_not_confirmed_absence() {
    let dir = tempfile::tempdir().unwrap();
    let manager = AcpManager::new(dir.path().join("logs"), dir.path().into());
    let connection = register(&manager, key(dir.path()), STATE_READY);
    let sessions = connection.sessions.clone();
    assert!(
        std::thread::spawn(move || {
            let _guard = sessions.lock().unwrap();
            panic!("controlled lock failure");
        })
        .join()
        .is_err()
    );
    assert!(
        manager
            .close_session_for_auth("close-retry-fixture", dir.path(), "gone")
            .await
            .is_err()
    );
}
