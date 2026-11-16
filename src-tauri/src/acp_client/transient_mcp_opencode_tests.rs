//! Real owned synthetic subprocesses, not official OpenCode or browser helpers.
use super::*;
use crate::acp_client::{browser_capability::LaunchKind, transient_mcp::McpUnavailable};
use sha2::{Digest, Sha256};

fn token_digest(token: &[u8]) -> String {
    Sha256::digest(token)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    let code = PEER
        .replace("import sys,json,os,time", "import sys,json,os,time,hashlib")
        .replace("mode,root=sys.argv[1:3]", &format!("mode,root='ok',{}", serde_json::to_string(&cwd.to_string_lossy()).unwrap()))
        .replace("'cwdMatches':", "'tokenDigest':hashlib.sha256(actual.encode()).hexdigest(), 'pid':os.getpid(), 'cwdMatches':");
    let script = crate::platform_tests::python_peer(&cwd, "opencode", &code);
    let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
    let row = AgentRow {
        id: "opencode".into(),
        name: "Controlled stdio peer".into(),
        source: "discovered".into(),
        command: script.to_string_lossy().into(),
        args: vec!["acp".into()],
        env: vec![
            ("OPENCODE_AUTO_HEAP_SNAPSHOT".into(), "false".into()),
            ("OTEL_EXPORTER_OTLP_ENDPOINT".into(), "".into()),
            // Unrelated Codex values cannot change this source's decision.
            ("APP_SERVER_LOGS".into(), "synthetic-nonempty".into()),
            ("CODEX_CONFIG".into(), "not-codex-configuration".into()),
        ],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    };
    store.insert_agent(&row).unwrap();
    let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
    Fixture {
        _dir: dir,
        cwd,
        store,
        manager,
        row,
    }
}

fn distinct_offer(owner: Arc<OwnerWitness>, token: &str) -> TransientMcpOpen {
    TransientMcpOpen::new(
        McpServerStdio::new("farfold-controlled-page", "/controlled/browser-helper")
            .args(vec!["--controlled-stdio".into()])
            .env(vec![EnvVariable::new("FARFOLD_CONTROLLED_CAP", token)]),
        owner,
    )
}

