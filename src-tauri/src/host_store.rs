use rusqlite::{Connection, OpenFlags, TransactionBehavior, backup::Backup, params};
use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::State;

pub mod lifemodel_gateway;
pub mod managed_worktree_removal;
pub mod native_model_selection;
pub mod portable_export;
pub mod portable_import_activation;
pub mod project_relocation;
pub mod provider_projection;
pub mod records;
pub mod runtime_owned_profile;
pub mod session_attention;
pub mod session_binding_index;
pub mod session_deletion;
pub mod session_open;
pub mod system_installation;
pub mod turn_changes;
pub mod working_copy_manager;

const APPLICATION_ID: i64 = 1_178_686_022;
pub const CURRENT_SCHEMA_VERSION: i64 = 15;
const SCHEMA_V1: &str = include_str!("host_store/migrations/0001_host_foundation.sql");
const SCHEMA_V2: &str = include_str!("host_store/migrations/0002_legacy_migration_ledger.sql");
const SCHEMA_V3: &str = include_str!("host_store/migrations/0003_native_session_locators.sql");
const SCHEMA_V4: &str = include_str!("host_store/migrations/0004_managed_worktrees.sql");
const SCHEMA_V5: &str = include_str!("host_store/migrations/0005_managed_worktree_removals.sql");
const SCHEMA_V6: &str = include_str!("host_store/migrations/0006_turn_change_reviews.sql");
const SCHEMA_V7: &str = include_str!("host_store/migrations/0007_lifemodel_document.sql");
const SCHEMA_V8: &str = include_str!("host_store/migrations/0008_system_installation_launches.sql");
const SCHEMA_V9: &str = include_str!("host_store/migrations/0009_provider_connections.sql");
const SCHEMA_V10: &str =
    include_str!("host_store/migrations/0010_provider_credential_revisions.sql");
const SCHEMA_V11: &str = include_str!("host_store/migrations/0011_runtime_owned_profiles.sql");
const SCHEMA_V12: &str = include_str!("host_store/migrations/0012_turn_model_sources.sql");
const SCHEMA_V13: &str = include_str!("host_store/migrations/0013_profile_provider_versions.sql");
const SCHEMA_V14: &str = include_str!("host_store/migrations/0014_optional_profile_bootstrap.sql");
const SCHEMA_V15: &str = include_str!("host_store/migrations/0015_codex_owned_profile.sql");
static BACKUP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub struct HostDatabase {
    connection: Connection,
    path: PathBuf,
    last_backup_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostRecovery {
    path: PathBuf,
    reason: String,
    backup_path: Option<PathBuf>,
}

pub enum HostDatabaseOpen {
    Ready(HostDatabase),
    Recovery(HostRecovery),
}

#[derive(Clone)]
pub struct HostStore {
    state: std::sync::Arc<Mutex<HostDatabaseOpen>>,
    maintenance: std::sync::Arc<Mutex<Option<String>>>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HostStorageMode {
    Ready,
    Recovery,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostStorageStatus {
    mode: HostStorageMode,
    database_path: String,
    schema_version: Option<i64>,
    backup_path: Option<String>,
    recovery_reason: Option<String>,
}

struct OpenFailure {
    reason: String,
    backup_path: Option<PathBuf>,
}

impl HostRecovery {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }

    pub fn backup_path(&self) -> Option<&Path> {
        self.backup_path.as_deref()
    }
}

impl HostDatabaseOpen {
    pub fn open(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        match open_database(path.clone()) {
            Ok(database) => Self::Ready(database),
            Err(failure) => Self::Recovery(HostRecovery {
                path,
                reason: failure.reason,
                backup_path: failure.backup_path,
            }),
        }
    }
}

impl HostStore {
    pub fn open(path: impl Into<PathBuf>) -> Self {
        Self {
            state: std::sync::Arc::new(Mutex::new(HostDatabaseOpen::open(path))),
            maintenance: std::sync::Arc::new(Mutex::new(None)),
        }
    }

    pub fn status(&self) -> Result<HostStorageStatus, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Host storage state is unavailable".to_string())?;
        match &*state {
            HostDatabaseOpen::Ready(database) => Ok(HostStorageStatus {
                mode: HostStorageMode::Ready,
                database_path: database.path().to_string_lossy().into_owned(),
                schema_version: Some(
                    database
                        .schema_version()
                        .map_err(|error| format!("Cannot read Host schema version: {error}"))?,
                ),
                backup_path: database
                    .last_backup_path()
                    .map(|path| path.to_string_lossy().into_owned()),
                recovery_reason: None,
            }),
            HostDatabaseOpen::Recovery(recovery) => Ok(HostStorageStatus {
                mode: HostStorageMode::Recovery,
                database_path: recovery.path().to_string_lossy().into_owned(),
                schema_version: None,
                backup_path: recovery
                    .backup_path()
                    .map(|path| path.to_string_lossy().into_owned()),
                recovery_reason: Some(recovery.reason().to_string()),
            }),
        }
    }

    pub(crate) fn is_ready(&self) -> Result<bool, String> {
        Ok(self.status()?.mode == HostStorageMode::Ready)
    }

    pub(crate) fn current_schema_version(&self) -> Result<u64, String> {
        let version = self
            .status()?
            .schema_version
            .ok_or_else(|| "Host schema is unavailable in recovery mode".to_string())?;
        u64::try_from(version).map_err(|_| "Host schema version is invalid".to_string())
    }

    pub(crate) fn with_ready_database<T>(
        &self,
        operation: impl FnOnce(&mut HostDatabase) -> Result<T, String>,
    ) -> Result<T, String> {
        if self
            .maintenance
            .lock()
            .map_err(|_| "Host storage maintenance state is unavailable".to_string())?
            .is_some()
        {
            return Err("Host storage is paused for maintenance".to_string());
        }
        self.with_ready_database_inner(operation)
    }

    fn with_ready_database_inner<T>(
        &self,
        operation: impl FnOnce(&mut HostDatabase) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Host storage state is unavailable".to_string())?;
        match &mut *state {
            HostDatabaseOpen::Ready(database) => operation(database),
            HostDatabaseOpen::Recovery(recovery) => Err(format!(
                "Host storage is in recovery mode: {}",
                recovery.reason()
            )),
        }
    }

    pub(crate) fn begin_maintenance(&self, token: &str) -> Result<(), String> {
        if token.len() != 64
            || !token
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err("Host storage maintenance token is invalid".to_string());
        }
        let mut maintenance = self
            .maintenance
            .lock()
            .map_err(|_| "Host storage maintenance state is unavailable".to_string())?;
        match maintenance.as_deref() {
            Some(existing) if existing == token => return Ok(()),
            Some(_) => return Err("A different Host storage maintenance is active".to_string()),
            None => *maintenance = Some(token.to_string()),
        }
        let ready = self.is_ready();
        if !matches!(ready, Ok(true)) {
            *maintenance = None;
            return match ready {
                Ok(false) => Err("Host storage maintenance requires a ready Host".to_string()),
                Err(error) => Err(error),
                Ok(true) => unreachable!(),
            };
        }
        Ok(())
    }

    pub(crate) fn end_maintenance(&self, token: &str) -> Result<(), String> {
        let mut maintenance = self
            .maintenance
            .lock()
            .map_err(|_| "Host storage maintenance state is unavailable".to_string())?;
        match maintenance.as_deref() {
            Some(existing) if existing == token => {
                *maintenance = None;
                Ok(())
            }
            Some(_) => Err("Host storage maintenance token does not match".to_string()),
            None => Ok(()),
        }
    }

    pub(crate) fn create_consistent_snapshot(&self, destination: &Path) -> Result<(), String> {
        self.create_consistent_snapshot_inner(destination, None)
    }

    pub(crate) fn create_consistent_snapshot_for_maintenance(
        &self,
        destination: &Path,
        token: &str,
    ) -> Result<(), String> {
        self.create_consistent_snapshot_inner(destination, Some(token))
    }

    fn create_consistent_snapshot_inner(
        &self,
        destination: &Path,
        maintenance_token: Option<&str>,
    ) -> Result<(), String> {
        let parent = destination
            .parent()
            .ok_or_else(|| "Host snapshot destination has no parent directory".to_string())?;
        let mut snapshot_created = false;
        let snapshot_operation = |database: &mut HostDatabase| {
            let snapshot = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(destination)
                .map_err(|error| format!("Cannot reserve Host snapshot: {error}"))?;
            snapshot_created = true;
            drop(snapshot);
            let mut destination_database =
                Connection::open_with_flags(destination, OpenFlags::SQLITE_OPEN_READ_WRITE)
                    .map_err(|error| format!("Cannot open Host snapshot: {error}"))?;
            {
                let backup = Backup::new(&database.connection, &mut destination_database)
                    .map_err(|error| format!("Cannot start Host snapshot: {error}"))?;
                backup
                    .run_to_completion(128, Duration::from_millis(10), None)
                    .map_err(|error| format!("Cannot complete Host snapshot: {error}"))?;
            }
            require_integrity(&destination_database)?;
            drop(destination_database);
            fs::File::open(destination)
                .and_then(|file| file.sync_all())
                .map_err(|error| format!("Cannot sync Host snapshot: {error}"))?;
            fs::File::open(parent)
                .and_then(|directory| directory.sync_all())
                .map_err(|error| format!("Cannot sync Host snapshot directory: {error}"))
        };
        let result = if let Some(token) = maintenance_token {
            let maintenance = self
                .maintenance
                .lock()
                .map_err(|_| "Host storage maintenance state is unavailable".to_string())?;
            if maintenance.as_deref() != Some(token) {
                return Err("Host storage maintenance token does not match".to_string());
            }
            self.with_ready_database_inner(snapshot_operation)
        } else {
            self.with_ready_database(snapshot_operation)
        };
        if result.is_err() && snapshot_created {
            let _ = fs::remove_file(destination);
        }
        result
    }

    pub(crate) fn recovery_path(&self) -> Result<PathBuf, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Host storage state is unavailable".to_string())?;
        match &*state {
            HostDatabaseOpen::Ready(_) => Err("Host storage is not in recovery mode".to_string()),
            HostDatabaseOpen::Recovery(recovery) => Ok(recovery.path.clone()),
        }
    }
}

