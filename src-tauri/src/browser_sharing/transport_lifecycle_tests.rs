//! Actual Wire/lease cancellation, without starting an application or page.
use super::*;
use serde_json::json;

#[test]
fn queued_control_cancellation_preserves_the_original_page_grant() {
    let (grant, _) = crate::browser_workspace::sharing_scope_fixture("task-a", "page-a");
    let request = grant.one_shot().unwrap();
    let mut wire = Wire::default();
    wire.control_reply(
        protocol::snapshot(json!(42), json!({"outcome":"dispatched","applied":true})),
        request.clone(),
    )
    .unwrap();
    wire.cancel(&json!(41)).unwrap();
    assert!(
        request.is_valid(),
        "unrelated cancellation must not retire this request"
    );
    wire.cancel(&json!(42)).unwrap();
    assert!(!request.is_valid());
    assert!(
        grant.is_valid(),
        "cancelling one returned operation is not stop sharing"
    );
    assert!(
        wire.barrier.is_some(),
        "output still requires the helper barrier"
    );
    assert!(wire.packets[0].withdraw_invalid().unwrap().is_some());
    let packet: Value = serde_json::from_slice(&wire.packets[0].bytes).unwrap();
    assert_eq!(
        packet["message"]["result"]["structuredContent"]["outcome"],
        "unknown"
    );
    assert_eq!(packet["page"], false);
}

#[test]
fn queued_read_cancellation_preserves_the_original_page_grant() {
    let (grant, _) = crate::browser_workspace::sharing_scope_fixture("task-a", "page-a");
    let request = grant.one_shot().unwrap();
    let mut wire = Wire::default();
    wire.reply(
        protocol::snapshot(json!(42), json!({"text":"controlled public body"})),
        Some(request.clone()),
        false,
    )
    .unwrap();
    wire.cancel(&json!(42)).unwrap();
    assert!(!request.is_valid());
    assert!(
        grant.is_valid(),
        "the next explicit read may still use the user's grant"
    );
    assert!(wire.barrier.is_some());
    wire.packets[0].withdraw_invalid().unwrap();
    assert!(!String::from_utf8_lossy(&wire.packets[0].bytes).contains("controlled public body"));
}

#[test]
fn pending_read_drop_closes_only_its_own_dispatch_gate() {
    let (grant, _) = crate::browser_workspace::sharing_scope_fixture("task-a", "page-a");
    let request = grant.one_shot().unwrap();
    let (send, receive) = mpsc::channel();
    let task = tauri::async_runtime::spawn(async move {
        let _sender = send;
        std::future::pending::<()>().await;
    });
    let mut wire = Wire {
        pending: Some(PendingRead {
            id: json!(42),
            scope: request.clone(),
            result: receive,
            task,
            request: ToolRequest::Read,
            finished: Arc::new(AtomicBool::new(false)),
        }),
        ..Default::default()
    };
    wire.cancel(&json!(42)).unwrap();
    assert!(
        !request.is_valid(),
        "drop must synchronously prevent a queued native read"
    );
    assert!(grant.is_valid());
    assert!(wire.pending.is_none());
}

#[test]
fn unconfirmed_read_does_not_claim_that_the_page_grant_was_revoked() {
    let reply = operation_error_reply(json!(42), false, ToolFailure::Unconfirmed);
    let message = reply["result"]["content"][0]["text"].as_str().unwrap();
    assert!(message.contains("未确认"));
    assert!(!message.contains("许可已停止"));
    assert!(message.contains("不要自动重试"));
    assert!(reply["result"].get("structuredContent").is_none());
}

#[test]
fn request_scope_never_refreshes_a_cancelled_control_decision() {
    let (grant, _) = crate::browser_workspace::sharing_scope_fixture("task-a", "page-a");
    let approved = grant.one_shot().unwrap();
    approved.cancel_action();
    let request = approved.request_scope();
    assert!(!request.is_valid());
    assert!(request.grant_is_valid());
    assert!(grant.is_valid());
}

#[test]
fn separate_reads_keep_request_gates_but_still_inherit_whole_page_withdrawal() {
    let (grant, _) = crate::browser_workspace::sharing_scope_fixture("task-a", "page-a");
    let first = grant.request_scope();
    let second = grant.request_scope();
    first.cancel_action();
    assert!(!first.is_valid());
    assert!(first.grant_is_valid());
    assert!(second.is_valid());
    grant.revoke();
    assert!(!second.is_valid());
    assert!(!first.grant_is_valid());
    assert!(!second.grant_is_valid());
}
