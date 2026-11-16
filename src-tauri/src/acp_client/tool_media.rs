//! Passive media presentation from the reviewed official Mistral tool result.
//! The original ACP update and rawOutput are never rewritten or interpreted as text.
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::path::Path;

// Matches the common message-preview byte ceiling. Original raw data remains
// available when a supplement cannot be admitted; no decoding/codec claim.
const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;

pub(super) fn enabled(agent: &crate::meta_store::AgentRow) -> bool {
    let path = Path::new(&agent.command);
    agent.source == "registry"
        && agent.id == "registry:mistral-vibe"
        && agent.args.is_empty()
        && path.is_absolute()
        && path.file_name().and_then(|v| v.to_str()).is_some_and(|v| {
            v == "vibe-acp" || (cfg!(windows) && v.eq_ignore_ascii_case("vibe-acp.exe"))
        })
}

fn images(update: &Value) -> Option<Vec<Value>> {
    if !matches!(
        update.get("sessionUpdate")?.as_str()?,
        "tool_call" | "tool_call_update"
    ) || update.get("status")?.as_str()? != "completed"
        || update.pointer("/_meta/effect_kind")?.as_str()? != "tool"
        || update.pointer("/_meta/tool_name")?.as_str()?.is_empty()
    {
        return None;
    }
    // Official session_updates._raw_output forwards CompletedEffectState.output.
    // Its MCP success result has typed content, not a JSON-encoded text block.
    let output = update.get("rawOutput")?.as_object()?;
    if output.get("type")?.as_str()? != "success" {
        return None;
    }
    let blocks = output.get("content")?.as_array()?;
    if blocks.len() > 64 {
        return None;
    }
    let mut images = Vec::new();
    let mut total = 0usize;
    for block in blocks {
        match block.get("type")?.as_str()? {
            "text" => {
                block.get("text")?.as_str()?;
            }
            "image" => {
                let mime = block.get("mimeType")?.as_str()?;
                if !matches!(
                    mime,
                    "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif"
                ) {
                    return None;
                }
                let data = block.get("data")?.as_str()?;
                total = total.checked_add(data.len())?;
                if data.is_empty() || total > 4 * MAX_IMAGE_BYTES.div_ceil(3) {
                    return None;
                }
                let decoded = STANDARD.decode(data).ok()?;
                if decoded.len() > MAX_IMAGE_BYTES || STANDARD.encode(&decoded) != data {
                    return None;
                }
                if images.len() == 16 {
                    return None;
                }
                images.push(json!({"type":"image","mimeType":mime,"data":data}));
            }
            _ => return None,
        }
    }
    (!images.is_empty()).then_some(images)
}

pub(super) fn event(
    value: &Value,
    connection: &str,
    session: &str,
    allowed: bool,
) -> Option<Value> {
    if !allowed
        || connection.is_empty()
        || value.get("sessionId").and_then(Value::as_str) != Some(session)
        || value.get("kind").and_then(Value::as_str) == Some("toolMedia")
    {
        return None;
    }
    let update = value.get("update")?;
    let id = update
        .get("toolCallId")?
        .as_str()
        .filter(|id| !id.is_empty())?;
    let content = images(update)?;
    Some(
        json!({"kind":"toolMedia","connectionId":connection,"sessionId":session,"toolCallId":id,"content":content}),
    )
}

/// The Agent may report any unknown fields, including host-like names. Keep
/// the full original body as a notification; never grant it a local event kind.
pub(super) fn guard_notification(value: Value) -> Value {
    if (value.get("kind").and_then(Value::as_str) == Some("toolMedia")
        || super::history_supplement::reserved_kind(&value))
        && value.get("update").is_none()
    {
        json!({"kind":"notification","method":"session/update","params":value})
    } else {
        value
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod wire_tests;
