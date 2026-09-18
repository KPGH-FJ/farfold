use super::*;

#[test]
fn host_pi_acp_tasks_bind_current_connection_and_keep_terminal_and_provider_evidence_separate() {
    use crate::turn_coordinator::{
        HostNativeTurnSubmission, HostPiAcpTurnSubmitInput, TurnCoordinator,
        host_pi_acp_turn_submit_blocking,
    };
    for (mode, emit_receipt, newer_config) in [
        ("success", false, false),
        ("cancelled", false, false),
        ("error", false, false),
        ("success", true, false),
        ("error", true, false),
        ("success", true, true),
    ] {
        let fixture = Fixture::new("http://127.0.0.1:1/v1");
        let runtime = PiAcpRuntime::default();
        let coordinator = TurnCoordinator::default();
        coordinator
            .attach_host_store(fixture.store.clone())
            .unwrap();
        let router = RuntimeEventRouter::with_capacity_and_all_observers(
            128,
            None,
            None,
            Some(coordinator.clone()),
        );
        let controller = crate::session_controller::HostSessionController::default();
        let mut response = fixture.response();
        response["promptMode"] = json!(mode);
        response["emitReceipt"] = json!(emit_receipt);
        if mode == "cancelled" {
            response["promptResult"] = json!({"stopReason":"cancelled"});
        }
        let handle = fixture.start(&runtime, &router, response);
        let opened =
            open_native_session(&handle, &router, &fixture.store, None, "Pi task fixture").unwrap();
        if newer_config {
            let newer = crate::acp_provider_profile::tests::save_fixture(
                fixture.temp.path(),
                &fixture.store,
                "http://127.0.0.1:1/v1",
                "openai-chat-completions",
                "changed-fixture-key",
            );
            assert_eq!(
                newer.provider_connection_id,
                fixture.selection.provider_connection_id
            );
            assert_ne!(
                newer.provider_config_version_id,
                fixture.selection.provider_config_version_id
            );
        }
        let input = || HostPiAcpTurnSubmitInput {
            farfold_session_id: opened.farfold_session_id.clone(),
            native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
            runtime_generation: opened.runtime_generation,
            text: "fixture task".into(),
        };
        let mut stale = input();
        stale.runtime_generation += 1;
        assert!(
            host_pi_acp_turn_submit_blocking(
                &controller,
                &fixture.store,
                &runtime,
                &router,
                &coordinator,
                &crate::interaction_registry::InteractionRegistry::default(),
                stale
            )
            .is_err()
        );
        assert!(
            !coordinator
                .has_active_session(&opened.farfold_session_id)
                .unwrap()
        );
        let result = host_pi_acp_turn_submit_blocking(
            &controller,
            &fixture.store,
            &runtime,
            &router,
            &coordinator,
            &crate::interaction_registry::InteractionRegistry::default(),
            input(),
        )
        .unwrap();
        match (mode, result) {
            ("success", HostNativeTurnSubmission::Accepted { submission }) => {
                let bound = fixture
                    .store
                    .test_turn_provider_binding(&submission.turn_id)
                    .unwrap()
                    .unwrap();
                assert_eq!(bound.0, fixture.selection.provider_config_version_id);
                assert_eq!(bound.2, fixture.binding.connection_id);
            }
            ("cancelled", HostNativeTurnSubmission::Cancelled { .. })
            | ("error", HostNativeTurnSubmission::Failed { .. }) => {}
            (_, unexpected) => panic!("wrong terminal outcome: {unexpected:?}"),
        }
        assert!(
            !coordinator
                .has_active_session(&opened.farfold_session_id)
                .unwrap()
        );
        assert_eq!(
            fixture
                .store
                .provider_projection_snapshot(&fixture.selection.provider_connection_id)
                .unwrap()
                .projections[0]
                .request_state,
            if emit_receipt && !newer_config {
                if mode == "error" {
                    ProviderRequestState::VerifiedFailure
                } else {
                    ProviderRequestState::VerifiedSuccess
                }
            } else {
                ProviderRequestState::NotRequested
            }
        );
        runtime.stop_for_shutdown().unwrap();
    }
}

#[test]
fn disconnected_pi_task_keeps_occupancy_until_exact_explicit_recovery_without_resend() {
    use crate::turn_coordinator::{
        HostNativeTurnSubmission, HostPiAcpTurnSubmitInput, TurnCoordinator,
        host_pi_acp_turn_submit_blocking,
    };
    let fixture = Fixture::new("http://127.0.0.1:1/v1");
    let runtime = PiAcpRuntime::default();
    let coordinator = TurnCoordinator::default();
    coordinator
        .attach_host_store(fixture.store.clone())
        .unwrap();
    let router = RuntimeEventRouter::with_capacity_and_all_observers(
        128,
        None,
        None,
        Some(coordinator.clone()),
    );
    let controller = crate::session_controller::HostSessionController::default();
    let mut response = fixture.response();
    response["promptMode"] = json!("exit");
    let handle = fixture.start(&runtime, &router, response);
    let opened =
        open_native_session(&handle, &router, &fixture.store, None, "Pi task fixture").unwrap();
    let input = HostPiAcpTurnSubmitInput {
        farfold_session_id: opened.farfold_session_id.clone(),
        native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
        runtime_generation: opened.runtime_generation,
        text: "fixture task".into(),
    };
    assert!(matches!(
        host_pi_acp_turn_submit_blocking(
            &controller,
            &fixture.store,
            &runtime,
            &router,
            &coordinator,
            &crate::interaction_registry::InteractionRegistry::default(),
            input
        )
        .unwrap(),
        HostNativeTurnSubmission::Unknown { .. }
    ));
    let target = fixture
        .store
        .session_open_target(&opened.farfold_session_id)
        .unwrap();
    assert!(
        coordinator
            .has_active_session(&opened.farfold_session_id)
            .unwrap()
    );
    let snapshot = serde_json::to_value(coordinator.snapshot().unwrap()).unwrap();
    let turn_id =
        crate::host_ids::HostTurnId::parse(snapshot["activeTurns"][0]["turnId"].as_str().unwrap())
            .unwrap();
    assert!(
        coordinator
            .require_bound_recovery(&target, opened.runtime_generation + 1, &turn_id)
            .is_err()
    );
    let turn = coordinator
        .require_bound_recovery(&target, opened.runtime_generation, &turn_id)
        .unwrap();
    assert!(
        runtime
            .stop_for_recovery(&router, &target, opened.runtime_generation + 1)
            .is_err()
    );
    let stopped = runtime
        .stop_for_recovery(&router, &target, opened.runtime_generation)
        .unwrap();
    assert!(!stopped.running);
    assert!(stopped.last_error.is_some());
    assert!(
        coordinator
            .has_active_session(&opened.farfold_session_id)
            .unwrap()
    );
    coordinator.finish_bound_recovery(&turn).unwrap();
    assert!(
        !coordinator
            .has_active_session(&opened.farfold_session_id)
            .unwrap()
    );
    assert!(runtime.is_stopped().unwrap());
}

