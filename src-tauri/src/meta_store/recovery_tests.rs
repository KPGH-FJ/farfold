use super::*;
use serde_json::json;

fn saved_agent() -> AgentRow {
    AgentRow {
        id: "recovery-fixture".into(),
        name: "Recovery fixture".into(),
        source: "custom".into(),
        command: "/fixture/program".into(),
        args: vec!["--selected-mode".into()],
        env: vec![("FIXTURE_SOURCE".into(), "selected".into())],
        version: None,
        handshake: Some(json!({"agentCapabilities": {"loadSession": true}})),
        created_at: 1,
        updated_at: 1,
    }
}

#[test]
fn invalid_launch_settings_never_become_default_arguments_or_environment() {
    let directory = tempfile::tempdir().unwrap();
    let store = MetaStore::open(&directory.path().join("meta.sqlite3")).unwrap();
    let original = saved_agent();
    store.insert_agent(&original).unwrap();
    for (column, invalid) in [
        ("args", "[broken"),
        ("args", r#"["--selected-mode", 3]"#),
        ("env", "[broken"),
        ("env", r#"{"FIXTURE_SOURCE":42}"#),
        ("handshake", "{broken"),
    ] {
        store
            .lock()
            .unwrap()
            .execute(
                &format!("UPDATE agents SET {column} = ?1 WHERE id = ?2"),
                params![invalid, original.id],
            )
            .unwrap();
        assert!(
            store.get_agent(&original.id).is_err(),
            "{column}: {invalid}"
        );
        let retained: String = store
            .lock()
            .unwrap()
            .query_row(
                &format!("SELECT {column} FROM agents WHERE id = ?1"),
                params![original.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retained, invalid);
        store
            .lock()
            .unwrap()
            .execute(
                "UPDATE agents SET args = ?1, env = ?2, handshake = ?3 WHERE id = ?4",
                params![
                    serde_json::to_string(&original.args).unwrap(),
                    encoded_agent_env(&original.env),
                    original.handshake.as_ref().unwrap().to_string(),
                    original.id
                ],
            )
            .unwrap();
        assert_eq!(
            store.get_agent(&original.id).unwrap(),
            Some(original.clone())
        );
    }
}

#[test]
fn invalid_saved_session_choices_never_become_missing_configuration() {
    let directory = tempfile::tempdir().unwrap();
    let store = MetaStore::open(&directory.path().join("meta.sqlite3")).unwrap();
    let original = SessionRow {
        id: "saved-session".into(),
        agent_id: "recovery-fixture".into(),
        cwd: "/work".into(),
        native_session_id: Some("original-native-session".into()),
        title: Some("Keep history".into()),
        config_options: Some(json!({"model": "selected-model"})),
        pinned: false,
        archived: false,
        created_at: 1,
        updated_at: 1,
    };
    store.upsert_session(&original).unwrap();
    store
        .lock()
        .unwrap()
        .execute(
            "UPDATE sessions SET config_options = ?1 WHERE id = ?2",
            params!["{broken", original.id],
        )
        .unwrap();
    assert!(store.get_session(&original.id).is_err());
    let retained: String = store
        .lock()
        .unwrap()
        .query_row(
            "SELECT config_options FROM sessions WHERE id = ?1",
            params![original.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retained, "{broken");
}

#[test]
fn full_database_keeps_the_previous_unsent_snapshot_readable_after_reopening() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("meta.sqlite3");
    let store = MetaStore::open(&path).unwrap();
    let original = json!({"version":1,"input":"keep before failure"});
    store.set_setting("unsentWork.v1", &original).unwrap();
    {
        let connection = store.lock().unwrap();
        let pages: i64 = connection
            .pragma_query_value(None, "page_count", |row| row.get(0))
            .unwrap();
        connection
            .pragma_update(None, "max_page_count", pages)
            .unwrap();
    }
    let oversized = json!({"version":1,"input":"x".repeat(1024 * 1024)});
    assert!(store.set_setting("unsentWork.v1", &oversized).is_err());
    assert_eq!(
        store.get_setting("unsentWork.v1").unwrap(),
        Some(original.clone())
    );
    drop(store);
    let reopened = MetaStore::open(&path).unwrap();
    assert_eq!(
        reopened.get_setting("unsentWork.v1").unwrap(),
        Some(original)
    );
    let recovered = json!({"version":1,"input":"new explicit edit"});
    reopened.set_setting("unsentWork.v1", &recovered).unwrap();
    assert_eq!(
        reopened.get_setting("unsentWork.v1").unwrap(),
        Some(recovered)
    );
}

#[test]
fn read_only_save_has_a_specific_receipt_and_preserves_the_last_snapshot() {
    let directory = tempfile::tempdir().unwrap();
    let store = MetaStore::open(&directory.path().join("meta.sqlite3")).unwrap();
    let original = json!({"version":1,"input":"keep original"});
    store.set_setting("unsentWork.v1", &original).unwrap();
    store
        .lock()
        .unwrap()
        .pragma_update(None, "query_only", true)
        .unwrap();
    let failure = store
        .set_setting("unsentWork.v1", &json!({"input":"new"}))
        .unwrap_err();
    assert!(
        failure.starts_with("FARFOLD_STORAGE:readOnly:"),
        "{failure}"
    );
    assert_eq!(store.get_setting("unsentWork.v1").unwrap(), Some(original));
}

#[test]
fn storage_full_is_distinguished_from_unknown_save_failure() {
    let directory = tempfile::tempdir().unwrap();
    let store = MetaStore::open(&directory.path().join("meta.sqlite3")).unwrap();
    let original = json!({"input":"saved"});
    store.set_setting("unsentWork.v1", &original).unwrap();
    let connection = store.lock().unwrap();
    let pages: i64 = connection
        .pragma_query_value(None, "page_count", |row| row.get(0))
        .unwrap();
    connection
        .pragma_update(None, "max_page_count", pages)
        .unwrap();
    drop(connection);
    let failure = store
        .set_setting("unsentWork.v1", &json!("x".repeat(1024 * 1024)))
        .unwrap_err();
    assert!(failure.starts_with("FARFOLD_STORAGE:full:"), "{failure}");
    assert_eq!(store.get_setting("unsentWork.v1").unwrap(), Some(original));
}

#[test]
fn a_database_removed_after_validation_cannot_be_recreated_by_open() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("farfold.sqlite3");
    drop(MetaStore::open(&path).unwrap());
    let existing = storage_recovery::check_existing(&path).unwrap();
    assert!(existing);
    std::fs::rename(&path, directory.path().join("preserved.sqlite3")).unwrap();
    assert!(storage_recovery::open_connection(&path, existing).is_err());
    assert!(!path.exists());
}
