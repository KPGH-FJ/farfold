//! Process-local proof for one first permission that the client cancelled.
use serde_json::Value;

#[derive(Default)]
enum Phase {
    #[default]
    Invalid,
    AwaitingTool,
    Pending {
        tool: String,
        request: Option<String>,
    },
    CancelSent(String),
    Stopped(String),
}

#[derive(Default)]
pub(super) struct Proof {
    receipt: u64,
    phase: Phase,
}

pub(super) fn reports_output_extension(update: &Value) -> bool {
    update.pointer("/_meta/terminal_output").is_some()
        || update.pointer("/_meta/terminal_output_delta").is_some()
        || update
            .pointer("/_meta/toolNotification/type")
            .and_then(Value::as_str)
            == Some("live_output")
}

fn reports_execution_metadata(update: &Value) -> bool {
    update.get("rawOutput").is_some_and(|v| !v.is_null()) || reports_output_extension(update)
}

fn reports_output(update: &Value) -> bool {
    reports_execution_metadata(update)
        || update
            .get("content")
            .is_some_and(|v| !v.is_null() && v.as_array().is_none_or(|items| !items.is_empty()))
}

fn permission_explanation_only(call: &Value) -> bool {
    // An exact first request can include explanatory text. This exception
    // applies only to the permission envelope, never a tool update.
    !reports_execution_metadata(call)
        && call.get("content").is_none_or(|v| {
            v.is_null()
                || v.as_array().is_some_and(|items| {
                    items.iter().all(|item| {
                        item.as_object().is_some_and(|fields| fields.len() == 2)
                            && item["type"] == "content"
                            && item["content"]
                                .as_object()
                                .is_some_and(|fields| fields.len() == 2)
                            && item["content"]["type"] == "text"
                            && item["content"]["text"].is_string()
                    })
                })
        })
}

impl Proof {
    pub(super) fn start(&mut self, receipt: u64, clean: bool) {
        self.receipt = receipt;
        self.phase = if clean {
            Phase::AwaitingTool
        } else {
            Phase::Invalid
        };
    }

    pub(super) fn invalidate(&mut self) {
        self.phase = Phase::Invalid;
    }

    pub(super) fn config_changed(&mut self) {
        // Initial declarations can arrive ahead of the first tool. Once a
        // candidate exists, any later configuration activity invalidates it.
        if !matches!(self.phase, Phase::AwaitingTool) {
            self.invalidate();
        }
    }

    pub(super) fn tool(&mut self, kind: &str, id: &str, status: Option<&str>, update: &Value) {
        let no_output = !reports_output(update);
        let pending_update = kind == "tool_call_update"
            && (status == Some("pending") || update.get("status").is_none())
            && no_output;
        match &self.phase {
            Phase::AwaitingTool
                if kind == "tool_call" && status == Some("pending") && no_output =>
            {
                self.phase = Phase::Pending {
                    tool: id.to_owned(),
                    request: None,
                };
            }
            Phase::Pending { tool, .. } | Phase::CancelSent(tool) | Phase::Stopped(tool)
                if id == tool && pending_update => {}
            _ => self.invalidate(),
        }
    }

    pub(super) fn permission(&mut self, request_id: &str, call: &Value) {
        if let Phase::Pending { tool, request } = &mut self.phase
            && request.is_none()
            && call.get("toolCallId").and_then(Value::as_str) == Some(tool.as_str())
            && call.get("status").is_none_or(|v| v == "pending")
            && permission_explanation_only(call)
        {
            *request = Some(request_id.to_owned());
        } else {
            // A second request is disqualifying even if its earlier reply
            // already left the shared permission table.
            self.invalidate();
        }
    }

    pub(super) fn permission_id(&self) -> Option<&str> {
        match &self.phase {
            Phase::Pending { request, .. } => request.as_deref(),
            _ => None,
        }
    }

    pub(super) fn cancelled_permission(&mut self, confirmed: bool) {
        let phase = std::mem::take(&mut self.phase);
        if confirmed
            && let Phase::Pending {
                tool,
                request: Some(_),
            } = phase
        {
            self.phase = Phase::CancelSent(tool);
        }
    }

    pub(super) fn finish(&mut self, receipt: u64, cancelled: bool) {
        let phase = std::mem::take(&mut self.phase);
        if cancelled
            && self.receipt == receipt
            && let Phase::CancelSent(tool) = phase
        {
            self.phase = Phase::Stopped(tool);
        }
    }

    pub(super) fn stopped(&self) -> Option<(&str, u64)> {
        match &self.phase {
            Phase::Stopped(tool) => Some((tool, self.receipt)),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pending() -> Proof {
        let mut proof = Proof::default();
        proof.start(12, true);
        proof.tool("tool_call", "exact", Some("pending"), &json!({}));
        proof
    }

    #[test]
    fn stopped_tool_close_accepts_only_plain_approval_explanation() {
        let plain =
            json!([{"type":"content","content":{"type":"text","text":"Review this action"}}]);
        let mut proof = pending();
        proof.permission(
            "permission",
            &json!({"toolCallId":"exact","status":"pending","content":plain}),
        );
        assert_eq!(proof.permission_id(), Some("permission"));
        proof.cancelled_permission(true);
        proof.finish(12, true);
        assert_eq!(proof.stopped(), Some(("exact", 12)));

        for output in [
            json!([{"type":"terminal","terminalId":"active"}]),
            json!([{"type":"diff","path":"/tmp/owned","newText":"modified"}]),
            json!([{"type":"content","content":{"type":"image","data":"xx","mimeType":"image/png"}}]),
        ] {
            let mut proof = pending();
            proof.permission(
                "permission",
                &json!({"toolCallId":"exact","content":output}),
            );
            assert!(proof.permission_id().is_none());
        }
    }

    #[test]
    fn stopped_tool_close_rejects_any_reported_execution_output_or_configuration_change() {
        for output in [
            json!({"rawOutput":"already executed"}),
            json!({"_meta":{"terminal_output":{"terminal_id":"active","data":"progress"}}}),
            json!({"_meta":{"terminal_output_delta":{"terminal_id":"active","data":"progress"}}}),
            json!({"_meta":{"toolNotification":{"type":"live_output","params":{}}}}),
            json!({"content":[{"type":"content","content":{"type":"text","text":"started"}}]}),
        ] {
            let mut proof = pending();
            proof.permission("permission", &json!({"toolCallId":"exact"}));
            proof.cancelled_permission(true);
            proof.tool("tool_call_update", "exact", None, &output);
            proof.finish(12, true);
            assert!(proof.stopped().is_none());
        }
        let mut proof = pending();
        proof.permission("permission", &json!({"toolCallId":"exact"}));
        proof.cancelled_permission(true);
        proof.finish(12, true);
        proof.config_changed();
        assert!(proof.stopped().is_none());
    }
}
