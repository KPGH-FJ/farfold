//! Input reported by a tool in the current, locally admitted prompt.
use super::stopped_close::{reports_execution_metadata, reports_output};
use serde_json::Value;
use std::collections::BTreeMap;

enum ToolInput {
    Pending(Option<Value>),
    Started(Value),
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
        if reports_execution_metadata(update)
            || (kind == "tool_call_update" && reports_output(update))
        {
            self.disqualify(id);
        } else if kind == "tool_call" {
            self.tools
                .entry(id.to_owned())
                .and_modify(|slot| *slot = ToolInput::Unavailable)
                .or_insert_with(|| match status {
                    Some("pending") => ToolInput::Pending(raw_input(update).cloned()),
                    // A tool may be reported as started even when it will then
                    // request approval. Its first input is display context only.
                    Some("in_progress") if !reports_output(update) => raw_input(update)
                        .cloned()
                        .map_or(ToolInput::Unavailable, ToolInput::Started),
                    _ => ToolInput::Unavailable,
                });
        } else if kind == "tool_call_update" {
            let slot = self
                .tools
                .entry(id.to_owned())
                .or_insert(ToolInput::Unavailable);
            match slot {
                ToolInput::Pending(input)
                    if status == Some("pending")
                        || (status.is_none() && update.get("status").is_none()) =>
                {
                    if let Some(value) = raw_input(update) {
                        *input = Some(value.clone());
                    }
                }
                ToolInput::Started(_) if is_noop(update) => {}
                _ => *slot = ToolInput::Unavailable,
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
        if raw_input(request).is_some()
            || !request
                .get("status")
                .is_none_or(|status| status == "pending")
        {
            return None;
        }
        match observed {
            Some(ToolInput::Pending(input)) => input,
            Some(ToolInput::Started(input)) if !reports_output(request) => Some(input),
            _ => None,
        }
    }
}

fn raw_input(update: &Value) -> Option<&Value> {
    update.get("rawInput").filter(|value| !value.is_null())
}

fn is_noop(update: &Value) -> bool {
    update.as_object().is_some_and(|fields| {
        fields.iter().all(|(key, value)| match key.as_str() {
            "sessionUpdate" | "toolCallId" => true,
            "title" | "name" | "kind" | "status" | "rawInput" | "rawOutput" | "locations"
            | "content" => value.is_null(),
            _ => false,
        })
    })
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
    fn matching_start_in_progress_supplies_context_without_execution_output() {
        let mut prompt = PermissionInput::new(101);
        let input = json!({"command":"fixture only"});
        let start = json!({"rawInput":input});
        prompt.observe("tool_call", "original", Some("in_progress"), &start);
        prompt.observe(
            "tool_call_update",
            "original",
            None,
            &json!({"sessionUpdate":"tool_call_update","toolCallId":"original","rawInput":null}),
        );
        assert_eq!(prompt.for_request(&json!({"toolCallId":"unrelated"})), None);
        let request = json!({"toolCallId":"original"});
        assert_eq!(prompt.for_request(&request), Some(input));
        assert_eq!(prompt.for_request(&request), None);
    }

    #[test]
    fn started_tool_context_is_unavailable_after_mutation_or_execution_evidence() {
        let start = json!({"rawInput":{"command":"fixture only"}});
        let request = json!({"toolCallId":"original"});
        for (kind, status, change) in [
            ("tool_call", Some("in_progress"), start.clone()),
            (
                "tool_call_update",
                Some("completed"),
                json!({"status":"completed"}),
            ),
            (
                "tool_call_update",
                None,
                json!({"title":"different action"}),
            ),
            (
                "tool_call_update",
                None,
                json!({"rawInput":"different fixture"}),
            ),
            (
                "tool_call_update",
                None,
                json!({"rawOutput":"fixture output"}),
            ),
            ("tool_call_update", None, json!({"content":[{}]})),
            (
                "tool_call_update",
                None,
                json!({"_meta":{"terminal_output":{}}}),
            ),
        ] {
            let mut prompt = PermissionInput::new(101);
            prompt.observe("tool_call", "original", Some("in_progress"), &start);
            prompt.observe(kind, "original", status, &change);
            assert_eq!(prompt.for_request(&request), None, "{change}");
        }

        let mut prompt = PermissionInput::new(101);
        prompt.observe(
            "tool_call",
            "original",
            Some("in_progress"),
            &json!({"rawInput":"fixture only","content":[{}]}),
        );
        assert_eq!(prompt.for_request(&request), None);

        prompt.observe("tool_call", "other", Some("in_progress"), &start);
        assert_eq!(
            prompt.for_request(&json!({"toolCallId":"other","rawOutput":"fixture output"})),
            None
        );
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
