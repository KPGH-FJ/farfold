use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(crate) const PI_ACP_ADAPTER_ID: &str = "pi-acp-stdio-v1";

pub(crate) fn before_route(
    registry: Option<&crate::interaction_registry::InteractionRegistry>,
    transport: &crate::acp_transport::AcpTransport,
    binding: &crate::runtime_registry::RuntimeBinding,
    generation: u64,
    envelope: &Value,
) -> Result<(), String> {
    if !matches!(
        envelope["method"].as_str(),
        Some("elicitation/create" | "_pi/ui_withdrawn")
    ) {
        return Ok(());
    }
    let registry = registry.ok_or("Pi ACP interaction registry is unavailable")?;
    if !registry.is_current_connection(binding, generation)? {
        return Ok(());
    }
    if envelope["method"] == "elicitation/create" {
        PiAcpDialog::parse(envelope)?;
    } else {
        let withdrawal = PiAcpWithdrawal::parse(envelope)?;
        if let Some(dialog) = registry.pi_acp_dialog_by_native_id(
            binding,
            generation,
            withdrawal.native_session_id,
            withdrawal.native_request_id,
        )? {
            transport
                .withdraw_form_request(&dialog.request_key, &dialog.native_session_id)
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PiAcpDialog {
    pub(crate) request_key: String,
    pub(crate) native_request_id: String,
    pub(crate) native_session_id: String,
    pub(crate) native_event: Value,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PiAcpDialogAnswer {
    Cancel,
    Confirm { confirmed: bool },
    Text { value: String },
}

fn identity(value: &Value) -> Result<&str, String> {
    value
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 512)
        .ok_or_else(|| "Pi ACP interaction identity is missing or invalid".into())
}

impl PiAcpDialog {
    pub(crate) fn answer(&self, answer: &PiAcpDialogAnswer) -> Result<Value, String> {
        use serde_json::json;
        let value = match (answer, self.native_event["method"].as_str()) {
            (PiAcpDialogAnswer::Cancel, _) => return Ok(json!({"action":"cancel"})),
            (PiAcpDialogAnswer::Confirm { confirmed }, Some("confirm")) => json!(confirmed),
            (PiAcpDialogAnswer::Text { value }, Some("select" | "input" | "editor")) => {
                if value.len() > 65536 {
                    return Err("Pi 对话文本超过大小限制".into());
                }
                if self.native_event["method"] == "select"
                    && !self.native_event["options"]
                        .as_array()
                        .is_some_and(|options| options.contains(&json!(value)))
                {
                    return Err("Pi 选项不属于当前原生对话".into());
                }
                json!(value)
            }
            _ => return Err("Pi 回答类型与原生对话不一致".into()),
        };
        Ok(json!({"action":"accept","content":{"value":value}}))
    }

    pub(crate) fn parse(envelope: &Value) -> Result<Self, String> {
        if envelope["method"] != "elicitation/create" || envelope["params"]["mode"] != "form" {
            return Err("Pi ACP requires a native form interaction".into());
        }
        let params = &envelope["params"];
        let session = identity(&params["sessionId"])?;
        let meta = &params["_meta"];
        if meta["sessionId"] != session || meta["farfoldPi"]["version"] != 1 {
            return Err("Pi ACP form version or session does not match its native metadata".into());
        }
        let native = &meta["farfoldPi"]["event"];
        let method = native["method"].as_str().unwrap_or_default();
        if native["type"] != "extension_ui_request"
            || !["select", "confirm", "input", "editor"].contains(&method)
            || !native["title"].is_string()
            || native.to_string().len() > 65536
        {
            return Err("Pi ACP form has an invalid native UI envelope".into());
        }
        let schema = &params["requestedSchema"];
        let property = &schema["properties"]["value"];
        if schema["type"] != "object"
            || schema["required"] != serde_json::json!(["value"])
            || property["type"]
                != if method == "confirm" {
                    "boolean"
                } else {
                    "string"
                }
        {
            return Err("Pi ACP form schema does not match the native dialog".into());
        }
        if method == "select"
            && (native["options"]
                .as_array()
                .is_none_or(|options| options.is_empty() || options.iter().any(|v| !v.is_string()))
                || property["enum"] != native["options"])
        {
            return Err("Pi ACP select options do not match the native request".into());
        }
        Ok(Self {
            request_key: crate::acp_transport::json_rpc_id_key(&envelope["id"])?,
            native_request_id: identity(&native["id"])?.to_string(),
            native_session_id: session.to_string(),
            native_event: native.clone(),
        })
    }
}

pub(crate) struct PiAcpWithdrawal<'a> {
    pub(crate) native_session_id: &'a str,
    pub(crate) native_request_id: &'a str,
}

impl<'a> PiAcpWithdrawal<'a> {
    pub(crate) fn parse(envelope: &'a Value) -> Result<Self, String> {
        let params = &envelope["params"];
        if envelope["method"] != "_pi/ui_withdrawn"
            || params["version"] != 1
            || !matches!(
                params["reason"].as_str(),
                Some("cancelled" | "timeout" | "connection_closed")
            )
        {
            return Err("Pi ACP withdrawal version or reason is invalid".into());
        }
        Ok(Self {
            native_session_id: identity(&params["sessionId"])?,
            native_request_id: identity(&params["nativeRequestId"])?,
        })
    }
}

#[cfg(test)]
pub(crate) fn form_fixture() -> Value {
    serde_json::json!({"jsonrpc":"2.0","id":7,"method":"elicitation/create","params":{
        "sessionId":"native-session","mode":"form","message":"Continue?",
        "requestedSchema":{"type":"object","properties":{"value":{"type":"boolean","title":"Continue?"}},"required":["value"]},
        "_meta":{"sessionId":"native-session","farfoldPi":{"version":1,"event":{"type":"extension_ui_request","id":"native-dialog","method":"confirm","title":"Continue?"}}}
    }})
}

#[cfg(test)]
mod tests {
    use super::{PiAcpDialog, PiAcpDialogAnswer, form_fixture};
    use serde_json::json;

    #[test]
    fn pi_form_keeps_acp_and_native_request_identities_separate() {
        let envelope = form_fixture();
        let parsed = PiAcpDialog::parse(&envelope).unwrap();
        assert_eq!(parsed.request_key, "7");
        assert_eq!(parsed.native_request_id, "native-dialog");
        assert_eq!(parsed.native_session_id, "native-session");
        assert_eq!(
            parsed.native_event,
            envelope["params"]["_meta"]["farfoldPi"]["event"]
        );
    }

    #[test]
    fn mismatched_schema_session_and_version_do_not_open_pi_dialogs() {
        for (pointer, value) in [
            ("/params/_meta/sessionId", json!("other")),
            ("/params/_meta/farfoldPi/version", json!(2)),
            (
                "/params/requestedSchema/properties/value/type",
                json!("string"),
            ),
            ("/params/_meta/farfoldPi/event/method", json!("notify")),
        ] {
            let mut envelope = form_fixture();
            *envelope.pointer_mut(pointer).unwrap() = value;
            assert!(PiAcpDialog::parse(&envelope).is_err());
        }
    }

    #[test]
    fn pi_dialog_answers_preserve_false_empty_text_cancel_and_native_options() {
        let confirm = PiAcpDialog::parse(&form_fixture()).unwrap();
        assert_eq!(
            confirm
                .answer(&PiAcpDialogAnswer::Confirm { confirmed: false })
                .unwrap(),
            json!({"action":"accept","content":{"value":false}})
        );
        assert!(
            confirm
                .answer(&PiAcpDialogAnswer::Text {
                    value: "false".into()
                })
                .is_err()
        );
        for method in ["input", "editor", "select"] {
            let mut form = form_fixture();
            form["params"]["_meta"]["farfoldPi"]["event"]["method"] = json!(method);
            form["params"]["requestedSchema"]["properties"]["value"]["type"] = json!("string");
            if method == "select" {
                form["params"]["_meta"]["farfoldPi"]["event"]["options"] = json!(["red", "green"]);
                form["params"]["requestedSchema"]["properties"]["value"]["enum"] =
                    json!(["red", "green"]);
            }
            let dialog = PiAcpDialog::parse(&form).unwrap();
            let text = if method == "select" { "red" } else { "" };
            assert_eq!(
                dialog
                    .answer(&PiAcpDialogAnswer::Text { value: text.into() })
                    .unwrap(),
                json!({"action":"accept","content":{"value":text}})
            );
            assert_eq!(
                dialog.answer(&PiAcpDialogAnswer::Cancel).unwrap(),
                json!({"action":"cancel"})
            );
            assert!(
                dialog
                    .answer(&PiAcpDialogAnswer::Confirm { confirmed: false })
                    .is_err()
            );
            assert!(
                dialog
                    .answer(&PiAcpDialogAnswer::Text {
                        value: "x".repeat(65537)
                    })
                    .is_err()
            );
            if method == "select" {
                assert!(
                    dialog
                        .answer(&PiAcpDialogAnswer::Text {
                            value: "other".into()
                        })
                        .is_err()
                );
            }
        }
    }
}
