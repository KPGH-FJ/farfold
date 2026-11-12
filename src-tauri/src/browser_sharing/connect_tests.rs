use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
fn direct() -> (
    tempfile::TempDir,
    Arc<ToolSession>,
    FixedPageReadScope,
    Arc<AtomicBool>,
) {
    let dir = tempfile::tempdir().unwrap();
    let (page, _) =
        crate::browser_workspace::sharing_scope_fixture("controlled:/fixture:native", "page");
    let owner = super::super::state_tests::session(page.clone());
    let manager = AcpManager::new(dir.path().join("logs"), dir.path().into());
    let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
    owner.state.lock().unwrap().connection = Some(Attempt {
        manager,
        store,
        target: ShareTarget {
            agent_id: "controlled".into(),
            cwd: "/fixture".into(),
            native_session_id: "native".into(),
        },
        connection_id: "connection".into(),
        operation_id: "original-operation".into(),
        descriptor: serde_json::json!({"socket":"/owned/private.sock"}),
        confirmed: true,
        exact_key: Some("exact-key".into()),
        remove_operation: None,
        safe_failed: false,
        removed: false,
        unknown: false,
    });
    let (handle, stopped) = transport::control_state_fixture(owner.page.clone());
    assert!(owner.transport.set(handle).is_ok());
    (dir, owner, page, stopped)
}
#[test]
fn shutdown_retires_all_page_scopes_but_keeps_management_transport_and_original_attempt() {
    let (_a, first, page1, stopped1) = direct();
    let (_b, second, page2, stopped2) = direct();
    retire_connections(&[first.clone(), second.clone()]);
    for (owner, page, stopped) in [(&first, page1, stopped1), (&second, page2, stopped2)] {
        assert!(!page.is_valid());
        assert!(
            !stopped.load(Ordering::SeqCst),
            "exact remove still needs live HTTP management"
        );
        let state = owner.state.lock().unwrap();
        assert!(!state.ended);
        assert_eq!(state.phase, STOPPING);
        assert_eq!(
            state.connection.as_ref().unwrap().operation_id,
            "original-operation"
        );
        drop(state);
        assert!(
            !owner.removable(),
            "cancelled exit must retain an unresolved original attempt"
        );
    }
}
#[test]
fn settled_unknown_is_recheckable_without_another_connect_or_page_permission() {
    let (_dir, mut owner, _page, _stopped) = direct();
    let notifications = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen = notifications.clone();
    Arc::get_mut(&mut owner).unwrap().notify = Arc::new(move |_| {
        seen.fetch_add(1, Ordering::SeqCst);
    });
    let revision = owner.state.lock().unwrap().revision;
    owner
        .state
        .lock()
        .unwrap()
        .connection
        .as_mut()
        .unwrap()
        .confirmed = false;
    let reply = Ok(changes::Operation {
        kind: "addHttp",
        operation_id: "original-operation".into(),
        agent_id: "controlled".into(),
        cwd: "/fixture".into(),
        native_session_id: "native".into(),
        connection_id: "connection".into(),
        state: changes::State::Unknown,
        settled: true,
        mutation_sent: true,
        conversation_saved: true,
        persistence: changes::Persistence::Unknown,
        activity: changes::Activity::Unreported,
        items: vec![],
        error: None,
    });
    observe(&owner, &reply);
    observe(&owner, &reply);
    assert_eq!(
        notifications.load(Ordering::SeqCst),
        1,
        "same unknown status cannot schedule another status query"
    );
    assert_eq!(owner.state.lock().unwrap().revision, revision + 1);
    let info = owner.info("controlled:/fixture:native", "page");
    assert_eq!(info.phase, "unavailable");
    assert_eq!(info.connection_reason, Some("connection_unknown"));
    assert_eq!(info.connection_available, Some(false));
    assert!(!owner.removable());
    let json = serde_json::to_string(&info).unwrap();
    assert!(!json.contains("private.sock"));
    assert!(!json.contains("exact-key"));
}
#[test]
fn direct_connection_cannot_fork_a_same_process_child_even_without_page_grant() {
    let (_dir, owner, page, _stopped) = direct();
    page.revoke();
    owner.page.lock().unwrap().take();
    owner.state.lock().unwrap().prompt_active = false;
    assert!(!owner.fork_admissible());
    assert_eq!(owner.fork_blocker(), Some("browser_connected"));
    owner
        .state
        .lock()
        .unwrap()
        .connection
        .as_mut()
        .unwrap()
        .removed = true;
    assert!(owner.fork_admissible());
}
#[test]
fn repeated_ready_and_removed_observations_do_not_emit_duplicate_changes() {
    let (_dir, mut owner, _page, _stopped) = direct();
    let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen = count.clone();
    Arc::get_mut(&mut owner).unwrap().notify = Arc::new(move |_| {
        seen.fetch_add(1, Ordering::SeqCst);
    });
    confirm(&owner);
    confirm(&owner);
    assert_eq!(count.load(Ordering::SeqCst), 0);
    removed(&owner);
    let initial = count.load(Ordering::SeqCst);
    assert!(initial > 0);
    removed(&owner);
    assert_eq!(count.load(Ordering::SeqCst), initial);
}
