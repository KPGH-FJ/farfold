use super::*;

#[test]
fn native_auth_is_ephemeral_targeted_and_never_managed_request_verification() {
    for mode in ["success", "unknown", "wrong"] {
        let fixture = Fixture::stable("http://127.0.0.1:1/v1");
        let runtime = PiAcpRuntime::default();
        let router = RuntimeEventRouter::default();
        let controller = crate::session_controller::HostSessionController::default();
        let turns = crate::turn_coordinator::TurnCoordinator::default();
        let mut response = fixture.response();
        response["authMode"] = json!(mode);
        let handle = fixture.start(&runtime, &router, response);
        let opened =
            open_native_session(&handle, &router, &fixture.store, None, "Native auth").unwrap();
        let original = serde_json::to_value(
            fixture
                .store
                .provider_projection_snapshot(&fixture.selection.provider_connection_id)
                .unwrap(),
        )
        .unwrap();
        let call = |command: Value, generation: u64| {
            native_auth::authenticate(&controller, &runtime, &fixture.store, &router, &turns,
                    serde_json::from_value(json!({"farfoldSessionId":opened.farfold_session_id,
                        "nativeSessionId":opened.native_session_id,"runtimeGeneration":generation,"command":command})).unwrap())
        };
        let start = || json!({"action":"start","providerId":"anthropic","authType":"api_key"});
        assert!(call(start(), opened.runtime_generation + 1).is_err());
        assert!(call(json!({"action":"start","providerId":"farfold-managed-shadow","authType":"api_key"}), opened.runtime_generation).is_err());
        let first = call(start(), opened.runtime_generation);
        if mode == "wrong" {
            assert!(first.is_err());
        } else {
            let first = serde_json::to_value(first.unwrap()).unwrap();
            assert_eq!(first["flowId"], "flow-fixture");
            assert_eq!(first["state"], "running");
            assert!(handle.lock().unwrap().operations.is_config_pending());
            assert!(
                current_status(&runtime, &router)
                    .unwrap()
                    .model_source
                    .is_none()
            );
            assert!(call(start(), opened.runtime_generation).is_err());
            assert!(call(json!({"action":"reply","flowId":"other-flow","promptId":"prompt-fixture","value":"synthetic-auth-secret"}), opened.runtime_generation).is_err());
            let last = serde_json::to_value(call(json!({"action":"reply","flowId":"flow-fixture","promptId":"prompt-fixture","value":"synthetic-auth-secret"}), opened.runtime_generation).unwrap()).unwrap();
            assert_eq!(last["credentialState"], "committed");
            assert!(!last.to_string().contains("synthetic-auth-secret"));
            assert_eq!(
                handle.lock().unwrap().operations.is_config_pending(),
                mode == "unknown"
            );
            assert_eq!(
                current_status(&runtime, &router)
                    .unwrap()
                    .model_source
                    .is_some(),
                mode == "success"
            );
        }
        let target = fixture
            .store
            .session_open_target(&opened.farfold_session_id)
            .unwrap();
        assert_eq!(
            verify_prompt_connection(&handle.lock().unwrap(), &target, opened.runtime_generation)
                .is_ok(),
            mode == "success"
        );
        assert_eq!(
            serde_json::to_value(
                fixture
                    .store
                    .provider_projection_snapshot(&fixture.selection.provider_connection_id)
                    .unwrap()
            )
            .unwrap(),
            original
        );
        let transport = handle.lock().unwrap().transport.clone();
        assert_eq!(
            transport.request("fixture/auth_calls", json!({})).unwrap(),
            json!(if mode == "wrong" { 1 } else { 2 })
        );
        assert_eq!(
            transport
                .request("fixture/prompt_calls", json!({}))
                .unwrap(),
            json!(0)
        );
        assert!(transport.drain_events().unwrap().0.is_empty());
        runtime.stop_for_shutdown().unwrap();
    }
}

