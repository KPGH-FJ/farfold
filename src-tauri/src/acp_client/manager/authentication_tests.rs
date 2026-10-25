use super::*;

fn register(
    manager: &AcpManager,
    cwd: &str,
    service: Option<&str>,
    candidate: bool,
) -> (
    Arc<ConnectionLife>,
    mpsc::UnboundedReceiver<super::super::operations::QueuedCommand>,
) {
    register_method(
        manager,
        cwd,
        service,
        candidate,
        serde_json::json!({"id":"login","name":"Login"}),
    )
}

fn register_method(
    manager: &AcpManager,
    cwd: &str,
    service: Option<&str>,
    candidate: bool,
    method: serde_json::Value,
) -> (
    Arc<ConnectionLife>,
    mpsc::UnboundedReceiver<super::super::operations::QueuedCommand>,
) {
    register_connection(manager, cwd, service, candidate, None, method)
}

fn register_connection(
    manager: &AcpManager,
    cwd: &str,
    service: Option<&str>,
    candidate: bool,
    conversation_id: Option<&str>,
    method: serde_json::Value,
) -> (
    Arc<ConnectionLife>,
    mpsc::UnboundedReceiver<super::super::operations::QueuedCommand>,
) {
    let (command_tx, receive) = mpsc::unbounded_channel();
    let life = ConnectionLife::new();
    life.ready().unwrap();
    let handshake = OnceLock::new();
    handshake
        .set(
            Handshake::decode(serde_json::json!({
                "protocolVersion": 1,
                "agentCapabilities": {},
                "authMethods": [method]
            }))
            .unwrap(),
        )
        .unwrap_or_else(|_| panic!("handshake was already set"));
    manager.lock().unwrap().insert(
        ConnectionKey {
            agent_id: "example".into(),
            cwd: PathBuf::from(cwd),
            candidate,
            conversation_id: conversation_id.map(str::to_string),
            service: service.map(str::to_string),
        },
        ManagedConnection {
            launch_identity: None,
            connection_id: "fixture-connection".into(),
            account: Default::default(),
            account_query: None,
            workspace_access: crate::acp_client::workspace_access::Availability::new(None),
            command_tx,
            state: life.state.clone(),
            handshake: Arc::new(handshake),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            child_pid: Arc::new(AtomicU32::new(0)),
            browser_launch: None,
            mcp_spawn_facts: Arc::new(std::sync::OnceLock::new()),
            life: life.clone(),
            service: None,
        },
    );
    (life, receive)
}

#[tokio::test]
async fn unknown_or_malformed_terminal_extensions_do_not_dispatch_protocol_authentication() {
    for metadata in [
        serde_json::json!(true),
        serde_json::json!([]),
        serde_json::json!({"command":"/unknown/login","args":["login",false]}),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let manager = AcpManager::new(directory.path().into(), directory.path().into());
        let (_, mut commands) = register_method(
            &manager,
            "/a",
            None,
            false,
            serde_json::json!({"id":"login","name":"Login","_meta":{"terminal-auth":metadata}}),
        );
        let outcome = tokio::time::timeout(
            Duration::from_millis(40),
            manager.authenticate(
                "example",
                Path::new("/a"),
                "login",
                AuthenticationOperation::new(),
                Arc::new(|| {}),
            ),
        )
        .await;
        assert!(
            matches!(outcome, Ok(Err(_))),
            "unsafe extension reached protocol authentication"
        );
        assert!(commands.try_recv().is_err());
    }
}

#[tokio::test]
async fn auth_declaration_unknown_types_never_dispatch_after_live_sdk_decode() {
    for kind in ["env_var", "future-login"] {
        let directory = tempfile::tempdir().unwrap();
        let manager = AcpManager::new(directory.path().into(), directory.path().into());
        let (_, mut commands) = register_method(
            &manager,
            "/a",
            None,
            false,
            serde_json::json!({"id":"login","name":"Login","type":kind,"vars":[{"name":"FIXTURE_KEY"}]}),
        );
        let outcome = tokio::time::timeout(
            Duration::from_millis(40),
            manager.authenticate(
                "example",
                Path::new("/a"),
                "login",
                AuthenticationOperation::new(),
                Arc::new(|| {}),
            ),
        )
        .await;
        assert!(
            matches!(outcome, Ok(Err(_))),
            "unknown auth reached dispatcher"
        );
        assert!(commands.try_recv().is_err());
    }
}

