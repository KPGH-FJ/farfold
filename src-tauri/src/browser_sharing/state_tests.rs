//! Grant-state regressions through the same private stop methods as commands.
//! No AppHandle/setup, native view, Agent or transport worker is constructed.
use super::*;
use crate::browser_workspace::sharing_scope_fixture;
use std::{future::Future, task::Poll, time::Duration};

const TASK: &str = "controlled:/fixture:native";

pub(super) fn session(page: FixedPageReadScope) -> Arc<ToolSession> {
    let native_session_id = OnceLock::new();
    native_session_id.set("native".into()).unwrap();
    Arc::new(ToolSession {
        notify: Arc::new(|_| {}),
        agent_id: "controlled".into(),
        cwd: "/fixture".into(),
        native_session_id,
        page: Arc::new(Mutex::new(Some(page))),
        transport: OnceLock::new(),
        state: Mutex::new(ShareState {
            phase: READY,
            ready: true,
            ended: false,
            revision: 1,
            retiring: None,
            pending_request: None,
        }),
        operation: tokio::sync::Mutex::new(()),
    })
}

async fn until(mut ready: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while !ready() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("controlled sharing state did not settle");
}

fn assert_current(session: &ToolSession, expected: &FixedPageReadScope, revision: u64) {
    assert!(
        expected.is_valid(),
        "the replacement grant must stay usable"
    );
    assert!(
        session
            .page
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|page| page.same_grant(expected))
    );
    let info = session.info(TASK, expected.label());
    assert_eq!(info.phase, "shared");
    assert_eq!(
        info.revision, revision,
        "a stale stop must not publish a state change"
    );
}

#[tokio::test]
async fn delayed_invalidated_stop_rechecks_exact_retiring_grant_after_operation_lock() {
    let (old, replacement) = sharing_scope_fixture(TASK, "same-page");
    let owner = session(old.clone());
    let held = owner.operation.lock().await;
    // This is the real invalidation callback. Its async stop must wait for held.
    owner.invalidated(&old);
    assert!(!old.is_valid());
    assert_eq!(owner.info(TASK, old.label()).phase, "stopping");

    // Also poll the exact extracted method once to prove its identity check is
    // after lock acquisition, not a check captured before this queued wait.
    let mut late = Box::pin(owner.stop_expected(&old));
    assert!(std::future::poll_fn(|cx| Poll::Ready(late.as_mut().poll(cx).is_pending())).await);

    // Fixture precondition: another earlier stop received its transport ACK,
    // then the user granted B. This models the settled state, not an actual
    // stdout ACK; transport ACK behavior has separate transport tests.
    let replacement_revision = {
        let mut state = owner.state.lock().unwrap();
        assert!(
            state
                .retiring
                .as_ref()
                .is_some_and(|scope| scope.same_grant(&old))
        );
        state.retiring.take();
        state.phase = READY;
        *owner.page.lock().unwrap() = Some(replacement.clone());
        state.revision += 2;
        state.revision
    };
    drop(held);
    late.await.unwrap();
    // Wait for the actual invalidated callback's queued closure too.
    until(|| Arc::strong_count(&owner) == 1).await;
    assert_current(&owner, &replacement, replacement_revision);
}

#[tokio::test]
async fn old_page_label_stop_cannot_revoke_the_current_page_grant() {
    let (old, _) = sharing_scope_fixture(TASK, "old-page");
    let (replacement, _) = sharing_scope_fixture(TASK, "new-page");
    let owner = session(old.clone());
    let held = owner.operation.lock().await;
    let mut automatic = Box::pin(owner.stop_page(TASK, old.label()));
    assert!(std::future::poll_fn(|cx| Poll::Ready(automatic.as_mut().poll(cx).is_pending())).await);
    let revision = {
        let mut state = owner.state.lock().unwrap();
        old.revoke();
        *owner.page.lock().unwrap() = Some(replacement.clone());
        state.revision += 2;
        state.revision
    };
    drop(held);
    automatic.await.unwrap();
    assert_current(&owner, &replacement, revision);
    // Give explicit UI stop a CURRENT revision so this also proves label
    // matching, not only rejection by the unrelated revision guard.
    owner
        .stop_explicit(TASK, old.label(), revision)
        .await
        .unwrap();
    assert_current(&owner, &replacement, revision);
}

#[tokio::test]
async fn same_page_old_expected_revision_is_rechecked_after_waiting_for_operation() {
    let (old, replacement) = sharing_scope_fixture(TASK, "same-page");
    let owner = session(old.clone());
    let old_revision = owner.info(TASK, old.label()).revision;
    let held = owner.operation.lock().await;
    let mut late = Box::pin(owner.stop_explicit(TASK, old.label(), old_revision));
    assert!(std::future::poll_fn(|cx| Poll::Ready(late.as_mut().poll(cx).is_pending())).await);
    let new_revision = {
        let mut state = owner.state.lock().unwrap();
        old.revoke();
        *owner.page.lock().unwrap() = Some(replacement.clone());
        state.revision += 2;
        state.revision
    };
    drop(held);
    assert!(
        late.await.is_err(),
        "a stale explicit stop must be rejected"
    );
    assert_current(&owner, &replacement, new_revision);
}

