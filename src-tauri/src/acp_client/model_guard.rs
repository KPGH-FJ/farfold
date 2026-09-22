//! Model invariants over existing session metadata and Agent-reported options.
use serde_json::Value;

#[derive(Default)]
pub(crate) struct ModelGuard {
    expected: Option<Value>,
    current: Option<Value>,
    locked: bool,
}
impl ModelGuard {
    pub(crate) fn new(options: &Value, recorded: Option<&Value>, restored: bool) -> Self {
        let mut guard = Self {
            locked: restored,
            ..Self::default()
        };
        guard.observe(options);
        if let Some(recorded) = recorded {
            let id = model_option(options)
                .and_then(|o| o.get("id"))
                .and_then(Value::as_str);
            guard.expected = id
                .and_then(|id| recorded.get(id))
                .or_else(|| recorded.get("model"))
                .filter(|v| v.is_string())
                .cloned();
        }
        // An unindexed restored session has no known original model; do not
        // invent one. Its current model still stays fixed on subsequent sends.
        if restored && guard.expected.is_none() {
            guard.expected = guard.current.clone();
        }
        guard
    }
    pub(crate) fn observe(&mut self, options: &Value) {
        self.current = model_option(options)
            .and_then(|o| o.get("currentValue"))
            .filter(|v| v.is_string())
            .cloned();
    }
    pub(crate) fn admissible(&self) -> bool {
        !self.locked || self.expected.is_none() || self.current == self.expected
    }
    pub(crate) fn lock(&mut self) {
        if !self.locked {
            self.expected = self.current.clone();
            self.locked = true;
        }
    }
}
fn model_option(options: &Value) -> Option<&Value> {
    options
        .as_array()?
        .iter()
        .find(|o| o["category"] == "model" || o["id"] == "model")
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn options(model: &str) -> Value {
        json!([{"id":"model","category":"model","currentValue":model}])
    }
    #[test]
    fn restored_model_must_match_before_prompt() {
        let mut guard = ModelGuard::new(&options("new"), Some(&json!({"model":"old"})), true);
        assert!(!guard.admissible());
        guard.observe(&options("old"));
        assert!(guard.admissible());
        guard.observe(&json!([]));
        assert!(!guard.admissible());
    }
    #[test]
    fn draft_choice_locks_on_admission_not_creation() {
        let mut guard = ModelGuard::new(&options("a"), None, false);
        guard.observe(&options("b"));
        assert!(guard.admissible());
        guard.lock();
        guard.observe(&options("a"));
        assert!(!guard.admissible());
    }
}
