//! Transient ownership of officially reported live tools, not an execution loop.
use super::lifecycle::{ConnectionLife, WorkLease};
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc};

mod permission_input;
mod stopped_close;

pub(super) struct ToolActivity {
    life: Arc<ConnectionLife>,
    active: BTreeSet<String>,
    lease: Option<WorkLease>,
    live: bool,
    permission_input: Option<permission_input::PermissionInput>,
    stopped_close: stopped_close::Proof,
}
impl ToolActivity {
    pub(super) fn new(life: Arc<ConnectionLife>) -> Self {
        Self {
            life,
            active: BTreeSet::new(),
            lease: None,
            live: false,
            permission_input: None,
            stopped_close: Default::default(),
        }
    }
    /// Treat pre-prompt notifications, including replay delayed past open's
    /// received prefix, as history. Only a locally admitted prompt starts live
    /// observation; the protocol has no separate activity-query receipt.
    pub(super) fn begin_live(&mut self) {
        self.live = true;
    }
    pub(super) fn start_prompt(&mut self, receipt: u64) {
        self.begin_live();
        let clean = self.active.is_empty();
        self.permission_input = clean.then(|| permission_input::PermissionInput::new(receipt));
        self.stopped_close.start(receipt, clean);
    }
    pub(super) fn invalidate_stopped_close(&mut self) {
        self.stopped_close.invalidate();
    }
    pub(super) fn observe_permission(&mut self, request_id: &str, tool_call: &Value) {
        self.stopped_close.permission(request_id, tool_call);
    }
    pub(super) fn permission_event(
        &mut self,
        request_id: String,
        owner: Value,
        request: Value,
    ) -> Value {
        let mut event = json!({
            "kind": "permissionRequest",
            "requestId": request_id,
            "owner": owner,
            "toolCall": request["toolCall"],
            "options": request["options"],
            "request": request,
        });
        if event["owner"]["sessionId"]
            .as_str()
            .is_some_and(|session| event["request"]["sessionId"] == session)
            && let Some(input) = self
                .permission_input
                .as_mut()
                .and_then(|proof| proof.for_request(&event["toolCall"]))
        {
            event["reportedToolInput"] = input;
        }
        event
    }
    pub(super) fn first_permission_id(&self) -> Option<&str> {
        self.stopped_close.permission_id()
    }
    pub(super) fn cancel_first_permission(&mut self, confirmed: bool) {
        self.stopped_close.cancelled_permission(confirmed);
    }
    pub(super) fn finish_prompt(&mut self, receipt: u64, cancelled: bool) {
        if self
            .permission_input
            .as_ref()
            .is_some_and(|proof| proof.receipt() == receipt)
        {
            self.permission_input = None;
        }
        self.stopped_close.finish(receipt, cancelled);
    }
    pub(super) fn stopped_close(&self) -> Option<(&str, u64)> {
        let (id, receipt) = self.stopped_close.stopped()?;
        (self.active.len() == 1 && self.active.contains(id)).then_some((id, receipt))
    }
    pub(super) fn release_stopped_close(&mut self) {
        self.active.clear();
        self.lease.take();
        self.permission_input = None;
        self.stopped_close.invalidate();
    }
    pub(super) fn busy(&self) -> bool {
        !self.active.is_empty()
    }
    pub(super) fn event(&self) -> Value {
        json!({"kind":"toolActivity", "toolCallIds":self.active})
    }
    pub(super) fn observe(&mut self, params: &Value) -> Option<Value> {
        if !self.live {
            return None;
        }
        let update = params.get("update")?;
        let kind = update.get("sessionUpdate").and_then(Value::as_str);
        let id = update
            .get("toolCallId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty());
        let Some(kind @ ("tool_call" | "tool_call_update")) = kind else {
            // Official terminal output can be rendered without a tool-update
            // label. Its presence still defeats the pre-approval proof.
            if stopped_close::reports_output_extension(update) {
                if let (Some(id), Some(proof)) = (id, &mut self.permission_input) {
                    proof.disqualify(id);
                }
                self.stopped_close.invalidate();
            } else if matches!(kind, Some("config_option_update" | "current_mode_update")) {
                self.stopped_close.config_changed();
            }
            return None;
        };
        let Some(id) = id else {
            self.stopped_close.invalidate();
            return None;
        };
        // The official ToolCall schema omits its default Pending status when
        // serializing. Partial ToolCallUpdate has no such initial default.
        let status = match update.get("status") {
            None if kind == "tool_call" => Some("pending"),
            value => value.and_then(Value::as_str),
        };
        self.stopped_close.tool(kind, id, status, update);
        if let Some(proof) = &mut self.permission_input {
            proof.observe(kind, id, status, update);
        }
        let changed = match status {
            Some("pending" | "in_progress") => {
                if self.lease.is_none() {
                    // Live prompt admission already owns work. If shutdown has
                    // won the race, keep the reported IDs until actual teardown.
                    self.lease = self.life.work().ok();
                }
                self.active.insert(id.to_owned())
            }
            Some("completed" | "failed") => self.active.remove(id),
            // Partial and future updates do not prove an existing tool ended.
            _ => false,
        };
        if self.active.is_empty() {
            self.lease.take();
        }
        changed.then(|| self.event())
    }
}
impl Drop for ToolActivity {
    fn drop(&mut self) {
        if let Some(lease) = self.lease.take() {
            lease.retain_until_terminated();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{SessionNotification, SessionUpdate, ToolCall};
    use std::sync::atomic::Ordering;

    #[test]
    fn reported_permission_input_stays_in_the_original_prompt_and_session() {
        let life = ConnectionLife::new();
        life.ready().unwrap();
        let mut tools = ToolActivity::new(life);
        let tool = |id| json!({"update":{"sessionUpdate":"tool_call","toolCallId":id,"rawInput":"fixture"}});
        let decision = |tools: &mut ToolActivity, session, id| {
            tools.permission_event(
                "permission".into(),
                json!({"sessionId":"original"}),
                json!({"sessionId":session,"toolCall":{"toolCallId":id}}),
            )
        };
        tools.observe(&tool("history"));
        tools.start_prompt(101);
        assert!(
            decision(&mut tools, "original", "history")
                .get("reportedToolInput")
                .is_none()
        );
        tools.observe(&tool("current"));
        assert!(
            decision(&mut tools, "different", "current")
                .get("reportedToolInput")
                .is_none()
        );
        assert_eq!(
            decision(&mut tools, "original", "current")["reportedToolInput"],
            "fixture"
        );
        tools.observe(&tool("previous"));
        tools.observe(&tool("with-output"));
        tools.observe(
            &json!({"update":{"toolCallId":"with-output","_meta":{"terminal_output":{
                "terminal_id":"term","data":"fixture output"
            }}}}),
        );
        assert!(
            decision(&mut tools, "original", "with-output")
                .get("reportedToolInput")
                .is_none()
        );
        tools.finish_prompt(101, false);
        assert!(
            decision(&mut tools, "original", "previous")
                .get("reportedToolInput")
                .is_none()
        );
    }

    #[test]
    fn stopped_tool_close_invalidates_for_reported_output_without_a_tool_update_label() {
        for (kind, extension) in [
            (None, "terminal_output"),
            (Some("agent_message_chunk"), "terminal_output_delta"),
        ] {
            let life = ConnectionLife::new();
            life.ready().unwrap();
            let mut tools = ToolActivity::new(life.clone());
            tools.start_prompt(13);
            tools.observe(&json!({"update":{"sessionUpdate":"tool_call","toolCallId":"exact"}}));
            tools.observe_permission("held", &json!({"toolCallId":"exact"}));
            tools.cancel_first_permission(true);
            tools.finish_prompt(13, true);
            assert_eq!(tools.stopped_close(), Some(("exact", 13)));

            let mut output = json!({"update":{"toolCallId":"exact","_meta":{}}});
            output["update"]["_meta"][extension] = json!({"terminal_id":"tty","data":"worked"});
            if let Some(kind) = kind {
                output["update"]["sessionUpdate"] = json!(kind);
            }
            assert_eq!(
                crate::acp_client::terminal_output::output_event(&output).unwrap()["data"],
                "worked"
            );
            assert!(tools.observe(&output).is_none());
            assert!(tools.stopped_close().is_none());
            assert!(tools.busy());
            assert_eq!(life.work.load(Ordering::SeqCst), 1);
        }
    }

    #[test]
    fn tool_call_default_status_from_official_sdk_retains_pending_work() {
        let life = ConnectionLife::new();
        life.ready().unwrap();
        let mut tools = ToolActivity::new(life.clone());
        tools.begin_live();
        let envelope = serde_json::to_value(SessionNotification::new(
            "session",
            SessionUpdate::ToolCall(ToolCall::new("pending-default", "Preparing a tool")),
        ))
        .unwrap();
        assert!(envelope["update"].get("status").is_none());
        let event = tools
            .observe(&envelope)
            .expect("omitted initial status means pending");
        assert_eq!(event["toolCallIds"], json!(["pending-default"]));
        assert_eq!(life.work.load(Ordering::SeqCst), 1);
        // Only the initial announcement has a pending default. A partial
        // update without status neither invents a new tool nor ends one.
        let partial =
            |id: &str| json!({"update":{"sessionUpdate":"tool_call_update","toolCallId":id}});
        assert!(tools.observe(&partial("unannounced")).is_none());
        assert!(tools.observe(&partial("pending-default")).is_none());
        assert_eq!(tools.event()["toolCallIds"], json!(["pending-default"]));
        tools.observe(&json!({"update":{"sessionUpdate":"tool_call_update","toolCallId":"pending-default","status":"completed"}}));
        assert_eq!(life.work.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn replay_partial_unknown_and_duplicate_statuses_keep_truthful_ownership() {
        let life = ConnectionLife::new();
        life.ready().unwrap();
        let mut tools = ToolActivity::new(life.clone());
        let update = |id: &str, status: Value| json!({"update":{"sessionUpdate":"tool_call_update","toolCallId":id,"status":status}});
        assert!(
            tools
                .observe(&update("history", json!("in_progress")))
                .is_none()
        );
        assert!(!tools.busy());
        tools.begin_live();
        assert!(tools.observe(&update("a", json!("pending"))).is_some());
        assert!(tools.observe(&update("a", json!("pending"))).is_none());
        tools.observe(&update("b", json!("in_progress")));
        assert_eq!(life.work.load(Ordering::SeqCst), 1);
        tools.observe(&update("a", Value::Null));
        tools.observe(&update("a", json!("future-status")));
        assert_eq!(tools.event()["toolCallIds"], json!(["a", "b"]));
        tools.observe(&update("b", json!("failed")));
        assert!(tools.busy());
        tools.observe(&update("a", json!("completed")));
        assert!(!tools.busy());
        assert_eq!(life.work.load(Ordering::SeqCst), 0);
    }
}
