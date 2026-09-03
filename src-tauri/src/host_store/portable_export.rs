use super::{
    APPLICATION_ID, BACKUP_SEQUENCE, CURRENT_SCHEMA_VERSION, HostDatabase, HostStore, now_millis,
    require_integrity,
};
use rusqlite::{Connection, OpenFlags, TransactionBehavior, backup::Backup, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fmt::Write as _,
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::atomic::Ordering,
    time::Duration,
};
use tauri::State;

const PORTABLE_EXPORT_FORMAT_VERSION: i64 = 1;
const PORTABLE_EXPORT_SUFFIX: &str = ".farfold.sqlite3";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortableExportContents {
    runtime_product_count: u64,
    project_count: u64,
    working_copy_count: u64,
    session_count: u64,
    archived_session_count: u64,
    draft_count: u64,
    draft_byte_count: u64,
    attention_record_count: u64,
    native_locator_count: u64,
    legacy_ledger_record_count: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortableExportPolicy {
    includes_session_titles: bool,
    includes_project_paths: bool,
    includes_native_locator_paths: bool,
    includes_legacy_source_paths: bool,
    includes_draft_bodies: bool,
    includes_provider_credentials: bool,
    includes_native_runtime_history: bool,
    includes_runtime_diagnostics: bool,
    includes_life_model: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortableExportPreview {
    format_version: i64,
    host_schema_version: i64,
    contents: PortableExportContents,
    policy: PortableExportPolicy,
    destination_suffix: &'static str,
    previewed_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePortableExportInput {
    destination_path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortableExportResult {
    path: String,
    byte_count: u64,
    sha256: String,
    exported_at: i64,
    preview: PortableExportPreview,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortableImportPreview {
    path: String,
    byte_count: u64,
    sha256: String,
    format_version: i64,
    host_schema_version: i64,
    exported_at: i64,
    contents: PortableExportContents,
    policy: PortableExportPolicy,
    compatible: bool,
    restore_enabled: bool,
}

fn export_policy() -> PortableExportPolicy {
    PortableExportPolicy {
        includes_session_titles: true,
        includes_project_paths: true,
        includes_native_locator_paths: true,
        includes_legacy_source_paths: true,
        includes_draft_bodies: true,
        includes_provider_credentials: false,
        includes_native_runtime_history: false,
        includes_runtime_diagnostics: false,
        includes_life_model: false,
    }
}

fn checked_count(value: i64, label: &str) -> Result<u64, String> {
    u64::try_from(value).map_err(|_| format!("Stored {label} is invalid"))
}

fn sql_count(value: u64, label: &str) -> Result<i64, String> {
    i64::try_from(value).map_err(|_| format!("{label} exceeds the portable export limit"))
}

fn read_contents(connection: &Connection) -> Result<PortableExportContents, String> {
    let counts = connection
        .query_row(
            "SELECT
                (SELECT COUNT(*) FROM runtime_products),
                (SELECT COUNT(*) FROM projects),
                (SELECT COUNT(*) FROM working_copies),
                (SELECT COUNT(*) FROM sessions),
                (SELECT COUNT(*) FROM sessions WHERE archived_at IS NOT NULL),
                (SELECT COUNT(*) FROM session_drafts),
                COALESCE((SELECT SUM(length(CAST(body AS BLOB))) FROM session_drafts), 0),
                (SELECT COUNT(*) FROM session_attention),
                (SELECT COUNT(*) FROM session_native_locators),
                (SELECT COUNT(*) FROM legacy_migration_sources)",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i64>(9)?,
                ))
            },
        )
        .map_err(|error| format!("Cannot inspect portable export contents: {error}"))?;
    Ok(PortableExportContents {
        runtime_product_count: checked_count(counts.0, "Runtime product count")?,
        project_count: checked_count(counts.1, "Project count")?,
        working_copy_count: checked_count(counts.2, "Working Copy count")?,
        session_count: checked_count(counts.3, "Session count")?,
        archived_session_count: checked_count(counts.4, "archived Session count")?,
        draft_count: checked_count(counts.5, "draft count")?,
        draft_byte_count: checked_count(counts.6, "draft byte count")?,
        attention_record_count: checked_count(counts.7, "attention record count")?,
        native_locator_count: checked_count(counts.8, "native locator count")?,
        legacy_ledger_record_count: checked_count(counts.9, "legacy ledger record count")?,
    })
}

fn require_foreign_key_integrity(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare("PRAGMA foreign_key_check")
        .map_err(|error| format!("Cannot prepare portable export foreign-key check: {error}"))?;
    let mut rows = statement
        .query([])
        .map_err(|error| format!("Cannot run portable export foreign-key check: {error}"))?;
    if rows
        .next()
        .map_err(|error| format!("Cannot read portable export foreign-key check: {error}"))?
        .is_some()
    {
        return Err("Portable export contains a foreign-key violation".to_string());
    }
    Ok(())
}

fn preview_database(database: &mut HostDatabase) -> Result<PortableExportPreview, String> {
    let transaction = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(|error| format!("Cannot begin portable export preview: {error}"))?;
    let contents = read_contents(&transaction)?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot finish portable export preview: {error}"))?;
    Ok(PortableExportPreview {
        format_version: PORTABLE_EXPORT_FORMAT_VERSION,
        host_schema_version: CURRENT_SCHEMA_VERSION,
        contents,
        policy: export_policy(),
        destination_suffix: PORTABLE_EXPORT_SUFFIX,
        previewed_at: now_millis(),
    })
}

fn canonical_new_destination(input: &str) -> Result<PathBuf, String> {
    let requested = Path::new(input);
    if !requested.is_absolute() {
        return Err("Portable export destination must be an absolute path".to_string());
    }
    let file_name = requested
        .file_name()
        .ok_or_else(|| "Portable export destination has no file name".to_string())?;
    if !file_name
        .to_string_lossy()
        .ends_with(PORTABLE_EXPORT_SUFFIX)
    {
        return Err(format!(
            "Portable export destination must end with {PORTABLE_EXPORT_SUFFIX}"
        ));
    }
    let parent = requested
        .parent()
        .ok_or_else(|| "Portable export destination has no parent directory".to_string())?
        .canonicalize()
        .map_err(|error| format!("Cannot resolve portable export directory: {error}"))?;
    if !parent.is_dir() {
        return Err("Portable export destination parent is not a directory".to_string());
    }
    let destination = parent.join(file_name);
    if fs::symlink_metadata(&destination).is_ok() {
        return Err("Portable export destination already exists".to_string());
    }
    Ok(destination)
}

fn temporary_export_path(destination: &Path) -> Result<PathBuf, String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "Portable export destination has no parent directory".to_string())?;
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("farfold-export");
    for _ in 0..16 {
        let suffix = BACKUP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let candidate = parent.join(format!(
            ".{file_name}.{}.{}.incomplete",
            std::process::id(),
            suffix
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&candidate)
        {
            Ok(file) => {
                drop(file);
                return Ok(candidate);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Cannot reserve portable export file: {error}")),
        }
    }
    Err("Cannot reserve a unique portable export file".to_string())
}

fn write_manifest(
    destination: &Connection,
    contents: &PortableExportContents,
    exported_at: i64,
) -> Result<(), String> {
    destination
        .execute_batch(
            "CREATE TABLE farfold_portable_export_manifest (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                format_version INTEGER NOT NULL,
                host_schema_version INTEGER NOT NULL,
                exported_at INTEGER NOT NULL CHECK (exported_at >= 0),
                runtime_product_count INTEGER NOT NULL,
                project_count INTEGER NOT NULL,
                working_copy_count INTEGER NOT NULL,
                session_count INTEGER NOT NULL,
                archived_session_count INTEGER NOT NULL,
                draft_count INTEGER NOT NULL,
                draft_byte_count INTEGER NOT NULL,
                attention_record_count INTEGER NOT NULL,
                native_locator_count INTEGER NOT NULL,
                legacy_ledger_record_count INTEGER NOT NULL,
                includes_session_titles INTEGER NOT NULL,
                includes_project_paths INTEGER NOT NULL,
                includes_native_locator_paths INTEGER NOT NULL,
                includes_legacy_source_paths INTEGER NOT NULL,
                includes_draft_bodies INTEGER NOT NULL,
                includes_provider_credentials INTEGER NOT NULL,
                includes_native_runtime_history INTEGER NOT NULL,
                includes_runtime_diagnostics INTEGER NOT NULL,
                includes_life_model INTEGER NOT NULL
             ) STRICT;",
        )
        .map_err(|error| format!("Cannot create portable export manifest: {error}"))?;
    let policy = export_policy();
    let runtime_product_count = sql_count(contents.runtime_product_count, "Runtime product count")?;
    let project_count = sql_count(contents.project_count, "Project count")?;
    let working_copy_count = sql_count(contents.working_copy_count, "Working Copy count")?;
    let session_count = sql_count(contents.session_count, "Session count")?;
    let archived_session_count =
        sql_count(contents.archived_session_count, "archived Session count")?;
    let draft_count = sql_count(contents.draft_count, "draft count")?;
    let draft_byte_count = sql_count(contents.draft_byte_count, "draft byte count")?;
    let attention_record_count =
        sql_count(contents.attention_record_count, "attention record count")?;
    let native_locator_count = sql_count(contents.native_locator_count, "native locator count")?;
    let legacy_ledger_record_count = sql_count(
        contents.legacy_ledger_record_count,
        "legacy ledger record count",
    )?;
    destination
        .execute(
            "INSERT INTO farfold_portable_export_manifest VALUES (
                1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22
             )",
            params![
                PORTABLE_EXPORT_FORMAT_VERSION,
                CURRENT_SCHEMA_VERSION,
                exported_at,
                runtime_product_count,
                project_count,
                working_copy_count,
                session_count,
                archived_session_count,
                draft_count,
                draft_byte_count,
                attention_record_count,
                native_locator_count,
                legacy_ledger_record_count,
                policy.includes_session_titles,
                policy.includes_project_paths,
                policy.includes_native_locator_paths,
                policy.includes_legacy_source_paths,
                policy.includes_draft_bodies,
                policy.includes_provider_credentials,
                policy.includes_native_runtime_history,
                policy.includes_runtime_diagnostics,
                policy.includes_life_model,
            ],
        )
        .map_err(|error| format!("Cannot write portable export manifest: {error}"))?;
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("Cannot open portable export for hashing: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Cannot hash portable export: {error}"))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let mut encoded = String::with_capacity(64);
    for byte in digest.finalize() {
        write!(&mut encoded, "{byte:02x}")
            .map_err(|error| format!("Cannot encode portable export hash: {error}"))?;
    }
    Ok(encoded)
}

