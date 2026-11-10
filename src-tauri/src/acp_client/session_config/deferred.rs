//! Response-independent summary of configuration effects during load. Original
//! notifications continue to the existing raw sink in order. This stores only
//! the last replacement, conditional legacy-model effect, and sticky facts;
//! it is not a replay queue or a fabricated response/configuration baseline.
use super::*;
use std::collections::HashSet;
#[derive(Clone, Copy, Default)]
struct Position {
    options: u64,
    initial_model: u64,
    later_model: u64,
}
impl Position {
    fn count(self, initial: bool, models: bool) -> u64 {
        self.options
            .saturating_add(if initial { self.initial_model } else { 0 })
            .saturating_add(if models { self.later_model } else { 0 })
    }
}
#[derive(Default)]
pub(crate) struct Deferred {
    position: Position,
    options: Option<Value>,
    valid_options: Option<Position>,
    invalid_options: Option<Position>,
    initial_model: Option<(Position, Option<String>)>,
    later_model: Option<(Position, Option<String>)>,
    allowing_options: bool,
    models: HashSet<String>,
}
impl Deferred {
    pub(crate) fn observe(&mut self, dispatch: &Dispatch, dialect: Dialect) {
        let Some(update) = SessionConfig::configuration_update(dispatch) else {
            return;
        };
        match update["sessionUpdate"].as_str() {
            Some("config_option_update") => {
                self.position.options = self.position.options.saturating_add(1);
                let options =
                    dialect.options(update.get("configOptions").cloned().unwrap_or(Value::Null));
                if options.is_array() {
                    self.valid_options = Some(self.position);
                } else {
                    self.invalid_options = Some(self.position);
                }
                self.allowing_options |= allows_legacy(Some(&options));
                self.models
                    .extend(crate::acp_client::pump::model_ids(&options));
                self.options = Some(options);
            }
            Some("current_model_update") => {
                let model = update
                    .get("currentModelId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                if self.options.is_none() {
                    self.position.initial_model = self.position.initial_model.saturating_add(1);
                    self.initial_model = Some((self.position, model));
                } else if allows_legacy(self.options.as_ref()) {
                    self.position.later_model = self.position.later_model.saturating_add(1);
                    self.later_model = Some((self.position, model));
                }
            }
            _ => {}
        }
    }
    /// Apply after the real response has established the original baseline.
    /// No mutation was in flight while loading, so only these latest revision
    /// positions and sticky invalid-shape fact can affect later prepare/complete.
    pub(crate) fn apply(self, config: &mut SessionConfig) -> (HashSet<String>, bool) {
        let initial = config.legacy_option().is_some();
        let available = SessionConfig {
            models: config.models.clone(),
            ..Default::default()
        }
        .legacy_option()
        .is_some();
        let initial_ids = if initial && self.initial_model.is_some() {
            crate::acp_client::pump::model_ids(config.options().as_ref().unwrap_or(&Value::Null))
        } else {
            HashSet::new()
        };
        let before = config.revision;
        let at = |position: Position| before.saturating_add(position.count(initial, available));
        if let Some(options) = self.options {
            config.options = Some(options);
        }
        if let Some(position) = self.valid_options {
            config.options_revision = at(position);
        }
        if let Some(position) = self.invalid_options {
            config.invalid_options_revision = at(position);
        }
        let model = if available { self.later_model } else { None }.or(if initial {
            self.initial_model
        } else {
            None
        });
        if let Some((position, value)) = model {
            config.model_update = Some((at(position), value.clone()));
            if let Some(models) = &mut config.models {
                models["currentModelId"] = value.map(Value::String).unwrap_or(Value::Null);
            }
        }
        config.revision = at(self.position);
        let mut models = self.models;
        models.extend(initial_ids);
        if available && self.allowing_options {
            models.insert(LEGACY_MODEL_ID.to_owned());
        }
        (models, self.invalid_options.is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn dispatch(update: Value) -> Dispatch {
        Dispatch::Notification(
            UntypedMessage::new("session/update", json!({"sessionId":"s","update":update}))
                .unwrap(),
        )
    }
    #[test]
    fn response_dependent_summary_matches_every_original_configuration_effect() {
        let updates = [
            json!({"sessionUpdate":"current_model_update","currentModelId":"second"}),
            json!({"sessionUpdate":"config_option_update","configOptions":null}),
            json!({"sessionUpdate":"current_model_update","currentModelId":"ignored"}),
            json!({"sessionUpdate":"config_option_update","configOptions":[{"id":"thought_level","category":"thought_level","currentValue":"high"}]}),
            json!({"sessionUpdate":"current_model_update","currentModelId":"third"}),
            json!({"sessionUpdate":"config_option_update","configOptions":[{"id":"model","category":"model","currentValue":"real"}]}),
            json!({"sessionUpdate":"current_model_update","currentModelId":"ignored-again"}),
            json!({"sessionUpdate":"config_option_update","configOptions":[]}),
            json!({"sessionUpdate":"current_model_update"}),
        ];
        for initial in [
            Value::Null,
            json!([]),
            json!([{"id":"model","category":"model","currentValue":"initial"}]),
        ] {
            for models in [
                Value::Null,
                json!({"currentModelId":"first","availableModels":[{"modelId":"first","name":"one"}]}),
            ] {
                for length in 0..=updates.len() {
                    for absent in [false, true] {
                        let mut response = json!({"configOptions":initial,"models":models});
                        if absent {
                            response.as_object_mut().unwrap().remove("configOptions");
                        }
                        let mut expected = SessionConfig::from_response(&response);
                        let mut actual = expected.clone();
                        let mut deferred = Deferred::default();
                        let mut expected_ids = HashSet::new();
                        let mut invalid = false;
                        for update in &updates[..length] {
                            let event = dispatch(update.clone());
                            if let Some(options) = expected.observe(&event) {
                                expected_ids.extend(crate::acp_client::pump::model_ids(&options));
                                invalid |= !options.is_array();
                            }
                            deferred.observe(&event, Dialect::Standard);
                        }
                        let (ids, actual_invalid) = deferred.apply(&mut actual);
                        assert_eq!(actual.options(), expected.options(), "prefix {length}");
                        assert_eq!(actual.models, expected.models);
                        assert_eq!(actual.revision, expected.revision);
                        assert_eq!(actual.options_revision, expected.options_revision);
                        assert_eq!(
                            actual.invalid_options_revision,
                            expected.invalid_options_revision
                        );
                        assert_eq!(actual.model_update, expected.model_update);
                        assert_eq!(ids, expected_ids);
                        assert_eq!(actual_invalid, invalid);
                    }
                }
            }
        }
    }
}