impl HostDatabase {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn schema_version(&self) -> rusqlite::Result<i64> {
        schema_version(&self.connection)
    }

    pub fn application_id(&self) -> rusqlite::Result<i64> {
        application_id(&self.connection)
    }

    pub fn last_backup_path(&self) -> Option<&Path> {
        self.last_backup_path.as_deref()
    }
}

#[tauri::command]
pub fn host_storage_status(store: State<'_, HostStore>) -> Result<HostStorageStatus, String> {
    store.status()
}

fn open_database(path: PathBuf) -> Result<HostDatabase, OpenFailure> {
    let parent = path.parent().ok_or_else(|| OpenFailure {
        reason: "Host database path has no parent directory".to_string(),
        backup_path: None,
    })?;
    fs::create_dir_all(parent).map_err(|error| OpenFailure {
        reason: format!("Cannot create Host database directory: {error}"),
        backup_path: None,
    })?;

    let needs_backup = path.metadata().is_ok_and(|metadata| metadata.len() > 0);
    let mut connection = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )
    .map_err(|error| OpenFailure {
        reason: format!("Cannot open Host database: {error}"),
        backup_path: None,
    })?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| OpenFailure {
            reason: format!("Cannot configure Host database timeout: {error}"),
            backup_path: None,
        })?;
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(|error| OpenFailure {
            reason: format!("Cannot enable Host database foreign keys: {error}"),
            backup_path: None,
        })?;

    require_integrity(&connection).map_err(|reason| OpenFailure {
        reason,
        backup_path: None,
    })?;

    let found_application_id = application_id(&connection).map_err(|error| OpenFailure {
        reason: format!("Cannot read Host database application ID: {error}"),
        backup_path: None,
    })?;
    if found_application_id != 0 && found_application_id != APPLICATION_ID {
        return Err(OpenFailure {
            reason: format!(
                "Host database belongs to application ID {found_application_id}, expected {APPLICATION_ID}"
            ),
            backup_path: None,
        });
    }

    let found_version = schema_version(&connection).map_err(|error| OpenFailure {
        reason: format!("Cannot read Host database schema version: {error}"),
        backup_path: None,
    })?;
    if found_version > CURRENT_SCHEMA_VERSION {
        return Err(OpenFailure {
            reason: format!(
                "Host database schema {found_version} is newer than supported schema {CURRENT_SCHEMA_VERSION}"
            ),
            backup_path: None,
        });
    }

    let backup_path = if found_version < CURRENT_SCHEMA_VERSION && needs_backup {
        Some(
            backup_database(&connection, &path, found_version, CURRENT_SCHEMA_VERSION).map_err(
                |reason| OpenFailure {
                    reason,
                    backup_path: None,
                },
            )?,
        )
    } else {
        None
    };

    if found_version < CURRENT_SCHEMA_VERSION {
        migrate(&mut connection, found_version).map_err(|reason| OpenFailure {
            reason,
            backup_path: backup_path.clone(),
        })?;
    }

    configure_ready_connection(&connection).map_err(|reason| OpenFailure {
        reason,
        backup_path: backup_path.clone(),
    })?;
    require_integrity(&connection).map_err(|reason| OpenFailure {
        reason,
        backup_path: backup_path.clone(),
    })?;

    Ok(HostDatabase {
        connection,
        path,
        last_backup_path: backup_path,
    })
}

fn schema_version(connection: &Connection) -> rusqlite::Result<i64> {
    connection.pragma_query_value(None, "user_version", |row| row.get(0))
}

fn application_id(connection: &Connection) -> rusqlite::Result<i64> {
    connection.pragma_query_value(None, "application_id", |row| row.get(0))
}

