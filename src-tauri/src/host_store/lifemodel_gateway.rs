use super::{HostDatabase, HostStore, now_millis};
use crate::lifemodel::{LifeModelSnapshot, validate_store};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
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
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Cannot begin Host LifeModel transaction: {error}"))?;
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
