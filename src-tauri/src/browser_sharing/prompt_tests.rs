//! Actual permission methods without a browser, model, transport or page body.
//! Ending a reply must end its decision even without an MCP cancel notification.
use super::*;
use crate::browser_workspace::{BrowserInfo, ControlReview, sharing_scope_fixture};
use std::sync::atomic::{AtomicUsize, Ordering};

const TASK: &str = "controlled:/fixture:native";
const LABEL: &str = "page-a";

fn page() -> BrowserInfo {
    BrowserInfo {
        task_key: TASK.into(),
        label: LABEL.into(),
        url: "https://example.com/".into(),
        local_file_name: None,
        preview_mode: None,
        local_storage_persistent: None,
        phase: "ready".into(),
        revision: 3,
        error: None,
    }
}

fn owner() -> (Arc<ToolSession>, Arc<AtomicUsize>) {
    let (scope, _) = sharing_scope_fixture(TASK, LABEL);
    let mut owner = state_tests::session(scope);
    *owner.page.lock().unwrap() = None;
    owner.state.lock().unwrap().prompt_active = false;
    let changed = Arc::new(AtomicUsize::new(0));
    let observed = changed.clone();
    Arc::get_mut(&mut owner).unwrap().notify = Arc::new(move |_| {
        observed.fetch_add(1, Ordering::SeqCst);
    });
    (owner, changed)
}

#[test]
fn stopped_prompt_cancels_its_decision_without_mcp_notification_and_rejects_late_requests() {
    let (owner, changed) = owner();
    assert!(owner.request_permission(page()).is_err());
    owner.set_prompt_active(true);
    let waiting = owner.request_permission(page()).unwrap();
    let request = owner.info(TASK, LABEL).pending_request.unwrap();
    let before = changed.load(Ordering::SeqCst);
    owner.set_prompt_active(false);
    assert!(matches!(waiting.poll(), Some(Err(_))));
    assert!(owner.info(TASK, LABEL).pending_request.is_none());
    assert_eq!(changed.load(Ordering::SeqCst), before + 1);
    assert!(owner.request_permission(page()).is_err());
    assert!(
        owner
            .respond_permission(TASK, LABEL, &request.request_id, true, |_| {
                panic!("ended permission must never capture the page")
            })
            .is_err()
    );
    assert_eq!(owner.info(TASK, LABEL).phase, "unshared");
    assert!(!owner.state.lock().unwrap().ended);
}

#[test]
fn next_prompt_can_request_and_approve_after_old_wait_is_dropped() {
    let (owner, _) = owner();
    owner.set_prompt_active(true);
    let old = owner.request_permission(page()).unwrap();
    owner.set_prompt_active(false);
    owner.set_prompt_active(true);
    let current = owner.request_permission(page()).unwrap();
    let pending = owner.info(TASK, LABEL).pending_request.unwrap();
    drop(old);
    assert_eq!(
        owner.info(TASK, LABEL).pending_request.unwrap().request_id,
        pending.request_id
    );
    owner
        .respond_permission(TASK, LABEL, &pending.request_id, true, |_| {
            Ok(sharing_scope_fixture(TASK, LABEL).0)
        })
        .unwrap();
    assert!(matches!(current.poll(), Some(Ok(_))));
    assert!(owner.info(TASK, LABEL).pending_request.is_none());
    assert_eq!(owner.info(TASK, LABEL).phase, "shared");
}

#[test]
fn ending_one_prompt_keeps_other_owner_and_explicit_page_grant() {
    let (first, _) = owner();
    let (other, _) = owner();
    let (grant, _) = sharing_scope_fixture(TASK, LABEL);
    *first.page.lock().unwrap() = Some(grant.clone());
    first.set_prompt_active(true);
    other.set_prompt_active(true);
    let control = first
        .request_tool_permission(
            page(),
            Some(ControlReview {
                kind: "screenshot",
                target: "current page".into(),
                text: None,
            }),
        )
        .unwrap();
    let other_wait = other.request_permission(page()).unwrap();
    first.set_prompt_active(false);
    assert!(matches!(control.poll(), Some(Err(_))));
    assert!(other_wait.poll().is_none());
    assert!(other.info(TASK, LABEL).pending_request.is_some());
    assert!(grant.is_valid());
    assert_eq!(first.info(TASK, LABEL).phase, "shared");
    assert!(first.state.lock().unwrap().retiring.is_none());
    first.set_prompt_active(true);
    assert!(
        first
            .request_tool_permission(
                page(),
                Some(ControlReview {
                    kind: "screenshot",
                    target: "current page".into(),
                    text: None,
                })
            )
            .is_ok()
    );
}
