//! Farfold-owned selected configuration, never an Agent history or configuration source.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

mod format;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Choice {
    pub id: String,
    pub category: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub value: String,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct Snapshot {
    pub choices: Vec<Choice>,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigIssue {
    pub category: &'static str,
    pub reason: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub expected: Option<String>,
    pub current: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigCheck {
    pub status: &'static str,
    pub issues: Vec<ConfigIssue>,
    pub current: Value,
    pub protected_ids: Vec<String>,
}

fn category(value: &str) -> &'static str {
    if value == "thought_level" {
        "thought_level"
    } else {
        "model"
    }
}
fn issue(
    category: &'static str,
    id: Option<String>,
    reason: &'static str,
    expected: Option<String>,
    current: Option<String>,
) -> ConfigIssue {
    ConfigIssue {
        category,
        reason,
        id,
        expected,
        current,
    }
}

pub(crate) struct ModelGuard {
    current: Snapshot,
    expected: Snapshot,
    model_known: bool,
    locked: bool,
    pending: Option<Snapshot>,
    invalid: Vec<ConfigIssue>,
    record_invalid: bool,
    declared_ids: BTreeSet<String>,
    unclassified_ids: BTreeSet<String>,
}
impl ModelGuard {
    pub(crate) fn new(options: &Value, recorded: Option<&Value>, restored: bool) -> Self {
        let (current, _, _) = format::observe(options, &Snapshot::default());
        let baseline = if restored {
            format::baseline(recorded, &current, options)
        } else {
            format::Baseline {
                snapshot: current.clone(),
                model_known: true,
                invalid: false,
                unclassified_ids: BTreeSet::new(),
            }
        };
        let (current, invalid, declared_ids) = format::observe(options, &baseline.snapshot);
        Self {
            current,
            expected: baseline.snapshot,
            model_known: baseline.model_known,
            locked: restored,
            pending: None,
            invalid,
            record_invalid: baseline.invalid,
            declared_ids,
            unclassified_ids: baseline.unclassified_ids,
        }
    }
    pub(crate) fn observe(&mut self, options: &Value) {
        (self.current, self.invalid, self.declared_ids) = format::observe(options, &self.expected);
    }
    pub(crate) fn protected_ids(&self) -> Vec<String> {
        self.declared_ids
            .iter()
            .cloned()
            .chain(self.expected.choices.iter().map(|c| c.id.clone()))
            .chain(self.unclassified_ids.iter().cloned())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }
    /// API selection still requires one exact, unambiguous model choice.
    pub(crate) fn single_model_value(&self) -> Option<&str> {
        let mut models = self
            .current
            .choices
            .iter()
            .filter(|c| c.category == "model");
        let value = &models.next()?.value;
        models.next().is_none().then_some(value.as_str())
    }
    pub(crate) fn check(&self) -> ConfigCheck {
        let mut issues = self.invalid.clone();
        if self.record_invalid {
            issues.push(issue("model", None, "missing", None, None));
        } else if self.locked {
            for expected in &self.expected.choices {
                let current = self.current.choices.iter().find(|c| c.id == expected.id);
                let reason = match current {
                    None => Some("missing"),
                    Some(current)
                        if current.kind != expected.kind || current.value != expected.value =>
                    {
                        Some("changed")
                    }
                    _ => None,
                };
                if let Some(reason) = reason {
                    issues.push(issue(
                        category(&expected.category),
                        Some(expected.id.clone()),
                        reason,
                        Some(expected.value.clone()),
                        current.map(|c| c.value.clone()),
                    ));
                }
            }
            for current in &self.current.choices {
                if !self.expected.choices.iter().any(|c| c.id == current.id) {
                    issues.push(issue(
                        category(&current.category),
                        Some(current.id.clone()),
                        "unrecorded",
                        None,
                        Some(current.value.clone()),
                    ));
                }
            }
            if !self.model_known && !issues.iter().any(|i| i.category == "model") {
                issues.push(issue("model", None, "unrecorded", None, None));
            }
        }
        let status = if self.record_invalid || !self.invalid.is_empty() {
            "blocked"
        } else if self.pending.is_some() {
            "record_failed"
        } else if issues.is_empty() {
            "ready"
        } else if issues
            .iter()
            .all(|i| i.category == "thought_level" && i.reason == "unrecorded")
        {
            "confirmation_required"
        } else {
            "blocked"
        };
        ConfigCheck {
            status,
            issues,
            current: self.current_value(),
            protected_ids: self.protected_ids(),
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
        value["_farfoldConfig"] = json!(2);
        value
    }
    pub(crate) fn lock(&mut self) {
        self.expected = self.current.clone();
        self.model_known = true;
        self.locked = true;
        self.pending = None;
    }
    pub(crate) fn record_failed(&mut self) {
        self.pending = Some(self.current.clone());
    }
    pub(crate) fn confirmable(&self, displayed: &Value) -> bool {
        if displayed != &self.current_value() || self.record_invalid || !self.invalid.is_empty() {
            return false;
        }
        let check = self.check();
        check.status == "confirmation_required"
            || (self.pending.as_ref() == Some(&self.current)
                && check
                    .issues
                    .iter()
                    .all(|i| i.category == "thought_level" && i.reason == "unrecorded"))
    }
    pub(crate) fn may_set(&self, id: &str) -> bool {
        if !self.locked {
            return true;
        }
        if self.protected_ids().iter().any(|saved| saved == id)
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
