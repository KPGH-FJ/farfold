//! Transient ownership of officially reported live tools, not an execution loop.
use super::lifecycle::{ConnectionLife, WorkLease};
use serde_json::{Value, json};
use std::{collections::BTreeSet, sync::Arc};

pub(super) struct ToolActivity {
    life: Arc<ConnectionLife>,
    active: BTreeSet<String>,
    lease: Option<WorkLease>,
    live: bool,
}
impl ToolActivity {
    pub(super) fn new(life: Arc<ConnectionLife>) -> Self {
        Self {
            life,
            active: BTreeSet::new(),
            lease: None,
            live: false,
        }
    }
    /// Treat pre-prompt notifications, including replay delayed past open's
    /// received prefix, as history. Only a locally admitted prompt starts live
    /// observation; the protocol has no separate activity-query receipt.
    pub(super) fn begin_live(&mut self) {
        self.live = true;
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
        let kind = update.get("sessionUpdate")?.as_str()?;
        if !matches!(kind, "tool_call" | "tool_call_update") {
            return None;
        }
        let id = update
            .get("toolCallId")?
            .as_str()
            .filter(|id| !id.is_empty())?;
        // The official ToolCall schema omits its default Pending status when
        // serializing. Partial ToolCallUpdate has no such initial default.
        let status = match update.get("status") {
            None if kind == "tool_call" => Some("pending"),
            value => value.and_then(Value::as_str),
        };
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
