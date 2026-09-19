//! LifeModel seam (decision D8): settings keys and the single prompt
//! injection hook. Real collection/injection is out of scope this phase —
//! `context_blocks_for_prompt` returns empty, which makes the prompt path
//! a no-op while keeping the seam in place.
//!
//! Settings keys (all default `false`, booleans in meta_store `settings`):
//! - `lifemodel.master`     — master switch for the whole LifeModel layer
//! - `lifemodel.contribute` — allow proposals to be derived from sessions
//! - `lifemodel.use`        — allow approved canonical entries to inject

use agent_client_protocol::schema::v1::ContentBlock;
use serde_json::Value;

use crate::meta_store::MetaStore;

pub(crate) const MASTER_KEY: &str = "lifemodel.master";
pub(crate) const CONTRIBUTE_KEY: &str = "lifemodel.contribute";
pub(crate) const USE_KEY: &str = "lifemodel.use";

const KEYS: [&str; 3] = [MASTER_KEY, CONTRIBUTE_KEY, USE_KEY];

/// Ensure the three settings keys exist so the Settings page and
/// diagnostics export see stable defaults.
pub(crate) fn ensure_defaults(store: &MetaStore) -> Result<(), String> {
    for key in KEYS {
        if store.get_setting(key)?.is_none() {
            store.set_setting(key, &Value::Bool(false))?;
        }
    }
    Ok(())
}

/// Read one LifeModel switch (`false` when unset or non-boolean).
#[allow(dead_code)]
pub(crate) fn enabled(store: &MetaStore, key: &str) -> bool {
    store
        .get_setting(key)
        .ok()
        .flatten()
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

/// Content blocks prepended to a session prompt. This phase returns an
/// empty vec — LifeModel injection is not implemented (D8).
///
/// TODO(lifemodel): when canonical entries exist, render the approved
/// entries for `agent_id` (per the F-spec injection preview) as a single
/// `ContentBlock::Text` and return it here. `session_prompt` prepends the
/// result, so returning `vec![]` is the no-op path.
pub(crate) fn context_blocks_for_prompt(_store: &MetaStore, _agent_id: &str) -> Vec<ContentBlock> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> MetaStore {
        let dir = tempfile::tempdir().expect("tempdir");
        MetaStore::open(&dir.path().join("farfold.sqlite3")).expect("open store")
    }

    #[test]
    fn defaults_are_false_and_stable() {
        let store = store();
        ensure_defaults(&store).unwrap();
        for key in KEYS {
            assert_eq!(store.get_setting(key).unwrap(), Some(Value::Bool(false)));
            assert!(!enabled(&store, key));
        }
        // Idempotent: a user-set value is not clobbered.
        store.set_setting(MASTER_KEY, &Value::Bool(true)).unwrap();
        ensure_defaults(&store).unwrap();
        assert!(enabled(&store, MASTER_KEY));
    }

    #[test]
    fn injection_hook_is_a_no_op() {
        let store = store();
        assert!(context_blocks_for_prompt(&store, "codex").is_empty());
    }
}
