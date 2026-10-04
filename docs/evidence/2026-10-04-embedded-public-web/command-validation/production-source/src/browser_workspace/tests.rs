use super::*;

fn ready(state: &BrowserWorkspace, task: &str) -> (u64, BrowserInfo) {
    let (id, _, info) = state
        .reserve(task, Url::parse("https://www.rust-lang.org/").unwrap())
        .unwrap();
    state.event(id, 1, 1, "https://www.rust-lang.org/").unwrap();
    (id, info)
}
fn result() -> &'static str {
    r#"{"blocked":false,"url":"https://www.rust-lang.org/","title":"Public fixture","text":"visible fixture"}"#
}

#[test]
fn another_task_cannot_read_or_close_owned_page() {
    let state = BrowserWorkspace::default();
    let (_, info) = ready(&state, "a");
    assert!(state.read_ticket("b", &info.label).is_err());
    assert!(state.close("b", &info.label).unwrap().is_none());
    assert!(state.read_ticket("a", &info.label).is_ok());
}
#[test]
fn close_revokes_queued_reads_and_repeated_close_is_noop() {
    let state = BrowserWorkspace::default();
    let (_, info) = ready(&state, "a");
    let ticket = state.read_ticket("a", &info.label).unwrap();
    assert!(state.close("a", &info.label).unwrap().is_some());
    assert!(state.complete_read(&ticket, result()).is_err());
    let id = state.identity("a", &info.label).unwrap();
    assert!(state.close("a", &info.label).unwrap().is_some());
    state.acknowledge_close(id);
    assert!(state.close("a", &info.label).unwrap().is_none());
}
#[test]
fn old_close_and_old_response_cannot_affect_same_task_reopened() {
    let state = BrowserWorkspace::default();
    let (_, old) = ready(&state, "a");
    let ticket = state.read_ticket("a", &old.label).unwrap();
    state.acknowledge_close(state.close("a", &old.label).unwrap().unwrap().0);
    let (_, new) = ready(&state, "a");
    assert_ne!(old.label, new.label);
    assert!(state.close("a", &old.label).unwrap().is_none());
    assert!(state.complete_read(&ticket, result()).is_err());
    assert!(state.read_ticket("a", &new.label).is_ok());
}
#[test]
fn navigation_revokes_read_and_does_not_admit_another_origin() {
    let state = BrowserWorkspace::default();
    let (id, info) = ready(&state, "a");
    let ticket = state.read_ticket("a", &info.label).unwrap();
    assert!(!state.policy(id, "https://www.mozilla.org/"));
    assert!(
        state
            .link_navigation(id, "https://www.rust-lang.org/learn")
            .is_some()
    );
    assert!(state.complete_read(&ticket, result()).is_err());
    assert!(state.read_ticket("a", &info.label).is_err());
}
#[test]
fn explicit_navigate_can_authorize_new_public_origin() {
    let state = BrowserWorkspace::default();
    let (id, _) = ready(&state, "a");
    state
        .navigate(id, Url::parse("https://www.mozilla.org/").unwrap())
        .unwrap();
    assert!(state.policy(id, "https://www.mozilla.org/"));
    assert!(!state.policy(id, "https://www.rust-lang.org/"));
}
#[test]
fn blocked_or_failed_page_never_releases_snapshot() {
    for event in [5, 3] {
        let state = BrowserWorkspace::default();
        let (id, info) = ready(&state, "a");
        let ticket = state.read_ticket("a", &info.label).unwrap();
        state.event(id, 1, event, "").unwrap();
        assert!(state.complete_read(&ticket, result()).is_err());
    }
}
#[test]
fn native_password_marker_has_no_content_output() {
    let state = BrowserWorkspace::default();
    let (_, info) = ready(&state, "a");
    let ticket = state.read_ticket("a", &info.label).unwrap();
    assert!(state.complete_read(&ticket, r#"{"blocked":true}"#).is_err());
    let accepted = state.complete_read(&ticket, result()).unwrap();
    assert_eq!(accepted.text, "visible fixture");
}
#[test]
fn late_event_from_replaced_page_does_not_change_new_page() {
    let state = BrowserWorkspace::default();
    let (old, previous) = ready(&state, "a");
    state.close("a", &previous.label).unwrap();
    state.acknowledge_close(old);
    let (new, info) = ready(&state, "b");
    assert!(state.event(old, 1, 3, "").is_none());
    assert_eq!(state.info(new).unwrap().task_key, info.task_key);
    assert_eq!(state.info(new).unwrap().phase, "ready");
}

#[test]
fn close_pending_retains_owner_for_failed_dispatch_retry() {
    let state = BrowserWorkspace::default();
    let (id, info) = ready(&state, "a");
    state.close("a", &info.label).unwrap().unwrap();
    assert!(
        state.info(id).is_ok(),
        "native close has not acknowledged yet"
    );
    assert!(
        state.close("a", &info.label).unwrap().is_some(),
        "retry must retain owner"
    );
}
#[test]
fn replacement_cannot_discard_owner_before_close_ack() {
    let state = BrowserWorkspace::default();
    let (id, _) = ready(&state, "a");
    assert!(
        state
            .reserve("b", Url::parse("https://www.mozilla.org/").unwrap())
            .is_err()
    );
    assert_eq!(state.info(id).unwrap().task_key, "a");
}
#[test]
fn old_navigation_finish_cannot_replace_new_requested_url() {
    let state = BrowserWorkspace::default();
    let (id, _) = ready(&state, "a");
    state
        .navigate(id, Url::parse("https://www.rust-lang.org/learn").unwrap())
        .unwrap();
    state.event(id, 1, 1, "https://www.rust-lang.org/");
    assert_eq!(state.info(id).unwrap().phase, "loading");
    assert_eq!(
        state.info(id).unwrap().url,
        "https://www.rust-lang.org/learn"
    );
}

#[test]
fn failed_close_ack_blocks_replacement_and_is_retryable() {
    let state = BrowserWorkspace::default();
    let (id, info) = ready(&state, "a");
    let ticket = state.read_ticket("a", &info.label).unwrap();
    state.close("a", &info.label).unwrap();
    assert!(!state.can_operate(id, None));
    assert!(state.read_ticket("a", &info.label).is_err());
    assert!(state.complete_read(&ticket, result()).is_err());
    assert_eq!(state.close_failed(id).unwrap().phase, "error");
    assert!(
        state
            .reserve("b", Url::parse("https://www.mozilla.org/").unwrap())
            .is_err()
    );
    assert!(state.close("a", &info.label).unwrap().is_some());
    assert_eq!(state.acknowledge_close(id).unwrap().phase, "closed");
    let (new, _, _) = state
        .reserve("b", Url::parse("https://www.mozilla.org/").unwrap())
        .unwrap();
    assert!(state.acknowledge_close(id).is_none());
    assert!(state.info(new).is_ok());
}
#[test]
fn late_callbacks_and_abandoned_creation_cannot_revive_closing() {
    let state = BrowserWorkspace::default();
    let (id, info) = ready(&state, "a");
    state.close("a", &info.label).unwrap();
    assert!(!state.can_operate(id, Some(1)));
    assert!(!state.policy(id, "https://www.rust-lang.org/"));
    assert!(
        state
            .event(id, 1, 1, "https://www.rust-lang.org/")
            .is_none()
    );
    assert!(state.event(id, 1, 5, "").is_none());
    assert!(
        state
            .link_navigation(id, "https://www.rust-lang.org/")
            .is_none()
    );
}
#[test]
fn same_url_stale_finish_fail_start_and_unknown_start_cannot_steal_new_navigation() {
    let state = BrowserWorkspace::default();
    let (id, _) = ready(&state, "a");
    state
        .navigate(id, Url::parse("https://www.rust-lang.org/").unwrap())
        .unwrap();
    for event in [0, 1, 2] {
        assert!(
            state
                .event(id, 1, event, "https://www.rust-lang.org/")
                .is_none()
        );
        assert!(
            state
                .event(id, 0, event, "https://www.rust-lang.org/")
                .is_none()
        );
    }
    assert_eq!(state.navigation(id).unwrap(), 2);
    assert_eq!(state.info(id).unwrap().phase, "loading");
    assert_eq!(
        state
            .event(id, 2, 1, "https://www.rust-lang.org/")
            .unwrap()
            .phase,
        "ready"
    );
    assert!(state.event(id, 1, 2, "").is_none());
}
#[test]
fn blocked_then_late_finish_stays_blocked() {
    let state = BrowserWorkspace::default();
    let (id, _, _) = state
        .reserve("a", Url::parse("https://www.rust-lang.org/").unwrap())
        .unwrap();
    state.event(id, 1, 3, "").unwrap();
    assert!(
        state
            .event(id, 1, 1, "https://www.rust-lang.org/")
            .is_none()
    );
    assert_eq!(state.info(id).unwrap().phase, "blocked");
}
#[test]
fn failed_replacement_create_keeps_new_reservation_closeable() {
    let state = BrowserWorkspace::default();
    let (old, info) = ready(&state, "a");
    state.close("a", &info.label).unwrap();
    state.acknowledge_close(old).unwrap();
    let (id, _, info) = state
        .reserve("b", Url::parse("https://www.rust-lang.org/").unwrap())
        .unwrap();
    assert_eq!(state.event(id, 1, 2, "").unwrap().phase, "error");
    assert!(state.close("b", &info.label).unwrap().is_some());
    state.acknowledge_close(id).unwrap();
}

#[test]
fn missing_ack_deadline_releases_waiter_and_cancels_queued_action() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    runtime.block_on(async {
        let (sender, receiver) = tokio::sync::oneshot::channel::<Result<(), String>>();
        assert!(
            native::await_ack(receiver, Duration::from_millis(1))
                .await
                .is_err()
        );
        assert!(sender.is_closed());
        // main/create closures check this before native side effects.
        assert!(sender.send(Ok(())).is_err());
    });
}
#[test]
fn failed_ack_channel_does_not_report_success() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    runtime.block_on(async {
        let (sender, receiver) = tokio::sync::oneshot::channel::<Result<(), String>>();
        drop(sender);
        assert!(
            native::await_ack(receiver, Duration::from_secs(1))
                .await
                .is_err()
        );
    });
}

