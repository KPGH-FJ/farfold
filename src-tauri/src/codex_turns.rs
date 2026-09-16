//! Native turn bookkeeping only: Codex owns execution. Host admission remains
//! in TurnCoordinator. A terminal turn does not prove background shells exited.
use crate::host_ids::{HostTurnId, NativeSessionId, NativeTurnId};
use serde_json::Value;
use std::collections::HashSet;

pub(crate) enum ActivityUpdate {
    Unchanged,
    UnknownEvent,
    Changed(crate::live_session_projection::RuntimeActivity),
    Reconciled,
    Reconcile,
}

/// Only adapter-confirmed state changes affect shared activity. In particular,
/// raw turn/completed cannot make background commands or unknown outcomes idle.
pub(crate) fn project_activity(kind: &str, envelope: &Value) -> ActivityUpdate {
    use crate::live_session_projection::RuntimeActivity as Activity;
    use ActivityUpdate::*;
    match kind {
        "codex_session_opened" => Reconciled,
        "lifecycle" => match envelope.pointer("/payload/state").and_then(Value::as_str) {
            Some("initialized") => Changed(Activity::Ready),
            Some("terminated") => Changed(Activity::Stopped),
            Some("error") => Reconcile,
            _ => UnknownEvent,
        },
        "codex_turn_state" => match envelope.pointer("/payload/phase").and_then(Value::as_str) {
            Some("submitting" | "executing" | "stopping") => Changed(Activity::Working),
            Some("completed" | "interrupted" | "failed" | "rejected") => Changed(Activity::Idle),
            Some("unknown") => Reconcile,
            _ => UnknownEvent,
        },
        "transport_error" | "protocol_error" | "transport_gap" | "oversized_event" => Reconcile,
        "codex_interaction" | "codex_interaction_reply_sent" | "codex_interactions_invalidated" => {
            Unchanged
        }
        "codex_rpc" => match envelope.pointer("/payload/method").and_then(Value::as_str) {
            Some(
                "turn/started"
                | "turn/completed"
                | "item/started"
                | "item/completed"
                | "item/agentMessage/delta"
                | "item/commandExecution/outputDelta"
                | "item/commandExecution/requestApproval"
                | "item/fileChange/requestApproval"
                | "item/tool/requestUserInput"
                | "serverRequest/resolved",
            ) => Unchanged,
            _ => UnknownEvent,
        },
        _ => UnknownEvent,
    }
}

pub(crate) struct ActiveTurn {
    pub(crate) host_id: HostTurnId,
    pub(crate) thread_id: NativeSessionId,
    pub(crate) native_id: Option<NativeTurnId>,
    pending: Vec<Value>,
    pending_bytes: usize,
    pub(crate) unknown: bool,
    pub(crate) stopping: bool,
    pub(crate) early_interactions: Vec<Value>,
    commands: HashSet<String>,
    terminal: Option<String>,
}

impl ActiveTurn {
    pub(crate) fn new(host_id: HostTurnId, thread_id: NativeSessionId) -> Self {
        Self {
            host_id,
            thread_id,
            native_id: None,
            pending: Vec::new(),
            pending_bytes: 0,
            unknown: false,
            stopping: false,
            early_interactions: Vec::new(),
            commands: HashSet::new(),
            terminal: None,
        }
    }

    pub(crate) fn accepts_interaction(&self, thread: &str, turn: &str) -> bool {
        !self.unknown
            && !self.stopping
            && self.terminal.is_none()
            && self.thread_id.as_str() == thread
            && self
                .native_id
                .as_ref()
                .is_some_and(|id| id.as_str() == turn)
    }

    pub(crate) fn bind(&mut self, response: &Value) -> Result<(), String> {
        let id = response
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .ok_or("Codex 任务响应缺少原生轮次身份")?;
        let id = NativeTurnId::parse(id).map_err(|_| "Codex 原生轮次身份无效")?;
        if self
            .native_id
            .as_ref()
            .is_some_and(|current| *current != id)
        {
            return Err("Codex 原生轮次身份发生变化".into());
        }
        self.native_id = Some(id);
        for event in std::mem::take(&mut self.pending) {
            self.observe(&event);
        }
        self.pending_bytes = 0;
        Ok(())
    }

