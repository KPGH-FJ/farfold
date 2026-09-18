use super::*;

#[test]
#[ignore = "fixed Pi/Node, isolated empty managed session, trust restart and control read; zero model requests"]
fn fixed_pi_managed_empty_trust_restart_and_session_control_are_model_free() {
    let server = crate::opencode_acp::tests::ChatFixtureServer::start();
    let fixture = Fixture::stable(&format!("http://127.0.0.1:{}/v1", server.port));
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let node = manifest.join("capability-bridge/runtime/node");
    let pi = manifest.join("resources/pi-runtime/pi");
    assert_eq!(file_sha256(&node).unwrap(), NODE_SHA256);
    crate::runtime_registry::verify_managed_binary_path(pi.clone(), PI_ACP_RUNTIME).unwrap();
    let runtime = PiAcpRuntime::default();
    let router = RuntimeEventRouter::default();
    let start = |trust| {
        let mut command = launch_command(
            &node,
            &manifest.join("pi-acp-adapter/dist/index.js"),
            &pi,
            &fixture.cwd,
            &fixture.prepared,
            Some(trust),
        )
        .unwrap();
        start_connection(
            &runtime,
            &router,
            fixture.binding.clone(),
            &fixture.cwd,
            &fixture.prepared,
            &mut command,
        )
        .unwrap()
    };
    let handle = start("ignore");
    let first =
        open_native_session(&handle, &router, &fixture.store, None, "Empty managed").unwrap();
    let native = handle.lock().unwrap().native.clone().unwrap();
    assert!(!native.session_file.exists());
    runtime.stop_for_shutdown().unwrap();
    let handle = start("approve");
    let restored = open_native_session_request(
        &handle,
        &router,
        &fixture.store,
        Some(PiNativeSessionRequest::Identity(
            NativeSessionId::parse(&first.native_session_id).unwrap(),
        )),
        "Empty managed",
    )
    .unwrap();
    assert_eq!(restored.farfold_session_id, first.farfold_session_id);
    assert_eq!(restored.native_session_id, first.native_session_id);
    assert!(restored.runtime_generation > first.runtime_generation);
    assert!(
        !handle
            .lock()
            .unwrap()
            .native
            .as_ref()
            .unwrap()
            .session_file
            .exists()
    );
    read_workspace(
        &runtime,
        &fixture.store,
        &router,
        PiAcpWorkspaceInput {
            farfold_session_id: first.farfold_session_id.clone(),
            native_session_id: NativeSessionId::parse(&first.native_session_id).unwrap(),
            runtime_generation: restored.runtime_generation,
            section: PiWorkspaceSection::SessionCommand,
        },
    )
    .unwrap();
    let projection = fixture
        .store
        .provider_projection_snapshot(&fixture.selection.provider_connection_id)
        .unwrap();
    assert_eq!(
        projection.projections[0].request_state,
        ProviderRequestState::NotRequested
    );
    assert!(server.captured.lock().unwrap().is_empty());
    runtime.stop_for_shutdown().unwrap();
}

#[test]
#[ignore = "fixed Pi/Node, isolated multi-version profile and one local simulated model request; no accounts"]
fn fixed_pi_managed_version_apply_request_and_cold_restore() {
    use crate::turn_coordinator::{
        HostNativeTurnSubmission, HostPiAcpTurnSubmitInput, TurnCoordinator,
        host_pi_acp_turn_submit_blocking,
    };
    let server = crate::opencode_acp::tests::ChatFixtureServer::start();
    let endpoint = format!("http://127.0.0.1:{}/v1", server.port);
    let mut fixture = Fixture::stable(&endpoint);
    let root = fixture.temp.path().canonicalize().unwrap();
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let node = manifest.join("capability-bridge/runtime/node");
    let pi = manifest.join("resources/pi-runtime/pi");
    assert_eq!(file_sha256(&node).unwrap(), NODE_SHA256);
    crate::runtime_registry::verify_managed_binary_path(pi.clone(), PI_ACP_RUNTIME).unwrap();
    let runtime = PiAcpRuntime::default();
    let turns = TurnCoordinator::default();
    turns.attach_host_store(fixture.store.clone()).unwrap();
    let interactions = crate::interaction_registry::InteractionRegistry::default();
    let router = RuntimeEventRouter::with_capacity_and_all_observers(
        256,
        None,
        Some(interactions.clone()),
        Some(turns.clone()),
    );
    let controller = crate::session_controller::HostSessionController::default();
    let start = |prepared: &PreparedPiProfile| {
        let mut command = launch_command(
            &node,
            &manifest.join("pi-acp-adapter/dist/index.js"),
            &pi,
            &fixture.cwd,
            prepared,
            Some("ignore"),
        )
        .unwrap();
        start_connection(
            &runtime,
            &router,
            fixture.binding.clone(),
            &fixture.cwd,
            prepared,
            &mut command,
        )
        .unwrap()
    };
    let handle = start(&fixture.prepared);
    let opened = open_native_session(
        &handle,
        &router,
        &fixture.store,
        None,
        "Multi-version local fixture",
    )
    .unwrap();
    let original_native = handle.lock().unwrap().native.clone().unwrap();
    let selected = crate::acp_provider_profile::tests::save_fixture(
        &root,
        &fixture.store,
        &endpoint,
        "openai-chat-completions",
        "second-version-synthetic-key",
    );
    let outcome = apply_provider(
        &controller,
        &runtime,
        &fixture.store,
        &router,
        &turns,
        &root,
        PiAcpApplyProviderInput {
            farfold_session_id: opened.farfold_session_id.clone(),
            native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
            runtime_generation: opened.runtime_generation,
            provider: selected.clone(),
        },
    );
    if let Err(error) = &outcome {
        runtime.stop_for_shutdown().unwrap();
        panic!("fixed Pi managed apply: {error}");
    }
    let applied = outcome.unwrap();
    assert_eq!(applied.native_session.as_ref(), Some(&original_native));
    assert_eq!(applied.generation, opened.runtime_generation);
    assert_eq!(
        applied
            .managed_provider
            .as_ref()
            .unwrap()
            .provider_config_version_id,
        selected.provider_config_version_id
    );
    assert!(server.captured.lock().unwrap().is_empty());
    assert_eq!(
        fixture
            .store
            .provider_projection_snapshot(&selected.provider_connection_id)
            .unwrap()
            .projections[0]
            .request_state,
        ProviderRequestState::NotRequested
    );
    let task = host_pi_acp_turn_submit_blocking(
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
            text: "Reply with ok only. Isolated local protocol test.".into(),
        },
    );
    if !matches!(task, Ok(HostNativeTurnSubmission::Accepted { .. })) {
        runtime.stop_for_shutdown().unwrap();
        panic!("fixed Pi version task: {task:?}");
    }
    let snapshot = fixture
        .store
        .provider_projection_snapshot(&selected.provider_connection_id)
        .unwrap();
    assert_eq!(
        snapshot.projections[0].request_verified_version_id.as_ref(),
        Some(&selected.provider_config_version_id)
    );
    let history = fs::read(&original_native.session_file).unwrap();
    {
        let requests = server.captured.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].1, "Bearer second-version-synthetic-key");
        let roles = requests[0].2["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|message| message["role"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(roles, ["system", "user"]);
        assert!(!roles.contains(&"developer"));
    }
    runtime.stop_for_shutdown().unwrap();
    let profile = saved_owned_profile(&fixture.store, &fixture.binding).unwrap();
    fixture.prepared = crate::acp_provider_profile::prepare_owned(
        &root,
        &root.join("pi-acp"),
        &fixture.store,
        &profile,
        false,
    )
    .unwrap();
    let handle = start(&fixture.prepared);
    let restored = open_native_session(
        &handle,
        &router,
        &fixture.store,
        Some(&original_native),
        "Multi-version local fixture",
    );
    let status = current_status(&runtime, &router).unwrap();
    runtime.stop_for_shutdown().unwrap();
    let restored = restored.unwrap();
    assert_eq!(restored.farfold_session_id, opened.farfold_session_id);
    assert_eq!(status.managed_provider, applied.managed_provider);
    assert!(
        fs::read(&original_native.session_file)
            .unwrap()
            .starts_with(&history)
    );
    assert_eq!(server.captured.lock().unwrap().len(), 1);
}

