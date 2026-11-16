//! Real manager/queue/pump/owned synthetic process, not either official Agent.
//! No helper is launched by this peer; actual helper authentication and MCP
//! readiness have separate native tests. These verify delivery and ownership.
use super::*;
use crate::acp_client::{
    browser_capability::{LaunchKind, reviewed_launch},
    browser_process::PendingOwner,
    transient_mcp::McpUnavailable,
};

fn fixture(fast: bool) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    let code = PEER
        .replace("mode,root=sys.argv[1:3]", &format!("mode,root='ok',{}", serde_json::to_string(&cwd.to_string_lossy()).unwrap()))
        .replace("'cwdMatches':", "'pid':os.getpid(),'environmentEmpty':env==[],'diagnosticPreserved':os.environ.get('LOG_SECRETS')=='TRUE','cwdMatches':");
    let script = crate::platform_tests::python_peer(
        &cwd,
        if fast { "fast-agent-acp" } else { "vibe-acp" },
        &code,
    );
    let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
    let row = AgentRow {
        id: if fast {
            "registry:fast-agent"
        } else {
            "registry:mistral-vibe"
        }
        .into(),
        name: "Controlled authenticated-channel peer".into(),
        source: "registry".into(),
        command: script.to_string_lossy().into(),
        args: if fast { vec!["-x".into()] } else { vec![] },
        // Preserve unrelated diagnostics. No new credential/config is delivered.
        env: vec![("LOG_SECRETS".into(), "TRUE".into())],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    };
    store.insert_agent(&row).unwrap();
    Fixture {
        _dir: dir,
        manager: Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone())),
        cwd,
        store,
        row,
    }
}

fn public_offer(owner: Arc<OwnerWitness>, pending: PendingOwner) -> TransientMcpOpen {
    TransientMcpOpen::new(
        McpServerStdio::new("farfold-controlled-page", "/controlled/browser-helper")
            .args(vec!["--controlled-public-channel".into()])
            .env(vec![]),
        owner,
    )
    .with_process_owner(pending)
}

async fn open(f: &Fixture, native: Option<&str>, offer: TransientMcpOpen) -> OpenedSession {
    f.manager
        .open_session_selected_with_mcp(
            &f.row,
            &f.cwd,
            native.map(str::to_owned),
            vec![],
            Arc::new(|_| {}),
            &f.store,
            None,
            Some(offer),
            None,
        )
        .await
        .unwrap()
}

async fn close(f: &Fixture, opened: &OpenedSession) {
    f.manager
        .close_session(&f.row.id, &f.cwd, &opened.session_id)
        .await
        .unwrap();
}

fn reason(f: &Fixture, opened: &OpenedSession) -> Option<McpUnavailable> {
    f.manager
        .browser_tool_unavailable(&f.row.id, &f.cwd, &opened.session_id)
}

