use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::CString,
    fmt::Write as _,
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::ffi::OsStrExt,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Component, Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

use crate::{host_store::HostStore, runtime_registry::file_sha256};

const INTENT_VERSION: u32 = 1;
const RECOVERY_DIRECTORY: &str = "managed-update-recovery";
const PENDING_INTENT: &str = "pending-activation.json";
const PENDING_DISCARD: &str = "pending-recovery-discard.json";
const MAX_INTENT_BYTES: u64 = 16 * 1024;
const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_RECOVERY_DIRECTORY_ENTRIES: usize = 256;
static OPERATION_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateActivationIntent {
    pub(crate) format_version: u32,
    pub(crate) operation_id: String,
    pub(crate) candidate_token: String,
    pub(crate) from_version: String,
    pub(crate) to_version: String,
    pub(crate) bundle_id: String,
    pub(crate) current_main_sha256: String,
    pub(crate) candidate_main_sha256: String,
    pub(crate) artifact_sha256: String,
    pub(crate) host_snapshot_sha256: String,
    pub(crate) current_host_schema_version: u64,
    pub(crate) candidate_host_schema_version: u64,
    pub(crate) current_executable_relative_path: String,
    pub(crate) phase: UpdateActivationPhase,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum UpdateActivationPhase {
    Prepared,
    Installing,
    Installed,
    Committed,
    RollingBack,
    RolledBack,
    Discarding,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum UpdateStartupDisposition {
    None,
    ValidateCandidate(Box<UpdateActivationIntent>),
    ResumeRollback(Box<UpdateActivationIntent>),
    RolledBack,
}

pub(crate) struct PrepareUpdateRecoveryInput<'a> {
    pub(crate) app_data_dir: &'a Path,
    pub(crate) current_executable: &'a Path,
    pub(crate) artifact: &'a [u8],
    pub(crate) candidate_token: &'a str,
    pub(crate) from_version: &'a str,
    pub(crate) to_version: &'a str,
    pub(crate) bundle_id: &'a str,
    pub(crate) candidate_main_sha256: &'a str,
    pub(crate) current_host_schema_version: u64,
    pub(crate) candidate_host_schema_version: u64,
}

fn sha256_bytes(value: &[u8]) -> String {
    let mut encoded = String::with_capacity(64);
    for byte in Sha256::digest(value) {
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    encoded
}

fn valid_token(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_identity(value: &str, max_bytes: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control)
}

fn valid_operation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'-')
}

fn validate_relative_executable(path: &Path) -> Result<String, String> {
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => components.push(
                value
                    .to_str()
                    .ok_or_else(|| "Current app executable path is not valid UTF-8".to_string())?,
            ),
            _ => return Err("Current app executable path is unsafe".to_string()),
        }
    }
    if components.len() != 3 || components[0] != "Contents" || components[1] != "MacOS" {
        return Err("Current executable is not inside a macOS app bundle".to_string());
    }
    Ok(components.join("/"))
}

fn current_app_identity(current_executable: &Path) -> Result<(PathBuf, String), String> {
    let app_path = current_executable
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or_else(|| "Cannot resolve current macOS app bundle".to_string())?;
    if app_path.extension().and_then(|value| value.to_str()) != Some("app") || !app_path.is_dir() {
        return Err("Current executable is not inside a macOS app bundle".to_string());
    }
    let relative = current_executable
        .strip_prefix(app_path)
        .map_err(|_| "Cannot bind current executable to its app bundle".to_string())?;
    Ok((
        app_path.to_path_buf(),
        validate_relative_executable(relative)?,
    ))
}

fn recovery_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(RECOVERY_DIRECTORY)
}

fn intent_path(app_data_dir: &Path) -> PathBuf {
    recovery_root(app_data_dir).join(PENDING_INTENT)
}

fn discard_intent_path(app_data_dir: &Path) -> PathBuf {
    recovery_root(app_data_dir).join(PENDING_DISCARD)
}

fn operation_path(app_data_dir: &Path, operation_id: &str) -> PathBuf {
    recovery_root(app_data_dir).join(format!("operation-{operation_id}"))
}

fn sync_directory(path: &Path) -> Result<(), String> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Cannot sync managed update recovery directory: {error}"))
}

fn prepare_private_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => {
            let mut permissions = metadata.permissions();
            permissions.set_mode(0o700);
            fs::set_permissions(path, permissions).map_err(|error| {
                format!("Cannot secure managed update recovery directory: {error}")
            })
        }
        Ok(_) => Err("Managed update recovery path is not a directory".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(|error| {
                format!("Cannot create managed update recovery directory: {error}")
            })?;
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| {
                format!("Cannot secure managed update recovery directory: {error}")
            })
        }
        Err(error) => Err(format!(
            "Cannot inspect managed update recovery directory: {error}"
        )),
    }
}

fn write_private_file(path: &Path, value: &[u8], label: &str) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| format!("Cannot reserve managed update {label}: {error}"))?;
    file.write_all(value)
        .map_err(|error| format!("Cannot write managed update {label}: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Cannot sync managed update {label}: {error}"))
}

fn verify_app_signature(app_path: &Path) -> Result<(), String> {
    let output = Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(app_path)
        .output()
        .map_err(|_| "Cannot run rollback app code-signature verification".to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err("Rollback app code signature is invalid".to_string())
    }
}

fn copy_rollback_app(source: &Path, destination: &Path) -> Result<(), String> {
    let output = Command::new("/usr/bin/ditto")
        .arg(source)
        .arg(destination)
        .output()
        .map_err(|_| "Cannot start rollback app copy".to_string())?;
    if !output.status.success() {
        return Err("Cannot copy rollback app".to_string());
    }
    verify_app_signature(destination)
}

fn require_regular_file(path: &Path, label: &str, max_bytes: Option<u64>) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| format!("Managed update recovery {label} is unavailable"))?;
    if !metadata.file_type().is_file()
        || metadata.len() == 0
        || max_bytes.is_some_and(|limit| metadata.len() > limit)
    {
        return Err(format!("Managed update recovery {label} is invalid"));
    }
    Ok(())
}