#[test]
fn shutdown_revokes_queued_creation_and_read_before_native_ack() {
    let state = BrowserWorkspace::default();
    let (id, info) = ready(&state, "a");
    let ticket = state.read_ticket("a", &info.label).unwrap();
    state.begin_shutdown();
    assert!(!state.can_operate(id, Some(1)));
    assert!(state.complete_read(&ticket, result()).is_err());
    assert!(
        state
            .event(id, 1, 1, "https://www.rust-lang.org/")
            .is_none()
    );
    assert!(
        state.info(id).is_ok(),
        "retain owner until native cleanup ACK"
    );
    assert!(
        state
            .reserve("b", Url::parse("https://www.rust-lang.org/").unwrap())
            .is_err()
    );
    state.acknowledge_shutdown();
    assert!(state.active_info().unwrap().is_none());
    assert!(
        state
            .reserve("b", Url::parse("https://www.rust-lang.org/").unwrap())
            .is_err()
    );
}

#[test]
fn only_main_destruction_or_final_exit_reclaims_browser() {
    assert!(should_close_for_event(&tauri::RunEvent::Exit));
    assert!(should_close_for_window(
        "main",
        &tauri::WindowEvent::Destroyed
    ));
    assert!(!should_close_for_event(&tauri::RunEvent::Ready));
    assert!(!should_close_for_window(
        "another-window",
        &tauri::WindowEvent::Destroyed
    ));
}

#[test]
fn cancelled_current_navigation_is_terminal_but_old_cancellation_is_ignored() {
    let state = BrowserWorkspace::default();
    let (id, _, _) = state
        .reserve("a", Url::parse("https://www.rust-lang.org/").unwrap())
        .unwrap();
    state
        .navigate(id, Url::parse("https://www.rust-lang.org/").unwrap())
        .unwrap();
    assert!(state.event(id, 1, 3, "").is_none());
    assert_eq!(state.info(id).unwrap().phase, "loading");
    assert_eq!(state.event(id, 2, 3, "").unwrap().phase, "blocked");
    assert!(
        state
            .event(id, 2, 1, "https://www.rust-lang.org/")
            .is_none()
    );
}
