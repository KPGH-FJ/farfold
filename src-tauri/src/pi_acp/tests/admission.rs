use super::*;

#[test]
fn native_configuration_blocks_new_tasks_and_preserves_unknown_or_explicit_rejection() {
    use crate::turn_coordinator::{
        HostPiAcpTurnSubmitInput, TurnCoordinator, host_pi_acp_turn_submit_blocking,
    };
    for mode in ["accepted", "reject", "malformed", "disconnect"] {
        let fixture = Fixture::new("http://127.0.0.1:1/v1");
        let runtime = PiAcpRuntime::default();
        let controller = crate::session_controller::HostSessionController::default();
        let turns = TurnCoordinator::default();
        let interactions = crate::interaction_registry::InteractionRegistry::default();
        let router = RuntimeEventRouter::default();
        let mut response = fixture.response();
        response["configMode"] = json!(mode);
        let handle = fixture.start(&runtime, &router, response);
        let opened = open_native_session(
            &handle,
            &router,
            &fixture.store,
            None,
            "Pi configuration fixture",
        )
        .unwrap();
        let transport = handle.lock().unwrap().transport.clone();
        let target = fixture
            .store
            .session_open_target(&opened.farfold_session_id)
            .unwrap();
        let input = PiAcpConfigInput {
            farfold_session_id: opened.farfold_session_id.clone(),
            native_session_id: target.native_session_id.clone(),
            runtime_generation: opened.runtime_generation,
            config_id: PiAcpConfigId::ThoughtLevel,
            value: "high".into(),
        };
        for field in ["generation", "native", "choice", "model"] {
            let mut wrong = input.clone();
            match field {
                "generation" => wrong.runtime_generation += 1,
                "native" => {
                    wrong.native_session_id = NativeSessionId::parse("wrong-native").unwrap()
                }
                "choice" => wrong.value = "xhigh".into(),
                _ => {
                    wrong.config_id = PiAcpConfigId::Model;
                    wrong.value = "other/model".into();
                }
            }
            assert!(
                set_config_option(
                    &controller,
                    &runtime,
                    &fixture.store,
                    &router,
                    &turns,
                    wrong
                )
                .is_err()
            );
        }
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                set_config_option(
                    &controller,
                    &runtime,
                    &fixture.store,
                    &router,
                    &turns,
                    input.clone(),
                )
            });
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            while !handle.lock().unwrap().operations.is_pending() {
                if worker.is_finished() {
                    panic!(
                        "configuration returned before fixture dispatch: {:?}",
                        worker.join().unwrap()
                    );
                }
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(1));
            }
            assert_eq!(
                transport
                    .request("fixture/config_status", json!({}))
                    .unwrap()["held"],
                true
            );
            assert!(
                host_pi_acp_turn_submit_blocking(
                    &controller,
                    &fixture.store,
                    &runtime,
                    &router,
                    &turns,
                    &interactions,
                    HostPiAcpTurnSubmitInput {
                        farfold_session_id: input.farfold_session_id.clone(),
                        native_session_id: input.native_session_id.clone(),
                        runtime_generation: input.runtime_generation,
                        text: "Must not dispatch".into()
                    }
                )
                .is_err()
            );
            assert!(
                !turns
                    .has_active_session(&opened.farfold_session_id)
                    .unwrap()
            );
            if mode == "disconnect" {
                assert!(
                    runtime
                        .stop_idle_session(&router, &target, input.runtime_generation + 1)
                        .is_err()
                );
                runtime
                    .stop_idle_session(&router, &target, input.runtime_generation)
                    .unwrap();
                assert!(worker.join().unwrap().is_err());
                assert!(runtime.is_stopped().unwrap());
                return;
            }
            transport
                .request("fixture/release_config", json!({}))
                .unwrap();
            let result = worker.join().unwrap();
            assert_eq!(result.is_ok(), mode == "accepted", "{result:?}");
            assert_eq!(
                handle.lock().unwrap().operations.is_pending(),
                mode == "malformed"
            );
            assert_eq!(
                verify_task_target(&runtime, &target, input.runtime_generation).is_ok(),
                mode != "malformed"
            );
            if let Ok(status) = result {
                assert_eq!(
                    selected_config(&status.config_options, "thought_level"),
                    Some("high")
                );
            }
            let status = transport
                .request("fixture/config_status", json!({}))
                .unwrap();
            assert_eq!(status["configs"], 1);
            assert_eq!(status["prompts"], 0);
        });
        if mode == "disconnect" {
            continue;
        }
        let mut connection = handle.lock().unwrap();
        connection.config_options[0]["currentValue"] = json!("other/model");
        drop(connection);
        assert!(verify_prompt_target(&runtime, &target, input.runtime_generation).is_err());
        assert_eq!(
            verify_task_target(&runtime, &target, input.runtime_generation).is_ok(),
            mode != "malformed"
        );
        assert!(
            runtime
                .stop_idle_session(&router, &target, input.runtime_generation + 1)
                .is_err()
        );
        let stopped = runtime
            .stop_idle_session(&router, &target, input.runtime_generation)
            .unwrap();
        assert_eq!(stopped.last_error.is_some(), mode == "malformed");
        assert!(runtime.is_stopped().unwrap());
    }
}

