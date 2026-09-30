//! In-memory confirmation of a verified official permission option. Never a
//! permission policy, Agent configuration source or persistent execution log.
use serde_json::{Value, json};

pub(crate) struct PermissionGuard {
    id: Option<String>,
    state: &'static str,
    confirmed: Option<String>,
    update_blocker: Option<crate::managed_update::ActivityPermit>,
}
fn selected(options: &Value) -> Option<&str> {
    let entries = options.as_array()?;
    let mut modes = entries.iter().filter(|v| v["id"] == "mode");
    let mode = modes.next()?;
    if modes.next().is_some() || mode["category"] != "mode" || mode["type"] != "select" {
        return None;
    }
    let values = mode["options"].as_array()?;
    // Verified shape from the 2026-09-27 official Codex ACP probe. Do not
    // infer a permission capability for arbitrary options named "mode".
    if !["read-only", "agent", "agent-full-access"]
        .iter()
        .all(|expected| values.iter().any(|v| v["value"] == *expected))
    {
        return None;
    }
    let current = mode["currentValue"].as_str()?;
    values
        .iter()
        .any(|v| v["value"] == current)
        .then_some(current)
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
            update_blocker: None,
        }
    }
    pub(crate) fn id(&self) -> Option<String> {
        self.id.clone()
    }
    pub(crate) fn state(&self) -> &'static str {
        self.state
    }
    pub(crate) fn is_permission(&self, id: &str) -> bool {
        self.id.as_deref() == Some(id)
    }
    pub(crate) fn admissible(&self) -> bool {
        self.state == "ready"
    }
    pub(crate) fn event(&self) -> Value {
        json!({"kind":"permissionState", "permissionConfigId":self.id, "permissionState":self.state})
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
