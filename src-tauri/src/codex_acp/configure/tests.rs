use super::*;
use std::time::Instant;
fn scope(generation: u64) -> Scope {
    Scope {
        runtime_product_id: "codex".into(),
        installation_id: "synthetic-installation".into(),
        runtime_build_id: NATIVE_SHA.into(),
        adapter_id: "codex-acp-stdio-v1".into(),
        adapter_build_id: ADAPTER_SHA.into(),
        connection_id: "synthetic-connection".into(),
        profile_id: "synthetic-profile".into(),
        generation,
    }
}

#[test]
fn discovery_projects_inflight_unknown_and_rejects_missing_kind_or_ownership() {
    let runtime = Runtime::default();
    let _home = attach(&runtime, "waiting", 1);
    let target = scope(1);
    let handle = runtime.connection().unwrap();
    {
        let mut c = handle.lock().unwrap();
        let id = c.control.operations.begin_connection_config(false).unwrap();
        c.control.flow = Some(Flow {
            expected_account: AccountState::Chatgpt,
            device: Some(true),
            id,
            login_id: None,
            phase: Phase::Starting,
            in_flight: true,
            terminal: false,
        });
    }
    let read = || serde_json::to_value(runtime.discover_configure(&target).unwrap()).unwrap();
    assert_eq!(read()["operation"]["inFlight"], true);
    assert_eq!(read()["operation"]["kind"], "device");
    assert!(
        runtime
            .configure(
                &target,
                CommandInput::Status {
                    operation_id: 1,
                    login_id: None
                }
            )
            .is_err()
    );
    {
        let mut c = handle.lock().unwrap();
        let flow = c.control.flow.as_mut().unwrap();
        flow.in_flight = false;
        flow.phase = Phase::Unknown;
    }
    assert_eq!(read()["operation"]["phase"], "unknown");
    assert!(runtime.configure(&target, CommandInput::Browser).is_err());
    // Unknown remains a blocker even if the old occupancy was already released.
    handle
        .lock()
        .unwrap()
        .control
        .flow
        .as_mut()
        .unwrap()
        .terminal = true;
    handle
        .lock()
        .unwrap()
        .control
        .operations
        .complete(1)
        .unwrap();
    assert!(
        runtime
            .admission_view(&target, super::super::admission::ViewCommand::Refresh)
            .is_err()
    );
    {
        let mut c = handle.lock().unwrap();
        c.control.flow.as_mut().unwrap().terminal = false;
        c.control.operations = AcpSessionOperations::default();
        c.control.operations.begin_connection_config(false).unwrap();
    }
    handle.lock().unwrap().control.flow.as_mut().unwrap().phase = Phase::Confirmed;
    assert!(runtime.discover_configure(&target).is_err());
    handle.lock().unwrap().control.flow.as_mut().unwrap().phase = Phase::Unknown;
    handle.lock().unwrap().control.flow.as_mut().unwrap().device = None;
    assert!(runtime.discover_configure(&target).is_err());
    handle.lock().unwrap().control.flow = None;
    assert!(runtime.discover_configure(&target).is_err());
    runtime.stop(&target).unwrap();
}

