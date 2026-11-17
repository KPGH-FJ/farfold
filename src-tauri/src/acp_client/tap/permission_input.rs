//! Content-free evidence from adjacent inbound tool and permission events.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PermissionInput {
    request_has_input: bool,
    request_status: ToolStatus,
    preceding_tool: PrecedingTool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum PrecedingTool {
    Unavailable,
    Different,
    Exact(ToolShape),
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolShape {
    update: ToolUpdate,
    status: ToolStatus,
    has_input: bool,
    has_raw_output: bool,
    has_content: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ToolUpdate {
    ToolCall,
    ToolCallUpdate,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ToolStatus {
    Omitted,
    Pending,
    InProgress,
    Completed,
    Failed,
    Other,
}

fn status(tool: &Value) -> ToolStatus {
    match tool.get("status") {
        None => ToolStatus::Omitted,
        Some(value) => match value.as_str() {
            Some("pending") => ToolStatus::Pending,
            Some("in_progress") => ToolStatus::InProgress,
            Some("completed") => ToolStatus::Completed,
            Some("failed") => ToolStatus::Failed,
            _ => ToolStatus::Other,
        },
    }
}

fn has_raw(tool: &Value, key: &str) -> bool {
    tool.get(key).is_some_and(|v| !v.is_null())
}

struct ObservedTool {
    session_id: String,
    tool_id: String,
    shape: ToolShape,
}

#[derive(Default)]
pub(in crate::acp_client) struct PermissionObservation(Option<ObservedTool>);

impl PermissionObservation {
    pub(super) fn annotate(&mut self, message: Option<&Value>, record: &mut Value) {
        let preceding = self.0.take();
        let Some(params) = message.and_then(|m| m.get("params")) else {
            return;
        };
        match record["event"].as_str() {
            Some("session/update") => self.0 = observe_tool(params),
            Some("session/request_permission") => {
                let tool = &params["toolCall"];
                let preceding_tool = match (preceding, identity(params, tool)) {
                    (Some(previous), Some((session, id))) => {
                        if session == previous.session_id && id == previous.tool_id {
                            PrecedingTool::Exact(previous.shape)
                        } else {
                            PrecedingTool::Different
                        }
                    }
                    _ => PrecedingTool::Unavailable,
                };
                let summary = PermissionInput {
                    request_has_input: has_raw(tool, "rawInput"),
                    request_status: status(tool),
                    preceding_tool,
                };
                if let Ok(summary) = serde_json::to_value(summary) {
                    record["permissionInput"] = summary;
                }
            }
            _ => {}
        }
    }
}

fn identity<'a>(params: &'a Value, tool: &'a Value) -> Option<(&'a str, &'a str)> {
    // Keep only one pair in memory and leave oversized identifiers unobserved.
    let identity = |v: Option<&'a Value>| {
        v.and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.len() <= 256)
    };
    Some((
        identity(params.get("sessionId"))?,
        identity(tool.get("toolCallId"))?,
    ))
}

fn observe_tool(params: &Value) -> Option<ObservedTool> {
    let tool = params.get("update")?;
    let update = match tool.get("sessionUpdate").and_then(Value::as_str)? {
        "tool_call" => ToolUpdate::ToolCall,
        "tool_call_update" => ToolUpdate::ToolCallUpdate,
        _ => return None,
    };
    let (session, id) = identity(params, tool)?;
    Some(ObservedTool {
        session_id: session.to_owned(),
        tool_id: id.to_owned(),
        shape: ToolShape {
            update,
            status: status(tool),
            has_input: has_raw(tool, "rawInput"),
            has_raw_output: has_raw(tool, "rawOutput"),
            has_content: tool.get("content").is_some_and(|v| {
                !v.is_null() && v.as_array().is_none_or(|items| !items.is_empty())
            }),
        },
    })
}

pub(super) fn safe_permission_input(value: &Value) -> Option<Value> {
    let summary = serde_json::from_value::<PermissionInput>(value.clone()).ok()?;
    serde_json::to_value(summary).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn permission_tap_only_records_redacted_evidence_of_the_preceding_tool() {
        let mut observation = PermissionObservation::default();
        let start = json!({"method":"session/update","params":{"sessionId":"private-session","update":{
            "sessionUpdate":"tool_call","toolCallId":"private-tool","status":"in_progress","rawInput":{"command":"private-input"}
        }}});
        let request = |session: &str| {
            json!({"method":"session/request_permission","params":{
                "sessionId":session,"toolCall":{"toolCallId":"private-tool"}
            }})
        };
        let mut inspect = |line: Value| {
            super::super::diagnostic_record_with_permission(
                &line.to_string(),
                "in",
                Some(&mut observation),
            )
        };

        inspect(start.clone());
        let exact = inspect(request("private-session"));
        let expected = json!({
            "requestHasInput":false, "requestStatus":"omitted",
            "precedingTool":{"exact":{"update":"tool_call","status":"in_progress","hasInput":true,"hasRawOutput":false,"hasContent":false}}
        });
        assert_eq!(exact["permissionInput"], expected);
        assert!(!exact.to_string().contains("private-"));
        assert_eq!(super::super::safe_record(&exact), Some(exact.clone()));

        inspect(start.clone());
        let different = inspect(request("different-session"));
        assert_eq!(different["permissionInput"]["precedingTool"], "different");

        inspect(start);
        inspect(
            json!({"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk"}}}),
        );
        let unavailable = inspect(request("private-session"));
        assert_eq!(
            unavailable["permissionInput"]["precedingTool"],
            "unavailable"
        );

        let mut unexpected = exact;
        unexpected["permissionInput"]["precedingTool"]["exact"]["status"] = json!("private-text");
        assert!(
            super::super::safe_record(&unexpected)
                .is_some_and(|r| r.get("permissionInput").is_none())
        );
    }
}
