use super::*;
#[cfg(unix)]
use std::os::unix::fs::symlink;
use std::path::PathBuf;
#[cfg(unix)]
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock, atomic::AtomicU32},
    time::{Duration, Instant},
};

#[cfg(unix)]
struct ReapFixture {
    pty: Arc<PtyManager>,
    id: String,
}
#[cfg(unix)]
impl Drop for ReapFixture {
    fn drop(&mut self) {
        let _ = self.pty.close(&self.id);
    }
}

fn fixture() -> (tempfile::TempDir, MetaStore, AgentRow, PathBuf) {
    fixture_with_layout(false)
}
fn fixture_with_layout(encoded: bool) -> (tempfile::TempDir, MetaStore, AgentRow, PathBuf) {
    let data = tempfile::tempdir().unwrap();
    let root = data
        .path()
        .canonicalize()
        .unwrap()
        .join(if encoded || cfg!(windows) {
            "agent-installations/agent-registry%3Agoose/install-fixture"
        } else {
            "agents/registry:goose/install-fixture"
        });
    std::fs::create_dir_all(&root).unwrap();
    let program = root.join(if cfg!(windows) { "goose.exe" } else { "goose" });
    std::fs::write(&program, "#!/bin/sh\nexit 0\n").unwrap();
    crate::process_platform::set_executable(&program).unwrap();
    let row = AgentRow {
        id: "registry:goose".into(),
        name: "Goose".into(),
        source: "registry".into(),
        command: program.display().to_string(),
        args: vec!["acp".into()],
        env: vec![],
        version: Some("1.52.0".into()),
        handshake: Some(
            serde_json::json!({"authMethods":[{"id":"goose-provider","name":"Provider"}],"kept":"unknown envelope"}),
        ),
        created_at: 1,
        updated_at: 1,
    };
    let store = MetaStore::open(&data.path().join("meta.db")).unwrap();
    store.insert_agent(&row).unwrap();
    crate::installations::record(&store, &row, &root).unwrap();
    (data, store, row, root)
}

#[test]
fn service_configuration_has_a_scoped_preview_without_execution_or_auth_mutation() {
    let (data, store, row, root) = fixture();
    let marker = root.join("must-not-exist");
    std::fs::write(
        &row.command,
        format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
    )
    .unwrap();
    let action = actions_for(&store, &row, data.path()).unwrap().remove(0);
    assert_eq!(action.purpose, "service_configuration");
    assert_eq!(action.transport, "terminal");
    assert_eq!(action.command, row.command);
    assert_eq!(action.args, ["configure"]);
    assert!(action.source_url.contains("/v1.52.0/"));
    assert!(!marker.exists());
    assert_eq!(store.get_agent(&row.id).unwrap().unwrap(), row);
    let preview = serde_json::to_value(action).unwrap();
    assert!(preview.get("env").is_none());
    assert!(preview.get("methodId").is_none());
}

#[test]
fn service_configuration_never_uses_only_a_name_or_id_as_provenance() {
    let (data, store, original, _) = fixture();
    for kind in ["custom", "id", "version", "args", "env", "file"] {
        let mut row = original.clone();
        match kind {
            "custom" => row.source = "custom".into(),
            "id" => row.id = "custom-goose".into(),
            "version" => row.version = None,
            "args" => row.args.push("unverified".into()),
            "env" => row.env.push(("PROVIDER_KEY".into(), "__keychain__".into())),
            "file" => row.command = "/bin/sh".into(),
            _ => unreachable!(),
        }
        assert!(
            actions_for(&store, &row, data.path()).unwrap().is_empty(),
            "{kind}"
        );
    }
    let records = store.get_setting("installations.v1").unwrap().unwrap();
    for kind in [
        "missing",
        "source",
        "version",
        "args",
        "command",
        "ownership",
    ] {
        let mut changed = records.clone();
        match kind {
            "missing" => changed = serde_json::json!([]),
            "source" => changed[0]["source"] = "external".into(),
            "version" => changed[0]["version"] = "1.53.0".into(),
            "args" => changed[0]["args"] = serde_json::json!([]),
            "command" => changed[0]["command"] = "/bin/sh".into(),
            "ownership" => changed[0]["managedRoot"] = serde_json::Value::Null,
            _ => unreachable!(),
        }
        store.set_setting("installations.v1", &changed).unwrap();
        assert!(
            actions_for(&store, &original, data.path())
                .unwrap()
                .is_empty(),
            "{kind}"
        );
    }
}