#[test]
#[ignore = "explicit fixed Codex/Node; reads only, real authentication entry remains disabled"]
fn fixed_runtime_lifecycle_never_restores_authorization_or_enables_login() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = Runtime::default();
    let launch = |profile: &str| {
        let mut scope = scope(1);
        scope.profile_id = profile.into();
        Launch {
            node: std::env::var_os("FARFOLD_E_NODE")
                .expect("explicit Node")
                .into(),
            native: std::env::var_os("FARFOLD_E_CODEX")
                .expect("explicit Codex")
                .into(),
            adapter: std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("codex-acp-adapter/adapter.mjs"),
            owned_parent: temp.path().into(),
            cwd: temp.path().into(),
            working_copy_id: None,
            scope,
        }
    };
    let first = runtime.start(launch("profile-first")).unwrap();
    assert!(runtime.start(launch("profile-second")).is_err());
    assert!(runtime.configure(&first, CommandInput::Browser).is_err());
    {
        let handle = runtime.connection().unwrap();
        let c = handle.lock().unwrap();
        for method in [
            "_codex/turn",
            "_codex/turn/history",
            "_codex/interaction/reply",
            "_codex/turn/steer",
        ] {
            assert!(matches!(
                c.transport
                    .request(method, json!({"scope":first,"command":{},"thread":{}})),
                Err(crate::acp_transport::AcpDispatchError::Rejected { code: -32601, .. })
            ));
        }
        assert!(!c.profile_home.join("codex/sessions").exists());
    }
    assert_eq!(
        runtime.read(&first, ReadMethod::Account).unwrap()["account"],
        json!({"account":null,"requiresOpenaiAuth":true})
    );
    runtime.stop(&first).unwrap();
    assert!(runtime.start(launch("profile-first")).is_err());
    let next = runtime.start(launch("profile-second")).unwrap();
    assert!(next.generation > first.generation);
    assert!(runtime.read(&first, ReadMethod::Account).is_err());
    assert_eq!(
        runtime.read(&next, ReadMethod::EmptyThreadList).unwrap()["data"],
        json!([])
    );
    assert!(
        runtime
            .connection()
            .unwrap()
            .lock()
            .unwrap()
            .control
            .flow
            .is_none()
    );
    runtime.stop(&next).unwrap();
}
pub(crate) fn attach(runtime: &Runtime, mode: &str, generation: u64) -> tempfile::TempDir {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let home = base.join("home");
    fs::create_dir(&home).unwrap();
    fs::create_dir(home.join("codex")).unwrap();
    let launch =
        json!({"scope":scope(generation),"home":home,"codexHome":home.join("codex"),"cwd":base});
    let node = std::env::var_os("FARFOLD_E_NODE").unwrap_or_else(|| "node".into());
    let mut command = Command::new(node);
    command
        .arg(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("codex-acp-adapter/test/synthetic-adapter.mjs"),
        )
        .arg(mode)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", &home)
        .env("FARFOLD_TEST_LAUNCH", launch.to_string());
    let (transport, _) = initialize_transport(
        &mut command,
        &base,
        json!({}),
        ADAPTER_VERSION,
        Duration::from_secs(5),
    )
    .unwrap();
    let connection = Connection {
        transport,
        scope: scope(generation),
        profile_home: home,
        control: Control::default(),
        workspace: super::super::threads::Workspace {
            cwd: base,
            working_copy_id: None,
        },
        threads: super::super::threads::Control::default(),
        turns: super::super::turns::Control::default(),
        admission: None,
        _profile_lease: None,
    };
    *runtime.inner.state.lock().unwrap() = AcpLifecycle::Running(Arc::new(Mutex::new(connection)));
    temp
}
fn poll(runtime: &Runtime, mut snapshot: Snapshot, predicate: impl Fn(Phase) -> bool) -> Snapshot {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !predicate(snapshot.phase) {
        assert!(
            Instant::now() < deadline,
            "Synthetic Configure did not settle"
        );
        std::thread::sleep(Duration::from_millis(10));
        snapshot = runtime
            .configure(
                &snapshot.scope,
                CommandInput::Status {
                    operation_id: snapshot.operation_id,
                    login_id: snapshot.login_id,
                },
            )
            .unwrap();
    }
    snapshot
}
#[test]
fn account_updated_requires_fresh_observation_not_a_stale_confirmed_label() {
    let runtime = Runtime::default();
    let _temp = attach(&runtime, "external_logout", 1);
    let start = runtime
        .configure(
            &scope(1),
            CommandInput::ApiKey {
                key: "SYNTHETIC-ONLY".into(),
            },
        )
        .unwrap();
    let done = poll(&runtime, start, |phase| phase == Phase::Confirmed);
    assert!(done.account_state == AccountState::ApiKey);
    std::thread::sleep(Duration::from_millis(140));
    let next = runtime
        .configure(
            &scope(1),
            CommandInput::Status {
                operation_id: done.operation_id,
                login_id: done.login_id,
            },
        )
        .unwrap();
    assert!(next.phase == Phase::Confirmed); // The past operation completed, not a ready Runtime.
    assert!(next.account_state == AccountState::Unauthenticated);
    runtime.stop(&scope(1)).unwrap();
}

