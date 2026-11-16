//! The real pending commit shares the service-mutation lock; no system vault.
use super::*;
use crate::meta_store::{
    SessionRow,
    mcp_pending::{Action, Pending},
};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
    mpsc,
};
use std::time::Duration;

#[derive(Default)]
struct MemoryVault {
    writes: AtomicUsize,
    deletes: AtomicUsize,
}
impl Vault for MemoryVault {
    fn put(&self, _: &str, _: &str) -> Result<(), String> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn get(&self, _: &str) -> Option<String> {
        Some("fixture-secret".into())
    }
    fn delete(&self, _: &str) -> Result<(), String> {
        self.deletes.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}
fn fixture() -> (MetaStore, SessionRow, Pending) {
    let store = MetaStore::test_memory();
    let credential = Credential {
        id: "selected".into(),
        label: "Selected".into(),
        provider: "fixture".into(),
        purpose: None,
        endpoint: "https://example.test/api".into(),
        api_type: "chat-completions".into(),
        models: vec!["model".into()],
        secret_ref: "reference".into(),
        retired: vec![],
        grants: vec![],
        deleting: false,
    };
    write(
        &store,
        &[
            credential.clone(),
            Credential {
                id: "unrelated".into(),
                ..credential.clone()
            },
        ],
    )
    .unwrap();
    let identity = ServiceIdentity {
        id: credential.id,
        fingerprint: service_fingerprint(&credential.endpoint, &credential.api_type),
        model: "model".into(),
    };
    let row = SessionRow {
        id: "row".into(),
        agent_id: "owner".into(),
        cwd: "/fixture".into(),
        native_session_id: Some("native".into()),
        title: None,
        config_options: Some(
            serde_json::json!({"_farfoldService":{"kind":"configured","identity":identity}}),
        ),
        pinned: false,
        archived: false,
        created_at: 1,
        updated_at: 1,
    };
    store.upsert_session(&row).unwrap();
    let pending = Pending {
        operation_id: "operation".into(),
        action: Action::Add,
        before_digest: "a".repeat(64),
        expected_digest: None,
        target_digest: "b".repeat(64),
    };
    (store, row, pending)
}

#[test]
fn mcp_pending_commit_serializes_after_service_deletion_and_never_records_a_missing_source() {
    let (store, row, pending) = fixture();
    let vault = MemoryVault::default();
    let guard = MUTATION.lock().unwrap();
    let cloned = store.clone();
    let row_copy = row.clone();
    let (started, beginning) = mpsc::channel();
    let (done, result) = mpsc::channel();
    let task = std::thread::spawn(move || {
        started.send(()).unwrap();
        done.send(cloned.begin_mcp_pending(&row_copy, &pending))
            .unwrap();
    });
    beginning.recv().unwrap();
    assert!(result.recv_timeout(Duration::from_millis(50)).is_err());
    remove(&store, &vault, "selected").unwrap();
    drop(guard);
    assert!(
        result
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .is_err()
    );
    task.join().unwrap();
    assert!(store.mcp_pending(&row.id).unwrap().is_none());
    assert_eq!(vault.deletes.load(Ordering::SeqCst), 1);
}

#[test]
fn mcp_pending_commit_serializes_after_service_edit_and_preserves_original_selection() {
    let (store, row, pending) = fixture();
    let vault = MemoryVault::default();
    let guard = MUTATION.lock().unwrap();
    let cloned = store.clone();
    let row_copy = row.clone();
    let (done, result) = mpsc::channel();
    let task = std::thread::spawn(move || {
        done.send(cloned.begin_mcp_pending(&row_copy, &pending))
            .unwrap()
    });
    assert!(result.recv_timeout(Duration::from_millis(50)).is_err());
    save(
        &store,
        &vault,
        SaveInput {
            id: Some("selected".into()),
            label: "Selected".into(),
            provider: "fixture".into(),
            endpoint: "https://changed.test/api".into(),
            api_type: "chat-completions".into(),
            key: "fixture-new-secret".into(),
            models: vec!["model".into()],
        },
    )
    .unwrap();
    drop(guard);
    assert!(
        result
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .is_err()
    );
    task.join().unwrap();
    assert!(store.mcp_pending(&row.id).unwrap().is_none());
    assert_eq!(store.get_session(&row.id).unwrap(), Some(row));
}

#[test]
fn mcp_pending_selected_service_cannot_change_after_commit_but_unrelated_service_can() {
    let (store, row, pending) = fixture();
    let vault = Arc::new(MemoryVault::default());
    store.begin_mcp_pending(&row, &pending).unwrap();
    assert!(store.require_mcp_agent_ready("owner").is_err());
    assert!(store.require_mcp_agent_ready("other").is_ok());
    let cloned = store.clone();
    let capture = vault.clone();
    std::thread::spawn(move || {
        let _guard = MUTATION.lock().unwrap();
        assert!(remove(&cloned, &*capture, "selected").is_err());
        assert!(
            save(
                &cloned,
                &*capture,
                SaveInput {
                    id: Some("selected".into()),
                    label: "Changed".into(),
                    provider: "fixture".into(),
                    endpoint: "https://example.test/api".into(),
                    api_type: "chat-completions".into(),
                    key: "different-fixture-secret".into(),
                    models: vec!["model".into()]
                }
            )
            .is_err()
        );
        remove(&cloned, &*capture, "unrelated").unwrap();
    })
    .join()
    .unwrap();
    assert_eq!(vault.writes.load(Ordering::SeqCst), 0);
    assert_eq!(vault.deletes.load(Ordering::SeqCst), 1);
    assert_eq!(store.mcp_pending(&row.id).unwrap(), Some(pending));
    assert!(
        read(&store)
            .unwrap()
            .iter()
            .any(|c| c.id == "selected" && !c.deleting)
    );
}