async fn open_offer(
    f: &Fixture,
    native: Option<&str>,
    owner: Arc<OwnerWitness>,
    token: &str,
) -> OpenedSession {
    f.manager
        .open_session_selected_with_mcp(
            &f.row,
            &f.cwd,
            native.map(str::to_owned),
            vec![],
            Arc::new(|_| {}),
            &f.store,
            None,
            Some(distinct_offer(owner, token)),
            None,
        )
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn opencode_same_cwd_conversations_keep_independent_processes_offers_and_restore_owner() {
    let f = fixture();
    let a = Arc::new(OwnerWitness::default());
    let b = Arc::new(OwnerWitness::default());
    let first = open_offer(&f, None, a.clone(), "public-synthetic-first").await;
    let second = open_offer(&f, None, b.clone(), "public-synthetic-second").await;
    assert_ne!(first.connection_id, second.connection_id);
    let first_proof = &first.response["farfoldRequestProof"];
    let second_proof = &second.response["farfoldRequestProof"];
    assert_eq!(first_proof["oneServer"], true);
    assert_eq!(second_proof["oneServer"], true);
    assert_ne!(first_proof["pid"], second_proof["pid"]);
    assert_eq!(
        first_proof["tokenDigest"],
        token_digest(b"public-synthetic-first")
    );
    assert_eq!(
        second_proof["tokenDigest"],
        token_digest(b"public-synthetic-second")
    );
    for id in [&first.session_id, &second.session_id] {
        let connection = f.manager.session_connection(&f.row.id, &f.cwd, id).unwrap();
        assert_eq!(connection.browser_launch, Some(LaunchKind::OpenCode));
        assert_eq!(
            connection.mcp_spawn_facts.get().unwrap().kind,
            LaunchKind::OpenCode
        );
        assert!(connection.mcp_spawn_facts.get().unwrap().logs_safe);
    }
    assert_eq!(
        a.bound.lock().unwrap().as_slice(),
        [first.session_id.as_str()]
    );
    assert_eq!(
        b.bound.lock().unwrap().as_slice(),
        [second.session_id.as_str()]
    );
    f.manager
        .close_session(&f.row.id, &f.cwd, &first.session_id)
        .await
        .unwrap();
    assert_eq!(a.revoked.load(Ordering::Acquire), 1);
    assert_eq!(b.revoked.load(Ordering::Acquire), 0);
    let restored_owner = Arc::new(OwnerWitness::default());
    let restored = open_offer(
        &f,
        Some("restore-controlled"),
        restored_owner.clone(),
        "public-synthetic-restore",
    )
    .await;
    assert_ne!(restored.connection_id, first.connection_id);
    assert_eq!(
        restored.response["farfoldRequestProof"]["method"],
        "session/load"
    );
    assert_eq!(
        restored.response["farfoldRequestProof"]["tokenDigest"],
        token_digest(b"public-synthetic-restore")
    );
    assert_eq!(
        restored_owner.bound.lock().unwrap().as_slice(),
        ["restore-controlled"]
    );
    f.manager
        .close_session(&f.row.id, &f.cwd, &second.session_id)
        .await
        .unwrap();
    f.manager
        .close_session(&f.row.id, &f.cwd, &restored.session_id)
        .await
        .unwrap();
    assert_eq!(b.revoked.load(Ordering::Acquire), 1);
    assert_eq!(restored_owner.revoked.load(Ordering::Acquire), 1);
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn opencode_diagnostic_launch_refuses_only_tool_offer_not_the_conversation() {
    for (key, value) in [
        ("OPENCODE_AUTO_HEAP_SNAPSHOT", "TRUE"),
        ("OTEL_EXPORTER_OTLP_ENDPOINT", "false"),
    ] {
        let mut f = fixture();
        f.row
            .env
            .iter_mut()
            .find(|(name, _)| name == key)
            .unwrap()
            .1 = value.into();
        f.store.replace_agent_launch(&f.row).unwrap();
        let owner = Arc::new(OwnerWitness::default());
        let opened = open_offer(&f, None, owner.clone(), SYNTHETIC_CAP).await;
        assert_eq!(opened.response["farfoldRequestProof"]["oneServer"], false);
        assert_eq!(owner.revoked.load(Ordering::Acquire), 1);
        assert!(owner.bound.lock().unwrap().is_empty());
        assert_eq!(
            f.manager
                .browser_tool_unavailable(&f.row.id, &f.cwd, &opened.session_id),
            Some(McpUnavailable::UnsafeLogging)
        );
        f.manager
            .close_session(&f.row.id, &f.cwd, &opened.session_id)
            .await
            .unwrap();
        f.finish().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn opencode_stale_registration_cannot_endorse_changed_source_command_or_args() {
    for drift in ["source", "command", "args", "same-shape-command"] {
        let f = fixture();
        let mut current = f.row.clone();
        match drift {
            "source" => current.source = "custom".into(),
            "args" => current.args.push("--print-logs".into()),
            "same-shape-command" => {
                let replacement = f.cwd.join("another-program");
                std::fs::create_dir(&replacement).unwrap();
                let program = replacement.join(if cfg!(windows) {
                    "opencode.exe"
                } else {
                    "opencode"
                });
                std::fs::copy(&current.command, &program).unwrap();
                current.command = program.to_string_lossy().into();
                assert_eq!(
                    crate::acp_client::browser_capability::reviewed_launch(&current),
                    Some(LaunchKind::OpenCode)
                );
            }
            _ => {
                let unreviewed = f.cwd.join(if cfg!(windows) {
                    "unreviewed.exe"
                } else {
                    "unreviewed"
                });
                std::fs::copy(&current.command, &unreviewed).unwrap();
                current.command = unreviewed.to_string_lossy().into();
            }
        }
        f.store.replace_agent_launch(&current).unwrap();
        let owner = Arc::new(OwnerWitness::default());
        let opened = open_offer(&f, None, owner.clone(), SYNTHETIC_CAP).await;
        assert_eq!(opened.response["farfoldRequestProof"]["oneServer"], false);
        assert_eq!(owner.revoked.load(Ordering::Acquire), 1);
        assert_eq!(
            f.manager
                .browser_tool_unavailable(&f.row.id, &f.cwd, &opened.session_id),
            Some(if drift == "same-shape-command" {
                McpUnavailable::LaunchUnconfirmed
            } else {
                McpUnavailable::SourceNotReviewed
            })
        );
        f.manager
            .close_session(&f.row.id, &f.cwd, &opened.session_id)
            .await
            .unwrap();
        f.finish().await;
    }
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn opencode_normal_symlink_alias_keeps_the_same_selected_entrypoint() {
    let f = fixture();
    let directory = f.cwd.join("ordinary-link");
    std::fs::create_dir(&directory).unwrap();
    let alias = directory.join("opencode");
    std::os::unix::fs::symlink(&f.row.command, &alias).unwrap();
    let mut current = f.row.clone();
    current.command = alias.to_string_lossy().into();
    f.store.replace_agent_launch(&current).unwrap();
    let owner = Arc::new(OwnerWitness::default());
    let opened = open_offer(&f, None, owner.clone(), SYNTHETIC_CAP).await;
    assert_eq!(opened.response["farfoldRequestProof"]["oneServer"], true);
    assert_eq!(
        owner.bound.lock().unwrap().as_slice(),
        [opened.session_id.as_str()]
    );
    f.manager
        .close_session(&f.row.id, &f.cwd, &opened.session_id)
        .await
        .unwrap();
    f.finish().await;
}
