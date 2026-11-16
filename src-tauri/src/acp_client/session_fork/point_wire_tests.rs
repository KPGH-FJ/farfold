//! The real locked SDK and pump with owned stdio peers; no actual Agent/model.
use super::*;
use crate::acp_client::session_fork::HistoryPoint;

async fn point_parent(f: &Fixture, mode: &str) -> (String, Events) {
    std::fs::write(f.cwd.join("peer.py"), include_str!("point_peer.py")).unwrap();
    std::fs::write(f.cwd.join("point-mode"), mode).unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let opened = f
        .manager
        .open_session(&f.row, &f.cwd, None, vec![], sink(&events), &f.store)
        .await
        .unwrap();
    let connection = f
        .manager
        .session_connection(&f.row.id, &f.cwd, "parent")
        .unwrap();
    connection.session_tools.enable_for_test();
    let capability = crate::acp_client::session_fork::capabilities(&connection, "parent");
    assert!(!capability.fork_current_context);
    assert!(
        capability.fork_historical_point,
        "reviewed supplement does not require a fork declaration"
    );
    f.manager
        .session_prompt(
            &f.row.id,
            &f.cwd,
            "parent",
            serde_json::from_value(json!([{"type":"text","text":"fixture-save"}])).unwrap(),
        )
        .await
        .unwrap();
    until(|| {
        events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "turnEnd")
    })
    .await;
    (opened.connection_id, events)
}
async fn pointed(
    f: &Fixture,
    connection: &str,
    events: &Events,
    id: &str,
) -> crate::acp_client::session_fork::ForkResult {
    f.manager
        .fork_selected(
            f.row.clone(),
            &f.cwd,
            "parent",
            connection,
            "selected-operation".into(),
            "point-open".into(),
            sink(events),
            Arc::new(AtomicBool::new(false)),
            &f.store,
            None,
            Some(HistoryPoint {
                message_id: id.into(),
            }),
        )
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn historical_point_official_supplement_uses_exact_cutoff_and_retains_original_operation() {
    let f = Fixture::new();
    let (connection, events) = point_parent(&f, "normal").await;
    let result = pointed(&f, &connection, &events, "b").await;
    assert_eq!(result.status, "ready");
    assert_eq!(
        result.history_point,
        Some(HistoryPoint {
            message_id: "b".into()
        })
    );
    let requests = trace(&f);
    let fork = requests
        .iter()
        .find(|v| v["method"] == "session/fork")
        .unwrap();
    assert_eq!(fork["params"]["_meta"], json!({"conversationBefore":3}));
    assert_eq!(count(&f, "_goose/unstable/session/export"), 5);
    until(|| {
        f.manager
            .opening_sessions
            .reserve(&f.row.id, &f.cwd, "parent")
            .is_ok()
    })
    .await;
    let repeat = pointed(&f, &connection, &events, "b").await;
    assert_eq!(repeat.child_session_id, result.child_session_id);
    assert_eq!(repeat.status, "ready");
    let conflict = pointed(&f, &connection, &events, "a").await;
    assert_eq!(conflict.status, "rejected");
    assert_eq!(conflict.reason, Some("point_unavailable"));
    let changed_observer = f
        .manager
        .begin_fork_selected(
            f.row.clone(),
            &f.cwd,
            "parent",
            &connection,
            "selected-operation".into(),
            "different-open".into(),
            sink(&events),
            Arc::new(AtomicBool::new(false)),
            &f.store,
            None,
            Some(HistoryPoint {
                message_id: "b".into(),
            }),
        )
        .await;
    assert!(
        changed_observer.is_err(),
        "an operation cannot be moved to another opening observer"
    );
    assert_eq!(count(&f, "session/fork"), 1);
    assert_eq!(count(&f, "_goose/unstable/session/export"), 5);
}

#[tokio::test(flavor = "multi_thread")]
async fn historical_point_unavailable_ambiguous_and_config_drift_never_dispatch_fork() {
    for (mode, id, reason) in [
        ("normal", "missing", "point_unavailable"),
        ("normal", "later-20", "point_unavailable"),
        ("normal", "a", "point_ambiguous"),
        ("read-error", "b", "point_read_failed"),
        ("config-drift", "b", "configuration"),
    ] {
        let f = Fixture::new();
        let (connection, events) = point_parent(&f, mode).await;
        let result = pointed(&f, &connection, &events, id).await;
        assert_eq!(result.status, "rejected", "{mode}/{id}");
        assert_eq!(result.reason, Some(reason), "{mode}/{id}");
        assert_eq!(
            result.history_point.as_ref().map(|v| v.message_id.as_str()),
            Some(id)
        );
        assert_eq!(count(&f, "session/fork"), 0);
        assert_eq!(result.child_session_id, None);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn historical_point_ignored_selector_or_changed_source_retains_real_child_without_ready() {
    for mode in [
        "ignore-point",
        "parent-change",
        "load-rewrite",
        "after-child-read-error",
    ] {
        let f = Fixture::new();
        let (connection, events) = point_parent(&f, mode).await;
        let result = pointed(&f, &connection, &events, "b").await;
        assert_eq!(result.status, "created_unavailable", "{mode}");
        assert_eq!(
            result.reason,
            Some(if mode == "after-child-read-error" {
                "point_read_failed"
            } else {
                "point_mismatch"
            })
        );
        assert_eq!(result.child_session_id.as_deref(), Some("child"));
        assert!(result.indexed);
        assert!(result.session.is_none());
        assert_eq!(count(&f, "session/fork"), 1);
        assert_eq!(
            count(&f, "session/load"),
            usize::from(mode == "load-rewrite")
        );
        assert!(
            f.manager
                .opening_sessions
                .reserve(&f.row.id, &f.cwd, "parent")
                .is_err()
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn historical_point_read_deadline_keeps_single_wire_and_never_mutates_later() {
    let f = Fixture::new();
    let (connection, events) = point_parent(&f, "hold-read").await;
    let result = tokio::time::timeout(
        Duration::from_secs(30),
        pointed(&f, &connection, &events, "b"),
    )
    .await
    .unwrap();
    assert_eq!(result.status, "rejected");
    assert_eq!(result.reason, Some("point_read_failed"));
    let second = pointed(&f, &connection, &events, "b").await;
    assert_eq!(second.status, "rejected");
    assert_eq!(count(&f, "_goose/unstable/session/export"), 1);
    assert_eq!(count(&f, "session/fork"), 0);
    std::fs::write(f.cwd.join("release-read"), "").unwrap();
    let owner = f
        .manager
        .session_connection(&f.row.id, &f.cwd, "parent")
        .unwrap();
    until(|| owner.life.operation("fork-point:parent".into()).is_ok()).await;
    assert_eq!(count(&f, "session/fork"), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn historical_point_compacted_prefix_without_later_summary_never_dispatches() {
    let f = Fixture::new();
    let (connection, events) = point_parent(&f, "compacted").await;
    let result = pointed(&f, &connection, &events, "b").await;
    assert_eq!(
        count(&f, "session/fork"),
        0,
        "a visible historical prefix is not necessarily complete Agent context"
    );
    assert_eq!(result.status, "rejected");
    assert_eq!(result.reason, Some("point_context_unavailable"));
}

#[tokio::test(flavor = "multi_thread")]
async fn historical_point_official_extension_reorder_after_child_load_is_ready_once() {
    let f = Fixture::new();
    let (connection, events) = point_parent(&f, "extension-reorder").await;
    let result = pointed(&f, &connection, &events, "b").await;
    assert_eq!(
        result.status,
        "ready",
        "the official load persisted the same seven complete descriptors in another order: reason={:?}, requests={:?}",
        result.reason,
        trace(&f)
            .iter()
            .map(|v| v["method"].clone())
            .collect::<Vec<_>>()
    );
    assert_eq!(result.child_session_id.as_deref(), Some("child"));
    assert!(result.indexed);
    assert!(result.session.is_some());
    assert_eq!(count(&f, "session/fork"), 1);
    assert_eq!(count(&f, "session/load"), 2);
    assert_eq!(count(&f, "initialize"), 2);
    assert_eq!(count(&f, "_goose/unstable/session/export"), 5);
    let repeat = pointed(&f, &connection, &events, "b").await;
    assert_eq!(repeat.status, "ready");
    assert_eq!(repeat.child_session_id, result.child_session_id);
    assert_eq!(count(&f, "session/fork"), 1);
    assert_eq!(count(&f, "_goose/unstable/session/export"), 5);
}
