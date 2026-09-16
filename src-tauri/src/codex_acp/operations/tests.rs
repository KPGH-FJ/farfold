use super::*;
use crate::codex_acp::{
    configure::tests::attach,
    threads::tests::{scope, shared_profile},
};
use std::{cell::Cell, time::Instant};

mod session_facade;
mod turn_facade;

fn call(runtime: &configure::Runtime, value: Value) -> Result<Receipt, OperationError> {
    gated(Entry::Synthetic, value, |input| {
        dispatch(runtime, input, |_, _| {
            Err("No synthetic restore prepared".into())
        })
    })
}
fn configure(runtime: &configure::Runtime, generation: u64, command: Value) -> configure::Snapshot {
    match call(
        runtime,
        json!({"action":"configure","scope":scope(generation),"command":command}),
    )
    .unwrap()
    {
        Receipt::Configure { snapshot } => snapshot,
        _ => panic!("Configure receipt expected"),
    }
}
fn poll(
    runtime: &configure::Runtime,
    mut snapshot: configure::Snapshot,
    phase: configure::Phase,
) -> configure::Snapshot {
    let deadline = Instant::now() + Duration::from_secs(3);
    while snapshot.phase != phase {
        assert!(
            Instant::now() < deadline,
            "Synthetic Configure did not settle"
        );
        std::thread::sleep(Duration::from_millis(10));
        snapshot = configure(
            runtime,
            snapshot.scope.generation,
            json!({"action":"status","operationId":snapshot.operation_id,"loginId":snapshot.login_id}),
        );
    }
    snapshot
}

#[test]
fn production_gate_never_parses_or_resolves_services_for_any_operation() {
    for value in [
        json!({"action":"history","scope":scope(1),"farfoldSessionId":"original"}),
        json!({"action":"turn","scope":scope(1),"command":{"action":"send","text":"PRIVATE-SYNTHETIC"}}),
        json!({"action":"turn","scope":scope(1),"command":{"action":"interrupt"}}),
        json!({"action":"focus","receipt":null,"expectedNavigation":{"kind":"absent"}}),
        json!({"action":"session","scope":scope(1),"command":{"action":"start"}}),
        json!({"action":"session","scope":scope(1),"command":{"action":"open","farfoldSessionId":"original"}}),
        json!({"action":"admission","scope":scope(1),"command":{"action":"refresh"}}),
        json!({"action":"discover_configure","scope":scope(1)}),
        json!({"action":"restore","scope":scope(1),"workingCopyId":"synthetic-worktree"}),
        json!({"action":"stop","scope":scope(1)}),
        json!({"action":"configure","scope":scope(1),"command":{"action":"api_key","key":"SECRET-FIXTURE"}}),
        json!({"action":"configure","enabled":true,"test":true,"command":{"action":"SECRET-FIXTURE"}}),
        Value::Null,
    ] {
        let result = gated(Entry::Production, value, |_| {
            panic!("Production accessed services")
        });
        assert!(matches!(result, Err(OperationError::Unavailable)));
        assert_eq!(
            serde_json::to_string(&result.err().unwrap()).unwrap(),
            "\"unavailable\""
        );
    }
}

#[test]
fn discovery_reads_existing_private_flow_and_does_not_authorize_a_racing_start() {
    let runtime = configure::Runtime::default();
    let _home = attach(&runtime, "waiting", 1);
    let discover = || {
        call(
            &runtime,
            json!({"action":"discover_configure","scope":scope(1)}),
        )
    };
    let empty = serde_json::to_value(discover().unwrap()).unwrap();
    assert_eq!(empty["discovery"]["operation"], Value::Null);
    let original = configure(&runtime, 1, json!({"action":"device"}));
    let found = serde_json::to_value(discover().unwrap()).unwrap();
    assert_eq!(found["discovery"]["operation"]["kind"], "device");
    assert_eq!(
        found["discovery"]["operation"]["operationId"],
        original.operation_id
    );
    assert_eq!(
        found["discovery"]["operation"]["loginId"],
        json!(original.login_id)
    );
    assert!(!found.to_string().contains("https:"));
    assert!(
        call(
            &runtime,
            json!({"action":"configure","scope":scope(1),"command":{"action":"browser"}})
        )
        .is_err()
    );
    let refreshed = configure(
        &runtime,
        1,
        json!({"action":"status","operationId":original.operation_id,"loginId":original.login_id}),
    );
    assert!(matches!(
        refreshed.payload,
        Some(configure::Instructions::Device { .. })
    ));
    assert!(
        call(
            &runtime,
            json!({"action":"discover_configure","scope":scope(2)})
        )
        .is_err()
    );
    runtime.stop(&scope(1)).unwrap();
}