pub(crate) fn verify_recovery_unit(
    app_data_dir: &Path,
    intent: &UpdateActivationIntent,
) -> Result<(), String> {
    validate_intent(intent)?;
    let operation = operation_path(app_data_dir, &intent.operation_id);
    let operation_metadata = fs::symlink_metadata(&operation)
        .map_err(|_| "Managed update recovery operation is unavailable".to_string())?;
    if !operation_metadata.file_type().is_dir() {
        return Err("Managed update recovery operation is invalid".to_string());
    }
    let artifact = operation.join("candidate.app.tar.gz");
    let host_snapshot = operation.join("farfold-host.sqlite3");
    let rollback_app = operation.join("rollback.app");
    require_regular_file(&artifact, "candidate artifact", Some(MAX_ARTIFACT_BYTES))?;
    require_regular_file(&host_snapshot, "Host snapshot", None)?;
    let rollback_metadata = fs::symlink_metadata(&rollback_app)
        .map_err(|_| "Managed update recovery rollback app is unavailable".to_string())?;
    if !rollback_metadata.file_type().is_dir() {
        return Err("Managed update recovery rollback app is invalid".to_string());
    }
    let rollback_executable = rollback_app.join(&intent.current_executable_relative_path);
    require_regular_file(&rollback_executable, "rollback executable", None)?;
    if file_sha256(&artifact)? != intent.artifact_sha256
        || file_sha256(&host_snapshot)? != intent.host_snapshot_sha256
        || file_sha256(&rollback_executable)? != intent.current_main_sha256
    {
        return Err("Managed update recovery unit digest does not match its intent".to_string());
    }
    verify_app_signature(&rollback_app)
}

fn publish_intent(path: &Path, intent: &UpdateActivationIntent) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Managed update intent path has no parent".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Managed update intent filename is invalid".to_string())?;
    let temporary = parent.join(format!(".{file_name}.incomplete"));
    let encoded = serde_json::to_vec(intent)
        .map_err(|_| "Cannot encode managed update activation intent".to_string())?;
    if encoded.len() as u64 > MAX_INTENT_BYTES {
        return Err("Managed update activation intent is too large".to_string());
    }
    write_private_file(&temporary, &encoded, "activation intent")?;
    let result = fs::hard_link(&temporary, path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            "A managed update activation is already pending".to_string()
        } else {
            format!("Cannot publish managed update activation intent: {error}")
        }
    });
    let _ = fs::remove_file(&temporary);
    result?;
    sync_directory(parent)
}

fn replace_intent(app_data_dir: &Path, intent: &UpdateActivationIntent) -> Result<(), String> {
    let path = intent_path(app_data_dir);
    let parent = path
        .parent()
        .ok_or_else(|| "Managed update intent path has no parent".to_string())?;
    let temporary = parent.join(format!(
        ".{PENDING_INTENT}.{}.incomplete",
        intent.operation_id
    ));
    let encoded = serde_json::to_vec(intent)
        .map_err(|_| "Cannot encode managed update activation intent".to_string())?;
    if encoded.len() as u64 > MAX_INTENT_BYTES {
        return Err("Managed update activation intent is too large".to_string());
    }
    if temporary.exists() {
        fs::remove_file(&temporary)
            .map_err(|error| format!("Cannot clear stale managed update intent: {error}"))?;
    }
    write_private_file(&temporary, &encoded, "activation intent")?;
    fs::rename(&temporary, &path)
        .map_err(|error| format!("Cannot replace managed update activation intent: {error}"))?;
    sync_directory(parent)
}

fn read_intent_file(path: &Path) -> Result<UpdateActivationIntent, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => return Err(format!("Cannot inspect managed update intent: {error}")),
    };
    if !metadata.file_type().is_file() || metadata.len() == 0 || metadata.len() > MAX_INTENT_BYTES {
        return Err("Managed update activation intent is invalid".to_string());
    }
    let mut encoded = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(path)
        .and_then(|mut file| file.read_to_end(&mut encoded))
        .map_err(|error| format!("Cannot read managed update activation intent: {error}"))?;
    let intent: UpdateActivationIntent = serde_json::from_slice(&encoded)
        .map_err(|_| "Managed update activation intent is invalid".to_string())?;
    validate_intent(&intent)?;
    Ok(intent)
}

pub(crate) fn read_pending_intent(
    app_data_dir: &Path,
) -> Result<Option<UpdateActivationIntent>, String> {
    let path = intent_path(app_data_dir);
    match fs::symlink_metadata(&path) {
        Ok(_) => read_intent_file(&path).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Cannot inspect managed update intent: {error}")),
    }
}

fn validate_intent(intent: &UpdateActivationIntent) -> Result<(), String> {
    if intent.format_version != INTENT_VERSION
        || !valid_token(&intent.candidate_token)
        || !valid_token(&intent.current_main_sha256)
        || !valid_token(&intent.candidate_main_sha256)
        || !valid_token(&intent.artifact_sha256)
        || !valid_token(&intent.host_snapshot_sha256)
        || !valid_operation_id(&intent.operation_id)
        || !valid_identity(&intent.from_version, 128)
        || !valid_identity(&intent.to_version, 128)
        || !valid_identity(&intent.bundle_id, 255)
        || intent.current_host_schema_version == 0
        || intent.candidate_host_schema_version == 0
    {
        return Err("Managed update activation intent identity is invalid".to_string());
    }
    validate_relative_executable(Path::new(&intent.current_executable_relative_path))?;
    Ok(())
}

fn displaced_app_path(current_app: &Path, operation_id: &str) -> Result<PathBuf, String> {
    let parent = current_app
        .parent()
        .ok_or_else(|| "Current app bundle has no parent directory".to_string())?;
    Ok(parent.join(format!(".farfold-update-{operation_id}-displaced.app")))
}

fn finalized_intent_path(
    app_data_dir: &Path,
    intent: &UpdateActivationIntent,
    label: &str,
) -> PathBuf {
    recovery_root(app_data_dir).join(format!("{label}-activation-{}.json", intent.operation_id))
}

fn verify_displaced_rollback_app(
    current_executable: &Path,
    intent: &UpdateActivationIntent,
) -> Result<(), String> {
    let (current_app, _) = current_app_identity(current_executable)?;
    let displaced = displaced_app_path(&current_app, &intent.operation_id)?;
    verify_app_signature(&displaced)?;
    if file_sha256(&displaced.join(&intent.current_executable_relative_path))?
        != intent.current_main_sha256
    {
        return Err("Managed update displaced rollback app digest does not match".to_string());
    }
    Ok(())
}