#[test]
fn managed_empty_load_requires_original_receipt_and_never_creates_native_first_use() {
    for valid in [true, false] {
        let fixture = Fixture::stable("http://127.0.0.1:1/v1");
        let runtime = PiAcpRuntime::default();
        let router = RuntimeEventRouter::default();
        let mut response = fixture.response();
        let anchor = managed_pre_file_anchor(
            &fixture.binding,
            fixture.prepared.binding.as_ref().unwrap(),
            &fixture.prepared.profile_root,
            &fixture.cwd,
        )
        .unwrap();
        if valid {
            response["_meta"]["farfoldPi"]["managedPreFile"] = anchor.clone();
        }
        let handle = fixture.start(&runtime, &router, response);
        let result = open_native_session_request(
            &handle,
            &router,
            &fixture.store,
            Some(PiNativeSessionRequest::Identity(
                NativeSessionId::parse("native-fixture").unwrap(),
            )),
            "Empty managed",
        );
        assert_eq!(result.is_ok(), valid, "{:?}", result.as_ref().err());
        assert!(handle.lock().unwrap().native_first_use.is_none());
        assert!(!fixture.native().session_file.exists());
        let mut changed = fixture.binding.clone();
        changed.connection_id = ConnectionId::parse("other-connection").unwrap();
        assert_ne!(
            anchor,
            managed_pre_file_anchor(
                &changed,
                fixture.prepared.binding.as_ref().unwrap(),
                &fixture.prepared.profile_root,
                &fixture.cwd
            )
            .unwrap()
        );
        assert_ne!(
            anchor,
            managed_pre_file_anchor(
                &fixture.binding,
                fixture.prepared.binding.as_ref().unwrap(),
                &fixture.prepared.profile_root.join("other"),
                &fixture.cwd
            )
            .unwrap()
        );
        runtime.stop_for_shutdown().unwrap();
    }
}

#[test]
fn wrong_native_identity_or_model_never_registers_or_marks_provider_applied() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1");
    for pointer in [
        "/sessionId",
        "/_meta/farfoldPi/nativeSession/cwd",
        "/configOptions/0/currentValue",
    ] {
        let runtime = PiAcpRuntime::default();
        let router = RuntimeEventRouter::default();
        let mut response = fixture.response();
        *response.pointer_mut(pointer).unwrap() = json!("wrong");
        let handle = fixture.start(&runtime, &router, response);
        assert!(open_native_session(&handle, &router, &fixture.store, None, "Pi fixture").is_err());
        runtime.stop_locked(Some(&router)).unwrap();
        assert!(
            fixture
                .store
                .provider_projection_snapshot(&fixture.selection.provider_connection_id)
                .unwrap()
                .projections
                .is_empty()
        );
        assert!(serde_json::to_value(fixture.store.navigation_snapshot().unwrap()).unwrap()["sessionIndex"]["sessions"].as_array().unwrap().is_empty());
    }
}

#[test]
fn native_owned_profile_persists_without_a_managed_provider_or_implicit_grant() {
    let temp = tempfile::tempdir().unwrap();
    let store = HostStore::open(temp.path().join("host.sqlite3"));
    let profile = new_owned_profile(None).unwrap();
    store
        .register_runtime_owned_profile(&runtime_registration(&profile.binding, 1), &profile)
        .unwrap();
    let restored = saved_owned_profile(&store, &profile.binding).unwrap();
    assert_eq!(restored.profile_id, profile.profile_id);
    assert_eq!(restored.binding, profile.binding);
    assert!(restored.bootstrap_managed_provider.is_none());
    assert!(
        store
            .runtime_profile_provider_versions(&profile.binding)
            .unwrap()
            .is_empty()
    );
    let db = rusqlite::Connection::open(temp.path().join("host.sqlite3")).unwrap();
    db.pragma_update(None, "foreign_keys", true).unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM provider_connections", [], |row| row
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        0
    );
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM runtime_profile_provider_versions",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert!(
        db.execute(
            "UPDATE runtime_owned_profiles SET bootstrap_provider_connection_id = 'incomplete'",
            []
        )
        .is_err()
    );
    assert!(
        db.execute(
            "UPDATE runtime_owned_profiles SET layout = 'legacy_provider_bound_v1'",
            []
        )
        .is_err()
    );
    let mut invalid = profile.clone();
    invalid.layout = OwnedProfileLayout::LegacyProviderBoundV1;
    assert!(invalid.validate().is_err());
    assert!(
        store
            .register_runtime_owned_profile(&runtime_registration(&profile.binding, 2), &invalid)
            .is_err()
    );
    assert!(store.discard_unbound_owned_profile(&profile).unwrap());
    assert!(
        store
            .runtime_owned_profile(&profile.binding)
            .unwrap()
            .is_none()
    );
}

