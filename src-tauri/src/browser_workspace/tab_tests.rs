use super::*;

#[test]
fn second_page_reservation_keeps_first_page_owned() {
    let state = BrowserWorkspace::default();
    let (first, _, first_info) = state
        .reserve("task-a", Url::parse("https://example.com/a").unwrap())
        .unwrap();
    let (second, _, second_info) = state
        .reserve("task-a", Url::parse("https://example.com/b").unwrap())
        .expect("a second page must be reserved without closing its sibling");
    assert_ne!(first, second);
    assert_eq!(state.info(first).unwrap().label, first_info.label);
    assert_eq!(state.info(second).unwrap().label, second_info.label);
}

/// Old fixtures now explicitly select their first hidden page. Even here the
/// production transaction runs; no stop/hide may occur without an old page.
pub(super) fn select_initial(state: &BrowserWorkspace, task: &str, label: &str) {
    let expected = state.tabs(task).unwrap().selection;
    assert!(expected.label.is_none());
    state
        .creation_confirmed(state.identity(task, label).unwrap())
        .unwrap();
    let movement = state
        .begin_select(task, Some(label), &expected)
        .unwrap()
        .unwrap();
    futures_lite::future::block_on(state.execute_selection(
        movement,
        |_, _| async { panic!("initial selection has no retiring grant") },
        |_| async { panic!("initial selection has no visible page") },
    ))
    .unwrap();
}

fn page(state: &BrowserWorkspace, task: &str, path: &str) -> (u64, BrowserInfo) {
    let url = format!("https://example.com/{path}");
    let (id, _, _) = state.reserve(task, Url::parse(&url).unwrap()).unwrap();
    state.creation_confirmed(id).unwrap();
    (id, state.event(id, 1, 1, &url).unwrap())
}

