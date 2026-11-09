//! Exact private configuration identities from the same official MCP response.
use super::{launch::Directory, output, requests, types::*};
use crate::meta_store::{AgentRow, MetaStore};
use serde_json::{Value, json};
use std::{collections::HashSet, sync::Arc};
#[derive(Clone, PartialEq)]
pub(in crate::acp_client) struct McpTarget {
    pub id: usize,
    pub name: String,
    pub transport: &'static str,
    pub identity: Value,
}
pub(in crate::acp_client) struct TargetSet {
    pub row: AgentRow,
    pub directory: Arc<Directory>,
    pub entries: Vec<McpTarget>,
    pub names: HashSet<String>,
}
#[derive(Clone)]
pub(in crate::acp_client) struct Source {
    pub request: Arc<requests::Request>,
    pub set: Arc<TargetSet>,
    pub target: McpTarget,
    pub inventory_id: String,
}
#[derive(Clone, PartialEq)]
pub(in crate::acp_client) struct Report {
    pub target: McpTarget,
    pub enabled: bool,
    pub policy_disabled: bool,
}
fn strings(v: &Value) -> bool {
    v.as_array().is_some_and(|a| a.iter().all(Value::is_string))
}
fn string_map(v: &Value) -> bool {
    v.as_object()
        .is_some_and(|a| a.values().all(Value::is_string))
}
pub(in crate::acp_client) fn target(row: &Value, id: usize) -> Option<McpTarget> {
    let name = row.get("name")?.as_str()?;
    output::safe_name(name)?;
    let t = row.get("transport")?.as_object()?;
    let transport = match t.get("type")?.as_str()? {
        "stdio" => {
            if !t
                .get("command")?
                .as_str()
                .is_some_and(|s| !s.is_empty() && !s.contains('\0'))
                || t.get("args").is_some_and(|v| !v.is_null() && !strings(v))
                || t.get("env").is_some_and(|v| !v.is_null() && !string_map(v))
            {
                return None;
            }
            "stdio"
        }
        "streamable_http" => {
            if !t
                .get("url")?
                .as_str()
                .is_some_and(|s| !s.is_empty() && !s.chars().any(char::is_control))
            {
                return None;
            }
            "streamableHttp"
        }
        _ => return None,
    };
    // Same official list/get projection; auth_status is deliberately not identity.
    let mut identity = json!({"transport":t});
    for key in [
        "enabled_tools",
        "disabled_tools",
        "startup_timeout_sec",
        "tool_timeout_sec",
    ] {
        if let Some(value) = row.get(key) {
            identity[key] = value.clone();
        }
    }
    Some(McpTarget {
        id,
        name: name.into(),
        transport,
        identity,
    })
}
pub(in crate::acp_client) fn report(bytes: &[u8], original: &McpTarget) -> Result<Report> {
    if bytes.len() > output::STDOUT_LIMIT || !output::bounded_depth(bytes) {
        return Err(Code::OutputLimit.into());
    }
    let row: Value = serde_json::from_slice(bytes).map_err(|_| Code::InvalidOutput)?;
    let target = target(&row, original.id).ok_or(Code::InvalidOutput)?;
    if target.id != original.id
        || target.name != original.name
        || target.transport != original.transport
        || !original.identity.as_object().is_some_and(|fields| {
            fields
                .iter()
                .all(|(key, value)| target.identity.get(key) == Some(value))
        })
    {
        return Err(Code::TargetChanged.into());
    }
    let enabled = row
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or(Code::InvalidOutput)?;
    let policy_disabled = row.get("disabled_reason").is_some_and(|v| !v.is_null());
    Ok(Report {
        target,
        enabled,
        policy_disabled,
    })
}
impl Source {
    pub fn current(&self, store: &MetaStore, require_inventory: bool) -> Result<()> {
        let row = store
            .get_agent(&self.set.row.id)
            .map_err(|_| Code::Unavailable)?;
        if !row
            .as_ref()
            .is_some_and(|v| super::launch::same_selection(v, &self.set.row))
        {
            return Err(Code::SelectionChanged.into());
        }
        if !self.set.directory.current() {
            return Err(Code::CwdUnavailable.into());
        }
        if require_inventory && !self.available() {
            return Err(Code::TargetUnavailable.into());
        }
        Ok(())
    }
    pub fn cwd(&self) -> &str {
        self.request.cwd.as_deref().unwrap_or_default()
    }
    pub fn available(&self) -> bool {
        self.request.operation.interested()
            && self
                .request
                .mcp_targets
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .as_ref()
                .is_some_and(|v| Arc::ptr_eq(v, &self.set))
    }
}
pub(in crate::acp_client) fn get(agent: &str, id: &str, item: usize) -> Result<Source> {
    let request = requests::shared().get_for_management(agent, id)?;
    if !request.operation.interested()
        || !request
            .snapshot()
            .is_some_and(|v| v.settled && v.state == State::Ready && v.kind == Kind::Mcp)
    {
        return Err(Code::TargetUnavailable.into());
    }
    let set = request
        .mcp_targets
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .ok_or(Code::TargetUnavailable)?;
    let target = set
        .entries
        .iter()
        .find(|v| v.id == item)
        .cloned()
        .ok_or(Code::TargetUnavailable)?;
    Ok(Source {
        request,
        set,
        target,
        inventory_id: id.into(),
    })
}

// No item ordinal: a complete empty catalogue is sufficient to inspect addition.
#[derive(Clone)]
pub(in crate::acp_client) struct CatalogueSource {
    pub request: Arc<requests::Request>,
    pub set: Arc<TargetSet>,
    pub inventory_id: String,
}
impl CatalogueSource {
    pub fn cwd(&self) -> &str {
        self.request.cwd.as_deref().unwrap_or_default()
    }
    pub fn available(&self) -> bool {
        self.request.operation.interested()
            && self
                .request
                .mcp_targets
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .as_ref()
                .is_some_and(|v| Arc::ptr_eq(v, &self.set))
    }
    pub fn current(&self, store: &MetaStore, require_inventory: bool) -> Result<()> {
        let row = store
            .get_agent(&self.set.row.id)
            .map_err(|_| Code::Unavailable)?;
        if !row
            .as_ref()
            .is_some_and(|r| super::launch::same_selection(r, &self.set.row))
        {
            return Err(Code::SelectionChanged.into());
        }
        if !self.set.directory.current() {
            return Err(Code::CwdUnavailable.into());
        }
        if require_inventory && !self.available() {
            return Err(Code::TargetUnavailable.into());
        }
        Ok(())
    }
}
pub(in crate::acp_client) fn catalogue(agent: &str, id: &str) -> Result<CatalogueSource> {
    let request = requests::shared().get_for_management(agent, id)?;
    if !request.operation.interested()
        || !request.snapshot().is_some_and(|v| {
            v.settled
                && v.state == State::Ready
                && v.kind == Kind::Mcp
                && matches!(
                    v.snapshot,
                    Some(InventorySnapshot::Mcp(McpInventory { complete: true, .. }))
                )
        })
    {
        return Err(Code::TargetUnavailable.into());
    }
    let set = request
        .mcp_targets
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .ok_or(Code::TargetUnavailable)?;
    Ok(CatalogueSource {
        request,
        set,
        inventory_id: id.into(),
    })
}
