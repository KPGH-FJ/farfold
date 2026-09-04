use super::{
    APPLICATION_ID, BACKUP_SEQUENCE, CURRENT_SCHEMA_VERSION, HostDatabase, HostDatabaseOpen,
    HostStore, now_millis,
    portable_export::{
        PortableImportPreview, StagePortableImportInput, StagedPortableImport, preview_import,
        stage_import_for_database_path,
    },
    require_integrity,
};
use crate::{
    opencode_runtime::{self, OpenCodeRuntime},
    pi_runtime::{self, PiRuntime},
};
use rusqlite::{Connection, OpenFlags, backup::Backup};
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::atomic::Ordering,
    time::Duration,
};
use tauri::State;

const ACTIVATION_INTENT_VERSION: i64 = 1;
const PENDING_INTENT_FILE: &str = "farfold-host.pending-import.json";
const APPLYING_INTENT_FILE: &str = ".farfold-host.applying-import.json";
const MAX_INTENT_BYTES: u64 = 4 * 1024;
const EXPORT_MANIFEST_TABLE: &str = "farfold_portable_export_manifest";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PortableImportActivationPhase {
    Idle,
    Activated,
    Rejected,
    RolledBack,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortableImportActivationStatus {
    phase: PortableImportActivationPhase,
    sha256: Option<String>,
    rollback_path: Option<String>,
    recovery_source_archive_path: Option<String>,
    reason: Option<String>,
}

impl PortableImportActivationStatus {
    fn idle() -> Self {
        Self {
            phase: PortableImportActivationPhase::Idle,
            sha256: None,
            rollback_path: None,
            recovery_source_archive_path: None,
            reason: None,
        }
    }

    fn rejected(sha256: Option<String>, reason: String) -> Self {
        Self {
            phase: PortableImportActivationPhase::Rejected,
            sha256,
            rollback_path: None,
            recovery_source_archive_path: None,
            reason: Some(reason),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestPortableImportActivationInput {
    expected_sha256: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RequestedPortableImportActivation {
    sha256: String,
    staged_path: String,
    already_requested: bool,
    restart_required: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestRecoveryRestoreInput {
    source_path: String,
    expected_sha256: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RequestedRecoveryRestore {
    preview: PortableImportPreview,
    staged: StagedPortableImport,
    activation: RequestedPortableImportActivation,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ActivationIntent {
    version: i64,
    expected_sha256: String,
    operation_id: String,
    requested_at: i64,
    #[serde(default)]
    recovery_source: bool,
}

#[derive(Debug)]
struct MoveDatabaseFamilyError {
    reason: String,
    original_restored: bool,
}

#[derive(Debug)]
struct ActivationFailure {
    reason: String,
    rollback_path: Option<PathBuf>,
    rolled_back: bool,
    safe_to_continue: bool,
}

impl ActivationFailure {
    fn rejected(reason: String) -> Self {
        Self {
            reason,
            rollback_path: None,
            rolled_back: false,
            safe_to_continue: true,
        }
    }
}

fn validate_sha256(value: &str) -> Result<(), String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Expected portable import SHA-256 is invalid".to_string());
    }
    if value.bytes().any(|byte| byte.is_ascii_uppercase()) {
        return Err("Expected portable import SHA-256 must use lowercase hexadecimal".to_string());
    }
    Ok(())
}

fn validate_operation_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 96
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'-')
    {
        return Err("Portable import activation operation ID is invalid".to_string());
    }
    Ok(())
}

fn profile_path(database_path: &Path) -> Result<PathBuf, String> {
    database_path
        .parent()
        .ok_or_else(|| "Host database path has no parent directory".to_string())?
        .canonicalize()
        .map_err(|error| format!("Cannot resolve Host database directory: {error}"))
}

fn pending_import_path(profile: &Path, sha256: &str) -> PathBuf {
    profile.join(format!("farfold-host.pending-import-{sha256}.sqlite3"))
}

fn intent_path(profile: &Path, applying: bool) -> PathBuf {
    profile.join(if applying {
        APPLYING_INTENT_FILE
    } else {
        PENDING_INTENT_FILE
    })
}

fn operation_path(profile: &Path, intent: &ActivationIntent, kind: &str) -> PathBuf {
    profile.join(format!(
        ".farfold-host.import-{}-{kind}.sqlite3",
        intent.operation_id
    ))
}

fn rollback_path(profile: &Path, intent: &ActivationIntent) -> PathBuf {
    profile.join(format!(
        "farfold-host.rollback-before-import-{}.sqlite3",
        intent.operation_id
    ))
}

fn recovery_source_archive_path(profile: &Path, intent: &ActivationIntent) -> PathBuf {
    profile.join(format!(
        "farfold-host.recovery-source-before-import-{}.sqlite3",
        intent.operation_id
    ))
}

fn sidecar_path(database_path: &Path, suffix: &str) -> PathBuf {
    let mut value = OsString::from(database_path.as_os_str());
    value.push(suffix);
    PathBuf::from(value)
}

fn require_regular_file(path: &Path, label: &str) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("Cannot inspect {label}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{label} must be a regular non-symlink file"));
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), String> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Cannot sync Host database directory: {error}"))
}

fn read_intent(path: &Path) -> Result<ActivationIntent, String> {
    require_regular_file(path, "portable import activation intent")?;
    let metadata = path
        .metadata()
        .map_err(|error| format!("Cannot inspect portable import activation intent: {error}"))?;
    if metadata.len() == 0 || metadata.len() > MAX_INTENT_BYTES {
        return Err("Portable import activation intent size is invalid".to_string());
    }
    let file = fs::File::open(path)
        .map_err(|error| format!("Cannot open portable import activation intent: {error}"))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_INTENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Cannot read portable import activation intent: {error}"))?;
    let intent: ActivationIntent = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Portable import activation intent is invalid: {error}"))?;
    if intent.version != ACTIVATION_INTENT_VERSION {
        return Err(format!(
            "Portable import activation intent version {} is unsupported",
            intent.version
        ));
    }
    validate_sha256(&intent.expected_sha256)?;
    validate_operation_id(&intent.operation_id)?;
    if intent.requested_at < 0 {
        return Err("Portable import activation request time is invalid".to_string());
    }
    Ok(intent)
}

fn reserve_file(path: &Path, label: &str) -> Result<fs::File, String> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| format!("Cannot reserve {label}: {error}"))
}

