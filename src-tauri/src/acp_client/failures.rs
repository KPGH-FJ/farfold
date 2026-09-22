//! Public session-failure extension decoding belongs at the protocol boundary.
//! Raw metadata still travels unchanged; only controlled categories reach UI.
use serde_json::{Value, json};
use std::collections::VecDeque;

pub(crate) fn capability() -> Value {
    json!({"version": 1, "capabilities": ["sessionFailure"]})
}

fn failure(meta: &Value) -> Option<&Value> {
    let air = meta.pointer("/jetbrains/air")?;
    if air.get("version")?.as_u64()? != 1 {
        return None;
    }
    let value = air.get("sessionFailure")?;
    value.get("id")?.as_str()?;
    value.get("revision")?.as_u64()?;
    (value.get("severity")?.as_str()? == "error").then_some(value)
}

fn normalized(value: &Value) -> Value {
    let category = value
        .get("category")
        .and_then(Value::as_str)
        .filter(|v| {
            matches!(
                *v,
                "access" | "limit" | "service" | "connection" | "request"
            )
        })
        .unwrap_or("unknown");
    json!({"category": category})
}

/// In-memory deduplication of recent incidents, not a persisted event ledger.
#[derive(Default)]
pub(crate) struct FailureTracker {
    previous: VecDeque<String>,
    current: Option<Value>,
}
impl FailureTracker {
    fn remember(&mut self, value: &Value) {
        if let Some(id) = value.get("id").and_then(Value::as_str)
            && !self.previous.iter().any(|old| old == id)
        {
            self.previous.push_back(id.to_owned());
            if self.previous.len() > 128 {
                self.previous.pop_front();
            }
        }
    }

    pub(crate) fn observe(&mut self, meta: &Value, in_flight: bool) {
        if let Some(value) = failure(meta) {
            if !in_flight {
                self.remember(value);
            } else if !self.previous.iter().any(|id| value["id"] == *id) {
                self.current = Some(value.clone());
            }
        }
    }

    pub(crate) fn finish(&mut self, response: Option<&Value>) -> Option<Value> {
        // The prompt response is attributable to this request, even if an
        // earlier notification carried the same incident.
        let value = response
            .and_then(|r| r.get("_meta"))
            .and_then(failure)
            .cloned()
            .or_else(|| self.current.take());
        self.current = None;
        value.map(|value| {
            self.remember(&value);
            normalized(&value)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn meta(id: &str, severity: &str) -> Value {
        json!({"jetbrains":{"air":{"version":1,"sessionFailure":{
            "id":id,"revision":1,"severity":severity,"category":"service",
            "title":"sensitive raw error", "actions":[]
        }}}})
    }
    #[test]
    fn terminal_failure_and_update_are_normalized_without_free_text() {
        let mut tracker = FailureTracker::default();
        let response = json!({"stopReason":"end_turn","_meta":meta("a", "error")});
        assert_eq!(
            tracker.finish(Some(&response)),
            Some(json!({"category":"service"}))
        );
        tracker.observe(&meta("b", "error"), true);
        assert_eq!(tracker.finish(None), Some(json!({"category":"service"})));
        assert_eq!(tracker.finish(None), None);
    }
    #[test]
    fn warnings_replay_and_old_incidents_do_not_fail_a_new_prompt() {
        let mut tracker = FailureTracker::default();
        tracker.observe(&meta("old", "error"), false);
        tracker.observe(&meta("old", "error"), true);
        tracker.observe(&meta("retry", "warning"), true);
        assert_eq!(tracker.finish(None), None);
        tracker.observe(&meta("retry", "error"), true);
        assert!(tracker.finish(None).is_some());
        tracker.observe(&meta("retry", "error"), true);
        assert_eq!(tracker.finish(None), None);
    }
    #[test]
    fn malformed_or_unknown_extension_is_not_interpreted() {
        let mut tracker = FailureTracker::default();
        let mut value = meta("a", "error");
        value["jetbrains"]["air"]["version"] = json!(2);
        tracker.observe(&value, true);
        tracker.observe(&json!({"message":"error"}), true);
        assert_eq!(tracker.finish(None), None);
    }
}
