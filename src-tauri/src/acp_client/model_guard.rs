//! Farfold-owned selected configuration, never an Agent history or configuration source.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

mod format;
mod restore_selection;

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

#[derive(Clone)]
pub(crate) struct ModelGuard {
    dialect: super::session_config::Dialect,
    current: Snapshot,
    expected: Snapshot,
    model_known: bool,
    empty_existing_record: bool,
    explicit_model: bool,
    locked: bool,
    established: bool,
    pending: Option<Snapshot>,
    authorized_change: Option<Snapshot>,
    change_unknown: bool,
    invalid: Vec<ConfigIssue>,
    record_invalid: bool,
    declared_ids: BTreeSet<String>,
    unclassified_ids: BTreeSet<String>,
}
impl ModelGuard {
    pub(crate) fn new(options: &Value, recorded: Option<&Value>, restored: bool) -> Self {
        Self::for_connection(options, recorded, restored, Default::default())
    }

    pub(crate) fn for_connection(
        options: &Value,
        recorded: Option<&Value>,
        restored: bool,
        dialect: super::session_config::Dialect,
    ) -> Self {
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
        let explicit_model = explicit_model(options, &current, dialect);
        Self {
            dialect,
            current,
            expected: baseline.snapshot,
            model_known: baseline.model_known,
            empty_existing_record: restored && recorded == Some(&empty_existing_record()),
            explicit_model,
            locked: restored,
            established: restored,
            pending: None,
            authorized_change: None,
            change_unknown: false,
            invalid,
            record_invalid: baseline.invalid,
            declared_ids,
            unclassified_ids: baseline.unclassified_ids,
        }
    }
    pub(crate) fn observe(&mut self, options: &Value) {
        (self.current, self.invalid, self.declared_ids) = format::observe(options, &self.expected);
        self.explicit_model = explicit_model(options, &self.current, self.dialect);
    }
    pub(crate) fn needs_model_record(&self) -> bool {
        self.empty_existing_record
            && self.expected.choices.is_empty()
            && self.explicit_model
            && self.invalid.is_empty()
            && !self.change_unknown
            && self.pending.is_none()
    }