fn create_export(
    database: &mut HostDatabase,
    input: CreatePortableExportInput,
) -> Result<PortableExportResult, String> {
    let destination = canonical_new_destination(&input.destination_path)?;
    if destination == database.path {
        return Err("Portable export cannot replace the active Host database".to_string());
    }
    let temporary = temporary_export_path(&destination)?;
    let result = (|| {
        let mut output = Connection::open_with_flags(
            &temporary,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
        )
        .map_err(|error| format!("Cannot open portable export file: {error}"))?;
        {
            let backup = Backup::new(&database.connection, &mut output)
                .map_err(|error| format!("Cannot start portable Host export: {error}"))?;
            backup
                .run_to_completion(128, Duration::from_millis(10), None)
                .map_err(|error| format!("Cannot complete portable Host export: {error}"))?;
        }
        let contents = read_contents(&output)?;
        let exported_at = now_millis();
        write_manifest(&output, &contents, exported_at)?;
        require_integrity(&output)?;
        require_foreign_key_integrity(&output)?;
        drop(output);
        fs::File::open(&temporary)
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("Cannot sync portable export: {error}"))?;
        let byte_count = temporary
            .metadata()
            .map_err(|error| format!("Cannot inspect portable export: {error}"))?
            .len();
        let sha256 = sha256_file(&temporary)?;
        fs::hard_link(&temporary, &destination).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "Portable export destination already exists".to_string()
            } else {
                format!("Cannot activate portable export: {error}")
            }
        })?;
        if let Err(error) = fs::remove_file(&temporary) {
            let _ = fs::remove_file(&destination);
            return Err(format!(
                "Cannot remove portable export staging file: {error}"
            ));
        }
        if let Some(parent) = destination.parent()
            && let Ok(directory) = fs::File::open(parent)
            && let Err(error) = directory.sync_all()
        {
            let _ = fs::remove_file(&destination);
            return Err(format!("Cannot sync portable export directory: {error}"));
        }
        Ok(PortableExportResult {
            path: destination.to_string_lossy().into_owned(),
            byte_count,
            sha256,
            exported_at,
            preview: PortableExportPreview {
                format_version: PORTABLE_EXPORT_FORMAT_VERSION,
                host_schema_version: CURRENT_SCHEMA_VERSION,
                contents,
                policy: export_policy(),
                destination_suffix: PORTABLE_EXPORT_SUFFIX,
                previewed_at: exported_at,
            },
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn canonical_import_file(input: &str) -> Result<PathBuf, String> {
    let requested = Path::new(input);
    if !requested.is_absolute() {
        return Err("Portable import source must be an absolute path".to_string());
    }
    let metadata = fs::symlink_metadata(requested)
        .map_err(|error| format!("Cannot inspect portable import source: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Portable import source must be a regular non-symlink file".to_string());
    }
    requested
        .canonicalize()
        .map_err(|error| format!("Cannot resolve portable import source: {error}"))
}

fn read_manifest(
    connection: &Connection,
) -> Result<(i64, i64, i64, PortableExportContents, PortableExportPolicy), String> {
    let raw = connection
        .query_row(
            "SELECT format_version, host_schema_version, exported_at,
                    runtime_product_count, project_count, working_copy_count, session_count,
                    archived_session_count, draft_count, draft_byte_count,
                    attention_record_count, native_locator_count, legacy_ledger_record_count,
                    includes_session_titles, includes_project_paths,
                    includes_native_locator_paths, includes_legacy_source_paths,
                    includes_draft_bodies,
                    includes_provider_credentials, includes_native_runtime_history,
                    includes_runtime_diagnostics, includes_life_model
             FROM farfold_portable_export_manifest WHERE singleton = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    [
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, i64>(8)?,
                        row.get::<_, i64>(9)?,
                        row.get::<_, i64>(10)?,
                        row.get::<_, i64>(11)?,
                        row.get::<_, i64>(12)?,
                    ],
                    [
                        row.get::<_, bool>(13)?,
                        row.get::<_, bool>(14)?,
                        row.get::<_, bool>(15)?,
                        row.get::<_, bool>(16)?,
                        row.get::<_, bool>(17)?,
                        row.get::<_, bool>(18)?,
                        row.get::<_, bool>(19)?,
                        row.get::<_, bool>(20)?,
                        row.get::<_, bool>(21)?,
                    ],
                ))
            },
        )
        .map_err(|error| format!("Portable import manifest is missing or invalid: {error}"))?;
    Ok((
        raw.0,
        raw.1,
        raw.2,
        PortableExportContents {
            runtime_product_count: checked_count(raw.3[0], "Runtime product count")?,
            project_count: checked_count(raw.3[1], "Project count")?,
            working_copy_count: checked_count(raw.3[2], "Working Copy count")?,
            session_count: checked_count(raw.3[3], "Session count")?,
            archived_session_count: checked_count(raw.3[4], "archived Session count")?,
            draft_count: checked_count(raw.3[5], "draft count")?,
            draft_byte_count: checked_count(raw.3[6], "draft byte count")?,
            attention_record_count: checked_count(raw.3[7], "attention record count")?,
            native_locator_count: checked_count(raw.3[8], "native locator count")?,
            legacy_ledger_record_count: checked_count(raw.3[9], "legacy ledger record count")?,
        },
        PortableExportPolicy {
            includes_session_titles: raw.4[0],
            includes_project_paths: raw.4[1],
            includes_native_locator_paths: raw.4[2],
            includes_legacy_source_paths: raw.4[3],
            includes_draft_bodies: raw.4[4],
            includes_provider_credentials: raw.4[5],
            includes_native_runtime_history: raw.4[6],
            includes_runtime_diagnostics: raw.4[7],
            includes_life_model: raw.4[8],
        },
    ))
}