#[test]
#[ignore = "fixed Pi/SDK, isolated native model selection, one local simulated request and original cold restore"]
fn fixed_pi_explicit_native_model_request_and_original_cold_restore() {
    use crate::turn_coordinator::{
        HostNativeTurnSubmission, HostPiAcpTurnSubmitInput, TurnCoordinator,
        host_pi_acp_turn_submit_blocking,
    };
    let server = crate::opencode_acp::tests::ChatFixtureServer::start();
    let mut fixture = Fixture::stable(&format!("http://127.0.0.1:{}/v1", server.port));
    let root = fixture.temp.path().canonicalize().unwrap();
    let profile = saved_owned_profile(&fixture.store, &fixture.binding).unwrap();
    let models_path = fixture.prepared.config_root.join("models.json");
    let mut models: Value = serde_json::from_slice(&fs::read(&models_path).unwrap()).unwrap();
    let mut native = models["providers"][&fixture
        .prepared
        .binding
        .clone()
        .unwrap()
        .runtime_provider_id]
        .clone();
    native["apiKey"] = json!("synthetic-native-model-key");
    models["providers"]["native-local-fixture"] = native;
    fs::write(&models_path, serde_json::to_vec(&models).unwrap()).unwrap();
    fixture.prepared = crate::acp_provider_profile::prepare_owned(
        &root,
        &root.join("pi-acp"),
        &fixture.store,
        &profile,
        false,
    )
    .unwrap();
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let node = manifest.join("resources/pi-capabilities/runtime/node");
    let pi = manifest.join("resources/pi-runtime/pi");
    let adapter = root.join("isolated-adapter/index.mjs");
    fs::create_dir_all(adapter.parent().unwrap()).unwrap();
    fs::copy(manifest.join("pi-acp-adapter/dist/index.js"), &adapter).unwrap();
    assert_eq!(file_sha256(&node).unwrap(), NODE_SHA256);
    crate::runtime_registry::verify_managed_binary_path(pi.clone(), PI_ACP_RUNTIME).unwrap();
    let runtime = PiAcpRuntime::default();
    let turns = TurnCoordinator::default();
    turns.attach_host_store(fixture.store.clone()).unwrap();
    let router =
        RuntimeEventRouter::with_capacity_and_all_observers(256, None, None, Some(turns.clone()));
    let controller = crate::session_controller::HostSessionController::default();
    let start = |prepared: &PreparedPiProfile| {
        let mut command =
            launch_command(&node, &adapter, &pi, &fixture.cwd, prepared, Some("ignore"))?;
        start_connection(
            &runtime,
            &router,
            fixture.binding.clone(),
            &fixture.cwd,
            prepared,
            &mut command,
        )
    };
    let result = (|| -> Result<(), String> {
        let handle = start(&fixture.prepared)?;
        let opened = open_native_session(
            &handle,
            &router,
            &fixture.store,
            None,
            "Native model local fixture",
        )?;
        let original = handle.lock().unwrap().native.clone().unwrap();
        let projection = serde_json::to_value(
            fixture
                .store
                .provider_projection_snapshot(&fixture.selection.provider_connection_id)?,
        )
        .unwrap();
        let native_id = fixture
            .prepared
            .binding
            .as_ref()
            .unwrap()
            .runtime_model_id
            .split_once('/')
            .unwrap()
            .1;
        let selector = format!("native-local-fixture/{native_id}");
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
                value: selector.clone(),
            },
        )?;
        assert!(selected.native_admission_ready);
        assert!(selected.managed_provider.is_none());
        assert_eq!(selected.native_session.as_ref(), Some(&original));
        assert!(server.captured.lock().unwrap().is_empty());
        let task = host_pi_acp_turn_submit_blocking(
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
                text: "Reply with ok only. Isolated local native source test.".into(),
            },
        )?;
        let HostNativeTurnSubmission::Accepted { submission } = task else {
            return Err(format!("native task outcome: {task:?}"));
        };
        let db = rusqlite::Connection::open_with_flags(
            root.join("host.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let source: (String, String, Option<String>) = db.query_row("SELECT source_kind, runtime_model_id, provider_config_version_id FROM turn_provider_bindings WHERE host_turn_id = ?1",
                [submission.turn_id.as_str()], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
        assert_eq!(source, ("native_observation".into(), selector, None));
        assert_eq!(
            serde_json::to_value(
                fixture
                    .store
                    .provider_projection_snapshot(&fixture.selection.provider_connection_id)?
            )
            .unwrap(),
            projection
        );
        {
            let requests = server.captured.lock().unwrap();
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].1, "Bearer synthetic-native-model-key");
        }
        let history = fs::read(&original.session_file).unwrap();
        runtime.stop_for_shutdown()?;
        let prepared = crate::acp_provider_profile::prepare_owned(
            &root,
            &root.join("pi-acp"),
            &fixture.store,
            &profile,
            false,
        )?;
        let handle = start(&prepared)?;
        let restored = open_native_session(
            &handle,
            &router,
            &fixture.store,
            Some(&original),
            "Native model local fixture",
        )?;
        let status = current_status(&runtime, &router)?;
        assert_eq!(restored.farfold_session_id, opened.farfold_session_id);
        assert_eq!(restored.native_session_id, opened.native_session_id);
        assert!(restored.runtime_generation > opened.runtime_generation);
        assert_eq!(status.model_source, selected.model_source);
        assert!(status.native_admission_ready);
        let target = fixture
            .store
            .session_open_target(&opened.farfold_session_id)?;
        let observation = capture_prompt_model(
            &runtime,
            &fixture.store,
            &router,
            &target,
            restored.runtime_generation,
        )?;
        assert_eq!(Some(observation.source()), status.model_source.as_ref());
        assert!(
            fs::read(&original.session_file)
                .unwrap()
                .starts_with(&history)
        );
        assert_eq!(server.captured.lock().unwrap().len(), 1);
        Ok(())
    })();
    runtime.stop_for_shutdown().unwrap();
    result.unwrap();
}