#[test]
fn unfinished_native_first_use_never_registers_or_restores_a_session() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1");
    let runtime = PiAcpRuntime::default();
    let router = RuntimeEventRouter::default();
    let handle = fixture.start(&runtime, &router, fixture.response());
    handle.lock().unwrap().managed_provider = None;
    for requested in [None, Some(fixture.native())] {
        assert!(
            open_native_session(
                &handle,
                &router,
                &fixture.store,
                requested.as_ref(),
                "Unfinished native first use"
            )
            .is_err()
        );
        assert!(handle.lock().unwrap().native.is_none());
    }
    assert!(
        serde_json::to_value(fixture.store.navigation_snapshot().unwrap()).unwrap()["sessionIndex"]
            ["sessions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    runtime.stop_for_shutdown().unwrap();
}

#[test]
fn owned_profile_authorization_is_exact_and_does_not_apply_or_verify_a_version() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1");
    let profile = new_owned_profile(fixture.selection.clone()).unwrap();
    let prepared = crate::acp_provider_profile::prepare_owned(
        fixture.temp.path(),
        &fixture.temp.path().join("pi-acp"),
        &fixture.store,
        &profile,
        true,
    )
    .unwrap();
    let original_file = fs::read(prepared.config_root.join("models.json")).unwrap();
    fixture
        .store
        .register_runtime_owned_profile(&runtime_registration(&profile.binding, 1), &profile)
        .unwrap();
    let versions = || {
        fixture
            .store
            .runtime_profile_provider_versions(&profile.binding)
            .unwrap()
    };
    assert_eq!(versions().len(), 1);
    assert_eq!(
        versions()[0].provider_config_version_id,
        fixture.selection.provider_config_version_id
    );
    let second = crate::acp_provider_profile::tests::save_fixture(
        fixture.temp.path(),
        &fixture.store,
        "http://127.0.0.1:1/v1",
        "openai-chat-completions",
        "changed-synthetic-key",
    );
    assert_eq!(
        versions().len(),
        1,
        "global Provider edits cannot silently authorize another profile version"
    );
    let mut wrong = profile.binding.clone();
    wrong.runtime_build_id = crate::host_ids::RuntimeBuildId::parse("wrong-build").unwrap();
    assert!(
        fixture
            .store
            .authorize_runtime_profile_provider_version(&wrong, &second)
            .is_err()
    );
    assert!(
        fixture
            .store
            .authorize_runtime_profile_provider_version(&profile.binding, &fixture.selection)
            .is_err(),
        "stale explicit selection is rejected without removing its existing grant"
    );
    fixture
        .store
        .authorize_runtime_profile_provider_version(&profile.binding, &second)
        .unwrap();
    fixture
        .store
        .authorize_runtime_profile_provider_version(&profile.binding, &second)
        .unwrap();
    assert_eq!(versions().len(), 2);
    assert_eq!(
        fs::read(prepared.config_root.join("models.json")).unwrap(),
        original_file
    );
    assert!(
        fixture
            .store
            .provider_projection_snapshot(&second.provider_connection_id)
            .unwrap()
            .projections
            .is_empty()
    );
    let restored = saved_owned_profile(&fixture.store, &profile.binding).unwrap();
    assert_eq!(
        restored
            .bootstrap_managed_provider
            .as_ref()
            .unwrap()
            .provider_config_version_id,
        fixture.selection.provider_config_version_id
    );
    rusqlite::Connection::open(fixture.temp.path().join("host.sqlite3")).unwrap()
            .execute("DELETE FROM runtime_profile_provider_versions WHERE profile_id = ?1 AND provider_config_version_id = ?2", rusqlite::params![profile.profile_id.as_str(), fixture.selection.provider_config_version_id.as_str()]).unwrap();
    assert!(saved_owned_profile(&fixture.store, &profile.binding).is_err());
    assert!(
        fixture
            .store
            .register_runtime_owned_profile(&runtime_registration(&profile.binding, 2), &profile)
            .is_err(),
        "a missing bootstrap grant must not be silently recreated"
    );
}

