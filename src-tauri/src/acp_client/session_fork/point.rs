//! A selected official message is verified against complete, ephemeral exports.
//! No conversation body, node map or export is persisted by Farfold.
use super::*;
use agent_client_protocol::{Agent, ConnectionTo};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashSet;

const EXPORT: &str = "_goose/unstable/session/export";
const MAX_EXPORT_BYTES: usize = 8 * 1024 * 1024;
const READ_BUDGET: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryPoint {
    pub message_id: String,
}
impl HistoryPoint {
    pub(crate) fn valid(&self) -> bool {
        valid_id(&self.message_id)
    }
}
fn valid_id(id: &str) -> bool {
    !id.trim().is_empty() && id.len() <= 1024 && !id.chars().any(char::is_control)
}

pub(super) struct Prepared {
    original: Value,
    prefix: Vec<Value>,
    pub(super) cutoff: i64,
}

fn exported(value: Value, id: &str, cwd: &Path) -> Result<Value, &'static str> {
    let data = value
        .get("data")
        .and_then(Value::as_str)
        .ok_or("point_read_failed")?;
    if value.as_object().is_none_or(|v| v.len() != 1) || data.len() > MAX_EXPORT_BYTES {
        return Err("point_read_failed");
    }
    let data: Value = serde_json::from_str(data).map_err(|_| "point_read_failed")?;
    let messages = data
        .get("conversation")
        .and_then(Value::as_array)
        .ok_or("point_read_failed")?;
    if data["id"].as_str() != Some(id)
        || data["working_dir"].as_str() != cwd.to_str()
        || data["message_count"].as_u64() != Some(messages.len() as u64)
        || !data["extension_data"].is_object()
    {
        return Err("point_read_failed");
    }
    let mut ids = HashSet::new();
    let mut last = None;
    for message in messages {
        let time = message
            .get("created")
            .and_then(Value::as_i64)
            .ok_or("point_read_failed")?;
        if !message.is_object()
            || !message["content"].is_array()
            || !message["metadata"].is_object()
            || !message["metadata"]["agentVisible"].is_boolean()
            || !message["metadata"]["userVisible"].is_boolean()
            || !matches!(message["role"].as_str(), Some("user" | "assistant"))
        {
            return Err("point_read_failed");
        }
        if last.is_some_and(|last| time < last) {
            return Err("point_ambiguous");
        }
        last = Some(time);
        match message.get("id") {
            Some(Value::Null) => {}
            Some(Value::String(id)) if valid_id(id) && ids.insert(id.clone()) => {}
            _ => return Err("point_ambiguous"),
        }
    }
    Ok(data)
}

impl Prepared {
    pub(super) fn select(
        value: Value,
        id: &str,
        cwd: &Path,
        point: &HistoryPoint,
    ) -> Result<Self, &'static str> {
        let original = exported(value, id, cwd)?;
        let messages = original["conversation"]
            .as_array()
            .ok_or("point_read_failed")?;
        let index = messages
            .iter()
            .position(|v| v["id"].as_str() == Some(&point.message_id))
            .ok_or("point_unavailable")?;
        // Official Conversation::agent_visible_messages drops these records.
        // After compaction their replacement summary can lie beyond the cut;
        // byte-equal copied history would then still lose the earlier context.
        // We cannot reconstruct that context or alter upstream visibility.
        if messages[..=index]
            .iter()
            .any(|message| message["metadata"]["agentVisible"] != true)
        {
            return Err("point_context_unavailable");
        }
        let next = messages.get(index + 1).ok_or("point_unavailable")?;
        let cutoff = next["created"].as_i64().ok_or("point_read_failed")?;
        if messages[index]["created"]
            .as_i64()
            .is_none_or(|t| t >= cutoff)
        {
            return Err("point_ambiguous");
        }
        Ok(Self {
            prefix: messages[..=index].to_vec(),
            original,
            cutoff,
        })
    }
    pub(super) fn verify(
        &self,
        parent: Value,
        child: Value,
        parent_id: &str,
        child_id: &str,
        cwd: &Path,
    ) -> Result<(), &'static str> {
        let parent = exported(parent, parent_id, cwd)?;
        let child = exported(child, child_id, cwd)?;
        if parent != self.original || child["conversation"].as_array() != Some(&self.prefix) {
            return Err("point_mismatch");
        }
        for key in [
            "extension_data",
            "provider_name",
            "model_config",
            "goose_mode",
            "recipe",
            "user_recipe_values",
        ] {
            if child.get(key) != self.original.get(key) {
                return Err("point_mismatch");
            }
        }
        Ok(())
    }
}

/// Complete response matching uses the same original SDK witness as tool reads.
/// A timed-out observer never cancels, replaces or retries that wire request.
pub(super) async fn read(
    cx: &ConnectionTo<Agent>,
    ops: &super::super::pump::SessionOps,
    id: &str,
) -> Result<Value, &'static str> {
    let lease = ops
        .life
        .operation(format!("fork-point:{id}"))
        .map_err(|_| "point_read_failed")?;
    let (wire, witness) = ops
        .session_tools
        .send_raw(cx, EXPORT, json!({"sessionId":id,"format":"json"}))
        .map_err(|_| "point_read_failed")?;
    let life = ops.life.clone();
    let available = ops.session_tools.clone();
    let (send, receive) = oneshot::channel();
    super::super::manager::runtime().spawn(async move {
        let response = super::super::operations::until_owner_ended(&life, wire).await;
        let matched = witness.load(Ordering::SeqCst);
        let value = if matched {
            response.and_then(Result::ok).ok_or("point_read_failed")
        } else {
            Err("point_read_failed")
        };
        if matched {
            available.clear(&witness);
            drop(lease);
            let _ = send.send(value);
            return;
        }
        let _ = send.send(value);
        if !life.finished() {
            life.terminated().await;
        }
        available.clear(&witness);
        drop(lease);
    });
    tokio::time::timeout(READ_BUDGET, receive)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or(Err("point_read_failed"))
}

pub(crate) fn present(mut params: Value, connection: &str, session: &str, allowed: bool) -> Value {
    let update = &params["update"];
    if allowed
        && params["sessionId"].as_str() == Some(session)
        && matches!(
            update["sessionUpdate"].as_str(),
            Some("user_message_chunk" | "agent_message_chunk")
        )
        && let Some(id) = update["messageId"].as_str().filter(|id| valid_id(id))
        && update
            .pointer("/_meta/goose/messageId")
            .and_then(Value::as_str)
            == Some(id)
        && update
            .pointer("/_meta/goose/created")
            .and_then(Value::as_i64)
            .is_some()
        && params.get("presentation").is_none()
    {
        let hint = json!({"kind":"historyForkPoint","connectionId":connection,"messageId":id});
        params
            .as_object_mut()
            .expect("session envelope")
            .insert("presentation".into(), hint);
    }
    params
}

#[cfg(test)]
mod tests;