fn write_intent(profile: &Path, intent: &ActivationIntent) -> Result<(), String> {
    let destination = intent_path(profile, false);
    let temporary = profile.join(format!(
        ".farfold-host.pending-import.{}.{}.incomplete",
        std::process::id(),
        BACKUP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = reserve_file(&temporary, "portable import activation intent")?;
        let bytes = serde_json::to_vec(intent)
            .map_err(|error| format!("Cannot encode portable import activation intent: {error}"))?;
        file.write_all(&bytes)
            .map_err(|error| format!("Cannot write portable import activation intent: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Cannot sync portable import activation intent: {error}"))?;
        drop(file);
        fs::hard_link(&temporary, &destination).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "A portable import activation is already pending".to_string()
            } else {
                format!("Cannot publish portable import activation intent: {error}")
            }
        })?;
        fs::remove_file(&temporary).map_err(|error| {
            let _ = fs::remove_file(&destination);
            format!("Cannot finish portable import activation intent: {error}")
        })?;
        sync_directory(profile)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn request_activation(
    database: &mut HostDatabase,
    expected_sha256: String,
) -> Result<RequestedPortableImportActivation, String> {
    let profile = profile_path(database.path())?;
    request_activation_in_profile(&profile, expected_sha256, false)
}

fn request_activation_in_profile(
    profile: &Path,
    expected_sha256: String,
    recovery_source: bool,
) -> Result<RequestedPortableImportActivation, String> {
    validate_sha256(&expected_sha256)?;
    let staged_path = pending_import_path(profile, &expected_sha256);
    let staged = preview_import(staged_path.to_string_lossy().as_ref())?;
    if !staged.compatible || staged.sha256 != expected_sha256 {
        return Err("Staged portable import is not compatible with this Farfold build".to_string());
    }
    for applying in [false, true] {
        let existing_path = intent_path(profile, applying);
        if existing_path.exists() {
            let existing = read_intent(&existing_path)?;
            if existing.expected_sha256 != expected_sha256 {
                return Err("A different portable import activation is already pending".to_string());
            }
            if existing.recovery_source != recovery_source {
                return Err(
                    "Portable import activation mode does not match the pending request"
                        .to_string(),
                );
            }
            return Ok(RequestedPortableImportActivation {
                sha256: expected_sha256,
                staged_path: staged.path,
                already_requested: true,
                restart_required: true,
            });
        }
    }
    let intent = ActivationIntent {
        version: ACTIVATION_INTENT_VERSION,
        expected_sha256: expected_sha256.clone(),
        operation_id: format!(
            "{}-{}-{}",
            now_millis(),
            std::process::id(),
            BACKUP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ),
        requested_at: now_millis(),
        recovery_source,
    };
    write_intent(profile, &intent)?;
    Ok(RequestedPortableImportActivation {
        sha256: expected_sha256,
        staged_path: staged.path,
        already_requested: false,
        restart_required: true,
    })
}

