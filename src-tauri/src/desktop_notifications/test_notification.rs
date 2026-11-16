//! An explicit settings action, using the same permission/ticket/native pipeline.
//! It never creates a conversation or changes reminder preferences.
use super::*;

pub(super) fn target() -> String {
    Sha256::digest(b"farfold-notification-settings-v1")
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn main_only(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("NOTIFICATION_TEST_MAIN_ONLY".into())
    }
}

#[tauri::command]
pub async fn desktop_notification_test(
    app: AppHandle,
    webview: tauri::Webview,
    renderer_nonce: String,
    sequence: u64,
) -> Result<Submission, String> {
    main_only(webview.label())?;
    let state = app.state::<DesktopNotifications>();
    let revision = state.revision.load(Ordering::SeqCst);
    // Missing/invalid preference data cannot silently become a different sound choice.
    let preference = read_preference(app.state::<MetaStore>().inner())
        .map_err(|_| "NOTIFICATION_TEST_PREFERENCE_UNAVAILABLE")?;
    let attempt = state.diagnostic.begin(&renderer_nonce, sequence);
    let ticket = state
        .tickets
        .claim(&renderer_nonce, sequence)
        .map_err(|_| "NOTIFICATION_TEST_NOT_SUBMITTED")?;
    if !may_submit(&app, &ticket, NoticeKind::Test, revision, &attempt) {
        return Ok(Submission::Suppressed);
    }
    // Permission requests remain exclusively in the existing explicit enable flow.
    let system = native::settings(&app, false)
        .await
        .map_err(|_| "NOTIFICATION_TEST_SYSTEM_UNAVAILABLE")?;
    state.diagnostic.update(&attempt, |d| d.system(system));
    if !system.allowed() {
        diagnostic_stop(&app, &attempt, Stage::Backend, Reason::SystemNotAllowed);
        return Err("NOTIFICATION_TEST_PERMISSION_REQUIRED".into());
    }
    if !may_submit(&app, &ticket, NoticeKind::Test, revision, &attempt) {
        return Ok(Submission::Suppressed);
    }
    let sound = preference.sound && system.system_sound != Some(false);
    state
        .diagnostic
        .update(&attempt, |d| d.sound_requested = Some(sound));
    let submitted = native::submit(
        &app,
        target(),
        NoticeKind::Test,
        sound,
        revision,
        attempt,
        ticket,
    )
    .await
    .map_err(|_| "NOTIFICATION_TEST_UNCONFIRMED")?;
    Ok(if submitted {
        Submission::Submitted
    } else {
        Submission::Suppressed
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_kind_is_not_accepted_by_the_normal_submission_payload() {
        assert!(serde_json::from_value::<NoticeKind>(json!("test")).is_err());
        for value in ["approval", "question", "interrupted", "success"] {
            assert!(serde_json::from_value::<NoticeKind>(json!(value)).is_ok());
        }
        assert!(main_only("main").is_ok());
        for label in ["", "page", "main-other", "browser-main"] {
            assert!(main_only(label).is_err());
        }
    }

    #[test]
    fn settings_target_does_not_require_or_create_a_conversation() {
        let dir = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
        assert_eq!(
            serde_json::to_value(resolve_activation(&store, &target())).unwrap(),
            json!({"kind":"settings","section":"notifications"})
        );
        assert!(resolve_target(&store, &target()).is_none());
        assert!(target_current(&store, &target(), NoticeKind::Test));
        assert!(!target_current(&store, &target(), NoticeKind::Approval));
        assert!(!target_current(
            &store,
            &target_digest("row"),
            NoticeKind::Test
        ));
        assert!(store.list_sessions().unwrap().is_empty());
        assert!(store.get_setting(SETTINGS_KEY).unwrap().is_none());
    }

    #[test]
    fn only_explicit_test_can_present_in_foreground_and_never_on_unknown_window_state() {
        assert!(presentation_gate(NoticeKind::Test, Some(true), Some(true)).is_ok());
        for kind in [
            NoticeKind::Approval,
            NoticeKind::Question,
            NoticeKind::Interrupted,
            NoticeKind::Success,
        ] {
            assert_eq!(
                presentation_gate(kind, Some(true), Some(true)),
                Err(Reason::WindowFocused)
            );
        }
        for (visible, focused) in [(None, Some(true)), (Some(true), None), (None, None)] {
            assert!(presentation_gate(NoticeKind::Test, visible, focused).is_err());
        }
    }

    #[test]
    fn explicit_test_preserves_disabled_preferences_and_still_checks_revision_and_corrupt_storage()
    {
        let dir = tempfile::tempdir().unwrap();
        let store = MetaStore::open(&dir.path().join("meta.db")).unwrap();
        save_preference(&store, false, false, true).unwrap();
        let before = store.get_setting(SETTINGS_KEY).unwrap();
        assert!(preference_gate(&store, NoticeKind::Test, 2, 2).is_ok());
        assert_eq!(
            preference_gate(&store, NoticeKind::Test, 2, 3),
            Err(Reason::PreferenceChanged)
        );
        assert_eq!(
            preference_gate(&store, NoticeKind::Approval, 2, 2),
            Err(Reason::PreferenceOff)
        );
        assert_eq!(store.get_setting(SETTINGS_KEY).unwrap(), before);
        store
            .set_setting(SETTINGS_KEY, &json!({"version":99}))
            .unwrap();
        assert_eq!(
            preference_gate(&store, NoticeKind::Test, 2, 2),
            Err(Reason::PreferenceUnreadable)
        );
    }
}