#[tokio::test(flavor = "multi_thread")]
async fn authenticated_new_load_keep_empty_env_exact_child_and_independent_routes() {
    for fast in [true, false] {
        let f = fixture(fast);
        let a = Arc::new(OwnerWitness::default());
        let b = Arc::new(OwnerWitness::default());
        let pending_a = PendingOwner::new();
        let pending_b = PendingOwner::new();
        let first = open(&f, None, public_offer(a.clone(), pending_a.clone())).await;
        let second = open(
            &f,
            Some("restore-controlled"),
            public_offer(b.clone(), pending_b.clone()),
        )
        .await;
        assert_ne!(first.connection_id, second.connection_id);
        assert_ne!(
            first.response["farfoldRequestProof"]["pid"],
            second.response["farfoldRequestProof"]["pid"]
        );
        for opened in [&first, &second] {
            let proof = &opened.response["farfoldRequestProof"];
            for field in [
                "oneServer",
                "standardFields",
                "environmentEmpty",
                "diagnosticPreserved",
                "cwdMatches",
            ] {
                assert_eq!(proof[field], true, "{field}");
            }
            assert_eq!(reason(&f, opened), None);
        }
        let first_connection = f
            .manager
            .session_connection(&f.row.id, &f.cwd, &first.session_id)
            .unwrap();
        let second_connection = f
            .manager
            .session_connection(&f.row.id, &f.cwd, &second.session_id)
            .unwrap();
        assert_eq!(
            first_connection.browser_launch,
            Some(if fast {
                LaunchKind::MachFastAgent
            } else {
                LaunchKind::MachMistralVibe
            })
        );
        assert!(
            first_connection.mcp_spawn_facts.get().is_none(),
            "no fabricated bearer log facts"
        );
        assert!(pending_a.bind(&first_connection));
        assert!(!pending_a.bind(&second_connection));
        assert!(pending_b.bind(&second_connection));
        let row_id = crate::acp_client::session_index::session_row_id(
            &f.row.id,
            &f.cwd.to_string_lossy(),
            &first.session_id,
        );
        assert!(
            f.store.get_session(&row_id).unwrap().is_none(),
            "preparing a browser tool must not save an empty draft"
        );
        close(&f, &first).await;
        assert_eq!(a.revoked.load(Ordering::Acquire), 1);
        assert_eq!(b.revoked.load(Ordering::Acquire), 0);
        close(&f, &second).await;
        assert_eq!(b.revoked.load(Ordering::Acquire), 1);
        f.finish().await;
        assert!(!pending_a.bind(&first_connection));
        assert!(!pending_b.bind(&second_connection));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn authenticated_sources_never_receive_bearer_or_unowned_public_offers() {
    for fast in [true, false] {
        for variant in [
            "bearer",
            "missing-process-owner",
            "bearer-marked-as-authenticated",
        ] {
            let f = fixture(fast);
            let owner = Arc::new(OwnerWitness::default());
            let offered = match variant {
                "bearer" => offer(owner.clone()),
                "missing-process-owner" => TransientMcpOpen::new(
                    McpServerStdio::new("public", "/controlled/helper").env(vec![]),
                    owner.clone(),
                ),
                _ => offer(owner.clone()).with_process_owner(PendingOwner::new()),
            };
            let opened = open(&f, None, offered).await;
            assert_eq!(opened.response["farfoldRequestProof"]["oneServer"], false);
            assert_eq!(reason(&f, &opened), Some(McpUnavailable::LaunchUnconfirmed));
            assert_eq!(owner.revoked.load(Ordering::Acquire), 1);
            assert!(owner.bound.lock().unwrap().is_empty());
            close(&f, &opened).await;
            f.finish().await;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn bearer_source_cannot_consume_an_authenticated_offer() {
    let f = Fixture::new("ok");
    let owner = Arc::new(OwnerWitness::default());
    let opened = open(&f, None, public_offer(owner.clone(), PendingOwner::new())).await;
    assert_eq!(opened.response["farfoldRequestProof"]["oneServer"], false);
    assert_eq!(reason(&f, &opened), Some(McpUnavailable::LaunchUnconfirmed));
    assert_eq!(owner.revoked.load(Ordering::Acquire), 1);
    close(&f, &opened).await;
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn authenticated_offer_refuses_refreshed_source_args_and_same_name_other_program() {
    for fast in [true, false] {
        for drift in ["source", "args", "same-name-command"] {
            let f = fixture(fast);
            let mut current = f.row.clone();
            match drift {
                "source" => current.source = "custom".into(),
                "args" => current.args.push("--unreviewed".into()),
                _ => {
                    let parent = f.cwd.join("different-program");
                    std::fs::create_dir(&parent).unwrap();
                    let path =
                        parent.join(std::path::Path::new(&current.command).file_name().unwrap());
                    std::fs::copy(&current.command, &path).unwrap();
                    current.command = path.to_string_lossy().into();
                    assert_eq!(reviewed_launch(&current), reviewed_launch(&f.row));
                }
            }
            f.store.replace_agent_launch(&current).unwrap();
            let owner = Arc::new(OwnerWitness::default());
            let opened = open(&f, None, public_offer(owner.clone(), PendingOwner::new())).await;
            assert_eq!(opened.response["farfoldRequestProof"]["oneServer"], false);
            assert_eq!(
                reason(&f, &opened),
                Some(if drift == "same-name-command" {
                    McpUnavailable::LaunchUnconfirmed
                } else {
                    McpUnavailable::SourceNotReviewed
                })
            );
            assert_eq!(owner.revoked.load(Ordering::Acquire), 1);
            close(&f, &opened).await;
            f.finish().await;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn authenticated_pending_owner_cannot_be_reused_by_a_second_process() {
    let f = fixture(true);
    let pending = PendingOwner::new();
    let a = Arc::new(OwnerWitness::default());
    let b = Arc::new(OwnerWitness::default());
    let first = open(&f, None, public_offer(a.clone(), pending.clone())).await;
    let second = open(&f, None, public_offer(b.clone(), pending)).await;
    assert_eq!(first.response["farfoldRequestProof"]["oneServer"], true);
    assert_eq!(second.response["farfoldRequestProof"]["oneServer"], false);
    assert_eq!(reason(&f, &second), Some(McpUnavailable::LaunchUnconfirmed));
    assert_eq!(a.revoked.load(Ordering::Acquire), 0);
    assert_eq!(b.revoked.load(Ordering::Acquire), 1);
    close(&f, &second).await;
    close(&f, &first).await;
    f.finish().await;
}