    pub(crate) fn can_record_model(&self, modern_options: Option<&Value>) -> bool {
        self.needs_model_record()
            && modern_options
                .is_some_and(|options| explicit_model(options, &self.current, self.dialect))
    }
    pub(crate) fn is_established(&self) -> bool {
        self.established
    }
    pub(crate) fn choice_request(&self, id: &str, value: &Value) -> Result<Option<Choice>, String> {
        if !self.may_set(id) {
            return Err("当前模型或思考选择尚未确认，请检查后重试".into());
        }
        let Some(current) = self.current.choices.iter().find(|choice| choice.id == id) else {
            if self.protected_ids().iter().any(|saved| saved == id)
                || matches!(id, "model" | "thought_level" | "reasoning_effort")
                || self.dialect.is_vibe_thinking(id)
            {
                return Err("无法读取当前模型或思考选择，请检查后重试".into());
            }
            return Ok(None);
        };
        let value = value.as_str().ok_or("模型或思考选项的值无效，请重新选择")?;
        Ok(Some(Choice {
            value: value.to_owned(),
            ..current.clone()
        }))
    }
    /// A successful explicit setting reply can propose a new baseline. Ordinary
    /// option notifications cannot authorize either the change or a failed-save retry.
    pub(crate) fn confirmed_change(
        &self,
        requested: &Choice,
        options: &Value,
    ) -> Result<Self, String> {
        let error = "Agent 未确认所选模型或思考深度，请检查后重试";
        if self.record_invalid || self.change_unknown || self.pending.is_some() {
            return Err(error.into());
        }
        let baseline = if self.locked {
            &self.expected
        } else {
            &self.current
        };
        if !baseline.choices.iter().any(|choice| {
            choice.id == requested.id
                && choice.category == requested.category
                && choice.kind == requested.kind
        }) {
            return Err(error.into());
        }
        let mut candidate = self.clone();
        candidate.observe(options);
        if candidate.record_invalid
            || !candidate.invalid.is_empty()
            || !candidate.current.choices.contains(requested)
        {
            return Err(error.into());
        }
        let mut expected_models = baseline
            .choices
            .iter()
            .filter(|choice| choice.category == "model")
            .cloned()
            .collect::<Vec<_>>();
        if requested.category == "model" {
            let Some(model) = expected_models
                .iter_mut()
                .find(|choice| choice.id == requested.id)
            else {
                return Err(error.into());
            };
            *model = requested.clone();
        }
        let actual_models = candidate
            .current
            .choices
            .iter()
            .filter(|choice| choice.category == "model")
            .cloned()
            .collect::<Vec<_>>();
        if actual_models != expected_models {
            return Err(error.into());
        }
        candidate.pending = None;
        candidate.authorized_change = Some(candidate.current.clone());
        Ok(candidate)
    }
    pub(crate) fn change_unknown(&mut self) {
        self.change_unknown = true;
        self.pending = None;
        self.authorized_change = None;
    }
    pub(crate) fn blocks_vibe_restore(&self) -> bool {
        self.dialect.is_vibe_family() && self.change_unknown
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
        if self.change_unknown {
            issues.push(issue("model", None, "unknown", None, None));
        }
        let status = if self.change_unknown || self.record_invalid || !self.invalid.is_empty() {
            "blocked"
        } else if self.pending.is_some() {
            "record_failed"
        } else if issues.is_empty() {
            "ready"
        } else if self.needs_model_record()
            || issues
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
        self.authorized_change = None;
        self.change_unknown = false;
    }
    /// Only a successful session-index save establishes a conversation.
    pub(crate) fn saved_session(&mut self) {
        self.established = true;
        self.lock();
    }
    pub(crate) fn record_failed(&mut self) {
        self.pending = Some(self.current.clone());
        self.authorized_change = None;
    }
    pub(crate) fn record_failed_change(&mut self) {
        if !self.change_unknown
            && !self.record_invalid
            && self.invalid.is_empty()
            && self.authorized_change.as_ref() == Some(&self.current)
        {
            self.pending = Some(self.current.clone());
        } else {
            self.change_unknown();
        }
    }
    pub(crate) fn confirmable(&self, displayed: &Value) -> bool {
        if self.change_unknown
            || displayed != &self.current_value()
            || self.record_invalid
            || !self.invalid.is_empty()
        {
            return false;
        }
        let check = self.check();
        check.status == "confirmation_required"
            || (self.pending.as_ref() == Some(&self.current)
                && (self.authorized_change.as_ref() == Some(&self.current)
                    || check
                        .issues
                        .iter()
                        .all(|i| i.category == "thought_level" && i.reason == "unrecorded")))
    }
    pub(crate) fn may_set(&self, _id: &str) -> bool {
        if self.change_unknown {
            return false;
        }
        if !self.locked {
            return true;
        }
        self.admissible()
    }
    pub(crate) fn confirm_saved(&mut self) {
        let locked = self.locked;
        self.lock();
        self.locked = locked;
    }
}

fn empty_existing_record() -> Value {
    json!({"_farfoldConfig":2,"_farfoldService":{"kind":"existing"},"choices":[]})
}