#[test]
fn host_cancel_is_ordered_after_prompt_dispatch_and_waits_for_native_terminal() {
    host_cancel_fixture(false);
}

#[test]
fn ordinary_dialog_reply_requires_native_and_acp_identity_and_rejects_late_answers() {
    use crate::pi_acp_interactions::PiAcpDialogAnswer;
    let fixture = Fixture::new("http://127.0.0.1:1/v1");
    let runtime = PiAcpRuntime::default();
    let interactions = crate::interaction_registry::InteractionRegistry::default();
    let router =
        RuntimeEventRouter::with_capacity_and_observers(128, None, Some(interactions.clone()));
    let controller = crate::session_controller::HostSessionController::default();
    let mut response = fixture.response();
    let mut form = crate::pi_acp_interactions::form_fixture();
    form["params"]["sessionId"] = json!("native-fixture");
    form["params"]["_meta"]["sessionId"] = json!("native-fixture");
    response["form"] = form;
    let handle = fixture.start(&runtime, &router, response);
    let opened =
        open_native_session(&handle, &router, &fixture.store, None, "Pi dialog fixture").unwrap();
    let transport = handle.lock().unwrap().transport.clone();
    let accepted = json!({"action":"accept","content":{"value":false}});
    transport
        .request("fixture/show_form", json!({"expectedAnswer":accepted}))
        .unwrap();
    handle.lock().unwrap().update_events(&router).unwrap();
    assert_eq!(interactions.snapshots().unwrap().len(), 1);
    let input = PiAcpDialogResponseInput {
        farfold_session_id: opened.farfold_session_id,
        native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
        runtime_generation: opened.runtime_generation,
        request_id: "101".into(),
        native_request_id: "manual-dialog-1".into(),
        answer: PiAcpDialogAnswer::Confirm { confirmed: false },
    };
    for mistake in 0..5 {
        let mut wrong = input.clone();
        match mistake {
            0 => wrong.native_session_id = NativeSessionId::parse("other-native").unwrap(),
            1 => wrong.runtime_generation += 1,
            2 => wrong.request_id = "other-rpc-id".into(),
            3 => wrong.native_request_id = "other-native-dialog".into(),
            _ => {
                wrong.answer = PiAcpDialogAnswer::Text {
                    value: "false".into(),
                }
            }
        }
        assert!(
            respond_dialog(
                &controller,
                &runtime,
                &fixture.store,
                &router,
                &interactions,
                wrong
            )
            .is_err()
        );
        assert_eq!(interactions.snapshots().unwrap().len(), 1);
    }
    respond_dialog(
        &controller,
        &runtime,
        &fixture.store,
        &router,
        &interactions,
        input.clone(),
    )
    .unwrap();
    assert_eq!(
        transport
            .request("fixture/last_form_answer", json!({}))
            .unwrap(),
        accepted
    );
    assert!(interactions.snapshots().unwrap().is_empty());
    assert!(
        respond_dialog(
            &controller,
            &runtime,
            &fixture.store,
            &router,
            &interactions,
            input.clone()
        )
        .is_err()
    );
    transport.request("fixture/show_form", json!({})).unwrap();
    handle.lock().unwrap().update_events(&router).unwrap();
    assert!(
        respond_dialog(
            &controller,
            &runtime,
            &fixture.store,
            &router,
            &interactions,
            input.clone()
        )
        .is_err()
    );
    assert_eq!(interactions.snapshots().unwrap().len(), 1);
    transport
        .request("fixture/withdraw_form", json!({}))
        .unwrap();
    handle.lock().unwrap().update_events(&router).unwrap();
    assert!(interactions.snapshots().unwrap().is_empty());
    let mut withdrawn = input;
    withdrawn.request_id = "102".into();
    withdrawn.native_request_id = "manual-dialog-2".into();
    assert!(
        respond_dialog(
            &controller,
            &runtime,
            &fixture.store,
            &router,
            &interactions,
            withdrawn
        )
        .is_err()
    );
    assert_eq!(
        transport
            .request("fixture/last_form_answer", json!({}))
            .unwrap(),
        json!({"action":"cancel"})
    );
    runtime.stop_for_shutdown().unwrap();
}

#[test]
fn concurrent_workspace_read_does_not_make_a_confirmed_task_unknown() {
    concurrent_workspace_fixture(false);
}

#[test]
fn pending_workspace_read_does_not_block_native_cancel_dispatch() {
    concurrent_workspace_fixture(true);
}

