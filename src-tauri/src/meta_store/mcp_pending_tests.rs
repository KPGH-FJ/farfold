use super::*;
use serde_json::json;

fn row(id: &str) -> SessionRow {
    SessionRow {
        id: id.into(),
        agent_id: "agent".into(),
        cwd: "/fixture".into(),
        native_session_id: Some(id.into()),
        title: Some("keep".into()),
        config_options: Some(json!({"keep":true})),
        pinned: true,
        archived: false,
        created_at: 1,
        updated_at: 1,
    }
}
fn pending(id: &str) -> Pending {
    Pending {
        operation_id: id.into(),
        action: Action::Add,
        before_digest: "a".repeat(64),
        expected_digest: None,
        target_digest: "b".repeat(64),
    }
}

#[test]
fn mcp_pending_restart_and_snapshot_preserve_only_one_scoped_digest_record() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("meta.db");
    let store = MetaStore::open(&path).unwrap();
    let original = row("first");
    let sibling = row("sibling");
    store.upsert_session(&original).unwrap();
    store.upsert_session(&sibling).unwrap();
    let change = pending("add-one");
    store.begin_mcp_pending(&original, &change).unwrap();
    assert!(store.require_mcp_ready(&original.id).is_err());
    assert!(store.require_mcp_ready(&sibling.id).is_ok());
    assert_eq!(
        store.get_session(&original.id).unwrap(),
        Some(original.clone())
    );
    let raw = store.get_setting(&key(&original.id)).unwrap().unwrap();
    assert_eq!(raw.as_object().unwrap().len(), 3);
    assert_eq!(raw["change"].as_object().unwrap().len(), 5);
    assert!(raw.get("url").is_none());
    let copy = dir.path().join("copy.db");
    store.export_snapshot(&copy).unwrap();
    drop(store);
    for path in [&path, &copy] {
        let reopened = MetaStore::open(path).unwrap();
        assert_eq!(
            reopened.mcp_pending(&original.id).unwrap(),
            Some(change.clone())
        );
        assert!(reopened.require_mcp_ready(&original.id).is_err());
        assert_eq!(
            reopened.get_session(&sibling.id).unwrap(),
            Some(sibling.clone())
        );
    }
}

#[test]
fn mcp_pending_failure_before_send_and_failed_clear_preserve_current_state() {
    let store = MetaStore::test_memory();
    let owner = row("one");
    store.upsert_session(&owner).unwrap();
    store.lock().unwrap().execute_batch("CREATE TRIGGER refuse_begin BEFORE INSERT ON settings BEGIN SELECT RAISE(FAIL,'fixture'); END;").unwrap();
    assert!(store.begin_mcp_pending(&owner, &pending("first")).is_err());
    assert!(store.mcp_pending(&owner.id).unwrap().is_none());
    store
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER refuse_begin;")
        .unwrap();
    let first = pending("first");
    store.begin_mcp_pending(&owner, &first).unwrap();
    store.lock().unwrap().execute_batch("CREATE TRIGGER refuse_clear BEFORE DELETE ON settings BEGIN SELECT RAISE(FAIL,'fixture'); END;").unwrap();
    assert!(store.clear_mcp_pending(&owner, &first).is_err());
    assert_eq!(store.mcp_pending(&owner.id).unwrap(), Some(first.clone()));
    store
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER refuse_clear;")
        .unwrap();
    store.clear_mcp_pending(&owner, &first).unwrap();
    assert!(store.require_mcp_ready(&owner.id).is_ok());
}

#[test]
fn mcp_pending_compare_and_owner_checks_reject_stale_clear_or_overwrite() {
    let store = MetaStore::test_memory();
    let owner = row("one");
    store.upsert_session(&owner).unwrap();
    let first = pending("first");
    let second = pending("second");
    store.begin_mcp_pending(&owner, &first).unwrap();
    assert!(store.begin_mcp_pending(&owner, &second).is_err());
    assert!(store.clear_mcp_pending(&owner, &second).is_err());
    let mut different = owner.clone();
    different.agent_id = "different".into();
    assert!(store.clear_mcp_pending(&different, &first).is_err());
    store.clear_mcp_pending(&owner, &first).unwrap();
    store.begin_mcp_pending(&owner, &second).unwrap();
    assert!(store.clear_mcp_pending(&owner, &first).is_err());
    assert_eq!(store.mcp_pending(&owner.id).unwrap(), Some(second));
}

