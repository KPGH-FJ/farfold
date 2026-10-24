//! A caller's saved or explicitly selected values, never inferred from current values.
use super::*;

const UNCONFIRMED: &str = "当前设置已变化或无法确认，请重新检查";

impl ModelGuard {
    /// Protect the one existing snapshot without publishing a conversation index.
    /// The frontend separately verifies every original key, including legacy
    /// synthetic modes not present in the native model/thought declaration.
    pub(crate) fn confirm_restored_selection(
        &self,
        displayed: &Value,
        selection: &Value,
        options: &Value,
    ) -> Result<Self, String> {
        let selected = selection
            .as_object()
            .filter(|map| !map.is_empty())
            .ok_or(UNCONFIRMED)?;
        if !self.admissible() || displayed != &self.current_value() {
            return Err(UNCONFIRMED.into());
        }
        let options = options.as_array().ok_or(UNCONFIRMED)?;
        // All reported protected values must have a real, unambiguous select
        // declaration. Extra values may be inherited; they are not called saved.
        for choice in &self.current.choices {
            let mut declarations = options.iter().filter(|option| option["id"] == choice.id);
            let option = declarations.next().ok_or(UNCONFIRMED)?;
            if declarations.next().is_some()
                || option["type"] != "select"
                || option["currentValue"] != choice.value
                || !option["options"].is_array()
            {
                return Err(UNCONFIRMED.into());
            }
        }
        let protected = self.protected_ids();
        let mut explicit = false;
        for (id, value) in selected {
            if !protected.contains(id) {
                continue;
            }
            let choice = self
                .current
                .choices
                .iter()
                .find(|choice| &choice.id == id)
                .ok_or(UNCONFIRMED)?;
            if value.as_str() != Some(choice.value.as_str()) {
                return Err(UNCONFIRMED.into());
            }
            explicit = true;
        }
        if !explicit {
            return Err(UNCONFIRMED.into());
        }
        let mut confirmed = self.clone();
        confirmed.lock();
        Ok(confirmed)
    }
}