pub(crate) fn current_committed_recovery(
    app_data_dir: &Path,
    current_executable: &Path,
) -> Result<Option<UpdateActivationIntent>, String> {
    let root = recovery_root(app_data_dir);
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Cannot inspect managed update recovery directory: {error}"
            ));
        }
    };
    let current_sha256 = file_sha256(current_executable)?;
    let mut matched = None;
    for (index, entry) in entries.enumerate() {
        if index >= MAX_RECOVERY_DIRECTORY_ENTRIES {
            return Err("Managed update recovery directory is too large".to_string());
        }
        let entry = entry
            .map_err(|error| format!("Cannot inspect managed update recovery entry: {error}"))?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Managed update recovery entry name is not UTF-8".to_string())?;
        if !name.starts_with("committed-activation-") || !name.ends_with(".json") {
            continue;
        }
        let intent = read_intent_file(&entry.path())?;
        if intent.phase != UpdateActivationPhase::Committed
            || entry.path() != finalized_intent_path(app_data_dir, &intent, "committed")
        {
            return Err("Managed update committed recovery identity is invalid".to_string());
        }
        if intent.candidate_main_sha256 != current_sha256
            || intent.to_version != env!("CARGO_PKG_VERSION")
        {
            continue;
        }
        let rolled_back = finalized_intent_path(app_data_dir, &intent, "rolled-back");
        match fs::symlink_metadata(&rolled_back) {
            Ok(_) => {
                let mut expected = intent.clone();
                expected.phase = UpdateActivationPhase::RolledBack;
                if read_intent_file(&rolled_back)? != expected {
                    return Err("Managed update rollback final status conflicts".to_string());
                }
                continue;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Cannot inspect managed update rollback final status: {error}"
                ));
            }
        }
        if matched.is_some() {
            return Err("Multiple managed update recovery points match this build".to_string());
        }
        verify_recovery_unit(app_data_dir, &intent)?;
        verify_displaced_rollback_app(current_executable, &intent)?;
        matched = Some(intent);
    }
    Ok(matched)
}

pub(crate) fn request_post_commit_rollback(
    app_data_dir: &Path,
    current_executable: &Path,
    expected_operation_id: &str,
) -> Result<UpdateActivationIntent, String> {
    if read_pending_intent(app_data_dir)?.is_some() {
        return Err("A managed update activation is already pending".to_string());
    }
    let mut intent = current_committed_recovery(app_data_dir, current_executable)?
        .ok_or_else(|| "No rollback point matches the current Farfold build".to_string())?;
    if intent.operation_id != expected_operation_id {
        return Err("Managed update rollback authorization is stale".to_string());
    }
    intent.phase = UpdateActivationPhase::RollingBack;
    publish_intent(&intent_path(app_data_dir), &intent)?;
    Ok(intent)
}

pub(crate) fn request_post_commit_discard(
    app_data_dir: &Path,
    current_executable: &Path,
    expected_operation_id: &str,
) -> Result<UpdateActivationIntent, String> {
    if read_pending_intent(app_data_dir)?.is_some() {
        return Err("A managed update activation is already pending".to_string());
    }
    let discard_path = discard_intent_path(app_data_dir);
    if discard_path.exists() {
        return Err("Managed update recovery discard is already pending".to_string());
    }
    let mut intent = current_committed_recovery(app_data_dir, current_executable)?
        .ok_or_else(|| "No rollback point matches the current Farfold build".to_string())?;
    if intent.operation_id != expected_operation_id {
        return Err("Managed update recovery discard authorization is stale".to_string());
    }
    intent.phase = UpdateActivationPhase::Discarding;
    publish_intent(&discard_path, &intent)?;
    Ok(intent)
}

fn remove_owned_directory(path: &Path, label: &str) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => {
            fs::remove_dir_all(path)
                .map_err(|error| format!("Cannot remove managed update {label}: {error}"))?;
            Ok(true)
        }
        Ok(_) => Err(format!("Managed update {label} path is not a directory")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Cannot inspect managed update {label}: {error}")),
    }
}

pub(crate) fn resume_post_commit_discard(
    app_data_dir: &Path,
    current_executable: &Path,
) -> Result<bool, String> {
    if read_pending_intent(app_data_dir)?.is_some() {
        return Err("Managed update recovery discard conflicts with an activation".to_string());
    }
    let discard_path = discard_intent_path(app_data_dir);
    let intent = match fs::symlink_metadata(&discard_path) {
        Ok(_) => read_intent_file(&discard_path)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "Cannot inspect managed update recovery discard: {error}"
            ));
        }
    };
    if intent.phase != UpdateActivationPhase::Discarding
        || file_sha256(current_executable)? != intent.candidate_main_sha256
        || intent.to_version != env!("CARGO_PKG_VERSION")
    {
        return Err("Managed update recovery discard identity does not match".to_string());
    }
    let committed = finalized_intent_path(app_data_dir, &intent, "committed");
    if committed.exists()
        && read_intent_file(&committed)? != {
            let mut expected = intent.clone();
            expected.phase = UpdateActivationPhase::Committed;
            expected
        }
    {
        return Err("Managed update committed recovery changed during discard".to_string());
    }
    let (current_app, _) = current_app_identity(current_executable)?;
    let displaced = displaced_app_path(&current_app, &intent.operation_id)?;
    if remove_owned_directory(&displaced, "displaced rollback app")? {
        sync_directory(
            current_app
                .parent()
                .ok_or_else(|| "Current app bundle has no parent directory".to_string())?,
        )?;
    }
    let root = recovery_root(app_data_dir);
    if remove_owned_directory(
        &operation_path(app_data_dir, &intent.operation_id),
        "recovery unit",
    )? {
        sync_directory(&root)?;
    }
    match fs::remove_file(&committed) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Cannot remove managed update committed recovery: {error}"
            ));
        }
    }
    fs::remove_file(&discard_path)
        .map_err(|error| format!("Cannot finish managed update recovery discard: {error}"))?;
    sync_directory(&root)?;
    Ok(true)
}

