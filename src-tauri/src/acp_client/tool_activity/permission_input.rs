//! Input reported by a pending tool in the current, locally admitted prompt.
use serde_json::Value;
use std::collections::BTreeMap;

enum ToolInput {
    Pending(Option<Value>),
    Unavailable,
}

pub(super) struct PermissionInput {
    receipt: u64,
    tools: BTreeMap<String, ToolInput>,
}

impl PermissionInput {
    pub(super) fn new(receipt: u64) -> Self {
        Self {
            receipt,
            tools: BTreeMap::new(),
        }
    }

    pub(super) fn receipt(&self) -> u64 {
        self.receipt
    }

    pub(super) fn observe(&mut self, kind: &str, id: &str, status: Option<&str>, update: &Value) {
        if super::stopped_close::reports_execution_metadata(update)
            || (kind == "tool_call_update" && super::stopped_close::reports_output(update))
        {
            self.disqualify(id);
        } else if kind == "tool_call" && status == Some("pending") {
            self.tools
                .entry(id.to_owned())
                .and_modify(|slot| *slot = ToolInput::Unavailable)
                .or_insert_with(|| ToolInput::Pending(raw_input(update).cloned()));
        } else if kind == "tool_call_update"
            && (status == Some("pending") || (status.is_none() && update.get("status").is_none()))
        {
            let slot = self
                .tools
                .entry(id.to_owned())
                .or_insert(ToolInput::Unavailable);
            if let (ToolInput::Pending(input), Some(value)) = (slot, raw_input(update)) {
                *input = Some(value.clone());
            }
        } else {
            self.disqualify(id);
        }
    }

    pub(super) fn disqualify(&mut self, id: &str) {
        self.tools.insert(id.to_owned(), ToolInput::Unavailable);
    }

    pub(super) fn for_request(&mut self, request: &Value) -> Option<Value> {
        let id = request
            .get("toolCallId")?
            .as_str()
            .filter(|id| !id.is_empty())?;
        // Every request consumes eligibility, including one with its own input.
        // A repeated ID cannot be used to borrow an earlier approval's details.
        let observed = self.tools.insert(id.to_owned(), ToolInput::Unavailable);
        if raw_input(request).is_none()
            && request
                .get("status")
                .is_none_or(|status| status == "pending")
            && let Some(ToolInput::Pending(input)) = observed
        {
            return input;
        }
        None
    }
}

fn raw_input(update: &Value) -> Option<&Value> {
    update.get("rawInput").filter(|value| !value.is_null())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn first_request_consumes_only_its_exact_tool_input() {
        let mut prompt = PermissionInput::new(101);
        let input = json!({"command":"fixture only"});
        prompt.observe("tool_call", "tool", Some("pending"), &json!({}));
        prompt.observe("tool_call_update", "tool", None, &json!({"rawInput":input}));
        assert_eq!(prompt.for_request(&json!({"toolCallId":"other"})), None);
        assert_eq!(
            prompt.for_request(&json!({"toolCallId":"tool"})),
            Some(input)
        );
        prompt.observe("tool_call_update", "tool", None, &json!({"rawInput":42}));
        assert_eq!(prompt.for_request(&json!({"toolCallId":"tool"})), None);
    }

    #[test]
    fn duplicate_or_finished_tool_cannot_supply_input() {
        let mut prompt = PermissionInput::new(101);
        let update = json!({"rawInput":"fixture"});
        for (id, status) in [("duplicate", "pending"), ("finished", "completed")] {
            prompt.observe("tool_call", id, Some("pending"), &update);
            prompt.observe("tool_call", id, Some(status), &update);
            assert_eq!(prompt.for_request(&json!({"toolCallId":id})), None);
        }
        prompt.observe("tool_call", "incomplete", Some("pending"), &update);
        prompt.observe(
            "tool_call_update",
            "incomplete",
            Some("in_progress"),
            &json!({"status":"in_progress"}),
        );
        assert_eq!(
            prompt.for_request(&json!({"toolCallId":"incomplete"})),
            None
        );
    }

    #[test]
    fn later_output_without_a_status_cannot_supply_approval_input() {
        for output in [
            json!({"content":[{"type":"content","content":{"type":"text","text":"fixture output"}}]}),
            json!({"rawOutput":"fixture output"}),
        ] {
            let mut prompt = PermissionInput::new(101);
            // An initial pending notification may include a proposed diff
            // or a description. Later tool content is ambiguous here.
            let input = json!({"rawInput":"fixture","content":[{"type":"content","content":{"type":"text","text":"operation"}}]});
            prompt.observe("tool_call", "control", Some("pending"), &input);
            prompt.observe("tool_call", "tool", Some("pending"), &input);
            prompt.observe("tool_call_update", "tool", None, &output);
            assert_eq!(prompt.for_request(&json!({"toolCallId":"tool"})), None);
            assert_eq!(
                prompt.for_request(&json!({"toolCallId":"control"})),
                Some(json!("fixture"))
            );
        }
    }
}