fn explicit_model(
    options: &Value,
    snapshot: &Snapshot,
    dialect: super::session_config::Dialect,
) -> bool {
    let mut models = snapshot
        .choices
        .iter()
        .filter(|choice| choice.category == "model");
    let Some(choice) = models.next() else {
        return false;
    };
    if models.next().is_some()
        || choice.value.trim().is_empty()
        || choice.id == super::session_config::LEGACY_MODEL_ID
    {
        return false;
    }
    let reviewed_vibe_pair = dialect == super::session_config::Dialect::Vibe
        && snapshot.choices.len() == 2
        && snapshot.choices.iter().any(|entry| {
            entry.id == super::session_config::THINKING_ID && entry.category == "thought_level"
        });
    if snapshot.choices.len() != 1 && !reviewed_vibe_pair {
        return false;
    }
    fn matching_choices(entries: &[Value], value: &str) -> Option<bool> {
        let named = |item: &Value| {
            item["name"]
                .as_str()
                .is_some_and(|name| !name.trim().is_empty())
        };
        let mut selected = Vec::new();
        for entry in entries {
            if !named(entry) {
                return None;
            }
            if let Some(leaf) = entry["value"].as_str() {
                if entry.get("options").is_some() {
                    return None;
                }
                if leaf == value {
                    selected.push((entry["name"].as_str()?, false));
                }
            } else {
                entry["group"].as_str()?;
                for leaf in entry["options"].as_array()? {
                    if !named(leaf) || leaf.get("options").is_some() {
                        return None;
                    }
                    if leaf["value"].as_str()? == value {
                        selected.push((leaf["name"].as_str()?, true));
                    }
                }
            }
        }
        // Only the wire value is written. Agents may repeat the same value
        // with the same display name but different descriptive metadata.
        Some(match selected.as_slice() {
            [] => false,
            [_] => true,
            [(label, false), rest @ ..] => rest.iter().all(|choice| choice == &(*label, false)),
            _ => false,
        })
    }
    options.as_array().is_some_and(|entries| {
        entries.iter().any(|entry| {
            entry["id"] == choice.id
                && entry["category"] == "model"
                && entry["type"] == "select"
                && entry["name"]
                    .as_str()
                    .is_some_and(|name| !name.trim().is_empty())
                && entry["currentValue"] == choice.value
                && entry["options"]
                    .as_array()
                    .and_then(|entries| matching_choices(entries, &choice.value))
                    == Some(true)
        })
    })
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
    pub(crate) async fn save_missing_model(
        &self,
        session_id: &str,
        mut value: Value,
    ) -> Result<(), String> {
        if self.service_record != Some(super::service_connection::ServiceRecord::Existing)
            || self.expected_model.is_some()
        {
            return Err("无法确认此对话的原服务来源，请重新检查".into());
        }
        value["_farfoldService"] = json!({"kind":"existing"});
        let id = super::session_index::session_row_id(&self.agent_id, &self.cwd, session_id);
        let owner = (
            self.agent_id.clone(),
            self.cwd.clone(),
            session_id.to_owned(),
        );
        self.store
            .run(move |store| {
                store.compare_session_config(&id, owner, &empty_existing_record(), &value)
            })
            .await
    }

    pub(crate) async fn for_choice(&self, choice: Option<&Choice>) -> Result<Self, String> {
        let mut candidate = self.clone();
        let Some(choice) = choice.filter(|choice| choice.category == "model") else {
            return Ok(candidate);
        };
        let Some(super::service_connection::ServiceRecord::Configured { identity }) =
            &mut candidate.service_record
        else {
            return Ok(candidate);
        };
        let error = "请选择此对话当前 API 服务中的模型";
        let expected = self.expected_model.as_deref().ok_or(error)?;
        if identity.model.is_empty() || choice.kind != "select" {
            return Err(error.into());
        }
        let prefix = expected.strip_suffix(&identity.model).ok_or(error)?;
        let model = choice.value.strip_prefix(prefix).ok_or(error)?;
        if model.trim().is_empty() {
            return Err(error.into());
        }
        identity.model = model.to_owned();
        candidate.expected_model = Some(choice.value.clone());
        candidate.validate_service().await?;
        Ok(candidate)
    }
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
    pub(crate) fn record_with_source(&self, mut value: Value) -> Result<Value, String> {
        if let Some(service) = &self.service_record {
            value["_farfoldService"] =
                serde_json::to_value(service).map_err(|_| "CONFIG_RECORD_FAILED")?;
        }
        Ok(value)
    }
    pub(crate) async fn save(&self, session_id: &str, value: Value) -> Result<(), String> {
        let value = self.record_with_source(value)?;
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
    pub(crate) async fn save_initial(
        &self,
        session_id: &str,
        value: Value,
        previous: Option<crate::meta_store::SessionRow>,
    ) -> Result<crate::meta_store::SessionRow, crate::meta_store::InitialConfigError> {
        use crate::meta_store::InitialConfigError::SaveFailed;
        let now = super::session_index::now_millis();
        let row = crate::meta_store::SessionRow {
            id: super::session_index::session_row_id(&self.agent_id, &self.cwd, session_id),
            agent_id: self.agent_id.clone(),
            cwd: self.cwd.clone(),
            native_session_id: Some(session_id.to_owned()),
            title: None,
            config_options: Some(self.record_with_source(value).map_err(|_| SaveFailed)?),
            pinned: false,
            archived: false,
            created_at: now,
            updated_at: now,
        };
        self.store
            .run(move |store| Ok(store.save_initial_session_config(&row, previous.as_ref())))
            .await
            .map_err(|_| SaveFailed)?
    }
}

#[cfg(test)]
mod change_tests;

#[cfg(test)]
mod switch_transport_tests;

#[cfg(test)]
mod tests {
    use super::*;
    fn options(model: &str, effort: &str) -> Value {
        json!([{"id":"model","category":"model","currentValue":model}, {"id":"reasoning_effort","category":"thought_level","currentValue":effort}])
    }
    #[test]
    fn missing_model_record_requires_an_explicit_unambiguous_current_choice() {
        let record = empty_existing_record();
        let mut options = json!([{"id":"model","name":"Model","category":"model","type":"select","currentValue":"auto","options":[{"value":"auto","name":"Auto"}]}]);
        let mut guard = ModelGuard::new(&options, Some(&record), true);
        assert_eq!(guard.check().status, "confirmation_required");
        assert!(!guard.admissible());
        assert!(!guard.may_set("model"));
        assert!(!guard.can_record_model(None));
        assert!(guard.can_record_model(Some(&options)));
        let mut wrong_service = record.clone();
        wrong_service["_farfoldService"] = json!({"kind":"configured"});
        assert!(!ModelGuard::new(&options, Some(&wrong_service), true).needs_model_record());
        assert!(!ModelGuard::new(&options, None, true).needs_model_record());
        options[0]["options"] = json!([
            {"value":"auto","name":"Auto","description":"A","_meta":{"a":true}},
            {"value":"auto","name":"Auto","description":"B","_meta":{"b":true}}
        ]);
        guard.observe(&options);
        assert!(guard.can_record_model(Some(&options)));
        options[0]["options"] = json!([
            {"group":"one","name":"One","options":[{"value":"auto","name":"Auto"}]},
            {"group":"two","name":"Two","options":[{"value":"auto","name":"Auto"}]}
        ]);
        guard.observe(&options);
        assert!(!guard.can_record_model(Some(&options)));
        options[0]["options"] = json!([{"value":"auto","name":"A"},{"value":"auto","name":"B"}]);
        guard.observe(&options);
        assert_eq!(guard.check().status, "blocked");
        options[0]["options"] = json!([{"value":"auto","name":"Auto"}]);
        options[0].as_object_mut().unwrap().remove("category");
        guard.observe(&options);
        assert!(!guard.needs_model_record());
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
    fn configuration_change_legacy_requires_explicit_confirmation_only_when_model_matches() {
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
    fn configuration_change_ready_established_choices_can_change_but_legacy_requires_confirmation()
    {
        let mut guard = ModelGuard::new(&options("m", "high"), None, false);
        assert!(guard.may_set("reasoning_effort"));
        guard.lock();
        assert!(guard.may_set("model"));
        assert!(guard.may_set("reasoning_effort"));
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