#[test]
#[ignore = "fixed Pi/Node, isolated managed profile and local simulated HTTP model only; no account access"]
fn fixed_pi_native_request_verifies_bound_provider_and_restores_persisted_history() {
    use crate::turn_coordinator::{
        HostNativeTurnSubmission, HostPiAcpTurnSubmitInput, TurnCoordinator,
        host_pi_acp_turn_submit_blocking,
    };
    let server = crate::opencode_acp::tests::ChatFixtureServer::start();
    let mut fixture = Fixture::new(&format!("http://127.0.0.1:{}/v1", server.port));
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
        .register_runtime_owned_profile(
            &runtime_registration(&fixture.binding, crate::host_store::now_millis()),
            &profile,
        )
        .unwrap();
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let node = manifest.join("capability-bridge/runtime/node");
    let pi = manifest.join("resources/pi-runtime/pi");
    assert_eq!(file_sha256(&node).unwrap(), NODE_SHA256);
    crate::runtime_registry::verify_managed_binary_path(pi.clone(), PI_ACP_RUNTIME).unwrap();
    let runtime = PiAcpRuntime::default();
    let coordinator = TurnCoordinator::default();
    coordinator
        .attach_host_store(fixture.store.clone())
        .unwrap();
    let interactions = crate::interaction_registry::InteractionRegistry::default();
    let router = RuntimeEventRouter::with_capacity_and_all_observers(
        256,
        None,
        Some(interactions.clone()),
        Some(coordinator.clone()),
    );
    let start = || {
        let mut command = launch_command(
            &node,
            &manifest.join("pi-acp-adapter/dist/index.js"),
            &pi,
            &fixture.cwd,
            &fixture.prepared,
            Some("ignore"),
        )
        .unwrap();
        start_connection(
            &runtime,
            &router,
            fixture.binding.clone(),
            &fixture.cwd,
            &fixture.prepared,
            &mut command,
        )
        .unwrap()
    };
    let handle = start();
    let opened = open_native_session(
        &handle,
        &router,
        &fixture.store,
        None,
        "Pi local HTTP contract",
    )
    .unwrap();
    let native = handle.lock().unwrap().native.clone().unwrap();
    let wire = handle.lock().unwrap().transport.clone();
    let entries = || {
        wire.request_timeout(
            "_pi/workspace",
            json!({"sessionId":opened.native_session_id,"section":"entries"}),
            REQUEST_TIMEOUT,
        )
        .unwrap()["data"]
            .clone()
    };
    let before_rejected_prompt = entries();
    let rejected = wire.request_timeout(
            "session/prompt",
            json!({"sessionId":opened.native_session_id,"prompt":[{"type":"text","text":"This mismatched model must never run"}],
                "_meta":{"farfoldPi":{"hostTurnId":"fixed-native-preflight-rejection","expectedModel":{
                    "version":1,"sessionId":native.session_id,"sessionFile":native.session_file,
                    "provider":fixture.prepared.binding.clone().unwrap().runtime_provider_id,"modelId":"intentionally-different-model"}}}}),
            REQUEST_TIMEOUT,
        );
    assert!(
        matches!(rejected, Err(AcpDispatchError::Rejected {code:-32600, data:Some(ref data)}) if data["farfoldPiPromptNotSent"] == true)
    );
    assert_eq!(
        entries(),
        before_rejected_prompt,
        "rejected preflight must not add native history"
    );
    assert!(
        server.captured.lock().unwrap().is_empty(),
        "rejected preflight must not call the local model service"
    );
    let input = HostPiAcpTurnSubmitInput {
        farfold_session_id: opened.farfold_session_id.clone(),
        native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
        runtime_generation: opened.runtime_generation,
        text: "Reply with ok only. This is an isolated local protocol test.".into(),
    };
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let worker = {
        let runtime = runtime.clone();
        let store = fixture.store.clone();
        let router = router.clone();
        let coordinator = coordinator.clone();
        std::thread::spawn(move || {
            let result = host_pi_acp_turn_submit_blocking(
                &crate::session_controller::HostSessionController::default(),
                &store,
                &runtime,
                &router,
                &coordinator,
                &interactions,
                input,
            );
            let _ = sender.send(result);
        })
    };
    let result = receiver.recv_timeout(Duration::from_secs(30));
    if result.is_err() {
        let _ = runtime.stop_for_shutdown();
    }
    worker.join().unwrap();
    let result = result.unwrap();
    if !matches!(result, Ok(HostNativeTurnSubmission::Accepted { .. })) {
        let _ = runtime.stop_for_shutdown();
        panic!("fixed Pi local HTTP task: {result:?}");
    }
    let projection = fixture
        .store
        .provider_projection_snapshot(&fixture.selection.provider_connection_id)
        .unwrap();
    assert_eq!(
        projection.projections[0].request_state,
        ProviderRequestState::VerifiedSuccess
    );
    assert_eq!(
        projection.projections[0].request_verified_version_id,
        Some(fixture.selection.provider_config_version_id.clone())
    );
    {
        let requests = server.captured.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0, "/v1/chat/completions");
        assert_eq!(requests[0].1, "Bearer fixture-not-a-credential");
        assert_eq!(requests[0].2["model"], "fixture-only");
    }
    let target = fixture
        .store
        .session_open_target(&opened.farfold_session_id)
        .unwrap();
    assert!(target.blockers().is_empty());
    assert!(native.session_file.is_file());
    let persisted_before_refresh = fs::read(&native.session_file).unwrap();
    let wire = handle.lock().unwrap().transport.clone();
    let refresh = wire
        .request(
            "_pi/refresh_profile",
            json!({"sessionId": opened.native_session_id}),
        )
        .unwrap();
    assert_eq!(refresh["version"], 1);
    assert_eq!(refresh["nativeSession"]["sessionId"], native.session_id);
    assert_eq!(
        fs::read(&native.session_file).unwrap(),
        persisted_before_refresh,
        "profile refresh must preserve persisted user and assistant history byte-for-byte"
    );
    assert_eq!(server.captured.lock().unwrap().len(), 1);
    runtime
        .stop_idle_session(&router, &target, opened.runtime_generation)
        .unwrap();
    let handle = start();
    let restored = open_native_session(
        &handle,
        &router,
        &fixture.store,
        Some(&native),
        &target.title,
    )
    .unwrap();
    let messages = read_workspace(
        &runtime,
        &fixture.store,
        &router,
        PiAcpWorkspaceInput {
            farfold_session_id: restored.farfold_session_id.clone(),
            native_session_id: NativeSessionId::parse(&restored.native_session_id).unwrap(),
            runtime_generation: restored.runtime_generation,
            section: PiWorkspaceSection::Messages,
        },
    )
    .unwrap();
    runtime.stop_for_shutdown().unwrap();
    assert_eq!(restored.farfold_session_id, opened.farfold_session_id);
    assert_eq!(restored.native_session_id, opened.native_session_id);
    assert!(restored.runtime_generation > opened.runtime_generation);
    assert!(
        messages["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| message["role"] == "assistant"
                && message["content"]
                    .as_array()
                    .is_some_and(|content| content.iter().any(|block| block["text"] == "ok")))
    );
    assert_eq!(
        server.captured.lock().unwrap().len(),
        1,
        "cold load must not resend the task"
    );
    let original_history = fs::read(&native.session_file).unwrap();
    let mut changed_history = String::new();
    for line in std::str::from_utf8(&original_history).unwrap().lines() {
        let mut entry: Value = serde_json::from_str(line).unwrap();
        if entry["type"] == "model_change" {
            entry["provider"] = json!("missing-original-provider");
            entry["modelId"] = json!("missing-original-model");
        }
        if entry["type"] == "message" && entry["message"]["role"] == "assistant" {
            entry["message"]["provider"] = json!("missing-original-provider");
            entry["message"]["model"] = json!("missing-original-model");
        }
        changed_history.push_str(&serde_json::to_string(&entry).unwrap());
        changed_history.push('\n');
    }
    // Isolated synthetic history only: make the original model unavailable while a configured default remains.
    fs::write(&native.session_file, changed_history.as_bytes()).unwrap();
    let blocked = start();
    let failure = open_native_session(
        &blocked,
        &router,
        &fixture.store,
        Some(&native),
        &target.title,
    );
    assert!(
        failure
            .err()
            .is_some_and(|detail| detail.contains("未恢复原会话模型"))
    );
    assert_eq!(
        fs::read(&native.session_file).unwrap(),
        changed_history.as_bytes()
    );
    assert_eq!(server.captured.lock().unwrap().len(), 1);
    assert_eq!(
        fixture
            .store
            .session_open_target(&opened.farfold_session_id)
            .unwrap()
            .binding(),
        target.binding()
    );
    runtime.stop_for_shutdown().unwrap();
    fs::write(&native.session_file, &original_history).unwrap();
    let repaired = start();
    let recovered = open_native_session(
        &repaired,
        &router,
        &fixture.store,
        Some(&native),
        &target.title,
    )
    .unwrap();
    runtime.stop_for_shutdown().unwrap();
    assert_eq!(recovered.farfold_session_id, opened.farfold_session_id);
    assert_eq!(recovered.native_session_id, opened.native_session_id);
    assert_eq!(fs::read(&native.session_file).unwrap(), original_history);
    assert_eq!(
        server.captured.lock().unwrap().len(),
        1,
        "model recovery must not replay a task"
    );
}

