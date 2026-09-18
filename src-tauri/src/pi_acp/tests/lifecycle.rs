use super::*;

#[test]
fn native_descriptor_rejects_identity_path_header_and_missing_restore_without_writing() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1");
    let native = fixture.native();
    let root = fixture.prepared.profile_root.join("sessions");
    let response = fixture.response();
    assert_eq!(
        native_descriptor(&response, None, &fixture.cwd, &root).unwrap(),
        native
    );
    assert!(native_descriptor(&response, Some(&native), &fixture.cwd, &root).is_err());
    assert!(!native.session_file.exists());
    for pointer in [
        "/sessionId",
        "/_meta/farfoldPi/nativeSession/sessionId",
        "/_meta/farfoldPi/nativeSession/cwd",
    ] {
        let mut bad = response.clone();
        *bad.pointer_mut(pointer).unwrap() = json!("different");
        assert!(native_descriptor(&bad, Some(&native), &fixture.cwd, &root).is_err());
    }
    fs::write(
        &native.session_file,
        json!({"type":"session","id":"wrong","cwd":fixture.cwd}).to_string(),
    )
    .unwrap();
    assert!(native_descriptor(&response, None, &fixture.cwd, &root).is_err());
    let original = fs::read(&native.session_file).unwrap();
    assert!(native_descriptor(&response, Some(&native), &fixture.cwd, &root).is_err());
    assert_eq!(fs::read(&native.session_file).unwrap(), original);
    fs::remove_file(&native.session_file).unwrap();
    let outside = fixture.temp.path().join("outside.jsonl");
    fs::write(&outside, "{}\n").unwrap();
    std::os::unix::fs::symlink(&outside, &native.session_file).unwrap();
    assert!(native_descriptor(&response, None, &fixture.cwd, &root).is_err());
}

#[test]
fn confirmed_exit_releases_lifecycle_even_if_pending_event_publication_fails() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1");
    let runtime = PiAcpRuntime::default();
    let router = RuntimeEventRouter::default();
    let handle = fixture.start(&runtime, &router, fixture.response());
    let transport = {
        let connection = handle.lock().unwrap();
        connection.event_pump_stop.store(true, Ordering::Release);
        connection.transport.clone()
    };
    transport.request("fixture/malformed", json!({})).unwrap();
    let result = runtime.stop_locked(Some(&router));
    assert!(result.unwrap_err().contains("进程已确认退出"));
    assert!(runtime.is_stopped().unwrap());
    assert!(!transport.is_running().unwrap());
    runtime.stop_locked(Some(&router)).unwrap();
    fixture.start(&runtime, &router, fixture.response());
    runtime.stop_for_shutdown().unwrap();
}

#[test]
fn isolated_launch_keeps_tool_paths_without_inheriting_other_environment() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1");
    let paths = launch_path(
        Path::new("/owned/node/bin/node"),
        Some(std::ffi::OsStr::new("/custom/bin::relative:/usr/bin")),
    )
    .unwrap();
    let paths: Vec<_> = std::env::split_paths(&paths).collect();
    assert_eq!(paths[0], Path::new("/owned/node/bin"));
    assert!(paths.contains(&PathBuf::from("/custom/bin")));
    assert!(paths.contains(&PathBuf::from("/opt/homebrew/bin")));
    assert!(paths.iter().all(|path| path.is_absolute()));
    let command = launch_command(
        Path::new("/owned/node"),
        Path::new("/owned/adapter.js"),
        Path::new("/owned/pi"),
        &fixture.cwd,
        &fixture.prepared,
        Some("ignore"),
    )
    .unwrap();
    let environment: std::collections::BTreeMap<_, _> = command.get_envs().collect();
    assert_eq!(
        environment
            .get(std::ffi::OsStr::new("FARFOLD_PI_PROJECT_TRUST"))
            .copied()
            .flatten(),
        Some(std::ffi::OsStr::new("ignore"))
    );
    assert!(!environment.contains_key(std::ffi::OsStr::new("OPENAI_API_KEY")));
    assert!(
        launch_command(
            Path::new("/owned/node"),
            Path::new("/owned/adapter.js"),
            Path::new("/owned/pi"),
            &fixture.cwd,
            &fixture.prepared,
            Some("invalid")
        )
        .is_err()
    );
}

