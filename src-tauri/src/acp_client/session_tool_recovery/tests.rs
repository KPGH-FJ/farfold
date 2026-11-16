use super::*;
use crate::meta_store::AgentRow;
use serde_json::{Value, json};
use std::path::PathBuf;

struct Fixture {
    _directory: tempfile::TempDir,
    cwd: PathBuf,
    store: MetaStore,
    agent: AgentRow,
    manager: Arc<AcpManager>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}
fn base() -> Value {
    json!({"extensions":[{"extensionKey":"developer","extension":{"type":"platform","name":"developer"}}]})
}
fn descriptor() -> Value {
    json!({"type":"mcp","server":{"type":"http","name":"Owned","url":"http://127.0.0.1:8910/PRIVATE_TEST_URL","headers":[]}})
}
fn applied() -> Value {
    let mut value = base();
    value["extensions"]
        .as_array_mut()
        .unwrap()
        .push(json!({"extensionKey":"official-returned-key","extension":descriptor()}));
    value
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let cwd = directory.path().canonicalize().unwrap();
        let program = crate::platform_tests::python_peer(&cwd, "goose", include_str!("peer.py"));
        let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
        let agent = AgentRow {
            id: "registry:goose".into(),
            name: "Owned fixture".into(),
            source: "registry".into(),
            command: program.to_string_lossy().into(),
            args: vec!["acp".into()],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 1,
            updated_at: 1,
        };
        store.insert_agent(&agent).unwrap();
        let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
        Self {
            _directory: directory,
            cwd,
            store,
            agent,
            manager,
        }
    }
    fn target(&self, native: &str) -> Target {
        Target {
            agent_id: self.agent.id.clone(),
            cwd: self.cwd.to_string_lossy().into(),
            session_id: native.into(),
        }
    }
    fn save(&self, native: &str) -> SessionRow {
        let target = self.target(native);
        let row = SessionRow {
            id: super::super::session_index::session_row_id(&target.agent_id, &target.cwd, native),
            agent_id: target.agent_id,
            cwd: target.cwd,
            native_session_id: Some(native.into()),
            title: Some("preserve".into()),
            config_options: Some(
                json!({"_farfoldConfig":2,"_farfoldService":{"kind":"existing"},"choices":[]}),
            ),
            pinned: true,
            archived: false,
            created_at: 1,
            updated_at: 1,
        };
        self.store.upsert_session(&row).unwrap();
        self.inventory(native, base());
        row
    }
    fn pending(&self, row: &SessionRow, id: &str) -> Pending {
        let value = Pending {
            operation_id: id.into(),
            action: Action::Add,
            before_digest: Inventory::parse(base()).unwrap().digest(),
            expected_digest: None,
            target_digest: super::super::session_tool_changes::inventory::descriptor_digest(
                &descriptor(),
            ),
        };
        self.store.begin_mcp_pending(row, &value).unwrap();
        value
    }
    fn inventory(&self, native: &str, value: Value) {
        std::fs::write(
            self.cwd.join(format!("inventory-{native}.json")),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
    }
    fn trace(&self) -> Vec<Value> {
        std::fs::read_to_string(self.cwd.join("recovery-trace.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    fn queries(&self, native: &str) -> usize {
        self.trace()
            .iter()
            .filter(|v| {
                v["method"] == super::super::session_tool_changes::LIST
                    && v["params"]["sessionId"] == native
            })
            .count()
    }
    async fn inspect(&self, native: &str) -> Inspection {
        self.manager
            .inspect_tool_recovery(&self.store, self.target(native))
            .await
            .unwrap()
    }
    async fn confirm(&self, inspection: &Inspection) -> Result<Confirmation, String> {
        self.manager
            .confirm_tool_recovery(
                &self.store,
                inspection.target.clone(),
                inspection.review_id.clone().unwrap(),
                inspection.connection_id.clone().unwrap(),
                inspection.resolution.unwrap(),
            )
            .await
    }
}
async fn until(mut check: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !check() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn session_tool_recovery_cold_guard_never_dispatches_load_and_sibling_is_unaffected() {
    let f = Fixture::new();
    let row = f.save("first");
    f.save("other");
    f.pending(&row, "first-op");
    let error = f
        .manager
        .open_session(
            &f.agent,
            &f.cwd,
            Some("first".into()),
            vec![],
            Arc::new(|_| {}),
            &f.store,
        )
        .await
        .err()
        .unwrap();
    assert_eq!(error, crate::meta_store::mcp_pending::BLOCKED);
    assert!(f.trace().is_empty());
    f.manager
        .open_session(
            &f.agent,
            &f.cwd,
            Some("other".into()),
            vec![],
            Arc::new(|_| {}),
            &f.store,
        )
        .await
        .unwrap();
    assert!(
        f.trace()
            .iter()
            .any(|v| v["method"] == "session/load" && v["params"]["sessionId"] == "other")
    );
    assert!(
        !f.trace()
            .iter()
            .any(|v| v["method"] == "session/load" && v["params"]["sessionId"] == "first")
    );
    assert!(f.store.mcp_pending(&row.id).unwrap().is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn session_tool_recovery_requires_exact_confirmation_rechecks_and_replays_receipt_only() {
    let f = Fixture::new();
    let row = f.save("first");
    let pending = f.pending(&row, "first-op");
    f.inventory("first", applied());
    let review = f.inspect("first").await;
    assert_eq!(review.outcome, "applied");
    assert!(review.can_confirm);
    assert_eq!(review.operation_id.as_deref(), Some("first-op"));
    assert_eq!(f.queries("first"), 1);
    assert_eq!(f.store.mcp_pending(&row.id).unwrap(), Some(pending));
    assert!(f.trace().iter().all(|v| matches!(
        v["method"].as_str(),
        Some("initialize" | "_goose/unstable/session/extensions/list")
    )));
    assert_eq!(
        f.manager
            .confirm_tool_recovery(
                &f.store,
                review.target.clone(),
                review.review_id.clone().unwrap(),
                "wrong-process".into(),
                Resolution::ConfirmResult,
            )
            .await
            .unwrap_err(),
        CHANGED
    );
    assert_eq!(f.queries("first"), 1);
    let completed = f.confirm(&review).await.unwrap();
    assert!(completed.resolved && completed.requires_reopen);
    assert_eq!(completed.operation_id, "first-op");
    assert!(f.store.mcp_pending(&row.id).unwrap().is_none());
    assert_eq!(f.queries("first"), 2);
    assert_eq!(
        f.confirm(&review).await.unwrap().review_id,
        completed.review_id
    );
    assert_eq!(f.queries("first"), 2);
    assert_eq!(f.store.get_session(&row.id).unwrap(), Some(row));
}

#[tokio::test(flavor = "multi_thread")]
async fn session_tool_recovery_external_change_and_local_save_failure_keep_pending() {
    let f = Fixture::new();
    let row = f.save("first");
    let original = f.pending(&row, "first-op");
    let before = f.inspect("first").await;
    assert_eq!(before.outcome, "unchanged");
    let mut drift = applied();
    drift["extensions"]
        .as_array_mut()
        .unwrap()
        .push(json!({"extensionKey":"other","extension":{"type":"platform","name":"other"}}));
    f.inventory("first", drift);
    assert_eq!(f.confirm(&before).await.unwrap_err(), CHANGED);
    assert_eq!(
        f.store.mcp_pending(&row.id).unwrap(),
        Some(original.clone())
    );
    let changed = f.inspect("first").await;
    assert_eq!(changed.outcome, "changed");
    assert!(!changed.can_confirm);
    f.inventory("first", applied());
    let next = f.inspect("first").await;
    let sql = rusqlite::Connection::open(f.cwd.join("meta.db")).unwrap();
    sql.execute_batch("CREATE TRIGGER refuse_pending_clear BEFORE DELETE ON settings WHEN OLD.key LIKE 'mcpPending.v1:%' BEGIN SELECT RAISE(FAIL,'fixture'); END;").unwrap();
    assert_eq!(f.confirm(&next).await.unwrap_err(), CHANGED);
    assert_eq!(f.store.mcp_pending(&row.id).unwrap(), Some(original));
    sql.execute_batch("DROP TRIGGER refuse_pending_clear;")
        .unwrap();
    let next = f.inspect("first").await;
    assert!(f.confirm(&next).await.unwrap().resolved);
}

#[tokio::test(flavor = "multi_thread")]
async fn session_tool_recovery_external_current_settings_can_be_explicitly_adopted() {
    let f = Fixture::new();
    let row = f.save("external-review");
    let pending = f.pending(&row, "external-op");
    let mut current = applied();
    current["extensions"][1]["extension"]["server"]["url"] = json!("http://127.0.0.1:8910/mcp");
    current["extensions"]
        .as_array_mut()
        .unwrap()
        .push(json!({"extensionKey":"other","extension":{"type":"platform","name":"Other"}}));
    f.inventory("external-review", current);
    let review = f.inspect("external-review").await;
    assert_eq!(review.outcome, "changed");
    assert!(
        review.can_confirm,
        "an exact safe current inventory needs an explicit recovery exit"
    );
    let public = serde_json::to_value(&review).unwrap();
    assert_eq!(public["resolution"], "acceptCurrent");
    assert_eq!(public["configuration"]["complete"], true);
    assert_eq!(
        public["configuration"]["items"].as_array().unwrap().len(),
        3
    );
    assert!(!public.to_string().contains("PRIVATE_TEST_URL"));
    assert_eq!(f.store.mcp_pending(&row.id).unwrap(), Some(pending));
    assert_eq!(f.store.get_session(&row.id).unwrap(), Some(row.clone()));
    assert!(f.trace().iter().all(|v| matches!(
        v["method"].as_str(),
        Some("initialize" | "_goose/unstable/session/extensions/list")
    )));
    assert_eq!(
        f.manager
            .confirm_tool_recovery(
                &f.store,
                review.target.clone(),
                review.review_id.clone().unwrap(),
                review.connection_id.clone().unwrap(),
                Resolution::ConfirmResult,
            )
            .await
            .unwrap_err(),
        CHANGED
    );
    assert!(f.store.mcp_pending(&row.id).unwrap().is_some());
    assert_eq!(f.queries("external-review"), 1);
    assert_eq!(
        f.inspect("external-review").await.review_id,
        review.review_id
    );
    let confirmed = f.confirm(&review).await.unwrap();
    assert!(confirmed.resolved && confirmed.requires_reopen);
    assert_eq!(confirmed.resolution, Resolution::AcceptCurrent);
    assert!(f.store.mcp_pending(&row.id).unwrap().is_none());
    assert_eq!(f.store.get_session(&row.id).unwrap(), Some(row));
    assert_eq!(f.queries("external-review"), 2);
    assert_eq!(
        f.confirm(&review).await.unwrap().review_id,
        confirmed.review_id
    );
    assert_eq!(f.queries("external-review"), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn session_tool_recovery_current_acceptance_rejects_drift_then_hides_unsafe_values() {
    let f = Fixture::new();
    let row = f.save("external-drift");
    let pending = f.pending(&row, "drift-op");
    let mut current = applied();
    current["extensions"][1]["extension"]["server"]["url"] = json!("http://127.0.0.1:8910/mcp");
    f.inventory("external-drift", current.clone());
    let review = f.inspect("external-drift").await;
    assert_eq!(review.resolution, Some(Resolution::AcceptCurrent));
    current["extensions"][1]["extension"]["server"]["url"] = json!("http://127.0.0.1:8910/");
    f.inventory("external-drift", current.clone());
    assert_eq!(f.confirm(&review).await.unwrap_err(), CHANGED);
    assert_eq!(f.store.mcp_pending(&row.id).unwrap(), Some(pending.clone()));
    assert_eq!(f.queries("external-drift"), 2);
    current["extensions"][1]["extension"]["server"]["headers"] =
        json!([{"name":"Authorization","value":"PRIVATE-DO-NOT-EXPOSE"}]);
    f.inventory("external-drift", current.clone());
    let unsafe_review = f.inspect("external-drift").await;
    assert_eq!(unsafe_review.outcome, "changed");
    assert!(!unsafe_review.can_confirm);
    assert!(unsafe_review.review_id.is_none() && unsafe_review.configuration.is_none());
    assert!(
        !serde_json::to_string(&unsafe_review)
            .unwrap()
            .contains("PRIVATE")
    );
    assert_eq!(f.store.mcp_pending(&row.id).unwrap(), Some(pending));
    current["extensions"][1]["extension"]["server"]["headers"] = json!([]);
    f.inventory("external-drift", current);
    let fresh = f.inspect("external-drift").await;
    assert_ne!(fresh.review_id, review.review_id);
    assert!(f.confirm(&fresh).await.unwrap().requires_reopen);
    assert_eq!(f.store.get_session(&row.id).unwrap(), Some(row));
}

#[tokio::test(flavor = "multi_thread")]
async fn session_tool_recovery_lost_inspection_dedupes_without_blocking_another_target() {
    let f = Fixture::new();
    let first = f.save("first");
    let other = f.save("other");
    f.pending(&first, "first-op");
    f.pending(&other, "other-op");
    let hold = f.cwd.join("hold-first");
    std::fs::write(&hold, "").unwrap();
    assert!(
        tokio::time::timeout(
            Duration::from_millis(150),
            f.manager.inspect_tool_recovery(&f.store, f.target("first"))
        )
        .await
        .is_err()
    );
    until(|| f.queries("first") == 1).await;
    assert!(
        tokio::time::timeout(
            Duration::from_millis(100),
            f.manager.inspect_tool_recovery(&f.store, f.target("first"))
        )
        .await
        .is_err()
    );
    assert_eq!(f.queries("first"), 1);
    let sibling = f.inspect("other").await;
    assert_eq!(sibling.outcome, "unchanged");
    let receipt = f.confirm(&sibling).await.unwrap();
    std::fs::remove_file(hold).unwrap();
    let first = f.inspect("first").await;
    assert_eq!(first.outcome, "unchanged");
    assert_eq!(f.queries("first"), 1);
    f.confirm(&first).await.unwrap();
    assert_eq!(
        f.confirm(&sibling).await.unwrap().operation_id,
        receipt.operation_id
    );
    assert_eq!(f.queries("other"), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn session_tool_recovery_unknown_live_operation_stays_busy_then_only_exact_idle_owner_ends() {
    let f = Fixture::new();
    let row = f.save("first");
    f.save("other");
    f.manager
        .open_session(
            &f.agent,
            &f.cwd,
            Some("first".into()),
            vec![],
            Arc::new(|_| {}),
            &f.store,
        )
        .await
        .unwrap();
    let owner = f
        .manager
        .session_connection(&f.agent.id, &f.cwd, "first")
        .unwrap();
    f.manager
        .open_session(
            &f.agent,
            &f.cwd,
            Some("other".into()),
            vec![],
            Arc::new(|_| {}),
            &f.store,
        )
        .await
        .unwrap();
    let other = f
        .manager
        .session_connection(&f.agent.id, &f.cwd, "other")
        .unwrap();
    f.pending(&row, "first-op");
    let ongoing = owner.life.operation("owned-test-pending".into()).unwrap();
    let blocked = f.inspect("first").await;
    assert_eq!(blocked.outcome, "busy");
    assert_eq!(f.queries("first"), 0);
    assert!(!owner.life.finished());
    drop(ongoing);
    let review = f.inspect("first").await;
    assert_eq!(review.outcome, "unchanged");
    assert!(owner.life.finished());
    assert!(!other.life.finished());
    assert_eq!(
        f.trace()
            .iter()
            .filter(|v| v["method"] == "session/load" && v["params"]["sessionId"] == "first")
            .count(),
        1
    );
    f.confirm(&review).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn session_tool_recovery_pending_live_route_blocks_config_mode_confirmation_and_delete() {
    let f = Fixture::new();
    let row = f.save("first");
    f.manager
        .open_session(
            &f.agent,
            &f.cwd,
            Some("first".into()),
            vec![],
            Arc::new(|_| {}),
            &f.store,
        )
        .await
        .unwrap();
    let connection = f
        .manager
        .session_connection(&f.agent.id, &f.cwd, "first")
        .unwrap();
    f.pending(&row, "first-op");
    let before = f.trace();
    let blocked = crate::meta_store::mcp_pending::BLOCKED;
    assert_eq!(
        f.manager
            .session_set_config(&f.agent.id, &f.cwd, "first", "model", json!("next"))
            .await
            .unwrap_err(),
        blocked
    );
    assert_eq!(
        f.manager
            .session_set_mode(&f.agent.id, &f.cwd, "first", "next")
            .await
            .unwrap_err(),
        blocked
    );
    assert_eq!(
        f.manager
            .confirm_config(&f.agent.id, &f.cwd, "first", json!({}))
            .await
            .unwrap_err(),
        blocked
    );
    let control = connection
        .sessions
        .lock()
        .unwrap()
        .get("first")
        .unwrap()
        .control
        .clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    control
        .send(super::super::pump::SessionControl::Delete {
            opening: None,
            deadline: tokio::time::Instant::now() + Duration::from_secs(2),
            result: send,
        })
        .unwrap();
    assert!(matches!(
        receive.await.unwrap(),
        Err(super::super::mutation::DeleteFailure::NotDispatched)
    ));
    assert_eq!(f.trace(), before);
    assert!(f.store.mcp_pending(&row.id).unwrap().is_some());
    let inspection = f.inspect("first").await;
    assert!(inspection.can_confirm);
    assert!(f.confirm(&inspection).await.unwrap().resolved);
}

#[tokio::test(flavor = "multi_thread")]
async fn session_tool_recovery_remove_before_and_expected_sets_can_be_explicitly_confirmed() {
    let f = Fixture::new();
    for (native, inventory, expected_outcome) in [
        ("unchanged-remove", applied(), "unchanged"),
        ("applied-remove", base(), "applied"),
    ] {
        let row = f.save(native);
        let pending = Pending {
            operation_id: native.into(),
            action: Action::Remove,
            before_digest: Inventory::parse(applied()).unwrap().digest(),
            expected_digest: Some(Inventory::parse(base()).unwrap().digest()),
            target_digest: super::super::session_tool_changes::inventory::descriptor_digest(
                &descriptor(),
            ),
        };
        f.store.begin_mcp_pending(&row, &pending).unwrap();
        f.inventory(native, inventory);
        let inspection = f.inspect(native).await;
        assert_eq!(inspection.action, Some("remove"));
        assert_eq!(inspection.outcome, expected_outcome);
        assert_eq!(f.store.mcp_pending(&row.id).unwrap(), Some(pending));
        assert!(f.confirm(&inspection).await.unwrap().requires_reopen);
        assert!(f.store.mcp_pending(&row.id).unwrap().is_none());
        assert_eq!(f.queries(native), 2);
    }
    assert!(f.trace().iter().all(|entry| matches!(
        entry["method"].as_str(),
        Some("initialize" | "_goose/unstable/session/extensions/list")
    )));
}
