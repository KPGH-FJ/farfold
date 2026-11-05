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

/// Explicit, temporary-file transport for the separately invoked frontend
/// storage bridge. Normal Rust checks skip it; frontend CI never builds it.
#[cfg(target_os = "macos")]
#[test]
#[ignore = "requires the explicit owned temporary frontend storage-bridge fixture"]
fn explicit_frontend_storage_bridge() {
    use std::fs::{self, File, OpenOptions};
    use std::io::{Read, Write};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

    fn owned_file(path: &Path) -> File {
        let before = fs::symlink_metadata(path).unwrap();
        assert!(before.is_file() && !before.file_type().is_symlink());
        assert_eq!(before.uid(), unsafe { libc::geteuid() });
        assert_eq!(before.nlink(), 1);
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .unwrap();
        let held = file.metadata().unwrap();
        assert_eq!((before.dev(), before.ino()), (held.dev(), held.ino()));
        file
    }
    fn small_json(path: &Path) -> serde_json::Value {
        let file = owned_file(path);
        assert_eq!(file.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        let mut bytes = Vec::new();
        file.take(65_537).read_to_end(&mut bytes).unwrap();
        assert!(bytes.len() <= 65_536);
        serde_json::from_slice(&bytes).unwrap()
    }
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Request {
        token: String,
        id: String,
        command: String,
        key: String,
        read_only: bool,
        #[serde(default)]
        limit_pages_to_current: bool,
        #[serde(default)]
        value: serde_json::Value,
    }

    let directory = std::env::current_dir().unwrap();
    assert_eq!(directory, directory.canonicalize().unwrap());
    let temporary_parent = std::env::temp_dir().canonicalize().unwrap();
    assert_eq!(directory.parent(), Some(temporary_parent.as_path()));
    assert!(
        directory
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("farfold-p01-storage-bridge-")
    );
    let metadata = fs::symlink_metadata(&directory).unwrap();
    assert!(metadata.is_dir() && !metadata.file_type().is_symlink());
    assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
    assert_eq!(metadata.permissions().mode() & 0o777, 0o700);
    for entry in fs::read_dir(&directory).unwrap() {
        let entry = entry.unwrap();
        assert!(matches!(
            entry.file_name().to_str().unwrap(),
            "fixture.marker.json"
                | "request.json"
                | "fixture.sqlite3"
                | "fixture.sqlite3-wal"
                | "fixture.sqlite3-shm"
                | "fixture.sqlite3-journal"
        ));
        drop(owned_file(&entry.path()));
    }
    let marker = small_json(&directory.join("fixture.marker.json"));
    assert_eq!(marker["kind"], "farfold-p01-storage-bridge-v1");
    let request: Request =
        serde_json::from_value(small_json(&directory.join("request.json"))).unwrap();
    assert_eq!(marker["token"].as_str(), Some(request.token.as_str()));
    for token in [&request.token, &request.id] {
        assert_eq!(token.len(), 48);
        assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }
    assert_eq!(request.key, "unsentWork.v1");
    assert!(matches!(
        request.command.as_str(),
        "settings_get" | "settings_set"
    ));
    assert!(!request.read_only || request.command == "settings_set");
    assert!(
        !request.limit_pages_to_current
            || (request.command == "settings_set" && !request.read_only)
    );
    let store = MetaStore::open(&directory.join("fixture.sqlite3")).unwrap();
    if request.read_only {
        store
            .lock()
            .unwrap()
            .pragma_update(None, "query_only", true)
            .unwrap();
    }
    let sqlite_limit = if request.limit_pages_to_current {
        let connection = store.lock().unwrap();
        let pages: i64 = connection
            .pragma_query_value(None, "page_count", |row| row.get(0))
            .unwrap();
        let page_size: i64 = connection
            .pragma_query_value(None, "page_size", |row| row.get(0))
            .unwrap();
        let free_pages: i64 = connection
            .pragma_query_value(None, "freelist_count", |row| row.get(0))
            .unwrap();
        assert!((1..=256).contains(&pages));
        assert!((512..=4096).contains(&page_size));
        assert_eq!(free_pages, 0);
        assert!(request.value.to_string().len() >= 48 * 1024);
        connection
            .pragma_update(None, "max_page_count", pages)
            .unwrap();
        let maximum: i64 = connection
            .pragma_query_value(None, "max_page_count", |row| row.get(0))
            .unwrap();
        assert_eq!(maximum, pages);
        Some(json!({
            "pageCount":pages,"pageSize":page_size,
            "freePages":free_pages,"maxPageCount":maximum
        }))
    } else {
        None
    };
    let result = if request.command == "settings_get" {
        store
            .get_setting("unsentWork.v1")
            .map(|value| value.unwrap_or(serde_json::Value::Null))
    } else {
        assert!(request.value.is_object());
        store
            .set_setting("unsentWork.v1", &request.value)
            .map(|()| serde_json::Value::Null)
    };
    if request.limit_pages_to_current {
        assert!(matches!(
            &result,
            Err(error) if error.starts_with("FARFOLD_STORAGE:full:")
        ));
    }
    drop(store);
    let mut response = match result {
        Ok(value) => json!({"id":request.id,"ok":true,"value":value}),
        Err(error) => json!({"id":request.id,"ok":false,"error":error}),
    };
    if let Some(limit) = sqlite_limit {
        response["testSqliteLimit"] = limit;
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(directory.join("response.json"))
        .unwrap();
    file.write_all(serde_json::to_string(&response).unwrap().as_bytes())
        .unwrap();
    file.sync_all().unwrap();
}
