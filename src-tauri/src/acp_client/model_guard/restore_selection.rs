//! A caller's saved or explicitly selected values, never inferred from current values.
use super::*;
use crate::acp_client::restore_confirmation::Code;

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
            .ok_or(Code::SelectionInvalid)?;
        if !self.admissible() {
            return Err(Code::GuardNotReady.into());
        }
        if displayed != &self.current_value() {
            return Err(Code::DisplayedChanged.into());
        }
        let options = options.as_array().ok_or(Code::OptionsInvalid)?;
        // All reported protected values must have a real, unambiguous select
        // declaration. Extra values may be inherited; they are not called saved.
        for choice in &self.current.choices {
            let mut declarations = options.iter().filter(|option| option["id"] == choice.id);
            let option = declarations.next().ok_or(Code::DeclarationMissing)?;
            if declarations.next().is_some() {
                return Err(Code::DeclarationDuplicate.into());
            }
            if option["type"] != "select" {
                return Err(Code::DeclarationType.into());
            }
            if option["currentValue"] != choice.value {
                return Err(Code::DeclarationValue.into());
            }
            if !option["options"].is_array() {
                return Err(Code::DeclarationOptions.into());
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
                .ok_or(Code::SelectedMissing)?;
            if value.as_str() != Some(choice.value.as_str()) {
                return Err(Code::SelectedMismatch.into());
            }
            explicit = true;
        }
        if !explicit {
            return Err(Code::NoProtectedSelection.into());
        }
        let mut confirmed = self.clone();
        confirmed.lock();
        Ok(confirmed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> Value {
        json!([{"id":"private-model-id","category":"model","type":"select",
            "currentValue":"PRIVATE_MODEL_ACCOUNT_KEY_DIRECTORY_CANARY","options":[]}])
    }

    #[test]
    fn restore_guard_classifies_original_checks_in_order_without_private_values() {
        let options = options();
        let guard = ModelGuard::new(&options, None, false);
        let selection = json!({"private-model-id":"PRIVATE_MODEL_ACCOUNT_KEY_DIRECTORY_CANARY"});
        let displayed = guard.current_value();
        let reject = |guard: &ModelGuard,
                      displayed: &Value,
                      selection: &Value,
                      options: &Value,
                      code: Code| {
            let error = guard
                .confirm_restored_selection(displayed, selection, options)
                .err()
                .unwrap();
            assert_eq!(error, code.as_str());
            assert!(!error.contains("PRIVATE_MODEL"));
            assert!(!error.contains("private-model-id"));
        };
        reject(
            &guard,
            &displayed,
            &json!({}),
            &options,
            Code::SelectionInvalid,
        );
        reject(
            &guard,
            &displayed,
            &json!([]),
            &options,
            Code::SelectionInvalid,
        );
        let mut unknown = guard.clone();
        unknown.change_unknown();
        reject(
            &unknown,
            &json!({"private":"PRIVATE_CANARY"}),
            &selection,
            &options,
            Code::GuardNotReady,
        );
        reject(
            &guard,
            &json!({"private":"PRIVATE_CANARY"}),
            &selection,
            &options,
            Code::DisplayedChanged,
        );
        reject(
            &guard,
            &displayed,
            &selection,
            &Value::Null,
            Code::OptionsInvalid,
        );
        reject(
            &guard,
            &displayed,
            &selection,
            &json!([]),
            Code::DeclarationMissing,
        );
        reject(
            &guard,
            &displayed,
            &selection,
            &json!([options[0].clone(), options[0].clone()]),
            Code::DeclarationDuplicate,
        );
        for (field, value, code) in [
            (
                "type",
                json!("PRIVATE_NONSELECT_TYPE"),
                Code::DeclarationType,
            ),
            (
                "currentValue",
                json!("PRIVATE_WRONG_VALUE"),
                Code::DeclarationValue,
            ),
            ("options", Value::Null, Code::DeclarationOptions),
        ] {
            let mut invalid = options.clone();
            invalid[0][field] = value;
            reject(&guard, &displayed, &selection, &invalid, code);
        }
        reject(
            &guard,
            &displayed,
            &json!({"private-model-id":"PRIVATE_WRONG_VALUE"}),
            &options,
            Code::SelectedMismatch,
        );
        reject(
            &guard,
            &displayed,
            &json!({"private-model-id":true}),
            &options,
            Code::SelectedMismatch,
        );
        reject(
            &guard,
            &displayed,
            &json!({"private-unprotected":"PRIVATE_CANARY"}),
            &options,
            Code::NoProtectedSelection,
        );
        let confirmed = guard
            .confirm_restored_selection(&displayed, &selection, &options)
            .unwrap();
        assert!(confirmed.admissible());
        assert!(!confirmed.is_established());
        assert_eq!(confirmed.current_value(), displayed);
        // A successful confirmation protects the current choices without making
        // an unprotected selection authoritative or publishing a session index.
        assert_eq!(confirmed.expected, guard.current);
    }
}
