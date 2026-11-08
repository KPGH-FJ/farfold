//! Reviewed per-message metadata, never context size, a total or work evidence.
//! Unknown official fields remain in the untouched notification parameters.
use serde::Serialize;
use serde_json::{Value, json};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_MESSAGE_ID: usize = 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report<'a> {
    message_id: Option<&'a str>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    total_tokens: Option<u64>,
    cache_read_tokens: Option<u64>,
    cache_write_tokens: Option<u64>,
    cost: Option<f64>,
    cost_source: Option<&'a str>,
    elapsed_ms: Option<u64>,
    time_to_first_token_ms: Option<u64>,
    is_compaction: Option<bool>,
}

fn optional<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|v| !v.is_null())
}

fn count(value: &Value, key: &str) -> Result<Option<u64>, ()> {
    optional(value, key)
        .map(|n| n.as_u64().filter(|n| *n <= MAX_SAFE_INTEGER).ok_or(()))
        .transpose()
}

fn report(update: &Value) -> Result<Report<'_>, ()> {
    let usage = update.get("usage").filter(|v| v.is_object()).ok_or(())?;
    let message_id = optional(update, "messageId")
        .map(|v| {
            v.as_str()
                .filter(|id| {
                    !id.trim().is_empty()
                        && id.chars().count() <= MAX_MESSAGE_ID
                        && !id.chars().any(char::is_control)
                })
                .ok_or(())
        })
        .transpose()?;
    let cost = optional(usage, "cost")
        .map(|v| v.as_f64().filter(|n| n.is_finite() && *n >= 0.0).ok_or(()))
        .transpose()?;
    let cost_source = optional(usage, "costSource")
        .map(|v| {
            v.as_str()
                .filter(|s| matches!(*s, "provider_reported" | "estimated"))
                .ok_or(())
        })
        .transpose()?;
    Ok(Report {
        message_id,
        input_tokens: count(usage, "inputTokens")?,
        output_tokens: count(usage, "outputTokens")?,
        total_tokens: count(usage, "totalTokens")?,
        cache_read_tokens: count(usage, "cacheReadTokens")?,
        cache_write_tokens: count(usage, "cacheWriteTokens")?,
        cost,
        cost_source,
        elapsed_ms: count(usage, "elapsedMs")?,
        time_to_first_token_ms: count(usage, "timeToFirstTokenMs")?,
        is_compaction: optional(usage, "isCompaction")
            .map(|v| v.as_bool().ok_or(()))
            .transpose()?,
    })
}

pub(super) fn present(mut value: Value, connection: &str, allowed: bool) -> Value {
    let update = &value["params"]["update"];
    let usage = allowed.then(|| report(update).ok()).flatten();
    let hint = json!({"kind":"messageUsage","connectionId":connection,"usage":usage});
    value
        .as_object_mut()
        .expect("notification wrapper")
        .insert("presentation".into(), hint);
    value
}

#[cfg(test)]
mod tests;
