use super::{HostDatabase, HostStore, now_millis};
use crate::{
    host_store::session_open::SessionOpenTarget,
    lifemodel::{LifeModelSnapshot, validate_store},
};
use rusqlite::{Transaction, TransactionBehavior, params};

const MAX_LIFE_MODEL_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;

fn decode_snapshot(body: &str) -> Result<LifeModelSnapshot, String> {
    if body.len() > MAX_LIFE_MODEL_DOCUMENT_BYTES {
        return Err("LifeModel document exceeds the Host storage limit".to_string());
    }
    let snapshot = serde_json::from_str::<LifeModelSnapshot>(body)
        .map_err(|error| format!("Host LifeModel document is invalid: {error}"))?;
    validate_store(&snapshot)?;
    Ok(snapshot)
}

fn encode_snapshot(snapshot: &LifeModelSnapshot) -> Result<String, String> {
    validate_store(snapshot)?;
    let body = serde_json::to_string(snapshot)
        .map_err(|error| format!("Cannot encode Host LifeModel document: {error}"))?;
    if body.len() > MAX_LIFE_MODEL_DOCUMENT_BYTES {
        return Err("LifeModel document exceeds the Host storage limit".to_string());
    }
    Ok(body)
}

fn validate_source_binding(
    transaction: &Transaction<'_>,
    target: &SessionOpenTarget,
) -> Result<(), String> {
    let locator_kind = target.locator_kind.map(|kind| kind.as_str());
    let locator_path = target
        .locator_path
        .as_ref()
        .map(|path| path.to_string_lossy().into_owned());
    let count = transaction
        .query_row(
            "SELECT COUNT(*)
             FROM sessions s
             JOIN working_copies w ON w.working_copy_id = s.working_copy_id
             LEFT JOIN session_native_locators l
               ON l.farfold_session_id = s.farfold_session_id
             WHERE s.farfold_session_id = ?1
               AND s.runtime_product_id = ?2
               AND s.installation_id = ?3
               AND s.runtime_build_id = ?4
               AND s.adapter_id = ?5
               AND s.connection_id = ?6
               AND s.working_copy_id = ?7
               AND w.canonical_path = ?8
               AND s.native_session_id = ?9
               AND s.archived_at IS NULL
               AND (
                    (?10 IS NULL AND ?11 IS NULL
                     AND l.farfold_session_id IS NULL)
                    OR (l.locator_kind = ?10 AND l.locator_value = ?11)
               )",
            params![
                target.farfold_session_id.as_str(),
                target.runtime_product_id.as_str(),
                target.installation_id.as_str(),
                target.runtime_build_id.as_str(),
                target.adapter_id.as_str(),
                target.connection_id.as_str(),
                target.working_copy_id.as_str(),
                target.working_copy_path.to_string_lossy(),
                target.native_session_id.as_str(),
                locator_kind,
                locator_path,
            ],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Cannot revalidate LifeModel source binding: {error}"))?;
    if count != 1 {
        return Err(
            "Farfold Session binding changed or was archived before Proposal commit".to_string(),
        );
    }
    Ok(())
}

impl HostDatabase {
    fn life_model_snapshot(&mut self) -> Result<LifeModelSnapshot, String> {
        let body = self
            .connection
            .query_row(
                "SELECT snapshot_json FROM life_model_state WHERE singleton = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| format!("Cannot read Host LifeModel document: {error}"))?;
        decode_snapshot(&body)
    }

    fn mutate_life_model<T>(
        &mut self,
        mutate: impl FnOnce(&mut LifeModelSnapshot) -> Result<T, String>,
    ) -> Result<T, String> {
        self.mutate_life_model_guarded(|_| Ok(()), mutate)
    }

    fn mutate_life_model_for_source<T>(
        &mut self,
        target: &SessionOpenTarget,
        mutate: impl FnOnce(&mut LifeModelSnapshot) -> Result<T, String>,
    ) -> Result<T, String> {
        self.mutate_life_model_guarded(
            |transaction| validate_source_binding(transaction, target),
            mutate,
        )
    }

    fn mutate_life_model_guarded<T>(
        &mut self,
        validate: impl FnOnce(&Transaction<'_>) -> Result<(), String>,
        mutate: impl FnOnce(&mut LifeModelSnapshot) -> Result<T, String>,
    ) -> Result<T, String> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Cannot begin Host LifeModel transaction: {error}"))?;
        validate(&transaction)?;
        let (body, revision) = transaction
            .query_row(
                "SELECT snapshot_json, revision FROM life_model_state WHERE singleton = 1",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .map_err(|error| format!("Cannot read Host LifeModel document: {error}"))?;
        let mut snapshot = decode_snapshot(&body)?;
        let result = mutate(&mut snapshot)?;
        let body = encode_snapshot(&snapshot)?;
        let updated = transaction
            .execute(
                "UPDATE life_model_state
                 SET snapshot_json = ?1, revision = revision + 1, updated_at = ?2
                 WHERE singleton = 1 AND revision = ?3",
                params![body, now_millis(), revision],
            )
            .map_err(|error| format!("Cannot write Host LifeModel document: {error}"))?;
        if updated != 1 {
            return Err("Host LifeModel document changed concurrently".to_string());
        }
        transaction
            .commit()
            .map_err(|error| format!("Cannot commit Host LifeModel transaction: {error}"))?;
        Ok(result)
    }
}

impl HostStore {
    pub(crate) fn life_model_snapshot(&self) -> Result<LifeModelSnapshot, String> {
        self.with_ready_database(HostDatabase::life_model_snapshot)
    }

    pub(crate) fn mutate_life_model<T>(
        &self,
        mutate: impl FnOnce(&mut LifeModelSnapshot) -> Result<T, String>,
    ) -> Result<T, String> {
        self.with_ready_database(|database| database.mutate_life_model(mutate))
    }

    pub(crate) fn mutate_life_model_for_source<T>(
        &self,
        target: &SessionOpenTarget,
        mutate: impl FnOnce(&mut LifeModelSnapshot) -> Result<T, String>,
    ) -> Result<T, String> {
        self.with_ready_database(|database| database.mutate_life_model_for_source(target, mutate))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        host_ids::{
            AdapterId, ConnectionId, FarfoldSessionId, InstallationId, NativeSessionId, ProjectId,
            RuntimeBuildId, RuntimeProductId, WorkingCopyId,
        },
        host_store::records::{
            RuntimeConnectionKind, RuntimeDistribution, RuntimeRegistration, SessionRegistration,
            SessionTitleSource, WorkingCopyKind,
        },
        runtime_registry::OPENCODE_RUNTIME,
    };
    use std::path::PathBuf;
    use std::{cell::Cell, fs};

    fn registered_store(name: &str) -> (HostStore, PathBuf, FarfoldSessionId) {
        let root = std::env::temp_dir().join(format!(
            "farfold-lifemodel-binding-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let store = HostStore::open(root.join("host.sqlite3"));
        store
            .register_runtime(&RuntimeRegistration {
                runtime_product_id: RuntimeProductId::parse(OPENCODE_RUNTIME.product_id).unwrap(),
                display_name: "OpenCode".to_string(),
                installation_id: InstallationId::parse(OPENCODE_RUNTIME.installation_id).unwrap(),
                runtime_build_id: RuntimeBuildId::parse(OPENCODE_RUNTIME.runtime_build_id).unwrap(),
                adapter_id: AdapterId::parse(OPENCODE_RUNTIME.adapter_id).unwrap(),
                distribution: RuntimeDistribution::Managed,
                observed_version: OPENCODE_RUNTIME.version.to_string(),
                artifact_sha256: OPENCODE_RUNTIME.binary_sha256.to_string(),
                connection_id: ConnectionId::parse(OPENCODE_RUNTIME.default_connection_id).unwrap(),
                connection_label: "Managed OpenCode".to_string(),
                connection_kind: RuntimeConnectionKind::ManagedLocal,
                created_at: 1,
                verified_at: 1,
            })
            .unwrap();
        let farfold_session_id = FarfoldSessionId::parse("lifemodel-source-session").unwrap();
        store
            .register_session(&SessionRegistration {
                farfold_session_id: farfold_session_id.clone(),
                runtime_product_id: RuntimeProductId::parse(OPENCODE_RUNTIME.product_id).unwrap(),
                installation_id: InstallationId::parse(OPENCODE_RUNTIME.installation_id).unwrap(),
                runtime_build_id: RuntimeBuildId::parse(OPENCODE_RUNTIME.runtime_build_id).unwrap(),
                adapter_id: AdapterId::parse(OPENCODE_RUNTIME.adapter_id).unwrap(),
                connection_id: ConnectionId::parse(OPENCODE_RUNTIME.default_connection_id).unwrap(),
                project_id: ProjectId::parse("lifemodel-project").unwrap(),
                project_path: root.clone(),
                project_name: "LifeModel".to_string(),
                working_copy_id: WorkingCopyId::parse("lifemodel-working-copy").unwrap(),
                working_copy_path: root.clone(),
                working_copy_kind: WorkingCopyKind::Root,
                branch_name: None,
                native_session_id: NativeSessionId::parse("ses_lifemodel").unwrap(),
                title: "LifeModel source".to_string(),
                title_source: SessionTitleSource::Native,
                created_at: 2,
                updated_at: 2,
            })
            .unwrap();
        (store, root, farfold_session_id)
    }

    #[test]
    fn proposal_commit_revalidates_the_unarchived_immutable_session_binding() {
        let (store, root, farfold_session_id) = registered_store("archive-race");
        let target = store.session_open_target(&farfold_session_id).unwrap();
        store
            .with_ready_database(|database| {
                database
                    .connection
                    .execute(
                        "UPDATE sessions SET archived_at = 3 WHERE farfold_session_id = ?1",
                        [farfold_session_id.as_str()],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();

        let mutation_ran = Cell::new(false);
        let error = store
            .mutate_life_model_for_source(&target, |snapshot| {
                mutation_ran.set(true);
                let _ = snapshot;
                Ok(())
            })
            .unwrap_err();
        assert!(error.contains("changed or was archived"));
        assert!(!mutation_ran.get());
        fs::remove_dir_all(root).unwrap();
    }
}
