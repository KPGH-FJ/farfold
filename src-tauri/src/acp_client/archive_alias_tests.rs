//! Existing directory aliases must not hide canonical work from archive admission.
//! Only temporary metadata, temporary symlinks and the parent controlled peer are used.
use super::{PEER, Stop, next};
use crate::acp_client::{
    manager::AcpManager,
    pump::SessionSink,
    session_index::{session_row_id, touch_session_row},
};
use crate::meta_store::{AgentRow, MetaStore, SessionRow};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, atomic::Ordering, mpsc},
};

struct Fixture {
    manager: Arc<AcpManager>,
    store: MetaStore,
    agent: AgentRow,
    root: PathBuf,
    _stop: Stop,
    _dir: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("peer.py"), PEER).unwrap();
        let store = MetaStore::open(&root.join("meta.db")).unwrap();
        let manager = Arc::new(AcpManager::new(root.join("logs"), root.clone()));
        let agent = AgentRow {
            id: "archive-alias-fixture".into(),
            name: "Fixture".into(),
            source: "custom".into(),
            command: crate::platform_tests::python(),
            args: vec!["-u".into(), root.join("peer.py").to_string_lossy().into()],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        };
        store.insert_agent(&agent).unwrap();
        Self {
            _stop: Stop(manager.clone()),
            manager,
            store,
            agent,
            root,
            _dir: dir,
        }
    }

    fn location(&self, name: &str) -> (PathBuf, PathBuf) {
        let canonical = self.root.join(format!("real-{name}"));
        std::fs::create_dir(&canonical).unwrap();
        #[cfg(unix)]
        let raw = self.root.join(format!("alias-{name}"));
        #[cfg(unix)]
        std::os::unix::fs::symlink(&canonical, &raw).unwrap();
        #[cfg(windows)]
        let raw = {
            // Keep dot components in an ordinary Win32 path. A verbatim path
            // deliberately disables that normalization at the OS boundary.
            let parent = self._dir.path().join(format!("alias-parent-{name}"));
            std::fs::create_dir(&parent).unwrap();
            parent.join("..").join(format!("real-{name}"))
        };
        assert_ne!(raw, canonical);
        assert_eq!(raw.canonicalize().unwrap(), canonical);
        (raw, canonical)
    }

    fn row(&self, cwd: &std::path::Path, native: &str) -> SessionRow {
        touch_session_row(
            &self.store,
            &self.agent.id,
            &cwd.to_string_lossy(),
            native,
            Some("Keep original metadata"),
            Some(json!({"model": "original", "thought_level": "off"})),
        )
        .unwrap()
    }
}

fn unsent(key: &str, queued: bool) -> Value {
    if queued {
        json!({
            "version": 1,
            "composers": {}, "feedback": {},
            "queues": {key: {"blocks": [[{"type": "text", "text": "Keep queued input"}]], "uncertainIndex": null}}
        })
    } else {
        json!({
            "version": 1,
            "composers": {format!("session:{key}"): {"text": "Keep unsent input", "attachments": []}},
            "feedback": {}, "queues": {}
        })
    }
}

async fn saved_alias_work(queued: bool) {
    let f = Fixture::new();
    let (raw, canonical) = f.location("saved");
    let original = f.row(&raw, "native");
    let key = session_row_id(&f.agent.id, &canonical.to_string_lossy(), "native");
    let saved = unsent(&key, queued);
    f.store.set_setting("unsentWork.v1", &saved).unwrap();
    let result = f
        .manager
        .archive_session(&f.store, original.id.clone(), true)
        .await;
    let actual = f.store.get_session(&original.id).unwrap().unwrap();
    assert_eq!(
        actual, original,
        "canonical unsent input must protect the complete original raw row"
    );
    assert!(result.is_err(), "archive must reject canonical unsent work");
    assert_eq!(f.store.get_setting("unsentWork.v1").unwrap(), Some(saved));
    assert!(f.manager.lock().unwrap().is_empty());
}

#[tokio::test]
async fn existing_alias_protects_canonical_saved_draft_without_starting_a_peer() {
    saved_alias_work(false).await;
}

#[tokio::test]
async fn existing_alias_protects_canonical_saved_queue_without_starting_a_peer() {
    saved_alias_work(true).await;
}

#[tokio::test]
async fn identical_native_in_another_directory_does_not_inherit_saved_alias_work() {
    let f = Fixture::new();
    let (raw, canonical) = f.location("protected");
    let (other_raw, _) = f.location("other");
    let protected = f.row(&raw, "same-native");
    let other = f.row(&other_raw, "same-native");
    let saved = unsent(
        &session_row_id(&f.agent.id, &canonical.to_string_lossy(), "same-native"),
        true,
    );
    f.store.set_setting("unsentWork.v1", &saved).unwrap();
    let actual = f
        .manager
        .archive_session(&f.store, other.id.clone(), true)
        .await
        .unwrap();
    let mut expected = other;
    expected.archived = true;
    expected.updated_at = actual.updated_at;
    assert_eq!(actual, expected);
    assert_eq!(f.store.get_session(&protected.id).unwrap(), Some(protected));
    assert_eq!(f.store.get_setting("unsentWork.v1").unwrap(), Some(saved));
    assert!(f.manager.lock().unwrap().is_empty());
}