fn atomic_swap(left: &Path, right: &Path) -> Result<(), String> {
    let left = CString::new(left.as_os_str().as_bytes())
        .map_err(|_| "Managed update app path contains a null byte".to_string())?;
    let right = CString::new(right.as_os_str().as_bytes())
        .map_err(|_| "Managed update app path contains a null byte".to_string())?;
    // SAFETY: both C strings live for the duration of the call and point to existing paths.
    let result = unsafe {
        libc::renameatx_np(
            libc::AT_FDCWD,
            left.as_ptr(),
            libc::AT_FDCWD,
            right.as_ptr(),
            libc::RENAME_SWAP,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(format!(
            "Cannot atomically exchange managed update app bundles: {}",
            std::io::Error::last_os_error()
        ))
    }
}

pub(crate) fn activate_candidate_bundle(
    app_data_dir: &Path,
    current_executable: &Path,
    candidate_app: &Path,
    candidate_executable: &Path,
    intent: &UpdateActivationIntent,
) -> Result<UpdateActivationIntent, String> {
    if intent.phase != UpdateActivationPhase::Prepared {
        return Err("Managed update activation is not in prepared state".to_string());
    }
    verify_recovery_unit(app_data_dir, intent)?;
    if file_sha256(current_executable)? != intent.current_main_sha256
        || file_sha256(candidate_executable)? != intent.candidate_main_sha256
    {
        return Err("Managed update executable identity changed before activation".to_string());
    }
    let (current_app, current_relative) = current_app_identity(current_executable)?;
    if current_relative != intent.current_executable_relative_path {
        return Err("Managed update current executable binding changed".to_string());
    }
    let candidate_relative = candidate_executable
        .strip_prefix(candidate_app)
        .map_err(|_| "Candidate executable is outside its app bundle".to_string())?;
    let candidate_relative = validate_relative_executable(candidate_relative)?;
    if candidate_relative != current_relative {
        return Err("Candidate executable path does not match the current app".to_string());
    }
    verify_app_signature(candidate_app)?;
    let displaced = displaced_app_path(&current_app, &intent.operation_id)?;
    if fs::symlink_metadata(&displaced).is_ok() {
        return Err("Managed update displaced-app path is already occupied".to_string());
    }
    copy_rollback_app(candidate_app, &displaced)?;
    let copied_candidate_executable = displaced.join(&candidate_relative);
    if file_sha256(&copied_candidate_executable)? != intent.candidate_main_sha256 {
        let _ = fs::remove_dir_all(&displaced);
        return Err("Copied managed update candidate digest does not match".to_string());
    }

    let mut installing = intent.clone();
    installing.phase = UpdateActivationPhase::Installing;
    replace_intent(app_data_dir, &installing)?;
    if let Err(error) = atomic_swap(&current_app, &displaced) {
        let _ = fs::remove_dir_all(&displaced);
        let _ = replace_intent(app_data_dir, intent);
        return Err(error);
    }
    let activated = file_sha256(&current_app.join(&candidate_relative))
        .map(|digest| digest == intent.candidate_main_sha256)
        .unwrap_or(false);
    if !activated {
        let restored = atomic_swap(&current_app, &displaced);
        if restored.is_ok() {
            let _ = replace_intent(app_data_dir, intent);
            let _ = fs::remove_dir_all(&displaced);
        }
        return Err(if restored.is_ok() {
            "Managed update activation identity failed and the current app was restored".to_string()
        } else {
            "Managed update activation identity failed and app rollback failed".to_string()
        });
    }
    let mut installed = installing;
    installed.phase = UpdateActivationPhase::Installed;
    replace_intent(app_data_dir, &installed)?;
    Ok(installed)
}

fn finalize_intent(
    app_data_dir: &Path,
    intent: &UpdateActivationIntent,
    label: &str,
) -> Result<(), String> {
    replace_intent(app_data_dir, intent)?;
    let pending = intent_path(app_data_dir);
    let destination = finalized_intent_path(app_data_dir, intent, label);
    match fs::hard_link(&pending, &destination) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            if file_sha256(&pending)? != file_sha256(&destination)? {
                return Err("Managed update final status conflicts with existing state".to_string());
            }
        }
        Err(error) => {
            return Err(format!(
                "Cannot publish managed update final status: {error}"
            ));
        }
    }
    fs::remove_file(&pending)
        .map_err(|error| format!("Cannot consume managed update activation intent: {error}"))?;
    sync_directory(&recovery_root(app_data_dir))
}

pub(crate) fn reconcile_update_before_host_open(
    app_data_dir: &Path,
    current_executable: &Path,
) -> Result<UpdateStartupDisposition, String> {
    let Some(intent) = read_pending_intent(app_data_dir)? else {
        return Ok(UpdateStartupDisposition::None);
    };
    verify_recovery_unit(app_data_dir, &intent)?;
    let observed = file_sha256(current_executable)?;
    match intent.phase {
        UpdateActivationPhase::Prepared if observed == intent.current_main_sha256 => {
            cancel_prepared_recovery_unit(app_data_dir, &intent.candidate_token)?;
            Ok(UpdateStartupDisposition::None)
        }
        UpdateActivationPhase::Installing if observed == intent.current_main_sha256 => {
            let (current_app, _) = current_app_identity(current_executable)?;
            let displaced = displaced_app_path(&current_app, &intent.operation_id)?;
            if displaced.exists() {
                fs::remove_dir_all(&displaced).map_err(|error| {
                    format!("Cannot discard unactivated managed update candidate: {error}")
                })?;
            }
            cancel_prepared_recovery_unit(app_data_dir, &intent.candidate_token)?;
            Ok(UpdateStartupDisposition::None)
        }
        UpdateActivationPhase::Installing | UpdateActivationPhase::Installed
            if observed == intent.candidate_main_sha256 =>
        {
            Ok(UpdateStartupDisposition::ValidateCandidate(Box::new(
                intent,
            )))
        }
        UpdateActivationPhase::Committed if observed == intent.candidate_main_sha256 => {
            finalize_intent(app_data_dir, &intent, "committed")?;
            Ok(UpdateStartupDisposition::None)
        }
        UpdateActivationPhase::RollingBack if observed == intent.candidate_main_sha256 => {
            Ok(UpdateStartupDisposition::ResumeRollback(Box::new(intent)))
        }
        UpdateActivationPhase::RollingBack if observed == intent.current_main_sha256 => {
            let mut rolled_back = intent;
            rolled_back.phase = UpdateActivationPhase::RolledBack;
            finalize_intent(app_data_dir, &rolled_back, "rolled-back")?;
            Ok(UpdateStartupDisposition::RolledBack)
        }
        UpdateActivationPhase::RolledBack if observed == intent.current_main_sha256 => {
            finalize_intent(app_data_dir, &intent, "rolled-back")?;
            Ok(UpdateStartupDisposition::RolledBack)
        }
        _ => Err(
            "Managed update startup executable does not match its activation intent".to_string(),
        ),
    }
}

pub(crate) fn reconcile_managed_update_before_host_open(
    app_data_dir: &Path,
    current_executable: &Path,
) -> Result<UpdateStartupDisposition, String> {
    let disposition = reconcile_update_before_host_open(app_data_dir, current_executable)?;
    if matches!(
        &disposition,
        UpdateStartupDisposition::None | UpdateStartupDisposition::RolledBack
    ) {
        resume_post_commit_discard(app_data_dir, current_executable)?;
    }
    Ok(disposition)
}

