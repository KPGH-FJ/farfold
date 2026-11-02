//! Passive input-format declarations for official file tools lacking ACP diffs.
//! https://github.com/aaif-goose/goose/blob/v1.52.0/crates/goose/src/acp/server/tool_calls/conversion.rs
//! https://github.com/aaif-goose/goose/blob/v1.52.0/crates/goose/src/agents/platform_extensions/developer/edit.rs
//! Preserve the original envelope first; only send field names, never a second
//! input body or a claim that the proposed edit was executed successfully.
use serde_json::{Value, json};

pub(super) fn input_event(params: &Value) -> Option<Value> {
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
    let meta = update.pointer("/_meta/goose")?.get("toolCall")?;
    let fields = format_fields(update, meta).unwrap_or(Value::Null);
    Some(json!({"kind":"toolFileInput","source":"reported","toolCallId":id,"fields":fields}))
}

fn format_fields(update: &Value, meta: &Value) -> Option<Value> {
    if let Some(kind) = update.get("kind").filter(|kind| !kind.is_null())
        && !matches!(kind.as_str()?, "other" | "edit")
    {
        return None;
    }
    if meta.get("extensionName")?.as_str()? != "developer" {
        return None;
    }
    let (operation, old_key, new_key) = match meta.get("toolName")?.as_str()? {
        "edit" | "developer__edit" => ("edit", Some("before"), "after"),
        "write" | "developer__write" => ("write", None, "content"),
        _ => return None,
    };
    if let Some(input) = update.get("rawInput").filter(|input| !input.is_null()) {
        input
            .get("path")?
            .as_str()
            .filter(|path| !path.is_empty())?;
        input.get(new_key)?.as_str()?;
        if let Some(key) = old_key {
            input.get(key)?.as_str()?;
        }
    }
    let mut fields = json!({"operation":operation,"path":"path","newText":new_key});
    if let Some(key) = old_key {
        fields["oldText"] = json!(key);
    }
    Some(fields)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(name: &str) -> Value {
        json!({"update":{"sessionUpdate":"tool_call","toolCallId":"owned",
            "rawInput":{"path":"/work/proof.txt","before":"ALPHA","after":"","content":"WRITE"},
            "_meta":{"goose":{"toolCall":{"toolName":name,"extensionName":"developer"}}}}})
    }

    #[test]
    fn declares_official_edit_and_write_formats_without_copying_or_mutating_input() {
        for name in ["edit", "developer__edit", "write", "developer__write"] {
            let params = sample(name);
            let before = params.clone();
            let event = input_event(&params).unwrap();
            assert_eq!(params, before);
            assert_eq!(event["toolCallId"], "owned");
            assert!(event.get("rawInput").is_none());
            assert!(event.get("status").is_none());
            let is_edit = name.ends_with("edit");
            assert_eq!(
                event["fields"]["operation"],
                if is_edit { "edit" } else { "write" }
            );
            assert_eq!(
                event["fields"]["newText"],
                if is_edit { "after" } else { "content" }
            );
            assert_eq!(
                event["fields"].get("oldText"),
                is_edit.then(|| json!("before")).as_ref()
            );
        }
    }

    #[test]
    fn rejects_unknown_ownership_kinds_and_malformed_inputs_without_guessing_from_title() {
        for (path, value) in [
            ("/update/_meta/goose/toolCall/toolName", json!("read")),
            (
                "/update/_meta/goose/toolCall/toolName",
                json!("other__edit"),
            ),
            ("/update/_meta/goose/toolCall/extensionName", json!("other")),
            ("/update/_meta/goose/toolCall", Value::Null),
            ("/update/rawInput/path", json!(123)),
            ("/update/rawInput/after", json!(false)),
            ("/update/rawInput/before", Value::Null),
        ] {
            let mut params = sample("edit");
            *params.pointer_mut(path).unwrap() = value;
            assert_eq!(
                input_event(&params).unwrap()["fields"],
                Value::Null,
                "accepted {path}"
            );
        }
        let mut params = sample("edit");
        params["update"]["kind"] = json!("read");
        assert_eq!(input_event(&params).unwrap()["fields"], Value::Null);
        for path in ["/update/toolCallId", "/update/sessionUpdate"] {
            let mut params = sample("edit");
            *params.pointer_mut(path).unwrap() = Value::Null;
            assert!(input_event(&params).is_none());
        }
        let mut params = sample("edit");
        params["update"].as_object_mut().unwrap().remove("_meta");
        params["update"]["title"] = json!("edit developer /work/proof.txt");
        assert!(input_event(&params).is_none());
    }
}
