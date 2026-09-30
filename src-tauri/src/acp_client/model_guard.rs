//! Farfold-owned selected configuration, never an Agent history or configuration source.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Choice {
    pub id: String,
    pub category: String,
    pub value: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub model: Option<Choice>,
    pub thought_level: Option<Choice>,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigIssue {
    pub category: &'static str,
    pub reason: &'static str,
    pub expected: Option<String>,
    pub current: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigCheck {
    pub status: &'static str,
    pub issues: Vec<ConfigIssue>,
    pub current: Value,
}

fn option_matches(o: &Value, category: &str) -> bool {
    o["category"] == category
        || (o.get("category").is_none()
            && match category {
                "model" => o["id"] == "model",
                _ => o["id"] == "thought_level" || o["id"] == "reasoning_effort",
            })
}
fn invalid_categories(options: &Value) -> Vec<&'static str> {
    ["model", "thought_level"]
        .into_iter()
        .filter(|category| {
            options
                .as_array()
                .is_some_and(|a| a.iter().any(|o| option_matches(o, category)))
                && choice(options, category).is_none()
        })
        .collect()
}
pub(crate) fn choice(options: &Value, category: &str) -> Option<Choice> {
    let entries = options.as_array()?;
    let mut selected = entries.iter().filter(|o| option_matches(o, category));
    let option = selected.next()?;
    if selected.next().is_some() {
        return None;
    }
    Some(Choice {
        id: option["id"].as_str()?.to_owned(),
        category: category.to_owned(),
        value: option["currentValue"].as_str()?.to_owned(),
    })
}
fn snapshot(options: &Value) -> Snapshot {
    Snapshot {
        model: choice(options, "model"),
        thought_level: choice(options, "thought_level"),
    }
}

pub(crate) struct ModelGuard {
    current: Snapshot,
    expected: Snapshot,
    model_known: bool,
    thought_known: bool,
    locked: bool,
    pending: Option<Snapshot>,
    invalid: Vec<&'static str>,
}
impl ModelGuard {
    pub(crate) fn new(options: &Value, recorded: Option<&Value>, restored: bool) -> Self {
        let current = snapshot(options);
        let saved = recorded
            .filter(|v| v["_farfoldConfig"] == 1)
            .and_then(|v| serde_json::from_value::<Snapshot>(v.clone()).ok());
        let mut guard = Self {
            expected: current.clone(),
            current,
            model_known: !restored,
            thought_known: !restored,
            locked: restored,
            pending: None,
            invalid: invalid_categories(options),
        };
        if let Some(saved) = saved {
            guard.expected = saved;
            guard.model_known = true;
            guard.thought_known = true;
        } else if restored {
            guard.expected = Snapshot {
                model: None,
                thought_level: None,
            };
            for category in ["model", "thought_level"] {
                let current = if category == "model" {
                    &guard.current.model
                } else {
                    &guard.current.thought_level
                };
                let id = current.as_ref().map(|v| v.id.as_str()).unwrap_or(category);
                let value = recorded
                    .and_then(|r| r.get(id).or_else(|| r.get(category)))
                    .and_then(Value::as_str);
                if let Some(value) = value {
                    let item = Some(Choice {
                        id: id.into(),
                        category: category.into(),
                        value: value.into(),
                    });
                    if category == "model" {
                        guard.expected.model = item;
                        guard.model_known = true;
                    } else {
                        guard.expected.thought_level = item;
                        guard.thought_known = true;
                    }
                }
            }
        }
        guard
    }
    pub(crate) fn observe(&mut self, options: &Value) {
        self.current = snapshot(options);
        self.invalid = invalid_categories(options);
    }
    pub(crate) fn check(&self) -> ConfigCheck {
        let mut issues = Vec::new();
        if self.locked || !self.invalid.is_empty() {
            for (category, known, expected, current) in [
                (
                    "model",
                    self.model_known,
                    &self.expected.model,
                    &self.current.model,
                ),
                (
                    "thought_level",
                    self.thought_known,
                    &self.expected.thought_level,
                    &self.current.thought_level,
                ),
            ] {
                let before = expected.as_ref().map(|c| c.value.clone());
                let now = current.as_ref().map(|c| c.value.clone());
                let reason = if self.invalid.contains(&category) {
                    Some("missing")
                } else if !known && (category == "model" || current.is_some()) {
                    Some("unrecorded")
                } else if before != now {
                    Some(if current.is_none() {
                        "missing"
                    } else {
                        "changed"
                    })
                } else {
                    None
                };
                if let Some(reason) = reason {
                    issues.push(ConfigIssue {
                        category,
                        reason,
                        expected: before,
                        current: now,
                    });
                }
            }
        }
        let status = if self.pending.is_some() {
            "record_failed"
        } else if issues.is_empty() {
            "ready"
        } else if issues.len() == 1
            && issues[0].category == "thought_level"
            && issues[0].reason == "unrecorded"
        {
            "confirmation_required"
        } else {
            "blocked"
        };
        ConfigCheck {
            status,
            issues,
            current: serde_json::to_value(&self.current).unwrap(),
        }
    }
    pub(crate) fn admissible(&self) -> bool {
        self.check().status == "ready"
    }
    pub(crate) fn current_value(&self) -> Value {
        serde_json::to_value(&self.current).unwrap()
    }
    pub(crate) fn record(&self) -> Value {
        let mut value = self.current_value();
        value["_farfoldConfig"] = json!(1);
        value
    }
    pub(crate) fn lock(&mut self) {
        self.expected = self.current.clone();
        self.model_known = true;
        self.thought_known = true;
        self.locked = true;
        self.pending = None;
    }
    pub(crate) fn record_failed(&mut self) {
        self.pending = Some(self.current.clone());
    }
    pub(crate) fn confirmable(&self, displayed: &Value) -> bool {
        if displayed != &self.current_value() {
            return false;
        }
        self.check().status == "confirmation_required"
            || self.pending.as_ref() == Some(&self.current)
    }
    pub(crate) fn may_set(&self, id: &str) -> bool {
        if !self.locked {
            return true;
        }
        if [
            self.current.model.as_ref(),
            self.expected.model.as_ref(),
            self.current.thought_level.as_ref(),
            self.expected.thought_level.as_ref(),
        ]
        .into_iter()
        .flatten()
        .any(|c| c.id == id)
            || matches!(id, "model" | "thought_level" | "reasoning_effort")
        {
            return false;
        }
        self.admissible()
    }
    pub(crate) fn confirm_saved(&mut self) {
        let locked = self.locked;
        self.lock();
        self.locked = locked;
    }
}

