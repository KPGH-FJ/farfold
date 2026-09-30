use super::*;
use std::{
    collections::HashMap,
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock, atomic::AtomicU32},
    time::{Duration, Instant},
};

struct ReapFixture {
    pty: Arc<PtyManager>,
    id: String,
}
impl Drop for ReapFixture {
    fn drop(&mut self) {
        let _ = self.pty.close(&self.id);
    }
}

fn fixture() -> (tempfile::TempDir, MetaStore, AgentRow, PathBuf) {
    let data = tempfile::tempdir().unwrap();
    let root = data
        .path()
        .canonicalize()
        .unwrap()
        .join("agents/registry:goose/install-fixture");
    std::fs::create_dir_all(&root).unwrap();
    let program = root.join("goose");
    std::fs::write(&program, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
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
fn service_configuration_rejects_a_managed_directory_or_binary_symlink_escape() {
    let (data, store, row, root) = fixture();
    let outside = data.path().canonicalize().unwrap().join("outside");
    std::fs::create_dir(&outside).unwrap();
    let external = outside.join("goose");
    std::fs::write(&external, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&external, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::remove_file(&row.command).unwrap();
    symlink(&external, &row.command).unwrap();
    assert!(actions_for(&store, &row, data.path()).unwrap().is_empty());
    std::fs::remove_dir_all(&root).unwrap();
    symlink(&outside, &root).unwrap();
    assert!(actions_for(&store, &row, data.path()).unwrap().is_empty());
    assert!(external.exists());
}

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
            service: Some("service-fixture".into()),
        },
        super::super::manager::ManagedConnection {
            command_tx,
            state: life.state.clone(),
            handshake: Arc::new(OnceLock::new()),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            child_pid: Arc::new(AtomicU32::new(0)),
            life: life.clone(),
            service: None,
        },
    );
    life
}

#[tokio::test]
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
