use super::{HostStore, session_open::SessionOpenTarget};
use crate::{host_ids::*, runtime_registry::RuntimeBinding};
use rusqlite::{Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeModelSelection {
    pub catalog_model_id: String,
    pub native_model: String,
    pub provider: String,
    pub reasoning_effort: String,
}
impl NativeModelSelection {
    pub fn validate(&self) -> Result<(), String> {
        for s in [
            &self.catalog_model_id,
            &self.native_model,
            &self.provider,
            &self.reasoning_effort,
        ] {
            if s.is_empty()
                || s.len() > 200
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.:/-".contains(&b))
            {
                return Err("Invalid native model selection identity".into());
            }
        }
        Ok(())
    }
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionModelSelection {
    pub farfold_session_id: FarfoldSessionId,
    pub(crate) runtime: RuntimeBinding,
    pub profile_id: RuntimeProfileId,
    pub working_copy_id: WorkingCopyId,
    pub cwd: PathBuf,
    pub native_thread_id: String,
    pub native_tree_id: String,
    pub selection: NativeModelSelection,
}
impl SessionModelSelection {
    pub(crate) fn verify(
        &self,
        t: &SessionOpenTarget,
        profile: &RuntimeProfileId,
    ) -> Result<(), String> {
        self.selection.validate()?;
        if self.farfold_session_id != t.farfold_session_id
            || self.runtime != t.binding()
            || &self.profile_id != profile
            || self.working_copy_id != t.working_copy_id
            || self.cwd != t.working_copy_path
            || self.native_thread_id != t.native_session_id.as_str()
            || t.locator_value.as_ref() != Some(&self.native_tree_id)
            || t.locator_kind != Some(super::records::NativeSessionLocatorKind::CodexTreeSessionId)
            || t.archived_at.is_some()
        {
            return Err("Native selection differs from original shared Session".into());
        }
        Ok(())
    }
}
impl HostStore {
    pub fn session_model_selection(
        &self,
        id: &FarfoldSessionId,
    ) -> Result<SessionModelSelection, String> {
        self.with_ready_database(|db| read_from_connection(&db.connection, id))
    }
    pub fn record_session_model_selection(
        &self,
        input: &SessionModelSelection,
    ) -> Result<(), String> {
        self.with_ready_database(|db| {
            let tx = db
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| "Cannot begin Session model transaction")?;
            record_in_transaction(&tx, input, &input.profile_id)?;
            tx.commit()
                .map_err(|_| "Cannot commit Session model".into())
        })
    }
}

pub(super) fn read_from_connection(
    connection: &rusqlite::Connection,
    id: &FarfoldSessionId,
) -> Result<SessionModelSelection, String> {
    let raw: Option<String> = connection
        .query_row(
            "SELECT native_model_selection_json FROM sessions WHERE farfold_session_id=?1",
            [id.as_str()],
            |r| r.get(0),
        )
        .map_err(|_| "Original Session model metadata missing")?;
    serde_json::from_str(&raw.ok_or("Original Session has no explicit model metadata")?)
        .map_err(|_| "Invalid Session model metadata".into())
}

pub(super) fn record_in_transaction(
    tx: &Transaction<'_>,
    input: &SessionModelSelection,
    expected_profile: &RuntimeProfileId,
) -> Result<(), String> {
    input.verify(
        &super::session_open::read_target_from_connection(tx, &input.farfold_session_id)?,
        expected_profile,
    )?;
    let raw = serde_json::to_string(input).map_err(|_| "Model metadata unavailable")?;
    if raw.len() > 8192 {
        return Err("Model metadata too large".into());
    }
    let changed = tx.execute("UPDATE sessions SET native_model_selection_json=?1 WHERE farfold_session_id=?2 AND connection_id=?3 AND runtime_build_id=?4 AND native_session_id=?5 AND working_copy_id=?6 AND (native_model_selection_json IS NULL OR native_model_selection_json=?1) AND EXISTS (SELECT 1 FROM runtime_owned_profiles p WHERE p.profile_id=?7 AND p.connection_id=sessions.connection_id AND p.installation_id=sessions.installation_id AND p.runtime_product_id=sessions.runtime_product_id AND p.runtime_build_id=sessions.runtime_build_id AND p.adapter_id=sessions.adapter_id) AND EXISTS (SELECT 1 FROM session_native_locators l WHERE l.farfold_session_id=sessions.farfold_session_id AND l.locator_value=?8)", params![raw, input.farfold_session_id.as_str(), input.runtime.connection_id.as_str(), input.runtime.runtime_build_id.as_str(), input.native_thread_id, input.working_copy_id.as_str(), input.profile_id.as_str(), input.native_tree_id]).map_err(|_| "Cannot record original Session model")?;
    if changed != 1 {
        return Err("Original Session model cannot be overwritten".into());
    }
    Ok(())
}
