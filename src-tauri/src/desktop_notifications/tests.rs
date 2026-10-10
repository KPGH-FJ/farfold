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
        assert!(save_preference(&store, false, false, false).is_err());
        assert_eq!(store.get_setting(SETTINGS_KEY).unwrap(), Some(invalid));
    }
}

#[test]
fn saved_choice_survives_restart_and_failed_write_preserves_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("meta.db");
    let store = MetaStore::open(&path).unwrap();
    save_preference(&store, true, false, false).unwrap();
    drop(store);
    let store = MetaStore::open(&path).unwrap();
    assert!(read_preference(&store).unwrap().enabled);
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TRIGGER reject_notification_save BEFORE UPDATE ON settings BEGIN SELECT RAISE(FAIL, 'controlled failure'); END;").unwrap();
    assert!(save_preference(&store, false, false, false).is_err());
    assert!(read_preference(&store).unwrap().enabled);
}

#[test]
fn unknown_system_result_cannot_overwrite_an_existing_choice_but_disable_still_works() {
    let dir = tempfile::tempdir().unwrap();
    let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
    save_preference(&store, true, false, false).unwrap();
    assert!(
        save_confirmed_preference(&store, true, false, true, SystemSettings::unknown()).is_err()
    );
    let saved = read_preference(&store).unwrap();
    assert!(saved.enabled);
    assert!(!saved.sound);
    assert!(
        !save_confirmed_preference(&store, false, false, false, SystemSettings::unknown())
            .unwrap()
            .enabled
    );
}

#[test]
fn duplicate_submissions_are_bounded_and_payloads_only_accept_known_kinds() {
    let tickets = Tickets::default();
    let renderer = "0123456789abcdef0123456789abcdef";
    assert!(tickets.claim(renderer, 0).is_err());
    drop(tickets.claim(renderer, 1).unwrap());
    assert!(tickets.claim(renderer, 1).is_err());
    for sequence in 2..300 {
        drop(tickets.claim(renderer, sequence).unwrap());
    }
    // Even evicted terminal decisions cannot authorize a duplicate request.
    assert!(tickets.claim(renderer, 1).is_err());
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
    let tickets = Tickets::default();
    let first = "0123456789abcdef0123456789abcdef";
    let restarted = "abcdef0123456789abcdef0123456789";
    drop(tickets.claim(first, 1).unwrap());
    drop(tickets.claim(restarted, 1).unwrap());
    assert!(tickets.claim(first, 1).is_err());
    assert!(tickets.claim("invalid", 2).is_err());
}

#[test]
fn legacy_settings_leave_success_off_without_rewriting_saved_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
    for old in [
        json!({"version":1,"enabled":true}),
        json!({"version":1,"enabled":true,"sound":true}),
        json!({"version":1,"enabled":false,"sound":false}),
    ] {
        store.set_setting(SETTINGS_KEY, &old).unwrap();
        let preference = read_preference(&store).unwrap();
        assert!(!preference.success_enabled);
        assert_eq!(store.get_setting(SETTINGS_KEY).unwrap(), Some(old));
    }
    for invalid in [
        json!({"version":1,"enabled":true,"successEnabled":null}),
        json!({"version":1,"enabled":true,"successEnabled":"yes"}),
        json!({"version":1,"enabled":true,"successEnabled":true,"extra":"private"}),
    ] {
        store.set_setting(SETTINGS_KEY, &invalid).unwrap();
        assert!(read_preference(&store).is_err());
        assert!(save_preference(&store, false, true, false).is_err());
        assert_eq!(store.get_setting(SETTINGS_KEY).unwrap(), Some(invalid));
    }
}

#[test]
fn success_only_choice_survives_restart_and_failed_save_keeps_all_choices() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("meta.db");
    let store = MetaStore::open(&path).unwrap();
    save_preference(&store, false, true, true).unwrap();
    drop(store);
    let store = MetaStore::open(&path).unwrap();
    let expected = json!({"version":1,"enabled":false,"successEnabled":true,"sound":true});
    assert_eq!(
        store.get_setting(SETTINGS_KEY).unwrap(),
        Some(expected.clone())
    );
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TRIGGER reject_notification_save BEFORE UPDATE ON settings BEGIN SELECT RAISE(FAIL, 'controlled failure'); END;").unwrap();
    assert!(save_preference(&store, true, false, false).is_err());
    assert_eq!(store.get_setting(SETTINGS_KEY).unwrap(), Some(expected));
}

#[test]
fn shared_submission_preference_gate_checks_kind_and_current_revision() {
    let dir = tempfile::tempdir().unwrap();
    let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
    for attention in [false, true] {
        for success in [false, true] {
            save_preference(&store, attention, success, false).unwrap();
            for kind in [
                NoticeKind::Approval,
                NoticeKind::Question,
                NoticeKind::Interrupted,
            ] {
                assert_eq!(preference_gate(&store, kind, 9, 9).is_ok(), attention);
                assert_eq!(
                    preference_gate(&store, kind, 9, 10),
                    Err(Reason::PreferenceChanged)
                );
            }
            assert_eq!(
                preference_gate(&store, NoticeKind::Success, 9, 9).is_ok(),
                success
            );
            assert_eq!(
                preference_gate(&store, NoticeKind::Success, 9, 10),
                Err(Reason::PreferenceChanged)
            );
        }
    }
    save_preference(&store, false, true, false).unwrap();
    assert!(preference_gate(&store, NoticeKind::Success, 10, 10).is_ok());
    save_preference(&store, true, false, false).unwrap();
    // Re-reading the real saved preference cannot borrow attention's enabled flag.
    assert_eq!(
        preference_gate(&store, NoticeKind::Success, 10, 10),
        Err(Reason::PreferenceOff)
    );
    store.set_setting(SETTINGS_KEY, &json!(null)).unwrap();
    assert_eq!(
        preference_gate(&store, NoticeKind::Success, 10, 10),
        Err(Reason::PreferenceUnreadable)
    );
}