#[test]
fn owned_profile_creation_and_restore_keep_launch_identity_separate_from_provider_version() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1");
    let profile = new_owned_profile(fixture.selection.clone()).unwrap();
    let other = new_owned_profile(fixture.selection.clone()).unwrap();
    assert_ne!(profile.profile_id, other.profile_id);
    assert_ne!(profile.binding, other.binding);
    assert_ne!(profile.binding, fixture.binding);
    assert!(
        saved_owned_profile(&fixture.store, &profile.binding)
            .unwrap_err()
            .contains("reference is missing")
    );
    let prepared = crate::acp_provider_profile::prepare_owned(
        fixture.temp.path(),
        &fixture.temp.path().join("pi-acp"),
        &fixture.store,
        &profile,
        true,
    )
    .unwrap();
    assert_eq!(
        prepared.profile_root.file_name().unwrap(),
        profile.profile_id.as_str()
    );
    fixture
        .store
        .register_runtime_owned_profile(&runtime_registration(&profile.binding, 1), &profile)
        .unwrap();
    let second = crate::acp_provider_profile::tests::save_fixture(
        fixture.temp.path(),
        &fixture.store,
        "http://127.0.0.1:2/v1",
        "openai-chat-completions",
        "changed-fixture-key",
    );
    assert_ne!(
        second.provider_config_version_id,
        fixture.selection.provider_config_version_id
    );
    let reopened_store = HostStore::open(fixture.temp.path().join("host.sqlite3"));
    let restored = saved_owned_profile(&reopened_store, &profile.binding).unwrap();
    assert_eq!(
        restored
            .bootstrap_managed_provider
            .as_ref()
            .unwrap()
            .provider_config_version_id,
        fixture.selection.provider_config_version_id
    );
    let restored_files = crate::acp_provider_profile::prepare_owned(
        fixture.temp.path(),
        &fixture.temp.path().join("pi-acp"),
        &reopened_store,
        &restored,
        false,
    )
    .unwrap();
    assert_eq!(restored_files.profile_root, prepared.profile_root);
    assert_eq!(restored_files.binding, prepared.binding);
    assert!(serde_json::to_value(reopened_store.navigation_snapshot().unwrap()).unwrap()["sessionIndex"]["sessions"].as_array().unwrap().is_empty());
    let mut changed = profile.clone();
    changed.bootstrap_managed_provider = Some(second);
    assert!(
        reopened_store
            .register_runtime_owned_profile(&runtime_registration(&profile.binding, 2), &changed)
            .is_err()
    );
    assert_eq!(
        saved_owned_profile(&reopened_store, &profile.binding)
            .unwrap()
            .bootstrap_managed_provider
            .as_ref()
            .unwrap()
            .provider_config_version_id,
        fixture.selection.provider_config_version_id
    );
    assert!(
        reopened_store
            .discard_unbound_owned_profile(&profile)
            .unwrap()
    );
    assert!(saved_owned_profile(&reopened_store, &profile.binding).is_err());
}

#[test]
fn managed_version_apply_refreshes_and_selects_without_replacing_session_or_verifying_request() {
    let mut fixture = Fixture::stable("http://127.0.0.1:1/v1");
    let runtime = PiAcpRuntime::default();
    let router = RuntimeEventRouter::default();
    let controller = crate::session_controller::HostSessionController::default();
    let turns = crate::turn_coordinator::TurnCoordinator::default();
    let mut response = fixture.response();
    response["autoConfig"] = json!(true);
    response["emitConfigUpdate"] = json!(true);
    let handle = fixture.start(&runtime, &router, response);
    let opened =
        open_native_session(&handle, &router, &fixture.store, None, "Version apply").unwrap();
    let root = fixture.temp.path().canonicalize().unwrap();
    let selected = crate::acp_provider_profile::tests::save_fixture(
        &root,
        &fixture.store,
        "http://127.0.0.1:1/v1",
        "openai-chat-completions",
        "second-synthetic-key",
    );
    let input = PiAcpApplyProviderInput {
        farfold_session_id: opened.farfold_session_id.clone(),
        native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
        runtime_generation: opened.runtime_generation,
        provider: selected.clone(),
    };
    let original_config = fs::read(fixture.prepared.config_root.join("models.json")).unwrap();
    for mismatch in ["generation", "session"] {
        let mut stale = input.clone();
        if mismatch == "generation" {
            stale.runtime_generation += 1;
        } else {
            stale.native_session_id = NativeSessionId::parse("wrong-native").unwrap();
        }
        assert!(
            apply_provider(
                &controller,
                &runtime,
                &fixture.store,
                &router,
                &turns,
                &root,
                stale
            )
            .is_err()
        );
        assert_eq!(
            fs::read(fixture.prepared.config_root.join("models.json")).unwrap(),
            original_config
        );
        assert_eq!(
            fixture
                .store
                .runtime_profile_provider_versions(&fixture.binding)
                .unwrap()
                .len(),
            1
        );
    }
    let status = apply_provider(
        &controller,
        &runtime,
        &fixture.store,
        &router,
        &turns,
        &root,
        input,
    )
    .unwrap();
    let actual = status.managed_provider.as_ref().unwrap();
    assert_eq!(
        actual.provider_config_version_id,
        selected.provider_config_version_id
    );
    assert_ne!(
        actual.runtime_provider_id,
        fixture
            .prepared
            .binding
            .clone()
            .unwrap()
            .runtime_provider_id
    );
    assert_eq!(status.native_session, Some(fixture.native()));
    assert_eq!(status.generation, opened.runtime_generation);
    assert_eq!(
        handle.lock().unwrap().managed_provider,
        fixture.prepared.binding
    );
    assert_eq!(handle.lock().unwrap().managed_versions.len(), 2);
    let snapshot = fixture
        .store
        .provider_projection_snapshot(&selected.provider_connection_id)
        .unwrap();
    let applied = snapshot
        .projections
        .iter()
        .find(|projection| projection.config_version_id == selected.provider_config_version_id)
        .unwrap();
    assert_eq!(applied.apply_state, ProviderApplyState::Applied);
    assert_eq!(applied.request_state, ProviderRequestState::NotRequested);
    assert!(applied.request_verified_version_id.is_none());
    let target = fixture
        .store
        .session_open_target(&opened.farfold_session_id)
        .unwrap();
    let observation = capture_prompt_model(
        &runtime,
        &fixture.store,
        &router,
        &target,
        opened.runtime_generation,
    )
    .unwrap();
    assert_eq!(observation.source().managed_binding(), Some(actual));
    let transport = handle.lock().unwrap().transport.clone();
    let counts = transport
        .request("fixture/config_status", json!({}))
        .unwrap();
    assert_eq!(counts["refreshes"], 1);
    assert_eq!(counts["configs"], 1);
    assert_eq!(
        transport
            .request("fixture/prompt_calls", json!({}))
            .unwrap(),
        0
    );
    runtime.stop_for_shutdown().unwrap();

    let native = fixture.native();
    fs::write(
        &native.session_file,
        json!({"type":"session","id":native.session_id,"cwd":native.cwd}).to_string(),
    )
    .unwrap();
    let profile = fixture
        .store
        .runtime_owned_profile(&fixture.binding)
        .unwrap()
        .unwrap();
    fixture.prepared = crate::acp_provider_profile::prepare_owned(
        &root,
        &root.join("pi-acp"),
        &fixture.store,
        &profile,
        false,
    )
    .unwrap();
    let mut response = fixture.response();
    response["configOptions"][0]["currentValue"] = json!(actual.runtime_model_id);
    let handle = fixture.start(&runtime, &router, response);
    let restored = open_native_session(
        &handle,
        &router,
        &fixture.store,
        Some(&native),
        "Version apply",
    )
    .unwrap();
    assert_eq!(restored.farfold_session_id, opened.farfold_session_id);
    assert_eq!(
        current_status(&runtime, &router)
            .unwrap()
            .managed_provider
            .as_ref(),
        Some(actual)
    );
    runtime.stop_for_shutdown().unwrap();
}

