use super::*;
use crate::codex_acp::threads::tests::{attach, scope, session_registration, shared_profile};
use std::{path::Path, thread, time::Instant};

pub(crate) struct Fixture {
    pub(crate) temp: tempfile::TempDir,
    pub(crate) runtime: configure::Runtime,
    pub(crate) store: HostStore,
    pub(crate) coordinator: TurnCoordinator,
    pub(crate) router: RuntimeEventRouter,
    pub(crate) interactions: crate::interaction_registry::InteractionRegistry,
    pub(crate) id: FarfoldSessionId,
}
impl Fixture {
    pub(crate) fn new(mode: &str) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let store = HostStore::open(root.join("host.sqlite3"));
        let runtime = configure::Runtime::default();
        let workspace = attach(&runtime, &root, mode, 1);
        if mode.starts_with("admission_") {
            crate::codex_acp::threads::tests::select_test_model(&runtime, 1);
        }
        shared_profile(&store, &workspace, &root.join("home"), true);
        let thread = runtime
            .threads(&scope(1), &workspace, threads::CommandInput::Start)
            .unwrap()
            .thread
            .unwrap();
        let registration = session_registration(&workspace, &thread);
        runtime
            .register_thread(&store, &scope(1), &registration)
            .unwrap();
        runtime.thread_events(&scope(1)).unwrap();
        let coordinator = TurnCoordinator::default();
        let interactions = crate::interaction_registry::InteractionRegistry::default();
        let router = RuntimeEventRouter::with_all_observers(
            crate::live_session_projection::LiveSessionProjection::default(),
            interactions.clone(),
            coordinator.clone(),
        );
        router
            .activate_connection(
                store
                    .session_open_target(&registration.farfold_session_id)
                    .unwrap()
                    .binding(),
                1,
            )
            .unwrap();
        Self {
            temp,
            runtime,
            store,
            coordinator,
            router,
            interactions,
            id: registration.farfold_session_id,
        }
    }
    pub(crate) fn start(&self) -> HostTurnId {
        self.runtime
            .start_turn(
                &self.store,
                &scope(1),
                &self.id,
                &self.coordinator,
                &self.router,
                "synthetic test only",
            )
            .unwrap()
    }
    pub(crate) fn count(&self) -> usize {
        self.coordinator.snapshot().unwrap().active_turn_count()
    }
    pub(crate) fn settle(&self) -> Vec<Event> {
        let until = Instant::now() + Duration::from_secs(3);
        let mut events = Vec::new();
        while Instant::now() < until {
            events.extend(self.runtime.poll_turn_events(&scope(1)).unwrap());
            if self.count() == 0 {
                return events;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("synthetic terminal missing");
    }
    fn history_path(&self) -> PathBuf {
        self.temp
            .path()
            .join("home/codex/sessions/synthetic-thread.jsonl")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Ok(handle) = self.runtime.connection() {
            let s = handle.lock().unwrap().scope.clone();
            let _ = self.runtime.stop(&s);
        }
    }
}

#[test]
fn synthetic_turn_stream_routes_safe_items_and_cold_history_without_resending() {
    let f = Fixture::new("turn_complete");
    let host_id = f.start();
    assert_eq!(f.count(), 1);
    let events = f.settle();
    assert!(events.iter().all(|e| e.context.host_turn_id == host_id));
    assert!(
        events
            .iter()
            .any(|e| matches!(e.payload, Payload::Delta { .. }))
    );
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e.payload, Payload::ItemCompleted { .. }))
            .count(),
        4
    );
    assert!(
        matches!(events.last().unwrap().payload, Payload::Terminal { ref status } if status == "completed")
    );
    let safe = serde_json::to_string(&events).unwrap();
    assert!(f.interactions.snapshots().unwrap().is_empty());
    assert!(!safe.contains("PRIVATE") && !safe.contains("FOREIGN"));
    let routed = serde_json::to_string(&f.router.snapshot(None, Some(512)).unwrap()).unwrap();
    assert!(routed.contains("_codex/turn/event") && !routed.contains("PRIVATE"));
    let history = f
        .runtime
        .read_turn_history(&f.store, &scope(1), &f.id)
        .unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].items.len(), 4);
    let bytes = fs::read(f.history_path()).unwrap();
    f.runtime.stop(&scope(1)).unwrap();
    let root = f.temp.path().canonicalize().unwrap();
    let workspace = attach(&f.runtime, &root, "turn_complete", 2);
    let store = HostStore::open(root.join("host.sqlite3"));
    assert_eq!(
        shared_profile(&store, &workspace, &root.join("home"), false),
        2
    );
    f.runtime
        .open_registered_thread(&store, &scope(2), &f.id)
        .unwrap();
    let restored = f
        .runtime
        .read_turn_history(&store, &scope(2), &f.id)
        .unwrap();
    assert_eq!(restored[0].native_turn_id, history[0].native_turn_id);
    assert_eq!(fs::read(f.history_path()).unwrap(), bytes);
    assert_eq!(f.count(), 0);
}