pub(crate) fn commit_candidate_startup(
    app_data_dir: &Path,
    current_executable: &Path,
    mut intent: UpdateActivationIntent,
) -> Result<UpdateActivationIntent, String> {
    if !matches!(
        intent.phase,
        UpdateActivationPhase::Installing | UpdateActivationPhase::Installed
    ) || file_sha256(current_executable)? != intent.candidate_main_sha256
        || env!("CARGO_PKG_VERSION") != intent.to_version
    {
        return Err("Managed update candidate startup identity does not match".to_string());
    }
    verify_recovery_unit(app_data_dir, &intent)?;
    verify_displaced_rollback_app(current_executable, &intent)?;
    intent.phase = UpdateActivationPhase::Committed;
    finalize_intent(app_data_dir, &intent, "committed")?;
    Ok(intent)
}

fn database_sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn host_restore_marker(operation: &Path) -> PathBuf {
    operation.join("host-snapshot-restored")
}

fn publish_host_restore_marker(
    operation: &Path,
    intent: &UpdateActivationIntent,
) -> Result<(), String> {
    let marker = host_restore_marker(operation);
    match fs::read(&marker) {
        Ok(value) if value == intent.host_snapshot_sha256.as_bytes() => return Ok(()),
        Ok(_) => return Err("Managed update Host restore marker conflicts".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Cannot inspect managed update Host restore marker: {error}"
            ));
        }
    }
    write_private_file(
        &marker,
        intent.host_snapshot_sha256.as_bytes(),
        "Host restore marker",
    )?;
    sync_directory(operation)
}