fn preview_import(path: &str) -> Result<PortableImportPreview, String> {
    let path = canonical_import_file(path)?;
    let connection = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Cannot open portable import source: {error}"))?;
    require_integrity(&connection)?;
    require_foreign_key_integrity(&connection)?;
    let application_id = connection
        .pragma_query_value(None, "application_id", |row| row.get::<_, i64>(0))
        .map_err(|error| format!("Cannot read portable import application ID: {error}"))?;
    if application_id != APPLICATION_ID {
        return Err("Portable import does not belong to Farfold Host storage".to_string());
    }
    let (format_version, host_schema_version, exported_at, recorded_contents, recorded_policy) =
        read_manifest(&connection)?;
    let observed_contents = read_contents(&connection)?;
    if recorded_contents != observed_contents {
        return Err("Portable import contents do not match its manifest".to_string());
    }
    if recorded_policy != export_policy() {
        return Err("Portable import policy does not match its manifest contract".to_string());
    }
    let observed_schema_version = connection
        .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
        .map_err(|error| format!("Cannot read portable import schema version: {error}"))?;
    if host_schema_version != observed_schema_version {
        return Err("Portable import schema does not match its manifest".to_string());
    }
    let compatible = format_version == PORTABLE_EXPORT_FORMAT_VERSION
        && host_schema_version > 0
        && host_schema_version <= CURRENT_SCHEMA_VERSION;
    let byte_count = path
        .metadata()
        .map_err(|error| format!("Cannot inspect portable import source: {error}"))?
        .len();
    Ok(PortableImportPreview {
        path: path.to_string_lossy().into_owned(),
        byte_count,
        sha256: sha256_file(&path)?,
        format_version,
        host_schema_version,
        exported_at,
        contents: observed_contents,
        policy: recorded_policy,
        compatible,
        restore_enabled: false,
    })
}