#[test]
fn workspace_reads_are_scoped_and_refresh_only_the_same_persisted_native_locator() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1");
    let runtime = PiAcpRuntime::default();
    let router = RuntimeEventRouter::default();
    let handle = fixture.start(&runtime, &router, fixture.response());
    let opened = open_native_session(&handle, &router, &fixture.store, None, "Pi fixture").unwrap();
    let input = || PiAcpWorkspaceInput {
        farfold_session_id: opened.farfold_session_id.clone(),
        native_session_id: NativeSessionId::parse(&opened.native_session_id).unwrap(),
        runtime_generation: opened.runtime_generation,
        section: PiWorkspaceSection::Entries,
    };
    let mut stale = input();
    stale.runtime_generation += 1;
    assert!(read_workspace(&runtime, &fixture.store, &router, stale).is_err());
    let first = read_workspace(&runtime, &fixture.store, &router, input()).unwrap();
    assert_eq!(first["entries"][0]["type"], "future");
    assert!(
        fixture
            .store
            .session_open_target(&opened.farfold_session_id)
            .unwrap()
            .locator_value
            .is_none()
    );
    let native = fixture.native();
    fs::write(
        &native.session_file,
        format!(
            "{}\n",
            json!({"type":"session","id":native.session_id,"cwd":native.cwd})
        ),
    )
    .unwrap();
    read_workspace(&runtime, &fixture.store, &router, input()).unwrap();
    assert_eq!(
        fixture
            .store
            .session_open_target(&opened.farfold_session_id)
            .unwrap()
            .pi_session_file(),
        Some(native.session_file.as_path())
    );
    assert!(serde_json::from_value::<PiAcpWorkspaceInput>(json!({"farfoldSessionId":opened.farfold_session_id,
            "nativeSessionId":opened.native_session_id,"runtimeGeneration":opened.runtime_generation,"section":"prompt"})).is_err());
    runtime.stop_for_shutdown().unwrap();
}

#[test]
fn idle_exited_connection_can_be_cleaned_then_restore_the_original_session() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1");
    let runtime = PiAcpRuntime::default();
    let router = RuntimeEventRouter::default();
    let handle = fixture.start(&runtime, &router, fixture.response());
    let first = open_native_session(&handle, &router, &fixture.store, None, "Pi fixture").unwrap();
    let native = fixture.native();
    fs::write(
        &native.session_file,
        format!(
            "{}\n",
            json!({"type":"session","id":native.session_id,"cwd":native.cwd})
        ),
    )
    .unwrap();
    register_observation(&fixture.store, &handle.lock().unwrap(), "Pi fixture").unwrap();
    let target = fixture
        .store
        .session_open_target(&first.farfold_session_id)
        .unwrap();
    let transport = handle.lock().unwrap().transport.clone();
    transport
        .notify_timeout("fixture/idle_crash", json!({}), Duration::from_secs(1))
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while transport.is_running().unwrap() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(!transport.is_running().unwrap());
    assert!(!runtime.is_stopped().unwrap());
    let disconnected = current_status(&runtime, &router).unwrap();
    assert!(!disconnected.running);
    assert!(disconnected.runtime.is_some());
    assert_eq!(
        disconnected.native_session.as_ref().unwrap().session_id,
        native.session_id
    );
    assert!(require_live_target(&handle.lock().unwrap(), &target).is_err());
    assert!(
        runtime
            .stop_idle_session(&router, &target, first.runtime_generation + 1)
            .is_err()
    );
    let stopped = runtime
        .stop_idle_session(&router, &target, first.runtime_generation)
        .unwrap();
    assert!(!stopped.running);
    assert!(stopped.last_error.is_some());
    assert!(runtime.is_stopped().unwrap());
    let restored_handle = fixture.start(&runtime, &router, fixture.response());
    let restored = open_native_session(
        &restored_handle,
        &router,
        &fixture.store,
        Some(&native),
        &target.title,
    )
    .unwrap();
    assert_eq!(restored.farfold_session_id, first.farfold_session_id);
    assert_eq!(restored.native_session_id, first.native_session_id);
    assert!(restored.runtime_generation > first.runtime_generation);
    runtime.stop_for_shutdown().unwrap();
}

#[test]
fn shared_registration_keeps_empty_session_nonrestorable_and_stop_is_exact() {
    let fixture = Fixture::new("http://127.0.0.1:1/v1");
    let runtime = PiAcpRuntime::default();
    let router = RuntimeEventRouter::default();
    let handle = fixture.start(&runtime, &router, fixture.response());
    let opened = open_native_session(&handle, &router, &fixture.store, None, "Pi fixture").unwrap();
    let target = fixture
        .store
        .session_open_target(&opened.farfold_session_id)
        .unwrap();
    assert_eq!(target.binding(), fixture.binding);
    assert_eq!(target.native_session_id.as_str(), "native-fixture");
    assert_eq!(
        target.blockers(),
        vec![SessionOpenBlocker::NativeLocatorUnavailable]
    );
    assert!(!fixture.native().session_file.exists());
    let projection = fixture
        .store
        .provider_projection_snapshot(&fixture.selection.provider_connection_id)
        .unwrap();
    assert_eq!(
        projection.projections[0].apply_state,
        ProviderApplyState::Applied
    );
    assert_eq!(
        projection.projections[0].request_state,
        ProviderRequestState::NotRequested
    );
    assert_eq!(projection.projections[0].request_verified_version_id, None);
    assert!(
        runtime
            .stop_idle_session(&router, &target, opened.runtime_generation + 1)
            .is_err()
    );
    assert!(!runtime.is_stopped().unwrap());
    require_live_target(&handle.lock().unwrap(), &target).unwrap();
    assert_eq!(
        register_observation(&fixture.store, &handle.lock().unwrap(), "Pi fixture").unwrap(),
        opened.farfold_session_id
    );
    assert!(
        !runtime
            .stop_idle_session(&router, &target, opened.runtime_generation)
            .unwrap()
            .running
    );
    assert!(runtime.is_stopped().unwrap());
    assert!(
        fixture
            .store
            .session_open_target(&opened.farfold_session_id)
            .is_ok()
    );
}