async fn live_alias_work(archive_other_directory: bool) {
    let f = Fixture::new();
    let (raw, canonical) = f.location("busy");
    let (tx, rx) = mpsc::channel();
    let sink: SessionSink = Arc::new(move |event| {
        let _ = tx.send(event);
    });
    let busy = f
        .manager
        .open_session(&f.agent, &canonical, None, vec![], sink, &f.store)
        .await
        .unwrap();
    let protected = f.row(&raw, &busy.session_id);
    let mut live_locations = vec![canonical.clone()];
    let target = if archive_other_directory {
        let (other_raw, other_canonical) = f.location("idle");
        let idle = f
            .manager
            .open_session(
                &f.agent,
                &other_canonical,
                None,
                vec![],
                Arc::new(|_| {}),
                &f.store,
            )
            .await
            .unwrap();
        assert_eq!(idle.session_id, busy.session_id);
        live_locations.push(other_canonical);
        f.row(&other_raw, &idle.session_id)
    } else {
        protected.clone()
    };
    let blocks = serde_json::from_value(json!([{"type":"text","text":"hold"}])).unwrap();
    f.manager
        .session_prompt(&f.agent.id, &canonical, &busy.session_id, blocks)
        .await
        .unwrap();
    let result = f
        .manager
        .archive_session(&f.store, target.id.clone(), true)
        .await;
    let after = f.store.get_session(&target.id).unwrap().unwrap();
    let protected_after = f.store.get_session(&protected.id).unwrap().unwrap();

    // Settle and reap the controlled peer before asserting the expected red.
    f.manager
        .session_cancel(&f.agent.id, &canonical, &busy.session_id)
        .await
        .unwrap();
    next(&rx, "turnEnd");
    for cwd in live_locations {
        let connection = f
            .manager
            .lock()
            .unwrap()
            .iter()
            .find(|(key, _)| key.cwd == cwd)
            .unwrap()
            .1
            .clone();
        let pid = connection.child_pid.load(Ordering::SeqCst);
        assert!(f.manager.disconnect(&f.agent.id, &cwd).await.unwrap());
        assert!(
            !f.manager
                .status(&f.agent.id)
                .unwrap()
                .iter()
                .any(|status| status.cwd == cwd.to_string_lossy())
        );
        eprintln!("archive-alias-fixture-reaped-pid={pid}");
    }
    assert!(f.manager.lock().unwrap().is_empty());
    assert_eq!(
        protected_after, protected,
        "busy original row must stay intact"
    );
    if archive_other_directory {
        assert!(result.is_ok(), "another directory must remain independent");
        let mut expected = target;
        expected.archived = true;
        expected.updated_at = after.updated_at;
        assert_eq!(after, expected);
    } else {
        assert_eq!(after, target, "busy alias row must not be rewritten");
        assert!(
            result.is_err(),
            "the canonical busy owner must reject archive"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn existing_alias_reaches_canonical_busy_owner() {
    live_alias_work(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn identical_native_in_another_directory_does_not_inherit_a_busy_owner() {
    live_alias_work(true).await;
}

#[tokio::test]
async fn canonical_feedback_edit_and_first_send_pointer_protect_original_row() {
    let f = Fixture::new();
    let (raw, canonical) = f.location("other-inputs");
    let row = f.row(&raw, "native");
    let key = session_row_id(&f.agent.id, &canonical.to_string_lossy(), "native");
    for saved in [
        json!({"version":1,"composers":{},"queues":{},"feedback":{&key:{"file":{"text":"Keep comment"}}}}),
        json!({"version":1,"composers":{format!("queue-edit:{key}"):{"text":"","attachments":[],"queueEdit":{"index":0,"original":[]}}},"queues":{},"feedback":{}}),
        json!({"version":1,"composers":{"new":{"text":"","attachments":[],"pendingConversation":{"agentId":f.agent.id,"cwd":canonical,"nativeSessionId":"native"}}},"queues":{},"feedback":{}}),
    ] {
        f.store.set_setting("unsentWork.v1", &saved).unwrap();
        let result = f
            .manager
            .archive_session(&f.store, row.id.clone(), true)
            .await;
        assert_eq!(f.store.get_session(&row.id).unwrap(), Some(row.clone()));
        assert!(result.is_err());
        assert_eq!(f.store.get_setting("unsentWork.v1").unwrap(), Some(saved));
    }
}

#[tokio::test]
async fn canonical_open_reservation_blocks_alias_and_failed_admission_releases_raw() {
    let f = Fixture::new();
    let (raw, canonical) = f.location("reservation");
    let row = f.row(&raw, "native");
    let opening = f
        .manager
        .opening_sessions
        .reserve(&f.agent.id, &canonical, "native")
        .unwrap();
    let result = f
        .manager
        .archive_session(&f.store, row.id.clone(), true)
        .await;
    assert_eq!(f.store.get_session(&row.id).unwrap(), Some(row.clone()));
    assert!(result.is_err());
    let raw_released = f
        .manager
        .opening_sessions
        .reserve(&f.agent.id, &raw, "native")
        .unwrap();
    drop(raw_released);
    drop(opening);
    assert!(
        f.manager
            .archive_session(&f.store, row.id, true)
            .await
            .unwrap()
            .archived
    );
}

#[tokio::test]
#[cfg(unix)]
async fn unverified_directory_blocks_archive_but_does_not_block_restore() {
    let f = Fixture::new();
    let missing = f.root.join("missing");
    let dangling = f.root.join("dangling");
    std::os::unix::fs::symlink(&missing, &dangling).unwrap();
    let file = f.root.join("regular-file");
    std::fs::write(&file, "fixture").unwrap();
    for cwd in [missing, dangling, file] {
        let row = f.row(&cwd, "native");
        let result = f
            .manager
            .archive_session(&f.store, row.id.clone(), true)
            .await;
        assert_eq!(f.store.get_session(&row.id).unwrap(), Some(row.clone()));
        assert!(result.is_err());
        let mut previously_archived = row.clone();
        previously_archived.archived = true;
        f.store.upsert_session(&previously_archived).unwrap();
        let restored = f
            .manager
            .archive_session(&f.store, row.id, false)
            .await
            .unwrap();
        previously_archived.archived = false;
        previously_archived.updated_at = restored.updated_at;
        assert_eq!(restored, previously_archived);
    }
    assert!(f.manager.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn different_live_owners_under_raw_and_canonical_paths_are_ambiguous() {
    let f = Fixture::new();
    let (raw, canonical) = f.location("ambiguous");
    let mut native = None;
    for cwd in [&raw, &canonical] {
        let opened = f
            .manager
            .open_session(&f.agent, cwd, None, vec![], Arc::new(|_| {}), &f.store)
            .await
            .unwrap();
        if let Some(ref previous) = native {
            assert_eq!(&opened.session_id, previous);
        }
        native = Some(opened.session_id);
    }
    let row = f.row(&raw, native.as_deref().unwrap());
    let result = f
        .manager
        .archive_session(&f.store, row.id.clone(), true)
        .await;
    let after = f.store.get_session(&row.id).unwrap();
    for cwd in [&raw, &canonical] {
        let pid = f
            .manager
            .session_connection(&f.agent.id, cwd, native.as_deref().unwrap())
            .unwrap()
            .child_pid
            .load(Ordering::SeqCst);
        assert!(f.manager.disconnect(&f.agent.id, cwd).await.unwrap());
        eprintln!("archive-alias-fixture-reaped-pid={pid}");
    }
    assert_eq!(after, Some(row));
    assert!(
        result.is_err(),
        "choosing either of two owners would hide the other owner"
    );
}

#[test]
#[cfg(unix)]
fn archive_commit_rejects_an_alias_retargeted_after_directory_review() {
    let f = Fixture::new();
    let (raw, captured) = f.location("captured");
    let (_, replacement) = f.location("replacement");
    let row = f.row(&raw, "native");
    std::fs::remove_file(&raw).unwrap();
    std::os::unix::fs::symlink(&replacement, &raw).unwrap();
    let result = f
        .store
        .archive_session_row_in_directory(&row, captured.to_str().unwrap());
    assert_eq!(f.store.get_session(&row.id).unwrap(), Some(row));
    assert!(
        result.is_err(),
        "commit must not silently switch to the new directory"
    );
}

#[test]
fn archive_commit_rejects_a_directory_removed_after_review() {
    let f = Fixture::new();
    let (raw, captured) = f.location("removed");
    let row = f.row(&raw, "native");
    std::fs::remove_dir(&captured).unwrap();
    let result = f
        .store
        .archive_session_row_in_directory(&row, captured.to_str().unwrap());
    assert_eq!(f.store.get_session(&row.id).unwrap(), Some(row));
    assert!(result.is_err());
}

#[test]
fn archive_commit_rechecks_original_row_identity_but_preserves_new_metadata() {
    let f = Fixture::new();
    let (raw, canonical) = f.location("identity");
    let row = f.row(&raw, "native");
    let mut changed = row.clone();
    changed.native_session_id = Some("different-native".into());
    f.store.upsert_session(&changed).unwrap();
    assert!(
        f.store
            .archive_session_row_in_directory(&row, canonical.to_str().unwrap())
            .is_err()
    );
    assert_eq!(f.store.get_session(&row.id).unwrap(), Some(changed));
    f.store.upsert_session(&row).unwrap();
    let renamed = f
        .store
        .edit_session_metadata(&row.id, Some("new title"), Some(true))
        .unwrap();
    let actual = f
        .store
        .archive_session_row_in_directory(&row, canonical.to_str().unwrap())
        .unwrap();
    let mut expected = renamed;
    expected.archived = true;
    expected.updated_at = actual.updated_at;
    assert_eq!(actual, expected);
    assert_eq!(
        f.store.list_sessions().unwrap().len(),
        1,
        "no canonical index is added"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn abandoned_archive_keeps_both_reservations_until_the_owned_command_finishes() {
    use crate::acp_client::pump::SessionControl;
    let f = Fixture::new();
    let (raw, canonical) = f.location("abandoned");
    let opened = f
        .manager
        .open_session(
            &f.agent,
            &canonical,
            None,
            vec![],
            Arc::new(|_| {}),
            &f.store,
        )
        .await
        .unwrap();
    let row = f.row(&raw, &opened.session_id);
    let connection = f
        .manager
        .session_connection(&f.agent.id, &canonical, &opened.session_id)
        .unwrap();
    let (capture, mut commands) = tokio::sync::mpsc::unbounded_channel();
    let original = {
        let mut sessions = connection.sessions.lock().unwrap();
        std::mem::replace(
            &mut sessions.get_mut(&opened.session_id).unwrap().control,
            capture,
        )
    };
    let manager = f.manager.clone();
    let store = f.store.clone();
    let id = row.id.clone();
    let caller = tokio::spawn(async move { manager.archive_session(&store, id, true).await });
    let command = tokio::time::timeout(std::time::Duration::from_secs(3), commands.recv())
        .await
        .unwrap()
        .unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    for cwd in [&raw, &canonical] {
        assert!(
            f.manager
                .opening_sessions
                .reserve(&f.agent.id, cwd, &opened.session_id)
                .is_err()
        );
    }
    assert_eq!(f.store.get_session(&row.id).unwrap(), Some(row.clone()));
    let SessionControl::Archive {
        row: captured,
        canonical_cwd,
        reservations,
        admission,
        result,
        ..
    } = command
    else {
        panic!("expected archive command")
    };
    assert!(result.is_closed());
    let outcome = f
        .store
        .run(move |store| {
            let (_reservations, _admission) = (reservations, admission);
            store.archive_session_row_in_directory(&captured, &canonical_cwd)
        })
        .await
        .unwrap();
    assert!(outcome.archived);
    for cwd in [&raw, &canonical] {
        drop(
            f.manager
                .opening_sessions
                .reserve(&f.agent.id, cwd, &opened.session_id)
                .unwrap(),
        );
    }
    connection
        .sessions
        .lock()
        .unwrap()
        .get_mut(&opened.session_id)
        .unwrap()
        .control = original;
    let pid = connection.child_pid.load(Ordering::SeqCst);
    assert!(f.manager.disconnect(&f.agent.id, &canonical).await.unwrap());
    eprintln!("archive-alias-fixture-reaped-pid={pid}");
}

#[tokio::test]
#[cfg(unix)]
async fn reviewed_directory_can_only_veto_archive_and_does_not_route_or_block_restore() {
    let f = Fixture::new();
    let (raw, reviewed) = f.location("frontend-reviewed");
    let (_, changed) = f.location("frontend-changed");
    let row = f.row(&raw, "native");
    std::fs::remove_file(&raw).unwrap();
    std::os::unix::fs::symlink(&changed, &raw).unwrap();
    let result = f
        .manager
        .archive_session_checked(
            &f.store,
            row.id.clone(),
            true,
            Some(reviewed.to_str().unwrap().into()),
        )
        .await;
    assert_eq!(f.store.get_session(&row.id).unwrap(), Some(row.clone()));
    assert!(
        result.is_err(),
        "a verified frontend target is a veto, not an alternate route"
    );
    let archived = f
        .manager
        .archive_session_checked(
            &f.store,
            row.id.clone(),
            true,
            Some(changed.to_str().unwrap().into()),
        )
        .await
        .unwrap();
    assert!(archived.archived);
    std::fs::remove_dir(&changed).unwrap();
    let restored = f
        .manager
        .archive_session_checked(
            &f.store,
            row.id.clone(),
            false,
            Some(reviewed.to_str().unwrap().into()),
        )
        .await
        .unwrap();
    let mut expected = row;
    expected.updated_at = restored.updated_at;
    assert_eq!(restored, expected);
    assert!(f.manager.lock().unwrap().is_empty());
}