#[test]
fn unknown_permission_does_not_enable_success_or_erase_the_other_explicit_choice() {
    let dir = tempfile::tempdir().unwrap();
    let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
    save_preference(&store, true, false, true).unwrap();
    assert!(
        save_confirmed_preference(&store, true, true, true, SystemSettings::unknown()).is_err()
    );
    assert!(!read_preference(&store).unwrap().success_enabled);
    save_preference(&store, true, true, true).unwrap();
    let attention_only =
        save_confirmed_preference(&store, true, false, true, SystemSettings::unknown()).unwrap();
    assert!(attention_only.enabled);
    assert!(!attention_only.success_enabled);
    save_preference(&store, true, true, true).unwrap();
    let success_only =
        save_confirmed_preference(&store, false, true, true, SystemSettings::unknown()).unwrap();
    assert!(!success_only.enabled);
    assert!(success_only.success_enabled);
    assert!(
        save_confirmed_preference(&store, false, true, false, SystemSettings::unknown()).is_err()
    );
    let all_off =
        save_confirmed_preference(&store, false, false, true, SystemSettings::unknown()).unwrap();
    assert!(!all_off.enabled && !all_off.success_enabled);
}

#[test]
fn either_explicit_rising_preference_requests_permission_but_reads_and_disabling_do_not() {
    let dir = tempfile::tempdir().unwrap();
    let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
    let off = read_preference(&store).unwrap();
    assert!(!off.enabled && !off.success_enabled);
    assert!(!requests_permission(&off, false, false));
    assert!(requests_permission(&off, true, false));
    assert!(requests_permission(&off, false, true));
    save_preference(&store, true, true, false).unwrap();
    let both = read_preference(&store).unwrap();
    for enabled in [true, false] {
        for success in [true, false] {
            assert!(!requests_permission(&both, enabled, success));
        }
    }
    for permission in [2, 3, 4] {
        save_preference(&store, false, false, false).unwrap();
        let state = save_confirmed_preference(
            &store,
            false,
            true,
            false,
            SystemSettings::from_native(permission, true, true),
        )
        .unwrap();
        assert!(!state.enabled);
        assert_eq!(state.success_enabled, matches!(permission, 3 | 4));
    }
}

#[test]
fn success_wire_and_content_free_body_do_not_change_legacy_notice_kinds() {
    let kind: NoticeKind = serde_json::from_value(json!("success")).unwrap();
    assert_eq!(kind.body(), "有一项工作已完成。请回到 Farfold 查看。");
    for invalid in ["completed", "done", "private title"] {
        assert!(serde_json::from_value::<NoticeKind>(json!(invalid)).is_err());
    }
    let dir = tempfile::tempdir().unwrap();
    let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
    let state = snapshot(
        save_preference(&store, false, true, false).unwrap(),
        SystemSettings::unknown(),
    );
    let wire = serde_json::to_value(state).unwrap();
    assert_eq!(wire["enabled"], false);
    assert_eq!(wire["successEnabled"], true);
    assert_eq!(wire["sound"], false);
    assert_eq!(
        NoticeKind::Approval.body(),
        "有一项批准请求需要你处理。请回到 Farfold 查看。"
    );
    assert_eq!(
        NoticeKind::Interrupted.body(),
        "有一项工作需要你检查。请回到 Farfold 查看。"
    );
}

#[test]
fn denied_permission_does_not_erase_an_untouched_kind_when_disabling_the_other() {
    let dir = tempfile::tempdir().unwrap();
    let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
    let denied = SystemSettings::from_native(2, false, false);
    save_preference(&store, true, true, false).unwrap();
    let success_only = save_confirmed_preference(&store, false, true, false, denied).unwrap();
    assert!(!success_only.enabled);
    assert!(success_only.success_enabled);
    save_preference(&store, true, true, false).unwrap();
    let attention_only = save_confirmed_preference(&store, true, false, false, denied).unwrap();
    assert!(attention_only.enabled);
    assert!(!attention_only.success_enabled);
    // Saving a preference never overrides the separate system submission gate.
    assert!(!denied.allowed());
    save_preference(&store, false, false, false).unwrap();
    let refused_enable = save_confirmed_preference(&store, true, true, false, denied).unwrap();
    assert!(!refused_enable.enabled && !refused_enable.success_enabled);
}

#[test]
fn p48_old_record_exposes_explicit_default_off_success_without_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
    let old = json!({"version":1,"enabled":true,"sound":false});
    store.set_setting(SETTINGS_KEY, &old).unwrap();
    let preference = read_preference(&store).unwrap();
    let state = serde_json::to_value(snapshot(preference, SystemSettings::unknown())).unwrap();
    assert_eq!(state["successEnabled"], json!(false));
    assert_eq!(store.get_setting(SETTINGS_KEY).unwrap(), Some(old));
}
#[test]
fn p48_known_success_kind_uses_only_fixed_content_free_body() {
    let kind: NoticeKind = serde_json::from_value(json!("success")).expect("known success kind");
    assert_eq!(kind.body(), "有一项工作已完成。请回到 Farfold 查看。");
}