#[tokio::test]
async fn authentication_keeps_the_requested_directory_and_shared_scope() {
    let directory = tempfile::tempdir().unwrap();
    let manager = AcpManager::new(directory.path().into(), directory.path().into());
    let (_, mut first) = register(&manager, "/a", None, false);
    let (_, mut chosen) = register(&manager, "/b", None, false);
    let (_, mut api) = register(&manager, "/api", Some("service"), false);
    let scope = manager.reserve_account_change("example").unwrap();
    let (authenticated, ()) = tokio::join!(
        manager.authenticate(
            "example",
            Path::new("/b"),
            "login",
            AuthenticationOperation::new(),
            Arc::new(|| {})
        ),
        async {
            let queued = chosen.recv().await.unwrap();
            match queued.command {
                ManagerCommand::Authenticate {
                    method_id, result, ..
                } => {
                    assert_eq!(method_id, "login");
                    result.send(Ok(())).unwrap();
                }
                _ => panic!("only authentication should be dispatched"),
            }
        }
    );
    authenticated.unwrap();
    assert!(first.try_recv().is_err());
    assert!(api.try_recv().is_err());
    drop(scope);
}

#[test]
fn a_busy_directory_blocks_account_change_and_rolls_back_other_reservations() {
    let directory = tempfile::tempdir().unwrap();
    let manager = AcpManager::new(directory.path().into(), directory.path().into());
    let (idle, _) = register(&manager, "/a", None, false);
    let (busy, _) = register(&manager, "/b", None, false);
    let work = busy.work().unwrap();
    assert!(manager.reserve_account_change("example").is_err());
    assert!(idle.work().is_ok());
    drop(work);
    let scope = manager.reserve_account_change("example").unwrap();
    assert!(idle.work().is_err());
    assert!(busy.work().is_err());
    drop(scope);
    assert!(busy.work().is_ok());
}

#[test]
fn service_configuration_keeps_all_sources_idle_and_rolls_back_on_a_busy_api() {
    let directory = tempfile::tempdir().unwrap();
    let manager = AcpManager::new(directory.path().into(), directory.path().into());
    let (settings, _) = register(&manager, "/a", None, false);
    let (api, _) = register(&manager, "/api", Some("service"), false);
    let work = api.work().unwrap();
    assert!(manager.reserve_account_change("example").is_err());
    assert!(manager.reserve_preparation_change("example").is_err());
    assert!(settings.work().is_ok());
    drop(work);
    let scope = manager.reserve_preparation_change("example").unwrap();
    assert!(settings.work().is_err());
    assert!(api.work().is_err());
    assert!(api.operation("open:new".into()).is_err());
    assert_eq!(manager.status("example").unwrap().len(), 2);
    drop(scope);
    assert!(settings.work().is_ok());
    assert!(api.work().is_ok());
    let account = manager.reserve_account_change("example").unwrap();
    assert!(settings.work().is_err());
    assert!(api.work().is_err());
    drop(account);
    assert!(api.work().is_ok());
}

#[tokio::test]
async fn authentication_rechecks_the_exact_connections_declaration() {
    let directory = tempfile::tempdir().unwrap();
    let manager = AcpManager::new(directory.path().into(), directory.path().into());
    let (_, mut commands) = register(&manager, "/a", None, false);
    assert!(
        manager
            .authenticate(
                "example",
                Path::new("/a"),
                "another-directory-method",
                AuthenticationOperation::new(),
                Arc::new(|| {})
            )
            .await
            .is_err()
    );
    assert!(
        manager
            .logout(
                "example",
                Path::new("/a"),
                &manager.reserve_account_change("example").unwrap(),
                AuthenticationOperation::new(),
                Arc::new(|| {})
            )
            .await
            .is_err()
    );
    assert!(commands.try_recv().is_err());
}

