use super::super::{ShareState, ToolSession};
use super::*;
use crate::browser_workspace::sharing_scope_fixture;
use std::sync::{Mutex, OnceLock};

const TASK: &str = "controlled:/fixture:native";
fn fixture() -> (Arc<ToolSession>, BrowserInfo, FixedPageReadScope) {
    let (scope, _) = sharing_scope_fixture(TASK, "page-a");
    let native_session_id = OnceLock::new();
    native_session_id.set("native".into()).unwrap();
    let owner = Arc::new(ToolSession {
        notify: Arc::new(|_| {}),
        agent_id: "controlled".into(),
        cwd: "/fixture".into(),
        native_session_id,
        page: Arc::new(Mutex::new(None)),
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
    });
    let page = BrowserInfo {
        task_key: TASK.into(),
        label: "page-a".into(),
        url: "https://example.com/public".into(),
        local_file_name: None,
        preview_mode: None,
        local_storage_persistent: None,
        phase: "ready".into(),
        revision: 3,
        error: None,
    };
    (owner, page, scope)
}
fn pending_id(owner: &ToolSession) -> String {
    owner.info(TASK, "").pending_request.unwrap().request_id
}

#[test]
fn asking_permission_keeps_the_request_waiting_without_read_authority() {
    let (owner, page, _) = fixture();
    let wait = owner.request_permission(page.clone()).unwrap();
    assert!(wait.poll().is_none());
    assert!(owner.page.lock().unwrap().is_none());
    let state = owner.info(TASK, "");
    assert_eq!(state.phase, "unshared");
    assert_eq!(state.revision, 2);
    let pending = state.pending_request.unwrap();
    assert_eq!(pending.task_key, TASK);
    assert_eq!(pending.label, page.label);
    assert_eq!(pending.url, page.url);
    assert_eq!(pending.page_revision, 3);
    assert!(
        owner.request_permission(page).is_err(),
        "second call must not replace first"
    );
}

#[test]
fn approval_delivers_exact_grant_to_original_waiter_once() {
    let (owner, page, scope) = fixture();
    let wait = owner.request_permission(page.clone()).unwrap();
    let id = pending_id(&owner);
    owner
        .respond_permission(TASK, &page.label, &id, true, |pending| {
            assert_eq!(pending.page_revision, page.revision);
            assert_eq!(pending.url, page.url);
            Ok(scope.clone())
        })
        .unwrap();
    assert!(wait.poll().unwrap().unwrap().same_grant(&scope));
    assert!(owner.info(TASK, "").pending_request.is_none());
    assert_eq!(owner.info(TASK, &page.label).phase, "shared");
    assert_eq!(owner.info(TASK, "").phase, "shared");
    assert_eq!(owner.info(TASK, "").label, page.label);
    assert_eq!(owner.info(TASK, "other-page").phase, "stopping");
    assert!(
        owner
            .respond_permission(TASK, &page.label, &id, true, |_| panic!("second capture"))
            .is_err()
    );
    assert!(scope.is_valid());
}

#[test]
fn denial_never_captures_page_and_stale_approval_cannot_replace_next_request() {
    let (owner, page, _) = fixture();
    let wait = owner.request_permission(page.clone()).unwrap();
    let old = pending_id(&owner);
    owner
        .respond_permission(TASK, &page.label, &old, false, |_| {
            panic!("denial captured page")
        })
        .unwrap();
    assert!(wait.poll().unwrap().is_err());
    let next = owner.request_permission(page.clone()).unwrap();
    let current = pending_id(&owner);
    assert_ne!(old, current);
    drop(wait);
    assert_eq!(
        pending_id(&owner),
        current,
        "old wait cleanup must not remove new approval"
    );
    assert!(
        owner
            .respond_permission(TASK, &page.label, &old, true, |_| panic!("late capture"))
            .is_err()
    );
    assert_eq!(pending_id(&owner), current);
    assert!(next.poll().is_none());
    assert!(owner.page.lock().unwrap().is_none());
}

#[test]
fn cancelled_original_wait_cannot_be_approved_later() {
    let (owner, page, _) = fixture();
    let wait = owner.request_permission(page.clone()).unwrap();
    let id = pending_id(&owner);
    drop(wait);
    assert!(owner.info(TASK, "").pending_request.is_none());
    assert_eq!(owner.info(TASK, "").revision, 3);
    assert!(
        owner
            .respond_permission(TASK, &page.label, &id, true, |_| panic!(
                "cancelled capture"
            ))
            .is_err()
    );
}

