use serde_json::Value;

use super::{super::handshake::Handshake, Dialect};

pub(in crate::acp_client) const THINKING_ID: &str = "thinking";

impl Dialect {
    /// `None` is an unrelated Agent. A Vibe registration still needs its
    /// matching managed installation and a handshake from that same process.
    pub(crate) fn for_connection(managed_vibe: Option<bool>, handshake: &Handshake) -> Self {
        if managed_vibe.is_none() {
            Self::Standard
        } else if managed_vibe == Some(true)
            && handshake
                .typed
                .agent_info
                .as_ref()
                .is_some_and(|info| info.name == "@mistralai/mistral-vibe")
        {
            Self::Vibe
        } else {
            Self::UnverifiedVibe
        }
    }

    pub(crate) fn is_vibe_family(self) -> bool {
        matches!(self, Self::Vibe | Self::UnverifiedVibe)
    }

    pub(crate) fn is_vibe_thinking(self, id: &str) -> bool {
        self == Self::Vibe && id == THINKING_ID
    }

    /// The reviewed Vibe wire category is `thinking`. Convert the separate
    /// client view only; the original request and notification stay intact.
    /// A malformed or conflicting Vibe declaration uses the existing invalid
    /// full-configuration path, instead of quietly dropping one selector.
    pub(super) fn options(self, mut options: Value) -> Value {
        if !self.is_vibe_family() {
            return options;
        }
        let Some(entries) = options.as_array_mut() else {
            return options;
        };
        let mut candidates = entries
            .iter()
            .enumerate()
            .filter(|(_, entry)| entry["id"] == THINKING_ID || entry["category"] == THINKING_ID);
        let Some((index, candidate)) = candidates.next() else {
            return options;
        };
        if self == Self::UnverifiedVibe
            || candidates.next().is_some()
            || !valid_thinking(candidate)
            || entries.iter().enumerate().any(|(other, option)| {
                other != index
                    && (option["id"] == THINKING_ID
                        || option["category"] == "thought_level"
                        || (option["category"].is_null()
                            && matches!(
                                option["id"].as_str(),
                                Some("thought_level" | "reasoning_effort")
                            )))
            })
        {
            return Value::Null;
        }
        entries[index]["category"] = Value::String("thought_level".into());
        options
    }
}

fn nonempty(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|text| !text.trim().is_empty() && !text.chars().any(char::is_control))
}

fn valid_thinking(option: &Value) -> bool {
    if option["id"] != THINKING_ID
        || !matches!(
            option["category"].as_str(),
            Some(THINKING_ID | "thought_level")
        )
        || option["type"] != "select"
        || nonempty(&option["name"]).is_none()
    {
        return false;
    }
    let (Some(current), Some(choices)) = (
        nonempty(&option["currentValue"]),
        option["options"].as_array(),
    ) else {
        return false;
    };
    let mut values = std::collections::BTreeSet::new();
    choices.iter().all(|choice| {
        choice.get("options").is_none()
            && nonempty(&choice["name"]).is_some()
            && nonempty(&choice["value"]).is_some_and(|value| values.insert(value))
    }) && values.contains(current)
}