#[test]
fn service_configuration_rederives_review_and_rejects_old_or_arbitrary_commands() {
    let (data, store, row, _) = fixture();
    let action = actions_for(&store, &row, data.path()).unwrap().remove(0);
    assert_eq!(
        reviewed_action(
            &store,
            &row,
            data.path(),
            &action.id,
            &action.command,
            &action.args
        )
        .unwrap(),
        action
    );
    assert!(
        reviewed_action(
            &store,
            &row,
            data.path(),
            &action.id,
            "/bin/sh",
            &action.args
        )
        .is_err()
    );
    assert!(
        reviewed_action(
            &store,
            &row,
            data.path(),
            &action.id,
            &action.command,
            &["acp".into(), "configure".into()]
        )
        .is_err()
    );
    assert!(
        reviewed_action(
            &store,
            &row,
            data.path(),
            "unknown",
            &action.command,
            &action.args
        )
        .is_err()
    );
    let mut changed = row.clone();
    changed.version = Some("1.53.0".into());
    assert!(
        reviewed_action(
            &store,
            &changed,
            data.path(),
            &action.id,
            &action.command,
            &action.args
        )
        .is_err()
    );
    assert!(attempts::require_existing_source(Some("service-revision")).is_err());
}

#[test]
#[cfg(unix)]
fn service_configuration_rejects_a_managed_directory_or_binary_symlink_escape() {
    let (data, store, row, root) = fixture();
    let outside = data.path().canonicalize().unwrap().join("outside");
    std::fs::create_dir(&outside).unwrap();
    let external = outside.join("goose");
    std::fs::write(&external, "#!/bin/sh\nexit 0\n").unwrap();
    crate::process_platform::set_executable(&external).unwrap();
    std::fs::remove_file(&row.command).unwrap();
    symlink(&external, &row.command).unwrap();
    assert!(actions_for(&store, &row, data.path()).unwrap().is_empty());
    std::fs::remove_dir_all(&root).unwrap();
    symlink(&outside, &root).unwrap();
    assert!(actions_for(&store, &row, data.path()).unwrap().is_empty());
    assert!(external.exists());
}

#[cfg(unix)]
fn api_connection(
    manager: &AcpManager,
    row: &AgentRow,
) -> Arc<super::super::lifecycle::ConnectionLife> {
    let life = super::super::lifecycle::ConnectionLife::new();
    life.ready().unwrap();
    let (command_tx, _) = tokio::sync::mpsc::unbounded_channel();
    manager.lock().unwrap().insert(
        super::super::manager::ConnectionKey {
            agent_id: row.id.clone(),
            cwd: PathBuf::from("/api-fixture"),
            candidate: false,
            conversation_id: None,
            service: Some("service-fixture".into()),
        },
        super::super::manager::ManagedConnection {
            launch_identity: None,
            connection_id: "fixture-connection".into(),
            account: Default::default(),
            account_query: None,
            command_tx,
            state: life.state.clone(),
            handshake: Arc::new(OnceLock::new()),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            child_pid: Arc::new(AtomicU32::new(0)),
            browser_launch: None,
            mcp_spawn_facts: Arc::new(std::sync::OnceLock::new()),
            life: life.clone(),
            service: None,
        },
    );
    life
}