#[test]
#[ignore = "fixed Pi/SDK, isolated synthetic credentials and rejecting local endpoint; no model calls"]
fn fixed_pi_empty_message_branch_cannot_replace_its_original_model_on_restore() {
    let server = crate::pi_acp_contract_tests::RejectModelServer::start();
    let fixture = Fixture::new(&server.endpoint);
    let native = fixture.native();
    let timestamp = "2026-09-13T00:00:00.000Z";
    let entries = [
        json!({"type":"session","version":3,"id":native.session_id,"cwd":fixture.cwd,"timestamp":timestamp}),
        json!({"type":"model_change","id":"root","parentId":null,"timestamp":timestamp,"provider":"missing-original-provider","modelId":"missing-original-model"}),
        json!({"type":"message","id":"other-branch","parentId":"root","timestamp":timestamp,"message":{"role":"assistant","provider":"missing-original-provider","model":"missing-original-model","api":"openai-completions","content":[{"type":"text","text":"Isolated fixture on a different branch"}],"stopReason":"stop","timestamp":0,"usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}}),
        json!({"type":"model_change","id":"empty-branch","parentId":"root","timestamp":timestamp,"provider":"missing-original-provider","modelId":"missing-original-model"}),
    ];
    let original = entries
        .iter()
        .map(|entry| serde_json::to_string(entry).unwrap() + "\n")
        .collect::<String>();
    fs::create_dir_all(native.session_file.parent().unwrap()).unwrap();
    fs::write(&native.session_file, original.as_bytes()).unwrap();
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let node = manifest.join("resources/pi-capabilities/runtime/node");
    let adapter = fixture.temp.path().join("isolated-adapter/index.mjs");
    fs::create_dir_all(adapter.parent().unwrap()).unwrap();
    fs::copy(manifest.join("pi-acp-adapter/dist/index.js"), &adapter).unwrap();
    let pi = manifest.join("resources/pi-runtime/pi");
    assert_eq!(file_sha256(&node).unwrap(), NODE_SHA256);
    crate::runtime_registry::verify_managed_binary_path(pi.clone(), PI_ACP_RUNTIME).unwrap();
    let runtime = PiAcpRuntime::default();
    let router = RuntimeEventRouter::default();
    let mut command = launch_command(
        &node,
        &adapter,
        &pi,
        &fixture.cwd,
        &fixture.prepared,
        Some("ignore"),
    )
    .unwrap();
    let handle = start_connection(
        &runtime,
        &router,
        fixture.binding.clone(),
        &fixture.cwd,
        &fixture.prepared,
        &mut command,
    )
    .unwrap();
    let result = open_native_session(
        &handle,
        &router,
        &fixture.store,
        Some(&native),
        "Empty branch restoration",
    );
    runtime.stop_for_shutdown().unwrap();
    assert!(
        result.is_err(),
        "empty-message branch was incorrectly accepted after native default-model replacement"
    );
    assert_eq!(
        fs::read(&native.session_file).unwrap(),
        original.as_bytes(),
        "failed restore must preserve the pre-launch native branch bytes"
    );
    assert_eq!(server.requests.load(Ordering::SeqCst), 0);

    // Recover the same synthetic empty branch after its original model is available.
    // No task is sent; the native runtime may append its normal startup settings.
    let managed = &fixture.prepared.binding.clone().unwrap();
    let (_, native_model_id) = managed.runtime_model_id.split_once('/').unwrap();
    let repaired = original
        .replace("missing-original-provider", &managed.runtime_provider_id)
        .replace("missing-original-model", native_model_id);
    fs::write(&native.session_file, repaired.as_bytes()).unwrap();
    let mut command = launch_command(
        &node,
        &adapter,
        &pi,
        &fixture.cwd,
        &fixture.prepared,
        Some("ignore"),
    )
    .unwrap();
    let handle = start_connection(
        &runtime,
        &router,
        fixture.binding.clone(),
        &fixture.cwd,
        &fixture.prepared,
        &mut command,
    )
    .unwrap();
    let recovered = open_native_session(
        &handle,
        &router,
        &fixture.store,
        Some(&native),
        "Recovered empty branch",
    );
    runtime.stop_for_shutdown().unwrap();
    assert_eq!(recovered.unwrap().native_session_id, native.session_id);
    assert!(
        fs::read(&native.session_file)
            .unwrap()
            .starts_with(repaired.as_bytes())
    );
    assert_eq!(server.requests.load(Ordering::SeqCst), 0);
}

#[test]
#[ignore = "fixed Pi/SDK, empty owned profile, synthetic native login, local simulated request and cold recovery"]
fn fixed_pi_empty_profile_authentication_does_not_require_managed_bootstrap() {
    let server = crate::opencode_acp::tests::ChatFixtureServer::start();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let node = manifest.join("resources/pi-capabilities/runtime/node");
    let pi = manifest.join("resources/pi-runtime/pi");
    assert_eq!(file_sha256(&node).unwrap(), NODE_SHA256);
    crate::runtime_registry::verify_managed_binary_path(pi.clone(), PI_ACP_RUNTIME).unwrap();
    for path in [
        &root,
        &root.join("agent"),
        &root.join("sessions"),
        &root.join("home"),
        &root.join("tmp"),
        &root.join("project"),
    ] {
        protect_directory(path).unwrap();
    }
    let launch = || {
        let mut command = Command::new(&node);
        command
            .arg(manifest.join("pi-acp-adapter/dist/index.js"))
            .current_dir(root.join("project"))
            .env_clear()
            .env("HOME", root.join("home"))
            .env("PATH", launch_path(&node, None).unwrap())
            .env("TMPDIR", root.join("tmp"))
            .env("PI_CODING_AGENT_DIR", root.join("agent"))
            .env("PI_CODING_AGENT_SESSION_DIR", root.join("sessions"))
            .env("PI_ACP_PI_COMMAND", &pi)
            .env("FARFOLD_PI_PROJECT_TRUST", "ignore");
        crate::acp_runtime::initialize_transport(
            &mut command,
            &root.join("project"),
            json!({"elicitation":{"form":{}},"_meta":{"farfoldPi":{"version":1}}}),
            ADAPTER_VERSION,
            REQUEST_TIMEOUT,
        )
        .unwrap()
        .0
    };
    let wire = launch();
    let result = (|| -> Result<(String, PathBuf), String> {
        let session = wire
            .request_timeout(
                "session/new",
                json!({"cwd":root.join("project"),"mcpServers":[],
                "_meta":{"farfoldPi":{"allowUnauthenticated":true}}}),
                REQUEST_TIMEOUT,
            )
            .map_err(|error| error.to_string())?;
        let id = session["sessionId"]
            .as_str()
            .ok_or("empty profile lost native identity")?;
        wire.bind_client_session(Some(id))?;
        assert_eq!(
            session["_meta"]["farfoldPi"]["modelSelectionRequired"],
            true
        );
        assert_eq!(
            session["_meta"]["farfoldPi"]["nativeFirstUse"]["phase"],
            "authentication_required"
        );
        assert!(selected_config(&session["configOptions"], "model").is_none());
        let workspace = |section: &str| {
            wire.request_timeout(
                "_pi/workspace",
                json!({"sessionId":id,"section":section}),
                REQUEST_TIMEOUT,
            )
            .map_err(|error| format!("empty profile workspace {section}: {error}"))
        };
        let before = workspace("state")?;
        assert_eq!(before["data"]["isStreaming"], false);
        assert_eq!(before["data"]["pendingMessageCount"], 0);
        assert_eq!(workspace("models")?["data"]["models"], json!([]));
        let call = |mut value: Value| {
            value["sessionId"] = json!(id);
            wire.request_timeout("_pi/auth", value, REQUEST_TIMEOUT)
                .map_err(|error| format!("empty profile authentication: {error}"))
        };
        let mut auth =
            call(json!({"action":"start","providerId":"anthropic","authType":"api_key"}))?;
        let flow = auth["flowId"].clone();
        let deadline = std::time::Instant::now() + REQUEST_TIMEOUT;
        while auth["prompt"].is_null()
            && auth["state"] == "running"
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(20));
            auth = call(json!({"action":"status","flowId":flow}))?;
        }
        assert_eq!(auth["prompt"]["value"]["type"], "secret");
        auth = call(
            json!({"action":"reply","flowId":flow,"promptId":auth["prompt"]["id"],"value":"empty-profile-synthetic-key"}),
        )?;
        while auth["state"] == "running" && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
            auth = call(json!({"action":"status","flowId":flow}))?;
        }
        assert_eq!(auth["state"], "succeeded");
        assert_eq!(
            workspace("state")?["nativeSession"],
            before["nativeSession"]
        );
        let pending_entries = workspace("entries")?;
        assert_eq!(
            pending_entries["data"]["entries"]
                .as_array()
                .and_then(|entries| entries.last())
                .and_then(|entry| entry.pointer("/data/phase"))
                .and_then(Value::as_str),
            Some("model_selection_required")
        );
        let available = workspace("models")?;
        let model = available["data"]["models"]
            .as_array()
            .ok_or("native models missing")?
            .iter()
            .find(|model| model["provider"] == "anthropic")
            .ok_or("native login did not refresh catalog")?;
        assert!(model["id"].is_string());
        let auth_file: Value =
            serde_json::from_slice(&fs::read(root.join("agent/auth.json")).unwrap()).unwrap();
        assert_eq!(auth_file.as_object().unwrap().len(), 1);
        assert_eq!(auth_file["anthropic"]["key"], "empty-profile-synthetic-key");
        assert!(!root.join("host.sqlite3").exists());
        assert!(!root.join("agent/models.json").exists());
        let (events, _) = wire.drain_events()?;
        assert!(!events.iter().any(|event| {
            event.pointer("/params/event/type").and_then(Value::as_str) == Some("agent_start")
        }));
        let session_file = PathBuf::from(
            session["_meta"]["farfoldPi"]["nativeSession"]["sessionFile"]
                .as_str()
                .ok_or("empty profile lost native session file")?,
        );
        Ok((id.to_string(), session_file))
    })();
    let stopped = wire.stop();
    let (id, session_file) = result.unwrap();
    stopped.unwrap();
    assert!(!session_file.exists());

    let selector = "native-local-first-use/fixture-only";
    fs::write(
        root.join("agent/models.json"),
        serde_json::to_vec(&json!({"providers":{"native-local-first-use":{
            "baseUrl":format!("http://127.0.0.1:{}/v1",server.port),
            "api":"openai-completions","apiKey":"native-first-use-synthetic-key",
            "compat":{"supportsDeveloperRole":true,"supportsReasoningEffort":false},
            "models":[{"id":"fixture-only","name":"Fixture only","contextWindow":8192,
                "maxTokens":1024,"reasoning":false,"input":["text"]}]
        }}}))
        .unwrap(),
    )
    .unwrap();

    let wire = launch();
    let pending = wire
        .request_timeout(
            "session/load",
            json!({"sessionId":id,"cwd":root.join("project"),"mcpServers":[]}),
            REQUEST_TIMEOUT,
        )
        .unwrap();
    wire.bind_client_session(Some(&id)).unwrap();
    assert_eq!(
        pending["_meta"]["farfoldPi"]["nativeFirstUse"]["phase"],
        "model_selection_required"
    );
    assert!(
        wire.request_timeout(
            "session/prompt",
            json!({"sessionId":id,"prompt":[{"type":"text","text":"must not call a model"}]}),
            REQUEST_TIMEOUT,
        )
        .is_err()
    );
    let selected = wire
        .request_timeout(
            "session/set_config_option",
            json!({"sessionId":id,"configId":"model","value":selector}),
            REQUEST_TIMEOUT,
        )
        .unwrap();
    assert_eq!(
        selected_config(&selected["configOptions"], "model"),
        Some(selector)
    );
    assert_eq!(
        selected["_meta"]["farfoldPi"]["nativeFirstUse"]["phase"],
        "ready"
    );
    let task = wire
            .request_timeout(
                "session/prompt",
                json!({"sessionId":id,"prompt":[{"type":"text","text":"Reply with ok only. Local native first-use test."}]}),
                REQUEST_TIMEOUT,
            )
            .unwrap();
    assert_eq!(task["stopReason"], "end_turn");
    {
        let requests = server.captured.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0, "/v1/chat/completions");
        assert_eq!(requests[0].1, "Bearer native-first-use-synthetic-key");
        assert_eq!(requests[0].2["model"], "fixture-only");
    }
    wire.stop().unwrap();

    let wire = launch();
    let restored = wire
        .request_timeout(
            "session/load",
            json!({"sessionId":id,"cwd":root.join("project"),"mcpServers":[]}),
            REQUEST_TIMEOUT,
        )
        .unwrap();
    assert_eq!(
        restored["_meta"]["farfoldPi"]["nativeSession"]["sessionId"],
        id
    );
    assert_eq!(
        restored["_meta"]["farfoldPi"]["nativeFirstUse"]["phase"],
        "ready"
    );
    assert_eq!(
        selected_config(&restored["configOptions"], "model"),
        Some(selector)
    );
    wire.stop().unwrap();
    assert!(!root.join("host.sqlite3").exists());
    assert_eq!(server.captured.lock().unwrap().len(), 1);
}