impl HostStore {
    pub fn portable_export_preview(&self) -> Result<PortableExportPreview, String> {
        self.with_ready_database(preview_database)
    }

    pub fn create_portable_export(
        &self,
        input: CreatePortableExportInput,
    ) -> Result<PortableExportResult, String> {
        self.with_ready_database(|database| create_export(database, input))
    }
}

#[tauri::command]
pub fn host_portable_export_preview(
    store: State<'_, HostStore>,
) -> Result<PortableExportPreview, String> {
    store.portable_export_preview()
}

#[tauri::command]
pub fn host_portable_export_create(
    store: State<'_, HostStore>,
    input: CreatePortableExportInput,
) -> Result<PortableExportResult, String> {
    store.create_portable_export(input)
}

#[tauri::command]
pub fn host_portable_import_preview(path: String) -> Result<PortableImportPreview, String> {
    preview_import(&path)
}

#[cfg(test)]
mod tests {
    use super::{
        CreatePortableExportInput, PORTABLE_EXPORT_FORMAT_VERSION, create_export, preview_database,
        preview_import,
    };
    use crate::host_store::{HostDatabaseOpen, portable_export::PORTABLE_EXPORT_SUFFIX};
    use rusqlite::Connection;
    use std::{
        fs,
        os::unix::fs::{PermissionsExt, symlink},
    };

