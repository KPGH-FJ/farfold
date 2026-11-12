use super::*;
use crate::acp_client::transient_mcp::SessionMcpOwner;
use crate::browser_sharing::{
    READY, ShareState, ToolSession,
    protocol::{Action, Protocol},
};
use crate::browser_workspace::{BrowserInfo, sharing_scope_fixture};
use serde_json::json;
use std::sync::{Arc, Mutex, OnceLock};

const TASK: &str = "controlled:/fixture:native";
fn fixture(granted: bool) -> (Arc<ToolSession>, BrowserInfo, FixedPageReadScope) {
    let (scope, _) = sharing_scope_fixture(TASK, "page-a");
    let native_session_id = OnceLock::new();
    native_session_id.set("native".into()).unwrap();
    let owner = Arc::new(ToolSession {
        notify: Arc::new(|_| {}),
        agent_id: "controlled".into(),
        cwd: "/fixture".into(),
        native_session_id,
        page: Arc::new(Mutex::new(granted.then(|| scope.clone()))),
        transport: OnceLock::new(),
        state: Mutex::new(ShareState {
            connection: None,
            phase: READY,
            ready: true,
            ended: false,
            prompt_active: true,
            revision: 1,
            retiring: None,
            pending_request: None,
            active_screenshot: None,
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

fn ready(screenshots_available: bool) -> Protocol {
    let mut protocol = Protocol::new(screenshots_available);
    protocol.receive(json!({"jsonrpc":"2.0","id":1,"method":"initialize",
        "params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{}}}));
    protocol.receive(json!({"jsonrpc":"2.0","method":"notifications/initialized"}));
    assert!(matches!(
        protocol.receive(json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})),
        Action::Reply { list: true, .. }
    ));
    assert!(protocol.mark_list_delivered());
    protocol
}

fn call(id: u64, screenshot: bool) -> Value {
    json!({"jsonrpc":"2.0","id":id,"method":"tools/call",
        "params":{"name":"observe_page","arguments":{"screenshot":screenshot}}})
}

#[test]
fn p27_supported_screenshot_enters_original_worker_permission_route() {
    let (owner, page, scope) = fixture(false);
    let mut protocol = ready(true);
    let Action::Read { id, request } = protocol.receive(call(3, true)) else {
        panic!("supported screenshot must reach the worker");
    };
    assert!(!request.control(), "pixels remain read-only");
    let mut wire = Wire::default();
    assert!(
        wire.admit_read(id, request, &owner.page, &|request| owner
            .request_page_permission(page.clone(), request))
            .unwrap()
            .is_none()
    );
    let pending = owner.info(TASK, "").pending_request.unwrap();
    assert_eq!(
        pending.control.as_ref().map(|review| review.kind),
        Some("screenshot")
    );
    assert!(wire.approved_read().unwrap().is_none());
    assert!(owner.page.lock().unwrap().is_none());
    let token = pending.request_id;
    owner
        .respond_permission(TASK, &page.label, &token, true, |pending| {
            assert_eq!(pending.page_revision, page.revision);
            assert_eq!(pending.url, page.url);
            Ok(scope.clone())
        })
        .unwrap();
    let approved = wire.approved_read().unwrap().unwrap();
    assert_eq!(approved.id, json!(3));
    assert_eq!(approved.request, ToolRequest::Observe { screenshot: true });
    assert!(approved.scope.is_valid());
    assert!(
        owner.page.lock().unwrap().is_none(),
        "one screenshot cannot grant future text access"
    );
    assert!(wire.approved_read().unwrap().is_none());
    approved.scope.cancel_action();
    assert!(!approved.scope.is_valid());
    acknowledge_empty_result(&mut wire, 3);
    assert_eq!(owner.info(TASK, "").phase, "unshared");
}

#[test]
fn p27_existing_text_grant_never_bypasses_screenshot_consent() {
    let (owner, page, scope) = fixture(true);
    let mut wire = Wire::default();
    let admitted = wire
        .admit_read(
            json!(3),
            ToolRequest::Observe { screenshot: true },
            &owner.page,
            &|request| owner.request_page_permission(page.clone(), request),
        )
        .unwrap();
    assert!(
        admitted.is_none(),
        "the original text grant must not start capture"
    );
    let pending = owner.info(TASK, "").pending_request.unwrap();
    assert_eq!(pending.control.unwrap().kind, "screenshot");
    assert!(scope.is_valid());
    owner
        .respond_permission(TASK, &page.label, &pending.request_id, true, |_| {
            panic!("must derive original grant")
        })
        .unwrap();
    let approved = wire.approved_read().unwrap().unwrap();
    approved.scope.cancel_action();
    assert!(!approved.scope.is_valid());
    assert!(
        scope.is_valid(),
        "screenshot cancellation does not withdraw text permission"
    );
    assert!(
        owner
            .page
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .same_grant(&scope)
    );
    acknowledge_empty_result(&mut wire, 3);
    assert!(
        wire.admit_read(
            json!(4),
            ToolRequest::Observe { screenshot: true },
            &owner.page,
            &|request| owner.request_page_permission(page.clone(), request)
        )
        .unwrap()
        .is_none()
    );
    let next = owner.info(TASK, "").pending_request.unwrap();
    assert_ne!(next.request_id, pending.request_id);
    assert_eq!(next.control.unwrap().kind, "screenshot");
    assert!(
        owner
            .respond_permission(TASK, &page.label, &pending.request_id, true, |_| panic!(
                "stale"
            ))
            .is_err()
    );
    assert!(wire.approved_read().unwrap().is_none());
}

fn await_screenshot(owner: &Arc<ToolSession>, page: &BrowserInfo, id: u64) -> Wire {
    let Action::Read { id, request } = ready(true).receive(call(id, true)) else {
        panic!("missing admission")
    };
    let mut wire = Wire::default();
    assert!(
        wire.admit_read(id, request, &owner.page, &|request| owner
            .request_page_permission(page.clone(), request))
            .unwrap()
            .is_none()
    );
    wire
}

fn assert_read_error(wire: &Wire, id: u64) {
    let packet = wire.packets.back().unwrap();
    assert!(!packet.control);
    let value: Value = serde_json::from_slice(&packet.bytes).unwrap();
    assert_eq!(value["message"]["id"], json!(id));
    assert_eq!(value["message"]["result"]["isError"], true);
    assert!(value["message"]["result"].get("dispatched").is_none());
}

fn acknowledge_empty_result(wire: &mut Wire, id: u64) {
    wire.reply(
        crate::browser_sharing::protocol::tool_error(json!(id), "controlled empty result"),
        None,
        false,
    )
    .unwrap();
    let number = wire.delivery.as_ref().unwrap().number;
    assert_eq!(wire.acknowledge_written(number), Some(false));
    wire.packets.clear();
}

fn approve(
    owner: &Arc<ToolSession>,
    page: &BrowserInfo,
    scope: &FixedPageReadScope,
    wire: &mut Wire,
) -> AdmittedRead {
    let token = owner.info(TASK, "").pending_request.unwrap().request_id;
    owner
        .respond_permission(TASK, &page.label, &token, true, |_| Ok(scope.clone()))
        .unwrap();
    wire.approved_read().unwrap().unwrap()
}

#[tokio::test]
async fn p27_first_approved_screenshot_still_matches_explicit_stop_after_pending_clears() {
    let (owner, page, scope) = fixture(false);
    let mut wire = await_screenshot(&owner, &page, 7);
    let approved = approve(&owner, &page, &scope, &mut wire);
    let info = owner.info(TASK, "");
    assert!(info.pending_request.is_none());
    assert_eq!(info.phase, "reading");
    assert_eq!(info.label, page.label);
    assert!(owner.page.lock().unwrap().is_none());
    // No real helper exists in this unit fixture: withdrawal must happen, but
    // cannot falsely report that its stdout barrier was acknowledged.
    assert!(
        owner
            .stop_explicit(TASK, &page.label, info.revision)
            .await
            .is_err()
    );
    assert!(!approved.scope.is_valid());
    assert_eq!(owner.info(TASK, "").phase, "stop_failed");
    assert!(
        owner
            .state
            .lock()
            .unwrap()
            .retiring
            .as_ref()
            .unwrap()
            .same_request(&approved.scope)
    );
    wire.reply(
        crate::browser_sharing::protocol::snapshot(json!(7), json!({"text":"CANARY_LATE_PIXELS"})),
        Some(approved.scope),
        false,
    )
    .unwrap();
    assert!(wire.packets[0].withdraw_invalid().unwrap().is_some());
    assert!(!String::from_utf8_lossy(&wire.packets[0].bytes).contains("CANARY"));
    assert!(!wire.packets[0].control);
}

#[tokio::test]
async fn p27_first_approved_screenshot_is_withdrawn_by_page_stop_or_session_close() {
    for close in [false, true] {
        let (owner, page, scope) = fixture(false);
        let mut wire = await_screenshot(&owner, &page, 7);
        let approved = approve(&owner, &page, &scope, &mut wire);
        owner.stop_page(TASK, "other-page").await.unwrap();
        assert!(
            approved.scope.is_valid(),
            "a stale page stop cannot retarget the request"
        );
        if close {
            owner.revoke();
        } else {
            assert!(owner.stop_page(TASK, &page.label).await.is_err());
        }
        assert!(!approved.scope.is_valid());
        assert!(owner.page.lock().unwrap().is_none());
        assert!(owner.state.lock().unwrap().active_screenshot.is_none());
        owner.tool_closed(true);
        assert!(owner.state.lock().unwrap().retiring.is_none());
        drop(wire);
        assert_eq!(owner.info(TASK, "").phase, "unavailable");
    }
}

#[test]
fn p27_screenshot_owner_survives_queued_partial_delivery_until_exact_written_ack() {
    let (owner, page, scope) = fixture(false);
    let mut wire = await_screenshot(&owner, &page, 7);
    let approved = approve(&owner, &page, &scope, &mut wire);
    wire.reply(
        crate::browser_sharing::protocol::snapshot(json!(7), json!({"text":"fixture"})),
        Some(approved.scope.clone()),
        false,
    )
    .unwrap();
    let number = wire.delivery.as_ref().unwrap().number;
    wire.packets[0].written = 1;
    assert_eq!(owner.info(TASK, "").phase, "reading");
    assert_eq!(wire.acknowledge_written(number + 1), None);
    assert!(approved.scope.is_valid());
    wire.packets[0].written = wire.packets[0].bytes.len();
    wire.packets.pop_front();
    assert_eq!(
        owner.info(TASK, "").phase,
        "reading",
        "local enqueue/write is not helper ACK"
    );
    assert_eq!(wire.acknowledge_written(number), Some(false));
    assert!(!approved.scope.is_valid());
    assert_eq!(owner.info(TASK, "").phase, "unshared");
    assert!(owner.page.lock().unwrap().is_none());
    let mut next = await_screenshot(&owner, &page, 8);
    let current = approve(&owner, &page, &scope, &mut next);
    assert_eq!(wire.acknowledge_written(number), None);
    assert!(
        current.scope.is_valid(),
        "old delivery ACK cannot clear a new request"
    );
    acknowledge_empty_result(&mut next, 8);
}

#[tokio::test]
async fn p27_implicit_page_change_stops_first_screenshot_after_broker_write() {
    use super::super::{Control, HandleInner, TransportHandle};
    use crate::browser_sharing::BrowserSharing;
    use std::sync::{atomic::AtomicBool, mpsc};
    use std::time::Duration;

    let (owner, page, scope) = fixture(false);
    let sharing = BrowserSharing(Arc::new(Mutex::new(vec![owner.clone()])));
    let (controls, receive_control) = mpsc::channel();
    let (_completion, completed) = tokio::sync::watch::channel(0);
    assert!(
        owner
            .transport
            .set(TransportHandle(Arc::new(HandleInner {
                #[cfg(target_os = "macos")]
                initialized: Arc::new(AtomicBool::new(false)),
                #[cfg(target_os = "macos")]
                listed: Arc::new(AtomicBool::new(false)),
                page: owner.page.clone(),
                controls,
                shutdown: Arc::new(AtomicBool::new(false)),
                completed,
            })))
            .is_ok()
    );

    let mut wire = await_screenshot(&owner, &page, 7);
    let approved = approve(&owner, &page, &scope, &mut wire);
    wire.reply(
        crate::browser_sharing::protocol::snapshot(json!(7), json!({"text":"fixture"})),
        Some(approved.scope.clone()),
        false,
    )
    .unwrap();
    // Model a complete broker write with helper stdout still held. The
    // response has left the broker queue; its original delivery still owns
    // the screenshot until the helper reports a write or a stop barrier.
    let queued = wire.packets.pop_front().unwrap();
    let response: Value = serde_json::from_slice(&queued.bytes).unwrap();
    assert_eq!(response["message"]["id"], 7);
    assert_eq!(response["page"], true);
    assert_eq!(wire.delivery.as_ref().unwrap().number, response["delivery"]);
    assert!(owner.page.lock().unwrap().is_none());

    let held = owner.operation.lock().await;
    // Same boundary facts as the native page-change notification: the
    // captured scope is invalid and the current page has a new revision.
    scope.revoke();
    assert!(!approved.scope.is_valid());
    let mut changed = page.clone();
    changed.revision += 1;
    let mut unrelated = changed.clone();
    unrelated.label = "other-page".into();
    sharing.page_changed(&unrelated);
    assert_eq!(owner.info(TASK, &page.label).phase, "reading");

    sharing.page_changed(&changed);
    assert_eq!(
        owner.info(TASK, &page.label).phase,
        "stopping",
        "the first screenshot still owns a buffered response after a native page change"
    );
    assert!(
        owner
            .state
            .lock()
            .unwrap()
            .retiring
            .as_ref()
            .is_some_and(|retiring| retiring.same_request(&approved.scope))
    );
    assert!(matches!(
        receive_control.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
    drop(held);

    let Control::Quiesce(Some(ack)) =
        tokio::task::spawn_blocking(move || receive_control.recv_timeout(Duration::from_secs(2)))
            .await
            .unwrap()
            .expect("the page change must reach the existing helper stop path")
    else {
        panic!("the stop must keep its confirmation sender")
    };
    assert_eq!(owner.info(TASK, &page.label).phase, "stopping");
    assert!(
        wire.delivery.is_some(),
        "quiesce dispatch is not a write ACK"
    );
    ack.send(Ok(())).unwrap();
    let _settled = owner.operation.lock().await;
    assert_eq!(owner.info(TASK, &page.label).phase, "unshared");
    assert!(owner.page.lock().unwrap().is_none());
}

#[test]
fn p27_page_notification_does_not_treat_request_cancel_as_grant_withdrawal() {
    let (owner, page, scope) = fixture(false);
    let sharing = crate::browser_sharing::BrowserSharing(Arc::new(Mutex::new(vec![owner.clone()])));
    let mut wire = await_screenshot(&owner, &page, 7);
    let approved = approve(&owner, &page, &scope, &mut wire);
    wire.reply(
        crate::browser_sharing::protocol::snapshot(json!(7), json!({"text":"fixture"})),
        Some(approved.scope.clone()),
        false,
    )
    .unwrap();

    wire.cancel(&approved.id).unwrap();
    assert!(
        wire.barrier.is_some(),
        "request cancel owns its own barrier"
    );
    assert!(!approved.scope.is_valid());
    assert!(approved.scope.grant_is_valid());

    sharing.page_changed(&page);
    assert_eq!(owner.info(TASK, &page.label).phase, "reading");
    assert!(owner.state.lock().unwrap().retiring.is_none());
    wire.finish_stopped_screenshot();
    assert_eq!(owner.info(TASK, &page.label).phase, "unshared");
}

#[test]
fn p27_lost_delivery_ack_retains_unknown_stop_owner_without_text_grant() {
    let (owner, page, scope) = fixture(false);
    let mut wire = await_screenshot(&owner, &page, 7);
    let approved = approve(&owner, &page, &scope, &mut wire);
    wire.reply(
        crate::browser_sharing::protocol::snapshot(json!(7), json!({"text":"fixture"})),
        Some(approved.scope.clone()),
        false,
    )
    .unwrap();
    wire.packets[0].written = 1;
    drop(wire);
    assert!(!approved.scope.is_valid());
    assert_eq!(owner.info(TASK, "").phase, "stop_failed");
    assert!(owner.state.lock().unwrap().retiring.is_some());
    assert!(owner.page.lock().unwrap().is_none());
    owner.tool_closed(true);
    assert!(owner.state.lock().unwrap().retiring.is_none());
}

#[test]
fn p27_unsupported_capability_refuses_without_permission_or_text_fallback() {
    let (owner, _, scope) = fixture(true);
    let mut protocol = ready(false);
    for id in [3, 4] {
        let Action::Reply { value, list: false } = protocol.receive(call(id, true)) else {
            panic!("unsupported capability admitted page access")
        };
        assert_eq!(value["id"], json!(id));
        assert_eq!(value["result"]["isError"], true);
        assert!(
            value["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("不支持")
        );
    }
    assert!(owner.info(TASK, "").pending_request.is_none());
    assert!(scope.is_valid());
    assert!(matches!(
        protocol.receive(call(5, false)),
        Action::Read {
            request: ToolRequest::Observe { screenshot: false },
            ..
        }
    ));
}

#[test]
fn p27_cancelled_screenshot_rejects_late_approval_and_preserves_text_grant() {
    let (owner, page, scope) = fixture(true);
    let mut wire = await_screenshot(&owner, &page, 7);
    let token = owner.info(TASK, "").pending_request.unwrap().request_id;
    let Action::Cancel { id } = ready(true).receive(
        json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7}}),
    ) else {
        panic!("cancel")
    };
    wire.cancel(&id).unwrap();
    assert!(owner.info(TASK, "").pending_request.is_none());
    assert!(
        owner
            .respond_permission(TASK, &page.label, &token, true, |_| panic!(
                "cancelled capture"
            ))
            .is_err()
    );
    assert!(wire.approved_read().unwrap().is_none());
    assert_read_error(&wire, 7);
    assert!(scope.is_valid());
}

#[test]
fn p27_denied_screenshot_never_captures_and_does_not_authorize_next_request() {
    let (owner, page, _) = fixture(false);
    let mut wire = await_screenshot(&owner, &page, 7);
    let token = owner.info(TASK, "").pending_request.unwrap().request_id;
    owner
        .respond_permission(TASK, &page.label, &token, false, |_| {
            panic!("denied capture")
        })
        .unwrap();
    assert!(wire.approved_read().unwrap().is_none());
    assert_read_error(&wire, 7);
    assert!(owner.page.lock().unwrap().is_none());
    let next = await_screenshot(&owner, &page, 8);
    let current = owner.info(TASK, "").pending_request.unwrap();
    assert_ne!(token, current.request_id);
    assert!(next.waiting.is_some());
}

#[test]
fn p27_page_change_invalidates_exact_pending_screenshot_without_capture() {
    for field in 0..3 {
        let (owner, mut page, scope) = fixture(true);
        let mut wire = await_screenshot(&owner, &page, 7);
        let token = owner.info(TASK, "").pending_request.unwrap().request_id;
        match field {
            0 => page.revision += 1,
            1 => page.url = "https://example.com/other".into(),
            _ => page.phase = "loading".into(),
        }
        owner.invalidate_pending_page(&page);
        assert!(
            owner
                .respond_permission(TASK, &page.label, &token, true, |_| panic!(
                    "changed capture"
                ))
                .is_err()
        );
        assert!(wire.approved_read().unwrap().is_none());
        assert_read_error(&wire, 7);
        assert!(
            scope.is_valid(),
            "pending cancellation does not fabricate page navigation"
        );
    }
}

#[test]
fn p27_revocation_before_or_after_approval_never_reaches_native_admission() {
    for after_approval in [false, true] {
        let (owner, page, scope) = fixture(true);
        let mut wire = await_screenshot(&owner, &page, 7);
        let token = owner.info(TASK, "").pending_request.unwrap().request_id;
        if after_approval {
            owner
                .respond_permission(TASK, &page.label, &token, true, |_| {
                    panic!("existing grant")
                })
                .unwrap();
        }
        scope.revoke();
        if !after_approval {
            assert!(
                owner
                    .respond_permission(TASK, &page.label, &token, true, |_| panic!(
                        "revoked capture"
                    ))
                    .is_err()
            );
        }
        assert!(wire.approved_read().unwrap().is_none());
        assert_read_error(&wire, 7);
    }
}

#[test]
fn p27_transport_stop_drops_pending_screenshot_and_preserves_readonly_outcome() {
    let (owner, page, _) = fixture(false);
    let mut wire = await_screenshot(&owner, &page, 7);
    let token = owner.info(TASK, "").pending_request.unwrap().request_id;
    wire.stop(false, None).unwrap();
    assert!(owner.info(TASK, "").pending_request.is_none());
    assert!(
        owner
            .respond_permission(TASK, &page.label, &token, true, |_| panic!(
                "stopped capture"
            ))
            .is_err()
    );
    assert!(wire.waiting.is_none());
    let packet = wire.packets.iter().find(|p| p.delivery.is_some()).unwrap();
    assert!(!packet.control);
    let value: Value = serde_json::from_slice(&packet.bytes).unwrap();
    assert_eq!(value["message"]["result"]["isError"], true);
}
