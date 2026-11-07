//! Remove one exact path-only preference, never a skill or another selector.
use super::{mcp_plan, plan::Config, types::*};
use crate::acp_client::extension_inventory::targets::SkillTarget;
use serde_json::{Value, json};

#[derive(Clone)]
pub(super) struct Plan {
    pub before: Config,
    pub target: SkillTarget,
    pub configured: bool,
    pub rules_before: usize,
    pub rules_after: usize,
    pub value: Value,
    pub retained: Value,
    pub absent: Option<Value>,
}

fn source_known(config: &Config) -> bool {
    let name = &config.layers[config.active].name;
    name.as_object().is_some_and(|name| {
        name.keys()
            .all(|key| matches!(key.as_str(), "type" | "file" | "profile"))
    }) && config.layers.iter().enumerate().all(|(index, layer)| {
        index == config.active
            || layer.name.get("type") != Some(&json!("user"))
            || layer.name.get("file") != name.get("file")
            || layer.name.get("profile").and_then(Value::as_str)
                != name.get("profile").and_then(Value::as_str)
    })
}

fn configured(config: &Config, path: &str) -> Result<Option<bool>> {
    let Some(skills) = config.layers[config.active].config.get("skills") else {
        return Ok(None);
    };
    let skills = skills.as_object().ok_or(Code::ConfigurationUnsupported)?;
    let Some(rules) = skills.get("config") else {
        return Ok(None);
    };
    let rules = rules.as_array().ok_or(Code::ConfigurationUnsupported)?;
    let matching: Vec<_> = rules
        .iter()
        .filter(|rule| rule.get("path").and_then(Value::as_str) == Some(path))
        .collect();
    match matching.as_slice() {
        [] => Ok(None),
        [rule] if rule.get("name").is_none() => rule
            .get("enabled")
            .and_then(Value::as_bool)
            .map(Some)
            .ok_or_else(|| Code::ConfigurationUnsupported.into()),
        _ => Err(Code::ConfigurationUnsupported.into()),
    }
}

fn parent(config: &Config) -> Option<&'static str> {
    match config.layers[config.active].config.get("skills") {
        None => Some("absent"),
        Some(Value::Object(value)) if value.is_empty() => Some("empty"),
        Some(Value::Object(_)) => Some("nonempty"),
        _ => None,
    }
}

impl Plan {
    pub fn new(before: Config, target: SkillTarget) -> Result<Self> {
        if !source_known(&before) {
            return Err(Code::ConfigurationUnsupported.into());
        }
        let raw = &before.layers[before.active].config;
        let skills = match raw.get("skills") {
            None => return Err(Code::PreferenceNotConfigured.into()),
            Some(Value::Object(value)) => value,
            Some(_) => return Err(Code::ConfigurationUnsupported.into()),
        };
        let rules = match skills.get("config") {
            None => return Err(Code::PreferenceNotConfigured.into()),
            Some(Value::Array(value)) => value,
            Some(_) => return Err(Code::ConfigurationUnsupported.into()),
        };
        if rules.len() > 1024
            || rules
                .iter()
                .any(|rule| !rule.is_object() || !super::plan::supported(rule, 0))
            || serde_json::to_vec(rules)
                .map_err(|_| Code::InvalidOutput)?
                .len()
                > 262144
        {
            return Err(Code::ConfigurationUnsupported.into());
        }
        let matches: Vec<_> = rules
            .iter()
            .enumerate()
            .filter(|(_, rule)| {
                rule.get("path").and_then(Value::as_str) == Some(target.path.as_str())
            })
            .collect();
        let (index, rule) = match matches.as_slice() {
            [] => return Err(Code::PreferenceNotConfigured.into()),
            [matched] => *matched,
            _ => return Err(Code::ConfigurationUnsupported.into()),
        };
        let object = rule.as_object().ok_or(Code::ConfigurationUnsupported)?;
        if object
            .keys()
            .any(|key| !matches!(key.as_str(), "path" | "enabled"))
        {
            return Err(Code::ConfigurationUnsupported.into());
        }
        let configured = rule
            .get("enabled")
            .and_then(Value::as_bool)
            .ok_or(Code::ConfigurationUnsupported)?;
        let mut remaining = rules.clone();
        remaining.remove(index);
        let rules_before = rules.len();
        let rules_after = remaining.len();
        let value = if remaining.is_empty() {
            Value::Null
        } else {
            json!(remaining)
        };
        let mut retained = raw.clone();
        let table = retained["skills"]
            .as_object_mut()
            .ok_or(Code::ConfigurationUnsupported)?;
        if value.is_null() {
            table.remove("config");
        } else {
            table.insert("config".into(), value.clone());
        }
        let absent = if table.is_empty() {
            let mut candidate = retained.clone();
            candidate
                .as_object_mut()
                .ok_or(Code::ConfigurationUnsupported)?
                .remove("skills");
            Some(candidate)
        } else {
            None
        };
        Ok(Self {
            before,
            target,
            configured,
            rules_before,
            rules_after,
            value,
            retained,
            absent,
        })
    }

    pub fn params(&self) -> Value {
        json!({"keyPath":"skills.config","value":self.value,"mergeStrategy":"replace","filePath":self.before.file,"expectedVersion":self.before.version()})
    }

    pub fn unchanged(&self, before: &Config, target: &SkillTarget) -> bool {
        self.before == *before
            && self.target.path == target.path
            && self.target.name == target.name
            && self.target.origin == target.origin
            && self.target.enabled == target.enabled
    }

    pub fn observation(
        &self,
        after: &Config,
        actual_enabled: Option<bool>,
    ) -> Result<(Observation, bool)> {
        let matching = std::iter::once(&self.retained)
            .chain(self.absent.iter())
            .any(|candidate| mcp_plan::preserved(&self.before, after, candidate));
        let observation = Observation {
            observed_at_ms: now_ms(),
            configuration: if matching { "matching" } else { "different" },
            skill: Some(if actual_enabled.is_some() {
                "reported"
            } else {
                "missing"
            }),
            mcp: None,
            configured_enabled: Some(configured(after, &self.target.path)?),
            reported_enabled: actual_enabled,
            parent_outcome: Some(parent(after)),
            session_applicability: "unverified",
        };
        Ok((observation, matching && actual_enabled.is_some()))
    }
}
