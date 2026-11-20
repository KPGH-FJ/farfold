//! Identify the two official Pi declarations of the same thinking setting.

use std::collections::BTreeSet;

use serde_json::Value;

use super::super::{handshake::Handshake, recipes};
use crate::meta_store::AgentRow;

pub(in crate::acp_client) fn reviewed_component(
    row: &AgentRow,
    handshake: Option<&Handshake>,
) -> bool {
    let Some(info) = handshake.and_then(|value| value.typed.agent_info.as_ref()) else {
        return false;
    };
    matches!(row.id.as_str(), "pi" | "registry:pi-acp")
        && info.name == "pi-acp"
        && row
            .version
            .as_deref()
            .is_none_or(|version| version == info.version)
        && recipes::component_version(row).as_deref() == Some(info.version.as_str())
}

fn level(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| {
        !text.is_empty() && text.len() <= 32 && text.bytes().all(|byte| byte.is_ascii_lowercase())
    })
}

fn levels<'a>(list: &'a Value, key: &str) -> Option<BTreeSet<&'a str>> {
    let mut values = BTreeSet::new();
    for item in list.as_array()? {
        if !values.insert(level(item.get(key)?)?) {
            return None;
        }
    }
    Some(values)
}

/// The same official session/new response must declare both controls identically.
/// A real mode or another thinking declaration cannot be treated as a mirror.
pub(in crate::acp_client) fn declared_thought_mode_mirror(response: &Value) -> Option<String> {
    let modes = response.get("modes")?;
    let current = level(modes.get("currentModeId")?)?;
    let legacy = levels(modes.get("availableModes")?, "id")?;
    let entries = response.get("configOptions")?.as_array()?;
    if entries
        .iter()
        .any(|option| option["id"] == "mode" || option["category"] == "mode")
    {
        return None;
    }
    let mut thinking = entries
        .iter()
        .filter(|option| option["id"] == "thought_level" || option["category"] == "thought_level");
    let option = thinking.next()?;
    if thinking.next().is_some()
        || option["id"] != "thought_level"
        || option["category"] != "thought_level"
        || option["type"] != "select"
        || level(option.get("currentValue")?)? != current
        || !legacy.contains(current)
        || levels(option.get("options")?, "value")? != legacy
    {
        return None;
    }
    Some(current.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn response() -> Value {
        json!({
            "modes": {
                "currentModeId": "off",
                "availableModes": [{"id": "off"}, {"id": "medium"}]
            },
            "configOptions": [{
                "id": "thought_level", "category": "thought_level", "type": "select",
                "currentValue": "off", "options": [{"value": "medium"}, {"value": "off"}]
            }]
        })
    }

    #[test]
    fn requires_equivalent_unambiguous_declarations_in_one_response() {
        assert_eq!(
            declared_thought_mode_mirror(&response()).as_deref(),
            Some("off")
        );
        for (path, replacement) in [
            ("/modes", Value::Null),
            ("/modes/currentModeId", json!("medium")),
            ("/modes/availableModes/1/id", json!("high")),
            ("/configOptions/0/type", json!("boolean")),
            ("/configOptions/0/options/0/value", json!("off")),
        ] {
            let mut disputed = response();
            *disputed.pointer_mut(path).unwrap() = replacement;
            assert_eq!(declared_thought_mode_mirror(&disputed), None, "{path}");
        }
        for extra in [json!({"id": "mode"}), json!({"category": "thought_level"})] {
            let mut disputed = response();
            disputed["configOptions"]
                .as_array_mut()
                .unwrap()
                .push(extra);
            assert_eq!(declared_thought_mode_mirror(&disputed), None);
        }
    }

    #[test]
    fn requires_the_selected_official_pi_component_on_the_same_handshake() {
        let root = tempfile::tempdir().unwrap();
        let mut row = recipes::tests::official_row(root.path(), "pi", "pi-acp", "0.0.34");
        let handshake = |name: &str, version: &str| {
            Handshake::decode(json!({
                "protocolVersion": 1, "agentInfo": {"name": name, "version": version}
            }))
            .unwrap()
        };
        let pi = handshake("pi-acp", "0.0.34");
        assert!(reviewed_component(&row, Some(&pi)));
        assert!(!reviewed_component(&row, None));
        assert!(!reviewed_component(
            &row,
            Some(&handshake("custom", "0.0.34"))
        ));
        assert!(!reviewed_component(
            &row,
            Some(&handshake("pi-acp", "0.0.35"))
        ));
        row.source = "manual".into();
        assert!(!reviewed_component(&row, Some(&pi)));
    }
}
