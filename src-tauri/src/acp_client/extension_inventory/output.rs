//! Private stdout decoder. Never forwards unknown fields or serde/OS errors.
use super::types::*;
use serde::Deserialize;
use std::{
    collections::HashSet,
    time::{SystemTime, UNIX_EPOCH},
};
pub(in crate::acp_client) const STDOUT_LIMIT: usize = 1024 * 1024;
pub(in crate::acp_client) const STDERR_LIMIT: usize = 64 * 1024;

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
pub(in crate::acp_client) fn bounded_depth(bytes: &[u8]) -> bool {
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
pub(in crate::acp_client) fn safe_name(name: &str) -> Option<String> {
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
pub(in crate::acp_client) fn parse(bytes: &[u8]) -> Result<McpInventory> {
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
            enablement: SkillEnablement {
                availability: "unavailable",
                reason: Some("unsupportedTransport"),
            },
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

pub(in crate::acp_client) fn parse_private(
    bytes: &[u8],
) -> Result<(McpInventory, Vec<super::mcp_targets::McpTarget>)> {
    let mut snapshot = parse(bytes)?;
    let rows: Vec<serde_json::Value> =
        serde_json::from_slice(bytes).map_err(|_| Code::InvalidOutput)?;
    let mut targets = Vec::new();
    for (item, row) in snapshot.items.iter_mut().zip(&rows) {
        if let Some(target) = super::mcp_targets::target(row, item.id) {
            item.enablement = SkillEnablement {
                availability: "available",
                reason: None,
            };
            targets.push(target);
        } else if item.name.is_none() {
            item.enablement.reason = Some("unsafeLabel");
        }
    }
    Ok((snapshot, targets))
}

// Complete names, including hidden labels and unsupported transports, are private
// collision evidence. Successful management targets alone are not a catalogue.
pub(in crate::acp_client) fn names(bytes: &[u8]) -> Result<HashSet<String>> {
    parse(bytes)?;
    let rows: Vec<Row> = serde_json::from_slice(bytes).map_err(|_| Code::InvalidOutput)?;
    Ok(rows.into_iter().map(|v| v.name).collect())
}