fn require_foreign_key_integrity(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare("PRAGMA foreign_key_check")
        .map_err(|error| format!("Cannot prepare Host foreign-key check: {error}"))?;
    let mut rows = statement
        .query([])
        .map_err(|error| format!("Cannot run Host foreign-key check: {error}"))?;
    if rows
        .next()
        .map_err(|error| format!("Cannot read Host foreign-key check: {error}"))?
        .is_some()
    {
        return Err("Host database contains a foreign-key violation".to_string());
    }
    Ok(())
}

fn backup_into(source_path: &Path, destination_path: &Path) -> Result<(), String> {
    require_regular_file(source_path, "Host database backup source")?;
    let source = Connection::open_with_flags(source_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Cannot open Host database backup source: {error}"))?;
    let destination_file = reserve_file(destination_path, "Host database backup")?;
    drop(destination_file);
    let result = (|| {
        let mut destination =
            Connection::open_with_flags(destination_path, OpenFlags::SQLITE_OPEN_READ_WRITE)
                .map_err(|error| {
                    format!("Cannot open Host database backup destination: {error}")
                })?;
        {
            let backup = Backup::new(&source, &mut destination)
                .map_err(|error| format!("Cannot start Host database backup: {error}"))?;
            backup
                .run_to_completion(128, Duration::from_millis(10), None)
                .map_err(|error| format!("Cannot complete Host database backup: {error}"))?;
        }
        require_integrity(&destination)?;
        require_foreign_key_integrity(&destination)?;
        drop(destination);
        fs::File::open(destination_path)
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("Cannot sync Host database backup: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(destination_path);
    }
    result
}

fn prepare_candidate(staged_path: &Path, candidate_path: &Path) -> Result<(), String> {
    if candidate_path.exists() {
        fs::remove_file(candidate_path)
            .map_err(|error| format!("Cannot clear interrupted import candidate: {error}"))?;
    }
    backup_into(staged_path, candidate_path)?;
    let result = (|| {
        let connection =
            Connection::open_with_flags(candidate_path, OpenFlags::SQLITE_OPEN_READ_WRITE)
                .map_err(|error| format!("Cannot open portable import candidate: {error}"))?;
        connection
            .execute(&format!("DROP TABLE {EXPORT_MANIFEST_TABLE}"), [])
            .map_err(|error| format!("Cannot remove portable export manifest: {error}"))?;
        require_integrity(&connection)?;
        require_foreign_key_integrity(&connection)?;
        let application_id = connection
            .pragma_query_value(None, "application_id", |row| row.get::<_, i64>(0))
            .map_err(|error| format!("Cannot read import candidate application ID: {error}"))?;
        let schema_version = connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .map_err(|error| format!("Cannot read import candidate schema version: {error}"))?;
        if application_id != APPLICATION_ID
            || schema_version <= 0
            || schema_version > CURRENT_SCHEMA_VERSION
        {
            return Err("Portable import candidate identity is incompatible".to_string());
        }
        drop(connection);
        fs::File::open(candidate_path)
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("Cannot sync portable import candidate: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(candidate_path);
    }
    result
}

fn restore_moved_files(moved: &[(PathBuf, PathBuf)]) -> bool {
    let mut restored = true;
    for (original, relocated) in moved.iter().rev() {
        if fs::rename(relocated, original).is_err() {
            restored = false;
        }
    }
    restored
}

fn move_database_family(
    source: &Path,
    destination: &Path,
) -> Result<Vec<(PathBuf, PathBuf)>, MoveDatabaseFamilyError> {
    let mut moved = Vec::new();
    for suffix in ["", "-wal", "-shm"] {
        let from = if suffix.is_empty() {
            source.to_path_buf()
        } else {
            sidecar_path(source, suffix)
        };
        let to = if suffix.is_empty() {
            destination.to_path_buf()
        } else {
            sidecar_path(destination, suffix)
        };
        match fs::symlink_metadata(&from) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    let original_restored = restore_moved_files(&moved);
                    return Err(MoveDatabaseFamilyError {
                        reason: "Host database family contains a non-regular file".to_string(),
                        original_restored,
                    });
                }
                if let Err(error) = fs::rename(&from, &to) {
                    let original_restored = restore_moved_files(&moved);
                    return Err(MoveDatabaseFamilyError {
                        reason: format!("Cannot move Host database family: {error}"),
                        original_restored,
                    });
                }
                moved.push((from, to));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                let original_restored = restore_moved_files(&moved);
                return Err(MoveDatabaseFamilyError {
                    reason: format!("Cannot inspect Host database family: {error}"),
                    original_restored,
                });
            }
        }
    }
    Ok(moved)
}

fn remove_database_family(path: &Path) {
    let _ = fs::remove_file(path);
    let _ = fs::remove_file(sidecar_path(path, "-wal"));
    let _ = fs::remove_file(sidecar_path(path, "-shm"));
}

fn restore_interrupted_swap(
    database_path: &Path,
    displaced_path: &Path,
    failed_path: &Path,
) -> Result<(), String> {
    if !displaced_path.exists() {
        return Ok(());
    }
    if database_path.exists() {
        remove_database_family(failed_path);
        move_database_family(database_path, failed_path).map_err(|error| {
            if error.original_restored {
                error.reason
            } else {
                format!(
                    "{}; original database family was not restored",
                    error.reason
                )
            }
        })?;
    }
    move_database_family(displaced_path, database_path).map_err(|error| {
        if error.original_restored {
            error.reason
        } else {
            format!(
                "{}; displaced database family was not restored",
                error.reason
            )
        }
    })?;
    sync_directory(
        database_path
            .parent()
            .ok_or_else(|| "Host database path has no parent directory".to_string())?,
    )
}

fn validate_live_database(path: &Path) -> Result<(), String> {
    match HostDatabaseOpen::open(path) {
        HostDatabaseOpen::Ready(database) => {
            drop(database);
            Ok(())
        }
        HostDatabaseOpen::Recovery(recovery) => Err(recovery.reason().to_string()),
    }
}

fn activate_with_validator(
    database_path: &Path,
    intent: &ActivationIntent,
    validator: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<PathBuf, ActivationFailure> {
    let profile = database_path.parent().ok_or_else(|| {
        ActivationFailure::rejected("Host database path has no parent directory".to_string())
    })?;
    let staged_path = pending_import_path(profile, &intent.expected_sha256);
    let candidate_path = operation_path(profile, intent, "candidate");
    let displaced_path = if intent.recovery_source {
        recovery_source_archive_path(profile, intent)
    } else {
        operation_path(profile, intent, "displaced")
    };
    let failed_path = operation_path(profile, intent, "failed");
    let rollback_path = if intent.recovery_source {
        displaced_path.clone()
    } else {
        rollback_path(profile, intent)
    };

    if let Err(error) = restore_interrupted_swap(database_path, &displaced_path, &failed_path) {
        return Err(ActivationFailure {
            reason: error,
            rollback_path: None,
            rolled_back: false,
            safe_to_continue: false,
        });
    }
    let preview = match preview_import(staged_path.to_string_lossy().as_ref()) {
        Ok(preview) => preview,
        Err(error) => return Err(ActivationFailure::rejected(error)),
    };
    if !preview.compatible || preview.sha256 != intent.expected_sha256 {
        return Err(ActivationFailure::rejected(
            "Pending portable import no longer matches its activation intent".to_string(),
        ));
    }
    if let Err(error) = require_regular_file(database_path, "active Host database") {
        return Err(ActivationFailure::rejected(error));
    }
    if let Err(error) = prepare_candidate(&staged_path, &candidate_path) {
        return Err(ActivationFailure::rejected(error));
    }
    if intent.recovery_source {
        if ["", "-wal", "-shm"].iter().any(|suffix| {
            let path = if suffix.is_empty() {
                rollback_path.clone()
            } else {
                sidecar_path(&rollback_path, suffix)
            };
            fs::symlink_metadata(path).is_ok()
        }) {
            remove_database_family(&candidate_path);
            return Err(ActivationFailure::rejected(
                "Recovery source archive path is already occupied".to_string(),
            ));
        }
    } else if rollback_path.exists() {
        if let Err(error) = require_regular_file(&rollback_path, "portable import rollback") {
            remove_database_family(&candidate_path);
            return Err(ActivationFailure::rejected(error));
        }
        if let Err(error) = validate_live_database(&rollback_path) {
            remove_database_family(&candidate_path);
            return Err(ActivationFailure::rejected(format!(
                "Portable import rollback is invalid: {error}"
            )));
        }
    } else if let Err(error) = backup_into(database_path, &rollback_path) {
        remove_database_family(&candidate_path);
        return Err(ActivationFailure::rejected(error));
    }
    if let Err(error) = move_database_family(database_path, &displaced_path) {
        remove_database_family(&candidate_path);
        return Err(ActivationFailure {
            reason: error.reason,
            rollback_path: Some(rollback_path),
            rolled_back: false,
            safe_to_continue: error.original_restored,
        });
    }
    if let Err(error) = fs::rename(&candidate_path, database_path) {
        let restore = move_database_family(&displaced_path, database_path);
        remove_database_family(&candidate_path);
        return Err(match restore {
            Ok(_) => ActivationFailure {
                reason: format!(
                    "Cannot activate portable import candidate and restored the original database: {error}"
                ),
                rollback_path: Some(rollback_path),
                rolled_back: true,
                safe_to_continue: true,
            },
            Err(restore_error) => ActivationFailure {
                reason: format!(
                    "Cannot activate portable import candidate: {error}; rollback failed: {}",
                    restore_error.reason
                ),
                rollback_path: Some(rollback_path),
                rolled_back: false,
                safe_to_continue: false,
            },
        });
    }
    if let Err(error) = sync_directory(profile).and_then(|()| validator(database_path)) {
        remove_database_family(&failed_path);
        let quarantine_result = move_database_family(database_path, &failed_path);
        let restore_result = move_database_family(&displaced_path, database_path)
            .map_err(|error| error.reason)
            .and_then(|_| sync_directory(profile))
            .and_then(|_| {
                if intent.recovery_source {
                    require_regular_file(database_path, "restored recovery source")
                } else {
                    validate_live_database(database_path)
                }
            });
        return Err(match (quarantine_result, restore_result) {
            (Ok(_), Ok(())) => ActivationFailure {
                reason: format!("Portable import activation failed and was rolled back: {error}"),
                rollback_path: Some(rollback_path),
                rolled_back: true,
                safe_to_continue: true,
            },
            (quarantine, restore) => ActivationFailure {
                reason: format!(
                    "Portable import activation failed: {error}; quarantine: {quarantine:?}; rollback: {restore:?}"
                ),
                rollback_path: Some(rollback_path),
                rolled_back: false,
                safe_to_continue: false,
            },
        });
    }
    remove_database_family(&candidate_path);
    remove_database_family(&failed_path);
    Ok(rollback_path)
}

fn quarantine_intent(profile: &Path, source: &Path, operation_id: Option<&str>) {
    let suffix = operation_id.unwrap_or("unknown");
    let destination = profile.join(format!(
        "farfold-host.import-intent-rejected-{suffix}-{}.json",
        BACKUP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::rename(source, destination);
    let _ = sync_directory(profile);
}

pub fn process_pending_import_activation(
    database_path: &Path,
) -> Result<PortableImportActivationStatus, String> {
    let parent = match database_path.parent() {
        Some(parent) if parent.exists() => parent,
        _ => return Ok(PortableImportActivationStatus::idle()),
    };
    let profile = parent
        .canonicalize()
        .map_err(|error| format!("Cannot resolve Host database directory: {error}"))?;
    let pending_path = intent_path(&profile, false);
    let applying_path = intent_path(&profile, true);
    if pending_path.exists() && applying_path.exists() {
        return Err("Both pending and applying portable import intents exist".to_string());
    }
    let source_path = if applying_path.exists() {
        applying_path.clone()
    } else if pending_path.exists() {
        fs::rename(&pending_path, &applying_path)
            .map_err(|error| format!("Cannot begin portable import activation: {error}"))?;
        sync_directory(&profile)?;
        applying_path.clone()
    } else {
        return Ok(PortableImportActivationStatus::idle());
    };
    let intent = match read_intent(&source_path) {
        Ok(intent) => intent,
        Err(reason) => {
            quarantine_intent(&profile, &source_path, None);
            return Ok(PortableImportActivationStatus::rejected(None, reason));
        }
    };
    match activate_with_validator(database_path, &intent, validate_live_database) {
        Ok(rollback_path) => {
            fs::remove_file(&source_path).map_err(|error| {
                format!("Cannot consume portable import activation intent: {error}")
            })?;
            sync_directory(&profile)?;
            let displaced_path = operation_path(&profile, &intent, "displaced");
            if !intent.recovery_source {
                remove_database_family(&displaced_path);
            }
            remove_database_family(&pending_import_path(&profile, &intent.expected_sha256));
            let _ = sync_directory(&profile);
            Ok(PortableImportActivationStatus {
                phase: PortableImportActivationPhase::Activated,
                sha256: Some(intent.expected_sha256),
                rollback_path: (!intent.recovery_source)
                    .then(|| rollback_path.to_string_lossy().into_owned()),
                recovery_source_archive_path: intent
                    .recovery_source
                    .then(|| rollback_path.to_string_lossy().into_owned()),
                reason: None,
            })
        }
        Err(failure) => {
            if !failure.safe_to_continue {
                return Err(failure.reason);
            }
            quarantine_intent(&profile, &source_path, Some(&intent.operation_id));
            Ok(PortableImportActivationStatus {
                phase: if failure.rolled_back {
                    PortableImportActivationPhase::RolledBack
                } else {
                    PortableImportActivationPhase::Rejected
                },
                sha256: Some(intent.expected_sha256),
                rollback_path: (!intent.recovery_source)
                    .then(|| {
                        failure
                            .rollback_path
                            .as_ref()
                            .map(|path| path.to_string_lossy().into_owned())
                    })
                    .flatten(),
                recovery_source_archive_path: intent
                    .recovery_source
                    .then(|| {
                        failure.rollback_path.as_ref().and_then(|path| {
                            path.exists().then(|| path.to_string_lossy().into_owned())
                        })
                    })
                    .flatten(),
                reason: Some(failure.reason),
            })
        }
    }
}

#[tauri::command]
pub fn host_portable_import_activation_request(
    store: State<'_, HostStore>,
    pi: State<'_, PiRuntime>,
    opencode: State<'_, OpenCodeRuntime>,
    input: RequestPortableImportActivationInput,
) -> Result<RequestedPortableImportActivation, String> {
    pi_runtime::with_stopped(&pi, || {
        opencode_runtime::with_stopped(&opencode, || {
            store
                .with_ready_database(|database| request_activation(database, input.expected_sha256))
        })
    })
}

fn request_recovery_restore(
    store: &HostStore,
    input: RequestRecoveryRestoreInput,
) -> Result<RequestedRecoveryRestore, String> {
    let database_path = store.recovery_path()?;
    validate_sha256(&input.expected_sha256)?;
    let preview = preview_import(&input.source_path)?;
    if !preview.compatible {
        return Err(
            "Portable recovery source is not compatible with this Farfold build".to_string(),
        );
    }
    if preview.sha256 != input.expected_sha256 {
        return Err("Portable recovery source changed after preview".to_string());
    }
    let staged = stage_import_for_database_path(
        &database_path,
        StagePortableImportInput {
            source_path: input.source_path,
            expected_sha256: input.expected_sha256.clone(),
        },
    )?;
    let profile = profile_path(&database_path)?;
    let activation = request_activation_in_profile(&profile, input.expected_sha256, true)?;
    Ok(RequestedRecoveryRestore {
        preview,
        staged,
        activation,
    })
}

#[tauri::command]
pub fn host_recovery_restore_request(
    store: State<'_, HostStore>,
    pi: State<'_, PiRuntime>,
    opencode: State<'_, OpenCodeRuntime>,
    input: RequestRecoveryRestoreInput,
) -> Result<RequestedRecoveryRestore, String> {
    pi_runtime::with_stopped(&pi, || {
        opencode_runtime::with_stopped(&opencode, || request_recovery_restore(&store, input))
    })
}

#[tauri::command]
pub fn host_portable_import_activation_status(
    status: State<'_, PortableImportActivationStatus>,
) -> PortableImportActivationStatus {
    status.inner().clone()
}

#[cfg(test)]
mod tests {
    use super::{
        ActivationIntent, PortableImportActivationPhase, RequestRecoveryRestoreInput,
        activate_with_validator, intent_path, pending_import_path,
        process_pending_import_activation, request_activation, request_recovery_restore,
    };
    use crate::host_store::{
        HostDatabase, HostDatabaseOpen, HostStore,
        portable_export::{
            CreatePortableExportInput, StagePortableImportInput, create_export, preview_import,
            stage_import,
        },
    };
    use rusqlite::{Connection, params};
    use std::{
        fs::{self, OpenOptions},
        io::Write,
        path::Path,
    };

    fn ready(opened: HostDatabaseOpen) -> HostDatabase {
        match opened {
            HostDatabaseOpen::Ready(database) => database,
            HostDatabaseOpen::Recovery(recovery) => panic!("{}", recovery.reason()),
        }
    }

    fn marker(database: &HostDatabase) -> String {
        database
            .connection
            .query_row("SELECT value FROM activation_test_marker", [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    fn create_staged_import(
        root: &Path,
        live: &mut HostDatabase,
        imported_value: &str,
    ) -> (String, String) {
        let imported_path = root.join("import-source.sqlite3");
        let mut imported = ready(HostDatabaseOpen::open(&imported_path));
        imported
            .connection
            .execute_batch("CREATE TABLE activation_test_marker(value TEXT NOT NULL);")
            .unwrap();
        imported
            .connection
            .execute(
                "INSERT INTO activation_test_marker VALUES (?1)",
                params![imported_value],
            )
            .unwrap();
        let export_path = root.join("portable.farfold.sqlite3");
        let exported = create_export(
            &mut imported,
            CreatePortableExportInput {
                destination_path: export_path.to_string_lossy().into_owned(),
            },
        )
        .unwrap();
        let staged = stage_import(
            live,
            StagePortableImportInput {
                source_path: export_path.to_string_lossy().into_owned(),
                expected_sha256: exported.sha256.clone(),
            },
        )
        .unwrap();
        (exported.sha256, staged.staged_path)
    }

    #[test]
    fn requested_import_activates_only_on_cold_start_and_keeps_rollback() {
        let root = std::env::temp_dir().join(format!(
            "farfold-import-activation-success-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let live_path = root.join("farfold-host.sqlite3");
        let mut live = ready(HostDatabaseOpen::open(&live_path));
        live.connection
            .execute_batch("CREATE TABLE activation_test_marker(value TEXT NOT NULL);")
            .unwrap();
        live.connection
            .execute("INSERT INTO activation_test_marker VALUES ('old')", [])
            .unwrap();
        let (sha256, _) = create_staged_import(&root, &mut live, "imported");
        let requested = request_activation(&mut live, sha256.clone()).unwrap();
        assert!(requested.restart_required);
        assert!(!requested.already_requested);
        assert_eq!(marker(&live), "old");
        drop(live);

        let status = process_pending_import_activation(&live_path).unwrap();
        assert_eq!(status.phase, PortableImportActivationPhase::Activated);
        assert_eq!(status.sha256.as_deref(), Some(sha256.as_str()));
        assert!(!intent_path(&root, false).exists());
        assert!(!intent_path(&root, true).exists());
        let activated = ready(HostDatabaseOpen::open(&live_path));
        assert_eq!(marker(&activated), "imported");
        assert!(
            activated
                .connection
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name = 'farfold_portable_export_manifest'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap()
                == 0
        );
        let rollback = ready(HostDatabaseOpen::open(status.rollback_path.unwrap()));
        assert_eq!(marker(&rollback), "old");
        drop(activated);
        drop(rollback);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn activation_smoke_failure_restores_the_original_database() {
        let root = std::env::temp_dir().join(format!(
            "farfold-import-activation-rollback-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let live_path = root.join("farfold-host.sqlite3");
        let mut live = ready(HostDatabaseOpen::open(&live_path));
        live.connection
            .execute_batch("CREATE TABLE activation_test_marker(value TEXT NOT NULL);")
            .unwrap();
        live.connection
            .execute("INSERT INTO activation_test_marker VALUES ('old')", [])
            .unwrap();
        let (sha256, _) = create_staged_import(&root, &mut live, "imported");
        let _requested = request_activation(&mut live, sha256.clone()).unwrap();
        drop(live);
        let applying = intent_path(&root, true);
        fs::rename(intent_path(&root, false), &applying).unwrap();
        let intent: ActivationIntent = super::read_intent(&applying).unwrap();
        let failure = activate_with_validator(&live_path, &intent, |_| {
            Err("forced smoke failure".to_string())
        })
        .unwrap_err();
        assert!(failure.reason.contains("was rolled back"));
        let restored = ready(HostDatabaseOpen::open(&live_path));
        assert_eq!(marker(&restored), "old");
        assert!(Path::new(failure.rollback_path.unwrap().as_os_str()).is_file());
        drop(restored);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recovery_restore_preserves_the_unreadable_source_and_activates_only_on_restart() {
        let root =
            std::env::temp_dir().join(format!("farfold-recovery-restore-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        let source_path = root.join("source.sqlite3");
        let mut source = ready(HostDatabaseOpen::open(&source_path));
        source
            .connection
            .execute_batch("CREATE TABLE activation_test_marker(value TEXT NOT NULL);")
            .unwrap();
        source
            .connection
            .execute("INSERT INTO activation_test_marker VALUES ('restored')", [])
            .unwrap();
        let export_path = root.join("recovery.farfold.sqlite3");
        let exported = create_export(
            &mut source,
            CreatePortableExportInput {
                destination_path: export_path.to_string_lossy().into_owned(),
            },
        )
        .unwrap();
        drop(source);
        Connection::open(&export_path)
            .unwrap()
            .execute_batch("VACUUM")
            .unwrap();
        let changed_export = preview_import(export_path.to_string_lossy().as_ref()).unwrap();
        assert_ne!(changed_export.sha256, exported.sha256);

        let live_path = root.join("farfold-host.sqlite3");
        let corrupt_source = b"not a sqlite database";
        fs::write(&live_path, corrupt_source).unwrap();
        let store = HostStore::open(&live_path);
        assert!(!store.is_ready().unwrap());
        let stale_error = request_recovery_restore(
            &store,
            RequestRecoveryRestoreInput {
                source_path: export_path.to_string_lossy().into_owned(),
                expected_sha256: exported.sha256,
            },
        )
        .unwrap_err();
        assert_eq!(
            stale_error,
            "Portable recovery source changed after preview"
        );
        let request = request_recovery_restore(
            &store,
            RequestRecoveryRestoreInput {
                source_path: export_path.to_string_lossy().into_owned(),
                expected_sha256: changed_export.sha256.clone(),
            },
        )
        .unwrap();
        assert_eq!(request.preview.sha256, changed_export.sha256);
        assert!(request.activation.restart_required);
        assert_eq!(fs::read(&live_path).unwrap(), corrupt_source);
        drop(store);

        let status = process_pending_import_activation(&live_path).unwrap();
        assert_eq!(status.phase, PortableImportActivationPhase::Activated);
        assert!(status.rollback_path.is_none());
        assert!(!pending_import_path(&root, &changed_export.sha256).exists());
        assert!(fs::read_dir(&root).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".incomplete")
        }));
        let archive = status.recovery_source_archive_path.unwrap();
        assert_eq!(fs::read(archive).unwrap(), corrupt_source);
        let activated = ready(HostDatabaseOpen::open(&live_path));
        assert_eq!(marker(&activated), "restored");
        drop(activated);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recovery_restore_cannot_be_requested_from_a_ready_store() {
        let root = std::env::temp_dir().join(format!(
            "farfold-recovery-restore-ready-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let store = HostStore::open(root.join("farfold-host.sqlite3"));
        let error = request_recovery_restore(
            &store,
            RequestRecoveryRestoreInput {
                source_path: root
                    .join("missing.farfold.sqlite3")
                    .to_string_lossy()
                    .into_owned(),
                expected_sha256: "a".repeat(64),
            },
        )
        .unwrap_err();
        assert_eq!(error, "Host storage is not in recovery mode");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recovery_restore_smoke_failure_returns_to_the_original_recovery_source() {
        let root = std::env::temp_dir().join(format!(
            "farfold-recovery-restore-rollback-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let source_path = root.join("source.sqlite3");
        let mut source = ready(HostDatabaseOpen::open(&source_path));
        let export_path = root.join("recovery.farfold.sqlite3");
        let exported = create_export(
            &mut source,
            CreatePortableExportInput {
                destination_path: export_path.to_string_lossy().into_owned(),
            },
        )
        .unwrap();
        drop(source);

        let live_path = root.join("farfold-host.sqlite3");
        let corrupt_source = b"still not a sqlite database";
        fs::write(&live_path, corrupt_source).unwrap();
        let store = HostStore::open(&live_path);
        request_recovery_restore(
            &store,
            RequestRecoveryRestoreInput {
                source_path: export_path.to_string_lossy().into_owned(),
                expected_sha256: exported.sha256,
            },
        )
        .unwrap();
        drop(store);
        let intent = super::read_intent(&intent_path(&root, false)).unwrap();
        let failure = activate_with_validator(&live_path, &intent, |_| {
            Err("forced recovery smoke failure".to_string())
        })
        .unwrap_err();
        assert!(failure.rolled_back);
        assert!(failure.safe_to_continue);
        assert_eq!(fs::read(&live_path).unwrap(), corrupt_source);
        assert!(!super::recovery_source_archive_path(&root, &intent).exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn changed_staged_import_is_rejected_without_touching_live_data() {
        let root = std::env::temp_dir().join(format!(
            "farfold-import-activation-reject-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let live_path = root.join("farfold-host.sqlite3");
        let mut live = ready(HostDatabaseOpen::open(&live_path));
        live.connection
            .execute_batch("CREATE TABLE activation_test_marker(value TEXT NOT NULL);")
            .unwrap();
        live.connection
            .execute("INSERT INTO activation_test_marker VALUES ('old')", [])
            .unwrap();
        let (sha256, staged_path) = create_staged_import(&root, &mut live, "imported");
        request_activation(&mut live, sha256).unwrap();
        drop(live);
        OpenOptions::new()
            .append(true)
            .open(staged_path)
            .unwrap()
            .write_all(b"changed")
            .unwrap();
        let status = process_pending_import_activation(&live_path).unwrap();
        assert_eq!(status.phase, PortableImportActivationPhase::Rejected);
        let unchanged = ready(HostDatabaseOpen::open(&live_path));
        assert_eq!(marker(&unchanged), "old");
        assert!(status.rollback_path.is_none());
        drop(unchanged);
        let _ = fs::remove_dir_all(root);
    }
}