#[tokio::test]
async fn stopping_and_failed_stop_without_quiesce_ack_never_report_unshared() {
    let (scope, _) = sharing_scope_fixture(TASK, "page");
    let owner = session(scope.clone());
    let held = owner.operation.lock().await;
    owner.invalidated(&scope);
    assert!(owner.page.lock().unwrap().is_none());
    assert_eq!(owner.info(TASK, scope.label()).phase, "stopping");
    drop(held);
    // No transport is installed, so the real stop_locked path cannot receive
    // an ACK and must retain the retiring scope for an explicit retry.
    until(|| owner.state.lock().unwrap().phase == STOP_FAILED).await;
    until(|| Arc::strong_count(&owner) == 1).await;
    let failed = owner.info(TASK, scope.label());
    assert_eq!(failed.phase, "stop_failed");
    assert_eq!(failed.reason, Some("stop_unconfirmed"));
    assert!(
        owner
            .state
            .lock()
            .unwrap()
            .retiring
            .as_ref()
            .is_some_and(|old| old.same_grant(&scope))
    );
    assert!(
        owner
            .stop_explicit(TASK, scope.label(), failed.revision)
            .await
            .is_err()
    );
    assert_eq!(owner.info(TASK, scope.label()).phase, "stop_failed");
    assert!(!scope.is_valid());
}

#[test]
fn route_revoke_without_stdout_confirmation_preserves_retiring_ownership() {
    let (current, _) = sharing_scope_fixture(TASK, "page");
    let owner = session(current.clone());
    SessionMcpOwner::revoke(owner.as_ref());
    assert!(!current.is_valid());
    assert!(owner.page.lock().unwrap().is_none());
    let state = owner.state.lock().unwrap();
    assert!(state.ended);
    assert!(
        state
            .retiring
            .as_ref()
            .is_some_and(|old| old.same_grant(&current)),
        "route release must retain authority identity until helper stdout stop is confirmed"
    );
    assert!(
        matches!(state.phase, STOPPING | STOP_FAILED),
        "route release alone is not a confirmed transport close"
    );
    drop(state);
    assert!(matches!(
        owner.info(TASK, current.label()).phase,
        "stopping" | "stop_failed"
    ));
}

#[test]
fn confirmed_final_output_close_releases_retiring_ownership() {
    let (retiring, _) = sharing_scope_fixture(TASK, "page");
    retiring.revoke();
    let owner = session(retiring.clone());
    *owner.page.lock().unwrap() = None;
    {
        let mut state = owner.state.lock().unwrap();
        state.retiring = Some(retiring.clone());
        state.phase = STOP_FAILED;
        state.ready = false;
        state.ended = true;
    }
    assert_eq!(owner.info(TASK, retiring.label()).phase, "stop_failed");
    owner.tool_closed(true);
    assert!(!retiring.is_valid());
    assert!(owner.page.lock().unwrap().is_none());
    assert!(owner.state.lock().unwrap().retiring.is_none());
    assert_eq!(owner.info(TASK, retiring.label()).phase, "unavailable");
}

#[tokio::test]
async fn unconfirmed_close_retains_registry_owner_until_final_stdout_confirmation() {
    let (scope, _) = sharing_scope_fixture(TASK, "page");
    let owner = session(scope.clone());
    let registry = BrowserSharing::default();
    registry.0.lock().unwrap().push(owner.clone());
    let weak = Arc::downgrade(&owner);
    // The actual route has ended; a broken connection alone is not stdout ACK.
    owner.revoke();
    owner.tool_closed(false);
    assert_eq!(owner.info(TASK, scope.label()).phase, "stop_failed");
    assert!(!scope.is_valid());
    drop(owner);
    assert!(
        weak.upgrade().is_some(),
        "unconfirmed retiring owner was lost with the route"
    );
    let pending = registry.entries();
    assert_eq!(pending.len(), 1);
    assert!(
        pending[0]
            .state
            .lock()
            .unwrap()
            .retiring
            .as_ref()
            .is_some_and(|old| old.same_grant(&scope))
    );
    // Page close/switch guard must still find the owner and reject an
    // unconfirmed retry, even after the ACP route's Arc was dropped.
    assert!(registry.stop_page(TASK, scope.label()).await.is_err());
    assert_eq!(pending[0].info(TASK, scope.label()).phase, "stop_failed");
    pending[0].tool_closed(true);
    drop(pending);
    assert!(registry.entries().is_empty());
    assert!(
        weak.upgrade().is_none(),
        "confirmed ended owner was retained indefinitely"
    );
}