fn concurrent_workspace_fixture(cancel: bool) {
    use crate::turn_coordinator::{
        HostNativeTurnSubmission, HostPiAcpTurnAbortInput, HostPiAcpTurnSubmitInput,
        TurnCoordinator, host_pi_acp_turn_abort_blocking, host_pi_acp_turn_submit_blocking,
    };
    let fixture = Fixture::new("http://127.0.0.1:1/v1");
    let runtime = PiAcpRuntime::default();
    let coordinator = TurnCoordinator::default();
    coordinator
        .attach_host_store(fixture.store.clone())
        .unwrap();
    let interactions = crate::interaction_registry::InteractionRegistry::default();
    let router = RuntimeEventRouter::with_capacity_and_all_observers(
        128,
        None,
        Some(interactions.clone()),
        Some(coordinator.clone()),
    );
    let mut response = fixture.response();
    response["holdEntries"] = json!(true);
    if cancel {
        response["promptMode"] = json!("wait");
    }
    let handle = fixture.start(&runtime, &router, response);
    let opened = open_native_session(
        &handle,
        &router,
        &fixture.store,
        None,
        "Pi concurrent read fixture",
    )
    .unwrap();
    let read_input = PiAcpWorkspaceInput {
        farfold_session_id: opened.farfold_session_id.clone(),
        native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
        runtime_generation: opened.runtime_generation,
        section: PiWorkspaceSection::Entries,
    };
    let reader = {
        let runtime = runtime.clone();
        let store = fixture.store.clone();
        let router = router.clone();
        std::thread::spawn(move || read_workspace(&runtime, &store, &router, read_input))
    };
    let transport = handle.lock().unwrap().transport.clone();
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while transport
        .request("fixture/read_pending", json!({}))
        .unwrap()["pending"]
        != true
    {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    let input = HostPiAcpTurnSubmitInput {
        farfold_session_id: opened.farfold_session_id.clone(),
        native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
        runtime_generation: opened.runtime_generation,
        text: "fixture task during held history read".into(),
    };
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let controller = Arc::new(crate::session_controller::HostSessionController::default());
    let worker = {
        let runtime = runtime.clone();
        let store = fixture.store.clone();
        let router = router.clone();
        let coordinator = coordinator.clone();
        let controller = controller.clone();
        let interactions = interactions.clone();
        std::thread::spawn(move || {
            sender
                .send(host_pi_acp_turn_submit_blocking(
                    &controller,
                    &store,
                    &runtime,
                    &router,
                    &coordinator,
                    &interactions,
                    input,
                ))
                .unwrap();
        })
    };
    if cancel {
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while !coordinator
            .has_active_session(&opened.farfold_session_id)
            .unwrap()
        {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        }
        let turn = coordinator
            .active_for_session(&opened.farfold_session_id)
            .unwrap()
            .unwrap();
        assert!(
            host_pi_acp_turn_abort_blocking(
                &controller,
                &fixture.store,
                &runtime,
                &coordinator,
                &router,
                &interactions,
                HostPiAcpTurnAbortInput {
                    farfold_session_id: opened.farfold_session_id.clone(),
                    native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
                    runtime_generation: opened.runtime_generation,
                    turn_id: turn.id().clone(),
                }
            )
            .unwrap()
        );
    }
    let early = receiver.recv_timeout(Duration::from_millis(300));
    transport
        .request("fixture/release_read", json!({}))
        .unwrap();
    assert!(reader.join().unwrap().is_ok());
    let result = early.unwrap_or_else(|_| receiver.recv_timeout(Duration::from_secs(3)).unwrap());
    worker.join().unwrap();
    runtime.stop_for_shutdown().unwrap();
    assert!(
        matches!(
            (&result, cancel),
            (Ok(HostNativeTurnSubmission::Accepted { .. }), false)
                | (Ok(HostNativeTurnSubmission::Cancelled { .. }), true)
        ),
        "confirmed task became {result:?}"
    );
    assert!(
        !coordinator
            .has_active_session(&opened.farfold_session_id)
            .unwrap()
    );
}

#[test]
fn intervention_ack_is_ordered_with_terminal_and_does_not_block_stop() {
    use crate::turn_coordinator::{
        HostNativeTurnSubmission, HostPiAcpInterventionInput, HostPiAcpInterventionOutcome,
        HostPiAcpTurnAbortInput, HostPiAcpTurnSubmitInput, TurnCoordinator,
        host_pi_acp_intervene_blocking, host_pi_acp_turn_abort_blocking,
        host_pi_acp_turn_submit_blocking,
    };
    for mode in ["complete", "malformed", "cancel"] {
        let fixture = Fixture::new("http://127.0.0.1:1/v1");
        let runtime = PiAcpRuntime::default();
        let coordinator = TurnCoordinator::default();
        coordinator
            .attach_host_store(fixture.store.clone())
            .unwrap();
        let interactions = crate::interaction_registry::InteractionRegistry::default();
        let router = RuntimeEventRouter::with_capacity_and_all_observers(
            128,
            None,
            Some(interactions.clone()),
            Some(coordinator.clone()),
        );
        let controller = crate::session_controller::HostSessionController::default();
        let mut response = fixture.response();
        response["promptMode"] = json!("wait");
        response["holdIntervention"] = json!(true);
        let handle = fixture.start(&runtime, &router, response);
        let opened = open_native_session(
            &handle,
            &router,
            &fixture.store,
            None,
            "Pi intervention fixture",
        )
        .unwrap();
        let transport = handle.lock().unwrap().transport.clone();
        let native = NativeSessionId::parse(&opened.native_session_id).unwrap();
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                sender
                    .send(host_pi_acp_turn_submit_blocking(
                        &controller,
                        &fixture.store,
                        &runtime,
                        &router,
                        &coordinator,
                        &interactions,
                        HostPiAcpTurnSubmitInput {
                            farfold_session_id: opened.farfold_session_id.clone(),
                            native_session_id: native.clone(),
                            runtime_generation: opened.runtime_generation,
                            text: "Original fixture prompt".into(),
                        },
                    ))
                    .unwrap();
            });
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            while transport
                .request("fixture/intervention_status", json!({}))
                .unwrap()["prompts"]
                != 1
            {
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(1));
            }
            let active = coordinator
                .active_for_session(&opened.farfold_session_id)
                .unwrap()
                .unwrap();
            assert!(
                set_config_option(
                    &controller,
                    &runtime,
                    &fixture.store,
                    &router,
                    &coordinator,
                    PiAcpConfigInput {
                        farfold_session_id: opened.farfold_session_id.clone(),
                        native_session_id: native.clone(),
                        runtime_generation: opened.runtime_generation,
                        config_id: PiAcpConfigId::ThoughtLevel,
                        value: "high".into()
                    }
                )
                .is_err()
            );
            let input = HostPiAcpInterventionInput {
                farfold_session_id: opened.farfold_session_id.clone(),
                native_session_id: native.clone(),
                runtime_generation: opened.runtime_generation,
                turn_id: active.id().clone(),
                kind: if mode == "cancel" {
                    PiAcpInterventionKind::FollowUp
                } else {
                    PiAcpInterventionKind::Steer
                },
                message: "Native intervention".into(),
            };
            for field in ["generation", "native", "turn", "empty"] {
                let mut wrong = input.clone();
                match field {
                    "generation" => wrong.runtime_generation += 1,
                    "native" => {
                        wrong.native_session_id = NativeSessionId::parse("other-native").unwrap()
                    }
                    "turn" => {
                        wrong.turn_id = crate::host_ids::HostTurnId::parse("old-turn").unwrap()
                    }
                    _ => wrong.message.clear(),
                }
                assert!(
                    host_pi_acp_intervene_blocking(
                        &controller,
                        &fixture.store,
                        &runtime,
                        &coordinator,
                        wrong
                    )
                    .is_err()
                );
            }
            let intervention = {
                let input = input.clone();
                let controller = &controller;
                let store = &fixture.store;
                let runtime = &runtime;
                let coordinator = &coordinator;
                scope.spawn(move || {
                    host_pi_acp_intervene_blocking(controller, store, runtime, coordinator, input)
                })
            };
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            while transport
                .request("fixture/intervention_status", json!({}))
                .unwrap()["held"]
                != true
            {
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(1));
            }
            if mode == "cancel" {
                assert!(
                    host_pi_acp_turn_abort_blocking(
                        &controller,
                        &fixture.store,
                        &runtime,
                        &coordinator,
                        &router,
                        &interactions,
                        HostPiAcpTurnAbortInput {
                            farfold_session_id: input.farfold_session_id.clone(),
                            native_session_id: native.clone(),
                            runtime_generation: opened.runtime_generation,
                            turn_id: input.turn_id.clone(),
                        },
                    )
                    .unwrap()
                );
            } else {
                transport
                    .request("fixture/finish_prompt", json!({}))
                    .unwrap();
            }
            let early = receiver.recv_timeout(Duration::from_millis(100));
            transport
                .request(
                    "fixture/release_intervention",
                    json!({"malformed":mode=="malformed"}),
                )
                .unwrap();
            let reply = intervention.join().unwrap().unwrap();
            let settled_early = early.is_ok();
            let terminal = early
                .unwrap_or_else(|_| receiver.recv_timeout(Duration::from_secs(3)).unwrap())
                .unwrap();
            worker.join().unwrap();
            assert!(
                !settled_early,
                "terminal settled before intervention ACK validation"
            );
            assert!(
                matches!(
                    (&reply, mode),
                    (HostPiAcpInterventionOutcome::Unknown { .. }, "malformed")
                        | (
                            HostPiAcpInterventionOutcome::Queued { .. },
                            "complete" | "cancel"
                        )
                ),
                "{reply:?}"
            );
            assert!(
                matches!(
                    (&terminal, mode),
                    (HostNativeTurnSubmission::Unknown { .. }, "malformed")
                        | (HostNativeTurnSubmission::Accepted { .. }, "complete")
                        | (HostNativeTurnSubmission::Cancelled { .. }, "cancel")
                ),
                "{terminal:?}"
            );
            let remaining = coordinator
                .active_for_session(&opened.farfold_session_id)
                .unwrap();
            assert_eq!(remaining.is_some(), mode == "malformed");
            assert!(
                host_pi_acp_intervene_blocking(
                    &controller,
                    &fixture.store,
                    &runtime,
                    &coordinator,
                    input
                )
                .is_err()
            );
            let status = transport
                .request("fixture/intervention_status", json!({}))
                .unwrap();
            assert_eq!(status["prompts"], 1);
            assert_eq!(status["interventions"].as_array().unwrap().len(), 1);
        });
        runtime.stop_for_shutdown().unwrap();
    }
}

