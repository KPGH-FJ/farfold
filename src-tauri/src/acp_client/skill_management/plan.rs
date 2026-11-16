//! Only skills.config is changed. Raw official JSON is bounded and stays private.
use super::types::*;
use crate::acp_client::extension_inventory::{skills_output, targets::SkillTarget};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct Layer {
    pub name: Value,
    pub version: String,
    pub config: Value,
    pub disabled_reason: Option<String>,
}
#[derive(Clone, PartialEq)]
pub(super) struct Config {
    pub layers: Vec<Layer>,
    pub active: usize,
    pub file: String,
}
#[derive(Clone)]
pub(super) struct Plan {
    pub before: Config,
    pub intended: Value,
    pub array: Value,
    pub rules_before: usize,
    pub mutation: &'static str,
    pub enabled: bool,
    pub target: SkillTarget,
}
pub(super) fn display_path(path: &str) -> Result<String> {
    if !std::path::Path::new(path).is_absolute() || path.len()>4096 || path.chars().any(|c|c.is_control() || matches!(c,'\u{200b}'..='\u{200f}'|'\u{202a}'..='\u{202e}'|'\u{2060}'..='\u{206f}'|'\u{feff}')) {
        return Err(Code::ConfigurationUnsupported.into());
    }
    Ok(std::env::var("HOME")
        .ok()
        .and_then(|home| path.strip_prefix(&(home + "/")).map(|s| format!("~/{s}")))
        .unwrap_or_else(|| path.into()))
}
impl Config {
    pub fn parse(value: Value) -> Result<Self> {
        let layers: Vec<Layer> =
            serde_json::from_value(value.get("layers").cloned().ok_or(Code::InvalidOutput)?)
                .map_err(|_| Code::InvalidOutput)?;
        if layers.is_empty()
            || layers.len() > 128
            || layers
                .iter()
                .any(|v| !v.config.is_object() || v.version.is_empty() || v.version.len() > 256)
        {
            return Err(Code::ConfigurationUnsupported.into());
        }
        let active = layers
            .iter()
            .position(|v| v.name.get("type") == Some(&json!("user")))
            .ok_or(Code::ConfigurationUnsupported)?;
        let layer = &layers[active];
        if layer.disabled_reason.is_some() {
            return Err(Code::ConfigurationReadOnly.into());
        }
        let file = layer
            .name
            .get("file")
            .and_then(Value::as_str)
            .ok_or(Code::InvalidOutput)?
            .to_owned();
        display_path(&file)?;
        if layer
            .name
            .get("profile")
            .is_some_and(|v| !v.is_null() && !v.is_string())
        {
            return Err(Code::InvalidOutput.into());
        }
        Ok(Self {
            layers,
            active,
            file,
        })
    }
    pub fn scope(&self) -> Result<Scope> {
        Ok(Scope {
            kind: if self.layers[self.active]
                .name
                .get("profile")
                .is_some_and(|v| v.is_string())
            {
                "profile"
            } else {
                "user"
            },
            config_display_path: display_path(&self.file)?,
        })
    }
    pub fn version(&self) -> &str {
        &self.layers[self.active].version
    }
}
// TOML's JSON contract cannot represent null or unsigned values beyond i64.
// Preserve all supported unknown nested values; do not filter them into a DTO.
pub(super) fn supported(value: &Value, depth: usize) -> bool {
    if depth > 32 {
        return false;
    }
    match value {
        Value::Null => false,
        Value::Bool(_) | Value::String(_) => true,
        Value::Number(n) => {
            n.as_i64().is_some() || (!n.is_u64() && n.as_f64().is_some_and(f64::is_finite))
        }
        Value::Array(v) => v.iter().all(|x| supported(x, depth + 1)),
        Value::Object(v) => v.values().all(|x| supported(x, depth + 1)),
    }
}
pub(super) fn exact_skill(value: Value, cwd: &str, target: &SkillTarget) -> Result<SkillTarget> {
    let wire: skills_output::Wire =
        serde_json::from_value(value).map_err(|_| Code::InvalidOutput)?;
    let (snapshot, entries) = wire.project_private(cwd)?;
    if !snapshot.complete {
        return Err(Code::InventoryIncomplete.into());
    }
    let next = entries
        .into_iter()
        .find(|v| v.path == target.path)
        .ok_or(Code::TargetChanged)?;
    if next.name != target.name || next.origin != target.origin {
        return Err(Code::TargetChanged.into());
    }
    Ok(next)
}
impl Plan {
    pub fn new(before: Config, target: SkillTarget, enabled: bool) -> Result<Self> {
        let raw = &before.layers[before.active].config;
        let mut array = match raw.get("skills") {
            None => vec![],
            Some(Value::Object(skills)) => match skills.get("config") {
                None => vec![],
                Some(Value::Array(values)) => values.clone(),
                _ => return Err(Code::ConfigurationUnsupported.into()),
            },
            _ => return Err(Code::ConfigurationUnsupported.into()),
        };
        if array.len() > 1024 || array.iter().any(|v| !v.is_object() || !supported(v, 0)) {
            return Err(Code::ConfigurationUnsupported.into());
        }
        let rules_before = array.len();
        let update = array
            .last_mut()
            .filter(|v| v.get("path") == Some(&json!(target.path)) && v.get("name").is_none());
        let mutation = if let Some(last) = update {
            last["enabled"] = json!(enabled);
            "updateLastPathRule"
        } else {
            array.push(json!({"path":target.path,"enabled":enabled}));
            "appendPathRule"
        };
        let array = Value::Array(array);
        if array.as_array().is_none_or(|v| v.len() > 1024)
            || serde_json::to_vec(&array)
                .map_err(|_| Code::InvalidOutput)?
                .len()
                > 262144
        {
            return Err(Code::OutputLimit.into());
        }
        let mut intended = raw.clone();
        if intended.get("skills").is_none() {
            intended["skills"] = json!({});
        }
        intended["skills"]["config"] = array.clone();
        Ok(Self {
            before,
            intended,
            array,
            rules_before,
            mutation,
            enabled,
            target,
        })
    }
    pub fn params(&self) -> Value {
        json!({"keyPath":"skills.config","value":self.array,"mergeStrategy":"replace","filePath":self.before.file,"expectedVersion":self.before.version()})
    }
    pub fn unchanged(&self, config: &Config, target: &SkillTarget) -> bool {
        self.before == *config
            && self.target.path == target.path
            && self.target.name == target.name
            && self.target.origin == target.origin
            && self.target.enabled == target.enabled
    }
    pub fn config_matches(&self, after: &Config) -> bool {
        self.before.active == after.active
            && self.before.file == after.file
            && self.before.layers.len() == after.layers.len()
            && self
                .before
                .layers
                .iter()
                .zip(&after.layers)
                .enumerate()
                .all(|(i, (before, after))| {
                    if i == self.before.active {
                        before.name == after.name
                            && before.disabled_reason == after.disabled_reason
                            && self.intended == after.config
                    } else {
                        before == after
                    }
                })
    }
}
