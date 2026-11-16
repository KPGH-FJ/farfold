//! Controlled peer/SQLite/actual manager+actor tests, not installed acceptance.
use super::*;
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use std::path::PathBuf;

struct Fixture {
    _dir: tempfile::TempDir,
    cwd: PathBuf,
    _store: MetaStore,
    row: AgentRow,
    manager: Arc<AcpManager>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}
impl Fixture {
    async fn open(enabled: bool) -> (Self, ManagedConnection) {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().canonicalize().unwrap();
        let script = cwd.join("peer.py");
        std::fs::write(&script, include_str!("peer.py")).unwrap();
        let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
        let row = AgentRow {
            id: "tools-fixture".into(),
            name: "Fixture".into(),
            source: "custom".into(),
            command: crate::platform_tests::python(),
            args: vec!["-u".into(), script.to_string_lossy().into()],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        store.insert_agent(&row).unwrap();
        let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
        let opened = manager
            .open_session(&row, &cwd, None, vec![], Arc::new(|_| {}), &store)
            .await
            .unwrap();
        let c = manager
            .session_connection(&row.id, &cwd, &opened.session_id)
            .unwrap();
        if enabled {
            c.session_tools.enable_for_test();
        }
        (
            Self {
                _dir: dir,
                cwd,
                _store: store,
                row,
                manager,
            },
            c,
        )
    }
    fn flag(&self, name: &str) {
        std::fs::write(self.cwd.join(name), "").unwrap();
    }
    fn trace(&self) -> Vec<Value> {
        std::fs::read_to_string(self.cwd.join("trace.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect()
    }
    fn queries(&self) -> usize {
        self.trace()
            .iter()
            .filter(|v| v["method"] == METHOD)
            .count()
    }
    async fn read(&self, c: &ManagedConnection, id: &str) -> Reply {
        self.read_extension(c, id, None).await
    }
    async fn read_extension(
        &self,
        c: &ManagedConnection,
        id: &str,
        extension: Option<&str>,
    ) -> Reply {
        self.manager
            .tools_read(
                &self.row.id,
                &self.cwd,
                "owned-tools",
                &c.connection_id,
                id,
                extension,
            )
            .await
    }
    fn status(&self, c: &ManagedConnection, id: &str) -> Reply {
        self.status_extension(c, id, None)
    }
    fn status_extension(&self, c: &ManagedConnection, id: &str, extension: Option<&str>) -> Reply {
        self.manager.tools_status(
            &self.row.id,
            &self.cwd,
            "owned-tools",
            &c.connection_id,
            id,
            extension,
        )
    }
    async fn short_read(&self, c: &ManagedConnection, id: &str) -> Reply {
        self.manager
            .tools_read_until(
                &self.row.id,
                &self.cwd,
                "owned-tools",
                &c.connection_id,
                id,
                Query::Tools(None),
                tokio::time::Instant::now() + Duration::from_millis(150),
            )
            .await
    }
}
async fn until(mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(4), async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn tools_read_exact_actor_single_rpc_sanitized_report_and_status_without_requery() {
    let (f, c) = Fixture::open(true).await;
    let op = f.read(&c, "first").await.unwrap();
    assert_eq!(op.state, State::Ready);
    assert!(op.settled);
    let report = op.report.as_ref().unwrap();
    assert_eq!(report.completeness, "unreported");
    assert_eq!(report.items.len(), 1);
    assert_eq!(f.status(&c, "first").unwrap(), op);
    assert_eq!(f.read(&c, "first").await.unwrap(), op);
    assert_eq!(
        f.trace()
            .iter()
            .map(|x| x["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["initialize", "session/new", METHOD]
    );
    assert_eq!(
        f.trace()[2]["params"],
        json!({"sessionId":"owned-tools","extensionName":null})
    );
    assert!(!serde_json::to_string(&op).unwrap().contains("PRIVATE_"));
    assert_eq!(f.read(&c, "second").await.unwrap().state, State::Ready);
    assert_eq!(f.queries(), 2);
    assert_eq!(f.status(&c, "first").unwrap_err().code, Code::Changed);
}

#[tokio::test(flavor = "multi_thread")]
async fn tools_extension_requires_exact_opening_name_and_keeps_status_on_the_same_scope() {
    let (f, c) = Fixture::open(true).await;
    for name in [
        "ownedreport",
        "Other Extension",
        "ambiguous",
        "invalid/entry",
    ] {
        assert_eq!(
            f.read_extension(&c, "scoped", Some(name))
                .await
                .unwrap_err()
                .code,
            Code::Changed
        );
    }
    assert_eq!(f.queries(), 0);
    let name = Some("Owned Report");
    let operation = f.read_extension(&c, "scoped", name).await.unwrap();
    assert_eq!(operation.extension_name.as_deref(), name);
    assert_eq!(operation.state, State::Ready);
    assert_eq!(f.status_extension(&c, "scoped", name).unwrap(), operation);
    assert_eq!(
        f.read_extension(&c, "scoped", name).await.unwrap(),
        operation
    );
    assert_eq!(f.read(&c, "scoped").await.unwrap_err().code, Code::Changed);
    assert_eq!(f.status(&c, "scoped").unwrap_err().code, Code::Changed);
    assert_eq!(f.queries(), 1);
    assert_eq!(
        f.trace()[2]["params"],
        json!({"sessionId":"owned-tools","extensionName":"Owned Report"})
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn tools_retired_operation_id_cannot_be_reused_with_another_scope() {
    let (f, c) = Fixture::open(true).await;
    assert_eq!(f.read(&c, "original").await.unwrap().state, State::Ready);
    assert_eq!(f.read(&c, "replacement").await.unwrap().state, State::Ready);
    assert_eq!(
        f.read_extension(&c, "original", Some("Owned Report"))
            .await
            .unwrap_err()
            .code,
        Code::Changed
    );
    assert_eq!(f.status(&c, "replacement").unwrap().state, State::Ready);
    assert_eq!(f.queries(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn tools_read_limit_rejects_new_queries_and_preserves_the_current_receipt() {
    let (f, c) = Fixture::open(true).await;
    let current = f.read(&c, "current").await.unwrap();
    let slot = c.sessions.lock().unwrap()["owned-tools"]
        .tools_report
        .clone();
    slot.reads
        .lock()
        .unwrap()
        .admitted_ids
        .extend((1..MAX_OPERATIONS).map(|index| format!("prior-{index}")));
    assert_eq!(
        f.read(&c, "past-limit").await.unwrap_err().code,
        Code::ReadLimit
    );
    assert_eq!(f.status(&c, "current").unwrap(), current);
    assert_eq!(f.read(&c, "current").await.unwrap(), current);
    assert_eq!(f.queries(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn configuration_query_projects_only_safe_fields_and_leaves_tool_method_available() {
    let (f, c) = Fixture::open(true).await;
    let read = |id| {
        f.manager.tools_read_until(
            &f.row.id,
            &f.cwd,
            "owned-tools",
            &c.connection_id,
            id,
            Query::Configuration,
            tokio::time::Instant::now() + BUDGET,
        )
    };
    let configured = read("configuration").await.unwrap();
    assert_eq!(configured.state, State::Ready);
    assert!(configured.report.is_none());
    let public = serde_json::to_value(&configured).unwrap();
    assert_eq!(public["configuration"], true);
    assert_eq!(public["configurationReport"]["source"], "unreported");
    assert_eq!(
        public["configurationReport"]["connectionStatus"],
        "unreported"
    );
    assert_eq!(
        public["configurationReport"]["items"],
        json!([{"name":"HTTP Test","kind":"http"},{"name":"Local Test","kind":"local"}])
    );
    assert!(!public.to_string().contains("PRIVATE"));
    assert_eq!(
        f.status(&c, "configuration").unwrap_err().code,
        Code::Changed
    );
    assert_eq!(read("configuration").await.unwrap(), configured);
    assert_eq!(f.trace()[2]["params"], json!({"sessionId":"owned-tools"}));
    assert_eq!(f.trace()[2]["method"], configuration::METHOD);
    assert_eq!(f.trace().len(), 3);

    f.flag("configuration-malformed");
    let malformed = read("configuration-malformed").await.unwrap();
    assert_eq!(malformed.error.unwrap().code, Code::InvalidResponse);
    assert!(malformed.configuration_report.is_none());
    std::fs::remove_file(f.cwd.join("configuration-malformed")).unwrap();

    f.flag("configuration-unsupported");
    let unavailable = read("configuration-unsupported").await.unwrap();
    assert_eq!(unavailable.error.unwrap().code, Code::Unavailable);
    assert!(
        c.session_tools
            .capability()
            .unwrap()
            .configuration
            .is_none()
    );
    assert_eq!(
        f.read(&c, "tool-after-configuration").await.unwrap().state,
        State::Ready
    );
    assert_eq!(f.queries(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn tools_empty_success_remains_incomplete_and_bad_shape_or_error_never_becomes_empty() {
    let (f, c) = Fixture::open(true).await;
    f.flag("empty");
    let op = f.read(&c, "empty").await.unwrap();
    assert_eq!(op.report.unwrap().completeness, "unreported");
    std::fs::remove_file(f.cwd.join("empty")).unwrap();
    for (flag, code) in [
        ("invalid", Code::InvalidResponse),
        ("rpc-error", Code::QueryFailed),
    ] {
        f.flag(flag);
        let op = f.read(&c, flag).await.unwrap();
        assert_eq!(op.state, State::Failed);
        assert!(op.settled);
        assert!(op.report.is_none());
        assert_eq!(op.error.unwrap().code, code);
        assert!(
            !serde_json::to_string(&f.status(&c, flag).unwrap())
                .unwrap()
                .contains("PRIVATE_")
        );
        std::fs::remove_file(f.cwd.join(flag)).unwrap();
    }
    assert_eq!(f.queries(), 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn tools_unavailable_wrong_owner_preview_and_unknown_session_never_open_or_query() {
    let (f, c) = Fixture::open(false).await;
    assert_eq!(
        f.read(&c, "not-supported").await.unwrap_err().code,
        Code::Unavailable
    );
    c.session_tools.enable_for_test();
    assert_eq!(
        f.manager
            .tools_read(&f.row.id, &f.cwd, "owned-tools", "foreign", "wrong", None)
            .await
            .unwrap_err()
            .code,
        Code::Changed
    );
    assert_eq!(
        f.manager
            .tools_read(
                &f.row.id,
                &f.cwd,
                "historical-id",
                &c.connection_id,
                "history",
                None,
            )
            .await
            .unwrap_err()
            .code,
        Code::Changed
    );
    c.sessions
        .lock()
        .unwrap()
        .get_mut("owned-tools")
        .unwrap()
        .preview_token = Some("preview".into());
    assert_eq!(f.read(&c, "preview").await.unwrap_err().code, Code::Changed);
    assert_eq!(f.trace().len(), 2);
    assert_eq!(f.queries(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn tools_real_method_not_found_revokes_only_current_connection_supplement() {
    let (f, c) = Fixture::open(true).await;
    f.flag("unsupported");
    let op = f.read(&c, "unsupported").await.unwrap();
    assert!(op.settled);
    assert_eq!(op.error.unwrap().code, Code::Unavailable);
    let capability = c.session_tools.capability().unwrap();
    assert_eq!(capability.configuration, Some(true));
    assert_eq!(capability.tools_unavailable, Some(true));
    assert_eq!(
        f.manager
            .tools_read_until(
                &f.row.id,
                &f.cwd,
                "owned-tools",
                &c.connection_id,
                "configuration-after-tools",
                Query::Configuration,
                tokio::time::Instant::now() + BUDGET,
            )
            .await
            .unwrap()
            .state,
        State::Ready
    );
    assert_eq!(
        f.read(&c, "fresh").await.unwrap_err().code,
        Code::Unavailable
    );
    assert_eq!(f.queries(), 1);
    let (_other, other) = Fixture::open(true).await;
    assert!(other.session_tools.capability().is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn tools_expiry_and_same_id_status_do_not_repeat_rpc_late_reply_settles_original() {
    let (f, c) = Fixture::open(true).await;
    f.flag("hold");
    let pending = f.short_read(&c, "late").await.unwrap();
    assert_eq!(pending.state, State::Pending);
    assert!(!pending.settled);
    assert_eq!(f.status(&c, "late").unwrap(), pending);
    assert_eq!(f.short_read(&c, "late").await.unwrap(), pending);
    assert_eq!(f.read(&c, "duplicate").await.unwrap_err().code, Code::Busy);
    assert!(c.session_tools.capability().is_some());
    assert_eq!(f.queries(), 1);
    assert!(c.life.operation("open:owned-tools".into()).is_err());
    std::fs::remove_file(f.cwd.join("hold")).unwrap();
    until(|| f.status(&c, "late").is_ok_and(|o| o.settled)).await;
    let settled = f.status(&c, "late").unwrap();
    assert_eq!(settled.state, State::Ready);
    assert_eq!(f.status(&c, "late").unwrap().report, settled.report);
    assert!(c.life.operation("open:owned-tools".into()).is_ok());
    assert_eq!(f.queries(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn tools_pending_report_blocks_local_close_until_original_reply() {
    let (f, c) = Fixture::open(true).await;
    f.flag("hold");
    assert_eq!(
        f.short_read(&c, "original").await.unwrap().state,
        State::Pending
    );
    until(|| f.cwd.join("tools-started").exists()).await;

    // The peer declares no remote close; this exercises the public close
    // path that detaches the local route instead.
    assert!(
        f.manager
            .close_session(&f.row.id, &f.cwd, "owned-tools")
            .await
            .is_err(),
        "closing must not detach the route of an in-flight tools report"
    );
    assert_eq!(f.status(&c, "original").unwrap().state, State::Pending);

    std::fs::remove_file(f.cwd.join("hold")).unwrap();
    until(|| f.status(&c, "original").is_ok_and(|o| o.settled)).await;
    assert_eq!(f.status(&c, "original").unwrap().state, State::Ready);
    f.manager
        .close_session(&f.row.id, &f.cwd, "owned-tools")
        .await
        .unwrap();
    assert_eq!(f.status(&c, "original").unwrap_err().code, Code::Changed);
    assert_eq!(f.queries(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn tools_expired_unpolled_and_busy_actor_admission_have_zero_query() {
    let (f, c) = Fixture::open(true).await;
    drop(f.read(&c, "unpolled"));
    assert!(
        f.manager
            .tools_read_until(
                &f.row.id,
                &f.cwd,
                "owned-tools",
                &c.connection_id,
                "expired",
                Query::Tools(None),
                tokio::time::Instant::now() - Duration::from_secs(1)
            )
            .await
            .is_err()
    );
    let lease = c.life.operation("open:owned-tools".into()).unwrap();
    assert_eq!(f.read(&c, "busy").await.unwrap_err().code, Code::Busy);
    drop(lease);
    assert_eq!(f.queries(), 0);
    assert_eq!(f.trace().len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn tools_ui_drop_actor_end_and_same_connection_replaced_control_keep_original_read_owned() {
    let (f, c) = Fixture::open(true).await;
    f.flag("hold");
    let (manager, cwd, agent, connection) = (
        f.manager.clone(),
        f.cwd.clone(),
        f.row.id.clone(),
        c.connection_id.clone(),
    );
    let task = tokio::spawn(async move {
        manager
            .tools_read(&agent, &cwd, "owned-tools", &connection, "dropped", None)
            .await
    });
    until(|| f.cwd.join("tools-started").exists()).await;
    task.abort();
    let _ = task.await;
    let (control, slot) = {
        let entries = c.sessions.lock().unwrap();
        let entry = entries.get("owned-tools").unwrap();
        (entry.control.clone(), entry.tools_report.clone())
    };
    control.send(SessionControl::Shutdown).unwrap();
    until(|| control.is_closed()).await;
    assert!(!c.life.finished());
    assert!(c.life.operation("open:owned-tools".into()).is_err());
    assert_eq!(f.status(&c, "dropped").unwrap_err().code, Code::Changed);
    std::fs::remove_file(f.cwd.join("hold")).unwrap();
    until(|| slot.snapshot("dropped").is_ok_and(|o| o.settled)).await;
    let stale = slot.snapshot("dropped").unwrap();
    assert_eq!(stale.error.unwrap().code, Code::Changed);
    assert!(stale.report.is_none());
    assert_eq!(f.queries(), 1);
    assert_eq!(f.trace().len(), 3);
    assert!(c.life.operation("open:owned-tools".into()).is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn tools_changed_actor_same_connection_cannot_consume_original_read_or_start_another() {
    let (f, c) = Fixture::open(true).await;
    f.flag("hold");
    let _ = f.short_read(&c, "old").await.unwrap();
    let (new_control, _receiver) = tokio::sync::mpsc::unbounded_channel();
    let (original, slot) = {
        let mut entries = c.sessions.lock().unwrap();
        let entry = entries.get_mut("owned-tools").unwrap();
        let original = entry.control.clone();
        entry.control = new_control;
        (original, entry.tools_report.clone())
    };
    assert_eq!(f.status(&c, "old").unwrap_err().code, Code::Changed);
    assert_eq!(
        f.read(&c, "new-owner").await.unwrap_err().code,
        Code::Changed
    );
    std::fs::remove_file(f.cwd.join("hold")).unwrap();
    until(|| slot.snapshot("old").is_ok_and(|o| o.settled)).await;
    assert_eq!(
        slot.snapshot("old").unwrap().error.unwrap().code,
        Code::Changed
    );
    c.sessions
        .lock()
        .unwrap()
        .get_mut("owned-tools")
        .unwrap()
        .control = original;
    assert_eq!(f.queries(), 1);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn tools_local_transport_error_is_not_method_not_found_and_retains_lease_to_real_reap() {
    let (f, c) = Fixture::open(true).await;
    f.flag("transport-error");
    let owner = f
        .manager
        .tools_owner(
            &f.row.id,
            &f.cwd,
            "owned-tools",
            &c.connection_id,
            "transport",
            Query::Tools(None),
        )
        .unwrap();
    let _ = f.read(&c, "transport").await;
    let current = owner.request.slot.snapshot("transport").unwrap();
    assert_eq!(current.state, State::Failed);
    assert!(!current.settled);
    assert_eq!(current.error.unwrap().code, Code::QueryFailed);
    assert!(c.session_tools.capability().is_some());
    assert!(!c.life.finished());
    assert!(c.life.operation("open:owned-tools".into()).is_err());
    c.life.close(true, None).unwrap();
    tokio::time::timeout(Duration::from_secs(8), c.life.terminated())
        .await
        .unwrap();
    until(|| {
        owner
            .request
            .slot
            .snapshot("transport")
            .is_ok_and(|o| o.settled)
    })
    .await;
    assert_eq!(f.queries(), 1);
}