    #[test]
    fn portable_export_is_atomic_self_describing_and_no_clobber() {
        let root =
            std::env::temp_dir().join(format!("farfold-portable-export-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let mut database = match HostDatabaseOpen::open(root.join("host.sqlite3")) {
            HostDatabaseOpen::Ready(database) => database,
            HostDatabaseOpen::Recovery(recovery) => panic!("{}", recovery.reason()),
        };
        let before = preview_database(&mut database).unwrap();
        let destination = root.join(format!("backup{PORTABLE_EXPORT_SUFFIX}"));
        let result = create_export(
            &mut database,
            CreatePortableExportInput {
                destination_path: destination.to_string_lossy().into_owned(),
            },
        )
        .unwrap();
        assert_eq!(result.preview.contents, before.contents);
        assert_eq!(result.preview.policy, before.policy);
        assert!(result.exported_at >= before.previewed_at);
        assert_eq!(result.preview.previewed_at, result.exported_at);
        assert_eq!(result.sha256.len(), 64);
        assert!(result.byte_count > 0);
        assert_eq!(
            fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let imported = preview_import(destination.to_str().unwrap()).unwrap();
        assert_eq!(imported.sha256, result.sha256);
        assert_eq!(imported.exported_at, result.exported_at);
        assert!(imported.compatible);
        assert!(!imported.restore_enabled);
        assert!(imported.policy.includes_project_paths);
        assert!(imported.policy.includes_native_locator_paths);
        assert!(!imported.policy.includes_provider_credentials);
        assert!(!imported.policy.includes_native_runtime_history);
        assert!(
            create_export(
                &mut database,
                CreatePortableExportInput {
                    destination_path: destination.to_string_lossy().into_owned(),
                }
            )
            .unwrap_err()
            .contains("already exists")
        );
        assert!(fs::read_dir(&root).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".incomplete")
        }));
        drop(database);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn import_preview_rejects_live_database_symlink_and_manifest_tampering() {
        let root =
            std::env::temp_dir().join(format!("farfold-portable-import-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let mut database = match HostDatabaseOpen::open(root.join("host.sqlite3")) {
            HostDatabaseOpen::Ready(database) => database,
            HostDatabaseOpen::Recovery(recovery) => panic!("{}", recovery.reason()),
        };
        assert!(preview_import(database.path().to_str().unwrap()).is_err());
        let destination = root.join(format!("backup{PORTABLE_EXPORT_SUFFIX}"));
        create_export(
            &mut database,
            CreatePortableExportInput {
                destination_path: destination.to_string_lossy().into_owned(),
            },
        )
        .unwrap();
        let link = root.join("linked.farfold.sqlite3");
        symlink(&destination, &link).unwrap();
        assert!(
            preview_import(link.to_str().unwrap())
                .unwrap_err()
                .contains("non-symlink")
        );
        let tampered = Connection::open(&destination).unwrap();
        tampered
            .execute(
                "UPDATE farfold_portable_export_manifest SET session_count = 1",
                [],
            )
            .unwrap();
        drop(tampered);
        assert!(
            preview_import(destination.to_str().unwrap())
                .unwrap_err()
                .contains("do not match")
        );
        let tampered = Connection::open(&destination).unwrap();
        tampered
            .execute(
                "UPDATE farfold_portable_export_manifest
                 SET session_count = 0, includes_provider_credentials = 1",
                [],
            )
            .unwrap();
        drop(tampered);
        assert!(
            preview_import(destination.to_str().unwrap())
                .unwrap_err()
                .contains("policy")
        );
        let tampered = Connection::open(&destination).unwrap();
        tampered.pragma_update(None, "foreign_keys", false).unwrap();
        tampered
            .execute_batch(
                "UPDATE farfold_portable_export_manifest
                 SET includes_provider_credentials = 0, draft_count = 1, draft_byte_count = 6;
                 INSERT INTO session_drafts VALUES ('missing-session', 'orphan', 1);",
            )
            .unwrap();
        drop(tampered);
        assert!(
            preview_import(destination.to_str().unwrap())
                .unwrap_err()
                .contains("foreign-key violation")
        );
        assert_eq!(PORTABLE_EXPORT_FORMAT_VERSION, 1);
        drop(database);
        let _ = fs::remove_dir_all(root);
    }
}