#[derive(Clone)]
pub(crate) struct ConfigStore {
    pub store: crate::meta_store::MetaStore,
    pub agent_id: String,
    pub cwd: String,
    pub service_record: Option<super::service_connection::ServiceRecord>,
    pub expected_model: Option<String>,
    pub verified_permission_option: bool,
}
impl ConfigStore {
    pub(crate) async fn validate_service(&self) -> Result<(), String> {
        if let Some(super::service_connection::ServiceRecord::Configured { identity }) =
            &self.service_record
        {
            let identity = identity.clone();
            self.store
                .run(move |store| crate::credentials::validate_service_identity(store, &identity))
                .await?;
        }
        Ok(())
    }
    pub(crate) fn validate_model(&self, options: &Value) -> Result<(), String> {
        if let Some(expected) = &self.expected_model {
            super::service_config::validate_model(expected, options)?;
        }
        Ok(())
    }
    pub(crate) async fn save(&self, session_id: &str, mut value: Value) -> Result<(), String> {
        if let Some(service) = &self.service_record {
            value["_farfoldService"] =
                serde_json::to_value(service).map_err(|_| "CONFIG_RECORD_FAILED")?;
        }
        let agent = self.agent_id.clone();
        let cwd = self.cwd.clone();
        let id = session_id.to_owned();
        self.store
            .run(move |store| {
                super::session_index::touch_session_row(store, &agent, &cwd, &id, None, Some(value))
                    .map(|_| ())
            })
            .await
            .map_err(|_| "CONFIG_RECORD_FAILED".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn options(model: &str, effort: &str) -> Value {
        json!([{"id":"model","category":"model","currentValue":model}, {"id":"reasoning_effort","category":"thought_level","currentValue":effort}])
    }
    #[test]
    fn same_model_effort_drift_and_missing_option_block() {
        let mut original = ModelGuard::new(&options("m", "low"), None, false);
        original.lock();
        let mut guard = ModelGuard::new(&options("m", "high"), Some(&original.record()), true);
        assert_eq!(guard.check().status, "blocked");
        assert_eq!(guard.check().issues[0].category, "thought_level");
        assert!(!guard.confirmable(&guard.current_value()));
        guard.observe(&options("m", "low"));
        assert!(guard.admissible());
        guard.observe(&json!([{"id":"model","category":"model","currentValue":"m"}]));
        assert!(!guard.admissible());
    }
    #[test]
    fn legacy_requires_explicit_confirmation_only_when_model_matches() {
        let mut guard = ModelGuard::new(&options("m", "high"), Some(&json!({"model":"m"})), true);
        assert_eq!(guard.check().status, "confirmation_required");
        let displayed = guard.current_value();
        assert!(guard.confirmable(&displayed));
        guard.observe(&options("m", "low"));
        assert!(!guard.confirmable(&displayed));
        guard.observe(&options("other", "low"));
        assert_eq!(guard.check().status, "blocked");
        assert!(!guard.confirmable(&guard.current_value()));
        let unknown = ModelGuard::new(&options("m", "low"), None, true);
        assert_eq!(unknown.check().status, "blocked");
    }
    #[test]
    fn draft_locks_only_at_admission_and_notifications_do_not_confirm() {
        let mut guard = ModelGuard::new(&options("a", "low"), None, false);
        guard.observe(&options("b", "high"));
        assert!(guard.admissible());
        guard.lock();
        guard.observe(&options("b", "low"));
        assert!(!guard.admissible());
        assert!(!guard.may_set("reasoning_effort"));
    }
    #[test]
    fn established_and_legacy_choices_cannot_change_reasoning() {
        let mut guard = ModelGuard::new(&options("m", "high"), None, false);
        assert!(guard.may_set("reasoning_effort"));
        guard.lock();
        assert!(!guard.may_set("model"));
        assert!(!guard.may_set("reasoning_effort"));
        assert!(guard.may_set("mode"));
        let legacy = ModelGuard::new(&options("m", "high"), Some(&json!({"model":"m"})), true);
        assert!(!legacy.may_set("reasoning_effort"));
        assert!(legacy.confirmable(&legacy.current_value()));
    }
    #[test]
    fn unavailable_effort_is_not_invented_and_record_failure_is_explicit() {
        let options = json!([{"id":"model","category":"model","currentValue":"m"}]);
        let first = ModelGuard::new(&options, None, false);
        let mut guard = ModelGuard::new(&options, Some(&first.record()), true);
        assert!(guard.admissible());
        guard.record_failed();
        assert_eq!(guard.check().status, "record_failed");
        assert!(guard.confirmable(&guard.current_value()));
        guard.lock();
        assert!(guard.admissible());
    }
}
