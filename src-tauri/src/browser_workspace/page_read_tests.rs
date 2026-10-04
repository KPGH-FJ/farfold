use super::FixedPageReadScope;
use crate::browser_workspace::{BrowserInfo, BrowserWorkspace, PageReadLease, Url};
use std::cell::Cell;

fn ready() -> (BrowserWorkspace, u64, BrowserInfo) {
    let state = BrowserWorkspace::default();
    let (id, _, _) = state
        .reserve("task-a", Url::parse("https://example.com/").unwrap())
        .unwrap();
    state.event(id, 1, 1, "https://example.com/").unwrap();
    let info = state.info(id).unwrap();
    (state, id, info)
}

fn raw() -> &'static str {
    r#"{"blocked":false,"url":"https://example.com/","title":"Fixture","text":"public fixture"}"#
}

fn scope(state: &BrowserWorkspace, info: &BrowserInfo) -> (PageReadLease, FixedPageReadScope) {
    let lease = PageReadLease::new();
    let scope = state
        .capture_read_scope("task-a", &info.label, info.revision, lease.clone())
        .unwrap();
    (lease, scope)
}

#[test]
fn scope_captures_only_the_ready_exact_page_and_live_grant() {
    let (state, id, info) = ready();
    assert!(
        state
            .capture_read_scope("task-b", &info.label, info.revision, PageReadLease::new())
            .is_err()
    );
    assert!(
        state
            .capture_read_scope(
                "task-a",
                "another-page",
                info.revision,
                PageReadLease::new()
            )
            .is_err()
    );
    let lease = PageReadLease::new();
    lease.revoke();
    assert!(
        state
            .capture_read_scope("task-a", &info.label, info.revision, lease)
            .is_err()
    );
    state
        .navigate(id, Url::parse("https://example.com/next").unwrap())
        .unwrap();
    assert!(
        state
            .capture_read_scope("task-a", &info.label, info.revision, PageReadLease::new())
            .is_err()
    );
}

#[test]
fn permitted_observation_uses_the_captured_native_id_and_returns_snapshot() {
    let (state, id, info) = ready();
    let (_, scope) = scope(&state, &info);
    let observed = Cell::new(None);
    scope
        .observe(|actual, expected| {
            observed.set(Some(actual));
            assert_eq!(expected, Some("https://example.com/"));
            Ok(())
        })
        .unwrap();
    assert_eq!(observed.get(), Some(id));
    let snapshot = scope.complete(raw()).unwrap();
    assert_eq!(snapshot.text, "public fixture");
    assert_eq!(snapshot.task_key, "task-a");
    assert!(scope.is_valid());
}

#[test]
fn revoke_before_main_thread_dispatch_prevents_the_observation_itself() {
    let (state, _, info) = ready();
    let (lease, scope) = scope(&state, &info);
    let queued = scope.clone();
    lease.revoke();
    let count = Cell::new(0);
    assert!(
        queued
            .observe(|_, _| {
                count.set(count.get() + 1);
                Ok(())
            })
            .is_err()
    );
    assert_eq!(count.get(), 0);
    assert!(!scope.is_valid());
}

#[test]
fn revoke_after_observation_discards_native_result_and_prepared_output() {
    let (state, _, info) = ready();
    let (lease, scope) = scope(&state, &info);
    scope.observe(|_, _| Ok(())).unwrap();
    let snapshot = scope.complete(raw()).unwrap();
    lease.revoke();
    assert!(scope.complete(raw()).is_err());
    let writes = Cell::new(0);
    assert!(
        scope
            .with_valid(|| {
                writes.set(1);
                Ok(snapshot)
            })
            .is_err()
    );
    assert_eq!(writes.get(), 0);
}

#[test]
fn all_page_invalidations_block_queued_observation_and_late_result() {
    for invalidation in 0..6 {
        let (state, id, info) = ready();
        let (_, scope) = scope(&state, &info);
        match invalidation {
            0 => {
                state
                    .navigate(id, Url::parse("https://example.com/next").unwrap())
                    .unwrap();
            }
            1 => {
                state
                    .link_navigation(id, "https://example.com/link")
                    .unwrap();
            }
            2 => {
                state.event(id, 1, 3, "").unwrap();
            }
            3 => {
                state.event(id, 1, 5, "").unwrap();
            }
            4 => {
                state.close("task-a", &info.label).unwrap();
            }
            5 => state.begin_shutdown(),
            _ => unreachable!(),
        }
        let observed = Cell::new(false);
        assert!(
            scope
                .observe(|_, _| {
                    observed.set(true);
                    Ok(())
                })
                .is_err(),
            "case {invalidation}"
        );
        assert!(!observed.get(), "case {invalidation}");
        assert!(scope.complete(raw()).is_err(), "case {invalidation}");
        assert!(!scope.is_valid(), "case {invalidation}");
    }
}

#[test]
fn ready_after_navigation_or_reopening_never_revives_an_old_scope() {
    let (state, id, info) = ready();
    let (_, old) = scope(&state, &info);
    state
        .navigate(id, Url::parse("https://example.com/").unwrap())
        .unwrap();
    state.event(id, 2, 1, "https://example.com/").unwrap();
    assert!(!old.is_valid());
    let (_, current) = scope(&state, &state.info(id).unwrap());
    state.close("task-a", &info.label).unwrap();
    state.acknowledge_close(id).unwrap();
    let (new_id, _, new_info) = state
        .reserve("task-a", Url::parse("https://example.com/").unwrap())
        .unwrap();
    state.event(new_id, 1, 1, "https://example.com/").unwrap();
    assert_ne!(info.label, new_info.label);
    assert!(!current.is_valid());
    assert!(scope(&state, &state.info(new_id).unwrap()).1.is_valid());
}