async fn select(state: &BrowserWorkspace, task: &str, label: Option<&str>) {
    let expected = state.tabs(task).unwrap().selection;
    if let Some(movement) = state.begin_select(task, label, &expected).unwrap() {
        state
            .execute_selection(movement, |_, _| async { Ok(()) }, |_| async { Ok(()) })
            .await
            .unwrap();
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap()
}

#[test]
fn selection_waits_for_stop_and_hide_ack_without_changing_navigation() {
    runtime().block_on(async {
        let state = BrowserWorkspace::default();
        let (a, first) = page(&state, "task", "a");
        let (_, second) = page(&state, "task", "b");
        select_initial(&state, "task", &first.label);
        state.visibility_start(a, true).unwrap();
        assert!(state.can_present(a));
        state.visibility_finished(a, true, true);
        let manual = state.manual_read_scope("task", &first.label).unwrap();
        let granted = state
            .capture_read_scope("task", &first.label, first.revision, PageReadLease::new())
            .unwrap();
        let original = state.tabs("task").unwrap().selection;
        let movement = state
            .begin_select("task", Some(&second.label), &original)
            .unwrap()
            .unwrap();
        assert!(!manual.is_valid());
        assert!(!granted.is_valid());
        assert_eq!(state.navigation(a).unwrap(), 1);
        let (stopped_tx, stopped_rx) = tokio::sync::oneshot::channel();
        let (hidden_tx, hidden_rx) = tokio::sync::oneshot::channel();
        let (stop_started_tx, stop_started_rx) = tokio::sync::oneshot::channel();
        let (hide_started_tx, mut hide_started_rx) = tokio::sync::oneshot::channel();
        let worker_state = state.clone();
        let owner = first.label.clone();
        let pending = tokio::spawn(async move {
            worker_state
                .execute_selection(
                    movement,
                    |task, label| async move {
                        assert_eq!((task.as_str(), label.as_str()), ("task", owner.as_str()));
                        stop_started_tx.send(()).unwrap();
                        stopped_rx.await.unwrap()
                    },
                    |id| async move {
                        assert_eq!(id, a);
                        hide_started_tx.send(()).unwrap();
                        hidden_rx.await.unwrap()
                    },
                )
                .await
        });
        stop_started_rx.await.unwrap();
        assert!(matches!(
            hide_started_rx.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        assert_eq!(
            state.tabs("task").unwrap().selection.label.as_deref(),
            Some(first.label.as_str())
        );
        assert!(state.read_ticket("task", &second.label).is_err());
        assert!(state.visibility_start(a, true).is_err());
        stopped_tx.send(Ok(())).unwrap();
        hide_started_rx.await.unwrap();
        assert_eq!(
            state.tabs("task").unwrap().selection.label.as_deref(),
            Some(first.label.as_str())
        );
        hidden_tx.send(Ok(())).unwrap();
        let selected = pending.await.unwrap().unwrap();
        assert_eq!(
            selected.selection.label.as_deref(),
            Some(second.label.as_str())
        );
        assert_eq!(selected.selection.revision, original.revision + 1);
        assert_eq!(state.navigation(a).unwrap(), 1);
        assert!(
            state.0.lock().unwrap().presented.is_none(),
            "select never shows a page"
        );
        assert!(
            state.visibility_start(a, true).is_err(),
            "late old-label show is rejected"
        );
        assert!(!manual.is_valid());
    });
}

#[test]
fn stop_failure_keeps_owner_and_revoked_scope_until_explicit_retry() {
    runtime().block_on(async {
        let state = BrowserWorkspace::default();
        let (a, first) = page(&state, "task", "a");
        let (_, second) = page(&state, "task", "b");
        select_initial(&state, "task", &first.label);
        let old = state.manual_read_scope("task", &first.label).unwrap();
        let original = state.tabs("task").unwrap().selection;
        let movement = state
            .begin_select("task", Some(&second.label), &original)
            .unwrap()
            .unwrap();
        let result = state
            .execute_selection(
                movement,
                |_, _| async { Err("stop was not acknowledged".into()) },
                |_| async { panic!("hide must wait for stop ACK") },
            )
            .await;
        assert!(result.is_err());
        assert_eq!(state.tabs("task").unwrap().pages.len(), 2);
        assert_eq!(state.tabs("task").unwrap().selection.label, original.label);
        assert!(
            state
                .info(a)
                .unwrap()
                .error
                .unwrap()
                .contains("切换尚未确认")
        );
        assert!(state.visibility_start(a, true).is_err());
        assert!(!old.is_valid());
        select(&state, "task", Some(&second.label)).await;
        assert!(
            state.info(a).unwrap().error.is_none(),
            "confirmed retry must clear the retired page's stale selection error"
        );
        select(&state, "task", Some(&first.label)).await;
        assert!(!old.is_valid(), "A-B-A never restores an old page gate");
        assert!(
            state
                .manual_read_scope("task", &first.label)
                .unwrap()
                .is_valid()
        );
        assert!(
            state
                .begin_select("task", Some(&second.label), &original)
                .is_err(),
            "old selection serial cannot replay after A-B-A"
        );
        let writes = std::cell::Cell::new(0);
        assert!(
            old.with_valid(|| {
                writes.set(writes.get() + 1);
                Ok(())
            })
            .is_err()
        );
        assert_eq!(writes.get(), 0);
    });
}

#[test]
fn hide_failure_retains_global_barrier_and_failed_owner_without_a_page_cap() {
    runtime().block_on(async {
        let state = BrowserWorkspace::default();
        let (a, first) = page(&state, "task", "a");
        let (_, second) = page(&state, "task", "b");
        let (c, third) = page(&state, "other", "c");
        select_initial(&state, "task", &first.label);
        select_initial(&state, "other", &third.label);
        let original = state.tabs("task").unwrap().selection;
        let movement = state
            .begin_select("task", Some(&second.label), &original)
            .unwrap()
            .unwrap();
        assert!(
            state
                .execute_selection(
                    movement,
                    |_, _| async { Ok(()) },
                    |_| async { Err("hide timeout".into()) }
                )
                .await
                .is_err()
        );
        let (d, _) = page(&state, "other", "d");
        assert_eq!(
            state.0.lock().unwrap().pages.len(),
            4,
            "validation examples are not a product cap"
        );
        assert!(state.visibility_start(c, true).is_err());
        assert!(
            state.visibility_start(d, false).is_err(),
            "another owner cannot clear the unknown surface"
        );
        assert!(state.visibility_start(a, true).is_err());
        state.close("task", &first.label).unwrap();
        state.close_failed(a).unwrap();
        assert_eq!(state.tabs("task").unwrap().pages.len(), 2);
        assert!(state.visibility_start(c, true).is_err());
        assert!(state.acknowledge_close(d).is_none());
        assert!(state.info(a).is_ok());
        state.acknowledge_close(a).unwrap();
        state.visibility_start(c, true).unwrap();
        assert!(state.can_present(c));
        state.visibility_finished(c, true, true);
        assert!(state.info(d).is_ok());
    });
}

#[test]
fn hiding_same_selected_page_retains_scopes_and_selection_across_tasks() {
    let state = BrowserWorkspace::default();
    let (a, first) = page(&state, "one", "a");
    let (b, second) = page(&state, "two", "b");
    select_initial(&state, "one", &first.label);
    select_initial(&state, "two", &second.label);
    let before = state.tabs("one").unwrap().selection;
    let manual = state.manual_read_scope("one", &first.label).unwrap();
    let grant = state
        .capture_read_scope("one", &first.label, first.revision, PageReadLease::new())
        .unwrap();
    state.visibility_start(a, true).unwrap();
    state.visibility_finished(a, true, true);
    assert!(state.visibility_start(b, true).is_err());
    state.visibility_start(a, false).unwrap();
    state.visibility_finished(a, false, true);
    state.visibility_start(b, true).unwrap();
    state.visibility_finished(b, true, true);
    assert!(manual.is_valid());
    assert!(grant.is_valid());
    assert_eq!(state.tabs("one").unwrap().selection, before);
    assert_eq!(state.navigation(a).unwrap(), 1);
    assert!(
        state
            .begin_select(
                "two",
                Some(&first.label),
                &state.tabs("two").unwrap().selection
            )
            .is_err()
    );
}

#[test]
fn loading_sibling_finishes_without_stealing_selection_or_reviving_old_reads() {
    runtime().block_on(async {
        let state = BrowserWorkspace::default();
        let (a, first) = page(&state, "task", "a");
        let (_, second) = page(&state, "task", "b");
        select_initial(&state, "task", &first.label);
        let old = state.manual_read_scope("task", &first.label).unwrap();
        state
            .navigate(a, Url::parse("https://example.com/next").unwrap())
            .unwrap();
        select(&state, "task", Some(&second.label)).await;
        assert_eq!(
            state
                .event(a, 2, 1, "https://example.com/next")
                .unwrap()
                .phase,
            "ready"
        );
        assert_eq!(
            state.tabs("task").unwrap().selection.label.as_deref(),
            Some(second.label.as_str())
        );
        select(&state, "task", Some(&first.label)).await;
        assert!(!old.is_valid());
        assert!(
            state
                .manual_read_scope("task", &first.label)
                .unwrap()
                .is_valid()
        );
    });
}

#[test]
fn shutdown_keeps_every_owner_until_native_ack_and_refuses_late_creation() {
    let state = BrowserWorkspace::default();
    let (a, first) = page(&state, "one", "a");
    let (b, second) = page(&state, "two", "b");
    let (c, _) = state
        .reserve("one", Url::parse("https://example.com/creating").unwrap())
        .map(|(id, _, info)| (id, info))
        .unwrap();
    select_initial(&state, "one", &first.label);
    select_initial(&state, "two", &second.label);
    let one = state.manual_read_scope("one", &first.label).unwrap();
    let two = state.manual_read_scope("two", &second.label).unwrap();
    state.begin_shutdown();
    for id in [a, b, c] {
        assert!(state.info(id).is_ok());
        assert!(!state.can_operate(id, Some(1)));
        assert!(state.event(id, 1, 1, "https://example.com/").is_none());
    }
    assert!(!one.is_valid());
    assert!(!two.is_valid());
    assert!(
        state
            .reserve("three", Url::parse("https://example.com/").unwrap())
            .is_err()
    );
    state.acknowledge_shutdown();
    assert!(state.tabs("one").unwrap().pages.is_empty());
    assert!(state.tabs("two").unwrap().pages.is_empty());
    assert!(state.acknowledge_close(a).is_none());
}

#[test]
fn clearing_storage_refuses_a_sibling_in_the_same_partition_until_close_ack() {
    let state = BrowserWorkspace::default();
    let storage = local_html::StoragePartition {
        identifier: "bb96ceef-5927-8d53-b974-c5ad6f7a1108".into(),
        origin: Url::parse("https://file-one.invalid/").unwrap(),
    };
    let (_, _, first) = state
        .reserve_html("one", "game.html".into(), storage.clone())
        .unwrap();
    let (other, _, second) = state
        .reserve_html("one", "game.html".into(), storage)
        .unwrap();
    assert!(state.local_storage("one", &first.label).is_err());
    state.close("one", &second.label).unwrap();
    assert!(state.local_storage("one", &first.label).is_err());
    state.acknowledge_close(other).unwrap();
    assert!(state.local_storage("one", &first.label).is_ok());
}

#[test]
fn tab_review_regression_delayed_allow_cannot_regrant_after_returning_to_same_page() {
    runtime().block_on(async {
        let state = BrowserWorkspace::default();
        let (a, first) = page(&state, "task", "a");
        let (_, second) = page(&state, "task", "b");
        select_initial(&state, "task", &first.label);
        let user_saw = state.permission_page("task").unwrap();
        select(&state, "task", Some(&second.label)).await;
        select(&state, "task", Some(&first.label)).await;
        // This is the same capture boundary used by browser_share_allow; the old
        // invocation has not captured a scope or nonce before the two switches.
        assert!(
            state
                .capture_read_scope(
                    "task",
                    &user_saw.label,
                    user_saw.revision,
                    PageReadLease::new()
                )
                .is_err()
        );
        let fresh = state.permission_page("task").unwrap();
        assert!(
            state
                .capture_read_scope("task", &fresh.label, fresh.revision, PageReadLease::new())
                .is_ok()
        );
        assert_eq!(
            state.navigation(a).unwrap(),
            1,
            "control revision must not fabricate native navigation"
        );
    });
}

#[test]
fn unconfirmed_creation_blocks_other_show_until_its_exact_close_ack() {
    let state = BrowserWorkspace::default();
    let (a, first) = page(&state, "one", "a");
    select_initial(&state, "one", &first.label);
    let (pending, _, pending_info) = state
        .reserve("two", Url::parse("https://example.com/pending").unwrap())
        .unwrap();
    assert!(
        state.visibility_start(a, true).is_err(),
        "a possibly-created surface has no hidden acknowledgement yet"
    );
    state.event(pending, 1, 2, "").unwrap();
    state.close("two", &pending_info.label).unwrap();
    state.close_failed(pending).unwrap();
    assert!(state.visibility_start(a, true).is_err());
    assert!(state.info(pending).is_ok());
    state.acknowledge_close(pending).unwrap();
    state.visibility_start(a, true).unwrap();
    assert!(state.can_present(a));
}
