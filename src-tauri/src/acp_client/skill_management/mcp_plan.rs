//! Exactly one existing User MCP leaf. Complete unrelated JSON remains private.
use super::{plan::Config, types::*};
use crate::acp_client::extension_inventory::mcp_targets::Report;
use serde_json::{Value, json};
#[derive(Clone)]
pub(super) struct Plan {
    pub before: Config,
    pub directory: Config,
    pub report: Report,
    pub configured: bool,
    pub enabled: bool,
    pub intended: Value,
}
fn entry<'a>(config: &'a Config, name: &str) -> Result<&'a Value> {
    let raw = &config.layers[config.active].config;
    let servers = raw
        .get("mcp_servers")
        .and_then(Value::as_object)
        .ok_or(Code::ConfigurationUnsupported)?;
    let value = servers
        .get(name)
        .filter(|v| v.is_object())
        .ok_or(Code::ConfigurationUnsupported)?;
    Ok(value)
}
pub(super) fn configured(config: &Config, name: &str) -> Option<bool> {
    match entry(config, name).ok()?.get("enabled") {
        None => Some(true),
        Some(v) => v.as_bool(),
    }
}
fn same_scope(a: &Config, b: &Config) -> bool {
    a.file == b.file
        && a.layers[a.active].name == b.layers[b.active].name
        && a.layers[a.active].config == b.layers[b.active].config
        && a.version() == b.version()
}
fn unique(config: &Config, name: &str) -> bool {
    config.layers.iter().enumerate().all(|(i, layer)| {
        i == config.active
            || layer.disabled_reason.is_some()
            || layer
                .config
                .get("mcp_servers")
                .is_none_or(|v| v.as_object().is_some_and(|v| !v.contains_key(name)))
    })
}
fn preserved(before: &Config, after: &Config, intended: &Value) -> bool {
    before.active == after.active
        && before.file == after.file
        && before.layers.len() == after.layers.len()
        && before
            .layers
            .iter()
            .zip(&after.layers)
            .enumerate()
            .all(|(i, (a, b))| {
                if i == before.active {
                    a.name == b.name
                        && a.disabled_reason == b.disabled_reason
                        && b.config == *intended
                } else {
                    a == b
                }
            })
}
impl Plan {
    pub fn new(before: Config, directory: Config, report: Report, enabled: bool) -> Result<Self> {
        let name = &report.target.name;
        if !same_scope(&before, &directory) || !unique(&before, name) || !unique(&directory, name) {
            return Err(Code::ConfigurationUnsupported.into());
        }
        if report.policy_disabled {
            return Err(Code::ConfigurationReadOnly.into());
        }
        let raw = entry(&before, name)?;
        let transport = raw.as_object().ok_or(Code::ConfigurationUnsupported)?;
        // Require a complete entry; do not create a partial override of inherited transport.
        let compatible = match report.target.transport {
            "stdio" => {
                transport
                    .get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty())
                    && !transport.contains_key("url")
            }
            "streamableHttp" => {
                transport
                    .get("url")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty())
                    && !transport.contains_key("command")
            }
            _ => false,
        };
        if !compatible {
            return Err(Code::ConfigurationUnsupported.into());
        }
        let configured = configured(&before, name).ok_or(Code::ConfigurationUnsupported)?;
        if configured != report.enabled {
            return Err(Code::ConfigurationChanged.into());
        }
        let mut intended = before.layers[before.active].config.clone();
        intended["mcp_servers"][name]["enabled"] = json!(enabled);
        Ok(Self {
            before,
            directory,
            report,
            configured,
            enabled,
            intended,
        })
    }
    pub fn params(&self) -> Value {
        let name = self
            .report
            .target
            .name
            .replace('\\', "\\\\")
            .replace('"', "\\\"");
        json!({"keyPath":format!("mcp_servers.\"{name}\".enabled"),"value":self.enabled,"mergeStrategy":"replace","filePath":self.before.file,"expectedVersion":self.before.version()})
    }
    pub fn unchanged(&self, before: &Config, directory: &Config, report: &Report) -> bool {
        self.before == *before && self.directory == *directory && self.report == *report
    }
    pub fn matches(&self, after: &Config, directory: &Config) -> bool {
        preserved(&self.before, after, &self.intended)
            && preserved(&self.directory, directory, &self.intended)
    }
    pub fn observation(
        &self,
        after: &Config,
        directory: &Config,
        report: &Report,
    ) -> (Observation, bool) {
        let matching = self.matches(after, directory);
        let matches_report = report.enabled == self.enabled;
        (
            Observation {
                observed_at_ms: now_ms(),
                configuration: if matching { "matching" } else { "different" },
                skill: None,
                mcp: Some(if matches_report {
                    "matching"
                } else {
                    "different"
                }),
                configured_enabled: Some(configured(after, &self.report.target.name)),
                reported_enabled: Some(report.enabled),
                session_applicability: "unverified",
            },
            matching && matches_report,
        )
    }
}