#[test]
fn host_cancel_closes_exact_form_registry_after_native_withdrawal() {
    host_cancel_fixture(true);
}

fn host_cancel_fixture(with_form: bool) {
    host_cancel_capability_fixture(with_form, false);
}

#[test]
fn unsupported_compaction_cancel_preserves_active_task_and_normal_completion() {
    host_cancel_capability_fixture(false, true);
}

fn host_cancel_capability_fixture(with_form: bool, unsupported: bool) {
    use crate::turn_coordinator::{
        HostNativeTurnSubmission, HostPiAcpTurnAbortInput, HostPiAcpTurnSubmitInput,
        TurnCoordinator, host_pi_acp_turn_abort_blocking, host_pi_acp_turn_submit_blocking,
    };
    let fixture = Fixture::new("http://127.0.0.1:1/v1");
    let runtime = PiAcpRuntime::default();
    let coordinator = TurnCoordinator::default();
    coordinator
        .attach_host_store(fixture.store.clone())
        .unwrap();
    let interactions = crate::interaction_registry::InteractionRegistry::default();
    let router = RuntimeEventRouter::with_capacity_and_all_observers(
        128,
        None,
        Some(interactions.clone()),
        Some(coordinator.clone()),
    );
    let controller = Arc::new(crate::session_controller::HostSessionController::default());
    let mut response = fixture.response();
    response["promptMode"] = json!("wait");
    response["cancelUnsupported"] = json!(unsupported);
    if with_form {
        let mut form = crate::pi_acp_interactions::form_fixture();
        form["params"]["sessionId"] = json!("native-fixture");
        form["params"]["_meta"]["sessionId"] = json!("native-fixture");
        response["form"] = form;
    }
    let handle = fixture.start(&runtime, &router, response);
    let opened =
        open_native_session(&handle, &router, &fixture.store, None, "Pi cancel fixture").unwrap();
    let mut previous_abort: Option<HostPiAcpTurnAbortInput> = None;
    for round in 0..2 {
        let input = HostPiAcpTurnSubmitInput {
            farfold_session_id: opened.farfold_session_id.clone(),
            native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
            runtime_generation: opened.runtime_generation,
            text: "fixture pending task".into(),
        };
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let worker = {
            let runtime = runtime.clone();
            let router = router.clone();
            let coordinator = coordinator.clone();
            let controller = controller.clone();
            let store = fixture.store.clone();
            let interactions = interactions.clone();
            std::thread::spawn(move || {
                sender
                    .send(host_pi_acp_turn_submit_blocking(
                        &controller,
                        &store,
                        &runtime,
                        &router,
                        &coordinator,
                        &interactions,
                        input,
                    ))
                    .unwrap()
            })
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while !coordinator
            .has_active_session(&opened.farfold_session_id)
            .unwrap()
            || (with_form && interactions.snapshots().unwrap().is_empty())
        {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        }
        let abort = HostPiAcpTurnAbortInput {
            farfold_session_id: opened.farfold_session_id.clone(),
            native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
            runtime_generation: opened.runtime_generation,
            turn_id: coordinator
                .active_for_session(&opened.farfold_session_id)
                .unwrap()
                .unwrap()
                .id()
                .clone(),
        };
        let mut stale_abort = abort.clone();
        stale_abort.turn_id = crate::host_ids::HostTurnId::parse("stale-turn").unwrap();
        if let Some(previous) = &previous_abort {
            stale_abort = previous.clone();
        }
        if with_form && round == 1 {
            assert!(
                interactions
                    .begin_response(
                        fixture.binding.clone(),
                        opened.runtime_generation,
                        "7",
                        Some("native-fixture")
                    )
                    .is_err()
            );
            assert!(
                handle
                    .lock()
                    .unwrap()
                    .transport
                    .respond_client_request(
                        "7",
                        json!({"action":"accept","content":{"value":true}})
                    )
                    .is_err()
            );
            assert_eq!(interactions.snapshots().unwrap().len(), 1);
        }
        assert!(
            host_pi_acp_turn_abort_blocking(
                &controller,
                &fixture.store,
                &runtime,
                &coordinator,
                &router,
                &interactions,
                stale_abort
            )
            .unwrap_err()
            .contains("旧任务")
        );
        assert!(receiver.try_recv().is_err());
        let cancel_result = host_pi_acp_turn_abort_blocking(
            &controller,
            &fixture.store,
            &runtime,
            &coordinator,
            &router,
            &interactions,
            abort.clone(),
        );
        if unsupported {
            assert!(cancel_result.unwrap_err().contains("不支持停止手动压缩"));
            assert!(
                coordinator
                    .has_active_session(&opened.farfold_session_id)
                    .unwrap()
            );
            assert!(receiver.try_recv().is_err());
            handle
                .lock()
                .unwrap()
                .transport
                .request("fixture/finish_prompt", json!({}))
                .unwrap();
        } else {
            assert!(cancel_result.unwrap());
        }
        let result = receiver.recv_timeout(Duration::from_secs(3));
        if result.is_err() {
            let _ = runtime.stop_for_shutdown();
        }
        worker.join().unwrap();
        let result = result.unwrap().unwrap();
        assert!(matches!(
            (&result, unsupported),
            (HostNativeTurnSubmission::Accepted { .. }, true)
                | (HostNativeTurnSubmission::Cancelled { .. }, false)
        ));
        assert!(
            !coordinator
                .has_active_session(&opened.farfold_session_id)
                .unwrap()
        );
        let pending_forms = interactions.snapshots().unwrap();
        assert!(
            pending_forms.is_empty(),
            "registry pending after confirmed cancel: {pending_forms:?}"
        );
        if with_form {
            assert!(
                interactions
                    .begin_response(
                        fixture.binding.clone(),
                        opened.runtime_generation,
                        &(7 + round).to_string(),
                        Some("native-fixture")
                    )
                    .is_err()
            );
        }
        previous_abort = Some(abort);
    }
    runtime.stop_for_shutdown().unwrap();
}

#[test]
fn prompt_dispatch_rejects_provider_changed_since_admission_even_when_model_text_is_identical() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1");
    let runtime = PiAcpRuntime::default();
    let router = RuntimeEventRouter::default();
    let handle = fixture.start(&runtime, &router, fixture.response());
    let opened =
        open_native_session(&handle, &router, &fixture.store, None, "Admission fixture").unwrap();
    let target = fixture
        .store
        .session_open_target(&opened.farfold_session_id)
        .unwrap();
    let admitted = capture_prompt_model(
        &runtime,
        &fixture.store,
        &router,
        &target,
        opened.runtime_generation,
    )
    .unwrap();
    let turn_id = HostTurnId::parse("admission-fixture-turn").unwrap();
    {
        let mut connection = handle.lock().unwrap();
        connection.managed_versions[0].provider_config_version_id =
            crate::host_ids::ProviderConfigVersionId::parse("another-config-version").unwrap();
    }
    let rejected = begin_prompt_text(
        &runtime,
        &target,
        opened.runtime_generation,
        "Must not send",
        &turn_id,
        &admitted,
    );
    assert!(matches!(rejected, Err(AcpDispatchError::NotSent(_))));
    assert!(
        !handle
            .lock()
            .unwrap()
            .transport
            .has_unresolved_work()
            .unwrap()
    );
    handle.lock().unwrap().managed_versions =
        vec![admitted.source().managed_binding().unwrap().clone()];
    let response = begin_prompt_text(
        &runtime,
        &target,
        opened.runtime_generation,
        "Accepted fixture",
        &turn_id,
        &admitted,
    )
    .unwrap()
    .wait_timeout(REQUEST_TIMEOUT)
    .unwrap();
    assert_eq!(response["stopReason"], "end_turn");
    runtime.stop_for_shutdown().unwrap();
}