#[tokio::test]
#[cfg(unix)]
async fn service_configuration_terminal_keeps_attempt_and_scope_until_exact_reap() {
    let (data, store, row, _) = fixture();
    let manager = AcpManager::new(data.path().into(), data.path().into());
    let api = api_connection(&manager, &row);
    let pty = Arc::new(PtyManager::new());
    let action = actions_for(&store, &row, data.path()).unwrap().remove(0);
    let before = store.list_settings().unwrap();
    attempts::auth_cancel(row.id.clone(), "service-early".into()).unwrap();
    let attempt = attempts::reserve(&row.id, "service-early").unwrap();
    let configuration = crate::install_job::configuration_guard(&row.id).await;
    let error = run_terminal(
        &manager,
        &pty,
        &row,
        &action,
        data.path(),
        TerminalOwnership {
            configuration,
            attempt,
            output: Channel::new(|_| Ok(())),
        },
    )
    .unwrap_err();
    assert_eq!(error, "AUTH_CANCELLED");
    assert!(api.work().is_ok());

    let started = data.path().join("started");
    std::fs::write(
        &row.command,
        format!(
            "#!/bin/sh\ntrap '' HUP TERM\ntouch '{}'\nwhile :; do read token; done\n",
            started.display()
        ),
    )
    .unwrap();
    let attempt = attempts::reserve(&row.id, "service-running").unwrap();
    let configuration = crate::install_job::configuration_guard(&row.id).await;
    let id = run_terminal(
        &manager,
        &pty,
        &row,
        &action,
        data.path(),
        TerminalOwnership {
            configuration,
            attempt,
            output: Channel::new(|_| Ok(())),
        },
    )
    .unwrap();
    let _reap_on_panic = ReapFixture {
        pty: pty.clone(),
        id: id.clone(),
    };
    let deadline = Instant::now() + Duration::from_secs(3);
    while !started.exists() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(started.exists());
    assert!(api.work().is_err());
    assert!(attempts::reserve(&row.id, "duplicate").is_err());
    attempts::auth_cancel(row.id.clone(), "service-running".into()).unwrap();
    assert!(
        tokio::time::timeout(
            Duration::from_millis(10),
            crate::install_job::configuration_guard(&row.id)
        )
        .await
        .is_err()
    );
    assert!(api.work().is_err());
    let owned_pty = pty.clone();
    let owned_id = id.clone();
    tokio::time::timeout(
        Duration::from_secs(6),
        tokio::task::spawn_blocking(move || owned_pty.await_exit(&owned_id)),
    )
    .await
    .unwrap()
    .unwrap()
    .unwrap();
    let configuration = tokio::time::timeout(
        Duration::from_secs(1),
        crate::install_job::configuration_guard(&row.id),
    )
    .await
    .unwrap();
    assert!(api.work().is_ok());
    assert!(attempts::reserve(&row.id, "next").is_ok());
    assert_eq!(store.list_settings().unwrap(), before);
    assert_eq!(store.get_agent(&row.id).unwrap().unwrap(), row);
    assert_eq!(manager.status(&row.id).unwrap().len(), 1);
    drop(configuration);
    pty.close(&id).unwrap();
}

#[test]
fn encoded_goose_root_keeps_the_existing_configuration_action_proof() {
    let (data, store, row, _) = fixture_with_layout(true);
    let action = actions_for(&store, &row, data.path()).unwrap().remove(0);
    assert_eq!(action.command, row.command);
    assert_eq!(action.args, ["configure"]);
    let mut receipt = store.get_setting("installations.v1").unwrap().unwrap();
    receipt[0]["programOnly"] = serde_json::json!(true);
    store.set_setting("installations.v1", &receipt).unwrap();
    assert!(actions_for(&store, &row, data.path()).unwrap().is_empty());
}

fn npm_fixture(encoded: bool) -> (tempfile::TempDir, MetaStore, AgentRow, PathBuf) {
    let data = tempfile::tempdir().unwrap();
    let base = data.path().canonicalize().unwrap();
    let root = base.join(if encoded || cfg!(windows) {
        "agent-installations/agent-registry%3Acline/install-fixture"
    } else {
        "agents/registry:cline/install-fixture"
    });
    let package = root.join("node_modules/cline");
    std::fs::create_dir_all(package.join("bin")).unwrap();
    let loader = package.join("bin/cline");
    std::fs::write(&loader, "// controlled public loader fixture\n").unwrap();
    std::fs::write(
        package.join("package.json"),
        serde_json::to_vec(&serde_json::json!({
            "name":"cline", "version":"3.0.65", "bin":{"cline":"./bin/cline"},
            "repository":{"type":"git","url":"git+https://github.com/cline/cline.git","directory":"apps/cli"}
        })).unwrap(),
    ).unwrap();
    let node = base.join(if cfg!(windows) {
        "shared-node/node.exe"
    } else {
        "shared-node/bin/node"
    });
    std::fs::create_dir_all(node.parent().unwrap()).unwrap();
    std::fs::write(
        &node,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\n",
            root.join("invocation").display()
        ),
    )
    .unwrap();
    crate::process_platform::set_executable(&node).unwrap();
    let row = AgentRow {
        id: "registry:cline".into(),
        name: "Cline".into(),
        source: "registry".into(),
        command: node.display().to_string(),
        args: vec![loader.display().to_string(), "--acp".into()],
        env: vec![],
        version: Some("3.0.65".into()),
        handshake: Some(serde_json::json!({
            "authMethods":[
                {"id":"fixture-one","name":"One","type":"agent"},
                {"id":"fixture-two","name":"Two","type":"agent"},
                {"id":"fixture-three","name":"Three","type":"agent"}
            ], "kept":"unknown envelope"
        })),
        created_at: 1,
        updated_at: 1,
    };
    let store = MetaStore::open(&data.path().join("meta.db")).unwrap();
    store.insert_agent(&row).unwrap();
    crate::installations::record(&store, &row, &root).unwrap();
    (data, store, row, root)
}