#[test]
fn mcp_pending_generic_settings_and_data_removal_cannot_drop_guard() {
    let dir = tempfile::tempdir().unwrap();
    let store = MetaStore::test_memory();
    let owner = row("one");
    store.upsert_session(&owner).unwrap();
    assert!(store.set_setting(&key(&owner.id), &json!(null)).is_err());
    store.begin_mcp_pending(&owner, &pending("first")).unwrap();
    assert!(store.remove_session(&owner.id).is_err());
    assert!(store.remove_and_dismiss_session(&owner.id).is_err());
    assert!(store.clear_all().is_err());
    let marker = dir.path().join("conversations");
    std::fs::create_dir(&marker).unwrap();
    std::fs::write(marker.join("kept"), "keep").unwrap();
    let secrets = std::sync::atomic::AtomicUsize::new(0);
    assert!(
        crate::data_reset::clear_owned(dir.path(), &store, &|_| {
            secrets.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        })
        .is_err()
    );
    assert_eq!(secrets.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert!(marker.join("kept").exists());
    assert!(store.get_session(&owner.id).unwrap().is_some());
}

#[test]
fn mcp_pending_malformed_oversized_and_recreated_owner_never_become_ready() {
    let store = MetaStore::test_memory();
    let owner = row("one");
    store.upsert_session(&owner).unwrap();
    for raw in [
        "null".to_string(),
        "{".into(),
        "x".repeat(MAX_BYTES as usize + 1),
    ] {
        store.lock().unwrap().execute("INSERT INTO settings(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key(&owner.id),raw]).unwrap();
        assert!(store.mcp_pending(&owner.id).is_err());
        assert!(store.require_mcp_ready(&owner.id).is_err());
        assert!(store.require_no_mcp_pending().is_err());
    }
    store
        .lock()
        .unwrap()
        .execute("DELETE FROM settings", [])
        .unwrap();
    store.begin_mcp_pending(&owner, &pending("one")).unwrap();
    // Normal upserts intentionally preserve created_at. Simulate a restored
    // different owner row directly instead of claiming the normal API did so.
    store
        .lock()
        .unwrap()
        .execute(
            "UPDATE sessions SET created_at=created_at+1 WHERE id=?1",
            params![owner.id],
        )
        .unwrap();
    assert!(store.mcp_pending(&owner.id).is_err());
    assert!(store.clear_mcp_pending(&owner, &pending("one")).is_err());
    assert!(store.require_mcp_ready(&owner.id).is_err());
}

#[test]
fn mcp_pending_rejects_configuration_text_and_action_digest_ambiguity() {
    let store = MetaStore::test_memory();
    let owner = row("one");
    store.upsert_session(&owner).unwrap();
    for field in ["operation", "before", "target", "expected", "action"] {
        let mut change = pending("one");
        match field {
            "operation" => change.operation_id = "https://secret.example".into(),
            "before" => change.before_digest = "raw configuration".into(),
            "target" => change.target_digest = "B".repeat(64),
            "expected" => change.expected_digest = Some("c".repeat(64)),
            _ => change.action = Action::Remove,
        }
        assert!(store.begin_mcp_pending(&owner, &change).is_err());
    }
    assert!(store.mcp_pending(&owner.id).unwrap().is_none());
}

#[test]
fn mcp_pending_protects_owner_program_and_two_record_restore_keeps_guard() {
    let store = MetaStore::test_memory();
    let owner = row("one");
    let agent = AgentRow {
        id: owner.agent_id.clone(),
        name: "Owned fixture".into(),
        source: "custom".into(),
        command: "/fixture/program".into(),
        args: vec![],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 1,
        updated_at: 1,
    };
    let other = AgentRow {
        id: "other".into(),
        ..agent.clone()
    };
    store.insert_agent(&agent).unwrap();
    store.insert_agent(&other).unwrap();
    store.upsert_session(&owner).unwrap();
    let change = pending("one");
    store.begin_mcp_pending(&owner, &change).unwrap();
    assert_eq!(store.remove_agent(&agent.id).unwrap_err(), BLOCKED);
    assert_eq!(store.replace_agent_launch(&agent).unwrap_err(), BLOCKED);
    assert_eq!(store.set_agent_env(&agent.id, &[]).unwrap_err(), BLOCKED);
    assert_eq!(
        store
            .commit_agent_candidate(&agent, Some(&agent), &json!({}), &json!([]))
            .unwrap_err(),
        BLOCKED
    );
    store.replace_agent_launch(&other).unwrap();
    store.set_agent_env(&other.id, &[]).unwrap();
    assert!(store.remove_agent(&other.id).unwrap());
    assert_eq!(store.get_agent(&agent.id).unwrap(), Some(agent));
    let baseline = store.restore_values().unwrap();
    let selected = crate::storage_recovery::restore::KEYS
        .into_iter()
        .map(|key| (key.to_string(), "{}".to_string()))
        .collect();
    store.restore_startup_values(&baseline, &selected).unwrap();
    assert_eq!(store.mcp_pending(&owner.id).unwrap(), Some(change));
}