#[test]
fn managed_version_apply_unknown_keeps_original_source_and_blocks_tasks_without_resend() {
    for mode in ["wrong-refresh", "malformed", "reject"] {
        let fixture = Fixture::stable("http://127.0.0.1:1/v1");
        let runtime = PiAcpRuntime::default();
        let router = RuntimeEventRouter::default();
        let controller = crate::session_controller::HostSessionController::default();
        let turns = crate::turn_coordinator::TurnCoordinator::default();
        let mut response = fixture.response();
        response["autoConfig"] = json!(true);
        response["emitConfigUpdate"] = json!(true);
        if mode == "wrong-refresh" {
            response["refreshMode"] = json!("wrong");
        } else {
            response["configMode"] = json!(mode);
        }
        let handle = fixture.start(&runtime, &router, response);
        let opened =
            open_native_session(&handle, &router, &fixture.store, None, "Unknown apply").unwrap();
        let original = &fixture.prepared.binding.clone().unwrap();
        fixture
            .store
            .record_provider_target_projection(&ProviderTargetProjectionInput {
                provider_connection_id: original.provider_connection_id.clone(),
                config_version_id: original.provider_config_version_id.clone(),
                runtime_product_id: fixture.binding.product_id.clone(),
                installation_id: fixture.binding.installation_id.clone(),
                runtime_connection_id: fixture.binding.connection_id.clone(),
                runtime_provider_id: original.runtime_provider_id.clone(),
                runtime_model_id: original.runtime_model_id.clone(),
                save_state: ProviderSaveState::Saved,
                apply_state: ProviderApplyState::Applied,
                request_state: ProviderRequestState::VerifiedSuccess,
                request_verified_version_id: Some(original.provider_config_version_id.clone()),
                active_task_policy: ProviderActiveTaskPolicy::CurrentTaskKeepsBoundConfig,
                detail: None,
            })
            .unwrap();
        let verified_original = serde_json::to_value(
            fixture
                .store
                .provider_projection_snapshot(&original.provider_connection_id)
                .unwrap(),
        )
        .unwrap();
        let root = fixture.temp.path().canonicalize().unwrap();
        let selected = crate::acp_provider_profile::tests::save_fixture(
            &root,
            &fixture.store,
            "http://127.0.0.1:2/v1",
            "openai-chat-completions",
            "second-synthetic-key",
        );
        assert_ne!(
            selected.provider_connection_id,
            original.provider_connection_id
        );
        let input = PiAcpApplyProviderInput {
            farfold_session_id: opened.farfold_session_id.clone(),
            native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
            runtime_generation: opened.runtime_generation,
            provider: selected.clone(),
        };
        let projection_before = serde_json::to_value(
            fixture
                .store
                .provider_projection_snapshot(&selected.provider_connection_id)
                .unwrap(),
        )
        .unwrap();
        assert!(
            apply_provider(
                &controller,
                &runtime,
                &fixture.store,
                &router,
                &turns,
                &root,
                input.clone()
            )
            .is_err()
        );
        assert!(handle.lock().unwrap().operations.is_config_pending());
        let status = current_status(&runtime, &router).unwrap();
        assert_eq!(status.configuration_state, PiConfigurationState::Unknown);
        assert!(status.managed_provider.is_none());
        assert!(status.model_source.is_none());
        assert_eq!(
            status
                .last_confirmed_model_source
                .as_ref()
                .and_then(PiModelSource::managed_binding),
            Some(&fixture.prepared.binding.clone().unwrap())
        );
        assert!(status.last_error.is_some());
        assert_eq!(
            serde_json::to_value(
                fixture
                    .store
                    .provider_projection_snapshot(&original.provider_connection_id)
                    .unwrap()
            )
            .unwrap(),
            verified_original
        );
        let target = fixture
            .store
            .session_open_target(&opened.farfold_session_id)
            .unwrap();
        assert!(
            capture_prompt_model(
                &runtime,
                &fixture.store,
                &router,
                &target,
                opened.runtime_generation
            )
            .is_err()
        );
        assert!(
            apply_provider(
                &controller,
                &runtime,
                &fixture.store,
                &router,
                &turns,
                &root,
                input
            )
            .is_err()
        );
        let transport = handle.lock().unwrap().transport.clone();
        let counts = transport
            .request("fixture/config_status", json!({}))
            .unwrap();
        assert_eq!(counts["refreshes"], 1);
        assert_eq!(
            counts["configs"],
            if mode == "wrong-refresh" { 0 } else { 1 }
        );
        assert_eq!(
            transport
                .request("fixture/prompt_calls", json!({}))
                .unwrap(),
            0
        );
        assert_eq!(
            serde_json::to_value(
                fixture
                    .store
                    .provider_projection_snapshot(&selected.provider_connection_id)
                    .unwrap()
            )
            .unwrap(),
            projection_before
        );
        runtime
            .stop_idle_session(&router, &target, opened.runtime_generation)
            .unwrap();
    }
}