#[tokio::test]
async fn authentication_retains_shared_scope_until_the_exact_connection_terminates() {
    let directory = tempfile::tempdir().unwrap();
    let manager = AcpManager::new(directory.path().into(), directory.path().into());
    let (selected, mut commands) = register(&manager, "/a", None, false);
    let (other, _) = register(&manager, "/b", None, false);
    let operation = async {
        let _scope = manager.reserve_account_change("example").unwrap();
        manager
            .authenticate(
                "example",
                Path::new("/a"),
                "login",
                AuthenticationOperation::new(),
                Arc::new(|| {}),
            )
            .await
    };
    tokio::pin!(operation);
    let queued = tokio::select! {
        value = &mut operation => panic!("ended before request: {value:?}"),
        queued = commands.recv() => queued.unwrap(),
    };
    selected.close(false, None).unwrap();
    if let ManagerCommand::Authenticate { result, .. } = queued.command {
        result.send(Err("AUTH_CONNECTION_CLOSED".into())).unwrap();
    } else {
        panic!("unexpected command");
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(5), &mut operation)
            .await
            .is_err()
    );
    assert!(other.work().is_err());
    selected.finish(Ok(()));
    assert!(operation.await.is_err());
    assert!(other.work().is_ok());
}

#[test]
fn borrowable_handshake_only_uses_ready_same_directory_connections() {
    let directory = tempfile::tempdir().unwrap();
    let manager = AcpManager::new(directory.path().into(), directory.path().into());
    let method = serde_json::json!({"id":"login","name":"Login"});
    assert!(
        manager
            .borrowable_handshake("example", Path::new("/a"))
            .is_none()
    );
    // Candidate and service-scoped connections never lend declarations.
    register_connection(&manager, "/a", None, true, None, method.clone());
    register_connection(&manager, "/a", Some("service"), false, None, method.clone());
    assert!(
        manager
            .borrowable_handshake("example", Path::new("/a"))
            .is_none()
    );
    // A different directory's conversation connection is not a source.
    register_connection(&manager, "/b", None, false, Some("conv-b"), method.clone());
    assert!(
        manager
            .borrowable_handshake("example", Path::new("/a"))
            .is_none()
    );
    register_connection(&manager, "/a", None, false, Some("conv-a"), method.clone());
    assert!(
        manager
            .borrowable_handshake("example", Path::new("/a"))
            .is_some()
    );
}

#[test]
fn borrowable_handshake_prefers_the_preparation_connection() {
    let directory = tempfile::tempdir().unwrap();
    let manager = AcpManager::new(directory.path().into(), directory.path().into());
    register_connection(
        &manager,
        "/a",
        None,
        false,
        Some("conv-a"),
        serde_json::json!({"id":"conversation-login","name":"Login"}),
    );
    register_connection(
        &manager,
        "/a",
        None,
        false,
        None,
        serde_json::json!({"id":"preparation-login","name":"Login"}),
    );
    let borrowed = manager
        .borrowable_handshake("example", Path::new("/a"))
        .unwrap();
    let ids = borrowed.get().unwrap().auth_ids();
    assert_eq!(ids, ["preparation-login"]);
}

#[test]
fn a_closed_conversation_connection_is_not_borrowable() {
    let directory = tempfile::tempdir().unwrap();
    let manager = AcpManager::new(directory.path().into(), directory.path().into());
    let (life, _) = register_connection(
        &manager,
        "/a",
        None,
        false,
        Some("conv-a"),
        serde_json::json!({"id":"login","name":"Login"}),
    );
    assert!(
        manager
            .borrowable_handshake("example", Path::new("/a"))
            .is_some()
    );
    life.close(false, None).unwrap();
    assert!(
        manager
            .borrowable_handshake("example", Path::new("/a"))
            .is_none()
    );
}