#[test]
#[ignore = "fixed Pi/SDK with isolated synthetic native credential, same-process refresh and zero model calls"]
fn fixed_pi_native_authentication_preserves_session_model_and_provider_evidence() {
    let server = crate::pi_acp_contract_tests::RejectModelServer::start();
    let fixture = Fixture::stable(&server.endpoint);
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let node = manifest.join("capability-bridge/runtime/node");
    let pi = manifest.join("resources/pi-runtime/pi");
    assert_eq!(file_sha256(&node).unwrap(), NODE_SHA256);
    crate::runtime_registry::verify_managed_binary_path(pi.clone(), PI_ACP_RUNTIME).unwrap();
    let runtime = PiAcpRuntime::default();
    let router = RuntimeEventRouter::default();
    let controller = crate::session_controller::HostSessionController::default();
    let turns = crate::turn_coordinator::TurnCoordinator::default();
    let mut command = launch_command(
        &node,
        &manifest.join("pi-acp-adapter/dist/index.js"),
        &pi,
        &fixture.cwd,
        &fixture.prepared,
        Some("ignore"),
    )
    .unwrap();
    let handle = start_connection(
        &runtime,
        &router,
        fixture.binding.clone(),
        &fixture.cwd,
        &fixture.prepared,
        &mut command,
    )
    .unwrap();
    let result = (|| -> Result<(), String> {
        let opened = open_native_session(
            &handle,
            &router,
            &fixture.store,
            None,
            "Synthetic native auth",
        )?;
        let target = fixture
            .store
            .session_open_target(&opened.farfold_session_id)?;
        let before = current_status(&runtime, &router)?;
        let projection = serde_json::to_value(
            fixture
                .store
                .provider_projection_snapshot(&fixture.selection.provider_connection_id)?,
        )
        .unwrap();
        let workspace = |section| {
            read_workspace_snapshot(
                &runtime,
                &fixture.store,
                &router,
                PiAcpWorkspaceInput {
                    farfold_session_id: opened.farfold_session_id.clone(),
                    native_session_id: target.native_session_id.clone(),
                    runtime_generation: opened.runtime_generation,
                    section,
                },
            )
        };
        let entries = workspace(PiWorkspaceSection::Entries)?;
        let catalog = workspace(PiWorkspaceSection::AuthCatalog)?;
        assert!(
            catalog["providers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|provider| provider["id"] == "anthropic")
        );
        assert!(!catalog.to_string().contains("farfold-managed-"));
        let call = |command: Value| -> Result<Value, String> {
            let snapshot = native_auth::authenticate(&controller, &runtime, &fixture.store, &router, &turns,
                    serde_json::from_value(json!({"farfoldSessionId":opened.farfold_session_id,"nativeSessionId":opened.native_session_id,
                        "runtimeGeneration":opened.runtime_generation,"command":command})).unwrap())?;
            Ok(serde_json::to_value(snapshot).unwrap())
        };
        let mut auth =
            call(json!({"action":"start","providerId":"anthropic","authType":"api_key"}))?;
        let flow_id = auth["flowId"].clone();
        let deadline = std::time::Instant::now() + REQUEST_TIMEOUT;
        while auth["prompt"].is_null()
            && auth["state"] == "running"
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(20));
            auth = call(json!({"action":"status","flowId":flow_id}))?;
        }
        if auth["prompt"]["value"]["type"] != "secret" {
            return Err("fixed Pi did not expose its native key prompt".into());
        }
        assert!(
            verify_prompt_connection(&handle.lock().unwrap(), &target, opened.runtime_generation)
                .is_err()
        );
        auth = call(
            json!({"action":"reply","flowId":flow_id,"promptId":auth["prompt"]["id"],"value":"synthetic-native-auth-key"}),
        )?;
        while auth["state"] == "running" && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
            auth = call(json!({"action":"status","flowId":flow_id}))?;
        }
        if auth["state"] != "succeeded" {
            return Err(format!(
                "fixed Pi native auth state: {} / {} / {}",
                auth["state"], auth["credentialState"], auth["refreshState"]
            ));
        }
        assert_eq!(auth["credentialState"], "committed");
        assert_eq!(auth["refreshState"], "confirmed");
        assert!(!auth.to_string().contains("synthetic-native-auth-key"));
        let stored: Value = serde_json::from_slice(
            &fs::read(fixture.prepared.config_root.join("auth.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(stored["anthropic"]["key"], "synthetic-native-auth-key");
        assert_eq!(stored.as_object().unwrap().len(), 1);
        let available = current_status(&runtime, &router)?.config_options;
        assert!(
            available
                .as_array()
                .unwrap()
                .iter()
                .any(|option| option["id"] == "model"
                    && option["options"].as_array().unwrap().iter().any(|model| {
                        model["value"]
                            .as_str()
                            .is_some_and(|id| id.starts_with("anthropic/"))
                    }))
        );
        let mut logout = call(
            json!({"action":"start","operation":"logout","providerId":"anthropic","authType":"api_key"}),
        )?;
        let logout_id = logout["flowId"].clone();
        let deadline = std::time::Instant::now() + REQUEST_TIMEOUT;
        while logout["state"] == "running" && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
            logout = call(json!({"action":"status","flowId":logout_id}))?;
        }
        if logout["state"] != "succeeded" || logout["operation"] != "logout" {
            return Err("fixed Pi native logout was not confirmed".into());
        }
        let stored: Value = serde_json::from_slice(
            &fs::read(fixture.prepared.config_root.join("auth.json")).unwrap(),
        )
        .unwrap();
        assert!(stored.get("anthropic").is_none());
        assert_eq!(workspace(PiWorkspaceSection::Entries)?, entries);
        let after = current_status(&runtime, &router)?;
        assert_eq!(after.native_session, before.native_session);
        assert_eq!(after.model_source, before.model_source);
        assert_eq!(after.generation, before.generation);
        assert_eq!(
            serde_json::to_value(
                fixture
                    .store
                    .provider_projection_snapshot(&fixture.selection.provider_connection_id)?
            )
            .unwrap(),
            projection
        );
        Ok(())
    })();
    runtime.stop_for_shutdown().unwrap();
    assert_eq!(server.requests.load(Ordering::SeqCst), 0);
    result.unwrap();
}