#[test]
fn registered_tree_and_every_launch_scope_field_are_required_before_turn_admission() {
    let f = Fixture::new("turn_hold");
    let before = fs::read(f.history_path()).unwrap();
    for field in [
        "runtimeProductId",
        "installationId",
        "runtimeBuildId",
        "adapterId",
        "adapterBuildId",
        "connectionId",
        "profileId",
    ] {
        let mut value = serde_json::to_value(scope(1)).unwrap();
        value[field] = json!("foreign");
        let wrong: Scope = serde_json::from_value(value).unwrap();
        assert!(
            f.runtime
                .start_turn(
                    &f.store,
                    &wrong,
                    &f.id,
                    &f.coordinator,
                    &f.router,
                    "blocked"
                )
                .is_err()
        );
    }
    let db = rusqlite::Connection::open(f.temp.path().join("host.sqlite3")).unwrap();
    db.execute(
        "UPDATE session_native_locators SET locator_value=?1 WHERE locator_kind='codex_tree_session_id'",
        ["019a0000-0000-7000-8000-999999999999"],
    )
    .unwrap();
    assert!(
        f.runtime
            .start_turn(
                &f.store,
                &scope(1),
                &f.id,
                &f.coordinator,
                &f.router,
                "blocked"
            )
            .is_err()
    );
    assert_eq!(f.count(), 0);
    assert_eq!(fs::read(f.history_path()).unwrap(), before);
}

#[test]
fn interrupt_ack_does_not_release_shared_occupancy_and_wrong_identity_never_sends() {
    let f = Fixture::new("turn_hold");
    f.start();
    let (context, native) = f.runtime.turn_context(&scope(1)).unwrap();
    let mut wrong = context.clone();
    wrong.thread.native_session_id = "019a0000-0000-7000-8000-000000000099".into();
    assert!(
        f.runtime
            .interrupt_turn(&f.store, &scope(1), &wrong, &native)
            .is_err()
    );
    assert!(
        f.runtime
            .interrupt_turn(&f.store, &scope(2), &context, &native)
            .is_err()
    );
    assert!(
        f.runtime
            .interrupt_turn(
                &f.store,
                &scope(1),
                &context,
                "019a0000-0000-7000-8000-000000000099"
            )
            .is_err()
    );
    f.runtime
        .interrupt_turn(&f.store, &scope(1), &context, &native)
        .unwrap();
    assert_eq!(f.count(), 1);
    assert!(
        f.runtime
            .start_turn(
                &f.store,
                &scope(1),
                &f.id,
                &f.coordinator,
                &f.router,
                "second"
            )
            .is_err()
    );
    assert!(
        f.runtime
            .read_turn_history(&f.store, &scope(1), &f.id)
            .is_err()
    );
    assert!(
        f.runtime
            .connection()
            .unwrap()
            .lock()
            .unwrap()
            .control
            .operations
            .is_pending()
    );
    let events = f.settle();
    assert!(
        matches!(events.last().unwrap().payload, Payload::Terminal { ref status } if status == "interrupted")
    );
    assert!(
        !f.runtime
            .connection()
            .unwrap()
            .lock()
            .unwrap()
            .control
            .operations
            .is_pending()
    );
    f.start();
    let (next, next_native) = f.runtime.turn_context(&scope(1)).unwrap();
    assert_ne!(next_native, native);
    assert!(
        f.runtime
            .interrupt_turn(&f.store, &scope(1), &context, &native)
            .is_err()
    );
    f.runtime
        .interrupt_turn(&f.store, &scope(1), &next, &next_native)
        .unwrap();
    f.settle();
}

#[test]
fn rejected_interrupt_stays_unknown_until_native_completed_not_cancelled() {
    let f = Fixture::new("turn_reject_stop");
    f.start();
    let (context, native) = f.runtime.turn_context(&scope(1)).unwrap();
    assert!(
        f.runtime
            .interrupt_turn(&f.store, &scope(1), &context, &native)
            .is_err()
    );
    assert_eq!(f.count(), 1);
    assert!(
        serde_json::to_string(&f.coordinator.snapshot().unwrap())
            .unwrap()
            .contains("\"outcomeUnknown\":true")
    );
    let events = f.settle();
    assert!(
        matches!(events.last().unwrap().payload, Payload::Terminal { ref status } if status == "completed")
    );
}