    pub(crate) fn observe(&mut self, event: &Value) {
        let params = &event["params"];
        if params["threadId"].as_str() != Some(self.thread_id.as_str()) {
            return;
        }
        let Some(id) = &self.native_id else {
            let size = event.to_string().len();
            if self.pending.len() < 256 && self.pending_bytes + size <= 1024 * 1024 {
                self.pending.push(event.clone());
                self.pending_bytes += size;
            } else {
                self.unknown = true;
            }
            return;
        };
        let turn_id = params["turnId"]
            .as_str()
            .or_else(|| params.pointer("/turn/id").and_then(Value::as_str));
        if turn_id != Some(id.as_str()) {
            return;
        }
        match event["method"].as_str() {
            Some("item/started" | "item/completed")
                if params["item"]["type"] == "commandExecution" =>
            {
                let item = &params["item"];
                let Some(key) = item["processId"].as_str().or_else(|| item["id"].as_str()) else {
                    self.unknown = true;
                    return;
                };
                if event["method"] == "item/completed"
                    && (item["exitCode"].is_i64() || item["status"] == "declined")
                {
                    self.commands.remove(key);
                    if let Some(item_id) = item["id"].as_str() {
                        self.commands.remove(item_id);
                    }
                } else if self.commands.len() < 1024 {
                    self.commands.insert(key.to_owned());
                } else {
                    self.unknown = true;
                }
            }
            Some("turn/completed") => match params["turn"]["status"].as_str() {
                Some(status @ ("completed" | "interrupted" | "failed")) => {
                    self.terminal = Some(status.to_owned())
                }
                _ => self.unknown = true,
            },
            _ => {}
        }
    }

    pub(crate) fn settled_reason(&self) -> Option<&str> {
        self.terminal
            .as_deref()
            .filter(|_| !self.unknown && self.commands.is_empty())
    }

    pub(crate) fn outcome_unknown(&self) -> bool {
        self.unknown || (self.terminal.is_some() && !self.commands.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn turn() -> ActiveTurn {
        ActiveTurn::new(
            HostTurnId::parse("host-1").unwrap(),
            NativeSessionId::parse("thread-1").unwrap(),
        )
    }
    fn event(method: &str, params: Value) -> Value {
        json!({"method":method,"params":params})
    }
    #[test]
    fn response_identity_filters_early_and_late_events_without_inventing_completion() {
        let mut state = turn();
        state.observe(&event(
            "turn/completed",
            json!({"threadId":"thread-1","turn":{"id":"old-turn","status":"completed"}}),
        ));
        state.observe(&event(
            "turn/completed",
            json!({"threadId":"thread-1","turn":{"id":"current","status":"failed"}}),
        ));
        assert!(state.settled_reason().is_none());
        state
            .bind(&json!({"turn":{"id":"current","status":"inProgress"}}))
            .unwrap();
        assert_eq!(state.settled_reason(), Some("failed"));
        state.observe(&event(
            "turn/completed",
            json!({"threadId":"thread-1","turn":{"id":"old-turn","status":"completed"}}),
        ));
        assert_eq!(state.settled_reason(), Some("failed"));
        assert!(state.bind(&json!({"turn":{"id":"other"}})).is_err());
    }
    #[test]
    fn interruption_cannot_release_unconfirmed_background_commands() {
        let mut state = turn();
        state.bind(&json!({"turn":{"id":"current"}})).unwrap();
        state.observe(&event("item/started", json!({"threadId":"thread-1","turnId":"current","item":{"id":"command","type":"commandExecution","processId":"123","status":"inProgress","exitCode":null}})));
        state.observe(&event(
            "turn/completed",
            json!({"threadId":"thread-1","turn":{"id":"current","status":"interrupted"}}),
        ));
        assert!(state.outcome_unknown());
        assert!(state.settled_reason().is_none());
        state.observe(&event("item/completed", json!({"threadId":"other-thread","turnId":"current","item":{"id":"command","type":"commandExecution","processId":"123","status":"completed","exitCode":0}})));
        assert!(state.settled_reason().is_none());
        state.observe(&event("item/completed", json!({"threadId":"thread-1","turnId":"current","item":{"id":"poll-command","type":"commandExecution","processId":"123","status":"completed","exitCode":0}})));
        assert_eq!(state.settled_reason(), Some("interrupted"));
    }
    #[test]
    fn missing_early_events_require_reconciliation_even_after_terminal_notification() {
        let mut state = turn();
        for _ in 0..257 {
            state.observe(&event(
                "item/agentMessage/delta",
                json!({"threadId":"thread-1","turnId":"current","delta":"x"}),
            ));
        }
        state.bind(&json!({"turn":{"id":"current"}})).unwrap();
        state.observe(&event(
            "turn/completed",
            json!({"threadId":"thread-1","turn":{"id":"current","status":"completed"}}),
        ));
        assert!(state.outcome_unknown());
        assert!(state.settled_reason().is_none());
    }
}