#[test]
fn native_first_use_auth_selection_and_cold_pending_restore_stay_on_the_original_session() {
    use crate::turn_coordinator::{
        HostNativeTurnSubmission, HostPiAcpTurnSubmitInput, TurnCoordinator,
        host_pi_acp_turn_submit_blocking,
    };
    let fixture = Fixture::stable("http://127.0.0.1:1/v1");
    let runtime = PiAcpRuntime::default();
    let router = RuntimeEventRouter::default();
    let controller = crate::session_controller::HostSessionController::default();
    let turns = TurnCoordinator::default();
    turns.attach_host_store(fixture.store.clone()).unwrap();
    let mut response = fixture.response();
    response["configOptions"][0]["currentValue"] = json!("native/model");
    response["configOptions"][0]["options"] = json!([{"value":"native/model","name":"Native"}]);
    response["_meta"]["farfoldPi"]["nativeFirstUse"] =
        json!({"version":1,"phase":"authentication_required"});
    response["nativeFirstUse"] = json!(true);
    response["autoConfig"] = json!(true);
    let handle = fixture.start(&runtime, &router, response.clone());
    {
        let mut connection = handle.lock().unwrap();
        connection.managed_provider = None;
        connection.managed_versions.clear();
    }
    let opened =
        open_native_session(&handle, &router, &fixture.store, None, "Native first use").unwrap();
    let target = fixture
        .store
        .session_open_target(&opened.farfold_session_id)
        .unwrap();
    let pending = current_status(&runtime, &router).unwrap();
    assert_eq!(pending.configuration_state, PiConfigurationState::Confirmed);
    assert!(pending.model_source.is_none());
    assert!(!pending.native_admission_ready);
    assert!(
        verify_prompt_connection(&handle.lock().unwrap(), &target, opened.runtime_generation)
            .is_err()
    );

    let call = |command: Value| {
        native_auth::authenticate(
            &controller,
            &runtime,
            &fixture.store,
            &router,
            &turns,
            serde_json::from_value(json!({
                "farfoldSessionId":opened.farfold_session_id,
                "nativeSessionId":opened.native_session_id,
                "runtimeGeneration":opened.runtime_generation,
                "command":command
            }))
            .unwrap(),
        )
    };
    let started = serde_json::to_value(
        call(json!({"action":"start","providerId":"anthropic","authType":"api_key"})).unwrap(),
    )
    .unwrap();
    assert_eq!(started["state"], "running");
    let logged_in = serde_json::to_value(
            call(json!({"action":"reply","flowId":"flow-fixture","promptId":"prompt-fixture","value":"synthetic-auth-secret"})).unwrap(),
        )
        .unwrap();
    assert_eq!(logged_in["state"], "succeeded");
    assert!(matches!(
        handle.lock().unwrap().native_first_use,
        Some(PiNativeFirstUseState::ModelSelectionRequired { .. })
    ));
    assert!(
        verify_prompt_connection(&handle.lock().unwrap(), &target, opened.runtime_generation)
            .is_err()
    );

    let selected = set_config_option(
        &controller,
        &runtime,
        &fixture.store,
        &router,
        &turns,
        PiAcpConfigInput {
            farfold_session_id: opened.farfold_session_id.clone(),
            native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
            runtime_generation: opened.runtime_generation,
            config_id: PiAcpConfigId::Model,
            value: "native/model".into(),
        },
    )
    .unwrap();
    assert!(selected.native_admission_ready);
    assert!(matches!(
        selected.native_first_use,
        Some(PiNativeFirstUseState::Ready { .. })
    ));
    assert!(
        verify_prompt_connection(&handle.lock().unwrap(), &target, opened.runtime_generation)
            .is_ok()
    );
    assert!(matches!(
        host_pi_acp_turn_submit_blocking(
            &controller,
            &fixture.store,
            &runtime,
            &router,
            &turns,
            &crate::interaction_registry::InteractionRegistry::default(),
            HostPiAcpTurnSubmitInput {
                farfold_session_id: opened.farfold_session_id.clone(),
                native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
                runtime_generation: opened.runtime_generation,
                text: "native first-use task".into(),
            },
        )
        .unwrap(),
        HostNativeTurnSubmission::Accepted { .. }
    ));

    assert!(target.locator_value.is_none());
    runtime.stop_for_shutdown().unwrap();
    response["_meta"]["farfoldPi"]["nativeFirstUse"] =
        json!({"version":1,"phase":"model_selection_required"});
    let restored_handle = fixture.start(&runtime, &router, response);
    {
        let mut connection = restored_handle.lock().unwrap();
        connection.managed_provider = None;
        connection.managed_versions.clear();
    }
    let restored = open_native_session_request(
        &restored_handle,
        &router,
        &fixture.store,
        Some(PiNativeSessionRequest::Identity(
            target.native_session_id.clone(),
        )),
        "Native first use",
    )
    .unwrap();
    assert_eq!(restored.farfold_session_id, opened.farfold_session_id);
    let cold = current_status(&runtime, &router).unwrap();
    assert!(matches!(
        cold.native_first_use,
        Some(PiNativeFirstUseState::ModelSelectionRequired { .. })
    ));
    assert!(!cold.native_admission_ready);
    runtime.stop_for_shutdown().unwrap();
}
