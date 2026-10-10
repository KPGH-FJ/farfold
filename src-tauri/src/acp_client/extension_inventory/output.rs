//! Private stdout decoder. Never forwards unknown fields or serde/OS errors.
use super::types::*;
use serde::Deserialize;
use std::{
    collections::HashSet,
    time::{SystemTime, UNIX_EPOCH},
};
pub(super) const STDOUT_LIMIT: usize = 1024 * 1024;
pub(super) const STDERR_LIMIT: usize = 64 * 1024;

#[derive(Deserialize)]
struct Row {
    name: String,
    enabled: bool,
    transport: Transport,
    auth_status: String,
}
#[derive(Deserialize)]
struct Transport {
    r#type: String,
}

// serde's recursion ceiling is larger than the query's budget. Count containers
// outside JSON strings first; serde still validates escapes, UTF-8 and full EOF.
fn bounded_depth(bytes: &[u8]) -> bool {
    let (mut depth, mut string, mut escaped) = (0usize, false, false);
    for &byte in bytes {
        if string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                string = false;
            }
        } else if byte == b'"' {
            string = true;
        } else if matches!(byte, b'[' | b'{') {
            depth += 1;
            if depth > 32 {
                return false;
            }
        } else if matches!(byte, b']' | b'}') {
            let Some(next) = depth.checked_sub(1) else {
                return false;
            };
            depth = next;
        }
    }
    depth == 0 && !string
}
fn safe_name(name: &str) -> Option<String> {
    // Display only simple labels. URL/path/header-like names are retained as an
    // unnamed row. No filter can prove arbitrary user-given labels contain no secret.
    (!name.is_empty()
        && name.len() <= 256
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.'))
        && !name.contains(".."))
    .then(|| name.to_owned())
}
pub(super) fn parse(bytes: &[u8]) -> Result<McpInventory> {
    if bytes.len() > STDOUT_LIMIT {
        return Err(Code::OutputLimit.into());
    }
    if !bounded_depth(bytes) {
        return Err(Code::InvalidOutput.into());
    }
    // Derive rejects duplicate known keys; unknown nested values are skipped,
    // never allocated into a public Value or preserved in diagnostics.
    let rows: Vec<Row> = serde_json::from_slice(bytes).map_err(|_| Code::InvalidOutput)?;
    if rows.len() > 512 {
        return Err(Code::OutputLimit.into());
    }
    let mut names = HashSet::new();
    let mut items = Vec::with_capacity(rows.len());
    for (id, row) in rows.into_iter().enumerate() {
        if !names.insert(row.name.clone()) {
            return Err(Code::InvalidOutput.into());
        }
        items.push(McpInventoryItem {
            id,
            name: safe_name(&row.name),
            reported_enabled: row.enabled,
            transport: match row.transport.r#type.as_str() {
                "stdio" => "stdio",
                "streamable_http" => "streamableHttp",
                _ => "unknown",
            },
            reported_auth: match row.auth_status.as_str() {
                "oauth" => "oauth",
                "bearer_token" => "bearerToken",
                "not_logged_in" => "notLoggedIn",
                "unsupported" => "unsupported",
                _ => "unknown",
            },
            origin: "unreported",
            configuration_layer: "unreported",
            connection: "unverified",
            tools: "unreported",
        });
    }
    Ok(McpInventory {
        observed_at_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis().min(9_007_199_254_740_991) as u64)
            .unwrap_or_default(),
        scope: "officialCliConfigurationForDirectory",
        source: "officialCli",
        complete: true,
        session_applicability: "unverified",
        items,
    })
}
