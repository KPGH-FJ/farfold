//! Fixed-page MCP tools. Arguments never supply a new page or script. No logging.
use crate::browser_workspace::ToolRequest;
use serde_json::{Value, json};

pub(super) enum Action {
    None,
    Reply { value: Value, list: bool },
    Read { id: Value, request: ToolRequest },
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
                value: result(id, tool_list()),
                list: true,
            },
            "tools/call" => {
                let Some(request) = parse_tool(&params) else {
                    return reply(error(id, -32602, "Unknown tool or invalid parameters"));
                };
                if !self.listed {
                    return reply(tool_error(id, "网页工具尚未准备完成"));
                }
                // Pixels are unavailable. Reject before page admission rather
                // than asking permission for an operation we cannot deliver.
                if matches!(request, ToolRequest::Observe { screenshot: true }) {
                    return reply(tool_error(
                        id,
                        "当前版本暂不提供网页截图。若需要网页文字和可操作位置，请单独使用 screenshot=false 重新请求观察。",
                    ));
                }
                Action::Read { id, request }
            }
            _ => reply(error(id, -32601, "Method not found")),
        }
    }
}
fn tool_list() -> Value {
    let empty = json!({"type":"object","properties":{},"additionalProperties":false});
    let target = json!({"observationId":{"type":"string","minLength":1,"maxLength":128},"nodeRef":{"type":"string","minLength":1,"maxLength":128}});
    let mut input_target = target.clone();
    input_target["text"] = json!({"type":"string","maxLength":4096});
    json!({"tools":[
        {"name":"read_page_snapshot","description":"读取此对话当前页面的标题、地址和文字，未允许时等待用户确认。关闭、跳转或停止共享后失效。","inputSchema":empty,"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true}},
        {"name":"observe_page","description":"观察当前页面的可见文字和可操作位置。当前版本不提供页面截图，screenshot=true直接返回不可用且不读取网页或请求许可。需要文字和位置时，请单独使用screenshot=false重新请求。位置30秒内有效，每次操作后重新观察。","inputSchema":{"type":"object","properties":{"screenshot":{"type":"boolean","default":false,"description":"当前请使用false读取文字和位置；true仅返回截图不可用，不读取网页或请求许可。"}},"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true}},
        {"name":"click_page_node","description":"申请点击最近观察得到的位置，等待用户确认。本次许可仅用一次；结果未知时先重新观察，不自动重复。","inputSchema":{"type":"object","properties":target,"required":["observationId","nodeRef"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true,"idempotentHint":false,"openWorldHint":true}},
        {"name":"input_page_node","description":"申请把文字填入最近观察得到的普通输入位置，用户确认具体内容后仅执行一次。不提交表单；密码、账号和验证码输入受保护。verification=matched仅表示回复时同一普通字段与本次获准文字一致，mismatched表示不一致，unverified或缺失表示无法安全核实；不返回字段值，observe_page也不读取字段值。dispatched只表示事件已交付，不表示网站操作成功。结果未知时不要自动重试。","inputSchema":{"type":"object","properties":input_target,"required":["observationId","nodeRef","text"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true,"idempotentHint":false,"openWorldHint":true}}
    ]})
}
fn parse_tool(params: &Value) -> Option<ToolRequest> {
    let params = params.as_object()?;
    if params
        .keys()
        .any(|key| !matches!(key.as_str(), "name" | "arguments" | "_meta"))
        || params.get("_meta").is_some_and(|v| !v.is_object())
    {
        return None;
    }
    let empty = json!({});
    let arguments = params.get("arguments").unwrap_or(&empty).as_object()?;
    let name = params.get("name")?.as_str()?;
    let token = |key: &str| {
        arguments
            .get(key)?
            .as_str()
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 128
                    && s.bytes()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
            })
            .map(str::to_owned)
    };
    match name {
        "read_page_snapshot" if arguments.is_empty() => Some(ToolRequest::Read),
        "observe_page" if arguments.keys().all(|key| key == "screenshot") => {
            Some(ToolRequest::Observe {
                screenshot: match arguments.get("screenshot") {
                    None => false,
                    Some(v) => v.as_bool()?,
                },
            })
        }
        "click_page_node" if arguments.len() == 2 => Some(ToolRequest::Click {
            observation_id: token("observationId")?,
            node_ref: token("nodeRef")?,
        }),
        "input_page_node" if arguments.len() == 3 => {
            let text = arguments
                .get("text")?
                .as_str()
                .filter(|s| s.len() <= 8192 && s.chars().count() <= 4096 && !s.contains('\0'))?
                .to_owned();
            Some(ToolRequest::Input {
                observation_id: token("observationId")?,
                node_ref: token("nodeRef")?,
                text,
            })
        }
        _ => None,
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
/// A fixed local check proved no action was started. No page or target data is
/// attached, so this status can be delivered without a page grant.
pub(super) fn control_not_applied(id: Value, reason: &str) -> Value {
    result(
        id,
        json!({
            "content":[{"type":"text","text":reason}],
            "structuredContent":{"outcome":"rejected","applied":false},
            "isError":true
        }),
    )
}
/// Status only: safe to deliver after page authority is withdrawn. Never copy
/// page-owned data or entered text into an interrupted control receipt.
pub(super) fn control_unknown(id: Value) -> Value {
    result(
        id,
        json!({
            "content":[{"type":"text","text":"网页操作结果未确认，请重新观察；不要自动重试"}],
            "structuredContent":{"outcome":"unknown","applied":null},
            "isError":true
        }),
    )
}
pub(super) fn snapshot(id: Value, mut page: Value) -> Value {
    let image = page
        .get_mut("screenshot")
        .and_then(Value::as_object_mut)
        .and_then(|s| s.remove("data"))
        .and_then(|v| v.as_str().map(str::to_owned));
    let mut content = vec![json!({"type":"text","text":page.to_string()})];
    if let Some(data) = image {
        content.push(json!({"type":"image","mimeType":"image/png","data":data}));
    }
    result(
        id,
        json!({"content":content,"structuredContent":page,"isError":false}),
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
    fn p27_screenshot_unavailable_is_a_reply_after_handshake_and_list_delivery() {
        let mut protocol = ready();
        let Action::Reply { value, list } = protocol.receive(request("tools/list", json!({})))
        else {
            panic!("tool list should be delivered before calls");
        };
        assert!(list);
        assert!(protocol.mark_list_delivered());
        for id in [json!(42), json!("screenshot-repeat")] {
            let Action::Reply { value, list } = protocol.receive(json!({
                "jsonrpc":"2.0", "id":id, "method":"tools/call",
                "params":{"name":"observe_page","arguments":{"screenshot":true},
                    "_meta":{"progressToken":"CANARY_NOT_ECHOED"}}
            })) else {
                // Only Action::Read enters Worker page/permission admission.
                panic!("unavailable screenshots must never request page admission");
            };
            assert!(!list);
            assert_eq!(
                value,
                json!({
                    "jsonrpc":"2.0", "id":id,
                    "result":{"isError":true,"content":[{"type":"text",
                        "text":"当前版本暂不提供网页截图。若需要网页文字和可操作位置，请单独使用 screenshot=false 重新请求观察。"}]}
                })
            );
        }
        let observe = &value["result"]["tools"][1];
        assert_eq!(observe["name"], "observe_page");
        assert!(
            observe["description"]
                .as_str()
                .unwrap()
                .contains("screenshot=false")
        );
        assert!(
            observe["inputSchema"]["properties"]["screenshot"]["description"]
                .as_str()
                .unwrap()
                .contains("不读取网页或请求许可")
        );
        assert_eq!(observe["annotations"]["readOnlyHint"], true);
    }
    #[test]
    fn p27_unavailable_screenshot_preserves_text_observation_and_control_admission() {
        let mut protocol = ready();
        assert!(matches!(
            protocol.receive(request("tools/list", json!({}))),
            Action::Reply { list: true, .. }
        ));
        assert!(protocol.mark_list_delivered());
        for (params, control) in [
            (json!({"name":"read_page_snapshot"}), false),
            (json!({"name":"observe_page"}), false),
            (
                json!({"name":"observe_page","arguments":{"screenshot":false}}),
                false,
            ),
            (
                json!({"name":"click_page_node","arguments":{"observationId":"o","nodeRef":"n"}}),
                true,
            ),
            (
                json!({"name":"input_page_node","arguments":{"observationId":"o","nodeRef":"n","text":"public"}}),
                true,
            ),
        ] {
            let Action::Read { id, request } = protocol.receive(request("tools/call", params))
            else {
                panic!("existing text/control requests must retain admission");
            };
            assert_eq!(id, 7);
            assert_eq!(request.control(), control);
            if let ToolRequest::Observe { screenshot } = request {
                assert!(!screenshot);
            }
        }
    }
    #[test]
    fn standard_optional_arguments_and_progress_metadata_are_accepted_without_echo() {
        let mut protocol = ready();
        protocol.mark_list_delivered();
        for params in [
            json!({"name":"read_page_snapshot"}),
            json!({"name":"read_page_snapshot","arguments":{},"_meta":{"progressToken":"CANARY_IGNORED","custom":"CANARY_IGNORED"}}),
        ] {
            let Action::Read { id, .. } = protocol.receive(request("tools/call", params)) else {
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
    fn discovery_separates_observation_from_effectful_tools() {
        let mut protocol = ready();
        let Action::Reply { value, list } = protocol.receive(request("tools/list", json!({})))
        else {
            panic!("missing list");
        };
        assert!(list);
        let tools = value["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 4);
        assert_eq!(tools[2]["annotations"]["readOnlyHint"], false);
        assert_eq!(tools[3]["annotations"]["idempotentHint"], false);
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

#[cfg(test)]
mod control_tests {
    use super::*;
    #[test]
    fn fixed_tools_reject_scripts_selectors_extra_targets_and_invalid_text() {
        for arguments in [
            json!({"observationId":"a","nodeRef":"n","selector":"#a"}),
            json!({"observationId":"a","nodeRef":"n","text":"x","url":"https://other.test"}),
            json!({"observationId":"a","nodeRef":"n","text":null}),
        ] {
            assert!(parse_tool(&json!({"name":"input_page_node","arguments":arguments})).is_none());
        }
        assert!(
            parse_tool(
                &json!({"name":"click_page_node","arguments":{"observationId":"a","nodeRef":"n"}})
            )
            .unwrap()
            .control()
        );
        assert!(
            !parse_tool(&json!({"name":"observe_page","arguments":{"screenshot":true}}))
                .unwrap()
                .control()
        );
        assert!(
            !parse_tool(&json!({"name":"observe_page"}))
                .unwrap()
                .control()
        );
    }
    #[test]
    fn screenshot_bytes_are_image_content_and_never_repeated_in_text() {
        let response = snapshot(
            json!(1),
            json!({"screenshot":{"status":"captured","mimeType":"image/png","data":"CANARY_PNG"},"text":"visible"}),
        );
        assert_eq!(response["result"]["content"][1]["type"], "image");
        assert_eq!(response["result"]["content"][1]["data"], "CANARY_PNG");
        assert!(
            !response["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("CANARY_PNG")
        );
        assert!(
            response["result"]["structuredContent"]["screenshot"]
                .get("data")
                .is_none()
        );
    }
}