#[test]
#[ignore = "fixed Pi/SDK, isolated synthetic credentials and rejecting local endpoint; no model calls"]
fn fixed_pi_profile_refresh_keeps_native_process_session_and_history() {
    let server = crate::pi_acp_contract_tests::RejectModelServer::start();
    let fixture = Fixture::new(&server.endpoint);
    let root = fixture.temp.path().canonicalize().unwrap();
    let profile = new_owned_profile(fixture.selection.clone()).unwrap();
    let prepared = crate::acp_provider_profile::prepare_owned(
        &root,
        &root.join("pi-acp"),
        &fixture.store,
        &profile,
        true,
    )
    .unwrap();
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let node = manifest.join("capability-bridge/runtime/node");
    let pi = manifest.join("resources/pi-runtime/pi");
    assert_eq!(file_sha256(&node).unwrap(), NODE_SHA256);
    crate::runtime_registry::verify_managed_binary_path(pi.clone(), PI_ACP_RUNTIME).unwrap();
    fs::create_dir(prepared.config_root.join("extensions")).unwrap();
    fs::copy(
        manifest.join("../scripts/fixtures/pi-profile-refresh-probe.ts"),
        prepared.config_root.join("extensions/profile-probe.ts"),
    )
    .unwrap();
    let mut command = launch_command(
        &node,
        &manifest.join("pi-acp-adapter/dist/index.js"),
        &pi,
        &fixture.cwd,
        &prepared,
        Some("ignore"),
    )
    .unwrap();
    let (wire, _) = crate::acp_runtime::initialize_transport(
        &mut command,
        &fixture.cwd,
        json!({"elicitation":{"form":{}},"_meta":{"farfoldPi":{"version":1}}}),
        ADAPTER_VERSION,
        REQUEST_TIMEOUT,
    )
    .unwrap();
    let result = (|| -> Result<(), String> {
        let session = wire
            .request("session/new", json!({"cwd":fixture.cwd,"mcpServers":[]}))
            .map_err(|error| error.to_string())?;
        let session_id = session["sessionId"].as_str().ok_or("missing session")?;
        wire.bind_client_session(Some(session_id))?;
        let workspace = |section: &str| {
            wire.request(
                "_pi/workspace",
                json!({"sessionId":session_id,"section":section}),
            )
            .map_err(|error| error.to_string())
        };
        let probe = |refresh: bool| -> Result<Value, String> {
            let response = wire.request_timeout("session/prompt", json!({"sessionId":session_id,"prompt":[{"type":"text","text":if refresh {"/farfold-profile-probe refresh"} else {"/farfold-profile-probe"}}]}), REQUEST_TIMEOUT).map_err(|error| error.to_string())?;
            if response["stopReason"] != "end_turn" {
                return Err("profile probe did not settle".into());
            }
            let deadline = std::time::Instant::now() + REQUEST_TIMEOUT;
            while std::time::Instant::now() < deadline {
                let (events, dropped) = wire.wait_events(Duration::from_millis(25))?;
                if dropped != 0 {
                    return Err("profile probe lost events".into());
                }
                for event in events {
                    if event["method"] == "_pi/ui"
                        && event["params"]["sessionId"] == session_id
                        && let Some(value) = event
                            .pointer("/params/event/message")
                            .and_then(Value::as_str)
                            .and_then(|value| value.strip_prefix("D-PROFILE-PROBE:"))
                    {
                        return serde_json::from_str(value).map_err(|error| error.to_string());
                    }
                }
            }
            Err("native profile refresh acknowledgement missing".into())
        };
        let before = probe(false)?;
        let entries = workspace("entries")?;
        let initial = workspace("models")?;
        let models_path = prepared.config_root.join("models.json");
        let mut config: Value = serde_json::from_slice(&fs::read(&models_path).unwrap()).unwrap();
        let models =
            config["providers"][&prepared.binding.clone().unwrap().runtime_provider_id]["models"]
                .as_array_mut()
                .unwrap();
        let mut added = models[0].clone();
        added["id"] = json!("profile-refresh-second");
        models.push(added);
        fs::write(&models_path, serde_json::to_vec(&config).unwrap()).unwrap();
        let helper = Command::new(&node)
            .arg(manifest.join("../scripts/fixtures/pi-profile-catalog-probe.mjs"))
            .arg(&prepared.config_root)
            .arg(&prepared.binding.clone().unwrap().runtime_provider_id)
            .current_dir(&fixture.cwd)
            .env_clear()
            .env("HOME", prepared.profile_root.join("home"))
            .env("TMPDIR", &root)
            .env("PI_CODING_AGENT_DIR", &prepared.config_root)
            .env("PATH", "/usr/bin:/bin")
            .envs(&prepared.environment)
            .output()
            .map_err(|error| error.to_string())?;
        if !helper.status.success() {
            return Err(format!(
                "isolated SDK catalog helper failed: {}",
                String::from_utf8_lossy(&helper.stderr)
            ));
        }
        let catalog: Value =
            serde_json::from_slice(&helper.stdout).map_err(|error| error.to_string())?;
        assert_eq!(catalog["version"], "0.84.3");
        assert_ne!(catalog["pid"], before["pid"]);
        assert!(
            catalog["models"]
                .as_array()
                .unwrap()
                .iter()
                .any(|model| model == "profile-refresh-second")
        );
        assert_eq!(
            workspace("models")?,
            initial,
            "external SDK refresh must not be mistaken for native-process refresh"
        );
        let refreshed_identity = wire
            .request("_pi/refresh_profile", json!({"sessionId": session_id}))
            .map_err(|error| error.to_string())?;
        assert_eq!(refreshed_identity["version"], 1);
        assert_eq!(
            refreshed_identity["nativeSession"],
            initial["nativeSession"]
        );
        let after = probe(false)?;
        assert_eq!(
            after, before,
            "refresh changed PID or native Session identity"
        );
        assert_eq!(after["sessionId"], session_id);
        assert_eq!(
            after["sessionFile"],
            session["_meta"]["farfoldPi"]["nativeSession"]["sessionFile"]
        );
        assert_eq!(
            workspace("entries")?,
            entries,
            "catalog refresh must not append a user/Agent turn"
        );
        let refreshed = workspace("models")?;
        assert!(
            refreshed["data"]["models"]
                .as_array()
                .unwrap()
                .iter()
                .any(|model| model["id"] == "profile-refresh-second")
        );
        let selector = format!(
            "{}/profile-refresh-second",
            prepared.binding.clone().unwrap().runtime_provider_id
        );
        let changed = wire
            .request(
                "session/set_config_option",
                json!({"sessionId":session_id,"configId":"model","value":selector}),
            )
            .map_err(|error| error.to_string())?;
        assert_eq!(
            selected_config(&changed["configOptions"], "model"),
            Some(selector.as_str())
        );
        let state = workspace("state")?;
        assert_eq!(state["data"]["model"]["id"], "profile-refresh-second");
        assert_eq!(state["nativeSession"], initial["nativeSession"]);
        assert_eq!(server.requests.load(Ordering::Acquire), 0);
        Ok(())
    })();
    let stopped = wire.stop();
    result.unwrap();
    stopped.unwrap();
}