fn require_integrity(connection: &Connection) -> Result<(), String> {
    let result = connection
        .query_row("PRAGMA quick_check(1)", [], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Host database integrity check failed: {error}"))?;
    if result == "ok" {
        Ok(())
    } else {
        Err(format!("Host database integrity check failed: {result}"))
    }
}

fn configure_ready_connection(connection: &Connection) -> Result<(), String> {
    let journal_mode = connection
        .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get::<_, String>(0))
        .map_err(|error| format!("Cannot enable Host database WAL mode: {error}"))?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(format!(
            "Host database refused WAL mode and returned {journal_mode}"
        ));
    }
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|error| format!("Cannot enable Host database full synchronization: {error}"))?;
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(|error| format!("Cannot enable Host database foreign keys: {error}"))?;
    Ok(())
}

fn migrate(connection: &mut Connection, from_version: i64) -> Result<(), String> {
    if !(0..CURRENT_SCHEMA_VERSION).contains(&from_version) {
        return Err(format!(
            "No Host database migration path from schema {from_version} to {CURRENT_SCHEMA_VERSION}"
        ));
    }

    let applied_at = now_millis();
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Cannot begin Host database migration: {error}"))?;
    if from_version < 1 {
        transaction
            .execute_batch(SCHEMA_V1)
            .map_err(|error| format!("Cannot apply Host database schema 1: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?1, ?2, ?3)",
                params![1_i64, "host_foundation", applied_at],
            )
            .map_err(|error| format!("Cannot record Host database migration 1: {error}"))?;
    }
    if from_version < 2 {
        transaction
            .execute_batch(SCHEMA_V2)
            .map_err(|error| format!("Cannot apply Host database schema 2: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?1, ?2, ?3)",
                params![2_i64, "legacy_migration_ledger", applied_at],
            )
            .map_err(|error| format!("Cannot record Host database migration 2: {error}"))?;
    }
    if from_version < 3 {
        transaction
            .execute_batch(SCHEMA_V3)
            .map_err(|error| format!("Cannot apply Host database schema 3: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?1, ?2, ?3)",
                params![3_i64, "native_session_locators", applied_at],
            )
            .map_err(|error| format!("Cannot record Host database migration 3: {error}"))?;
    }
    if from_version < 4 {
        transaction
            .execute_batch(SCHEMA_V4)
            .map_err(|error| format!("Cannot apply Host database schema 4: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?1, ?2, ?3)",
                params![4_i64, "managed_worktrees", applied_at],
            )
            .map_err(|error| format!("Cannot record Host database migration 4: {error}"))?;
    }
    if from_version < 5 {
        transaction
            .execute_batch(SCHEMA_V5)
            .map_err(|error| format!("Cannot apply Host database schema 5: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?1, ?2, ?3)",
                params![5_i64, "managed_worktree_removals", applied_at],
            )
            .map_err(|error| format!("Cannot record Host database migration 5: {error}"))?;
    }
    if from_version < 6 {
        transaction
            .execute_batch(SCHEMA_V6)
            .map_err(|error| format!("Cannot apply Host database schema 6: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?1, ?2, ?3)",
                params![6_i64, "turn_change_reviews", applied_at],
            )
            .map_err(|error| format!("Cannot record Host database migration 6: {error}"))?;
    }
    if from_version < 7 {
        transaction
            .execute_batch(SCHEMA_V7)
            .map_err(|error| format!("Cannot apply Host database schema 7: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?1, ?2, ?3)",
                params![7_i64, "lifemodel_document", applied_at],
            )
            .map_err(|error| format!("Cannot record Host database migration 7: {error}"))?;
    }
    if from_version < 8 {
        transaction
            .execute_batch(SCHEMA_V8)
            .map_err(|error| format!("Cannot apply Host database schema 8: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?1, ?2, ?3)",
                params![8_i64, "system_installation_launches", applied_at],
            )
            .map_err(|error| format!("Cannot record Host database migration 8: {error}"))?;
    }
    if from_version < 9 {
        transaction
            .execute_batch(SCHEMA_V9)
            .map_err(|error| format!("Cannot apply Host database schema 9: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?1, ?2, ?3)",
                params![9_i64, "provider_connections", applied_at],
            )
            .map_err(|error| format!("Cannot record Host database migration 9: {error}"))?;
    }
    if from_version < 10 {
        transaction
            .execute_batch(SCHEMA_V10)
            .map_err(|error| format!("Cannot apply Host database schema 10: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?1, ?2, ?3)",
                params![10_i64, "provider_credential_revisions", applied_at],
            )
            .map_err(|error| format!("Cannot record Host database migration 10: {error}"))?;
    }
    if from_version < 11 {
        transaction
            .execute_batch(SCHEMA_V11)
            .map_err(|error| format!("Cannot apply Host database schema 11: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?1, ?2, ?3)",
                params![11_i64, "runtime_owned_profiles", applied_at],
            )
            .map_err(|error| format!("Cannot record Host database migration 11: {error}"))?;
    }
    if from_version < 12 {
        transaction
            .execute_batch(SCHEMA_V12)
            .map_err(|error| format!("Cannot apply Host database schema 12: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?1, ?2, ?3)",
                params![12_i64, "turn_model_sources", applied_at],
            )
            .map_err(|error| format!("Cannot record Host database migration 12: {error}"))?;
    }
    if from_version < 13 {
        transaction
            .execute_batch(SCHEMA_V13)
            .map_err(|error| format!("Cannot apply Host database schema 13: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?1, ?2, ?3)",
                params![13_i64, "profile_provider_versions", applied_at],
            )
            .map_err(|error| format!("Cannot record Host database migration 13: {error}"))?;
    }
    if from_version < 14 {
        transaction
            .execute_batch(SCHEMA_V14)
            .map_err(|error| format!("Cannot apply Host database schema 14: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?1, ?2, ?3)",
                params![14_i64, "optional_profile_bootstrap", applied_at],
            )
            .map_err(|error| format!("Cannot record Host database migration 14: {error}"))?;
    }
    if from_version < 15 {
        transaction
            .execute_batch(SCHEMA_V15)
            .map_err(|error| format!("Cannot apply Host database schema 15: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?1, ?2, ?3)",
                params![15_i64, "codex_owned_profile", applied_at],
            )
            .map_err(|error| format!("Cannot record Host database migration 15: {error}"))?;
    }
    transaction
        .pragma_update(None, "application_id", APPLICATION_ID)
        .map_err(|error| format!("Cannot set Host database application ID: {error}"))?;
    transaction
        .pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION)
        .map_err(|error| format!("Cannot set Host database schema version: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit Host database migration: {error}"))
}

fn backup_database(
    source: &Connection,
    source_path: &Path,
    from_version: i64,
    to_version: i64,
) -> Result<PathBuf, String> {
    let parent = source_path
        .parent()
        .ok_or_else(|| "Host database path has no parent directory".to_string())?;
    let file_name = source_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("farfold-host.sqlite3");
    let suffix = format!(
        "{}-{}",
        now_millis(),
        BACKUP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let final_path = parent.join(format!(
        "{file_name}.backup-v{from_version}-to-v{to_version}-{suffix}"
    ));
    let temporary_path = parent.join(format!(
        ".{file_name}.backup-v{from_version}-to-v{to_version}-{suffix}.incomplete"
    ));

    // Reserve a private, new file before SQLite opens it; SQLite's default
    // creation permissions otherwise expose the user-data backup as 0644.
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary_path)
        .map_err(|error| format!("Cannot reserve Host database backup: {error}"))?;

    let result = (|| -> Result<(), String> {
        let mut destination =
            Connection::open_with_flags(&temporary_path, OpenFlags::SQLITE_OPEN_READ_WRITE)
                .map_err(|error| format!("Cannot create Host database backup: {error}"))?;
        {
            let backup = Backup::new(source, &mut destination)
                .map_err(|error| format!("Cannot start Host database backup: {error}"))?;
            backup
                .run_to_completion(128, Duration::from_millis(10), None)
                .map_err(|error| format!("Cannot complete Host database backup: {error}"))?;
        }
        let journal_mode = destination
            .pragma_update_and_check(None, "journal_mode", "DELETE", |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| {
                format!("Cannot make Host migration backup self-contained: {error}")
            })?;
        if !journal_mode.eq_ignore_ascii_case("delete") {
            return Err("Host migration backup is not self-contained".to_string());
        }
        require_integrity(&destination)?;
        drop(destination);
        fs::rename(&temporary_path, &final_path)
            .map_err(|error| format!("Cannot activate Host database backup: {error}"))?;
        if let Ok(directory) = fs::File::open(parent) {
            directory
                .sync_all()
                .map_err(|error| format!("Cannot sync Host database backup directory: {error}"))?;
        }
        Ok(())
    })();

    if let Err(reason) = result {
        let _ = fs::remove_file(&temporary_path);
        return Err(reason);
    }
    Ok(final_path)
}

pub(crate) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{
        APPLICATION_ID, CURRENT_SCHEMA_VERSION, HostDatabase, HostDatabaseOpen, HostRecovery,
        HostStorageMode, HostStore, SCHEMA_V1,
    };
    use rusqlite::{Connection, params};
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, Ordering},
    };

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "farfold-host-store-{name}-{}-{}",
                std::process::id(),
                TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn database_path(&self) -> PathBuf {
            self.0.join("farfold-host.sqlite3")
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn ready(opened: HostDatabaseOpen) -> HostDatabase {
        match opened {
            HostDatabaseOpen::Ready(database) => database,
            HostDatabaseOpen::Recovery(recovery) => {
                panic!("expected ready database: {}", recovery.reason())
            }
        }
    }

    fn recovery(opened: HostDatabaseOpen) -> HostRecovery {
        match opened {
            HostDatabaseOpen::Recovery(recovery) => recovery,
            HostDatabaseOpen::Ready(_) => panic!("expected recovery mode"),
        }
    }

    fn historical_database(path: &Path, version: usize) -> HostDatabase {
        assert!((1..=14).contains(&version));
        let connection = Connection::open(path).unwrap();
        connection
            .pragma_update(None, "foreign_keys", true)
            .unwrap();
        for (index, schema) in [
            super::SCHEMA_V1,
            super::SCHEMA_V2,
            super::SCHEMA_V3,
            super::SCHEMA_V4,
            super::SCHEMA_V5,
            super::SCHEMA_V6,
            super::SCHEMA_V7,
            super::SCHEMA_V8,
            super::SCHEMA_V9,
            super::SCHEMA_V10,
            super::SCHEMA_V11,
            super::SCHEMA_V12,
            super::SCHEMA_V13,
            super::SCHEMA_V14,
        ]
        .into_iter()
        .take(version)
        .enumerate()
        {
            connection.execute_batch(schema).unwrap();
            connection.execute("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?1, 'historical-fixture', 1)", [index as i64 + 1]).unwrap();
        }
        connection
            .pragma_update(None, "application_id", APPLICATION_ID)
            .unwrap();
        connection
            .pragma_update(None, "user_version", version as i64)
            .unwrap();
        HostDatabase {
            connection,
            path: path.to_path_buf(),
            last_backup_path: None,
        }
    }

    #[test]
    fn schema_fourteen_upgrade_preserves_existing_session_and_native_only_profile() {
        let directory = TestDirectory::new("schema-fourteen-upgrade");
        let path = directory.database_path();
        let database = historical_database(&path, 14);
        insert_complete_binding(&database);
        database.connection.execute("INSERT INTO session_native_locators VALUES ('session-1', 'pi_session_file', '/original/pi/session.jsonl', 1, 2)", []).unwrap();
        database
            .connection
            .execute(
                "INSERT INTO session_drafts VALUES ('session-1', 'KEEP-14', 2)",
                [],
            )
            .unwrap();
        database.connection.execute("INSERT INTO runtime_builds VALUES ('pi-acp-build', 'managed-pi', 'pi', 'pi-acp-stdio-v1', '0.84.3', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1, 1)", []).unwrap();
        database.connection.execute("INSERT INTO runtime_connections VALUES ('pi-acp-local', 'managed-pi', 'pi', 'Pi ACP', 'managed_local', 1, 1)", []).unwrap();
        database.connection.execute("INSERT INTO runtime_owned_profiles VALUES ('native-profile', 'stable_v1', 'pi-acp-local', 'managed-pi', 'pi', 'pi-acp-build', 'pi-acp-stdio-v1', NULL, NULL, 1)", []).unwrap();
        drop(database);
        let upgraded = ready(HostDatabaseOpen::open(&path));
        let backup = Connection::open_with_flags(
            upgraded.last_backup_path().unwrap(),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        assert_eq!(super::schema_version(&backup).unwrap(), 14);
        for connection in [&upgraded.connection, &backup] {
            assert_eq!(
                connection
                    .query_row(
                        "SELECT body FROM session_drafts WHERE farfold_session_id='session-1'",
                        [],
                        |r| r.get::<_, String>(0)
                    )
                    .unwrap(),
                "KEEP-14"
            );
            assert_eq!(connection.query_row("SELECT COUNT(*) FROM runtime_owned_profiles WHERE profile_id='native-profile' AND bootstrap_provider_connection_id IS NULL", [], |r|r.get::<_,i64>(0)).unwrap(), 1);
            assert_eq!(connection.query_row("SELECT locator_kind, locator_value, created_at, updated_at FROM session_native_locators WHERE farfold_session_id='session-1'", [], |r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,i64>(3)?))).unwrap(), ("pi_session_file".into(),"/original/pi/session.jsonl".into(),1,2));
            assert_eq!(
                connection
                    .query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))
                    .unwrap(),
                "ok"
            );
        }
        assert_eq!(
            upgraded
                .connection
                .query_row(
                    "SELECT COUNT(*) FROM runtime_owned_profile_launches",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }

    fn insert_complete_binding(database: &HostDatabase) {
        let connection = &database.connection;
        connection
            .execute(
                "INSERT INTO runtime_products VALUES (?1, ?2, ?3, ?3)",
                params!["pi", "Pi", 1_i64],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO runtime_installations VALUES (?1, ?2, ?3, ?4, ?4)",
                params!["managed-pi", "pi", "managed", 1_i64],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO runtime_builds VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![
                    "pi@0.84.3+sha256:e844dc14",
                    "managed-pi",
                    "pi",
                    "pi-rpc-jsonl",
                    "0.84.3",
                    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    1_i64
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO runtime_connections VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![
                    "pi-local",
                    "managed-pi",
                    "pi",
                    "Pi native configuration",
                    "managed_local",
                    1_i64
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO projects VALUES (?1, ?2, ?3, ?4, ?4)",
                params!["project-1", "/project", "Project", 1_i64],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO working_copies VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?5)",
                params!["copy-1", "project-1", "/project", "root", 1_i64],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO sessions(
                    farfold_session_id,
                    runtime_product_id,
                    installation_id,
                    runtime_build_id,
                    adapter_id,
                    connection_id,
                    project_id,
                    working_copy_id,
                    native_session_id,
                    title,
                    title_source,
                    pinned,
                    archived_at,
                    created_at,
                    updated_at,
                    last_opened_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                    ?9, ?10, ?11, 0, NULL, ?12, ?12, ?12
                )",
                params![
                    "session-1",
                    "pi",
                    "managed-pi",
                    "pi@0.84.3+sha256:e844dc14",
                    "pi-rpc-jsonl",
                    "pi-local",
                    "project-1",
                    "copy-1",
                    "native-1",
                    "First Session",
                    "first_user",
                    1_i64
                ],
            )
            .unwrap();
    }

    #[test]
    fn fresh_database_has_identity_schema_and_foreign_keys() {
        let directory = TestDirectory::new("fresh");
        let database = ready(HostDatabaseOpen::open(directory.database_path()));

        assert_eq!(database.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
        assert_eq!(database.application_id().unwrap(), APPLICATION_ID);
        assert!(database.last_backup_path().is_none());
        insert_complete_binding(&database);

        database
            .connection
            .execute(
                "INSERT INTO runtime_builds VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![
                    "pi@0.84.4+sha256:bbbbbbbb",
                    "managed-pi",
                    "pi",
                    "pi-rpc-jsonl",
                    "0.84.4",
                    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    2_i64
                ],
            )
            .unwrap();
        assert_eq!(
            database
                .connection
                .query_row(
                    "SELECT count(*) FROM runtime_builds WHERE installation_id = 'managed-pi'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            2
        );

        let duplicate = database.connection.execute(
            "INSERT INTO sessions(
                farfold_session_id,
                runtime_product_id,
                installation_id,
                runtime_build_id,
                adapter_id,
                connection_id,
                project_id,
                working_copy_id,
                native_session_id,
                title,
                title_source,
                pinned,
                archived_at,
                created_at,
                updated_at,
                last_opened_at
            ) SELECT
                'session-2',
                runtime_product_id,
                installation_id,
                runtime_build_id,
                adapter_id,
                connection_id,
                project_id,
                working_copy_id,
                native_session_id,
                title,
                title_source,
                pinned,
                archived_at,
                created_at,
                updated_at,
                last_opened_at
            FROM sessions WHERE farfold_session_id = 'session-1'",
            [],
        );
        assert!(duplicate.is_err());
    }

    #[test]
    fn consistent_snapshot_is_private_complete_and_never_clobbered() {
        let directory = TestDirectory::new("consistent-snapshot");
        let store = HostStore::open(directory.database_path());
        store
            .with_ready_database(|database| {
                insert_complete_binding(database);
                Ok(())
            })
            .unwrap();
        let snapshot_path = directory.0.join("update-smoke.sqlite3");
        store.create_consistent_snapshot(&snapshot_path).unwrap();
        assert_eq!(
            fs::metadata(&snapshot_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let snapshot = ready(HostDatabaseOpen::open(&snapshot_path));
        assert_eq!(
            snapshot
                .connection
                .query_row("SELECT COUNT(*) FROM sessions", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(snapshot);
        assert!(store.create_consistent_snapshot(&snapshot_path).is_err());
        assert!(snapshot_path.is_file());

        let token = "a".repeat(64);
        store.begin_maintenance(&token).unwrap();
        assert!(store.with_ready_database(|_| Ok(())).is_err());
        let maintenance_snapshot = directory.0.join("maintenance-snapshot.sqlite3");
        store
            .create_consistent_snapshot_for_maintenance(&maintenance_snapshot, &token)
            .unwrap();
        assert!(maintenance_snapshot.is_file());
        store.end_maintenance(&token).unwrap();
        assert!(store.with_ready_database(|_| Ok(())).is_ok());
    }

    #[test]
    fn schema_thirteen_upgrade_preserves_profiles_exact_grants_and_drafts() {
        let directory = TestDirectory::new("schema-thirteen-optional-bootstrap");
        let path = directory.database_path();
        let database = historical_database(&path, 13);
        insert_complete_binding(&database);
        database.connection.execute_batch(
            "INSERT INTO provider_connections VALUES ('provider-old', 'key', 'Old provider', 'farfold_managed', 'v2', 1, 2);
             INSERT INTO provider_connection_versions(provider_connection_id, config_version_id, endpoint_fingerprint, model_mapping_fingerprint, created_at)
                VALUES ('provider-old', 'v1', 'endpoint-old', 'mapping-old', 1), ('provider-old', 'v2', 'endpoint-new', 'mapping-new', 2);
             INSERT INTO runtime_owned_profiles VALUES ('stable-profile', 'stable_v1', 'pi-local', 'managed-pi', 'pi', 'pi@0.84.3+sha256:e844dc14', 'pi-rpc-jsonl', 'provider-old', 'v1', 1);
             INSERT INTO runtime_profile_provider_versions VALUES ('stable-profile', 'provider-old', 'v1', 1), ('stable-profile', 'provider-old', 'v2', 2);
             INSERT INTO session_drafts VALUES ('session-1', 'KEEP-DRAFT-13-TO-14', 2);"
        ).unwrap();
        drop(database);
        let upgraded = ready(HostDatabaseOpen::open(&path));
        let backup = Connection::open_with_flags(
            upgraded.last_backup_path().unwrap(),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        assert_eq!(super::schema_version(&backup).unwrap(), 13);
        assert_eq!(upgraded.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
        let profile = |connection: &Connection| {
            connection.query_row("SELECT profile_id, bootstrap_provider_connection_id, bootstrap_provider_config_version_id, layout FROM runtime_owned_profiles", [],
            |row| Ok((row.get::<_,String>(0)?, row.get::<_,String>(1)?, row.get::<_,String>(2)?, row.get::<_,String>(3)?))).unwrap()
        };
        assert_eq!(profile(&backup), profile(&upgraded.connection));
        let grants = |connection: &Connection| {
            let mut statement = connection.prepare("SELECT profile_id, provider_connection_id, provider_config_version_id, authorized_at FROM runtime_profile_provider_versions ORDER BY authorized_at").unwrap();
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(grants(&backup), grants(&upgraded.connection));
        assert_eq!(
            upgraded
                .connection
                .query_row(
                    "SELECT body FROM session_drafts WHERE farfold_session_id = 'session-1'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "KEEP-DRAFT-13-TO-14"
        );
        assert_eq!(
            upgraded
                .connection
                .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
        assert!(
            upgraded
                .connection
                .execute(
                    "UPDATE runtime_owned_profiles SET bootstrap_provider_config_version_id = NULL",
                    []
                )
                .is_err()
        );
        assert!(
            upgraded
                .connection
                .execute(
                    "DELETE FROM provider_connection_versions WHERE config_version_id = 'v2'",
                    []
                )
                .is_err()
        );
    }

    #[test]
    fn schema_twelve_upgrade_grants_only_exact_stable_bootstrap_and_preserves_history() {
        let directory = TestDirectory::new("schema-twelve-profile-versions");
        let path = directory.database_path();
        let database = historical_database(&path, 12);
        insert_complete_binding(&database);
        database.connection.execute_batch(
            "INSERT INTO provider_connections VALUES ('provider-old', 'key', 'Old provider', 'farfold_managed', 'v2', 1, 2);
             INSERT INTO provider_connection_versions(provider_connection_id, config_version_id, endpoint_fingerprint, model_mapping_fingerprint, created_at)
                VALUES ('provider-old', 'v1', 'endpoint-old', 'mapping-old', 1), ('provider-old', 'v2', 'endpoint-new', 'mapping-new', 2);
             INSERT INTO runtime_connections VALUES ('legacy-local', 'managed-pi', 'pi', 'Legacy profile', 'managed_local', 1, 1);
             INSERT INTO runtime_owned_profiles VALUES ('stable-profile', 'stable_v1', 'pi-local', 'managed-pi', 'pi', 'pi@0.84.3+sha256:e844dc14', 'pi-rpc-jsonl', 'provider-old', 'v1', 1);
             INSERT INTO runtime_owned_profiles VALUES ('legacy-profile', 'legacy_provider_bound_v1', 'legacy-local', 'managed-pi', 'pi', 'pi@0.84.3+sha256:e844dc14', 'pi-rpc-jsonl', 'provider-old', 'v1', 1);
             INSERT INTO session_drafts VALUES ('session-1', 'KEEP-DRAFT-12-TO-13', 2);"
        ).unwrap();
        drop(database);
        let upgraded = ready(HostDatabaseOpen::open(&path));
        let backup = Connection::open_with_flags(
            upgraded.last_backup_path().unwrap(),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        assert_eq!(super::schema_version(&backup).unwrap(), 12);
        assert_eq!(upgraded.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
        assert_eq!(
            upgraded
                .connection
                .query_row(
                    "SELECT count(*) FROM runtime_profile_provider_versions",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(upgraded.connection.query_row("SELECT profile_id, provider_connection_id, provider_config_version_id FROM runtime_profile_provider_versions", [], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))).unwrap(), ("stable-profile".into(), "provider-old".into(), "v1".into()));
        assert!(
            upgraded
                .connection
                .execute(
                    "DELETE FROM provider_connection_versions WHERE config_version_id = 'v1'",
                    []
                )
                .is_err()
        );
        for connection in [&backup, &upgraded.connection] {
            assert_eq!(
                connection
                    .query_row(
                        "SELECT body FROM session_drafts WHERE farfold_session_id = 'session-1'",
                        [],
                        |row| row.get::<_, String>(0)
                    )
                    .unwrap(),
                "KEEP-DRAFT-12-TO-13"
            );
            assert_eq!(connection.query_row("SELECT native_session_id FROM sessions WHERE farfold_session_id = 'session-1'", [], |row| row.get::<_, String>(0)).unwrap(), "native-1");
            assert_eq!(
                connection
                    .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
                    .unwrap(),
                "ok"
            );
            assert!(
                !connection
                    .prepare("PRAGMA foreign_key_check")
                    .unwrap()
                    .exists([])
                    .unwrap()
            );
        }
    }

    #[test]
    fn schema_eleven_upgrade_preserves_managed_turns_and_native_session_with_backup() {
        let directory = TestDirectory::new("schema-eleven-model-sources");
        let path = directory.database_path();
        let database = historical_database(&path, 11);
        insert_complete_binding(&database);
        database.connection.execute_batch(
            "INSERT INTO provider_connections VALUES ('provider-old', 'key', 'Old provider', 'farfold_managed', 'v1', 1, 1);
             INSERT INTO provider_connection_versions(provider_connection_id, config_version_id, endpoint_fingerprint, model_mapping_fingerprint, created_at)
                VALUES ('provider-old', 'v1', 'endpoint-old', 'mapping-old', 1);
             INSERT INTO provider_target_projections VALUES ('provider-old', 'pi', 'managed-pi', 'pi-local', 'v1', 'provider-old', 'provider-old/model', 'saved', 'applied', 'verified_success', 'v1', 'current_task_keeps_bound_config', NULL, 1);
             INSERT INTO turn_provider_bindings VALUES ('turn-old', 'provider-old', 'v1', 'pi', 'managed-pi', 'pi-local', 'provider-old', 'provider-old/model', 1);
             INSERT INTO session_drafts VALUES ('session-1', 'KEEP-DRAFT-11-TO-12', 2);"
        ).unwrap();
        drop(database);
        let upgraded = ready(HostDatabaseOpen::open(&path));
        let backup = Connection::open_with_flags(
            upgraded.last_backup_path().unwrap(),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        assert_eq!(super::schema_version(&backup).unwrap(), 11);
        assert_eq!(upgraded.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
        for connection in [&backup, &upgraded.connection] {
            assert_eq!(connection.query_row("SELECT provider_connection_id, provider_config_version_id, runtime_model_id FROM turn_provider_bindings WHERE host_turn_id = 'turn-old'", [], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))).unwrap(), ("provider-old".into(), "v1".into(), "provider-old/model".into()));
            assert_eq!(
                connection
                    .query_row(
                        "SELECT body FROM session_drafts WHERE farfold_session_id = 'session-1'",
                        [],
                        |row| row.get::<_, String>(0)
                    )
                    .unwrap(),
                "KEEP-DRAFT-11-TO-12"
            );
            assert_eq!(connection.query_row("SELECT native_session_id FROM sessions WHERE farfold_session_id = 'session-1'", [], |row| row.get::<_, String>(0)).unwrap(), "native-1");
            assert_eq!(
                connection
                    .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
                    .unwrap(),
                "ok"
            );
            assert!(
                !connection
                    .prepare("PRAGMA foreign_key_check")
                    .unwrap()
                    .exists([])
                    .unwrap()
            );
        }
        assert_eq!(upgraded.connection.query_row("SELECT source_kind FROM turn_provider_bindings WHERE host_turn_id = 'turn-old'", [], |row| row.get::<_, String>(0)).unwrap(), "managed_version");
        assert!(upgraded.connection.execute("UPDATE turn_provider_bindings SET provider_config_version_id = 'missing' WHERE host_turn_id = 'turn-old'", []).is_err());
        assert!(upgraded.connection.execute("UPDATE turn_provider_bindings SET provider_connection_id = NULL WHERE host_turn_id = 'turn-old'", []).is_err());
    }

    #[test]
    fn native_model_observation_is_session_bound_immutable_and_not_a_managed_version() {
        use crate::host_ids::*;
        use crate::host_store::provider_projection::NativeTurnModelObservationInput;
        let directory = TestDirectory::new("native-turn-observation");
        let store = HostStore::open(directory.database_path());
        store
            .with_ready_database(|database| {
                insert_complete_binding(database);
                Ok(())
            })
            .unwrap();
        let input = NativeTurnModelObservationInput {
            host_turn_id: HostTurnId::parse("native-turn").unwrap(),
            farfold_session_id: FarfoldSessionId::parse("session-1").unwrap(),
            native_session_id: NativeSessionId::parse("native-1").unwrap(),
            runtime: crate::runtime_registry::RuntimeBinding {
                product_id: RuntimeProductId::parse("pi").unwrap(),
                installation_id: InstallationId::parse("managed-pi").unwrap(),
                runtime_build_id: RuntimeBuildId::parse("pi@0.84.3+sha256:e844dc14").unwrap(),
                adapter_id: AdapterId::parse("pi-rpc-jsonl").unwrap(),
                connection_id: ConnectionId::parse("pi-local").unwrap(),
            },
            runtime_generation: 7,
            runtime_provider_id: "native-provider".into(),
            runtime_model_id: "native-provider/native-model".into(),
            native_model_id: "native-model".into(),
            observed_at: 1,
        };
        for field in [
            "session",
            "native",
            "connection",
            "installation",
            "build",
            "adapter",
            "generation",
            "future",
            "reserved",
            "model",
        ] {
            let mut wrong = input.clone();
            match field {
                "session" => wrong.farfold_session_id = FarfoldSessionId::parse("other").unwrap(),
                "native" => wrong.native_session_id = NativeSessionId::parse("other").unwrap(),
                "connection" => wrong.runtime.connection_id = ConnectionId::parse("other").unwrap(),
                "installation" => {
                    wrong.runtime.installation_id = InstallationId::parse("other").unwrap()
                }
                "build" => wrong.runtime.runtime_build_id = RuntimeBuildId::parse("other").unwrap(),
                "adapter" => wrong.runtime.adapter_id = AdapterId::parse("other").unwrap(),
                "generation" => wrong.runtime_generation = 0,
                "future" => wrong.observed_at = u64::MAX,
                "reserved" => wrong.runtime_provider_id = "farfold-managed-unbound".into(),
                "model" => wrong.native_model_id = "other".into(),
                _ => unreachable!(),
            }
            assert!(
                store.bind_native_turn_model_observation(&wrong).is_err(),
                "{field}"
            );
        }
        store.bind_native_turn_model_observation(&input).unwrap();
        assert!(
            store.bind_native_turn_model_observation(&input).is_err(),
            "cannot overwrite an admitted Turn's source"
        );
        store.with_ready_database(|database| {
            let connection = &database.connection;
            assert_eq!(connection.query_row("SELECT source_kind, provider_connection_id, provider_config_version_id, native_session_id, runtime_generation FROM turn_provider_bindings WHERE host_turn_id = 'native-turn'", [], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, String>(3)?, row.get::<_, i64>(4)?))).unwrap(), ("native_observation".into(), None, None, "native-1".into(), 7));
            assert_eq!(connection.query_row("SELECT COUNT(*) FROM provider_connections", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
            assert_eq!(connection.query_row("SELECT COUNT(*) FROM provider_target_projections", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
            assert!(connection.execute("UPDATE turn_provider_bindings SET source_kind = 'managed_version' WHERE host_turn_id = 'native-turn'", []).is_err());
            assert!(connection.execute("UPDATE turn_provider_bindings SET runtime_generation = 0 WHERE host_turn_id = 'native-turn'", []).is_err());
            connection.execute("DELETE FROM sessions WHERE farfold_session_id = 'session-1'", []).unwrap();
            assert_eq!(connection.query_row("SELECT COUNT(*) FROM turn_provider_bindings", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
            Ok(())
        }).unwrap();
    }

    #[test]
    fn schema_ten_upgrade_preserves_original_session_and_draft_with_paired_backup() {
        let directory = TestDirectory::new("schema-ten-upgrade");
        let path = directory.database_path();
        let database = historical_database(&path, 10);
        insert_complete_binding(&database);
        database.connection.execute("INSERT INTO session_drafts(farfold_session_id, body, updated_at) VALUES ('session-1', 'KEEP-DRAFT-10-TO-11', 2)", []).unwrap();
        drop(database);
        let upgraded = ready(HostDatabaseOpen::open(&path));
        assert_eq!(upgraded.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
        let backup = Connection::open_with_flags(
            upgraded.last_backup_path().unwrap(),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        assert_eq!(super::schema_version(&backup).unwrap(), 10);
        for connection in [&upgraded.connection, &backup] {
            assert_eq!(
                connection
                    .query_row(
                        "SELECT body FROM session_drafts WHERE farfold_session_id = 'session-1'",
                        [],
                        |row| row.get::<_, String>(0)
                    )
                    .unwrap(),
                "KEEP-DRAFT-10-TO-11"
            );
            assert_eq!(connection.query_row("SELECT COUNT(*) FROM sessions WHERE farfold_session_id = 'session-1' AND working_copy_id = 'copy-1'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
            assert_eq!(
                connection
                    .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
                    .unwrap(),
                "ok"
            );
        }
        assert_eq!(
            upgraded
                .connection
                .query_row("SELECT COUNT(*) FROM runtime_owned_profiles", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn schema_seven_upgrade_preserves_bindings_drafts_and_lifemodel_and_backs_up() {
        let directory = TestDirectory::new("schema-seven-upgrade");
        let path = directory.database_path();
        let database = historical_database(&path, 7);
        insert_complete_binding(&database);
        database.connection.execute("INSERT INTO session_drafts(farfold_session_id, body, updated_at) VALUES ('session-1', 'KEEP-DRAFT-7-TO-8', 2)", []).unwrap();
        let snapshot: String = database
            .connection
            .query_row(
                "SELECT snapshot_json FROM life_model_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        drop(database);
        let upgraded = ready(HostDatabaseOpen::open(&path));
        assert_eq!(upgraded.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
        let binding: (String, String, String) = upgraded.connection.query_row("SELECT native_session_id, title, working_copy_id FROM sessions WHERE farfold_session_id = 'session-1'", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap();
        assert_eq!(binding.2, "copy-1");
        let draft: String = upgraded
            .connection
            .query_row(
                "SELECT body FROM session_drafts WHERE farfold_session_id = 'session-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(draft, "KEEP-DRAFT-7-TO-8");
        let actual: String = upgraded
            .connection
            .query_row(
                "SELECT snapshot_json FROM life_model_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(snapshot, actual);
        let backup = Connection::open_with_flags(
            upgraded.last_backup_path().unwrap(),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        assert_eq!(
            backup
                .pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))
                .unwrap(),
            "delete"
        );
        assert_eq!(super::schema_version(&backup).unwrap(), 7);
        assert_eq!(backup.query_row("SELECT native_session_id, title, working_copy_id FROM sessions WHERE farfold_session_id = 'session-1'", [], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))).unwrap(), binding);
        assert_eq!(
            fs::metadata(upgraded.last_backup_path().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn migration_creates_a_consistent_backup_before_schema_change() {
        let directory = TestDirectory::new("backup");
        let path = directory.database_path();
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE sentinel(value TEXT NOT NULL);
                     INSERT INTO sentinel VALUES ('before-migration');
                     PRAGMA user_version = 0;",
                )
                .unwrap();
        }

        let database = ready(HostDatabaseOpen::open(&path));
        let backup_path = database.last_backup_path().unwrap();
        assert!(backup_path.is_file());
        assert_eq!(database.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);

        let backup =
            Connection::open_with_flags(backup_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        assert_eq!(
            backup
                .query_row("SELECT value FROM sentinel", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "before-migration"
        );
        assert_eq!(
            backup
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn schema_one_migrates_once_and_records_all_later_authority_tables() {
        let directory = TestDirectory::new("schema-one");
        let path = directory.database_path();
        {
            let connection = Connection::open(&path).unwrap();
            connection.execute_batch(SCHEMA_V1).unwrap();
            connection
                .execute(
                    "INSERT INTO schema_migrations(version, name, applied_at)
                     VALUES (1, 'host_foundation', 1)",
                    [],
                )
                .unwrap();
            connection
                .pragma_update(None, "application_id", APPLICATION_ID)
                .unwrap();
            connection.pragma_update(None, "user_version", 1).unwrap();
        }

        let database = ready(HostDatabaseOpen::open(&path));
        assert_eq!(database.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
        assert!(database.last_backup_path().is_some());
        assert_eq!(
            database
                .connection
                .query_row("SELECT count(*) FROM schema_migrations", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            CURRENT_SCHEMA_VERSION
        );
        assert_eq!(
            database
                .connection
                .query_row(
                    "SELECT name FROM schema_migrations WHERE version = 3",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "native_session_locators"
        );
        assert_eq!(
            database
                .connection
                .query_row(
                    "SELECT count(*) FROM pragma_table_info('session_native_locators')",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            5
        );
        assert_eq!(
            database
                .connection
                .query_row(
                    "SELECT name FROM schema_migrations WHERE version = 4",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "managed_worktrees"
        );
        assert_eq!(
            database
                .connection
                .query_row(
                    "SELECT count(*) FROM pragma_table_info('managed_worktrees')",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            10
        );
        assert_eq!(
            database
                .connection
                .query_row(
                    "SELECT name FROM schema_migrations WHERE version = 5",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "managed_worktree_removals"
        );
        assert_eq!(
            database
                .connection
                .query_row(
                    "SELECT count(*) FROM pragma_table_info('managed_worktree_removals')",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            11
        );
        assert_eq!(
            database
                .connection
                .query_row(
                    "SELECT name FROM schema_migrations WHERE version = 6",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "turn_change_reviews"
        );
        assert_eq!(
            database
                .connection
                .query_row(
                    "SELECT count(*) FROM pragma_table_info('turn_change_reviews')",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            15
        );
        assert_eq!(
            database
                .connection
                .query_row(
                    "SELECT count(*) FROM pragma_table_info('turn_change_paths')",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            4
        );
        assert_eq!(
            database
                .connection
                .query_row(
                    "SELECT name FROM schema_migrations WHERE version = 7",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "lifemodel_document"
        );
        assert_eq!(
            database
                .connection
                .query_row(
                    "SELECT count(*) FROM life_model_state WHERE singleton = 1",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            database
                .connection
                .query_row(
                    "SELECT name FROM schema_migrations WHERE version = 8",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "system_installation_launches"
        );
        assert_eq!(
            database
                .connection
                .query_row(
                    "SELECT count(*) FROM pragma_table_info('system_installation_launches')",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            5
        );
        assert_eq!(
            database
                .connection
                .query_row(
                    "SELECT name FROM schema_migrations WHERE version = 9",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "provider_connections"
        );
        assert_eq!(
            database
                .connection
                .query_row(
                    "SELECT count(*) FROM pragma_table_info('provider_target_projections')",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            14
        );
        assert_eq!(
            database
                .connection
                .query_row(
                    "SELECT count(*) FROM pragma_table_info('provider_connection_versions')",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            6
        );
        assert_eq!(
            database
                .connection
                .query_row(
                    "SELECT name FROM schema_migrations WHERE version = 10",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "provider_credential_revisions"
        );
        assert_eq!(
            database
                .connection
                .query_row("SELECT count(*) FROM legacy_migration_sources", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
        drop(database);

        let reopened = ready(HostDatabaseOpen::open(&path));
        assert!(reopened.last_backup_path().is_none());
        assert_eq!(reopened.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn newer_schema_enters_recovery_without_rewriting_the_database() {
        let directory = TestDirectory::new("future");
        let path = directory.database_path();
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .pragma_update(None, "application_id", APPLICATION_ID)
                .unwrap();
            connection.pragma_update(None, "user_version", 99).unwrap();
        }

        let state = recovery(HostDatabaseOpen::open(&path));
        assert_eq!(state.path(), Path::new(&path));
        assert!(state.reason().contains("newer than supported"));
        assert!(state.backup_path().is_none());

        let unchanged =
            Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(
            unchanged
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            99
        );
    }

    #[test]
    fn corrupt_database_enters_recovery_without_silent_empty_replacement() {
        let directory = TestDirectory::new("corrupt");
        let path = directory.database_path();
        let original = b"not-a-sqlite-database";
        fs::write(&path, original).unwrap();

        let state = recovery(HostDatabaseOpen::open(&path));
        assert!(state.reason().contains("integrity check"));
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    #[test]
    fn store_status_exposes_ready_and_recovery_without_mutating_either() {
        let ready_directory = TestDirectory::new("ready-status");
        let ready_store = HostStore::open(ready_directory.database_path());
        let ready_status = ready_store.status().unwrap();
        assert_eq!(ready_status.mode, HostStorageMode::Ready);
        assert_eq!(ready_status.schema_version, Some(CURRENT_SCHEMA_VERSION));
        assert!(ready_status.recovery_reason.is_none());

        let corrupt_directory = TestDirectory::new("recovery-status");
        let corrupt_path = corrupt_directory.database_path();
        fs::write(&corrupt_path, b"not-a-sqlite-database").unwrap();
        let recovery_store = HostStore::open(&corrupt_path);
        let recovery_status = recovery_store.status().unwrap();
        assert_eq!(recovery_status.mode, HostStorageMode::Recovery);
        assert!(recovery_status.schema_version.is_none());
        assert!(recovery_status.recovery_reason.is_some());
        assert_eq!(fs::read(corrupt_path).unwrap(), b"not-a-sqlite-database");
    }
}
