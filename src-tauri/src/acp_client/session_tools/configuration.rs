//! The official reply may contain credentials and has no source/connection
//! attestation. Retain only bounded names, kinds and the unreported states.
use super::{Code, ToolsError, types};
use agent_client_protocol::schema::v1::{McpServerHttp, McpServerStdio};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

pub(super) const METHOD: &str = "_goose/unstable/session/extensions/list";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Builtin,
    Platform,
    Http,
    Local,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Item {
    name: Option<String>,
    kind: Kind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    observed_at_ms: u64,
    source: &'static str,
    connection_status: &'static str,
    reported_item_count: usize,
    items_truncated: bool,
    items: Vec<Item>,
}

pub(super) fn parse(value: &Value) -> Result<Report, ToolsError> {
    let entries = value
        .get("extensions")
        .and_then(Value::as_array)
        .ok_or(Code::InvalidResponse)?;
    let mut keys = HashSet::new();
    let mut items = Vec::with_capacity(entries.len().min(types::MAX_ITEMS));
    for entry in entries.iter().take(types::MAX_ITEMS) {
        let key = entry
            .get("extensionKey")
            .and_then(Value::as_str)
            .filter(|key| !key.is_empty())
            .ok_or(Code::InvalidResponse)?;
        if !keys.insert(key) {
            return Err(Code::InvalidResponse.into());
        }
        let extension = entry.get("extension").ok_or(Code::InvalidResponse)?;
        let item = match extension.get("type").and_then(Value::as_str) {
            Some("builtin" | "platform") => {
                let kind = if extension["type"] == "builtin" {
                    Kind::Builtin
                } else {
                    Kind::Platform
                };
                let name = extension
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or(Code::InvalidResponse)?;
                named(kind, name)
            }
            Some("mcp") => {
                let server = extension.get("server").ok_or(Code::InvalidResponse)?;
                mcp_item(server)?
            }
            Some(_) => Item {
                name: None,
                kind: Kind::Other,
            },
            None => return Err(Code::InvalidResponse.into()),
        };
        items.push(item);
    }
    Ok(Report {
        observed_at_ms: types::observed_at_ms()?,
        source: "unreported",
        connection_status: "unreported",
        reported_item_count: entries.len(),
        items_truncated: entries.len() > types::MAX_ITEMS,
        items,
    })
}

fn named(kind: Kind, name: &str) -> Item {
    Item {
        name: types::displayable_name(name).then(|| name.to_owned()),
        kind,
    }
}

fn mcp_item(server: &Value) -> Result<Item, ToolsError> {
    match server.get("type") {
        None => {
            // ACP v1 serializes stdio without a type tag. Validate the official
            // shape and discard all executable, argument and environment data.
            let server = McpServerStdio::deserialize(server).map_err(|_| Code::InvalidResponse)?;
            Ok(named(Kind::Local, &server.name))
        }
        Some(Value::String(kind)) if kind == "http" => {
            let server = McpServerHttp::deserialize(server).map_err(|_| Code::InvalidResponse)?;
            Ok(named(Kind::Http, &server.name))
        }
        Some(Value::String(kind)) if kind != "stdio" => Ok(Item {
            name: None,
            kind: Kind::Other,
        }),
        _ => Err(Code::InvalidResponse.into()),
    }
}
