use super::*;
use crate::codex_acp::threads::tests::attach as attach_threads;
use crate::codex_acp::turns::tests::Fixture;

fn call(f: &Fixture, input: Value) -> Result<Value, OperationError> {
    gated(Entry::Synthetic, input, |input| {
        execute(&f.runtime, &f.store, input, &f.coordinator, &f.router)
    })
    .map(|v| serde_json::to_value(v).unwrap())
}
fn send(f: &Fixture) -> Value {
    json!({"action":"turn","scope":scope(1),"command":{"action":"send","farfoldSessionId":f.id,"text":"Synthetic only"}})
}
fn stop(receipt: &Value) -> Value {
    let s = &receipt["snapshot"];
    json!({"action":"turn","scope":s["scope"],"command":{"action":"interrupt","farfoldSessionId":s["farfoldSessionId"],"hostTurnId":s["hostTurnId"],"nativeTurnId":s["nativeTurnId"]}})
}
fn wait_until(predicate: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(4);
    while !predicate() {
        assert!(
            Instant::now() < deadline,
            "Synthetic Host condition not observed"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn starts(f: &Fixture) -> u64 {
    let path = f
        .temp
        .path()
        .join("home/codex/synthetic-turn-start-count.json");
    if !path.exists() {
        return 0;
    }
    serde_json::from_slice::<Value>(&fs::read(path).unwrap()).unwrap()["count"]
        .as_u64()
        .unwrap()
}
fn history(f: &Fixture) -> Vec<u8> {
    fs::read(
        f.temp
            .path()
            .join("home/codex/sessions/synthetic-thread.jsonl"),
    )
    .unwrap()
}
fn routed(f: &Fixture) -> Value {
    serde_json::to_value(f.router.snapshot(None, Some(512)).unwrap()).unwrap()
}

#[test]
fn host_pump_settles_without_page_reads_and_router_reads_do_not_consume() {
    let f = Fixture::new("turn_complete");
    let receipt = call(&f, send(&f)).unwrap();
    assert_eq!(receipt["snapshot"]["outcome"], "started");
    assert_eq!(receipt["snapshot"]["farfoldSessionId"], json!(f.id));
    assert_eq!(receipt["snapshot"].as_object().unwrap().len(), 5);
    wait_until(|| f.count() == 0); // No workspace/history/events/UI reader drives settlement.
    assert_eq!(starts(&f), 1);
    let db = rusqlite::Connection::open(f.temp.path().join("host.sqlite3")).unwrap();
    let source: (String, Option<String>) = db.query_row(
        "SELECT source_kind,provider_connection_id FROM turn_provider_bindings WHERE host_turn_id=?1",
        [receipt["snapshot"]["hostTurnId"].as_str().unwrap()], |r| Ok((r.get(0)?, r.get(1)?))
    ).unwrap();
    assert_eq!(source, ("native_observation".into(), None));
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
    let events = routed(&f);
    assert_eq!(events, routed(&f));
    assert_eq!(
        events["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e.pointer("/nativeEnvelope/payload/params/turn/kind")
                == Some(&json!("terminal")))
            .count(),
        1
    );
    assert!(!events.to_string().contains("PRIVATE"));
    assert!(f.runtime.poll_turn_events(&scope(1)).is_err());
    assert!(f.runtime.thread_events(&scope(1)).is_err());
    assert!(
        f.runtime
            .connection()
            .unwrap()
            .lock()
            .unwrap()
            .events()
            .is_err()
    );
    let before = history(&f);
    assert_eq!(
        f.runtime
            .read_turn_history(&f.store, &scope(1), &f.id)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(history(&f), before);
    assert_eq!(starts(&f), 1);
}

#[test]
fn facade_stop_ack_keeps_occupancy_and_next_turn_keeps_one_consumer() {
    let f = Fixture::new("turn_hold");
    let first = call(&f, send(&f)).unwrap();
    let owner = f
        .runtime
        .connection()
        .unwrap()
        .lock()
        .unwrap()
        .turns
        .event_pump_stop
        .clone()
        .unwrap();
    assert!(call(&f, send(&f)).is_err());
    for field in ["farfoldSessionId", "hostTurnId", "nativeTurnId"] {
        let mut wrong = stop(&first);
        wrong["command"][field] = json!("foreign");
        assert!(call(&f, wrong).is_err());
    }
    assert_eq!(starts(&f), 1);
    let ack = call(&f, stop(&first)).unwrap();
    assert_eq!(ack["snapshot"]["outcome"], "interrupt_accepted");
    assert_eq!(f.count(), 1);
    assert!(call(&f, send(&f)).is_err());
    assert!(call(&f, stop(&first)).is_err());
    wait_until(|| f.count() == 0);
    let second = call(&f, send(&f)).unwrap();
    assert!(Arc::ptr_eq(
        &owner,
        f.runtime
            .connection()
            .unwrap()
            .lock()
            .unwrap()
            .turns
            .event_pump_stop
            .as_ref()
            .unwrap()
    ));
    assert_ne!(
        first["snapshot"]["hostTurnId"],
        second["snapshot"]["hostTurnId"]
    );
    assert!(call(&f, stop(&first)).is_err());
    assert_eq!(f.count(), 1);
    call(&f, stop(&second)).unwrap();
    wait_until(|| f.count() == 0);
    assert_eq!(starts(&f), 2);
}

#[test]
fn facade_rejects_free_targets_stale_scope_and_invalid_text_before_native_send() {
    let f = Fixture::new("turn_hold");
    for field in [
        "cwd",
        "thread",
        "nativeThreadId",
        "nativeTreeId",
        "model",
        "provider",
        "enabled",
    ] {
        let mut request = send(&f);
        request["command"][field] = json!("foreign");
        assert!(matches!(
            call(&f, request),
            Err(OperationError::InvalidRequest)
        ));
    }
    for field in [
        "runtimeProductId",
        "installationId",
        "runtimeBuildId",
        "adapterId",
        "adapterBuildId",
        "connectionId",
        "profileId",
        "generation",
    ] {
        let mut request = send(&f);
        request["scope"][field] = if field == "generation" {
            json!(2)
        } else {
            json!("foreign")
        };
        assert!(call(&f, request).is_err());
    }
    for text in [" ".into(), "x".repeat(65537)] {
        let mut request = send(&f);
        request["command"]["text"] = json!(text);
        assert!(call(&f, request).is_err());
    }
    let mut request = send(&f);
    request["command"]["farfoldSessionId"] = json!("foreign");
    assert!(call(&f, request).is_err());
    assert_eq!(starts(&f), 0);
    assert_eq!(f.count(), 0);
    assert!(
        f.runtime
            .connection()
            .unwrap()
            .lock()
            .unwrap()
            .turns
            .event_pump_stop
            .is_none()
    );
}

#[test]
fn facade_disconnect_timeout_and_unknown_never_release_or_redispatch() {
    for mode in [
        "turn_disconnect",
        "turn_bad_item",
        "turn_timeout_start",
        "turn_timeout_stop",
    ] {
        let f = Fixture::new(mode);
        let result = call(&f, send(&f));
        if mode == "turn_timeout_start" {
            assert!(result.is_err());
        } else {
            let receipt = result.unwrap();
            if mode == "turn_timeout_stop" {
                assert!(call(&f, stop(&receipt)).is_err());
            }
        }
        wait_until(|| {
            f.runtime
                .connection()
                .unwrap()
                .lock()
                .unwrap()
                .turns
                .unknown
        });
        assert_eq!(f.count(), 1);
        assert!(
            serde_json::to_value(f.coordinator.snapshot().unwrap())
                .unwrap()
                .to_string()
                .contains("\"outcomeUnknown\":true")
        );
        assert!(call(&f, send(&f)).is_err());
        assert_eq!(starts(&f), 1);
    }
}

#[test]
fn late_native_terminal_cannot_settle_the_next_turn_and_history_does_not_resend() {
    let f = Fixture::new("turn_late");
    let first = call(&f, send(&f)).unwrap();
    wait_until(|| f.count() == 0);
    let second = call(&f, send(&f)).unwrap();
    std::thread::sleep(Duration::from_millis(220));
    assert_eq!(f.count(), 1);
    assert_ne!(
        first["snapshot"]["nativeTurnId"],
        second["snapshot"]["nativeTurnId"]
    );
    call(&f, stop(&second)).unwrap();
    wait_until(|| f.count() == 0);
    let bytes = history(&f);
    f.runtime.stop(&scope(1)).unwrap();
    let workspace = attach_threads(&f.runtime, f.temp.path(), "turn_hold", 2);
    shared_profile(&f.store, &workspace, &workspace.cwd.join("home"), false);
    f.runtime
        .open_registered_thread(&f.store, &scope(2), &f.id)
        .unwrap();
    assert_eq!(
        f.runtime
            .read_turn_history(&f.store, &scope(2), &f.id)
            .unwrap()
            .len(),
        2
    );
    assert_eq!(history(&f), bytes);
    assert_eq!(starts(&f), 2);
    assert!(call(&f, stop(&second)).is_err());
    assert!(
        f.runtime
            .connection()
            .unwrap()
            .lock()
            .unwrap()
            .turns
            .active
            .is_none()
    );
}

#[test]
fn pump_routes_native_interaction_without_reply_or_ui_presence() {
    let f = Fixture::new("interaction_command");
    let receipt = call(&f, send(&f)).unwrap();
    wait_until(|| !f.interactions.snapshots().unwrap().is_empty());
    assert_eq!(f.count(), 1);
    assert_eq!(starts(&f), 1);
    call(&f, stop(&receipt)).unwrap();
    wait_until(|| f.count() == 0);
}

#[test]
fn late_interrupt_ack_does_not_settle_or_poison_a_later_reservation() {
    let f = Fixture::new("turn_late_stop_ack");
    let first = call(&f, send(&f)).unwrap();
    std::thread::scope(|s| {
        let pending = s.spawn(|| call(&f, stop(&first)));
        wait_until(|| f.count() == 0); // Native terminal, not the delayed ACK.
        // Pending wire request still forbids resending even after terminal.
        assert!(call(&f, send(&f)).is_err());
        assert!(pending.join().unwrap().is_err()); // Original Turn is already retired.
    });
    assert!(
        !f.runtime
            .connection()
            .unwrap()
            .lock()
            .unwrap()
            .turns
            .unknown
    );
    let second = call(&f, send(&f)).unwrap();
    assert_eq!(f.count(), 1);
    assert!(call(&f, stop(&first)).is_err());
    assert_eq!(f.count(), 1);
    assert!(call(&f, stop(&second)).is_err());
    wait_until(|| f.count() == 0);
    assert_eq!(starts(&f), 2);
}

#[test]
fn shared_working_copy_and_two_turn_capacity_still_own_admission() {
    use crate::{
        host_ids::*, host_store::provider_projection::TurnProviderBindingAuthority,
        turn_coordinator::TurnAdmissionRequest,
    };
    let f = Fixture::new("turn_hold");
    let reserve = |name: &str, work: &str| {
        f.coordinator
            .admit(TurnAdmissionRequest {
                farfold_session_id: FarfoldSessionId::parse(name).unwrap(),
                working_copy_id: WorkingCopyId::parse(work).unwrap(),
                runtime_product_id: RuntimeProductId::parse("codex").unwrap(),
                installation_id: InstallationId::parse("peer-install").unwrap(),
                runtime_connection_id: ConnectionId::parse(name).unwrap(),
                native_session_id: NativeSessionId::parse(name).unwrap(),
                runtime_generation: 1,
                started_at: 1,
                provider_connection_id: None,
                provider_config_version_id: None,
                runtime_provider_id: None,
                runtime_model_id: None,
                provider_binding_authority:
                    TurnProviderBindingAuthority::ActiveRuntimeSessionBinding,
            })
            .unwrap()
            .id()
            .clone()
    };
    let occupied = reserve("peer-a", "synthetic-worktree");
    assert!(call(&f, send(&f)).is_err());
    assert_eq!(starts(&f), 0);
    f.coordinator.cancel_submission(&occupied).unwrap();
    let a = reserve("peer-a", "work-a");
    let b = reserve("peer-b", "work-b");
    assert!(call(&f, send(&f)).is_err());
    assert_eq!(starts(&f), 0);
    f.coordinator.cancel_submission(&a).unwrap();
    let receipt = call(&f, send(&f)).unwrap();
    assert_eq!(f.count(), 2);
    call(&f, stop(&receipt)).unwrap();
    wait_until(|| f.count() == 1);
    f.coordinator.cancel_submission(&b).unwrap();
}

#[test]
fn original_model_preflight_and_original_router_cannot_be_replaced() {
    for mode in [
        "admission_catalog_change",
        "admission_account_change",
        "admission_read_provider",
        "admission_read_active",
    ] {
        let f = Fixture::new(mode);
        assert!(call(&f, send(&f)).is_err());
        assert_eq!(starts(&f), 0);
        assert_eq!(f.count(), 0);
    }
    let f = Fixture::new("turn_complete");
    call(&f, send(&f)).unwrap();
    wait_until(|| f.count() == 0);
    let other = crate::runtime_event_router::RuntimeEventRouter::default();
    assert!(
        gated(Entry::Synthetic, send(&f), |input| execute(
            &f.runtime,
            &f.store,
            input,
            &f.coordinator,
            &other
        ))
        .is_err()
    );
    assert_eq!(starts(&f), 1);
}

#[test]
fn foreign_event_scope_marks_original_unknown_and_cannot_settle() {
    let f = Fixture::new("turn_hold");
    call(&f, send(&f)).unwrap();
    let (context, native) = f.runtime.turn_context(&scope(1)).unwrap();
    let handle = f.runtime.connection().unwrap();
    let transport = {
        let mut c = handle.lock().unwrap();
        c.scope.generation = 2; // Inject an inconsistent current scope, only in this fixture.
        c.transport.clone()
    };
    // Test-only raw delivery produces the original scope's terminal after drift.
    transport.request_timeout("_codex/turn", json!({"scope":scope(1),"command":{"action":"interrupt","context":context,"nativeTurnId":native}}), Duration::from_secs(2)).unwrap();
    wait_until(|| handle.lock().unwrap().turns.unknown);
    assert_eq!(f.count(), 1);
    assert!(handle.lock().unwrap().control.operations.is_pending());
    assert!(call(&f, send(&f)).is_err());
    assert_eq!(starts(&f), 1);
}

#[test]
fn retiring_connection_stops_its_pump_but_unknown_turn_blocks_same_workspace_after_restore() {
    let f = Fixture::new("turn_hold");
    let first = call(&f, send(&f)).unwrap();
    let old = f
        .runtime
        .connection()
        .unwrap()
        .lock()
        .unwrap()
        .turns
        .event_pump_stop
        .clone()
        .unwrap();
    f.runtime.stop(&scope(1)).unwrap();
    assert!(old.load(std::sync::atomic::Ordering::Acquire));
    assert_eq!(f.count(), 1);
    let workspace = attach_threads(&f.runtime, f.temp.path(), "turn_hold", 2);
    shared_profile(&f.store, &workspace, &workspace.cwd.join("home"), false);
    // No automatic cross-generation unknown reconciliation or replay.
    f.runtime
        .open_registered_thread(&f.store, &scope(2), &f.id)
        .unwrap();
    let mut current = send(&f);
    current["scope"] = json!(scope(2));
    assert!(call(&f, current).is_err()); // Original unknown Turn still owns this WC.
    assert!(call(&f, stop(&first)).is_err());
    assert!(call(&f, send(&f)).is_err());
    assert_eq!(f.count(), 1);
    assert_eq!(starts(&f), 1);
    assert!(
        f.runtime
            .connection()
            .unwrap()
            .lock()
            .unwrap()
            .turns
            .active
            .is_none()
    );
}

#[test]
fn history_facade_is_original_bounded_read_with_before_cursor_and_no_replay() {
    let f = Fixture::new("turn_hold");
    let request = || json!({"action":"history","scope":scope(1),"farfoldSessionId":f.id});
    for field in ["nativeThreadId", "nativeTreeId", "cwd", "enabled"] {
        let mut wrong = request();
        wrong[field] = json!("foreign");
        assert!(matches!(
            call(&f, wrong),
            Err(OperationError::InvalidRequest)
        ));
    }
    let empty = call(&f, request()).unwrap();
    assert_eq!(empty["snapshot"]["turns"], json!([]));
    let receipt = call(&f, send(&f)).unwrap();
    assert!(call(&f, request()).is_err());
    call(&f, stop(&receipt)).unwrap();
    wait_until(|| f.count() == 0);
    let cursor = serde_json::to_value(f.router.cursor().unwrap()).unwrap();
    let bytes = history(&f);
    let result = call(&f, request()).unwrap();
    assert_eq!(result["snapshot"]["before"], cursor);
    assert_eq!(result["snapshot"]["farfoldSessionId"], json!(f.id));
    assert_eq!(
        result["snapshot"]["turns"][0]["nativeTurnId"],
        receipt["snapshot"]["nativeTurnId"]
    );
    assert_eq!(result["snapshot"]["turns"][0]["status"], "interrupted");
    assert!(!result.to_string().contains("PRIVATE"));
    assert_eq!(history(&f), bytes);
    assert_eq!(starts(&f), 1);
    let mut wrong = request();
    wrong["scope"] = json!(scope(2));
    assert!(call(&f, wrong).is_err());
    f.runtime
        .connection()
        .unwrap()
        .lock()
        .unwrap()
        .turns
        .unknown = true;
    assert!(call(&f, request()).is_err());
}
