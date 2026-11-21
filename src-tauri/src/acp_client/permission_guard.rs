//! In-memory confirmation of a verified official permission option. Never a
//! permission policy, Agent configuration source or persistent execution log.
use super::permission_effect::{PermissionEffect, requires_current_scope};
use serde_json::{Value, json};
use std::collections::HashSet;

pub(crate) struct PermissionGuard {
    id: Option<String>,
    state: &'static str,
    confirmed: Option<String>,
    effect: Option<PermissionEffect>,
    update_blocker: Option<crate::managed_update::ActivityPermit>,
}

fn grouped_choices(groups: &[Value]) -> Option<HashSet<&str>> {
    let mut group_ids = HashSet::new();
    let mut choices = HashSet::new();
    for group in groups {
        let id = group["group"].as_str()?;
        let options = group["options"].as_array()?;
        if id.trim().is_empty()
            || group["name"].as_str()?.trim().is_empty()
            || group.get("value").is_some()
            || !group_ids.insert(id)
            || options.is_empty()
        {
            return None;
        }
        for option in options {
            let value = option["value"].as_str()?;
            if value.trim().is_empty()
                || option["name"].as_str()?.trim().is_empty()
                || option.get("group").is_some()
                || option.get("options").is_some()
                || !choices.insert(value)
            {
                return None;
            }
        }
    }
    Some(choices)
}