#[test]
fn service_configuration_npm_preview_keeps_shared_node_loader_and_protocol_methods() {
    for encoded in [false, true] {
        let (data, store, row, root) = npm_fixture(encoded);
        let before = store.list_settings().unwrap();
        assert!(!Path::new(&row.command).starts_with(&root));
        let actions = actions_for(&store, &row, data.path()).unwrap();
        assert_eq!(actions.len(), 1);
        let action = &actions[0];
        assert_eq!(action.command, row.command);
        assert_eq!(action.args, [row.args[0].clone(), "auth".into()]);
        assert_eq!(action.purpose, "service_configuration");
        assert_eq!(action.transport, "terminal");
        assert_eq!(
            action.source_url,
            "https://github.com/cline/cline/tree/main/apps/cli"
        );
        assert!(
            !root.join("invocation").exists(),
            "preview must not execute Node"
        );
        assert_eq!(store.get_agent(&row.id).unwrap().unwrap(), row);
        assert_eq!(store.list_settings().unwrap(), before);
        let preview = serde_json::to_value(action).unwrap();
        assert!(preview.get("methodId").is_none());
        assert!(preview.get("env").is_none());
    }
}

#[test]
fn service_configuration_npm_rejects_unverified_registration_receipts_and_manifest() {
    let (data, store, original, root) = npm_fixture(true);
    for kind in [
        "custom", "id", "version", "empty", "args", "flag", "node", "loader", "env",
    ] {
        let mut row = original.clone();
        match kind {
            "custom" => row.source = "custom".into(),
            "id" => row.id = "custom-cline".into(),
            "version" => row.version = Some("3.0.67".into()),
            "empty" => row.args.clear(),
            "args" => row.args.push("unverified".into()),
            "flag" => row.args[1] = "auth".into(),
            "node" => row.command = "node".into(),
            "loader" => row.args[0] = "bin/cline".into(),
            "env" => row.env.push(("PROVIDER_KEY".into(), "__keychain__".into())),
            _ => unreachable!(),
        }
        assert!(
            actions_for(&store, &row, data.path()).unwrap().is_empty(),
            "{kind}"
        );
    }
    let records = store.get_setting("installations.v1").unwrap().unwrap();
    for kind in [
        "missing",
        "duplicate",
        "source",
        "version",
        "args",
        "command",
        "ownership",
        "path",
        "identity",
        "program",
    ] {
        let mut changed = records.clone();
        match kind {
            "missing" => changed = serde_json::json!([]),
            "duplicate" => changed.as_array_mut().unwrap().push(records[0].clone()),
            "source" => changed[0]["source"] = "external".into(),
            "version" => changed[0]["version"] = "3.0.67".into(),
            "args" => changed[0]["args"] = serde_json::json!([]),
            "command" => changed[0]["command"] = "/bin/sh".into(),
            "ownership" => changed[0]["managedRoot"] = serde_json::Value::Null,
            "path" => changed[0]["path"] = original.command.clone().into(),
            "identity" => changed[0]["id"] = "unrelated".into(),
            "program" => changed[0]["programOnly"] = true.into(),
            _ => unreachable!(),
        }
        store.set_setting("installations.v1", &changed).unwrap();
        assert!(
            actions_for(&store, &original, data.path())
                .unwrap()
                .is_empty(),
            "{kind}"
        );
    }
    store.set_setting("installations.v1", &records).unwrap();
    let path = root.join("node_modules/cline/package.json");
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    for kind in ["name", "version", "bin", "entry", "large"] {
        let mut changed = manifest.clone();
        match kind {
            "name" => changed["name"] = "unrelated".into(),
            "version" => changed["version"] = "3.0.67".into(),
            "bin" => changed["bin"] = "./bin/cline".into(),
            "entry" => changed["bin"]["cline"] = "./bin/other".into(),
            "large" => changed["extra"] = "x".repeat(64 * 1024).into(),
            _ => unreachable!(),
        }
        std::fs::write(&path, serde_json::to_vec(&changed).unwrap()).unwrap();
        assert!(
            actions_for(&store, &original, data.path())
                .unwrap()
                .is_empty(),
            "{kind}"
        );
    }
    assert!(!root.join("invocation").exists());
    assert_eq!(store.get_agent(&original.id).unwrap().unwrap(), original);
}

