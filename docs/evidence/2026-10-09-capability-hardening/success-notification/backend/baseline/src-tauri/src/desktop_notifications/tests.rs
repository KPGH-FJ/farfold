use super::*;
use serde_json::json;

#[test]
fn defaults_off_and_invalid_records_are_never_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
    assert!(!read_preference(&store).unwrap().enabled);
    assert!(store.get_setting(SETTINGS_KEY).unwrap().is_none());
    for invalid in [
        json!(true),
        json!({"version":2,"enabled":true}),
        json!({"version":1,"enabled":"yes"}),
    ] {
        store.set_setting(SETTINGS_KEY, &invalid).unwrap();
        assert!(read_preference(&store).is_err());
        assert!(save_preference(&store, false, false).is_err());
        assert_eq!(store.get_setting(SETTINGS_KEY).unwrap(), Some(invalid));
    }
}

#[test]
fn saved_choice_survives_restart_and_failed_write_preserves_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("meta.db");
    let store = MetaStore::open(&path).unwrap();
    save_preference(&store, true, false).unwrap();
    drop(store);
    let store = MetaStore::open(&path).unwrap();
    assert!(read_preference(&store).unwrap().enabled);
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TRIGGER reject_notification_save BEFORE UPDATE ON settings BEGIN SELECT RAISE(FAIL, 'controlled failure'); END;").unwrap();
    assert!(save_preference(&store, false, false).is_err());
    assert!(read_preference(&store).unwrap().enabled);
}

#[test]
fn unknown_system_result_cannot_overwrite_an_existing_choice_but_disable_still_works() {
    let dir = tempfile::tempdir().unwrap();
    let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
    save_preference(&store, true, false).unwrap();
    assert!(save_confirmed_preference(&store, true, true, SystemSettings::unknown()).is_err());
    let saved = read_preference(&store).unwrap();
    assert!(saved.enabled);
    assert!(!saved.sound);
    assert!(
        !save_confirmed_preference(&store, false, false, SystemSettings::unknown())
            .unwrap()
            .enabled
    );
}

#[test]
fn duplicate_submissions_are_bounded_and_payloads_only_accept_known_kinds() {
    let mut seen = VecDeque::new();
    assert!(!claim(&mut seen, "0123456789abcdef0123456789abcdef", 0));
    assert!(claim(&mut seen, "0123456789abcdef0123456789abcdef", 1));
    assert!(!claim(&mut seen, "0123456789abcdef0123456789abcdef", 1));
    for sequence in 2..300 {
        assert!(claim(
            &mut seen,
            "0123456789abcdef0123456789abcdef",
            sequence
        ));
    }
    assert_eq!(seen.len(), 256);
    assert!(serde_json::from_value::<NoticeKind>(json!("raw message")).is_err());
    assert_eq!(
        NoticeKind::Question.body(),
        "有一个问题需要你回答。请回到 Farfold 查看。"
    );
}

#[test]
fn existing_preferences_migrate_sound_silently_without_changing_the_choice() {
    let dir = tempfile::tempdir().unwrap();
    let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
    let old = json!({"version":1,"enabled":true});
    store.set_setting(SETTINGS_KEY, &old).unwrap();
    let preference = read_preference(&store).unwrap();
    assert!(preference.enabled);
    assert!(!preference.sound);
    assert_eq!(store.get_setting(SETTINGS_KEY).unwrap(), Some(old));
}

#[test]
fn unknown_or_denied_permission_never_authorizes_a_submission() {
    for value in [-1, 0, 1, 2, 3, 4, 99] {
        assert_eq!(
            SystemSettings::from_native(value, true, true).allowed(),
            matches!(value, 3 | 4)
        );
    }
}

#[test]
fn opaque_target_only_resolves_an_existing_row_and_does_not_recreate_deleted_history() {
    let dir = tempfile::tempdir().unwrap();
    let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
    let row = crate::meta_store::SessionRow {
        id: "agent:/private/location:native-secret".into(),
        agent_id: "agent".into(),
        cwd: "/private/location".into(),
        native_session_id: Some("native-secret".into()),
        title: Some("private title".into()),
        config_options: None,
        pinned: false,
        archived: false,
        created_at: 1,
        updated_at: 1,
    };
    let digest = target_digest(&row.id);
    assert!(valid_digest(&digest));
    assert!(!digest.contains("private"));
    assert!(resolve_target(&store, &digest).is_none());
    store.upsert_session(&row).unwrap();
    assert_eq!(resolve_target(&store, &digest), Some(row.id.clone()));
    for invalid in [row.id.clone(), format!("{digest}x"), "0".repeat(64)] {
        assert!(resolve_target(&store, &invalid).is_none());
    }
    store.remove_session(&row.id).unwrap();
    assert!(resolve_target(&store, &digest).is_none());
    assert!(store.list_sessions().unwrap().is_empty());
}

#[test]
fn renderer_restart_does_not_suppress_new_notices_with_reused_local_sequences() {
    let mut seen = VecDeque::new();
    let first = "0123456789abcdef0123456789abcdef";
    let restarted = "abcdef0123456789abcdef0123456789";
    assert!(claim(&mut seen, first, 1));
    assert!(claim(&mut seen, restarted, 1));
    assert!(!claim(&mut seen, first, 1));
    assert!(!claim(&mut seen, "invalid", 2));
}
