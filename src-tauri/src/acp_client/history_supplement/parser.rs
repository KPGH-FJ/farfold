//! Reviewed fast-agent Codex export: response_item carries canonical visible/tool data.
//! event_msg is redundant status and turn_context/base_instructions is never presentation.
use super::{strict_json, types::*};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v.get(key).and_then(Value::as_str).ok_or(Reason::Invalid)
}
fn identifier(v: &Value, key: &str) -> Result<String> {
    let s = text(v, key)?;
    if s.is_empty() || s.len() > 512 || s.chars().any(char::is_control) {
        return Err(Reason::Invalid);
    }
    Ok(s.into())
}
fn keys(v: &Value, allowed: &[&str]) -> Result<()> {
    if v.as_object()
        .is_none_or(|o| o.keys().any(|k| !allowed.contains(&k.as_str())))
    {
        return Err(Reason::Invalid);
    }
    Ok(())
}
fn bool_field(v: &Value, key: &str) -> Result<()> {
    if v.get(key).is_some_and(|v| !v.is_boolean()) {
        return Err(Reason::Invalid);
    }
    Ok(())
}
fn image(uri: &str) -> Result<Content> {
    let (prefix, data) = uri.split_once(",").ok_or(Reason::Invalid)?;
    let mime = prefix
        .strip_prefix("data:")
        .and_then(|s| s.strip_suffix(";base64"))
        .ok_or(Reason::Invalid)?;
    if !matches!(
        mime,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif"
    ) || data.is_empty()
    {
        return Err(Reason::Invalid);
    }
    if data.len() > OUTPUT_LIMIT / 2 {
        return Err(Reason::Limit);
    }
    let decoded = STANDARD.decode(data).map_err(|_| Reason::Invalid)?;
    if STANDARD.encode(&decoded) != data {
        return Err(Reason::Invalid);
    }
    // Pixels/decoder validation remains in the common frontend media admission.
    Ok(Content::Image {
        mime_type: mime.into(),
        data: data.into(),
    })
}
fn content(output: &Value) -> Result<Vec<Content>> {
    if let Some(text) = output.as_str() {
        return Ok(vec![Content::Text { text: text.into() }]);
    }
    let values = output.as_array().ok_or(Reason::Invalid)?;
    if values.len() > 16 {
        return Err(Reason::Limit);
    }
    values
        .iter()
        .map(|item| match text(item, "type")? {
            "input_text" => {
                keys(item, &["type", "text"])?;
                Ok(Content::Text {
                    text: text(item, "text")?.into(),
                })
            }
            "input_image" => {
                keys(item, &["type", "image_url"])?;
                image(text(item, "image_url")?)
            }
            _ => Err(Reason::Invalid),
        })
        .collect()
}
fn anchor(payload: &Value) -> Result<Option<Anchor>> {
    let role = match text(payload, "role")? {
        "system" | "developer" => return Ok(None),
        "user" => "user",
        "assistant" => "assistant",
        _ => return Err(Reason::Invalid),
    };
    keys(
        payload,
        &[
            "type", "role", "content", "phase", "end_turn", "id", "status",
        ],
    )?;
    bool_field(payload, "end_turn")?;
    if payload
        .get("phase")
        .is_some_and(|p| !matches!(p.as_str(), Some("final_answer" | "commentary")))
    {
        return Err(Reason::Invalid);
    }
    let items = payload
        .get("content")
        .and_then(Value::as_array)
        .ok_or(Reason::Invalid)?;
    let mut visible = String::new();
    for item in items {
        let expected = if role == "user" {
            "input_text"
        } else {
            "output_text"
        };
        if text(item, "type")? != expected {
            return Err(Reason::Invalid);
        }
        keys(item, &["type", "text", "annotations"])?;
        if item
            .get("annotations")
            .is_some_and(|v| v.as_array().is_none_or(|a| !a.is_empty()))
        {
            return Err(Reason::Invalid);
        }
        visible.push_str(text(item, "text")?);
    }
    Ok((!visible.is_empty()).then_some(Anchor {
        role,
        text: visible,
    }))
}
struct Pending {
    id: String,
    name: String,
    arguments: Value,
    gap: usize,
    raw: Value,
}