#[test]
fn key_cancellation_stays_unknown_after_late_commit_and_rejects_new_mutations() {
    let runtime = Runtime::default();
    let _temp = attach(&runtime, "delayed_key", 1);
    let start = runtime
        .configure(
            &scope(1),
            CommandInput::ApiKey {
                key: "SYNTHETIC-ONLY".into(),
            },
        )
        .unwrap();
    let canceled = runtime
        .configure(
            &scope(1),
            CommandInput::Cancel {
                operation_id: start.operation_id,
                login_id: start.login_id,
            },
        )
        .unwrap();
    assert!(canceled.phase == Phase::Unknown);
    std::thread::sleep(Duration::from_millis(160));
    let still = runtime
        .configure(
            &scope(1),
            CommandInput::Status {
                operation_id: canceled.operation_id,
                login_id: canceled.login_id,
            },
        )
        .unwrap();
    assert!(still.phase == Phase::Unknown);
    assert!(still.account_state == AccountState::Unconfirmed);
    assert!(runtime.configure(&scope(1), CommandInput::Logout).is_err());
    runtime.stop(&scope(1)).unwrap();
}

#[test]
fn synthetic_key_and_logout_are_ephemeral_and_never_model_verification() {
    let runtime = Runtime::default();
    let _temp = attach(&runtime, "waiting", 1);
    let start = runtime
        .configure(
            &scope(1),
            CommandInput::ApiKey {
                key: "SYNTHETIC-ONLY".into(),
            },
        )
        .unwrap();
    let done = poll(&runtime, start, |phase| phase == Phase::Confirmed);
    assert!(done.account_state == AccountState::ApiKey);
    assert!(done.payload.is_none());
    let serialized = serde_json::to_string(&done).unwrap();
    assert!(!serialized.contains("SYNTHETIC-ONLY"));
    assert!(!serialized.contains("verified"));
    let logout = runtime.configure(&scope(1), CommandInput::Logout).unwrap();
    let done = poll(&runtime, logout, |phase| phase == Phase::Confirmed);
    assert!(done.account_state == AccountState::Unauthenticated);
    let events = runtime
        .connection()
        .unwrap()
        .lock()
        .unwrap()
        .events()
        .unwrap();
    assert!(!serde_json::to_string(&events).unwrap().contains("account/"));
    runtime.stop(&scope(1)).unwrap();
}
#[test]
fn browser_device_instructions_and_early_completion_remain_configure_only() {
    for device in [false, true] {
        let runtime = Runtime::default();
        let _temp = attach(&runtime, "waiting", 1);
        let start = runtime
            .configure(
                &scope(1),
                if device {
                    CommandInput::Device
                } else {
                    CommandInput::Browser
                },
            )
            .unwrap();
        let waiting = poll(&runtime, start, |phase| phase == Phase::Waiting);
        assert!(waiting.payload.is_some());
        assert!(runtime.configure(&scope(1), CommandInput::Browser).is_err());
        assert!(runtime.read(&scope(1), ReadMethod::Account).is_err());
        assert!(
            runtime
                .configure(
                    &scope(2),
                    CommandInput::Cancel {
                        operation_id: waiting.operation_id,
                        login_id: waiting.login_id.clone()
                    }
                )
                .is_err()
        );
        assert!(
            runtime
                .configure(
                    &scope(1),
                    CommandInput::Status {
                        operation_id: waiting.operation_id + 1,
                        login_id: waiting.login_id.clone()
                    }
                )
                .is_err()
        );
        let canceled = runtime
            .configure(
                &scope(1),
                CommandInput::Cancel {
                    operation_id: waiting.operation_id,
                    login_id: waiting.login_id,
                },
            )
            .unwrap();
        assert!(canceled.payload.is_none());
        let canceled = poll(&runtime, canceled, |phase| phase == Phase::Canceled);
        std::thread::sleep(Duration::from_millis(40));
        assert!(
            runtime
                .configure(
                    &scope(1),
                    CommandInput::Status {
                        operation_id: canceled.operation_id,
                        login_id: canceled.login_id
                    }
                )
                .unwrap()
                .phase
                == Phase::Canceled
        );
        let events = runtime
            .connection()
            .unwrap()
            .lock()
            .unwrap()
            .events()
            .unwrap();
        let bytes = serde_json::to_string(&events).unwrap();
        for secret in [
            "account/",
            "SYNTHETIC-URL",
            "SYNTHETIC-CODE",
            "DO-NOT-ROUTE",
        ] {
            assert!(!bytes.contains(secret));
        }
        runtime.stop(&scope(1)).unwrap();
    }
    let runtime = Runtime::default();
    let _temp = attach(&runtime, "early", 1);
    let start = runtime.configure(&scope(1), CommandInput::Browser).unwrap();
    let done = poll(&runtime, start, |phase| phase == Phase::Confirmed);
    assert!(done.account_state == AccountState::Chatgpt);
    assert!(done.payload.is_none());
    runtime.stop(&scope(1)).unwrap();
}
#[test]
fn cancel_before_login_reply_and_not_found_do_not_invent_credential_rollback() {
    for mode in ["delayed_login", "cancel_not_found"] {
        let runtime = Runtime::default();
        let _temp = attach(&runtime, mode, 1);
        let mut start = runtime.configure(&scope(1), CommandInput::Browser).unwrap();
        if mode == "cancel_not_found" {
            start = poll(&runtime, start, |phase| phase == Phase::Waiting);
        }
        let cancel = runtime
            .configure(
                &scope(1),
                CommandInput::Cancel {
                    operation_id: start.operation_id,
                    login_id: start.login_id,
                },
            )
            .unwrap();
        let end = poll(&runtime, cancel, |phase| {
            matches!(phase, Phase::Canceled | Phase::Unknown)
        });
        assert!(end.payload.is_none());
        assert!(matches!(end.credential_state, CredentialState::Unknown));
        if mode == "cancel_not_found" {
            assert!(end.phase == Phase::Unknown);
            assert!(runtime.configure(&scope(1), CommandInput::Device).is_err());
        }
        runtime.stop(&scope(1)).unwrap();
    }
}
#[test]
fn stop_during_configure_wait_retires_the_old_request_before_reconnect() {
    let runtime = Arc::new(Runtime::default());
    let _first = attach(&runtime, "early_slow", 1);
    let start = runtime.configure(&scope(1), CommandInput::Browser).unwrap();
    std::thread::sleep(Duration::from_millis(30));
    let worker = runtime.clone();
    let reply = std::thread::spawn(move || {
        worker.configure(
            &scope(1),
            CommandInput::Status {
                operation_id: start.operation_id,
                login_id: start.login_id,
            },
        )
    });
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        if runtime
            .connection()
            .unwrap()
            .lock()
            .unwrap()
            .control
            .flow
            .as_ref()
            .unwrap()
            .in_flight
        {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::yield_now();
    }
    runtime.stop(&scope(1)).unwrap();
    let _second = attach(&runtime, "waiting", 2);
    assert!(reply.join().unwrap().is_err());
    assert!(
        runtime
            .connection()
            .unwrap()
            .lock()
            .unwrap()
            .control
            .flow
            .is_none()
    );
    runtime.stop(&scope(2)).unwrap();
}

#[test]
fn reconnect_discards_ephemeral_configuration_and_rejects_old_generation() {
    let runtime = Runtime::default();
    let _first = attach(&runtime, "waiting", 1);
    let start = runtime.configure(&scope(1), CommandInput::Device).unwrap();
    let waiting = poll(&runtime, start, |phase| phase == Phase::Waiting);
    runtime.stop(&scope(1)).unwrap();
    let _second = attach(&runtime, "waiting", 2);
    assert!(
        runtime
            .configure(
                &scope(1),
                CommandInput::Cancel {
                    operation_id: waiting.operation_id,
                    login_id: waiting.login_id
                }
            )
            .is_err()
    );
    assert_eq!(
        runtime.read(&scope(2), ReadMethod::Account).unwrap()["account"],
        json!({"account":null,"requiresOpenaiAuth":true})
    );
    assert!(
        runtime
            .connection()
            .unwrap()
            .lock()
            .unwrap()
            .control
            .flow
            .is_none()
    );
    runtime.stop(&scope(2)).unwrap();
}
