use rusqlite::{Connection, OpenFlags, TransactionBehavior, backup::Backup, params};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, State};

pub mod legacy;
pub mod records;
pub mod session_binding_index;
pub mod working_copy_manager;

const APPLICATION_ID: i64 = 1_178_686_022;
pub const CURRENT_SCHEMA_VERSION: i64 = 2;
const SCHEMA_V1: &str = include_str!("host_store/migrations/0001_host_foundation.sql");
const SCHEMA_V2: &str = include_str!("host_store/migrations/0002_legacy_migration_ledger.sql");
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

pub struct HostStore {
    state: Mutex<HostDatabaseOpen>,
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
            state: Mutex::new(HostDatabaseOpen::open(path)),
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

    pub(crate) fn with_ready_database<T>(
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

#[tauri::command]
pub fn host_legacy_migration_preview(
    app: tauri::AppHandle,
) -> Result<legacy::LegacyMigrationPreview, String> {
    let profile_path = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve Farfold data directory: {error}"))?;
    Ok(legacy::preview_profile(&profile_path))
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

    let result = (|| -> Result<(), String> {
        let mut destination = Connection::open(&temporary_path)
            .map_err(|error| format!("Cannot create Host database backup: {error}"))?;
        {
            let backup = Backup::new(source, &mut destination)
                .map_err(|error| format!("Cannot start Host database backup: {error}"))?;
            backup
                .run_to_completion(128, Duration::from_millis(10), None)
                .map_err(|error| format!("Cannot complete Host database backup: {error}"))?;
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
    fn schema_one_migrates_once_and_records_the_legacy_ledger() {
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
            2
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