pub(in crate::acp_client) fn parse(bytes: &[u8], sid: &str, cwd: &str) -> Result<ParsedHistory> {
    if bytes.len() > INPUT_LIMIT {
        return Err(Reason::Limit);
    }
    if bytes.is_empty() || !bytes.ends_with(b"\n") {
        return Err(Reason::Invalid);
    }
    let mut parsed = ParsedHistory {
        anchors: vec![],
        tools: vec![],
    };
    let mut calls: Vec<Option<Pending>> = Vec::new();
    let mut lookup = HashMap::new();
    let mut ids = HashSet::new();
    let mut completed = HashMap::new();
    for (line_no, line) in bytes.split(|b| *b == b'\n').enumerate() {
        if line.is_empty() {
            if line_no != bytes.iter().filter(|b| **b == b'\n').count() {
                return Err(Reason::Invalid);
            }
            break;
        }
        if line_no >= RECORD_LIMIT {
            return Err(Reason::Limit);
        }
        let record = strict_json::parse(line)?;
        keys(&record, &["type", "payload", "timestamp"])?;
        if record.get("timestamp").is_some_and(|v| !v.is_string()) {
            return Err(Reason::Invalid);
        }
        let payload = record
            .get("payload")
            .filter(|p| p.is_object())
            .ok_or(Reason::Invalid)?;
        let kind = text(&record, "type")?;
        if line_no == 0 {
            if kind != "session_meta"
                || text(payload, "id")? != sid
                || text(payload, "cwd")? != cwd
                || text(payload, "originator")? != "fast-agent"
                || text(payload, "source")? != "cli"
            {
                return Err(Reason::Changed);
            }
            continue;
        }
        match kind {
            "turn_context" => {
                if text(payload, "cwd")? != cwd {
                    return Err(Reason::Changed);
                }
            }
            "event_msg" => {
                if !matches!(
                    text(payload, "type")?,
                    "task_started"
                        | "task_complete"
                        | "user_message"
                        | "agent_message"
                        | "token_count"
                ) {
                    return Err(Reason::Invalid);
                }
            }
            "response_item" => {
                if let Some(id) = payload.get("id") {
                    let id = id
                        .as_str()
                        .filter(|s| !s.is_empty() && s.len() <= 512)
                        .ok_or(Reason::Invalid)?;
                    if !ids.insert(id.to_owned()) {
                        return Err(Reason::Invalid);
                    }
                }
                match text(payload, "type")? {
                    "message" => {
                        if let Some(a) = anchor(payload)? {
                            parsed.anchors.push(a);
                        }
                        if parsed.anchors.len() > ANCHOR_LIMIT {
                            return Err(Reason::Limit);
                        }
                    }
                    "reasoning" => {}
                    "function_call" => {
                        keys(
                            payload,
                            &["type", "call_id", "name", "arguments", "id", "status"],
                        )?;
                        let id = identifier(payload, "call_id")?;
                        if lookup.contains_key(&id) {
                            return Err(Reason::Invalid);
                        }
                        let arguments = strict_json::parse(text(payload, "arguments")?.as_bytes())?;
                        if !arguments.is_object() {
                            return Err(Reason::Invalid);
                        }
                        let p = Pending {
                            id: id.clone(),
                            name: identifier(payload, "name")?,
                            arguments,
                            gap: parsed.anchors.len(),
                            raw: payload.clone(),
                        };
                        lookup.insert(id, calls.len());
                        calls.push(Some(p));
                        if calls.len() > TOOL_LIMIT {
                            return Err(Reason::Limit);
                        }
                    }
                    "function_call_output" => {
                        keys(payload, &["type", "call_id", "output", "status", "id"])?;
                        let id = identifier(payload, "call_id")?;
                        let index = *lookup.get(&id).ok_or(Reason::Invalid)?;
                        let p = calls[index].take().ok_or(Reason::Invalid)?;
                        let outcome = match text(payload, "status")? {
                            "success" => "success",
                            "error" => "error",
                            _ => return Err(Reason::Invalid),
                        };
                        completed.insert(
                            index,
                            Tool {
                                tool_call_id: p.id,
                                name: p.name,
                                arguments: p.arguments,
                                call_after_anchor: p.gap,
                                result_after_anchor: parsed.anchors.len(),
                                outcome,
                                content: content(payload.get("output").ok_or(Reason::Invalid)?)?,
                                raw_call: p.raw,
                                raw_result: payload.clone(),
                            },
                        );
                    }
                    _ => return Err(Reason::Invalid),
                }
            }
            _ => return Err(Reason::Invalid),
        }
    }
    if calls.iter().any(Option::is_some) {
        return Err(Reason::Invalid);
    }
    for index in 0..calls.len() {
        parsed
            .tools
            .push(completed.remove(&index).ok_or(Reason::Invalid)?);
    }
    if serde_json::to_vec(&parsed)
        .map_err(|_| Reason::Invalid)?
        .len()
        > OUTPUT_LIMIT
    {
        return Err(Reason::Limit);
    }
    Ok(parsed)
}
