//! Complete private official configuration. Never serialize this type to UI,
//! persist descriptors, or include official values in an error.
use super::types::{ChangeError, Code};
use crate::meta_store::mcp_pending::{Action, Pending};
use agent_client_protocol::schema::v1::{McpServerHttp, McpServerSse, McpServerStdio};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};

const LIMIT: usize = 4096;
#[derive(Clone, PartialEq)]
pub(crate) struct Inventory {
    entries: BTreeMap<String, Value>,
}
impl Inventory {
    pub(crate) fn recovery_entries(&self) -> impl Iterator<Item = &Value> {
        self.entries.values()
    }
    pub(super) fn reviewed(&self) -> Result<Vec<super::slot::Reviewed>, ChangeError> {
        let digest = self.digest();
        self.entries
            .iter()
            .filter(|(_, d)| d.pointer("/server/type").and_then(Value::as_str) == Some("http"))
            .map(|(key, descriptor)| {
                let name = descriptor_name(descriptor).filter(|name| {
                    !name.is_empty()
                        && name.len() <= 256
                        && !name.chars().any(|c| {
                            c.is_control() || matches!(c as u32, 0x202a..=0x202e | 0x2066..=0x2069)
                        })
                });
                let can_remove = name.is_some() && self.scope_name(key, descriptor).is_ok();
                let mut entropy = [0u8; 16];
                getrandom::fill(&mut entropy).map_err(|_| Code::Unavailable)?;
                Ok(super::slot::Reviewed {
                    item: super::Item {
                        item_ref: entropy.iter().map(|v| format!("{v:02x}")).collect(),
                        name: name.unwrap_or("无法显示名称的工具").into(),
                        can_remove,
                    },
                    key: key.clone(),
                    descriptor: descriptor.clone(),
                    inventory_digest: digest.clone(),
                })
            })
            .collect()
    }
    pub(super) fn scope_name(&self, key: &str, descriptor: &Value) -> Result<String, ChangeError> {
        if self.entries.get(key) != Some(descriptor) {
            return Err(Code::Changed.into());
        }
        let name = descriptor_name(descriptor).ok_or(Code::InvalidResponse)?;
        let normalized = name_key(name);
        if self.entries.iter().any(|(other, d)| {
            other != key
                && (name_key(other) == normalized
                    || descriptor_name(d).is_none_or(|n| name_key(n) == normalized))
        }) {
            return Err(Code::Changed.into());
        }
        Ok(name.into())
    }
    pub(crate) fn parse(value: Value) -> Result<Self, ChangeError> {
        let root = value
            .as_object()
            .filter(|v| v.len() == 1)
            .ok_or(Code::InvalidResponse)?;
        let values = root
            .get("extensions")
            .and_then(Value::as_array)
            .filter(|v| v.len() <= LIMIT)
            .ok_or(Code::InvalidResponse)?;
        let mut entries = BTreeMap::new();
        for value in values {
            let entry = value
                .as_object()
                .filter(|v| v.len() == 2)
                .ok_or(Code::InvalidResponse)?;
            let key = entry
                .get("extensionKey")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty() && s.len() <= 4096)
                .ok_or(Code::InvalidResponse)?;
            let descriptor = normalize(entry.get("extension").ok_or(Code::InvalidResponse)?)?;
            if entries.insert(key.to_owned(), descriptor).is_some() {
                return Err(Code::InvalidResponse.into());
            }
        }
        Ok(Self { entries })
    }
    pub(crate) fn digest(&self) -> String {
        hash(&json!(self.entries))
    }
    pub(crate) fn matches_pending(&self, pending: &Pending) -> Result<bool, ChangeError> {
        match pending.action {
            Action::Add => {
                let targets: Vec<_> = self
                    .entries
                    .iter()
                    .filter(|(_, v)| descriptor_digest(v) == pending.target_digest)
                    .collect();
                if targets.len() != 1 {
                    return Ok(false);
                }
                let mut remaining = self.clone();
                remaining.entries.remove(targets[0].0);
                Ok(
                    pending.expected_digest.is_none()
                        && remaining.digest() == pending.before_digest,
                )
            }
            Action::Remove => Ok(pending
                .expected_digest
                .as_ref()
                .is_some_and(|v| v == &self.digest())
                && !self
                    .entries
                    .values()
                    .any(|v| descriptor_digest(v) == pending.target_digest)),
        }
    }
    pub(super) fn conflict(&self, name: &str) -> bool {
        let key = name_key(name);
        self.entries.iter().any(|(existing, value)| {
            name_key(existing) == key || descriptor_name(value).is_none_or(|n| name_key(n) == key)
        })
    }
    pub(super) fn added(
        &self,
        before: &Self,
        descriptor: &Value,
    ) -> Result<(String, Value), ChangeError> {
        let matches: Vec<_> = self
            .entries
            .iter()
            .filter(|(_, d)| *d == descriptor)
            .collect();
        if matches.len() != 1 {
            return Err(Code::InvalidResponse.into());
        }
        let (key, actual) = matches[0];
        let mut remaining = self.clone();
        remaining.entries.remove(key);
        if remaining != *before {
            return Err(Code::Changed.into());
        }
        Ok((key.clone(), actual.clone()))
    }
    pub(super) fn without(&self, key: &str, descriptor: &Value) -> Result<Self, ChangeError> {
        if self.entries.get(key) != Some(descriptor) {
            return Err(Code::Changed.into());
        }
        let mut result = self.clone();
        result.entries.remove(key);
        Ok(result)
    }
}
pub(crate) fn descriptor_digest(value: &Value) -> String {
    hash(value)
}
fn hash(value: &Value) -> String {
    // Tauri enables preserve_order. Canonicalize recursively before hashing;
    // an official serializer's field order is not a configuration change.
    let mut canonical = value.clone();
    canonical.sort_all_objects();
    Sha256::digest(serde_json::to_vec(&canonical).expect("JSON value serializes"))
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn descriptor_name(value: &Value) -> Option<&str> {
    match value.get("type")?.as_str()? {
        "builtin" | "platform" => value.get("name")?.as_str(),
        "mcp" => value.pointer("/server/name")?.as_str(),
        _ => None,
    }
}
fn name_key(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| match c {
            'A'..='Z' => c.to_ascii_lowercase(),
            'a'..='z' | '0'..='9' | '_' | '-' => c,
            _ => '_',
        })
        .collect()
}
pub(super) fn http_descriptor(name: &str, address: &str) -> Result<Value, ChangeError> {
    if name.is_empty()
        || name.len() > 128
        || name.trim() != name
        || !name.bytes().any(|b| b.is_ascii_alphanumeric())
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b' ' | b'_' | b'-'))
        || address.len() > 8192
        || address.trim() != address
    {
        return Err(Code::InvalidInput.into());
    }
    super::super::skill_management::mcp_http_url::validate(address)
        .map_err(|_| Code::InvalidInput)?;
    Ok(json!({"type":"mcp","server":{"type":"http","name":name,"url":address,"headers":[]}}))
}
fn normalize(value: &Value) -> Result<Value, ChangeError> {
    let mut value = value.as_object().cloned().ok_or(Code::InvalidResponse)?;
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .ok_or(Code::InvalidResponse)?;
    match kind {
        "builtin" | "platform" => {
            value
                .get("name")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or(Code::InvalidResponse)?;
        }
        "mcp" => {
            let server = value.get("server").ok_or(Code::InvalidResponse)?;
            match server.get("type").and_then(Value::as_str) {
                Some("http") => {
                    McpServerHttp::deserialize(server).map_err(|_| Code::InvalidResponse)?;
                }
                Some("sse") => {
                    McpServerSse::deserialize(server).map_err(|_| Code::InvalidResponse)?;
                }
                None => {
                    McpServerStdio::deserialize(server).map_err(|_| Code::InvalidResponse)?;
                }
                _ => return Err(Code::InvalidResponse.into()),
            }
        }
        _ => return Err(Code::InvalidResponse.into()),
    }
    // Official optional defaults round-trip as absent, null, or empty arrays.
    // Preserve every other field, including future fields, in the comparison.
    value.retain(|key, v| {
        !(v.is_null()
            && matches!(
                key.as_str(),
                "description"
                    | "display_name"
                    | "timeout"
                    | "socket"
                    | "clientId"
                    | "clientSecretKey"
                    | "bundled"
                    | "available_tools"
            )
            || matches!(key.as_str(), "envKeys" | "scopes" | "available_tools")
                && v.as_array().is_some_and(Vec::is_empty))
    });
    Ok(Value::Object(value))
}
pub(super) fn tools(value: &Value) -> Result<HashSet<String>, ChangeError> {
    let root = value
        .as_object()
        .filter(|v| v.len() == 1)
        .ok_or(Code::InvalidResponse)?;
    let entries = root
        .get("tools")
        .and_then(Value::as_array)
        .filter(|v| v.len() <= LIMIT)
        .ok_or(Code::InvalidResponse)?;
    let mut names = HashSet::new();
    for entry in entries {
        let name = entry
            .as_object()
            .and_then(|v| v.get("name"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.len() <= 4096)
            .ok_or(Code::InvalidResponse)?;
        if !names.insert(name.to_owned()) {
            return Err(Code::InvalidResponse.into());
        }
    }
    Ok(names)
}
