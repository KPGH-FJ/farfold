//! Add one disabled literal table, preserving every other raw configuration value.
use super::{mcp_add_input::Input, mcp_plan, plan::Config, types::*};
use serde_json::{Value, json};
#[derive(Clone)]
pub(super) struct Plan {
    pub before: Config,
    pub directory: Config,
    pub input: Input,
    pub intended: Value,
}
pub(super) fn absent(config: &Config, name: &str) -> Result<()> {
    for layer in &config.layers {
        if let Some(value) = layer.config.get("mcp_servers") {
            let table = value.as_object().ok_or(Code::ConfigurationUnsupported)?;
            if table.contains_key(name) {
                return Err(Code::NameConflict.into());
            }
        }
    }
    Ok(())
}
impl Plan {
    pub fn new(before: Config, directory: Config, input: impl Into<Input>) -> Result<Self> {
        let input = input.into();
        input.validate()?;
        absent(&before, input.name())?;
        absent(&directory, input.name())?;
        if !mcp_plan::same_scope(&before, &directory) {
            return Err(Code::ConfigurationUnsupported.into());
        }
        let mut intended = before.layers[before.active].config.clone();
        if intended.get("mcp_servers").is_none() {
            intended["mcp_servers"] = json!({});
        }
        intended["mcp_servers"][input.name()] = input.entry();
        Ok(Self {
            before,
            directory,
            input,
            intended,
        })
    }
    pub fn params(&self) -> Value {
        json!({"keyPath":format!("mcp_servers.\"{}\"",self.input.name()),"value":self.intended["mcp_servers"][self.input.name()],"mergeStrategy":"replace","filePath":self.before.file,"expectedVersion":self.before.version()})
    }
    pub fn unchanged(&self, before: &Config, directory: &Config) -> bool {
        self.before == *before && self.directory == *directory
    }
    pub fn observation(
        &self,
        after: &Config,
        directory: &Config,
        report: Option<&Value>,
    ) -> Result<(Observation, bool)> {
        let matching = mcp_plan::preserved(&self.before, after, &self.intended)
            && mcp_plan::preserved(&self.directory, directory, &self.intended);
        let reported = report
            .map(|r| {
                r.get("enabled")
                    .and_then(Value::as_bool)
                    .ok_or(Code::InvalidOutput)
            })
            .transpose()?;
        let matches_report = report.is_some_and(|r| self.matches_report(r));
        Ok((
            Observation {
                observed_at_ms: now_ms(),
                configuration: if matching { "matching" } else { "different" },
                skill: None,
                mcp: Some(if report.is_none() {
                    "missing"
                } else if matches_report {
                    "matching"
                } else {
                    "different"
                }),
                configured_enabled: Some(mcp_plan::configured(after, self.input.name())),
                reported_enabled: reported,
                parent_outcome: None,
                session_applicability: "unverified",
            },
            matching && matches_report,
        ))
    }
    fn matches_report(&self, r: &Value) -> bool {
        self.input.matches_transport(&r["transport"])
            && r.as_object().is_some_and(|v| {
                v.keys().all(|k| {
                    [
                        "name",
                        "enabled",
                        "disabled_reason",
                        "transport",
                        "enabled_tools",
                        "disabled_tools",
                        "startup_timeout_sec",
                        "tool_timeout_sec",
                        "auth_status",
                    ]
                    .contains(&k.as_str())
                })
            })
            && r["name"] == self.input.name()
            && r["enabled"] == false
            && r.get("disabled_reason").is_none_or(Value::is_null)
            && [
                "enabled_tools",
                "disabled_tools",
                "startup_timeout_sec",
                "tool_timeout_sec",
            ]
            .iter()
            .all(|k| r.get(k).is_none_or(Value::is_null))
    }
}
pub(super) fn parse_report(bytes: &[u8], name: &str) -> Result<Value> {
    use crate::acp_client::extension_inventory::output;
    if bytes.len() > output::STDOUT_LIMIT || !output::bounded_depth(bytes) {
        return Err(Code::OutputLimit.into());
    }
    let v: Value = serde_json::from_slice(bytes).map_err(|_| Code::InvalidOutput)?;
    if v.get("name").and_then(Value::as_str) != Some(name)
        || v.get("enabled").and_then(Value::as_bool).is_none()
        || !v.get("transport").is_some_and(Value::is_object)
    {
        return Err(Code::InvalidOutput.into());
    }
    Ok(v)
}
