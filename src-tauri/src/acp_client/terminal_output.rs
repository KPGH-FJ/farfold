//! Passive output from the public terminal-output extension. Never executes tools.
use serde_json::{Value, json};

pub(crate) fn output_event(params: &Value) -> Option<Value> {
    let update = params.get("update")?;
    let output = update
        .pointer("/_meta/terminal_output")
        .or_else(|| update.pointer("/_meta/terminal_output_delta"))?;
    Some(json!({
        "kind": "toolOutput",
        "toolCallId": update.get("toolCallId")?.as_str()?,
        "terminalId": output.get("terminal_id")?.as_str()?,
        "data": output.get("data")?.as_str()?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn translates_valid_output_and_ignores_unrecognized_shapes() {
        let params = json!({"update":{"toolCallId":"call","_meta":{"terminal_output":{
            "terminal_id":"terminal","data":"OUTPUT"
        }}}});
        assert_eq!(
            output_event(&params),
            Some(
                json!({"kind":"toolOutput","toolCallId":"call","terminalId":"terminal","data":"OUTPUT"})
            )
        );
        let delta = json!({"update":{"toolCallId":"call","_meta":{"terminal_output_delta":{
            "terminal_id":"terminal","data":"OUTPUT"
        }}}});
        assert_eq!(output_event(&delta), output_event(&params));
        assert!(
            output_event(
                &json!({"update":{"toolCallId":"call","_meta":{"terminal_output":{"data":12}}}})
            )
            .is_none()
        );
    }
}