#[test]
fn managed_version_apply_can_be_disconnected_while_select_is_pending() {
    let fixture = Fixture::stable("http://127.0.0.1:1/v1");
    let runtime = PiAcpRuntime::default();
    let router = RuntimeEventRouter::default();
    let controller = crate::session_controller::HostSessionController::default();
    let turns = crate::turn_coordinator::TurnCoordinator::default();
    let mut response = fixture.response();
    response["emitConfigUpdate"] = json!(true);
    response["holdFirstState"] = json!(true);
    let handle = fixture.start(&runtime, &router, response);
    let opened = open_native_session(&handle, &router, &fixture.store, None, "Held apply").unwrap();
    let root = fixture.temp.path().canonicalize().unwrap();
    let selected = crate::acp_provider_profile::tests::save_fixture(
        &root,
        &fixture.store,
        "http://127.0.0.1:2/v1",
        "openai-chat-completions",
        "second-synthetic-key",
    );
    let input = PiAcpApplyProviderInput {
        farfold_session_id: opened.farfold_session_id.clone(),
        native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
        runtime_generation: opened.runtime_generation,
        provider: selected,
    };
    let target = fixture
        .store
        .session_open_target(&opened.farfold_session_id)
        .unwrap();
    let transport = handle.lock().unwrap().transport.clone();
    let held_read = transport
        .begin_request_unbounded(
            "_pi/workspace",
            json!({"sessionId":opened.native_session_id,"section":"state"}),
        )
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while transport
        .request("fixture/read_pending", json!({}))
        .unwrap()["pending"]
        != true
    {
        assert!(std::time::Instant::now() < deadline);
    }
    let rejected = apply_provider(
        &controller,
        &runtime,
        &fixture.store,
        &router,
        &turns,
        &root,
        input.clone(),
    )
    .unwrap_err();
    assert!(rejected.contains("ACP 仍有活动或未确认请求"));
    assert!(!handle.lock().unwrap().operations.is_pending());
    transport
        .request("fixture/release_read", json!({}))
        .unwrap();
    held_read.wait_timeout(REQUEST_TIMEOUT).unwrap();
    std::thread::scope(|scope| {
        let worker = scope.spawn(|| {
            apply_provider(
                &controller,
                &runtime,
                &fixture.store,
                &router,
                &turns,
                &root,
                input,
            )
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        // Do not let fixture polling create unresolved work before admission.
        while !handle.lock().unwrap().operations.is_config_pending() {
            if worker.is_finished() {
                panic!(
                    "apply returned before configuration admission: {:?}",
                    worker.join().unwrap()
                );
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        }
        while transport
            .request("fixture/config_status", json!({}))
            .unwrap()["held"]
            != true
        {
            assert!(
                !worker.is_finished(),
                "apply must reach held native selection"
            );
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        }
        let status = current_status(&runtime, &router).unwrap();
        assert_eq!(status.configuration_state, PiConfigurationState::Changing);
        assert!(status.model_source.is_none());
        assert_eq!(
            status
                .last_confirmed_model_source
                .as_ref()
                .and_then(PiModelSource::managed_binding),
            Some(&fixture.prepared.binding.clone().unwrap())
        );
        assert!(verify_prompt_target(&runtime, &target, opened.runtime_generation).is_err());
        controller
            .exclusive(|| runtime.stop_idle_session(&router, &target, opened.runtime_generation))
            .unwrap();
        assert!(worker.join().unwrap().is_err());
    });
    assert!(runtime.is_stopped().unwrap());
    assert!(!transport.is_running().unwrap());
    assert!(
        !turns
            .has_active_session(&opened.farfold_session_id)
            .unwrap()
    );
}

#[test]
fn managed_profile_drift_blocks_prompt_and_provider_verification_but_not_stop() {
    let mut fixture = Fixture::new("http://127.0.0.1:1/v1");
    let profile = new_owned_profile(fixture.selection.clone()).unwrap();
    fixture.binding = profile.binding.clone();
    fixture.prepared = crate::acp_provider_profile::prepare_owned(
        fixture.temp.path(),
        &fixture.temp.path().join("pi-acp"),
        &fixture.store,
        &profile,
        true,
    )
    .unwrap();
    fixture
        .store
        .register_runtime_owned_profile(&runtime_registration(&fixture.binding, 1), &profile)
        .unwrap();
    let runtime = PiAcpRuntime::default();
    let router = RuntimeEventRouter::default();
    let handle = fixture.start(&runtime, &router, fixture.response());
    let opened =
        open_native_session(&handle, &router, &fixture.store, None, "Stable fixture").unwrap();
    let target = fixture
        .store
        .session_open_target(&opened.farfold_session_id)
        .unwrap();
    verify_prompt_target(&runtime, &target, opened.runtime_generation).unwrap();
    verify_provider_receipt_target(&runtime, &target, opened.runtime_generation).unwrap();
    let path = fixture.prepared.config_root.join("models.json");
    let original = fs::read(&path).unwrap();
    let mut config: Value = serde_json::from_slice(&original).unwrap();
    config["providers"][&fixture
        .prepared
        .binding
        .clone()
        .unwrap()
        .runtime_provider_id]["apiKey"] = json!("changed-fixture-secret");
    fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
    assert!(verify_prompt_target(&runtime, &target, opened.runtime_generation).is_err());
    assert!(verify_provider_receipt_target(&runtime, &target, opened.runtime_generation).is_err());
    verify_task_target(&runtime, &target, opened.runtime_generation).unwrap();
    fs::write(&path, &original).unwrap();
    let auth = fixture.prepared.config_root.join("auth.json");
    fs::write(auth, serde_json::to_vec(&json!({fixture.prepared.binding.clone().unwrap().runtime_provider_id.clone():{"type":"api_key","key":"shadow-fixture-secret"}})).unwrap()).unwrap();
    assert!(verify_prompt_target(&runtime, &target, opened.runtime_generation).is_err());
    assert!(verify_provider_receipt_target(&runtime, &target, opened.runtime_generation).is_err());
    assert!(
        !runtime
            .stop_idle_session(&router, &target, opened.runtime_generation)
            .unwrap()
            .running
    );
}

#[test]
fn owned_profile_cleanup_preserves_registered_session_even_after_later_failure() {
    let mut fixture = Fixture::new("http://127.0.0.1:1/v1");
    let profile = new_owned_profile(fixture.selection.clone()).unwrap();
    fixture.binding = profile.binding.clone();
    fixture.prepared = crate::acp_provider_profile::prepare_owned(
        fixture.temp.path(),
        &fixture.temp.path().join("pi-acp"),
        &fixture.store,
        &profile,
        true,
    )
    .unwrap();
    fixture
        .store
        .register_runtime_owned_profile(&runtime_registration(&fixture.binding, 1), &profile)
        .unwrap();
    let runtime = PiAcpRuntime::default();
    let router = RuntimeEventRouter::default();
    let handle = fixture.start(&runtime, &router, fixture.response());
    let opened =
        open_native_session(&handle, &router, &fixture.store, None, "Stable fixture").unwrap();
    runtime.stop_for_shutdown().unwrap();
    assert!(
        !fixture
            .store
            .discard_unbound_owned_profile(&profile)
            .unwrap()
    );
    assert_eq!(
        fixture
            .store
            .session_open_target(&opened.farfold_session_id)
            .unwrap()
            .binding(),
        profile.binding
    );
    assert_eq!(
        saved_owned_profile(&fixture.store, &profile.binding)
            .unwrap()
            .profile_id,
        profile.profile_id
    );
}

#[test]
fn owned_profile_missing_or_symlinked_directory_is_not_recreated_or_followed() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1");
    let profile = new_owned_profile(fixture.selection.clone()).unwrap();
    let acp_root = fixture.temp.path().join("pi-acp");
    let root = acp_root.join("profiles").join(profile.profile_id.as_str());
    assert!(
        crate::acp_provider_profile::prepare_owned(
            fixture.temp.path(),
            &acp_root,
            &fixture.store,
            &profile,
            false
        )
        .is_err()
    );
    assert!(!root.exists());
    std::os::unix::fs::symlink(&fixture.prepared.profile_root, &root).unwrap();
    assert!(
        crate::acp_provider_profile::prepare_owned(
            fixture.temp.path(),
            &acp_root,
            &fixture.store,
            &profile,
            false
        )
        .is_err()
    );
    assert!(
        crate::acp_provider_profile::prepare_owned(
            fixture.temp.path(),
            &acp_root,
            &fixture.store,
            &profile,
            true
        )
        .is_err()
    );
}

#[test]
fn owned_profile_corrupt_existing_reference_never_falls_back_to_provider_search() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1");
    let legacy = saved_owned_profile(&fixture.store, &fixture.binding).unwrap();
    fixture
        .store
        .register_runtime_owned_profile(&runtime_registration(&fixture.binding, 1), &legacy)
        .unwrap();
    let db = rusqlite::Connection::open(fixture.temp.path().join("host.sqlite3")).unwrap();
    db.execute(
        "UPDATE runtime_owned_profiles SET layout = 'stable_v1' WHERE connection_id = ?1",
        [fixture.binding.connection_id.as_str()],
    )
    .unwrap();
    assert!(
        saved_owned_profile(&fixture.store, &fixture.binding)
            .unwrap_err()
            .contains("bootstrap authorization is missing")
    );
    db.execute(
        "UPDATE runtime_owned_profiles SET profile_id = '../outside' WHERE connection_id = ?1",
        [fixture.binding.connection_id.as_str()],
    )
    .unwrap();
    assert!(saved_owned_profile(&fixture.store, &fixture.binding).is_err());
    let mut wrong_build = fixture.binding.clone();
    wrong_build.runtime_build_id = crate::host_ids::RuntimeBuildId::parse("wrong-build").unwrap();
    assert!(fixture.store.runtime_owned_profile(&wrong_build).is_err());
}

#[test]
fn fixture_cold_load_keeps_registered_identity_and_exact_historical_provider_version() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1");
    let runtime = PiAcpRuntime::default();
    let router = RuntimeEventRouter::default();
    let handle = fixture.start(&runtime, &router, fixture.response());
    let first = open_native_session(&handle, &router, &fixture.store, None, "Pi fixture").unwrap();
    let native = fixture.native();
    // A protocol fixture header, not evidence of real Agent history persistence.
    fs::write(
        &native.session_file,
        format!(
            "{}\n",
            json!({"type":"session","id":native.session_id,"cwd":native.cwd})
        ),
    )
    .unwrap();
    assert_eq!(
        register_observation(&fixture.store, &handle.lock().unwrap(), "Pi fixture").unwrap(),
        first.farfold_session_id
    );
    let target = fixture
        .store
        .session_open_target(&first.farfold_session_id)
        .unwrap();
    assert!(target.blockers().is_empty());
    runtime
        .stop_idle_session(&router, &target, first.runtime_generation)
        .unwrap();
    let second_selection = crate::acp_provider_profile::tests::save_fixture(
        fixture.temp.path(),
        &fixture.store,
        "http://127.0.0.1:2/v1",
        "openai-chat-completions",
        "changed-fixture-key",
    );
    assert_ne!(managed_binding(&second_selection).unwrap(), fixture.binding);
    let saved = saved_provider(&fixture.store, &target.binding()).unwrap();
    assert_eq!(
        saved.provider_config_version_id,
        fixture.selection.provider_config_version_id
    );
    let imported = saved_owned_profile(&fixture.store, &target.binding()).unwrap();
    assert_eq!(imported.layout, OwnedProfileLayout::LegacyProviderBoundV1);
    let files = crate::acp_provider_profile::prepare_owned(
        fixture.temp.path(),
        &fixture.temp.path().join("pi-acp"),
        &fixture.store,
        &imported,
        false,
    )
    .unwrap();
    assert_eq!(
        files.profile_root.canonicalize().unwrap(),
        fixture.prepared.profile_root.canonicalize().unwrap()
    );
    native_descriptor(
        &fixture.response(),
        Some(&native),
        &fixture.cwd,
        &files.profile_root.join("sessions"),
    )
    .unwrap();
    fixture
        .store
        .register_runtime_owned_profile(
            &runtime_registration(&fixture.binding, crate::host_store::now_millis()),
            &imported,
        )
        .unwrap();
    assert_eq!(
        saved_owned_profile(&fixture.store, &target.binding())
            .unwrap()
            .profile_id,
        imported.profile_id
    );
    let handle = fixture.start(&runtime, &router, fixture.response());
    let restored = open_native_session(
        &handle,
        &router,
        &fixture.store,
        Some(&native),
        &target.title,
    )
    .unwrap();
    assert_eq!(first.farfold_session_id, restored.farfold_session_id);
    assert_eq!(first.native_session_id, restored.native_session_id);
    assert!(restored.runtime_generation > first.runtime_generation);
    runtime.stop_for_shutdown().unwrap();
}
