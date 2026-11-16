//! Existing read-only session listing, extracted to keep the pump bounded.
use super::{Agent, ConnectionTo, Path, UntypedMessage, Value};
use agent_client_protocol::{Error, schema::v1::ErrorCode};

const LIST_UNAVAILABLE: &str = "Agent 未返回有效的对话列表，请重试";

/// `session/list` over the live connection: raw response, cursor pagination
/// unrolled into a single array. Call only when the agent advertises the
/// capability.
pub(crate) async fn list_sessions_on_connection(
    cx: &ConnectionTo<Agent>,
    cwd: Option<&Path>,
    initial_cursor: Option<&str>,
    all_pages: bool,
) -> Result<Value, String> {
    // Only the protocol's typed authentication failure reaches the preparation flow.
    let list_error = |error: Error| match error.code {
        ErrorCode::AuthRequired => "AUTH_REQUIRED".to_string(),
        _ => LIST_UNAVAILABLE.to_string(),
    };
    let mut sessions: Vec<Value> = Vec::new();
    let mut cursor = initial_cursor.map(str::to_string);
    let mut seen = std::collections::HashSet::new();
    loop {
        let mut params = serde_json::json!({});
        if let Some(cwd) = cwd {
            params["cwd"] = serde_json::json!(cwd);
        }
        if let Some(cursor) = &cursor {
            if !seen.insert(cursor.clone()) {
                return Err("Agent 返回了重复的翻页结果，请重新查找".into());
            }
            params["cursor"] = Value::String(cursor.clone());
        }
        let request = UntypedMessage::new("session/list", &params).map_err(list_error)?;
        let response = cx
            .send_request_to(Agent, request)
            .block_task()
            .await
            .map_err(list_error)?;
        let list = response
            .get("sessions")
            .and_then(Value::as_array)
            .ok_or(LIST_UNAVAILABLE)?;
        if !all_pages {
            return Ok(response);
        }
        sessions.extend(list.iter().cloned());
        match response.get("nextCursor").and_then(Value::as_str) {
            Some(next) if !next.is_empty() => {
                if sessions.len() >= 10_000 || seen.len() >= 100 {
                    return Err("对话较多，请使用带入已有对话逐页查看".into());
                }
                cursor = Some(next.to_string());
            }
            _ => return Ok(Value::Array(sessions)),
        }
    }
}