#[test]
#[ignore = "fixed Pi/Node binaries, isolated managed profile, rejecting model endpoint; no account access"]
fn fixed_pi_ordinary_startup_registers_native_session_without_model_request() {
    let server = crate::pi_acp_contract_tests::RejectModelServer::start();
    let mut fixture = Fixture::new(&server.endpoint);
    let profile = new_owned_profile(fixture.selection.clone()).unwrap();
    fixture.prepared = crate::acp_provider_profile::prepare_owned(
        fixture.temp.path(),
        &fixture.temp.path().join("pi-acp"),
        &fixture.store,
        &profile,
        true,
    )
    .unwrap();
    fixture.binding = profile.binding.clone();
    fixture
        .store
        .register_runtime_owned_profile(
            &runtime_registration(&fixture.binding, crate::host_store::now_millis()),
            &profile,
        )
        .unwrap();
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let node = manifest.join("capability-bridge/runtime/node");
    let pi = manifest.join("resources/pi-runtime/pi");
    assert_eq!(file_sha256(&node).unwrap(), NODE_SHA256);
    crate::runtime_registry::verify_managed_binary_path(pi.clone(), PI_ACP_RUNTIME).unwrap();
    let runtime = PiAcpRuntime::default();
    let router = RuntimeEventRouter::default();
    let mut command = launch_command(
        &node,
        &manifest.join("pi-acp-adapter/dist/index.js"),
        &pi,
        &fixture.cwd,
        &fixture.prepared,
        Some("ignore"),
    )
    .unwrap();
    let handle = start_connection(
        &runtime,
        &router,
        fixture.binding.clone(),
        &fixture.cwd,
        &fixture.prepared,
        &mut command,
    )
    .unwrap();
    let result = (|| {
        let result =
            open_native_session(&handle, &router, &fixture.store, None, "Pi native start")?;
        let controller = crate::session_controller::HostSessionController::default();
        let turns = crate::turn_coordinator::TurnCoordinator::default();
        for (config_id, value) in [
            (
                PiAcpConfigId::Model,
                fixture
                    .prepared
                    .binding
                    .clone()
                    .unwrap()
                    .runtime_model_id
                    .clone(),
            ),
            (PiAcpConfigId::ThoughtLevel, "off".into()),
        ] {
            let status = set_config_option(
                &controller,
                &runtime,
                &fixture.store,
                &router,
                &turns,
                PiAcpConfigInput {
                    farfold_session_id: result.farfold_session_id.clone(),
                    native_session_id: NativeSessionId::parse(&result.native_session_id).unwrap(),
                    runtime_generation: result.runtime_generation,
                    config_id,
                    value: value.clone(),
                },
            )?;
            assert_eq!(
                selected_config(&status.config_options, config_id.as_str()),
                Some(value.as_str())
            );
        }
        for section in [
            PiWorkspaceSection::State,
            PiWorkspaceSection::Messages,
            PiWorkspaceSection::Entries,
            PiWorkspaceSection::Models,
            PiWorkspaceSection::ThinkingLevels,
            PiWorkspaceSection::Commands,
            PiWorkspaceSection::Stats,
        ] {
            let data = read_workspace(
                &runtime,
                &fixture.store,
                &router,
                PiAcpWorkspaceInput {
                    farfold_session_id: result.farfold_session_id.clone(),
                    native_session_id: NativeSessionId::parse(&result.native_session_id).unwrap(),
                    runtime_generation: result.runtime_generation,
                    section,
                },
            )?;
            if section == PiWorkspaceSection::State {
                assert_eq!(data["sessionId"], result.native_session_id);
            }
            if section == PiWorkspaceSection::Entries {
                assert!(data["entries"].is_array());
            }
        }
        Ok::<_, String>(result)
    })();
    let stopped = runtime.stop_for_shutdown();
    let result = result.unwrap();
    stopped.unwrap();
    let target = fixture
        .store
        .session_open_target(&result.farfold_session_id)
        .unwrap();
    assert_eq!(target.binding(), fixture.binding);
    assert_eq!(target.native_session_id.as_str(), result.native_session_id);
    assert_eq!(
        saved_owned_profile(&fixture.store, &target.binding())
            .unwrap()
            .profile_id,
        profile.profile_id
    );
    assert!(
        !fixture
            .store
            .discard_unbound_owned_profile(&profile)
            .unwrap()
    );
    assert_eq!(
        target.blockers(),
        vec![SessionOpenBlocker::NativeLocatorUnavailable]
    );
    assert_eq!(server.requests.load(Ordering::Acquire), 0);
}