#[test]
fn discovery_preserves_original_background_completion_and_terminal_identity() {
    let runtime = configure::Runtime::default();
    let _home = attach(&runtime, "auto", 1);
    let start = configure(&runtime, 1, json!({"action":"browser"}));
    let original_id = start.operation_id;
    let done = poll(&runtime, start, configure::Phase::Confirmed);
    let found = serde_json::to_value(
        call(
            &runtime,
            json!({"action":"discover_configure","scope":scope(1)}),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(found["discovery"]["operation"]["operationId"], original_id);
    assert_eq!(found["discovery"]["operation"]["phase"], "confirmed");
    let fresh = configure(
        &runtime,
        1,
        json!({"action":"status","operationId":done.operation_id,"loginId":done.login_id}),
    );
    assert!(fresh.phase == configure::Phase::Confirmed);
    assert!(fresh.payload.is_none());
    runtime.stop(&scope(1)).unwrap();
    let _next = attach(&runtime, "waiting", 2);
    assert!(
        call(
            &runtime,
            json!({"action":"discover_configure","scope":scope(1)})
        )
        .is_err()
    );
    let empty = serde_json::to_value(
        call(
            &runtime,
            json!({"action":"discover_configure","scope":scope(2)}),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(empty["discovery"]["operation"], Value::Null);
    runtime.stop(&scope(2)).unwrap();
}

#[test]
fn strict_json_boundary_redacts_decode_and_dispatch_errors() {
    for value in [
        json!({"action":"admission","scope":scope(1),"command":{"action":"preflight","thread":{}}}),
        json!({"action":"admission","scope":scope(1),"command":{"action":"restore","selection":{}}}),
        json!({"action":"SECRET-FIXTURE"}),
        json!({"action":"stop","scope":scope(1),"enabled":true}),
        json!({"action":"configure","scope":scope(1),"command":{"action":"SECRET-FIXTURE"}}),
        json!({"action":"restore","scope":scope(1),"workingCopyId":"w","native":"/untrusted"}),
    ] {
        assert!(matches!(
            gated(Entry::Synthetic, value, |_| panic!(
                "Invalid input dispatched"
            )),
            Err(OperationError::InvalidRequest)
        ));
    }
    let error = gated(
        Entry::Synthetic,
        json!({"action":"stop","scope":scope(1)}),
        |_| Err("SECRET-FIXTURE raw failure".into()),
    )
    .err()
    .unwrap();
    assert_eq!(serde_json::to_string(&error).unwrap(), "\"unconfirmed\"");
}

#[test]
fn public_admission_only_refreshes_and_explicitly_selects_original_catalog() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = configure::Runtime::default();
    super::super::threads::tests::attach(&runtime, temp.path(), "admission_ok", 1);
    let request = |command: Value| json!({"action":"admission","scope":scope(1),"command":command});
    let initial =
        serde_json::to_value(call(&runtime, request(json!({"action":"refresh"}))).unwrap())
            .unwrap();
    let s = &initial["snapshot"];
    assert!(s.get("actual").is_none());
    let selected = json!({"catalogModelId":"synthetic-picker","nativeModel":"synthetic-model","provider":"synthetic","reasoningEffort":"medium"});
    let command = json!({"action":"select","observationScope":scope(1),"epoch":s["epoch"],"catalogHash":s["catalogHash"],"selection":selected});
    for field in [
        "epoch",
        "catalogHash",
        "nativeModel",
        "catalogModelId",
        "reasoningEffort",
    ] {
        let mut bad = command.clone();
        match field {
            "epoch" => bad[field] = json!(0),
            "catalogHash" => bad[field] = json!("wrong"),
            _ => bad["selection"][field] = json!("foreign"),
        }
        assert!(call(&runtime, request(bad)).is_err());
        // Explicit fresh observation, not automatic retry of failed select.
        call(&runtime, request(json!({"action":"refresh"}))).unwrap();
    }
    let result = serde_json::to_value(call(&runtime, request(command)).unwrap()).unwrap();
    assert_eq!(result["snapshot"]["selection"], selected);
    assert!(result["snapshot"].get("actual").is_none());
    assert!(
        !temp
            .path()
            .join("home/codex/sessions/synthetic-thread.jsonl")
            .exists()
    );
    runtime.stop(&scope(1)).unwrap();
}

#[test]
fn public_admission_preserves_bound_session_and_configure_occupancy() {
    let f = super::super::turns::tests::Fixture::new("turn_complete");
    let saved = f.store.session_model_selection(&f.id).unwrap();
    let request = |command: Value| json!({"action":"admission","scope":scope(1),"command":command});
    let refreshed =
        serde_json::to_value(call(&f.runtime, request(json!({"action":"refresh"}))).unwrap())
            .unwrap();
    let s = &refreshed["snapshot"];
    assert!(s.get("actual").is_none());
    assert!(s["selection"].is_null());
    assert!(call(&f.runtime,request(json!({"action":"select","observationScope":scope(1),"epoch":s["epoch"],"catalogHash":s["catalogHash"],"selection":saved.selection}))).is_err());
    assert!(f.store.session_model_selection(&f.id).unwrap() == saved);
    assert_eq!(f.count(), 0);
    f.runtime.stop(&scope(1)).unwrap();

    let runtime = configure::Runtime::default();
    let _home = attach(&runtime, "waiting", 1);
    let started = configure(&runtime, 1, json!({"action":"browser"}));
    assert!(call(&runtime, request(json!({"action":"refresh"}))).is_err());
    configure(
        &runtime,
        1,
        json!({"action":"cancel","operationId":started.operation_id,"loginId":started.login_id}),
    );
    runtime.stop(&scope(1)).unwrap();
}

#[test]
fn public_admission_new_catalog_revokes_original_choice_and_failure_clears_cache() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = configure::Runtime::default();
    super::super::threads::tests::attach(&runtime, temp.path(), "admission_catalog_change", 1);
    let request = |command: Value| json!({"action":"admission","scope":scope(1),"command":command});
    let first = serde_json::to_value(call(&runtime, request(json!({"action":"refresh"}))).unwrap())
        .unwrap();
    for _ in 0..2 {
        call(&runtime, request(json!({"action":"refresh"}))).unwrap();
    }
    assert!(call(&runtime,request(json!({"action":"select","observationScope":scope(1),"epoch":first["snapshot"]["epoch"],"catalogHash":first["snapshot"]["catalogHash"],"selection":{"catalogModelId":"synthetic-picker","nativeModel":"synthetic-model","provider":"synthetic","reasoningEffort":"medium"}}))).is_err());
    assert!(
        runtime
            .connection()
            .unwrap()
            .lock()
            .unwrap()
            .admission
            .is_none()
    );
    runtime.stop(&scope(1)).unwrap();
    let other = tempfile::tempdir().unwrap();
    super::super::threads::tests::attach(&runtime, other.path(), "admission_cursor_loop", 2);
    assert!(
        call(
            &runtime,
            json!({"action":"admission","scope":scope(2),"command":{"action":"refresh"}})
        )
        .is_err()
    );
    assert!(
        runtime
            .connection()
            .unwrap()
            .lock()
            .unwrap()
            .admission
            .is_none()
    );
    runtime.stop(&scope(2)).unwrap();
}

#[test]
fn restore_uses_only_original_stored_profile_and_working_copy() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = HostStore::open(root.join("host.sqlite3"));
    let workspace = super::super::threads::Workspace {
        cwd: root.clone(),
        working_copy_id: Some(WorkingCopyId::parse("synthetic-worktree").unwrap()),
    };
    shared_profile(&store, &workspace, &root.join("synthetic-profile"), true);
    let request = restore_request(
        &store,
        &scope(1),
        workspace.working_copy_id.as_ref().unwrap(),
    )
    .unwrap();
    assert!(!request.create);
    assert_eq!(request.launch.owned_parent, root);
    assert_eq!(request.launch.node, PathBuf::from("/synthetic/node"));
    assert_eq!(request.launch.scope, scope(1));
    for field in [
        "profileId",
        "installationId",
        "connectionId",
        "runtimeBuildId",
        "adapterBuildId",
        "adapterId",
        "runtimeProductId",
    ] {
        let mut changed = serde_json::to_value(scope(1)).unwrap();
        changed[field] = json!("foreign");
        let changed: Scope = serde_json::from_value(changed).unwrap();
        assert!(
            restore_request(
                &store,
                &changed,
                workspace.working_copy_id.as_ref().unwrap()
            )
            .is_err()
        );
    }
    assert!(
        restore_request(
            &store,
            &scope(2),
            workspace.working_copy_id.as_ref().unwrap()
        )
        .is_err()
    );
    assert!(restore_request(&store, &scope(1), &WorkingCopyId::parse("foreign").unwrap()).is_err());
    shared_profile(&store, &workspace, &root.join("synthetic-profile"), false);
    assert!(
        restore_request(
            &store,
            &scope(1),
            workspace.working_copy_id.as_ref().unwrap()
        )
        .is_err()
    );
    assert!(
        restore_request(
            &store,
            &scope(2),
            workspace.working_copy_id.as_ref().unwrap()
        )
        .is_ok()
    );
}

#[test]
fn synthetic_restore_receipt_keeps_scope_and_requires_a_new_generation() {
    let runtime = configure::Runtime::default();
    let request =
        || json!({"action":"restore","scope":scope(1),"workingCopyId":"synthetic-worktree"});
    let calls = Cell::new(0);
    let result = gated(Entry::Synthetic, request(), |input| {
        dispatch(&runtime, input, |s, w| {
            assert_eq!(s, &scope(1));
            assert_eq!(w.as_str(), "synthetic-worktree");
            calls.set(calls.get() + 1);
            Ok(scope(2))
        })
    })
    .unwrap();
    assert_eq!(calls.get(), 1);
    assert!(matches!(result, Receipt::Connected { scope: s } if s == scope(2)));
    for next in [
        scope(1),
        Scope {
            profile_id: "foreign".into(),
            ..scope(2)
        },
    ] {
        assert!(
            gated(Entry::Synthetic, request(), |input| dispatch(
                &runtime,
                input,
                |_, _| Ok(next)
            ))
            .is_err()
        );
    }
}

#[test]
fn synthetic_configure_occupancy_identity_private_instructions_and_cancel() {
    for action in ["browser", "device"] {
        let runtime = configure::Runtime::default();
        let _temp = attach(&runtime, "waiting", 1);
        let start = configure(&runtime, 1, json!({"action":action}));
        let waiting = poll(&runtime, start, configure::Phase::Waiting);
        assert!(waiting.payload.is_some());
        for command in [
            json!({"action":"logout"}),
            json!({"action":"cancel","operationId":waiting.operation_id+1,"loginId":waiting.login_id}),
        ] {
            assert!(
                call(
                    &runtime,
                    json!({"action":"configure","scope":scope(1),"command":command})
                )
                .is_err()
            );
        }
        assert!(call(&runtime, json!({"action":"configure","scope":scope(2),"command":{"action":"cancel","operationId":waiting.operation_id,"loginId":waiting.login_id}})).is_err());
        let canceled = configure(
            &runtime,
            1,
            json!({"action":"cancel","operationId":waiting.operation_id,"loginId":waiting.login_id}),
        );
        let canceled = poll(&runtime, canceled, configure::Phase::Canceled);
        assert!(canceled.payload.is_none());
        let events = runtime
            .connection()
            .unwrap()
            .lock()
            .unwrap()
            .events()
            .unwrap();
        let encoded = serde_json::to_string(&events).unwrap();
        for private in [
            "account/",
            "SYNTHETIC-URL",
            "SYNTHETIC-CODE",
            "DO-NOT-ROUTE",
        ] {
            assert!(!encoded.contains(private));
        }
        assert!(matches!(
            call(&runtime, json!({"action":"stop","scope":scope(1)})).unwrap(),
            Receipt::Stopped { .. }
        ));
    }
}

#[test]
fn synthetic_key_cancel_stays_unknown_and_old_scope_cannot_control_reconnect() {
    let runtime = configure::Runtime::default();
    let _first = attach(&runtime, "delayed_key", 1);
    let start = configure(
        &runtime,
        1,
        json!({"action":"api_key","key":"SYNTHETIC-ONLY"}),
    );
    let cancel = configure(
        &runtime,
        1,
        json!({"action":"cancel","operationId":start.operation_id,"loginId":start.login_id}),
    );
    assert!(cancel.phase == configure::Phase::Unknown);
    std::thread::sleep(Duration::from_millis(160));
    let later = configure(
        &runtime,
        1,
        json!({"action":"status","operationId":cancel.operation_id,"loginId":cancel.login_id}),
    );
    assert!(later.phase == configure::Phase::Unknown);
    assert!(
        !serde_json::to_string(&later)
            .unwrap()
            .contains("SYNTHETIC-ONLY")
    );
    assert!(
        call(
            &runtime,
            json!({"action":"configure","scope":scope(1),"command":{"action":"logout"}})
        )
        .is_err()
    );
    call(&runtime, json!({"action":"stop","scope":scope(1)})).unwrap();
    let _second = attach(&runtime, "waiting", 2);
    assert!(call(&runtime, json!({"action":"stop","scope":scope(1)})).is_err());
    assert!(call(&runtime, json!({"action":"configure","scope":scope(1),"command":{"action":"status","operationId":later.operation_id,"loginId":later.login_id}})).is_err());
    assert_eq!(
        runtime.connection().unwrap().lock().unwrap().scope,
        scope(2)
    );
    call(&runtime, json!({"action":"stop","scope":scope(2)})).unwrap();
}

#[test]
fn synthetic_native_error_is_redacted_without_inventing_not_sent_or_retry() {
    let runtime = configure::Runtime::default();
    let _temp = attach(&runtime, "waiting", 1);
    // The fixed test server rejects every value other than its one synthetic sentinel.
    let start = configure(
        &runtime,
        1,
        json!({"action":"api_key","key":"INTENTIONALLY-REJECTED"}),
    );
    // The adapter deliberately returns a typed Unknown snapshot, not the native error.
    let unknown = poll(&runtime, start, configure::Phase::Unknown);
    assert!(matches!(
        unknown.credential_state,
        configure::CredentialState::Unknown
    ));
    assert!(unknown.account_state == configure::AccountState::Unconfirmed);
    let snapshot = serde_json::to_string(&unknown).unwrap();
    assert!(!snapshot.contains("INTENTIONALLY-REJECTED"));
    assert!(!snapshot.contains("SYNTHETIC-SECRET"));
    let error = call(
        &runtime,
        json!({"action":"configure","scope":scope(1),"command":{"action":"logout"}}),
    )
    .err()
    .unwrap();
    assert_eq!(serde_json::to_string(&error).unwrap(), "\"unconfirmed\"");
    let events = runtime
        .connection()
        .unwrap()
        .lock()
        .unwrap()
        .events()
        .unwrap();
    assert!(
        !serde_json::to_string(&events)
            .unwrap()
            .contains("SYNTHETIC-SECRET")
    );
    call(&runtime, json!({"action":"stop","scope":scope(1)})).unwrap();
}

#[test]
fn synthetic_late_configure_receipt_cannot_cross_stopped_generation() {
    let runtime = Arc::new(configure::Runtime::default());
    let _first = attach(&runtime, "early_slow", 1);
    let start = configure(&runtime, 1, json!({"action":"browser"}));
    std::thread::sleep(Duration::from_millis(30));
    let worker = runtime.clone();
    let pending = std::thread::spawn(move || {
        call(
            &worker,
            json!({"action":"configure","scope":scope(1),"command":{"action":"status","operationId":start.operation_id,"loginId":start.login_id}}),
        )
    });
    let deadline = Instant::now() + Duration::from_secs(1);
    while !runtime
        .connection()
        .unwrap()
        .lock()
        .unwrap()
        .control
        .operations
        .is_current_config(2)
    {
        assert!(
            Instant::now() < deadline,
            "Synthetic status was not dispatched"
        );
        std::thread::yield_now();
    }
    call(&runtime, json!({"action":"stop","scope":scope(1)})).unwrap();
    let _second = attach(&runtime, "waiting", 2);
    assert!(matches!(
        pending.join().unwrap(),
        Err(OperationError::Unconfirmed)
    ));
    assert!(
        runtime
            .connection()
            .unwrap()
            .lock()
            .unwrap()
            .control
            .workspace_phase()
            .is_none()
    );
    call(&runtime, json!({"action":"stop","scope":scope(2)})).unwrap();
}
