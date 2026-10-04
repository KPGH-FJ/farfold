//! Narrow stdio MCP surface: one fixed-scope, read-only tool. No logging.
use serde_json::{Value, json};

pub(super) enum Action {
    None,
    Reply { value: Value, list: bool },
    Read { id: Value },
    Cancel { id: Value },
}
#[derive(Default)]
pub(super) struct Protocol {
    initialized: bool,
    notified: bool,
    listed: bool,
}
impl Protocol {
    pub(super) fn mark_list_delivered(&mut self) -> bool {
        let first = !self.listed && self.notified;
        self.listed = true;
        first
    }
    pub(super) fn receive(&mut self, request: Value) -> Action {
        let Some(object) = request.as_object() else {
            return reply(error(Value::Null, -32600, "Invalid request"));
        };
        let id = request.get("id").cloned();
        if request.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
            || id.as_ref().is_some_and(|id| {
                !(id.is_string() || id.as_i64().is_some() || id.as_u64().is_some())
                    || id.as_str().is_some_and(|text| text.len() > 128)
            })
        {
            return reply(error(Value::Null, -32600, "Invalid request"));
        }
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        if id.is_none() {
            if method == "notifications/cancelled"
                && self.notified
                && let Some(id) = request
                    .get("params")
                    .and_then(|p| p.get("requestId"))
                    .filter(|id| id.is_string() || id.as_i64().is_some() || id.as_u64().is_some())
            {
                return Action::Cancel { id: id.clone() };
            }
            if method == "notifications/initialized" && self.initialized {
                self.notified = true;
            }
            return Action::None;
        }
        let id = id.unwrap_or(Value::Null);
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
        if !params.is_object() || object.len() > 4 {
            return reply(error(id, -32602, "Invalid parameters"));
        }
        match method {
            "initialize" if !self.initialized => {
                if params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .is_none()
                    || !params.get("capabilities").is_some_and(Value::is_object)
                    || !params.get("clientInfo").is_some_and(Value::is_object)
                {
                    return reply(error(id, -32602, "Invalid initialization"));
                }
                self.initialized = true;
                reply(result(
                    id,
                    json!({
                        "protocolVersion":"2025-06-18", "capabilities":{"tools":{}},
                        "serverInfo":{"name":"farfold-public-page","version":"0.1.0"}
                    }),
                ))
            }
            "ping" => reply(result(id, json!({}))),
            _ if !self.notified => reply(error(id, -32002, "Initialization required")),
            "tools/list" => Action::Reply {
                value: result(
                    id,
                    json!({"tools":[{
                        "name":"read_page_snapshot", "description":"读取当前对话中打开的公开网页；如尚未允许，将等待用户在对话中确认。跳转、关闭或停止共享后需重新允许。",
                        "inputSchema":{"type":"object","properties":{},"additionalProperties":false},
                        "annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true}
                    }]}),
                ),
                list: true,
            },
            "tools/call" => {
                if params.get("name").and_then(Value::as_str) != Some("read_page_snapshot")
                    || params
                        .get("arguments")
                        .is_some_and(|arguments| arguments != &json!({}))
                    || params.get("_meta").is_some_and(|meta| !meta.is_object())
                    || params.as_object().is_none_or(|value| {
                        value
                            .keys()
                            .any(|key| !matches!(key.as_str(), "name" | "arguments" | "_meta"))
                    })
                {
                    return reply(error(id, -32602, "Unknown tool or invalid parameters"));
                }
                if !self.listed {
                    return reply(tool_error(id, "网页工具尚未准备完成"));
                }
                Action::Read { id }
            }
            _ => reply(error(id, -32601, "Method not found")),
        }
    }
}
fn reply(value: Value) -> Action {
    Action::Reply { value, list: false }
}
pub(super) fn result(id: Value, value: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":value})
}
pub(super) fn error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
pub(super) fn tool_error(id: Value, message: &str) -> Value {
    result(
        id,
        json!({"content":[{"type":"text","text":message}],"isError":true}),
    )
}
pub(super) fn snapshot(id: Value, page: Value) -> Value {
    result(
        id,
        json!({"content":[{"type":"text","text":page.to_string()}],"structuredContent":page,"isError":false}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(method: &str, params: Value) -> Value {
        json!({"jsonrpc":"2.0","id":7,"method":method,"params":params})
    }
    fn ready() -> Protocol {
        let mut protocol = Protocol::default();
        let _ = protocol.receive(request("initialize", json!({"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"controlled","version":"0"}})));
        let _ = protocol.receive(json!({"jsonrpc":"2.0","method":"notifications/initialized"}));
        protocol
    }
    #[test]
    fn cancellation_uses_only_exact_request_id_and_never_echoes_reason() {
        let mut protocol = ready();
        let Action::Cancel { id } = protocol.receive(json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":42,"reason":"CANARY"}})) else { panic!("missing cancellation"); };
        assert_eq!(id, 42);
        assert!(matches!(protocol.receive(json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":{}}})), Action::None));
    }
    #[test]
    fn read_requires_handshake_and_actual_list_delivery() {
        let call = request(
            "tools/call",
            json!({"name":"read_page_snapshot","arguments":{}}),
        );
        assert!(matches!(
            Protocol::default().receive(call.clone()),
            Action::Reply { .. }
        ));
        let mut protocol = ready();
        assert!(matches!(
            protocol.receive(call.clone()),
            Action::Reply { .. }
        ));
        assert!(matches!(
            protocol.receive(request("tools/list", json!({}))),
            Action::Reply { list: true, .. }
        ));
        assert!(matches!(
            protocol.receive(call.clone()),
            Action::Reply { .. }
        ));
        assert!(protocol.mark_list_delivered());
        assert!(!protocol.mark_list_delivered());
        assert!(matches!(protocol.receive(call), Action::Read { .. }));
    }
    #[test]
    fn standard_optional_arguments_and_progress_metadata_are_accepted_without_echo() {
        let mut protocol = ready();
        protocol.mark_list_delivered();
        for params in [
            json!({"name":"read_page_snapshot"}),
            json!({"name":"read_page_snapshot","arguments":{},"_meta":{"progressToken":"CANARY_IGNORED","custom":"CANARY_IGNORED"}}),
        ] {
            let Action::Read { id } = protocol.receive(request("tools/call", params)) else {
                panic!("standard call rejected");
            };
            assert_eq!(id, 7);
        }
        for params in [
            json!({"name":"read_page_snapshot","arguments":null}),
            json!({"name":"read_page_snapshot","arguments":{},"_meta":"invalid"}),
            json!({"name":"read_page_snapshot","other":true}),
        ] {
            assert!(matches!(
                protocol.receive(request("tools/call", params)),
                Action::Reply { .. }
            ));
        }
    }
    #[test]
    fn tool_cannot_choose_task_page_url_or_javascript() {
        let mut protocol = ready();
        protocol.mark_list_delivered();
        for arguments in [
            json!({"taskKey":"another"}),
            json!({"label":"other"}),
            json!({"url":"https://example.com/"}),
            json!({"script":"CANARY_NEVER_ECHO"}),
        ] {
            let action = protocol.receive(request(
                "tools/call",
                json!({"name":"read_page_snapshot","arguments":arguments}),
            ));
            let Action::Reply { value, .. } = action else {
                panic!("unexpected read");
            };
            assert_eq!(value["error"]["code"], -32602);
            assert!(!value.to_string().contains("CANARY_NEVER_ECHO"));
        }
    }
    #[test]
    fn tool_discovery_contains_only_one_readonly_tool() {
        let mut protocol = ready();
        let Action::Reply { value, list } = protocol.receive(request("tools/list", json!({})))
        else {
            panic!("missing list");
        };
        assert!(list);
        let tools = value["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "read_page_snapshot");
        assert_eq!(tools[0]["annotations"]["readOnlyHint"], true);
        assert_eq!(tools[0]["inputSchema"]["additionalProperties"], false);
    }
    #[test]
    fn caller_input_not_reflected_in_protocol_errors() {
        let mut protocol = ready();
        for message in [
            request("CANARY_UNKNOWN_METHOD", json!({})),
            request(
                "tools/call",
                json!({"name":"CANARY_UNKNOWN_TOOL","arguments":{}}),
            ),
            json!({"jsonrpc":"2.0","id":{},"method":"CANARY_INVALID_ID"}),
        ] {
            let Action::Reply { value, .. } = protocol.receive(message) else {
                panic!("expected error");
            };
            assert!(value.get("error").is_some());
            assert!(!value.to_string().contains("CANARY"));
        }
    }
}
