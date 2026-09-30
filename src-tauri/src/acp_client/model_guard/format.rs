//! Strict app-owned snapshot versions and public option identity.
use super::{Choice, ConfigIssue, Snapshot, category, issue};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub(super) struct Baseline {
    pub snapshot: Snapshot,
    pub model_known: bool,
    pub invalid: bool,
    pub unclassified_ids: BTreeSet<String>,
}
fn role(option: &Value) -> Option<&'static str> {
    match option.get("category") {
        Some(Value::String(value)) if value == "model" => Some("model"),
        Some(Value::String(value)) if value == "thought_level" => Some("thought_level"),
        None | Some(Value::Null) => match option["id"].as_str() {
            Some("model") => Some("model"),
            Some("thought_level" | "reasoning_effort") => Some("thought_level"),
            _ => None,
        },
        _ => None,
    }
}
pub(super) fn observe(
    options: &Value,
    saved: &Snapshot,
) -> (Snapshot, Vec<ConfigIssue>, BTreeSet<String>) {
    let entries = options.as_array().map(Vec::as_slice).unwrap_or_default();
    let mut counts = BTreeMap::<String, usize>::new();
    for option in entries {
        if let Some(id) = option["id"].as_str() {
            *counts.entry(id.to_owned()).or_default() += 1;
        }
    }
    let mut invalid = Vec::new();
    let mut choices = Vec::new();
    let mut ids = BTreeSet::new();
    for (id, count) in &counts {
        if *count > 1 {
            let role = entries
                .iter()
                .filter(|option| option["id"] == *id)
                .find_map(role)
                .unwrap_or("model");
            invalid.push(issue(role, Some(id.clone()), "missing", None, None));
        }
    }
    for option in entries {
        // Categories describe UX, not identity. Once an ID was recorded as
        // protected, keep examining its actual type/value even when its
        // category is missing or changes. New IDs use the current declaration.
        let saved_role = saved
            .choices
            .iter()
            .find(|c| option["id"] == c.id)
            .map(|c| category(&c.category));
        let Some(role) = saved_role.or_else(|| role(option)) else {
            continue;
        };
        let id = option["id"].as_str().filter(|id| !id.is_empty());
        if let Some(id) = id {
            ids.insert(id.to_owned());
        }
        // Older public fixtures/records omitted the then-only select type.
        let kind = option.get("type").map_or(Some("select"), Value::as_str);
        let value = option["currentValue"].as_str();
        let (Some(id), Some("select"), Some(value)) = (id, kind, value) else {
            invalid.push(issue(role, id.map(str::to_owned), "missing", None, None));
            continue;
        };
        if counts.get(id).copied().unwrap_or(0) != 1 {
            continue;
        }
        choices.push(Choice {
            id: id.to_owned(),
            category: role.into(),
            kind: "select".into(),
            value: value.to_owned(),
        });
    }
    choices.sort_by(|a, b| a.id.cmp(&b.id));
    (Snapshot { choices }, invalid, ids)
}

fn valid(snapshot: &Snapshot) -> bool {
    let mut ids = BTreeSet::new();
    snapshot.choices.iter().all(|c| {
        !c.id.is_empty()
            && ids.insert(&c.id)
            && matches!(c.category.as_str(), "model" | "thought_level")
            && c.kind == "select"
    })
}
fn legacy_choice(value: &Value, expected_category: &str) -> Option<Choice> {
    let choice = Choice {
        id: value["id"].as_str()?.into(),
        category: value["category"].as_str()?.into(),
        kind: "select".into(),
        value: value["value"].as_str()?.into(),
    };
    (choice.category == expected_category && !choice.id.is_empty()).then_some(choice)
}
pub(super) fn baseline(record: Option<&Value>, current: &Snapshot, options: &Value) -> Baseline {
    let mut output = Baseline {
        snapshot: Snapshot::default(),
        model_known: false,
        invalid: false,
        unclassified_ids: BTreeSet::new(),
    };
    let Some(record) = record.filter(|r| !r.is_null()) else {
        return output;
    };
    let Some(object) = record.as_object() else {
        output.invalid = true;
        return output;
    };
    if let Some(marker) = object.get("_farfoldConfig") {
        let saved = match marker.as_u64() {
            Some(2) => serde_json::from_value::<Snapshot>(record.clone()).ok(),
            Some(1) => {
                let mut choices = Vec::new();
                let mut correct = true;
                for (field, role) in [("model", "model"), ("thoughtLevel", "thought_level")] {
                    match object.get(field) {
                        Some(Value::Null) => {}
                        Some(value) => match legacy_choice(value, role) {
                            Some(choice) => choices.push(choice),
                            None => correct = false,
                        },
                        None => correct = false,
                    }
                }
                correct.then_some(Snapshot { choices })
            }
            _ => None,
        };
        match saved.filter(valid) {
            Some(mut saved) => {
                saved.choices.sort_by(|a, b| a.id.cmp(&b.id));
                output.snapshot = saved;
                output.model_known = true;
            }
            None => output.invalid = true,
        }
        return output;
    }
    // Old flat records prove only values under exact option IDs. They cannot
    // rename a stored choice to another ID merely because a category matches.
    let mut candidates = current
        .choices
        .iter()
        .map(|c| (c.id.clone(), c.category.clone()))
        .collect::<BTreeMap<_, _>>();
    for (id, role) in [
        ("model", "model"),
        ("thought_level", "thought_level"),
        ("reasoning_effort", "thought_level"),
    ] {
        if object.contains_key(id) {
            candidates.entry(id.into()).or_insert(role.into());
        }
    }
    for id in object.keys() {
        let declared_mode = options.as_array().is_some_and(|items| {
            items
                .iter()
                .any(|item| item["id"] == *id && item["category"] == "mode")
        });
        if !candidates.contains_key(id) && id != "_farfoldService" && id != "mode" && !declared_mode
        {
            // A flat record has no historical category. Do not discard an
            // unclassified saved selection, guess its role or echo its value.
            output.invalid = true;
            output.unclassified_ids.insert(id.clone());
        }
    }
    for (id, role) in candidates {
        if let Some(value) = object.get(&id) {
            match value.as_str() {
                Some(value) => {
                    output.model_known |= role == "model";
                    output.snapshot.choices.push(Choice {
                        id,
                        category: category(&role).into(),
                        kind: "select".into(),
                        value: value.into(),
                    });
                }
                None => output.invalid = true,
            }
        }
    }
    output
}