#[test]
fn adapter_preflight_rejection_releases_only_confirmed_not_sent_turns_without_provider_verification()
 {
    use crate::turn_coordinator::{
        HostNativeTurnSubmission, HostPiAcpTurnSubmitInput, TurnCoordinator,
        host_pi_acp_turn_submit_blocking,
    };
    for mode in ["preflight_not_sent", "preflight_unknown"] {
        let fixture = Fixture::new("http://127.0.0.1:1/v1");
        let runtime = PiAcpRuntime::default();
        let router = RuntimeEventRouter::default();
        let controller = crate::session_controller::HostSessionController::default();
        let turns = TurnCoordinator::default();
        let interactions = crate::interaction_registry::InteractionRegistry::default();
        let mut response = fixture.response();
        response["promptMode"] = json!(mode);
        let handle = fixture.start(&runtime, &router, response);
        let opened =
            open_native_session(&handle, &router, &fixture.store, None, "Preflight outcome")
                .unwrap();
        let result = host_pi_acp_turn_submit_blocking(
            &controller,
            &fixture.store,
            &runtime,
            &router,
            &turns,
            &interactions,
            HostPiAcpTurnSubmitInput {
                farfold_session_id: opened.farfold_session_id.clone(),
                native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
                runtime_generation: opened.runtime_generation,
                text: "Preflight test".into(),
            },
        );
        if mode == "preflight_not_sent" {
            assert!(result.unwrap_err().contains("未发送"));
        } else {
            assert!(matches!(
                result,
                Ok(HostNativeTurnSubmission::Unknown { .. })
            ));
        }
        assert_eq!(
            turns
                .has_active_session(&opened.farfold_session_id)
                .unwrap(),
            mode == "preflight_unknown"
        );
        let db = rusqlite::Connection::open_with_flags(
            fixture.temp.path().join("host.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM turn_provider_bindings", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(db.query_row("SELECT COUNT(*) FROM provider_target_projections WHERE request_verified_version_id IS NOT NULL", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        runtime.stop_for_shutdown().unwrap();
    }
}

#[test]
fn prompt_capture_rejects_actual_model_or_idle_identity_drift_before_admission() {
    use crate::turn_coordinator::{
        HostPiAcpTurnSubmitInput, TurnCoordinator, host_pi_acp_turn_submit_blocking,
    };
    for state_override in [
        json!({"model":null}),
        json!({"model":{"provider":"native-provider","id":"native-model"}}),
        json!({"model":{"provider":"farfold-managed-unmatched","id":"model"}}),
        json!({"model":{"provider":"ambiguous/provider","id":"model"}}),
        json!({"model":{"provider":"provider","id":""}}),
        json!({"sessionId":"other"}),
        json!({"sessionFile":"/other/native.jsonl"}),
        json!({"sessionFile":null}),
        json!({"isStreaming":true}),
        json!({"isCompacting":true}),
        json!({"pendingMessageCount":1}),
        json!({"isStreaming":null}),
    ] {
        let fixture = Fixture::new("http://127.0.0.1:1/v1");
        let runtime = PiAcpRuntime::default();
        let router = RuntimeEventRouter::default();
        let controller = crate::session_controller::HostSessionController::default();
        let turns = TurnCoordinator::default();
        let interactions = crate::interaction_registry::InteractionRegistry::default();
        let mut response = fixture.response();
        response["stateOverride"] = state_override.clone();
        let handle = fixture.start(&runtime, &router, response);
        let opened =
            open_native_session(&handle, &router, &fixture.store, None, "Capture rejection")
                .unwrap();
        let result = host_pi_acp_turn_submit_blocking(
            &controller,
            &fixture.store,
            &runtime,
            &router,
            &turns,
            &interactions,
            HostPiAcpTurnSubmitInput {
                farfold_session_id: opened.farfold_session_id.clone(),
                native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
                runtime_generation: opened.runtime_generation,
                text: "Must not reach native prompt".into(),
            },
        );
        assert!(result.is_err(), "accepted {state_override}");
        assert!(
            !turns
                .has_active_session(&opened.farfold_session_id)
                .unwrap()
        );
        let transport = handle.lock().unwrap().transport.clone();
        assert_eq!(
            transport
                .request("fixture/prompt_calls", json!({}))
                .unwrap(),
            json!(0)
        );
        let db = rusqlite::Connection::open_with_flags(
            fixture.temp.path().join("host.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM turn_provider_bindings", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        runtime.stop_for_shutdown().unwrap();
    }
}

#[test]
fn prompt_observation_carries_real_read_time_and_rejects_other_identity_or_generation() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1");
    let runtime = PiAcpRuntime::default();
    let router = RuntimeEventRouter::default();
    let handle = fixture.start(&runtime, &router, fixture.response());
    let opened =
        open_native_session(&handle, &router, &fixture.store, None, "Capture identity").unwrap();
    let target = fixture
        .store
        .session_open_target(&opened.farfold_session_id)
        .unwrap();
    let before = crate::host_store::now_millis() as u64;
    let mut observation = capture_prompt_model(
        &runtime,
        &fixture.store,
        &router,
        &target,
        opened.runtime_generation,
    )
    .unwrap();
    assert!(observation.observed_at() >= before);
    assert!(observation.observed_at() <= crate::host_store::now_millis() as u64);
    assert_eq!(
        observation.source().managed_binding(),
        Some(&fixture.prepared.binding.clone().unwrap())
    );
    observation
        .verify_target(&target, opened.runtime_generation)
        .unwrap();
    assert!(
        observation
            .verify_target(&target, opened.runtime_generation + 1)
            .is_err()
    );
    for field in [
        "session",
        "native",
        "connection",
        "build",
        "adapter",
        "installation",
    ] {
        let mut other = target.clone();
        match field {
            "session" => other.farfold_session_id = FarfoldSessionId::parse("other").unwrap(),
            "native" => other.native_session_id = NativeSessionId::parse("other").unwrap(),
            "connection" => other.connection_id = ConnectionId::parse("other").unwrap(),
            "build" => {
                other.runtime_build_id = crate::host_ids::RuntimeBuildId::parse("other").unwrap()
            }
            "adapter" => other.adapter_id = crate::host_ids::AdapterId::parse("other").unwrap(),
            _ => other.installation_id = crate::host_ids::InstallationId::parse("other").unwrap(),
        }
        assert!(
            observation
                .verify_target(&other, opened.runtime_generation)
                .is_err(),
            "{field}"
        );
    }
    observation.observed_at = u64::MAX;
    assert!(matches!(
        begin_prompt_text(
            &runtime,
            &target,
            opened.runtime_generation,
            "No future read",
            &HostTurnId::parse("future-read").unwrap(),
            &observation
        ),
        Err(AcpDispatchError::NotSent(_))
    ));
    runtime.stop_for_shutdown().unwrap();
}

#[test]
fn held_prompt_capture_does_not_hold_controller_or_admit_a_late_generation() {
    use crate::turn_coordinator::{
        HostPiAcpTurnSubmitInput, TurnCoordinator, host_pi_acp_turn_submit_blocking,
    };
    let fixture = Fixture::new("http://127.0.0.1:1/v1");
    let runtime = PiAcpRuntime::default();
    let router = RuntimeEventRouter::default();
    let controller = crate::session_controller::HostSessionController::default();
    let turns = TurnCoordinator::default();
    let interactions = crate::interaction_registry::InteractionRegistry::default();
    let mut response = fixture.response();
    response["holdFirstState"] = json!(true);
    let handle = fixture.start(&runtime, &router, response);
    let opened =
        open_native_session(&handle, &router, &fixture.store, None, "Held capture").unwrap();
    let transport = handle.lock().unwrap().transport.clone();
    std::thread::scope(|scope| {
        let worker = scope.spawn(|| {
            host_pi_acp_turn_submit_blocking(
                &controller,
                &fixture.store,
                &runtime,
                &router,
                &turns,
                &interactions,
                HostPiAcpTurnSubmitInput {
                    farfold_session_id: opened.farfold_session_id.clone(),
                    native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
                    runtime_generation: opened.runtime_generation,
                    text: "Late capture must not send".into(),
                },
            )
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while transport
            .request("fixture/read_pending", json!({}))
            .unwrap()["pending"]
            != true
        {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(
            !turns
                .has_active_session(&opened.farfold_session_id)
                .unwrap()
        );
        controller
            .exclusive(|| {
                handle.lock().unwrap().generation += 1;
                Ok(())
            })
            .unwrap();
        transport
            .request("fixture/release_read", json!({}))
            .unwrap();
        assert!(worker.join().unwrap().is_err());
    });
    assert_eq!(
        transport
            .request("fixture/prompt_calls", json!({}))
            .unwrap(),
        json!(0)
    );
    assert!(
        !turns
            .has_active_session(&opened.farfold_session_id)
            .unwrap()
    );
    runtime.stop_for_shutdown().unwrap();
}

#[test]
fn model_source_distinguishes_exact_managed_version_from_native_observation() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1");
    let managed = &fixture.prepared.binding.clone().unwrap();
    let options = |selector: &str| json!([{"id":"model","type":"select","currentValue":selector}]);
    let bindings = std::slice::from_ref(managed);
    let source = observed_model_source(&options(&managed.runtime_model_id), bindings).unwrap();
    assert_eq!(source.managed_binding(), Some(managed));
    let mut second = managed.clone();
    second.provider_config_version_id =
        crate::host_ids::ProviderConfigVersionId::parse("second-version").unwrap();
    second.runtime_provider_id = "farfold-managed-second".into();
    second.runtime_model_id = format!("{}/fixture-only", second.runtime_provider_id);
    let versions = vec![managed.clone(), second.clone()];
    let second_source =
        observed_model_source(&options(&second.runtime_model_id), &versions).unwrap();
    assert_eq!(second_source.managed_binding(), Some(&second));
    assert!(observed_model_source(&options(&second.runtime_model_id), bindings).is_err());
    assert!(observed_model_source(&options("farfold-managed-second/unbound"), &versions).is_err());
    let native = observed_model_source(&options("native-provider/native-model"), bindings).unwrap();
    assert!(native.managed_binding().is_none());
    assert_eq!(
        serde_json::to_value(&native).unwrap(),
        json!({
        "kind":"native_observation", "runtimeProviderId":"native-provider", "runtimeModelId":"native-provider/native-model", "nativeModelId":"native-model"
        })
    );
    for selector in [
        String::new(),
        "missing-provider".into(),
        "/missing-provider".into(),
        "missing-model/".into(),
        format!("{}/unbound-model", managed.runtime_provider_id),
        "farfold-managed-unknown/unbound-model".into(),
        format!("{}/model", "p".repeat(201)),
        format!("provider/{}", "m".repeat(513)),
    ] {
        assert!(observed_model_source(&options(&selector), bindings).is_err());
    }
    assert!(observed_model_source(&json!([]), bindings).is_err());
}

#[test]
fn explicit_native_selection_binds_turn_source_without_managed_verification() {
    use crate::turn_coordinator::{
        HostNativeTurnSubmission, HostPiAcpTurnSubmitInput, TurnCoordinator,
        host_pi_acp_turn_submit_blocking,
    };
    for mode in ["success", "mismatch", "malformed", "reject"] {
        let fixture = Fixture::stable("http://127.0.0.1:1/v1");
        let runtime = PiAcpRuntime::default();
        let turns = TurnCoordinator::default();
        turns.attach_host_store(fixture.store.clone()).unwrap();
        let router = RuntimeEventRouter::with_capacity_and_all_observers(
            128,
            None,
            None,
            Some(turns.clone()),
        );
        let controller = crate::session_controller::HostSessionController::default();
        let mut response = fixture.response();
        response["autoConfig"] = json!(true);
        response["emitReceipt"] = json!(true);
        response["configMode"] = json!(mode);
        response["configOptions"][0]["options"]
            .as_array_mut()
            .unwrap()
            .push(json!({"value":"native-provider/native-model","name":"Native model"}));
        if mode == "mismatch" {
            response["stateOverride"] =
                json!({"model":{"provider":"different-provider","id":"native-model"}});
        }
        let handle = fixture.start(&runtime, &router, response);
        let opened =
            open_native_session(&handle, &router, &fixture.store, None, "Native selection")
                .unwrap();
        let original = serde_json::to_value(
            fixture
                .store
                .provider_projection_snapshot(&fixture.selection.provider_connection_id)
                .unwrap(),
        )
        .unwrap();
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
                value: "native-provider/native-model".into(),
            },
        );
        let target = fixture
            .store
            .session_open_target(&opened.farfold_session_id)
            .unwrap();
        let db = rusqlite::Connection::open_with_flags(
            fixture.temp.path().join("host.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        if mode == "success" {
            let selected = selected.unwrap();
            assert!(selected.native_admission_ready);
            assert!(selected.managed_provider.is_none());
            let task = host_pi_acp_turn_submit_blocking(
                &controller,
                &fixture.store,
                &runtime,
                &router,
                &turns,
                &crate::interaction_registry::InteractionRegistry::default(),
                HostPiAcpTurnSubmitInput {
                    farfold_session_id: opened.farfold_session_id.clone(),
                    native_session_id: target.native_session_id.clone(),
                    runtime_generation: opened.runtime_generation,
                    text: "Native source fixture".into(),
                },
            )
            .unwrap();
            let HostNativeTurnSubmission::Accepted { submission } = task else {
                panic!("native task was not accepted")
            };
            let observed: Value = db.query_row("SELECT source_kind, provider_connection_id, provider_config_version_id,
                    farfold_session_id, native_session_id, runtime_product_id, installation_id, runtime_connection_id,
                    runtime_build_id, adapter_id, runtime_generation, runtime_provider_id, runtime_model_id, native_model_id,
                    observed_at, bound_at FROM turn_provider_bindings WHERE host_turn_id = ?1", [submission.turn_id.as_str()], |row| {
                    Ok(json!({"kind":row.get::<_,String>(0)?,"provider":row.get::<_,Option<String>>(1)?,"version":row.get::<_,Option<String>>(2)?,
                        "host":row.get::<_,String>(3)?,"native":row.get::<_,String>(4)?,"product":row.get::<_,String>(5)?,
                        "installation":row.get::<_,String>(6)?,"connection":row.get::<_,String>(7)?,"build":row.get::<_,String>(8)?,
                        "adapter":row.get::<_,String>(9)?,"generation":row.get::<_,i64>(10)?,"runtimeProvider":row.get::<_,String>(11)?,
                        "runtimeModel":row.get::<_,String>(12)?,"nativeModel":row.get::<_,String>(13)?,
                        "observedAt":row.get::<_,i64>(14)?,"boundAt":row.get::<_,i64>(15)?}))
                }).unwrap();
            assert_eq!(observed["kind"], "native_observation");
            assert_eq!(observed["provider"], Value::Null);
            assert_eq!(observed["version"], Value::Null);
            assert_eq!(observed["host"], opened.farfold_session_id.as_str());
            assert_eq!(observed["native"], opened.native_session_id);
            assert_eq!(observed["product"], fixture.binding.product_id.as_str());
            assert_eq!(
                observed["installation"],
                fixture.binding.installation_id.as_str()
            );
            assert_eq!(
                observed["connection"],
                fixture.binding.connection_id.as_str()
            );
            assert_eq!(observed["build"], fixture.binding.runtime_build_id.as_str());
            assert_eq!(observed["adapter"], fixture.binding.adapter_id.as_str());
            assert_eq!(observed["generation"], opened.runtime_generation);
            assert_eq!(observed["runtimeProvider"], "native-provider");
            assert_eq!(observed["runtimeModel"], "native-provider/native-model");
            assert_eq!(observed["nativeModel"], "native-model");
            assert!(
                observed["observedAt"].as_u64().unwrap() <= observed["boundAt"].as_u64().unwrap()
            );
        } else {
            assert!(selected.is_err());
            let status = current_status(&runtime, &router).unwrap();
            assert!(!status.native_admission_ready);
            if mode != "reject" {
                assert_eq!(status.configuration_state, PiConfigurationState::Unknown);
                assert!(
                    verify_prompt_target(&runtime, &target, opened.runtime_generation).is_err()
                );
            }
            assert_eq!(
                db.query_row("SELECT COUNT(*) FROM turn_provider_bindings", [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert_eq!(
                handle
                    .lock()
                    .unwrap()
                    .transport
                    .request("fixture/prompt_calls", json!({}))
                    .unwrap(),
                0
            );
        }
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
        assert!(
            !turns
                .has_active_session(&opened.farfold_session_id)
                .unwrap()
        );
        runtime.stop_for_shutdown().unwrap();
    }
}

#[test]
fn native_model_observation_cannot_reuse_bootstrap_provider_or_admit_a_source_less_turn() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1");
    let runtime = PiAcpRuntime::default();
    let router = RuntimeEventRouter::default();
    let handle = fixture.start(&runtime, &router, fixture.response());
    let opened = open_native_session(
        &handle,
        &router,
        &fixture.store,
        None,
        "Model source fixture",
    )
    .unwrap();
    let target = fixture
        .store
        .session_open_target(&opened.farfold_session_id)
        .unwrap();
    let admitted = capture_prompt_model(
        &runtime,
        &fixture.store,
        &router,
        &target,
        opened.runtime_generation,
    )
    .unwrap();
    assert!(
        current_status(&runtime, &router)
            .unwrap()
            .managed_provider
            .is_some()
    );
    {
        let mut connection = handle.lock().unwrap();
        let option = connection
            .config_options
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|option| option["id"] == "model")
            .unwrap();
        option["currentValue"] = json!("native-provider/native-model");
    }
    let status = current_status(&runtime, &router).unwrap();
    assert!(status.managed_provider.is_none());
    assert!(matches!(
        status.model_source,
        Some(PiModelSource::NativeObservation { .. })
    ));
    assert!(verify_prompt_target(&runtime, &target, opened.runtime_generation).is_err());
    assert!(matches!(
        begin_prompt_text(
            &runtime,
            &target,
            opened.runtime_generation,
            "Must not send",
            &HostTurnId::parse("unbound-native-turn").unwrap(),
            &admitted
        ),
        Err(AcpDispatchError::NotSent(_))
    ));
    assert!(
        !handle
            .lock()
            .unwrap()
            .transport
            .has_unresolved_work()
            .unwrap()
    );
    verify_task_target(&runtime, &target, opened.runtime_generation).unwrap();
    runtime
        .stop_idle_session(&router, &target, opened.runtime_generation)
        .unwrap();
}
