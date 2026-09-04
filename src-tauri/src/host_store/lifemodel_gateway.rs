use super::{HostDatabase, HostStore, now_millis};
use crate::{
    host_store::session_open::SessionOpenTarget,
    lifemodel::{LifeModelSnapshot, validate_store},
};
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use std::path::PathBuf;

const MAX_LIFE_MODEL_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LegacyLifeModelMigration {
    pub source_name: String,
    pub source_sha256: String,
    pub source_byte_count: u64,
    pub retired_path: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LegacyImportOutcome {
    Imported,
    AlreadyImported,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LegacyMigrationRecord {
    pub source_sha256: String,
    pub source_byte_count: u64,
    pub retired_path: PathBuf,
    pub retired_at: Option<i64>,
}

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

    fn import_legacy_life_model(
        &mut self,
        migration: &LegacyLifeModelMigration,
        snapshot: &LifeModelSnapshot,
    ) -> Result<LegacyImportOutcome, String> {
        if migration.source_name.trim().is_empty() || migration.source_name.len() > 200 {
            return Err("Legacy LifeModel source name is invalid".to_string());
        }
        if migration.source_sha256.len() != 64
            || !migration
                .source_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err("Legacy LifeModel source digest is invalid".to_string());
        }
        if migration.source_byte_count == 0
            || migration.source_byte_count > MAX_LIFE_MODEL_DOCUMENT_BYTES as u64
        {
            return Err("Legacy LifeModel source size is invalid".to_string());
        }
        let retired_path = migration.retired_path.to_string_lossy().into_owned();
        if retired_path.is_empty() || retired_path.len() > 4096 {
            return Err("Legacy LifeModel retired path is invalid".to_string());
        }
        let body = encode_snapshot(snapshot)?;
        let source_byte_count = i64::try_from(migration.source_byte_count)
            .map_err(|_| "Legacy LifeModel source size is invalid".to_string())?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Cannot begin legacy LifeModel migration: {error}"))?;
        let existing = transaction
            .query_row(
                "SELECT source_sha256, source_byte_count, retired_path
                 FROM life_model_legacy_migrations WHERE source_name = ?1",
                params![migration.source_name],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("Cannot inspect legacy LifeModel migration: {error}"))?;
        if let Some((sha256, byte_count, stored_retired_path)) = existing {
            if sha256 != migration.source_sha256
                || byte_count != source_byte_count
                || stored_retired_path != retired_path
            {
                return Err(
                    "Legacy LifeModel source changed after it was imported into Host storage"
                        .to_string(),
                );
            }
            transaction
                .commit()
                .map_err(|error| format!("Cannot finish legacy LifeModel inspection: {error}"))?;
            return Ok(LegacyImportOutcome::AlreadyImported);
        }

        let current_body = transaction
            .query_row(
                "SELECT snapshot_json FROM life_model_state WHERE singleton = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| format!("Cannot read Host LifeModel document: {error}"))?;
        if decode_snapshot(&current_body)? != LifeModelSnapshot::default() {
            return Err(
                "Host LifeModel already contains data; refusing to overwrite it from legacy JSON"
                    .to_string(),
            );
        }
        let imported_at = now_millis();
        transaction
            .execute(
                "UPDATE life_model_state
                 SET snapshot_json = ?1, revision = revision + 1, updated_at = ?2
                 WHERE singleton = 1",
                params![body, imported_at],
            )
            .map_err(|error| format!("Cannot import legacy LifeModel document: {error}"))?;
        transaction
            .execute(
                "INSERT INTO life_model_legacy_migrations(
                    source_name, source_sha256, source_byte_count, retired_path,
                    imported_at, retired_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, NULL)",
                params![
                    migration.source_name,
                    migration.source_sha256,
                    source_byte_count,
                    retired_path,
                    imported_at
                ],
            )
            .map_err(|error| format!("Cannot record legacy LifeModel migration: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("Cannot commit legacy LifeModel migration: {error}"))?;
        Ok(LegacyImportOutcome::Imported)
    }

    fn legacy_life_model_migration(
        &mut self,
        source_name: &str,
    ) -> Result<Option<LegacyMigrationRecord>, String> {
        self.connection
            .query_row(
                "SELECT source_sha256, source_byte_count, retired_path, retired_at
                 FROM life_model_legacy_migrations WHERE source_name = ?1",
                params![source_name],
                |row| {
                    let byte_count = row.get::<_, i64>(1)?;
                    Ok((
                        row.get::<_, String>(0)?,
                        byte_count,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("Cannot read legacy LifeModel migration: {error}"))?
            .map(
                |(source_sha256, source_byte_count, retired_path, retired_at)| {
                    Ok(LegacyMigrationRecord {
                        source_sha256,
                        source_byte_count: u64::try_from(source_byte_count)
                            .map_err(|_| "Legacy LifeModel source size is invalid".to_string())?,
                        retired_path: PathBuf::from(retired_path),
                        retired_at,
                    })
                },
            )
            .transpose()
    }

    fn mark_legacy_life_model_retired(
        &mut self,
        source_name: &str,
        source_sha256: &str,
        retired_path: &str,
    ) -> Result<(), String> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Cannot begin legacy LifeModel retirement: {error}"))?;
        let updated = transaction
            .execute(
                "UPDATE life_model_legacy_migrations
                 SET retired_at = COALESCE(retired_at, ?1)
                 WHERE source_name = ?2 AND source_sha256 = ?3 AND retired_path = ?4",
                params![now_millis(), source_name, source_sha256, retired_path],
            )
            .map_err(|error| format!("Cannot record legacy LifeModel retirement: {error}"))?;
        if updated != 1 {
            return Err(
                "Legacy LifeModel migration identity changed before retirement".to_string(),
            );
        }
        transaction
            .commit()
            .map_err(|error| format!("Cannot commit legacy LifeModel retirement: {error}"))
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

    pub(crate) fn import_legacy_life_model(
        &self,
        migration: &LegacyLifeModelMigration,
        snapshot: &LifeModelSnapshot,
    ) -> Result<LegacyImportOutcome, String> {
        self.with_ready_database(|database| database.import_legacy_life_model(migration, snapshot))
    }

    pub(crate) fn legacy_life_model_migration(
        &self,
        source_name: &str,
    ) -> Result<Option<LegacyMigrationRecord>, String> {
        self.with_ready_database(|database| database.legacy_life_model_migration(source_name))
    }

    pub(crate) fn mark_legacy_life_model_retired(
        &self,
        source_name: &str,
        source_sha256: &str,
        retired_path: &str,
    ) -> Result<(), String> {
        self.with_ready_database(|database| {
            database.mark_legacy_life_model_retired(source_name, source_sha256, retired_path)
        })
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
