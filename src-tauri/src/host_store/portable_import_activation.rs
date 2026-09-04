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
use sha2::{Digest, Sha256};
use std::{
    ffi::OsString,
    fmt::Write as _,
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
const PENDING_RESET_INTENT_FILE: &str = "farfold-host.pending-reset.json";
const APPLYING_RESET_INTENT_FILE: &str = ".farfold-host.applying-reset.json";
const MAX_INTENT_BYTES: u64 = 4 * 1024;
const EXPORT_MANIFEST_TABLE: &str = "farfold_portable_export_manifest";
const RECOVERY_RESET_CONFIRMATION: &str = "RESET FARFOLD HOST";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HostStorageActivationPhase {
    Idle,
    Activated,
    Reset,
    Rejected,
    RolledBack,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostStorageActivationStatus {
    phase: HostStorageActivationPhase,
    sha256: Option<String>,
    rollback_path: Option<String>,
    recovery_source_archive_path: Option<String>,
    reason: Option<String>,
}

impl HostStorageActivationStatus {
    fn idle() -> Self {
        Self {
            phase: HostStorageActivationPhase::Idle,
            sha256: None,
            rollback_path: None,
            recovery_source_archive_path: None,
            reason: None,
        }
    }

    fn rejected(sha256: Option<String>, reason: String) -> Self {
        Self {
            phase: HostStorageActivationPhase::Rejected,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestRecoveryResetInput {
    confirmation: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RequestedRecoveryReset {
    archive_path: String,
    source_byte_count: u64,
    source_sha256: String,
    already_requested: bool,
    restart_required: bool,
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

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct RecoveryResetIntent {
    version: i64,
    operation_id: String,
    requested_at: i64,
    source: RecoveryDatabaseIdentity,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct RecoveryDatabaseIdentity {
    byte_count: u64,
    sha256: String,
    members: Vec<String>,
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

fn reset_intent_path(profile: &Path, applying: bool) -> PathBuf {
    profile.join(if applying {
        APPLYING_RESET_INTENT_FILE
    } else {
        PENDING_RESET_INTENT_FILE
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

fn recovery_reset_archive_path(profile: &Path, operation_id: &str) -> PathBuf {
    profile.join(format!(
        "farfold-host.recovery-source-before-reset-{operation_id}.sqlite3"
    ))
}

fn recovery_reset_failed_path(profile: &Path, operation_id: &str) -> PathBuf {
    profile.join(format!(".farfold-host.reset-{operation_id}-failed.sqlite3"))
}

fn sidecar_path(database_path: &Path, suffix: &str) -> PathBuf {
    let mut value = OsString::from(database_path.as_os_str());
    value.push(suffix);
    PathBuf::from(value)
}

fn recovery_database_identity(path: &Path) -> Result<RecoveryDatabaseIdentity, String> {
    let mut digest = Sha256::new();
    digest.update(b"farfold-host-recovery-family-v1\0");
    let mut byte_count = 0_u64;
    let mut members = Vec::new();
    for suffix in ["", "-wal", "-shm"] {
        let member = if suffix.is_empty() {
            path.to_path_buf()
        } else {
            sidecar_path(path, suffix)
        };
        let label = if suffix.is_empty() { "main" } else { suffix };
        match fs::symlink_metadata(&member) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(
                        "Host recovery database family contains a non-regular file".to_string()
                    );
                }
                let length = metadata.len();
                byte_count = byte_count
                    .checked_add(length)
                    .ok_or_else(|| "Host recovery database family size overflowed".to_string())?;
                digest.update(label.as_bytes());
                digest.update([1]);
                digest.update(length.to_be_bytes());
                let mut file = fs::File::open(&member).map_err(|error| {
                    format!("Cannot open Host recovery database family: {error}")
                })?;
                let mut buffer = [0_u8; 64 * 1024];
                let mut observed = 0_u64;
                loop {
                    let read = file.read(&mut buffer).map_err(|error| {
                        format!("Cannot hash Host recovery database family: {error}")
                    })?;
                    if read == 0 {
                        break;
                    }
                    observed = observed.checked_add(read as u64).ok_or_else(|| {
                        "Host recovery database family size overflowed".to_string()
                    })?;
                    digest.update(&buffer[..read]);
                }
                if observed != length {
                    return Err(
                        "Host recovery database family changed while it was inspected".to_string(),
                    );
                }
                members.push(label.to_string());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && !suffix.is_empty() => {
                digest.update(label.as_bytes());
                digest.update([0]);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err("Host recovery database does not exist".to_string());
            }
            Err(error) => {
                return Err(format!(
                    "Cannot inspect Host recovery database family: {error}"
                ));
            }
        }
    }
    let mut sha256 = String::with_capacity(64);
    for byte in digest.finalize() {
        write!(&mut sha256, "{byte:02x}")
            .map_err(|error| format!("Cannot encode Host recovery database digest: {error}"))?;
    }
    Ok(RecoveryDatabaseIdentity {
        byte_count,
        sha256,
        members,
    })
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

fn read_reset_intent(path: &Path) -> Result<RecoveryResetIntent, String> {
    require_regular_file(path, "Host recovery reset intent")?;
    let metadata = path
        .metadata()
        .map_err(|error| format!("Cannot inspect Host recovery reset intent: {error}"))?;
    if metadata.len() == 0 || metadata.len() > MAX_INTENT_BYTES {
        return Err("Host recovery reset intent size is invalid".to_string());
    }
    let file = fs::File::open(path)
        .map_err(|error| format!("Cannot open Host recovery reset intent: {error}"))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_INTENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Cannot read Host recovery reset intent: {error}"))?;
    let intent: RecoveryResetIntent = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Host recovery reset intent is invalid: {error}"))?;
    if intent.version != ACTIVATION_INTENT_VERSION {
        return Err(format!(
            "Host recovery reset intent version {} is unsupported",
            intent.version
        ));
    }
    validate_operation_id(&intent.operation_id)?;
    if intent.requested_at < 0 {
        return Err("Host recovery reset request time is invalid".to_string());
    }
    validate_sha256(&intent.source.sha256)?;
    if intent.source.members.is_empty()
        || intent.source.members.len() > 3
        || intent.source.members[0] != "main"
        || intent
            .source
            .members
            .iter()
            .any(|member| !matches!(member.as_str(), "main" | "-wal" | "-shm"))
    {
        return Err("Host recovery reset source identity is invalid".to_string());
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

fn write_reset_intent(profile: &Path, intent: &RecoveryResetIntent) -> Result<(), String> {
    let destination = reset_intent_path(profile, false);
    let temporary = profile.join(format!(
        ".farfold-host.pending-reset.{}.{}.incomplete",
        std::process::id(),
        BACKUP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = reserve_file(&temporary, "Host recovery reset intent")?;
        let bytes = serde_json::to_vec(intent)
            .map_err(|error| format!("Cannot encode Host recovery reset intent: {error}"))?;
        file.write_all(&bytes)
            .map_err(|error| format!("Cannot write Host recovery reset intent: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Cannot sync Host recovery reset intent: {error}"))?;
        drop(file);
        fs::hard_link(&temporary, &destination).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "A Host recovery reset is already pending".to_string()
            } else {
                format!("Cannot publish Host recovery reset intent: {error}")
            }
        })?;
        fs::remove_file(&temporary).map_err(|error| {
            let _ = fs::remove_file(&destination);
            format!("Cannot finish Host recovery reset intent: {error}")
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
    if reset_intent_path(profile, false).exists() || reset_intent_path(profile, true).exists() {
        return Err("A Host recovery reset is already pending".to_string());
    }
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

fn database_family_exists(path: &Path) -> bool {
    ["", "-wal", "-shm"].iter().any(|suffix| {
        let member = if suffix.is_empty() {
            path.to_path_buf()
        } else {
            sidecar_path(path, suffix)
        };
        fs::symlink_metadata(member).is_ok()
    })
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

fn quarantine_reset_intent(profile: &Path, source: &Path, operation_id: Option<&str>) {
    let suffix = operation_id.unwrap_or("unknown");
    let destination = profile.join(format!(
        "farfold-host.reset-intent-rejected-{suffix}-{}.json",
        BACKUP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::rename(source, destination);
    let _ = sync_directory(profile);
}

fn rollback_recovery_reset(
    database_path: &Path,
    archive_path: &Path,
    failed_path: &Path,
) -> Result<(), String> {
    if database_family_exists(database_path) {
        remove_database_family(failed_path);
        move_database_family(database_path, failed_path).map_err(|error| error.reason)?;
    }
    move_database_family(archive_path, database_path).map_err(|error| error.reason)?;
    remove_database_family(failed_path);
    sync_directory(
        database_path
            .parent()
            .ok_or_else(|| "Host database path has no parent directory".to_string())?,
    )?;
    require_regular_file(database_path, "restored recovery source")
}

fn activate_recovery_reset(
    database_path: &Path,
    intent: &RecoveryResetIntent,
    validator: impl Fn(&Path) -> Result<(), String>,
) -> Result<PathBuf, ActivationFailure> {
    let profile = database_path.parent().ok_or_else(|| {
        ActivationFailure::rejected("Host database path has no parent directory".to_string())
    })?;
    let archive_path = recovery_reset_archive_path(profile, &intent.operation_id);
    let failed_path = recovery_reset_failed_path(profile, &intent.operation_id);

    if database_family_exists(&archive_path) {
        if let Err(error) = require_regular_file(&archive_path, "Host recovery reset archive") {
            return Err(ActivationFailure::rejected(error));
        }
        let archive_identity = recovery_database_identity(&archive_path);
        if archive_identity.as_ref() != Ok(&intent.source) {
            if recovery_database_identity(database_path).as_ref() == Ok(&intent.source) {
                return Err(ActivationFailure::rejected(
                    "Host recovery reset archive path became occupied before activation"
                        .to_string(),
                ));
            }
            return Err(ActivationFailure {
                reason: archive_identity.err().unwrap_or_else(|| {
                    "Host recovery reset archive changed during activation".to_string()
                }),
                rollback_path: Some(archive_path),
                rolled_back: false,
                safe_to_continue: false,
            });
        }
        if database_family_exists(database_path) {
            if validator(database_path).is_ok() {
                remove_database_family(&failed_path);
                return Ok(archive_path);
            }
            if let Err(error) = rollback_recovery_reset(database_path, &archive_path, &failed_path)
            {
                return Err(ActivationFailure {
                    reason: format!(
                        "Interrupted Host reset could not restore the recovery source: {error}"
                    ),
                    rollback_path: Some(archive_path),
                    rolled_back: false,
                    safe_to_continue: false,
                });
            }
            return Err(ActivationFailure {
                reason: "Interrupted Host reset was rolled back to the recovery source".to_string(),
                rollback_path: None,
                rolled_back: true,
                safe_to_continue: true,
            });
        }
    } else {
        if let Err(error) = require_regular_file(database_path, "Host recovery reset source") {
            return Err(ActivationFailure::rejected(error));
        }
        match recovery_database_identity(database_path) {
            Ok(identity) if identity == intent.source => {}
            Ok(_) => {
                return Err(ActivationFailure::rejected(
                    "Host recovery source changed after reset was requested".to_string(),
                ));
            }
            Err(reason) => return Err(ActivationFailure::rejected(reason)),
        }
        if let Err(error) = move_database_family(database_path, &archive_path) {
            return Err(ActivationFailure {
                reason: error.reason,
                rollback_path: None,
                rolled_back: false,
                safe_to_continue: error.original_restored,
            });
        }
        if let Err(error) = sync_directory(profile) {
            let restored = move_database_family(&archive_path, database_path)
                .map_err(|restore| restore.reason)
                .and_then(|_| sync_directory(profile));
            return Err(ActivationFailure {
                reason: format!(
                    "Cannot persist Host recovery reset archive: {error}; rollback: {restored:?}"
                ),
                rollback_path: None,
                rolled_back: restored.is_ok(),
                safe_to_continue: restored.is_ok(),
            });
        }
    }

    if let Err(error) = validator(database_path).and_then(|_| sync_directory(profile)) {
        let rollback = rollback_recovery_reset(database_path, &archive_path, &failed_path);
        return Err(ActivationFailure {
            reason: if rollback.is_ok() {
                format!("Host recovery reset failed and was rolled back: {error}")
            } else {
                format!("Host recovery reset failed: {error}; rollback: {rollback:?}")
            },
            rollback_path: None,
            rolled_back: rollback.is_ok(),
            safe_to_continue: rollback.is_ok(),
        });
    }
    remove_database_family(&failed_path);
    Ok(archive_path)
}

fn process_pending_recovery_reset(
    database_path: &Path,
    profile: &Path,
) -> Result<Option<HostStorageActivationStatus>, String> {
    let pending_path = reset_intent_path(profile, false);
    let applying_path = reset_intent_path(profile, true);
    if !pending_path.exists() && !applying_path.exists() {
        return Ok(None);
    }
    if pending_path.exists() && applying_path.exists() {
        return Err("Both pending and applying Host recovery reset intents exist".to_string());
    }
    if intent_path(profile, false).exists() || intent_path(profile, true).exists() {
        return Err("Host recovery reset conflicts with a portable import activation".to_string());
    }
    let source_path = if applying_path.exists() {
        applying_path
    } else {
        fs::rename(&pending_path, &applying_path)
            .map_err(|error| format!("Cannot begin Host recovery reset: {error}"))?;
        sync_directory(profile)?;
        applying_path
    };
    let intent = match read_reset_intent(&source_path) {
        Ok(intent) => intent,
        Err(reason) => {
            quarantine_reset_intent(profile, &source_path, None);
            return Ok(Some(HostStorageActivationStatus::rejected(None, reason)));
        }
    };
    match activate_recovery_reset(database_path, &intent, validate_live_database) {
        Ok(archive_path) => {
            fs::remove_file(&source_path)
                .map_err(|error| format!("Cannot consume Host recovery reset intent: {error}"))?;
            sync_directory(profile)?;
            Ok(Some(HostStorageActivationStatus {
                phase: HostStorageActivationPhase::Reset,
                sha256: None,
                rollback_path: None,
                recovery_source_archive_path: Some(archive_path.to_string_lossy().into_owned()),
                reason: None,
            }))
        }
        Err(failure) => {
            if !failure.safe_to_continue {
                return Err(failure.reason);
            }
            quarantine_reset_intent(profile, &source_path, Some(&intent.operation_id));
            Ok(Some(HostStorageActivationStatus {
                phase: if failure.rolled_back {
                    HostStorageActivationPhase::RolledBack
                } else {
                    HostStorageActivationPhase::Rejected
                },
                sha256: None,
                rollback_path: None,
                recovery_source_archive_path: None,
                reason: Some(failure.reason),
            }))
        }
    }
}

pub fn process_pending_storage_activation(
    database_path: &Path,
) -> Result<HostStorageActivationStatus, String> {
    let parent = match database_path.parent() {
        Some(parent) if parent.exists() => parent,
        _ => return Ok(HostStorageActivationStatus::idle()),
    };
    let profile = parent
        .canonicalize()
        .map_err(|error| format!("Cannot resolve Host database directory: {error}"))?;
    if let Some(status) = process_pending_recovery_reset(database_path, &profile)? {
        return Ok(status);
    }
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
        return Ok(HostStorageActivationStatus::idle());
    };
    let intent = match read_intent(&source_path) {
        Ok(intent) => intent,
        Err(reason) => {
            quarantine_intent(&profile, &source_path, None);
            return Ok(HostStorageActivationStatus::rejected(None, reason));
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
            Ok(HostStorageActivationStatus {
                phase: HostStorageActivationPhase::Activated,
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
            Ok(HostStorageActivationStatus {
                phase: if failure.rolled_back {
                    HostStorageActivationPhase::RolledBack
                } else {
                    HostStorageActivationPhase::Rejected
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
    let profile = profile_path(&database_path)?;
    if reset_intent_path(&profile, false).exists() || reset_intent_path(&profile, true).exists() {
        return Err("A Host recovery reset is already pending".to_string());
    }
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

fn request_recovery_reset(
    store: &HostStore,
    input: RequestRecoveryResetInput,
) -> Result<RequestedRecoveryReset, String> {
    if input.confirmation != RECOVERY_RESET_CONFIRMATION {
        return Err("Host recovery reset confirmation does not match".to_string());
    }
    let database_path = store.recovery_path()?;
    let profile = profile_path(&database_path)?;
    if intent_path(&profile, false).exists() || intent_path(&profile, true).exists() {
        return Err("A portable import activation is already pending".to_string());
    }
    for applying in [false, true] {
        let existing_path = reset_intent_path(&profile, applying);
        if existing_path.exists() {
            let existing = read_reset_intent(&existing_path)?;
            return Ok(RequestedRecoveryReset {
                archive_path: recovery_reset_archive_path(&profile, &existing.operation_id)
                    .to_string_lossy()
                    .into_owned(),
                source_byte_count: existing.source.byte_count,
                source_sha256: existing.source.sha256,
                already_requested: true,
                restart_required: true,
            });
        }
    }
    let source = recovery_database_identity(&database_path)?;
    let intent = RecoveryResetIntent {
        version: ACTIVATION_INTENT_VERSION,
        operation_id: format!(
            "{}-{}-{}",
            now_millis(),
            std::process::id(),
            BACKUP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ),
        requested_at: now_millis(),
        source: source.clone(),
    };
    let archive_path = recovery_reset_archive_path(&profile, &intent.operation_id);
    if database_family_exists(&archive_path) {
        return Err("Host recovery reset archive path is already occupied".to_string());
    }
    write_reset_intent(&profile, &intent)?;
    Ok(RequestedRecoveryReset {
        archive_path: archive_path.to_string_lossy().into_owned(),
        source_byte_count: source.byte_count,
        source_sha256: source.sha256,
        already_requested: false,
        restart_required: true,
    })
}

#[tauri::command]
pub fn host_recovery_reset_request(
    store: State<'_, HostStore>,
    pi: State<'_, PiRuntime>,
    opencode: State<'_, OpenCodeRuntime>,
    input: RequestRecoveryResetInput,
) -> Result<RequestedRecoveryReset, String> {
    pi_runtime::with_stopped(&pi, || {
        opencode_runtime::with_stopped(&opencode, || request_recovery_reset(&store, input))
    })
}

#[tauri::command]
pub fn host_storage_activation_status(
    status: State<'_, HostStorageActivationStatus>,
) -> HostStorageActivationStatus {
    status.inner().clone()
}

#[cfg(test)]
mod tests {
    use super::{
        ActivationIntent, HostStorageActivationPhase, RECOVERY_RESET_CONFIRMATION,
        RequestRecoveryResetInput, RequestRecoveryRestoreInput, activate_recovery_reset,
        activate_with_validator, intent_path, pending_import_path,
        process_pending_storage_activation, recovery_reset_failed_path, request_activation,
        request_recovery_reset, request_recovery_restore, reset_intent_path, sidecar_path,
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

        let status = process_pending_storage_activation(&live_path).unwrap();
        assert_eq!(status.phase, HostStorageActivationPhase::Activated);
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

        let status = process_pending_storage_activation(&live_path).unwrap();
        assert_eq!(status.phase, HostStorageActivationPhase::Activated);
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
    fn explicit_recovery_reset_preserves_the_database_family_and_starts_empty() {
        let root = std::env::temp_dir().join(format!(
            "farfold-recovery-reset-success-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let live_path = root.join("farfold-host.sqlite3");
        let source = b"not a sqlite database";
        let source_wal = b"retained wal";
        let source_shm = b"retained shm";
        fs::write(&live_path, source).unwrap();
        let external_working_copy = root.join("external-working-copy");
        fs::create_dir(&external_working_copy).unwrap();
        fs::write(external_working_copy.join("sentinel"), b"untouched").unwrap();

        let store = HostStore::open(&live_path);
        assert!(!store.is_ready().unwrap());
        fs::write(sidecar_path(&live_path, "-wal"), source_wal).unwrap();
        fs::write(sidecar_path(&live_path, "-shm"), source_shm).unwrap();
        let wrong_confirmation = request_recovery_reset(
            &store,
            RequestRecoveryResetInput {
                confirmation: "reset".to_string(),
            },
        )
        .unwrap_err();
        assert_eq!(
            wrong_confirmation,
            "Host recovery reset confirmation does not match"
        );
        assert!(!reset_intent_path(&root, false).exists());

        let requested = request_recovery_reset(
            &store,
            RequestRecoveryResetInput {
                confirmation: RECOVERY_RESET_CONFIRMATION.to_string(),
            },
        )
        .unwrap();
        assert!(requested.restart_required);
        assert!(!requested.already_requested);
        assert_eq!(
            requested.source_byte_count,
            (source.len() + source_wal.len() + source_shm.len()) as u64
        );
        assert_eq!(requested.source_sha256.len(), 64);
        assert_eq!(fs::read(&live_path).unwrap(), source);
        assert!(reset_intent_path(&root, false).exists());
        drop(store);

        let status = process_pending_storage_activation(&live_path).unwrap();
        assert_eq!(status.phase, HostStorageActivationPhase::Reset);
        assert!(status.sha256.is_none());
        let archive = Path::new(status.recovery_source_archive_path.as_deref().unwrap());
        assert_eq!(
            archive.canonicalize().unwrap(),
            Path::new(&requested.archive_path).canonicalize().unwrap()
        );
        assert_eq!(fs::read(archive).unwrap(), source);
        assert_eq!(fs::read(sidecar_path(archive, "-wal")).unwrap(), source_wal);
        assert_eq!(fs::read(sidecar_path(archive, "-shm")).unwrap(), source_shm);
        assert!(!reset_intent_path(&root, false).exists());
        assert!(!reset_intent_path(&root, true).exists());
        assert_eq!(
            fs::read(external_working_copy.join("sentinel")).unwrap(),
            b"untouched"
        );
        let reset = ready(HostDatabaseOpen::open(&live_path));
        assert_eq!(
            reset.schema_version().unwrap(),
            super::CURRENT_SCHEMA_VERSION
        );
        assert_eq!(
            reset
                .connection
                .query_row("SELECT count(*) FROM sessions", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        drop(reset);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recovery_reset_failure_restores_the_original_recovery_source() {
        let root = std::env::temp_dir().join(format!(
            "farfold-recovery-reset-rollback-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let live_path = root.join("farfold-host.sqlite3");
        let source = b"still not a sqlite database";
        fs::write(&live_path, source).unwrap();
        let store = HostStore::open(&live_path);
        let requested = request_recovery_reset(
            &store,
            RequestRecoveryResetInput {
                confirmation: RECOVERY_RESET_CONFIRMATION.to_string(),
            },
        )
        .unwrap();
        drop(store);
        let intent = super::read_reset_intent(&reset_intent_path(&root, false)).unwrap();
        let failure = activate_recovery_reset(&live_path, &intent, |_| {
            Err("forced reset smoke failure".to_string())
        })
        .unwrap_err();
        assert!(failure.rolled_back);
        assert!(failure.safe_to_continue);
        assert_eq!(fs::read(&live_path).unwrap(), source);
        assert!(!Path::new(&requested.archive_path).exists());
        assert!(!recovery_reset_failed_path(&root, &intent.operation_id).exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn changed_recovery_source_rejects_reset_without_moving_data() {
        let root = std::env::temp_dir().join(format!(
            "farfold-recovery-reset-changed-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let live_path = root.join("farfold-host.sqlite3");
        fs::write(&live_path, b"not a sqlite database").unwrap();
        let store = HostStore::open(&live_path);
        let requested = request_recovery_reset(
            &store,
            RequestRecoveryResetInput {
                confirmation: RECOVERY_RESET_CONFIRMATION.to_string(),
            },
        )
        .unwrap();
        drop(store);
        OpenOptions::new()
            .append(true)
            .open(&live_path)
            .unwrap()
            .write_all(b" changed")
            .unwrap();

        let status = process_pending_storage_activation(&live_path).unwrap();
        assert_eq!(status.phase, HostStorageActivationPhase::Rejected);
        assert_eq!(
            status.reason.as_deref(),
            Some("Host recovery source changed after reset was requested")
        );
        assert!(!Path::new(&requested.archive_path).exists());
        assert_eq!(
            fs::read(&live_path).unwrap(),
            b"not a sqlite database changed"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recovery_reset_cannot_be_requested_from_a_ready_store() {
        let root = std::env::temp_dir().join(format!(
            "farfold-recovery-reset-ready-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let store = HostStore::open(root.join("farfold-host.sqlite3"));
        let error = request_recovery_reset(
            &store,
            RequestRecoveryResetInput {
                confirmation: RECOVERY_RESET_CONFIRMATION.to_string(),
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
        let status = process_pending_storage_activation(&live_path).unwrap();
        assert_eq!(status.phase, HostStorageActivationPhase::Rejected);
        let unchanged = ready(HostDatabaseOpen::open(&live_path));
        assert_eq!(marker(&unchanged), "old");
        assert!(status.rollback_path.is_none());
        drop(unchanged);
        let _ = fs::remove_dir_all(root);
    }
}