#[test]
fn changed_page_invalidates_confirmation_before_approval() {
    let (owner, mut page, _) = fixture();
    let wait = owner.request_permission(page.clone()).unwrap();
    let id = pending_id(&owner);
    page.revision += 1;
    page.url = "https://example.com/other".into();
    owner.invalidate_pending_page(&page);
    assert!(wait.poll().unwrap().is_err());
    assert!(
        owner
            .respond_permission(TASK, &page.label, &id, true, |_| panic!(
                "new page captured"
            ))
            .is_err()
    );
    assert!(owner.page.lock().unwrap().is_none());
}

#[test]
fn expired_confirmation_rejects_approval_without_capture() {
    let (owner, page, _) = fixture();
    let mut wait = owner.request_permission(page.clone()).unwrap();
    let id = pending_id(&owner);
    let past = Instant::now() - Duration::from_secs(1);
    owner
        .state
        .lock()
        .unwrap()
        .pending_request
        .as_mut()
        .unwrap()
        .deadline = past;
    wait.deadline = past;
    assert!(
        owner
            .respond_permission(TASK, &page.label, &id, true, |_| panic!("expired capture"))
            .is_err()
    );
    assert!(wait.poll().unwrap().is_err());
    assert!(owner.info(TASK, "").pending_request.is_none());
}

#[test]
fn exact_page_capture_failure_ends_original_request_without_authority() {
    let (owner, page, _) = fixture();
    let wait = owner.request_permission(page.clone()).unwrap();
    let id = pending_id(&owner);
    assert!(
        owner
            .respond_permission(TASK, &page.label, &id, true, |_| Err("changed".into()))
            .is_err()
    );
    assert!(wait.poll().unwrap().is_err());
    assert!(owner.page.lock().unwrap().is_none());
    assert!(owner.info(TASK, "").pending_request.is_none());
}

#[test]
fn disconnect_ends_wait_without_creating_a_grant() {
    let (owner, page, _) = fixture();
    let wait = owner.request_permission(page.clone()).unwrap();
    let id = pending_id(&owner);
    owner.tool_closed(false);
    assert!(wait.poll().unwrap().is_err());
    assert!(
        owner
            .respond_permission(TASK, &page.label, &id, true, |_| panic!(
                "disconnected capture"
            ))
            .is_err()
    );
    assert!(owner.info(TASK, "").pending_request.is_none());
}

#[test]
fn wrong_task_or_label_never_consumes_original_confirmation() {
    let (owner, page, _) = fixture();
    let wait = owner.request_permission(page.clone()).unwrap();
    let id = pending_id(&owner);
    for (task, label) in [("other-task", page.label.as_str()), (TASK, "other-page")] {
        assert!(
            owner
                .respond_permission(task, label, &id, true, |_| panic!("wrong page capture"))
                .is_err()
        );
    }
    assert_eq!(pending_id(&owner), id);
    assert!(wait.poll().is_none());
}

#[test]
fn waiting_timeout_cleans_request_on_drop_even_without_a_user_response() {
    let (owner, page, _) = fixture();
    let mut wait = owner.request_permission(page).unwrap();
    wait.deadline = Instant::now() - Duration::from_secs(1);
    assert!(wait.poll().unwrap().is_err());
    drop(wait);
    assert!(owner.info(TASK, "").pending_request.is_none());
    assert_eq!(owner.info(TASK, "").revision, 3);
}

#[test]
fn explicit_operation_grant_is_one_shot_and_does_not_replace_the_read_grant() {
    let (owner, page, scope) = fixture();
    *owner.page.lock().unwrap() = Some(scope.clone());
    let wait = owner
        .request_tool_permission(
            page.clone(),
            Some(crate::browser_workspace::ControlReview {
                kind: "screenshot",
                target: "Visible page".into(),
                text: None,
            }),
        )
        .unwrap();
    let id = pending_id(&owner);
    owner
        .respond_permission(TASK, &page.label, &id, true, |_| {
            panic!("operation must not manufacture a new read scope")
        })
        .unwrap();
    let approved = wait.poll().unwrap().unwrap();
    approved.cancel_action();
    assert!(!approved.is_valid());
    assert!(scope.is_valid());
    assert!(
        owner
            .page
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .same_grant(&scope)
    );
    assert!(
        owner
            .respond_permission(TASK, &page.label, &id, true, |_| panic!(
                "no second delivery"
            ))
            .is_err()
    );
}