fn selected(options: &Value) -> Option<&str> {
    let entries = options.as_array()?;
    let mut modes = entries.iter().filter(|v| v["id"] == "mode");
    let mode = modes.next()?;
    if modes.next().is_some() || mode["category"] != "mode" || mode["type"] != "select" {
        return None;
    }
    let values = mode["options"].as_array()?;
    let current = mode["currentValue"].as_str()?;
    // Verified shape from the 2026-09-27 official Codex ACP probe. Do not
    // infer a permission capability for arbitrary options named "mode", or
    // effective sandbox permissions from a preset ID or profile name.
    let required = ["read-only", "agent", "agent-full-access", current];
    let declared = if values
        .iter()
        .any(|entry| entry.get("group").is_some() || entry.get("options").is_some())
    {
        // Codex ACP 2.7 groups built-in modes and configured permission
        // profiles when profiles exist. Only an unambiguous grouping counts.
        let choices = grouped_choices(values)?;
        required.iter().all(|value| choices.contains(value))
    } else {
        required
            .iter()
            .all(|expected| values.iter().any(|v| v["value"] == *expected))
    };
    declared.then_some(current)
}
impl PermissionGuard {
    pub(crate) fn new(verified: bool, options: &Value, restored: bool) -> Self {
        let value = verified.then(|| selected(options)).flatten();
        Self {
            id: value.map(|_| "mode".into()),
            state: if verified && value.is_none() {
                "unknown"
            } else if value.is_some() && restored {
                "required"
            } else {
                "ready"
            },
            confirmed: if restored {
                None
            } else {
                value.map(str::to_owned)
            },
            effect: value.map(|_| PermissionEffect::next_ordinary_prompt()),
            update_blocker: None,
        }
    }
    pub(crate) fn id(&self) -> Option<String> {
        self.id.clone()
    }
    pub(crate) fn state(&self) -> &'static str {
        self.state
    }
    pub(crate) fn effect(&self) -> Option<PermissionEffect> {
        self.effect
    }
    pub(crate) fn blocks_prompt(
        &self,
        blocks: &[agent_client_protocol::schema::v1::ContentBlock],
    ) -> bool {
        self.effect.is_some() && requires_current_scope(blocks)
    }
    pub(crate) fn is_permission(&self, id: &str) -> bool {
        self.id.as_deref() == Some(id)
    }
    pub(crate) fn admissible(&self) -> bool {
        self.state == "ready"
    }
    pub(crate) fn event(&self) -> Value {
        json!({"kind":"permissionState", "permissionConfigId":self.id, "permissionState":self.state, "permissionEffect":self.effect})
    }
    pub(crate) fn begin(&mut self) {
        self.state = "changing";
        self.confirmed = None;
    }
    pub(crate) fn unknown(&mut self) {
        self.state = "unknown";
        self.confirmed = None;
        if self.update_blocker.is_none() {
            // A pending mutation already owns admission while entering unknown.
            // An unsolicited change may arrive after an idle update has begun;
            // it cannot start work and will require confirmation after restart.
            self.update_blocker = crate::managed_update::activity().ok();
        }
    }
    /// An unsolicited update can invalidate a confirmation, never create one.
    pub(crate) fn observe(&mut self, options: &Value) {
        if self.id.is_some()
            && self.state == "ready"
            && selected(options) != self.confirmed.as_deref()
        {
            self.unknown();
        }
    }
    pub(crate) fn complete(
        &mut self,
        requested: &Value,
        outcome: &Result<Value, String>,
        delivered: bool,
    ) -> bool {
        let actual = outcome.as_ref().ok().and_then(selected);
        if delivered && actual.is_some() && actual == requested.as_str() {
            self.state = "ready";
            self.confirmed = actual.map(str::to_owned);
            self.update_blocker.take();
            true
        } else {
            self.unknown();
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn options(value: &str) -> Value {
        json!([{"id":"mode","category":"mode","type":"select","currentValue":value,"options":[{"value":"read-only"},{"value":"agent"},{"value":"agent-full-access"}]}])
    }
    fn grouped_options(value: &str) -> Value {
        json!([{
            "id": "mode",
            "name": "Mode",
            "category": "mode",
            "type": "select",
            "currentValue": value,
            "options": [
                {
                    "group": "sandbox-modes",
                    "name": "Sandbox Modes",
                    "options": [
                        {"value":"read-only","name":"Read-only"},
                        {"value":"workspace-write","name":"Workspace access"},
                        {"value":"agent","name":"Auto review"},
                        {"value":"agent-full-access","name":"Full access"}
                    ]
                },
                {
                    "group": "permission-profiles",
                    "name": "Permission Profiles",
                    "options": [{"value":"permission-profile:team","name":"team"}]
                }
            ]
        }])
    }
    #[test]
    fn capability_requires_verified_identity_and_actual_shape() {
        assert_eq!(
            PermissionGuard::new(false, &options("agent"), true).id(),
            None
        );
        assert_eq!(
            PermissionGuard::new(true, &json!([{"id":"mode","category":"mode"}]), true).id(),
            None
        );
        assert!(PermissionGuard::new(true, &options("agent"), false).admissible());
        assert!(!PermissionGuard::new(true, &json!([]), false).admissible());
    }
    #[test]
    fn restored_default_and_unsolicited_updates_never_confirm() {
        let mut guard = PermissionGuard::new(true, &options("agent"), true);
        assert_eq!(guard.state(), "required");
        assert!(!guard.admissible());
        guard.observe(&options("agent"));
        assert!(!guard.admissible());
        guard.begin();
        assert!(guard.complete(&json!("read-only"), &Ok(options("read-only")), true));
        guard.observe(&options("agent"));
        assert_eq!(guard.state(), "unknown");
        assert!(guard.update_blocker.is_some());
        guard.observe(&options("read-only"));
        assert!(!guard.admissible());
    }
    #[test]
    fn grouped_mode_selection_preserves_restoration_and_unknown_scope() {
        let profile = grouped_options("permission-profile:team");
        let fresh = PermissionGuard::new(true, &profile, false);
        assert!(fresh.admissible());
        assert_eq!(fresh.id().as_deref(), Some("mode"));
        let effect = json!({
            "configId":"mode",
            "appliesAt":"next_ordinary_prompt",
            "currentScope":"unknown"
        });
        assert_eq!(fresh.event()["permissionEffect"], effect);

        let mut guard = PermissionGuard::new(true, &profile, true);
        guard.observe(&profile);
        assert_eq!(guard.state(), "required");
        guard.begin();
        let read_only = grouped_options("read-only");
        assert!(guard.complete(&json!("read-only"), &Ok(read_only), true));
        assert_eq!(guard.event()["permissionEffect"], effect);
        guard.observe(&profile);
        assert_eq!(guard.state(), "unknown");
        assert_eq!(guard.event()["permissionEffect"], effect);
    }
    #[test]
    fn malformed_or_ambiguous_grouped_options_fail_closed() {
        let original = grouped_options("agent");
        let mut cases = Vec::new();

        let mut mixed = original.clone();
        mixed[0]["options"][1] = json!({"value":"permission-profile:team","name":"team"});
        cases.push(mixed);
        let mut duplicate_choice = original.clone();
        duplicate_choice[0]["options"][1]["options"][0]["value"] = json!("agent");
        cases.push(duplicate_choice);
        let mut duplicate_group = original.clone();
        duplicate_group[0]["options"][1]["group"] = json!("sandbox-modes");
        cases.push(duplicate_group);
        let mut missing_preset = original.clone();
        missing_preset[0]["options"][0]["options"][3]["value"] = json!("other");
        cases.push(missing_preset);
        let mut unlisted_current = original.clone();
        unlisted_current[0]["currentValue"] = json!("unlisted");
        cases.push(unlisted_current);

        for options in cases {
            let fresh = PermissionGuard::new(true, &options, false);
            assert_eq!(fresh.id(), None, "{options}");
            assert_eq!(fresh.state(), "unknown", "{options}");
            let mut restored = PermissionGuard::new(true, &original, true);
            restored.begin();
            assert!(!restored.complete(&json!("agent"), &Ok(options), true));
            assert_eq!(restored.state(), "unknown");
        }
    }
    #[test]
    fn failed_mismatched_and_late_results_remain_unknown() {
        let mut guard = PermissionGuard::new(true, &options("agent"), false);
        guard.begin();
        assert!(!guard.complete(&json!("read-only"), &Err("failed".into()), true));
        assert_eq!(guard.state(), "unknown");
        guard.begin();
        guard.unknown();
        assert!(!guard.complete(&json!("read-only"), &Ok(options("read-only")), false));
        assert!(!guard.complete(&json!("read-only"), &Ok(options("agent")), true));
        guard.begin();
        assert!(guard.complete(&json!("read-only"), &Ok(options("read-only")), true));
        assert!(guard.update_blocker.is_none());
    }
}
