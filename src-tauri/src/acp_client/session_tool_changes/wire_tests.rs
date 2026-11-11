//! Actual manager/pump with a controlled peer and temporary metadata only.
use super::super::manager::ManagedConnection;
use super::*;
use crate::meta_store::AgentRow;
use serde_json::{Value, json};
use std::path::PathBuf;

struct Fixture {
    _dir: tempfile::TempDir,
    cwd: PathBuf,
    store: MetaStore,
    agent: AgentRow,
    row_id: String,
    manager: Arc<AcpManager>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.stop_for_shutdown();
    }
}
impl Fixture {
    async fn open() -> (Self, ManagedConnection) {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().canonicalize().unwrap();
        let script = cwd.join("peer.py");
        std::fs::write(&script, include_str!("peer.py")).unwrap();
        let store = MetaStore::open(&cwd.join("meta.db")).unwrap();
        let agent = AgentRow {
            id: "change-fixture".into(),
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
        store.insert_agent(&agent).unwrap();
        let manager = Arc::new(AcpManager::new(cwd.join("logs"), cwd.clone()));
        let opened = manager
            .open_session(&agent, &cwd, None, vec![], Arc::new(|_| {}), &store)
            .await
            .unwrap();
        let connection = manager
            .session_connection(&agent.id, &cwd, &opened.session_id)
            .unwrap();
        connection.session_tools.enable_for_test();
        let row_id = super::super::session_index::session_row_id(
            &agent.id,
            &cwd.to_string_lossy(),
            &opened.session_id,
        );
        if store.get_session(&row_id).unwrap().is_none() {
            store
                .upsert_session(&SessionRow {
                    id: row_id.clone(),
                    agent_id: agent.id.clone(),
                    cwd: cwd.to_string_lossy().into(),
                    native_session_id: Some(opened.session_id),
                    title: Some("Owned".into()),
                    config_options: None,
                    pinned: false,
                    archived: false,
                    created_at: 0,
                    updated_at: 0,
                })
                .unwrap();
        }
        (
            Self {
                _dir: dir,
                cwd,
                store,
                agent,
                row_id,
                manager,
            },
            connection,
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
    fn add() -> Change {
        Change::AddHttp {
            name: "Owned".into(),
            url: "http://127.0.0.1:8910/mcp?opaque=PRIVATE_URL_CANARY".into(),
        }
    }
    async fn change(&self, c: &ManagedConnection, id: &str, change: Change) -> Reply {
        self.manager
            .change_start(
                &self.store,
                &self.agent.id,
                &self.cwd,
                "owned-change",
                &c.connection_id,
                id,
                change,
                tokio::time::Instant::now() + Duration::from_secs(3),
            )
            .await
    }
    fn status(&self, c: &ManagedConnection, id: &str) -> Operation {
        self.manager
            .change_status(
                &self.agent.id,
                &self.cwd,
                "owned-change",
                &c.connection_id,
                id,
            )
            .unwrap()
    }
    fn pending(&self) -> bool {
        self.store.mcp_pending(&self.row_id).unwrap().is_some()
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
async fn exact_add_report_remove_roundtrip_protects_original_and_never_replays_status() {
    let (f, c) = Fixture::open().await;
    let added = f.change(&c, "add", Fixture::add()).await.unwrap();
    assert_eq!(added.state, State::Ready);
    assert!(added.settled && added.mutation_sent);
    assert_eq!(added.persistence, Persistence::Confirmed);
    assert_eq!(added.activity, Activity::ToolsReported);
    assert_eq!(added.items.len(), 1);
    assert!(!f.pending());
    let count = f.trace().len();
    assert_eq!(f.status(&c, "add").items, added.items);
    assert_eq!(
        f.change(&c, "add", Fixture::add()).await.unwrap().items,
        added.items
    );
    assert_eq!(
        f.manager
            .change_items(&f.agent.id, &f.cwd, "owned-change", &c.connection_id)
            .unwrap(),
        added.items
    );
    assert_eq!(f.trace().len(), count);
    let removed = f
        .change(
            &c,
            "remove",
            Change::Remove {
                item_ref: added.items[0].item_ref.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(removed.state, State::Ready);
    assert_eq!(removed.activity, Activity::AbsentReported);
    assert!(removed.items.is_empty());
    assert!(!f.pending());
    let calls = f.trace();
    let remove = calls.iter().find(|v| v["method"] == REMOVE).unwrap();
    assert_eq!(
        remove["params"],
        json!({"sessionId":"owned-change","extensionKey":"assigned-exact-key"})
    );
    assert!(!serde_json::to_string(&added).unwrap().contains("PRIVATE_"));
    assert!(
        calls
            .iter()
            .all(|v| v["method"] != "session/prompt" && v["method"] != "tools/call")
    );
    assert_eq!(
        f.change(
            &c,
            "remove-again",
            Change::Remove {
                item_ref: added.items[0].item_ref.clone()
            }
        )
        .await
        .unwrap()
        .state,
        State::Failed
    );
}
#[tokio::test(flavor = "multi_thread")]
async fn live_first_save_error_keeps_durable_unknown_and_sends_no_retry() {
    let (f, c) = Fixture::open().await;
    f.flag("save-failure");
    let outcome = f.change(&c, "save-error", Fixture::add()).await.unwrap();
    assert_eq!(outcome.state, State::Unknown);
    assert!(outcome.settled && outcome.mutation_sent && f.pending());
    assert!(outcome.items.is_empty());
    assert_eq!(outcome.persistence, Persistence::Unknown);
    let trace = f.trace().len();
    assert_eq!(f.status(&c, "save-error").state, State::Unknown);
    assert_eq!(
        f.change(&c, "another", Fixture::add())
            .await
            .unwrap_err()
            .code,
        Code::Busy
    );
    assert_eq!(f.trace().len(), trace);
    assert!(
        !serde_json::to_string(&outcome)
            .unwrap()
            .contains("PRIVATE_")
    );
}
#[tokio::test(flavor = "multi_thread")]
async fn observation_failure_after_add_is_unknown_even_when_persisted_entry_matches() {
    let (f, c) = Fixture::open().await;
    f.flag("hidden-tools");
    let outcome = f.change(&c, "no-tools", Fixture::add()).await.unwrap();
    assert_eq!(outcome.state, State::Unknown);
    assert!(outcome.mutation_sent && f.pending());
    assert!(outcome.items.is_empty());
    assert_eq!(outcome.activity, Activity::Unreported);
}
#[tokio::test(flavor = "multi_thread")]
async fn unrelated_set_drift_and_remove_save_failure_never_claim_success() {
    let (f, c) = Fixture::open().await;
    f.flag("drift-after-add");
    let outcome = f.change(&c, "drift", Fixture::add()).await.unwrap();
    assert_eq!(outcome.state, State::Unknown);
    assert!(f.pending());
    let (f, c) = Fixture::open().await;
    let added = f.change(&c, "add", Fixture::add()).await.unwrap();
    f.flag("remove-save-failure");
    let result = f
        .change(
            &c,
            "remove",
            Change::Remove {
                item_ref: added.items[0].item_ref.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(result.state, State::Unknown);
    assert_eq!(result.items, added.items);
    assert!(f.pending());
}
#[tokio::test(flavor = "multi_thread")]
async fn malformed_before_report_and_forged_target_do_not_offer_mutation() {
    let (f, c) = Fixture::open().await;
    f.flag("invalid-list");
    let outcome = f.change(&c, "invalid", Fixture::add()).await.unwrap();
    assert_eq!(outcome.state, State::Failed);
    assert!(!outcome.mutation_sent);
    assert!(!f.pending());
    assert!(f.trace().iter().all(|v| v["method"] != ADD));
    std::fs::remove_file(f.cwd.join("invalid-list")).unwrap();
    let outcome = f
        .change(
            &c,
            "forged",
            Change::Remove {
                item_ref: "assigned-exact-key".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(outcome.state, State::Failed);
    assert!(!outcome.mutation_sent);
    assert!(!f.pending());
    assert!(f.trace().iter().all(|v| v["method"] != REMOVE));
}

#[tokio::test(flavor = "multi_thread")]
async fn inspect_retrieves_preexisting_http_by_exact_key_without_mutation_or_adoption_claim() {
    let (f, c) = Fixture::open().await;
    f.flag("seed-http");
    let result = f.change(&c, "inspect", Change::Inspect).await.unwrap();
    assert_eq!(result.kind, "inspect");
    assert_eq!(result.state, State::Ready);
    assert_eq!(result.persistence, Persistence::Unreported);
    assert_eq!(result.activity, Activity::Unreported);
    assert!(!result.mutation_sent && !f.pending());
    assert_eq!(result.items.len(), 1);
    assert!(result.items[0].can_remove);
    assert_eq!(f.trace().iter().filter(|v| v["method"] == LIST).count(), 1);
    assert!(
        f.trace()
            .iter()
            .all(|v| v["method"] != ADD && v["method"] != REMOVE)
    );
    assert!(!serde_json::to_string(&result).unwrap().contains("PRIVATE_"));
    let removed = f
        .change(
            &c,
            "remove",
            Change::Remove {
                item_ref: result.items[0].item_ref.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(removed.state, State::Ready);
    assert_eq!(removed.persistence, Persistence::Confirmed);
    assert_eq!(removed.activity, Activity::Unreported);
    assert!(!f.pending());
    assert_eq!(
        f.trace().iter().find(|v| v["method"] == REMOVE).unwrap()["params"]["extensionKey"],
        "prior-key"
    );
}
#[tokio::test(flavor = "multi_thread")]
async fn changed_full_set_and_ambiguous_display_names_invalidate_removal_handles() {
    let (f, c) = Fixture::open().await;
    f.flag("seed-http");
    let inspected = f.change(&c, "inspect", Change::Inspect).await.unwrap();
    f.flag("drift-before-remove");
    let rejected = f
        .change(
            &c,
            "stale",
            Change::Remove {
                item_ref: inspected.items[0].item_ref.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(rejected.state, State::Failed);
    assert!(!rejected.mutation_sent && !f.pending());
    assert!(f.trace().iter().all(|v| v["method"] != REMOVE));
    let (f, c) = Fixture::open().await;
    f.flag("seed-http");
    f.flag("duplicate-name");
    let inspected = f.change(&c, "inspect", Change::Inspect).await.unwrap();
    assert_eq!(inspected.items.len(), 2);
    assert!(inspected.items.iter().all(|i| !i.can_remove));
    let rejected = f
        .change(
            &c,
            "ambiguous",
            Change::Remove {
                item_ref: inspected.items[0].item_ref.clone(),
            },
        )
        .await
        .unwrap();
    assert!(!rejected.mutation_sent);
    assert!(f.trace().iter().all(|v| v["method"] != REMOVE));
}
#[tokio::test(flavor = "multi_thread")]
async fn early_and_expired_admission_prove_not_dispatched_without_a_durable_marker() {
    let (f, c) = Fixture::open().await;
    let error = f
        .change(
            &c,
            "invalid",
            Change::AddHttp {
                name: "bad/name".into(),
                url: "https://example.invalid".into(),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.not_dispatched, Some(true));
    assert!(!f.pending());
    let error = f
        .manager
        .change_start(
            &f.store,
            &f.agent.id,
            &f.cwd,
            "owned-change",
            &c.connection_id,
            "expired",
            Fixture::add(),
            tokio::time::Instant::now(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.not_dispatched, Some(true));
    assert!(!f.pending());
    assert!(f.trace().iter().all(|v| v["method"] != ADD));
}

#[tokio::test(flavor = "multi_thread")]
async fn observer_disappearing_after_pump_takes_command_cannot_offer_a_mutation() {
    use std::sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    };
    let (f, c) = Fixture::open().await;
    let owner = f
        .manager
        .change_owner(&f.agent.id, &f.cwd, "owned-change", &c.connection_id)
        .unwrap();
    let (result, receive) = oneshot::channel();
    let receiver = Arc::new(Mutex::new(Some(receive)));
    let called = Arc::new(AtomicBool::new(false));
    let original = owner.current.clone();
    let taken = called.clone();
    let current_owner = Arc::new(move || {
        receiver.lock().unwrap().take();
        taken.store(true, Ordering::SeqCst);
        original()
    });
    let request = Request {
        operation: Operation {
            kind: "addHttp",
            operation_id: "lost-admission".into(),
            agent_id: f.agent.id.clone(),
            cwd: f.cwd.to_string_lossy().into(),
            native_session_id: "owned-change".into(),
            connection_id: c.connection_id.clone(),
            state: State::Pending,
            settled: false,
            mutation_sent: false,
            persistence: Persistence::Unreported,
            activity: Activity::Unreported,
            items: vec![],
            error: None,
        },
        change: Fixture::add(),
        slot: owner.slot.clone(),
        availability: owner.availability,
        current_owner,
        store: f.store.clone(),
        row: f.store.get_session(&f.row_id).unwrap().unwrap(),
    };
    owner
        .control
        .send(SessionControl::ToolsChange {
            request: Box::new(request),
            deadline: tokio::time::Instant::now() + Duration::from_secs(3),
            result,
        })
        .unwrap();
    until(|| called.load(Ordering::SeqCst)).await;
    let (barrier, acknowledged) = oneshot::channel();
    owner
        .control
        .send(SessionControl::CheckUnapprovedStoppedClose {
            deadline: tokio::time::Instant::now() + Duration::from_secs(3),
            result: barrier,
        })
        .unwrap();
    let _ = acknowledged.await.unwrap();
    assert!(!owner.slot.was_admitted("lost-admission"));
    assert!(!f.pending());
    assert!(f.trace().iter().all(|v| v["method"] != ADD));
}
#[tokio::test(flavor = "multi_thread")]
async fn pump_rejects_other_changes_before_the_durable_marker_has_been_written() {
    let (f, c) = Fixture::open().await;
    f.flag("hold-list");
    let manager = f.manager.clone();
    let store = f.store.clone();
    let agent = f.agent.id.clone();
    let cwd = f.cwd.clone();
    let connection = c.connection_id.clone();
    let observer = tokio::spawn(async move {
        manager
            .change_start(
                &store,
                &agent,
                &cwd,
                "owned-change",
                &connection,
                "reading",
                Fixture::add(),
                tokio::time::Instant::now() + Duration::from_secs(3),
            )
            .await
    });
    until(|| f.cwd.join("list-started").exists()).await;
    assert!(!f.pending());
    let control = c
        .sessions
        .lock()
        .unwrap()
        .get("owned-change")
        .unwrap()
        .control
        .clone();
    let (result, receive) = oneshot::channel();
    control
        .send(SessionControl::SetConfig {
            config_id: "model".into(),
            value: json!("different"),
            deadline: tokio::time::Instant::now() + Duration::from_secs(3),
            result,
        })
        .unwrap();
    assert_eq!(
        receive.await.unwrap().unwrap_err(),
        "工具修改正在处理，请等待结果后再继续"
    );
    assert!(
        f.trace()
            .iter()
            .all(|v| v["method"] != "session/set_config_option")
    );
    std::fs::remove_file(f.cwd.join("hold-list")).unwrap();
    assert_eq!(observer.await.unwrap().unwrap().state, State::Ready);
}
#[tokio::test(flavor = "multi_thread")]
async fn lost_management_capability_does_not_hide_the_owned_unknown_receipt() {
    let (f, c) = Fixture::open().await;
    f.flag("unsupported-add");
    let result = f.change(&c, "unsupported", Fixture::add()).await.unwrap();
    assert_eq!(result.state, State::Unknown);
    assert!(f.pending());
    assert!(!c.session_tools.management_supported());
    assert_eq!(f.status(&c, "unsupported").state, State::Unknown);
    let repeat = f.change(&c, "unsupported", Fixture::add()).await.unwrap();
    assert_eq!(repeat.state, State::Unknown);
    assert_eq!(f.trace().iter().filter(|v| v["method"] == ADD).count(), 1);
}
#[tokio::test(flavor = "multi_thread")]
async fn dropped_observer_and_short_wait_keep_one_owner_until_real_reply() {
    let (f, c) = Fixture::open().await;
    f.flag("hold-add");
    let manager = f.manager.clone();
    let store = f.store.clone();
    let agent = f.agent.id.clone();
    let cwd = f.cwd.clone();
    let connection = c.connection_id.clone();
    let observer = tokio::spawn(async move {
        manager
            .change_start(
                &store,
                &agent,
                &cwd,
                "owned-change",
                &connection,
                "held",
                Fixture::add(),
                tokio::time::Instant::now() + Duration::from_secs(3),
            )
            .await
    });
    until(|| f.cwd.join("mutation-applied").exists()).await;
    observer.abort();
    let _ = observer.await;
    assert!(f.pending());
    assert!(!f.status(&c, "held").settled);
    assert_eq!(
        f.change(&c, "second", Fixture::add())
            .await
            .unwrap_err()
            .code,
        Code::Busy
    );
    std::fs::remove_file(f.cwd.join("hold-add")).unwrap();
    until(|| f.status(&c, "held").settled).await;
    assert_eq!(f.status(&c, "held").state, State::Ready);
    assert!(!f.pending());
    assert_eq!(f.trace().iter().filter(|v| v["method"] == ADD).count(), 1);
}
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn lost_transport_retains_original_work_until_the_owned_process_really_ends() {
    let (f, c) = Fixture::open().await;
    f.flag("transport-loss");
    let owner = f
        .manager
        .change_owner(&f.agent.id, &f.cwd, "owned-change", &c.connection_id)
        .unwrap();
    let _ = f.change(&c, "transport", Fixture::add()).await;
    let result = owner.slot.snapshot("transport").unwrap();
    assert_eq!(result.state, State::Unknown);
    assert!(!result.settled);
    assert!(f.pending());
    assert!(c.life.operation("open:owned-change".into()).is_err());
    f.flag("end-process");
    until(|| c.life.finished()).await;
    until(|| owner.slot.snapshot("transport").unwrap().settled).await;
    assert!(f.pending());
}