#[test]
fn manual_snapshots_use_the_same_pre_observation_page_guard() {
    let (state, id, info) = ready();
    let queued = state.manual_read_scope("task-a", &info.label).unwrap();
    state
        .navigate(id, Url::parse("https://example.com/next").unwrap())
        .unwrap();
    let observed = Cell::new(false);
    assert!(
        queued
            .observe(|_, _| {
                observed.set(true);
                Ok(())
            })
            .is_err()
    );
    assert!(!observed.get());
}

#[test]
fn observation_and_output_actions_hold_both_revoke_and_page_gates() {
    let (state, _, info) = ready();
    let (lease, scope) = scope(&state, &info);
    scope
        .observe(|_, _| {
            assert!(
                lease.0.try_lock().is_err(),
                "revoke cannot pass an ongoing observation start"
            );
            assert!(
                state.0.try_lock().is_err(),
                "navigation cannot pass an ongoing observation start"
            );
            Ok(())
        })
        .unwrap();
    scope
        .with_valid(|| {
            assert!(
                lease.0.try_lock().is_err(),
                "output write is in the same revoke gate"
            );
            assert!(
                state.0.try_lock().is_err(),
                "output write is in the same page gate"
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn detected_login_input_permanently_revokes_shared_grant_only() {
    let (state, _, info) = ready();
    let (_, shared) = scope(&state, &info);
    assert!(shared.complete(r#"{"blocked":true}"#).is_err());
    assert!(!shared.is_valid());
    assert!(shared.complete(raw()).is_err());
    let manual = state.manual_read_scope("task-a", &info.label).unwrap();
    assert!(manual.complete(r#"{"blocked":true}"#).is_err());
    assert!(manual.complete(raw()).is_ok());
}

#[test]
fn read_and_result_failures_do_not_expose_body_or_change_page() {
    let (state, id, info) = ready();
    let (_, scope) = scope(&state, &info);
    assert!(
        scope
            .observe::<()>(|_, _| Err("controlled observation failure".into()))
            .is_err()
    );
    assert!(scope.complete("malformed fixture").is_err());
    assert!(
        scope
            .complete(r#"{"blocked":false,"url":"https://other.example/","text":"DO-NOT-DELIVER"}"#)
            .is_err()
    );
    assert_eq!(state.info(id).unwrap().phase, "ready");
}

#[test]
fn confirmation_revision_is_checked_before_capturing_an_authority() {
    let (state, id, info) = ready();
    assert!(
        state
            .capture_read_scope(
                "task-a",
                &info.label,
                info.revision - 1,
                PageReadLease::new()
            )
            .is_err()
    );
    state
        .navigate(id, Url::parse("https://example.com/").unwrap())
        .unwrap();
    state.event(id, 2, 1, "https://example.com/").unwrap();
    assert!(
        state
            .capture_read_scope("task-a", &info.label, info.revision, PageReadLease::new())
            .is_err()
    );
    let current = state.info(id).unwrap();
    let (_, captured) = scope(&state, &current);
    assert_eq!(captured.task_key(), "task-a");
    assert_eq!(captured.label(), info.label);
    captured.revoke();
    assert!(!captured.is_valid());
}

#[test]
fn scoped_authority_is_send_and_sync_for_the_transport_worker() {
    fn require<T: Send + Sync + Clone>() {}
    require::<FixedPageReadScope>();
    require::<PageReadLease>();
}

#[test]
fn late_invalidation_identifies_only_the_exact_grant() {
    let (state, _, info) = ready();
    let (_, previous) = scope(&state, &info);
    let (_, current) = scope(&state, &info);
    assert!(previous.same_grant(&previous.clone()));
    assert!(!previous.same_grant(&current));
    previous.revoke();
    assert!(previous.same_grant(&previous.clone()));
    assert!(current.is_valid());
}

#[test]
fn same_document_url_change_discards_result_and_revokes_the_share() {
    let (state, _, info) = ready();
    let (_, shared) = scope(&state, &info);
    assert!(
        shared
            .complete(
                r#"{"blocked":false,"url":"https://example.com/next","text":"must not leave"}"#
            )
            .is_err()
    );
    assert!(!shared.is_valid());
    assert!(shared.complete(raw()).is_err());
    let manual = state.manual_read_scope("task-a", &info.label).unwrap();
    assert!(
        manual
            .complete(
                r#"{"blocked":false,"url":"https://example.com/next","text":"manual preview"}"#
            )
            .is_ok()
    );
}

#[test]
fn same_document_live_body_changes_remain_readable_under_the_fixed_url() {
    let (state, _, info) = ready();
    let (_, shared) = scope(&state, &info);
    assert_eq!(shared.complete(raw()).unwrap().text, "public fixture");
    assert_eq!(
        shared
            .complete(
                r#"{"blocked":false,"url":"https://example.com/","text":"updated public fixture"}"#
            )
            .unwrap()
            .text,
        "updated public fixture"
    );
    assert!(shared.is_valid());
}