#[test]
fn failed_terminal_and_late_completion_cannot_settle_the_next_turn() {
    let failed = Fixture::new("turn_failed");
    failed.start();
    let events = failed.settle();
    assert!(
        matches!(events.last().unwrap().payload, Payload::Terminal { ref status } if status == "failed")
    );
    let f = Fixture::new("turn_late");
    f.start();
    f.settle();
    let first = f
        .runtime
        .read_turn_history(&f.store, &scope(1), &f.id)
        .unwrap()[0]
        .native_turn_id
        .clone();
    let next = f.start();
    thread::sleep(Duration::from_millis(100));
    let mut events = f.runtime.poll_turn_events(&scope(1)).unwrap();
    assert_eq!(f.count(), 1); // Old completion arrived while the next native Turn remains held.
    let (context, native) = f.runtime.turn_context(&scope(1)).unwrap();
    f.runtime
        .interrupt_turn(&f.store, &scope(1), &context, &native)
        .unwrap();
    events.extend(f.settle());
    assert!(
        events
            .iter()
            .all(|e| e.context.host_turn_id == next && e.native_turn_id != first)
    );
    thread::sleep(Duration::from_millis(180));
    assert!(f.runtime.poll_turn_events(&scope(1)).unwrap().is_empty());
    assert_eq!(f.count(), 0);
}

#[test]
fn disconnect_or_unresolved_tool_never_releases_the_host_reservation() {
    for mode in ["turn_disconnect", "turn_bad_item"] {
        let f = Fixture::new(mode);
        f.start();
        thread::sleep(Duration::from_millis(180));
        assert!(f.runtime.poll_turn_events(&scope(1)).is_err());
        assert_eq!(f.count(), 1);
        assert!(
            f.runtime
                .start_turn(
                    &f.store,
                    &scope(1),
                    &f.id,
                    &f.coordinator,
                    &f.router,
                    "forbidden retry"
                )
                .is_err()
        );
        // Transport shutdown may truthfully report unknown after abnormal native exit.
        let _ = f.runtime.stop(&scope(1));
        assert_eq!(f.count(), 1);
    }
}

#[test]
fn native_start_timeout_is_unknown_without_retry_or_reservation_release() {
    let f = Fixture::new("turn_timeout_start");
    assert!(
        f.runtime
            .start_turn(
                &f.store,
                &scope(1),
                &f.id,
                &f.coordinator,
                &f.router,
                "synthetic timeout"
            )
            .is_err()
    );
    assert_eq!(f.count(), 1);
    assert!(
        f.runtime
            .connection()
            .unwrap()
            .lock()
            .unwrap()
            .control
            .operations
            .is_pending()
    );
}

#[test]
fn native_interrupt_timeout_is_not_stopped() {
    let f = Fixture::new("turn_timeout_stop");
    f.start();
    let (context, native) = f.runtime.turn_context(&scope(1)).unwrap();
    assert!(
        f.runtime
            .interrupt_turn(&f.store, &scope(1), &context, &native)
            .is_err()
    );
    assert_eq!(f.count(), 1);
    // The sanitized request failure can arrive before process/reader shutdown.
    // Already queued nonterminal events do not release occupancy during that interval.
    let until = Instant::now() + Duration::from_secs(3);
    loop {
        if f.runtime.poll_turn_events(&scope(1)).is_err() {
            break;
        }
        assert_eq!(f.count(), 1);
        assert!(Instant::now() < until, "native failure not observed");
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(f.count(), 1);
}

#[test]
fn turn_target_rejects_registered_tree_profile_and_working_copy_drift() {
    let f = Fixture::new("turn_hold");
    let handle = f.runtime.connection().unwrap();
    let workspace = handle.lock().unwrap().workspace.clone();
    handle.lock().unwrap().workspace.cwd = Path::new("/").into();
    assert!(
        f.runtime
            .start_turn(
                &f.store,
                &scope(1),
                &f.id,
                &f.coordinator,
                &f.router,
                "blocked"
            )
            .is_err()
    );
    handle.lock().unwrap().workspace = workspace;
    assert!(
        f.runtime
            .start_turn(
                &f.store,
                &scope(2),
                &f.id,
                &f.coordinator,
                &f.router,
                "blocked"
            )
            .is_err()
    );
    assert_eq!(f.count(), 0);
}
