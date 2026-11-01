//! Passive translation of the official tool-notification output extension.
//! https://github.com/aaif-goose/goose/blob/main/crates/goose/src/acp/server/tool_notifications.rs
//! The raw envelope is still delivered first. No tool execution or status inference.
use serde_json::{Value, json};

pub(super) fn output_event(params: &Value) -> Option<Value> {
    let update = params.get("update")?;
    if !matches!(
        update.get("sessionUpdate")?.as_str()?,
        "tool_call" | "tool_call_update"
    ) {
        return None;
    }
    let id = update
        .get("toolCallId")?
        .as_str()
        .filter(|id| !id.is_empty())?;
    let notification = update.pointer("/_meta/toolNotification")?;
    if notification.get("type")?.as_str()? != "live_output" {
        return None;
    }
    let output = notification.get("params")?;
    // The shared view uses JavaScript integers; do not round an opaque receipt.
    let sequence = output.get("sequence")?.as_u64()?;
    if sequence == 0 || sequence > 9_007_199_254_740_991 {
        return None;
    }
    let truncated = output.get("truncated")?.as_bool()?;
    let mut data = String::new();
    for chunk in output.get("chunks")?.as_array()? {
        if !matches!(chunk.get("stream")?.as_str()?, "stdout" | "stderr") {
            return None;
        }
        data.push_str(chunk.get("output")?.as_str()?);
    }
    Some(json!({
        "kind":"toolOutput", "source":"reported", "toolCallId":id,
        "data":data, "sequence":sequence, "truncated":truncated
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Value {
        json!({"update":{"sessionUpdate":"tool_call_update","toolCallId":"owned",
        "_meta":{"toolNotification":{"type":"live_output","params":{
            "sequence":1,"chunks":[{"stream":"stdout","output":"READY\n"}],"truncated":false
        }}}}})
    }

    #[test]
    fn rejects_unknown_or_malformed_shapes_without_guessing() {
        for (path, value) in [
            ("/update/sessionUpdate", json!("future")),
            ("/update/toolCallId", json!("")),
            ("/update/_meta/toolNotification/type", json!("message")),
            ("/update/_meta/toolNotification/params/sequence", json!(0)),
            ("/update/_meta/toolNotification/params/sequence", json!(1.5)),
            ("/update/_meta/toolNotification/params/sequence", json!("1")),
            (
                "/update/_meta/toolNotification/params/sequence",
                json!(9_007_199_254_740_992_u64),
            ),
            (
                "/update/_meta/toolNotification/params/truncated",
                json!("false"),
            ),
            (
                "/update/_meta/toolNotification/params/chunks/0/stream",
                json!("future"),
            ),
            (
                "/update/_meta/toolNotification/params/chunks/0/output",
                json!({"text":"NO"}),
            ),
        ] {
            let mut params = sample();
            *params.pointer_mut(path).unwrap() = value;
            assert!(output_event(&params).is_none(), "accepted {path}");
        }
    }

    #[test]
    fn preserves_the_empty_truncation_receipt_and_source_values() {
        let mut params = sample();
        params["update"]["_meta"]["toolNotification"]["params"] =
            json!({"sequence":2,"chunks":[],"truncated":true});
        let before = params.clone();
        assert_eq!(
            output_event(&params),
            Some(json!({
                "kind":"toolOutput","source":"reported","toolCallId":"owned",
                "data":"","sequence":2,"truncated":true
            }))
        );
        assert_eq!(params, before);
    }
}