fn restore_host_snapshot(
    app_data_dir: &Path,
    intent: &UpdateActivationIntent,
) -> Result<(), String> {
    let operation = operation_path(app_data_dir, &intent.operation_id);
    let snapshot = operation.join("farfold-host.sqlite3");
    if file_sha256(&snapshot)? != intent.host_snapshot_sha256 {
        return Err("Managed update rollback Host snapshot digest does not match".to_string());
    }
    let source = Connection::open_with_flags(&snapshot, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Cannot open update rollback Host snapshot: {error}"))?;
    let integrity = source
        .query_row("PRAGMA quick_check(1)", [], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Cannot verify update rollback Host snapshot: {error}"))?;
    let schema = source
        .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
        .map_err(|error| format!("Cannot read update rollback Host schema: {error}"))?;
    if integrity != "ok" || u64::try_from(schema).ok() != Some(intent.current_host_schema_version) {
        return Err("Managed update rollback Host snapshot is incompatible".to_string());
    }
    drop(source);
    let live = app_data_dir.join("farfold-host.sqlite3");
    let marker = host_restore_marker(&operation);
    if marker.exists() {
        if fs::read(&marker)
            .map_err(|error| format!("Cannot read managed update Host restore marker: {error}"))?
            != intent.host_snapshot_sha256.as_bytes()
            || file_sha256(&live)? != intent.host_snapshot_sha256
        {
            return Err("Managed update restored Host identity does not match".to_string());
        }
        return Ok(());
    }
    let failed_live = operation.join("failed-host.sqlite3");
    if failed_live.exists() && live.exists() && file_sha256(&live)? == intent.host_snapshot_sha256 {
        publish_host_restore_marker(&operation, intent)?;
        return Ok(());
    }
    let temporary = app_data_dir.join(format!(
        ".farfold-host.update-restore-{}.incomplete",
        intent.operation_id
    ));
    if !temporary.exists() {
        let mut input = fs::File::open(&snapshot)
            .map_err(|error| format!("Cannot open update rollback Host snapshot: {error}"))?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|error| format!("Cannot reserve update rollback Host restore: {error}"))?;
        std::io::copy(&mut input, &mut output)
            .map_err(|error| format!("Cannot copy update rollback Host snapshot: {error}"))?;
        output
            .sync_all()
            .map_err(|error| format!("Cannot sync update rollback Host snapshot: {error}"))?;
    }
    if file_sha256(&temporary)? != intent.host_snapshot_sha256 {
        let _ = fs::remove_file(&temporary);
        return Err("Copied update rollback Host snapshot digest does not match".to_string());
    }

    let mut moved = Vec::new();
    for suffix in ["", "-wal", "-shm"] {
        let source = if suffix.is_empty() {
            live.clone()
        } else {
            database_sidecar(&live, suffix)
        };
        let destination = operation.join(format!("failed-host.sqlite3{suffix}"));
        match (source.exists(), destination.exists()) {
            (true, false) => {
                if let Err(error) = fs::rename(&source, &destination) {
                    for (restore_source, restore_destination) in moved.iter().rev() {
                        let _ = fs::rename(restore_source, restore_destination);
                    }
                    return Err(format!(
                        "Cannot archive failed update Host database: {error}"
                    ));
                }
                moved.push((destination, source));
            }
            (true, true) => {
                let _ = fs::remove_file(&temporary);
                return Err("Managed update failed-Host archive is already occupied".to_string());
            }
            (false, true) | (false, false) => {}
        }
    }
    if let Err(error) = fs::rename(&temporary, &live) {
        for (restore_source, restore_destination) in moved.iter().rev() {
            let _ = fs::rename(restore_source, restore_destination);
        }
        let _ = fs::remove_file(&temporary);
        return Err(format!("Cannot restore pre-update Host snapshot: {error}"));
    }
    sync_directory(app_data_dir)?;
    publish_host_restore_marker(&operation, intent)
}

pub(crate) fn rollback_candidate_startup(
    app_data_dir: &Path,
    current_executable: &Path,
    database_path: &Path,
    mut intent: UpdateActivationIntent,
) -> Result<UpdateActivationIntent, String> {
    if !matches!(
        intent.phase,
        UpdateActivationPhase::Installing
            | UpdateActivationPhase::Installed
            | UpdateActivationPhase::RollingBack
    ) || file_sha256(current_executable)? != intent.candidate_main_sha256
    {
        return Err("Managed update rollback candidate identity does not match".to_string());
    }
    if database_path != app_data_dir.join("farfold-host.sqlite3") {
        return Err("Managed update rollback Host path does not match".to_string());
    }
    verify_recovery_unit(app_data_dir, &intent)?;
    if intent.phase != UpdateActivationPhase::RollingBack {
        intent.phase = UpdateActivationPhase::RollingBack;
        replace_intent(app_data_dir, &intent)?;
    }
    restore_host_snapshot(app_data_dir, &intent)?;
    let (current_app, relative) = current_app_identity(current_executable)?;
    let displaced = displaced_app_path(&current_app, &intent.operation_id)?;
    verify_app_signature(&displaced)?;
    if file_sha256(&displaced.join(relative))? != intent.current_main_sha256 {
        return Err("Managed update displaced rollback app digest does not match".to_string());
    }
    atomic_swap(&current_app, &displaced)?;
    if file_sha256(current_executable)? != intent.current_main_sha256 {
        let _ = atomic_swap(&current_app, &displaced);
        return Err("Managed update app rollback identity failed".to_string());
    }
    intent.phase = UpdateActivationPhase::RolledBack;
    replace_intent(app_data_dir, &intent)?;
    Ok(intent)
}

pub(crate) fn prepare_update_recovery_unit(
    store: &HostStore,
    input: PrepareUpdateRecoveryInput<'_>,
) -> Result<UpdateActivationIntent, String> {
    if !valid_token(input.candidate_token)
        || !valid_token(input.candidate_main_sha256)
        || !valid_identity(input.from_version, 128)
        || !valid_identity(input.to_version, 128)
        || !valid_identity(input.bundle_id, 255)
        || input.current_host_schema_version == 0
        || input.candidate_host_schema_version == 0
    {
        return Err("Managed update recovery input is invalid".to_string());
    }
    if let Some(existing) = read_pending_intent(input.app_data_dir)? {
        if existing.candidate_token == input.candidate_token {
            verify_recovery_unit(input.app_data_dir, &existing)?;
            if file_sha256(input.current_executable)? != existing.current_main_sha256 {
                return Err("Current app changed after update recovery was prepared".to_string());
            }
            return Ok(existing);
        }
        return Err("A different managed update activation is already pending".to_string());
    }
    let (current_app, relative_executable) = current_app_identity(input.current_executable)?;
    verify_app_signature(&current_app)?;
    prepare_private_directory(input.app_data_dir)?;
    let root = recovery_root(input.app_data_dir);
    prepare_private_directory(&root)?;
    let operation_id = format!(
        "{}-{}-{}",
        std::process::id(),
        crate::host_store::now_millis(),
        OPERATION_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let operation = operation_path(input.app_data_dir, &operation_id);
    prepare_private_directory(&operation)?;
    sync_directory(&root)?;
    let rollback_app = operation.join("rollback.app");
    let host_snapshot = operation.join("farfold-host.sqlite3");
    let artifact_path = operation.join("candidate.app.tar.gz");

    let prepared = (|| -> Result<UpdateActivationIntent, String> {
        copy_rollback_app(&current_app, &rollback_app)?;
        let rollback_executable = rollback_app.join(&relative_executable);
        let current_main_sha256 = file_sha256(input.current_executable)?;
        if file_sha256(&rollback_executable)? != current_main_sha256 {
            return Err("Rollback app executable digest does not match current app".to_string());
        }
        store.create_consistent_snapshot_for_maintenance(&host_snapshot, input.candidate_token)?;
        write_private_file(&artifact_path, input.artifact, "candidate artifact")?;
        let intent = UpdateActivationIntent {
            format_version: INTENT_VERSION,
            operation_id,
            candidate_token: input.candidate_token.to_string(),
            from_version: input.from_version.to_string(),
            to_version: input.to_version.to_string(),
            bundle_id: input.bundle_id.to_string(),
            current_main_sha256,
            candidate_main_sha256: input.candidate_main_sha256.to_string(),
            artifact_sha256: file_sha256(&artifact_path)?,
            host_snapshot_sha256: file_sha256(&host_snapshot)?,
            current_host_schema_version: input.current_host_schema_version,
            candidate_host_schema_version: input.candidate_host_schema_version,
            current_executable_relative_path: relative_executable,
            phase: UpdateActivationPhase::Prepared,
        };
        if intent.artifact_sha256 != sha256_bytes(input.artifact) {
            return Err("Persisted managed update artifact digest does not match".to_string());
        }
        validate_intent(&intent)?;
        sync_directory(&operation)?;
        publish_intent(&intent_path(input.app_data_dir), &intent)?;
        Ok(intent)
    })();
    if prepared.is_err() {
        let _ = fs::remove_dir_all(&operation);
        let _ = sync_directory(&root);
    }
    prepared
}

pub(crate) fn cancel_prepared_recovery_unit(
    app_data_dir: &Path,
    expected_candidate_token: &str,
) -> Result<bool, String> {
    let Some(intent) = read_pending_intent(app_data_dir)? else {
        return Ok(false);
    };
    if intent.candidate_token != expected_candidate_token {
        return Err("Managed update cancellation authorization is stale".to_string());
    }
    let pending = intent_path(app_data_dir);
    fs::remove_file(&pending)
        .map_err(|error| format!("Cannot cancel managed update activation intent: {error}"))?;
    let root = recovery_root(app_data_dir);
    sync_directory(&root)?;
    let operation = operation_path(app_data_dir, &intent.operation_id);
    fs::remove_dir_all(&operation).map_err(|error| {
        format!("Cannot remove cancelled managed update recovery unit: {error}")
    })?;
    sync_directory(&root)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::{
        PrepareUpdateRecoveryInput, UpdateActivationPhase, UpdateStartupDisposition,
        activate_candidate_bundle, cancel_prepared_recovery_unit, commit_candidate_startup,
        current_committed_recovery, displaced_app_path, finalized_intent_path, intent_path,
        operation_path, prepare_update_recovery_unit, read_pending_intent,
        reconcile_managed_update_before_host_open, request_post_commit_discard,
        request_post_commit_rollback, restore_host_snapshot, resume_post_commit_discard,
        rollback_candidate_startup,
    };
    use crate::host_store::HostStore;
    use crate::runtime_registry::file_sha256;
    use rusqlite::Connection;
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        path::{Path, PathBuf},
        process::Command,
        sync::atomic::{AtomicU64, Ordering},
    };

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "farfold-update-recovery-test-{}-{}",
                std::process::id(),
                TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn signed_app(root: &Path, name: &str, executable_source: &str) -> PathBuf {
        let app = root.join(name);
        fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        fs::write(
            app.join("Contents/Info.plist"),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>ai.farfold.test</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>CFBundleExecutable</key><string>farfold</string>
</dict></plist>"#,
        )
        .unwrap();
        fs::copy(executable_source, app.join("Contents/MacOS/farfold")).unwrap();
        let output = Command::new("/usr/bin/codesign")
            .args(["--force", "--deep", "--sign", "-"])
            .arg(&app)
            .output()
            .unwrap();
        assert!(output.status.success());
        app
    }

    #[test]
    fn recovery_unit_is_private_atomic_idempotent_and_bound_to_one_candidate() {
        let directory = TestDirectory::new();
        let app = signed_app(&directory.0, "Current.app", "/usr/bin/true");
        let app_data = directory.0.join("profile");
        fs::create_dir(&app_data).unwrap();
        let store = HostStore::open(app_data.join("farfold-host.sqlite3"));
        let artifact = b"signed candidate bytes";
        store.begin_maintenance(&"a".repeat(64)).unwrap();
        let input = PrepareUpdateRecoveryInput {
            app_data_dir: &app_data,
            current_executable: &app.join("Contents/MacOS/farfold"),
            artifact,
            candidate_token: &"a".repeat(64),
            from_version: "1.0.0",
            to_version: "2.0.0",
            bundle_id: "ai.farfold.test",
            candidate_main_sha256: &"b".repeat(64),
            current_host_schema_version: 7,
            candidate_host_schema_version: 8,
        };
        let intent = prepare_update_recovery_unit(&store, input).unwrap();
        assert_eq!(
            read_pending_intent(&app_data).unwrap().as_ref(),
            Some(&intent)
        );
        let operation = operation_path(&app_data, &intent.operation_id);
        for path in [
            intent_path(&app_data),
            operation.join("candidate.app.tar.gz"),
            operation.join("farfold-host.sqlite3"),
        ] {
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert!(operation.join("rollback.app").is_dir());

        let repeated = prepare_update_recovery_unit(
            &store,
            PrepareUpdateRecoveryInput {
                app_data_dir: &app_data,
                current_executable: &app.join("Contents/MacOS/farfold"),
                artifact,
                candidate_token: &"a".repeat(64),
                from_version: "1.0.0",
                to_version: "2.0.0",
                bundle_id: "ai.farfold.test",
                candidate_main_sha256: &"b".repeat(64),
                current_host_schema_version: 7,
                candidate_host_schema_version: 8,
            },
        )
        .unwrap();
        assert_eq!(repeated, intent);
        assert!(
            prepare_update_recovery_unit(
                &store,
                PrepareUpdateRecoveryInput {
                    app_data_dir: &app_data,
                    current_executable: &app.join("Contents/MacOS/farfold"),
                    artifact,
                    candidate_token: &"c".repeat(64),
                    from_version: "1.0.0",
                    to_version: "2.0.0",
                    bundle_id: "ai.farfold.test",
                    candidate_main_sha256: &"b".repeat(64),
                    current_host_schema_version: 7,
                    candidate_host_schema_version: 8,
                },
            )
            .is_err()
        );
        fs::write(operation.join("candidate.app.tar.gz"), b"tampered").unwrap();
        assert!(
            prepare_update_recovery_unit(
                &store,
                PrepareUpdateRecoveryInput {
                    app_data_dir: &app_data,
                    current_executable: &app.join("Contents/MacOS/farfold"),
                    artifact,
                    candidate_token: &"a".repeat(64),
                    from_version: "1.0.0",
                    to_version: "2.0.0",
                    bundle_id: "ai.farfold.test",
                    candidate_main_sha256: &"b".repeat(64),
                    current_host_schema_version: 7,
                    candidate_host_schema_version: 8,
                },
            )
            .is_err()
        );
        assert!(cancel_prepared_recovery_unit(&app_data, &"c".repeat(64)).is_err());
        assert!(cancel_prepared_recovery_unit(&app_data, &"a".repeat(64)).unwrap());
        store.end_maintenance(&"a".repeat(64)).unwrap();
        assert!(read_pending_intent(&app_data).unwrap().is_none());
        assert!(!operation.exists());

        store.begin_maintenance(&"a".repeat(64)).unwrap();
        let interrupted = prepare_update_recovery_unit(
            &store,
            PrepareUpdateRecoveryInput {
                app_data_dir: &app_data,
                current_executable: &app.join("Contents/MacOS/farfold"),
                artifact,
                candidate_token: &"a".repeat(64),
                from_version: "1.0.0",
                to_version: "2.0.0",
                bundle_id: "ai.farfold.test",
                candidate_main_sha256: &"b".repeat(64),
                current_host_schema_version: 7,
                candidate_host_schema_version: 8,
            },
        )
        .unwrap();
        let interrupted_operation = operation_path(&app_data, &interrupted.operation_id);
        assert!(matches!(
            reconcile_managed_update_before_host_open(
                &app_data,
                &app.join("Contents/MacOS/farfold")
            )
            .unwrap(),
            UpdateStartupDisposition::None
        ));
        store.end_maintenance(&"a".repeat(64)).unwrap();
        assert!(read_pending_intent(&app_data).unwrap().is_none());
        assert!(!interrupted_operation.exists());
    }

    #[test]
    fn candidate_activation_atomically_exchanges_complete_app_bundles() {
        let directory = TestDirectory::new();
        let current = signed_app(&directory.0, "Current.app", "/usr/bin/true");
        let candidate = signed_app(&directory.0, "Candidate.app", "/bin/echo");
        let current_executable = current.join("Contents/MacOS/farfold");
        let candidate_executable = candidate.join("Contents/MacOS/farfold");
        let candidate_sha256 = file_sha256(&candidate_executable).unwrap();
        let current_sha256 = file_sha256(&current_executable).unwrap();
        assert_ne!(candidate_sha256, current_sha256);
        let app_data = directory.0.join("profile");
        fs::create_dir(&app_data).unwrap();
        let store = HostStore::open(app_data.join("farfold-host.sqlite3"));
        let token = "d".repeat(64);
        store.begin_maintenance(&token).unwrap();
        let intent = prepare_update_recovery_unit(
            &store,
            PrepareUpdateRecoveryInput {
                app_data_dir: &app_data,
                current_executable: &current_executable,
                artifact: b"signed candidate bytes",
                candidate_token: &token,
                from_version: "1.0.0",
                to_version: "2.0.0",
                bundle_id: "ai.farfold.test",
                candidate_main_sha256: &candidate_sha256,
                current_host_schema_version: 7,
                candidate_host_schema_version: 8,
            },
        )
        .unwrap();
        let installed = activate_candidate_bundle(
            &app_data,
            &current_executable,
            &candidate,
            &candidate_executable,
            &intent,
        )
        .unwrap();
        assert_eq!(installed.phase, UpdateActivationPhase::Installed);
        assert!(matches!(
            reconcile_managed_update_before_host_open(&app_data, &current_executable).unwrap(),
            UpdateStartupDisposition::ValidateCandidate(intent) if *intent == installed
        ));
        assert_eq!(file_sha256(&current_executable).unwrap(), candidate_sha256);
        let displaced = displaced_app_path(&current, &intent.operation_id).unwrap();
        assert_eq!(
            file_sha256(&displaced.join("Contents/MacOS/farfold")).unwrap(),
            current_sha256
        );
        assert_eq!(
            read_pending_intent(&app_data).unwrap().unwrap().phase,
            UpdateActivationPhase::Installed
        );
        drop(store);
        let database_path = app_data.join("farfold-host.sqlite3");
        Connection::open(&database_path)
            .unwrap()
            .pragma_update(None, "user_version", 999_i64)
            .unwrap();
        let mut interrupted_rollback = installed;
        interrupted_rollback.phase = UpdateActivationPhase::RollingBack;
        super::replace_intent(&app_data, &interrupted_rollback).unwrap();
        restore_host_snapshot(&app_data, &interrupted_rollback).unwrap();
        let resumed = match reconcile_managed_update_before_host_open(
            &app_data,
            &current_executable,
        )
        .unwrap()
        {
            UpdateStartupDisposition::ResumeRollback(intent) => *intent,
            disposition => panic!("unexpected update startup disposition: {disposition:?}"),
        };
        let rolled_back =
            rollback_candidate_startup(&app_data, &current_executable, &database_path, resumed)
                .unwrap();
        assert_eq!(rolled_back.phase, UpdateActivationPhase::RolledBack);
        assert_eq!(file_sha256(&current_executable).unwrap(), current_sha256);
        assert_eq!(
            Connection::open(&database_path)
                .unwrap()
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            7_i64
        );
        assert!(matches!(
            reconcile_managed_update_before_host_open(&app_data, &current_executable).unwrap(),
            UpdateStartupDisposition::RolledBack
        ));
        assert!(read_pending_intent(&app_data).unwrap().is_none());
    }

    #[test]
    fn validated_candidate_commit_is_durable_and_crash_idempotent() {
        let directory = TestDirectory::new();
        let current = signed_app(&directory.0, "Current.app", "/usr/bin/true");
        let candidate = signed_app(&directory.0, "Candidate.app", "/bin/echo");
        let current_executable = current.join("Contents/MacOS/farfold");
        let candidate_executable = candidate.join("Contents/MacOS/farfold");
        let candidate_sha256 = file_sha256(&candidate_executable).unwrap();
        let app_data = directory.0.join("profile");
        fs::create_dir(&app_data).unwrap();
        let store = HostStore::open(app_data.join("farfold-host.sqlite3"));
        let token = "e".repeat(64);
        store.begin_maintenance(&token).unwrap();
        let intent = prepare_update_recovery_unit(
            &store,
            PrepareUpdateRecoveryInput {
                app_data_dir: &app_data,
                current_executable: &current_executable,
                artifact: b"signed candidate bytes",
                candidate_token: &token,
                from_version: "0.0.1",
                to_version: env!("CARGO_PKG_VERSION"),
                bundle_id: "ai.farfold.test",
                candidate_main_sha256: &candidate_sha256,
                current_host_schema_version: 7,
                candidate_host_schema_version: 7,
            },
        )
        .unwrap();
        let installed = activate_candidate_bundle(
            &app_data,
            &current_executable,
            &candidate,
            &candidate_executable,
            &intent,
        )
        .unwrap();
        let committed =
            commit_candidate_startup(&app_data, &current_executable, installed).unwrap();
        assert_eq!(committed.phase, UpdateActivationPhase::Committed);
        assert!(read_pending_intent(&app_data).unwrap().is_none());
        let committed_path = finalized_intent_path(&app_data, &committed, "committed");
        assert!(committed_path.is_file());
        let displaced = displaced_app_path(&current, &committed.operation_id).unwrap();
        assert!(displaced.is_dir());

        super::replace_intent(&app_data, &committed).unwrap();
        assert!(matches!(
            reconcile_managed_update_before_host_open(&app_data, &current_executable).unwrap(),
            UpdateStartupDisposition::None
        ));
        assert!(read_pending_intent(&app_data).unwrap().is_none());
        assert_eq!(
            current_committed_recovery(&app_data, &current_executable)
                .unwrap()
                .as_ref(),
            Some(&committed)
        );
        // A prior rollback of this exact executable must not shadow a later retry.
        let mut previous = committed.clone();
        previous.operation_id = "1-1-0".to_string();
        let previous_committed = finalized_intent_path(&app_data, &previous, "committed");
        super::publish_intent(&previous_committed, &previous).unwrap();
        previous.phase = UpdateActivationPhase::RolledBack;
        let previous_rolled_back = finalized_intent_path(&app_data, &previous, "rolled-back");
        super::publish_intent(&previous_rolled_back, &previous).unwrap();
        assert_eq!(
            current_committed_recovery(&app_data, &current_executable).unwrap(),
            Some(committed.clone())
        );
        previous.host_snapshot_sha256 = "f".repeat(64);
        fs::write(
            &previous_rolled_back,
            serde_json::to_vec(&previous).unwrap(),
        )
        .unwrap();
        assert!(current_committed_recovery(&app_data, &current_executable).is_err());
        previous.host_snapshot_sha256 = committed.host_snapshot_sha256.clone();
        fs::write(
            &previous_rolled_back,
            serde_json::to_vec(&previous).unwrap(),
        )
        .unwrap();
        fs::write(&committed_path, b"tampered").unwrap();
        assert!(current_committed_recovery(&app_data, &current_executable).is_err());
        fs::write(&committed_path, serde_json::to_vec(&committed).unwrap()).unwrap();
        assert!(
            request_post_commit_rollback(&app_data, &current_executable, "stale-operation")
                .is_err()
        );
        let requested =
            request_post_commit_rollback(&app_data, &current_executable, &committed.operation_id)
                .unwrap();
        assert_eq!(requested.phase, UpdateActivationPhase::RollingBack);
        assert!(matches!(
            reconcile_managed_update_before_host_open(&app_data, &current_executable).unwrap(),
            UpdateStartupDisposition::ResumeRollback(intent) if *intent == requested
        ));
        fs::remove_file(intent_path(&app_data)).unwrap();
        assert!(
            request_post_commit_discard(&app_data, &current_executable, "stale-operation").is_err()
        );
        let discard =
            request_post_commit_discard(&app_data, &current_executable, &committed.operation_id)
                .unwrap();
        assert_eq!(discard.phase, UpdateActivationPhase::Discarding);
        assert!(resume_post_commit_discard(&app_data, &current_executable).unwrap());
        assert!(!resume_post_commit_discard(&app_data, &current_executable).unwrap());
        assert!(
            current_committed_recovery(&app_data, &current_executable)
                .unwrap()
                .is_none()
        );
        assert!(!displaced.exists());
        assert!(!operation_path(&app_data, &committed.operation_id).exists());
    }
}
