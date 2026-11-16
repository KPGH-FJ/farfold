//! Internal browser attachment still uses the real pump/actor and durable guard.
//! Synthetic official wire only; this is not an installed Agent/tool exercise.
use super::*;
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};
fn descriptor() -> Value {
    json!({"type":"mcp","server":{"type":"http","name":"OwnedBrowser","url":"http://127.0.0.1:0/mcp","headers":[]},"socket":"/owned/temporary.sock"})
}
async fn browser(
    f: &Fixture,
    c: &ManagedConnection,
    id: &str,
    check: Arc<dyn Fn(bool, &str) -> Result<(), ChangeError> + Send + Sync>,
) -> Reply {
    f.manager
        .change_start_with_browser(
            &f.store,
            &f.agent.id,
            &f.cwd,
            "owned-change",
            &c.connection_id,
            id,
            Change::AddLocalBrowser {
                descriptor: descriptor(),
            },
            tokio::time::Instant::now() + Duration::from_secs(3),
            Some(check),
        )
        .await
}
async fn established() -> (Fixture, ManagedConnection) {
    let (f, c) = Fixture::open_with_index(false).await;
    let saved = f.change(&c, "establish", Fixture::add()).await.unwrap();
    assert_eq!(saved.state, State::Ready);
    let removed = f
        .change(
            &c,
            "clear-establish",
            Change::Remove {
                item_ref: saved.items[0].item_ref.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(removed.state, State::Ready);
    (f, c)
}
#[tokio::test(flavor = "multi_thread")]
async fn browser_offer_does_not_save_a_fresh_conversation() {
    let (f, c) = Fixture::open_with_index(false).await;
    let result = browser(
        &f,
        &c,
        "fresh-browser",
        Arc::new(|_, _| panic!("must not attach")),
    )
    .await
    .unwrap_err();
    assert_eq!(result.not_dispatched, Some(true));
    assert_eq!(result.code, Code::Changed);
    assert!(f.store.get_session(&f.row_id).unwrap().is_none());
    assert!(!f.pending());
    assert!(!f.trace().iter().any(|v| v["method"] == ADD));
}
#[tokio::test(flavor = "multi_thread")]
async fn browser_exact_socket_add_requires_local_witness_and_reuses_original_operation() {
    let (f, c) = established().await;
    let before = f.store.get_session(&f.row_id).unwrap().unwrap();
    let observations = Arc::new(Mutex::new(Vec::new()));
    let seen = observations.clone();
    let store = f.store.clone();
    let row = f.row_id.clone();
    let added = browser(
        &f,
        &c,
        "browser-one",
        Arc::new(move |confirmed, key| {
            assert_eq!(key, "assigned-exact-key");
            assert_eq!(store.mcp_pending(&row).unwrap().is_none(), confirmed);
            seen.lock().unwrap().push(confirmed);
            Ok(())
        }),
    )
    .await
    .unwrap();
    assert_eq!(added.state, State::Ready);
    assert_eq!(added.activity, Activity::ToolsReported);
    assert!(!f.pending());
    assert_eq!(*observations.lock().unwrap(), vec![false, true]);
    assert_eq!(f.store.get_session(&f.row_id).unwrap(), Some(before));
    let again = browser(
        &f,
        &c,
        "browser-one",
        Arc::new(|_, _| panic!("same ID must not reattach")),
    )
    .await
    .unwrap();
    assert_eq!(again.state, State::Ready);
    let adds: Vec<_> = f
        .trace()
        .into_iter()
        .filter(|v| v["method"] == ADD)
        .collect();
    assert_eq!(adds.len(), 2);
    assert_eq!(adds[1]["params"]["extension"], descriptor());
    let removed = f
        .manager
        .change_start_with_browser(
            &f.store,
            &f.agent.id,
            &f.cwd,
            "owned-change",
            &c.connection_id,
            "browser-remove",
            Change::RemoveLocalBrowser {
                key: "assigned-exact-key".into(),
                descriptor: descriptor(),
            },
            tokio::time::Instant::now() + Duration::from_secs(3),
            None,
        )
        .await
        .unwrap();
    assert_eq!(removed.state, State::Ready);
    assert_eq!(removed.persistence, Persistence::Confirmed);
    let calls = f.trace();
    assert_eq!(calls.iter().filter(|v| v["method"] == REMOVE).count(), 2);
    assert_eq!(
        calls.iter().rfind(|v| v["method"] == REMOVE).unwrap()["params"]["extensionKey"],
        "assigned-exact-key"
    );
    assert!(!calls.iter().any(|v| v["method"] == "session/prompt"));
}
#[tokio::test(flavor = "multi_thread")]
async fn browser_absent_local_witness_keeps_pending_and_never_repeats_add() {
    let (f, c) = established().await;
    let completed = Arc::new(AtomicUsize::new(0));
    let seen = completed.clone();
    let result = browser(
        &f,
        &c,
        "no-witness",
        Arc::new(move |saved, _| {
            assert!(!saved);
            seen.fetch_add(1, Ordering::SeqCst);
            Err(Code::InvalidResponse.into())
        }),
    )
    .await
    .unwrap();
    assert_eq!(result.state, State::Unknown);
    assert!(result.mutation_sent);
    assert!(f.pending());
    assert_eq!(completed.load(Ordering::SeqCst), 1);
    let replay = browser(
        &f,
        &c,
        "no-witness",
        Arc::new(|_, _| panic!("must not repeat")),
    )
    .await
    .unwrap();
    assert_eq!(replay.state, State::Unknown);
    assert_eq!(f.trace().iter().filter(|v| v["method"] == ADD).count(), 2);
    assert!(f.store.require_mcp_ready(&f.row_id).is_err());
}
#[test]
fn local_socket_changes_cannot_be_selected_from_user_ipc() {
    for value in [
        json!({"kind":"addLocalBrowser","descriptor":descriptor()}),
        json!({"kind":"removeLocalBrowser","key":"x","descriptor":descriptor()}),
    ] {
        assert!(serde_json::from_value::<Change>(value).is_err());
    }
}
#[derive(Default)]
struct BrowserOwner {
    closed: AtomicUsize,
    revoked: AtomicUsize,
}
impl super::super::super::transient_mcp::SessionMcpOwner for BrowserOwner {
    fn bind_session(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn set_prompt_active(&self, _: bool) {}
    fn fork_admissible(&self) -> bool {
        false
    }
    fn revoke(&self) {
        self.revoked.fetch_add(1, Ordering::SeqCst);
    }
    fn prepare_close(
        self: Arc<Self>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>> {
        Box::pin(async move {
            self.closed.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
    }
}
#[tokio::test(flavor = "multi_thread")]
async fn browser_close_rejects_wrong_preview_before_any_owned_cleanup() {
    let (f, c) = established().await;
    let original = Arc::new(BrowserOwner::default());
    let owner = f
        .manager
        .browser_uds_owner(&f.agent.id, &f.cwd, "owned-change", &c.connection_id)
        .unwrap();
    owner.attach(original.clone()).unwrap();
    assert!(
        f.manager
            .close_session_owned(&f.agent.id, &f.cwd, "owned-change", Some("wrong-preview"))
            .await
            .is_err()
    );
    assert_eq!(original.closed.load(Ordering::SeqCst), 0);
    assert_eq!(original.revoked.load(Ordering::SeqCst), 0);
    assert!(c.sessions.lock().unwrap().contains_key("owned-change"));
    f.manager
        .close_session(&f.agent.id, &f.cwd, "owned-change")
        .await
        .unwrap();
    assert_eq!(original.closed.load(Ordering::SeqCst), 1);
}
#[tokio::test(flavor = "multi_thread")]
async fn browser_detach_only_exact_owner_allows_explicit_new_connection_after_cancelled_exit() {
    use super::super::super::transient_mcp::SessionMcpOwner;
    let (f, c) = established().await;
    let identity = f
        .manager
        .browser_uds_owner(&f.agent.id, &f.cwd, "owned-change", &c.connection_id)
        .unwrap();
    let first: Arc<dyn SessionMcpOwner> = Arc::new(BrowserOwner::default());
    let unrelated: Arc<dyn SessionMcpOwner> = Arc::new(BrowserOwner::default());
    identity.attach(first.clone()).unwrap();
    assert!(
        f.manager
            .browser_uds_eligibility(&f.store, &f.agent.id, &f.cwd, "owned-change")
            .await
            .connection_id
            .is_none()
    );
    assert!(
        f.manager
            .browser_uds_detach(
                &f.agent.id,
                &f.cwd,
                "owned-change",
                &c.connection_id,
                &unrelated
            )
            .is_err()
    );
    f.manager
        .browser_uds_detach(
            &f.agent.id,
            &f.cwd,
            "owned-change",
            &c.connection_id,
            &first,
        )
        .unwrap();
    assert_eq!(
        f.manager
            .browser_uds_eligibility(&f.store, &f.agent.id, &f.cwd, "owned-change")
            .await
            .connection_id,
        Some(c.connection_id.clone())
    );
    identity.attach(unrelated.clone()).unwrap();
    assert!(
        f.manager
            .browser_uds_detach(
                &f.agent.id,
                &f.cwd,
                "owned-change",
                &c.connection_id,
                &first
            )
            .is_err()
    );
    assert!(
        c.sessions
            .lock()
            .unwrap()
            .get("owned-change")
            .unwrap()
            ._mcp_lease
            .is_some()
    );
}
#[tokio::test(flavor = "multi_thread")]
async fn browser_eligibility_distinguishes_saved_pending_from_missing_conversation() {
    let (f, c) = Fixture::open_with_index(false).await;
    let before = f
        .manager
        .browser_uds_eligibility(&f.store, &f.agent.id, &f.cwd, "owned-change")
        .await;
    assert_eq!(before.reason, "saved_conversation_required");
    assert!(before.connection_id.is_none());
    f.flag("save-failure");
    let result = f
        .change(&c, "unknown-configuration", Fixture::add())
        .await
        .unwrap();
    assert_eq!(result.state, State::Unknown);
    assert!(f.pending());
    let after = f
        .manager
        .browser_uds_eligibility(&f.store, &f.agent.id, &f.cwd, "owned-change")
        .await;
    assert_eq!(after.reason, "tool_change_pending");
    assert!(after.connection_id.is_none());
}
#[tokio::test(flavor = "multi_thread")]
async fn browser_cleanup_accepts_independently_verified_absence_without_guessing_another_key() {
    let (f, c) = established().await;
    let before = f.trace().iter().filter(|v| v["method"] == REMOVE).count();
    let result = f
        .manager
        .change_start_with_browser(
            &f.store,
            &f.agent.id,
            &f.cwd,
            "owned-change",
            &c.connection_id,
            "already-removed",
            Change::RemoveLocalBrowser {
                key: "assigned-exact-key".into(),
                descriptor: descriptor(),
            },
            tokio::time::Instant::now() + Duration::from_secs(3),
            None,
        )
        .await
        .unwrap();
    assert_eq!(result.state, State::Ready);
    assert_eq!(result.persistence, Persistence::Confirmed);
    assert!(!result.mutation_sent);
    assert!(!f.pending());
    assert_eq!(
        f.trace().iter().filter(|v| v["method"] == REMOVE).count(),
        before
    );
    let wrong = f
        .manager
        .change_start_with_browser(
            &f.store,
            &f.agent.id,
            &f.cwd,
            "owned-change",
            &c.connection_id,
            "wrong-key",
            Change::RemoveLocalBrowser {
                key: "original-key".into(),
                descriptor: descriptor(),
            },
            tokio::time::Instant::now() + Duration::from_secs(3),
            None,
        )
        .await
        .unwrap();
    assert_eq!(wrong.state, State::Failed);
    assert!(!wrong.mutation_sent);
    assert!(!f.pending());
    assert_eq!(
        f.trace().iter().filter(|v| v["method"] == REMOVE).count(),
        before
    );
}
