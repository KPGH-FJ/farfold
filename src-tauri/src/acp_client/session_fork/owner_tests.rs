//! Controlled lifecycle ownership, no process, App, account or Agent is used.
use super::*;
use crate::acp_client::lifecycle::{ConnectionLife, OpenReservations};

fn state() -> (Arc<SourceFork>, Arc<ConnectionLife>, OpenReservations) {
    let life = ConnectionLife::new();
    life.ready().unwrap();
    let openings = OpenReservations::default();
    let parent = openings
        .reserve("agent", Path::new("/project"), "parent")
        .unwrap();
    let (child, exclusive) = openings
        .claim_fork("agent", Path::new("/project"), "child")
        .unwrap();
    assert!(exclusive);
    let result = ForkResult {
        status: "created_unavailable",
        operation_id: "copy".into(),
        parent_connection_id: "owner".into(),
        parent_session_id: "parent".into(),
        cwd: "/project".into(),
        child_session_id: Some("child".into()),
        indexed: true,
        source_released: false,
        session: None,
        reason: Some("source_close_failed"),
        history_point: None,
    };
    let state = Arc::new(SourceFork {
        open_token: "owned-open".into(),
        busy: AtomicBool::new(true),
        result: Mutex::new(result.clone()),
        updated: watch::channel(result).0,
        publishing: Mutex::new(()),
        parent_events: Arc::new(|_| {}),
        child_events: Arc::new(|_| {}),
        holds: Mutex::new(Some(Holds {
            _work: life.work().unwrap(),
            _operation: life.operation("fork:parent".into()).unwrap(),
            _parent: parent,
            child: Some(child),
        })),
    });
    (state, life, openings)
}
#[tokio::test]
async fn fork_observer_keeps_open_identity_after_all_delivery_and_pump_owners_drop() {
    let (mut state, life, openings) = state();
    let final_events = Arc::new(Mutex::new(Vec::new()));
    let saved = final_events.clone();
    Arc::get_mut(&mut state).unwrap().child_events =
        Arc::new(move |value| saved.lock().unwrap().push(value));
    let weak = Arc::downgrade(&state);
    let observer = state.observe_parent(life.clone());
    life.close(true, None).unwrap();
    drop(state);
    let retained = weak.upgrade().is_some();
    let parent_protected = openings
        .reserve("agent", Path::new("/project"), "parent")
        .is_err();
    let child_protected = openings
        .reserve("agent", Path::new("/other"), "child")
        .is_err();
    assert!(!life.finished());
    life.finish(Err("controlled actual owner end".into()));
    tokio::time::timeout(Duration::from_secs(1), observer)
        .await
        .unwrap()
        .unwrap();
    assert!(
        retained && parent_protected && child_protected,
        "direct opening holders must outlive lost IPC/pump owners until actual reap"
    );
    assert!(weak.upgrade().is_none());
    assert!(
        final_events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event["kind"] == "forkResult"
                && event["settled"] == true
                && event["result"]["reason"] == "owner_ended")
    );
    assert!(
        openings
            .reserve("agent", Path::new("/project"), "parent")
            .is_ok()
    );
    assert!(
        openings
            .reserve("agent", Path::new("/other"), "child")
            .is_ok()
    );
}
#[tokio::test]
async fn fork_observer_retires_on_whole_operation_finish_while_parent_stays_live() {
    let (state, life, _) = state();
    let weak = Arc::downgrade(&state);
    let mut observer = state.observe_parent(life.clone());
    state.result.lock().unwrap().source_released = true;
    state.fail("destination_open_failed");
    drop(state);
    let retired = tokio::time::timeout(Duration::from_secs(1), &mut observer).await;
    if retired.is_err() {
        life.close(true, None).unwrap();
        life.finish(Ok(()));
        observer.await.unwrap();
    }
    assert!(
        retired.is_ok(),
        "a finished copy must not retain an observer until parent exit"
    );
    assert!(retired.unwrap().is_ok());
    assert!(!life.finished());
    assert!(weak.upgrade().is_none());
}
#[tokio::test]
async fn fork_observer_source_release_does_not_end_pending_destination_after_parent_reap() {
    let (state, life, openings) = state();
    let weak = Arc::downgrade(&state);
    let observer = state.observe_parent(life.clone());
    state.result.lock().unwrap().source_released = true;
    state.publish("running");
    drop(state);
    life.close(true, None).unwrap();
    life.finish(Ok(()));
    tokio::task::yield_now().await;
    let held = weak.upgrade();
    if held.is_none() {
        observer.await.unwrap();
        panic!("source close is not destination settlement");
    }
    let held = held.unwrap();
    assert!(held.busy.load(Ordering::SeqCst));
    assert!(
        openings
            .reserve("agent", Path::new("/other"), "child")
            .is_err()
    );
    held.fail("destination_open_failed");
    drop(held);
    tokio::time::timeout(Duration::from_secs(1), observer)
        .await
        .unwrap()
        .unwrap();
    assert!(weak.upgrade().is_none());
}
