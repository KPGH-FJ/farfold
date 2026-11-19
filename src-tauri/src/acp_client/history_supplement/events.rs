use super::{ParsedHistory, Reason};
use serde_json::{Value, json};
pub(crate) fn reserved_kind(value: &Value) -> bool {
    matches!(
        value.get("kind").and_then(Value::as_str),
        Some("historyToolSupplement" | "historyToolSupplementStatus")
    )
}
pub(in crate::acp_client) fn event(
    result: Result<ParsedHistory, Reason>,
    token: &str,
    connection: &str,
    sid: &str,
    cwd: &str,
) -> Value {
    let mut value = json!({"kind":"historyToolSupplementStatus","openToken":token,"connectionId":connection,"sessionId":sid,"cwd":cwd});
    match result {
        Ok(history) => {
            value["kind"] = "historyToolSupplement".into();
            value["anchors"] = serde_json::to_value(history.anchors).expect("serializable anchors");
            value["tools"] = serde_json::to_value(history.tools).expect("serializable tools");
            if let Some(configuration) = history.historical_configuration {
                value["historicalConfiguration"] = serde_json::to_value(configuration)
                    .expect("serializable historical configuration");
            }
        }
        Err(reason) => value["reason"] = serde_json::to_value(reason).expect("static reason"),
    }
    value
}