#[test]
#[cfg(unix)]
fn service_configuration_npm_rejects_loader_package_or_manifest_aliases() {
    for kind in ["loader", "package", "manifest"] {
        let (data, store, row, root) = npm_fixture(true);
        let package = root.join("node_modules/cline");
        let outside = data.path().canonicalize().unwrap().join("outside-package");
        std::fs::create_dir_all(outside.join("bin")).unwrap();
        std::fs::copy(package.join("package.json"), outside.join("package.json")).unwrap();
        std::fs::copy(package.join("bin/cline"), outside.join("bin/cline")).unwrap();
        match kind {
            "loader" => {
                std::fs::remove_file(package.join("bin/cline")).unwrap();
                symlink(outside.join("bin/cline"), package.join("bin/cline")).unwrap();
            }
            "package" => {
                std::fs::remove_dir_all(&package).unwrap();
                symlink(&outside, &package).unwrap();
            }
            "manifest" => {
                std::fs::remove_file(package.join("package.json")).unwrap();
                symlink(outside.join("package.json"), package.join("package.json")).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            actions_for(&store, &row, data.path()).unwrap().is_empty(),
            "{kind}"
        );
        assert!(outside.join("bin/cline").exists());
        assert!(!root.join("invocation").exists());
    }
}

#[test]
fn service_configuration_npm_rederives_reviewed_prefix_and_public_package() {
    let (data, store, row, root) = npm_fixture(true);
    let action = actions_for(&store, &row, data.path()).unwrap().remove(0);
    assert!(
        reviewed_action(
            &store,
            &row,
            data.path(),
            &action.id,
            &action.command,
            &["auth".into()]
        )
        .is_err()
    );
    assert!(
        reviewed_action(
            &store,
            &row,
            data.path(),
            &action.id,
            "/bin/sh",
            &action.args
        )
        .is_err()
    );
    assert_eq!(
        reviewed_action(
            &store,
            &row,
            data.path(),
            &action.id,
            &action.command,
            &action.args
        )
        .unwrap(),
        action
    );
    let path = root.join("node_modules/cline/package.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    manifest["bin"]["cline"] = "./bin/changed".into();
    std::fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert!(
        reviewed_action(
            &store,
            &row,
            data.path(),
            &action.id,
            &action.command,
            &action.args
        )
        .is_err()
    );
    assert!(!root.join("invocation").exists());
}

#[tokio::test]
#[cfg(unix)]
async fn service_configuration_npm_terminal_uses_exact_loader_then_auth_without_metadata_changes() {
    let (data, store, row, root) = npm_fixture(true);
    let before = store.list_settings().unwrap();
    let manager = AcpManager::new(data.path().into(), data.path().into());
    let pty = Arc::new(PtyManager::new());
    let action = actions_for(&store, &row, data.path()).unwrap().remove(0);
    let attempt = attempts::reserve(&row.id, "npm-action-fixture").unwrap();
    let configuration = crate::install_job::configuration_guard(&row.id).await;
    let id = run_terminal(
        &manager,
        &pty,
        &row,
        &action,
        data.path(),
        TerminalOwnership {
            configuration,
            attempt,
            output: Channel::new(|_| Ok(())),
        },
    )
    .unwrap();
    let _reap_on_panic = ReapFixture {
        pty: pty.clone(),
        id: id.clone(),
    };
    let owned_pty = pty.clone();
    let owned_id = id.clone();
    let code = tokio::time::timeout(
        Duration::from_secs(6),
        tokio::task::spawn_blocking(move || owned_pty.await_exit(&owned_id)),
    )
    .await
    .unwrap()
    .unwrap()
    .unwrap();
    assert_eq!(code, 0);
    assert_eq!(
        std::fs::read_to_string(root.join("invocation")).unwrap(),
        format!("{}\nauth\n", row.args[0])
    );
    assert_eq!(store.get_agent(&row.id).unwrap().unwrap(), row);
    assert_eq!(store.list_settings().unwrap(), before);
    assert!(attempts::reserve(&row.id, "npm-action-next").is_ok());
    assert!(manager.status(&row.id).unwrap().is_empty());
}
