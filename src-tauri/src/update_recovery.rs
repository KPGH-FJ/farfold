use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fmt::Write as _,
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Component, Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

use crate::{host_store::HostStore, runtime_registry::file_sha256};

const INTENT_VERSION: u32 = 1;
const RECOVERY_DIRECTORY: &str = "managed-update-recovery";
const PENDING_INTENT: &str = "pending-activation.json";
const MAX_INTENT_BYTES: u64 = 16 * 1024;
const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
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
    let temporary = parent.join(format!(".{PENDING_INTENT}.incomplete"));
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

pub(crate) fn read_pending_intent(
    app_data_dir: &Path,
) -> Result<Option<UpdateActivationIntent>, String> {
    let path = intent_path(app_data_dir);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot inspect managed update intent: {error}")),
    };
    if !metadata.file_type().is_file() || metadata.len() == 0 || metadata.len() > MAX_INTENT_BYTES {
        return Err("Managed update activation intent is invalid".to_string());
    }
    let mut encoded = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(&path)
        .and_then(|mut file| file.read_to_end(&mut encoded))
        .map_err(|error| format!("Cannot read managed update activation intent: {error}"))?;
    let intent: UpdateActivationIntent = serde_json::from_slice(&encoded)
        .map_err(|_| "Managed update activation intent is invalid".to_string())?;
    validate_intent(&intent)?;
    Ok(Some(intent))
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
        PrepareUpdateRecoveryInput, cancel_prepared_recovery_unit, intent_path, operation_path,
        prepare_update_recovery_unit, read_pending_intent,
    };
    use crate::host_store::HostStore;
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

    fn signed_app(root: &Path) -> PathBuf {
        let app = root.join("Current.app");
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
        fs::copy("/usr/bin/true", app.join("Contents/MacOS/farfold")).unwrap();
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
        let app = signed_app(&directory.0);
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
    }
}
