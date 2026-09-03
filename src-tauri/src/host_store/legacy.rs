use serde::{Deserialize, Serialize, de::IgnoredAny};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fmt::Write as _,
    fs,
    path::{Path, PathBuf},
};

use crate::{
    host_store::{HostDatabase, HostStore, now_millis},
    runtime_registry::{
        OPENCODE_RUNTIME_ADAPTER_ID, OPENCODE_RUNTIME_CONNECTION_ID,
        OPENCODE_RUNTIME_INSTALLATION_ID, OPENCODE_RUNTIME_PRODUCT_ID, PI_RUNTIME,
    },
};
use rusqlite::{OptionalExtension, TransactionBehavior, params};

const MAX_LEGACY_STORE_BYTES: u64 = 8 * 1024 * 1024;
const PI_POINTER_FILE: &str = "last-pi-session.json";
const OPENCODE_BINDINGS_FILE: &str = "opencode-session-bindings.json";
const LIFEMODEL_FILE: &str = "lifemodel.json";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LegacySourceKind {
    PiSessionPointer,
    OpenCodeBindings,
    LifeModel,
}

impl LegacySourceKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::PiSessionPointer => "pi_session_pointer",
            Self::OpenCodeBindings => "opencode_bindings",
            Self::LifeModel => "lifemodel",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LegacyPreviewDisposition {
    Missing,
    RequiresRuntimeValidation,
    DeferredToP8,
    Blocked,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyStorePreview {
    source_kind: LegacySourceKind,
    source_path: String,
    source_sha256: Option<String>,
    record_count: usize,
    disposition: LegacyPreviewDisposition,
    issue_codes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationPreview {
    profile_path: String,
    sources: Vec<LegacyStorePreview>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPiPointer {
    project_path: PathBuf,
    session_file: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyRuntimeIdentity {
    product_id: String,
    installation_id: String,
    adapter_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyOpenCodeBinding {
    runtime: LegacyRuntimeIdentity,
    connection_id: String,
    native_session_id: String,
    project_path: PathBuf,
    title: String,
    created_at: u64,
    updated_at: u64,
}

#[derive(Debug, Deserialize)]
struct LegacyOpenCodeBindingStore {
    version: u32,
    bindings: Vec<LegacyOpenCodeBinding>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyLifeModelStore {
    version: u32,
    #[serde(default)]
    proposals: Vec<IgnoredAny>,
    #[serde(default)]
    items: Vec<IgnoredAny>,
    #[serde(default)]
    source_withdrawals: Vec<IgnoredAny>,
    #[serde(default)]
    injection_manifests: Vec<IgnoredAny>,
}

struct ReadLegacyFile {
    path: PathBuf,
    bytes: Vec<u8>,
    sha256: String,
}

pub fn preview_profile(profile_path: &Path) -> LegacyMigrationPreview {
    LegacyMigrationPreview {
        profile_path: profile_path.to_string_lossy().into_owned(),
        sources: vec![
            preview_pi_pointer(profile_path),
            preview_opencode_bindings(profile_path),
            preview_lifemodel(profile_path),
        ],
    }
}

pub(crate) fn finalize_pi_pointer_if_bound(
    store: &HostStore,
    profile_path: &Path,
) -> Result<bool, String> {
    let Some((source, project_path, session_file)) = migration_pi_source(profile_path) else {
        return Ok(false);
    };
    store.with_ready_database(|database| {
        let transaction = database
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("Cannot begin legacy Pi activation: {error}"))?;
        let bound = transaction
            .query_row(
                "SELECT 1
                 FROM sessions s
                 JOIN projects p ON p.project_id = s.project_id
                 JOIN session_native_locators l
                   ON l.farfold_session_id = s.farfold_session_id
                 WHERE s.runtime_product_id = ?1
                   AND s.installation_id = ?2
                   AND s.adapter_id = ?3
                   AND s.connection_id = ?4
                   AND p.canonical_path = ?5
                   AND l.locator_kind = 'pi_session_file'
                   AND l.locator_value = ?6
                 LIMIT 1",
                params![
                    PI_RUNTIME.product_id,
                    PI_RUNTIME.installation_id,
                    PI_RUNTIME.adapter_id,
                    PI_RUNTIME.default_connection_id,
                    project_path.to_string_lossy(),
                    session_file.to_string_lossy()
                ],
                |_| Ok(()),
            )
            .optional()
            .map_err(|error| format!("Cannot verify migrated legacy Pi binding: {error}"))?
            .is_some();
        if !bound {
            return Ok(false);
        }
        record_imported_source(&transaction, LegacySourceKind::PiSessionPointer, &source, 1)?;
        transaction
            .commit()
            .map_err(|error| format!("Cannot commit legacy Pi activation: {error}"))?;
        Ok(true)
    })
}

pub(crate) fn finalize_opencode_bindings_if_bound(
    store: &HostStore,
    profile_path: &Path,
) -> Result<bool, String> {
    let Some((source, bindings)) = migration_opencode_source(profile_path) else {
        return Ok(false);
    };
    store.with_ready_database(|database| finalize_opencode_bindings(database, &source, &bindings))
}

fn missing_preview(kind: LegacySourceKind, path: &Path) -> LegacyStorePreview {
    LegacyStorePreview {
        source_kind: kind,
        source_path: path.to_string_lossy().into_owned(),
        source_sha256: None,
        record_count: 0,
        disposition: LegacyPreviewDisposition::Missing,
        issue_codes: Vec::new(),
    }
}

fn blocked_preview(
    kind: LegacySourceKind,
    path: &Path,
    sha256: Option<String>,
    record_count: usize,
    issue_code: impl Into<String>,
) -> LegacyStorePreview {
    LegacyStorePreview {
        source_kind: kind,
        source_path: path.to_string_lossy().into_owned(),
        source_sha256: sha256,
        record_count,
        disposition: LegacyPreviewDisposition::Blocked,
        issue_codes: vec![issue_code.into()],
    }
}

fn read_legacy_file(
    kind: LegacySourceKind,
    path: PathBuf,
) -> Result<Option<ReadLegacyFile>, LegacyStorePreview> {
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(blocked_preview(
                kind,
                &path,
                None,
                0,
                "metadata_unavailable",
            ));
        }
    };
    if metadata.file_type().is_symlink() {
        return Err(blocked_preview(kind, &path, None, 0, "source_is_symlink"));
    }
    if !metadata.is_file() {
        return Err(blocked_preview(kind, &path, None, 0, "source_is_not_file"));
    }
    if metadata.len() > MAX_LEGACY_STORE_BYTES {
        return Err(blocked_preview(kind, &path, None, 0, "source_too_large"));
    }
    let bytes =
        fs::read(&path).map_err(|_| blocked_preview(kind, &path, None, 0, "source_read_failed"))?;
    let sha256 = sha256_hex(&bytes);
    Ok(Some(ReadLegacyFile {
        path,
        bytes,
        sha256,
    }))
}

fn preview_pi_pointer(profile_path: &Path) -> LegacyStorePreview {
    let path = profile_path.join(PI_POINTER_FILE);
    let file = match read_legacy_file(LegacySourceKind::PiSessionPointer, path.clone()) {
        Ok(Some(file)) => file,
        Ok(None) => return missing_preview(LegacySourceKind::PiSessionPointer, &path),
        Err(preview) => return preview,
    };
    let pointer = match serde_json::from_slice::<LegacyPiPointer>(&file.bytes) {
        Ok(pointer) => pointer,
        Err(_) => {
            return blocked_preview(
                LegacySourceKind::PiSessionPointer,
                &file.path,
                Some(file.sha256),
                0,
                "invalid_json",
            );
        }
    };

    let expected_session_root = profile_path.join("sessions").canonicalize();
    let project_path = pointer.project_path.canonicalize();
    let session_file = pointer.session_file.canonicalize();
    let valid = expected_session_root
        .as_ref()
        .ok()
        .zip(project_path.as_ref().ok())
        .zip(session_file.as_ref().ok())
        .is_some_and(|((session_root, project), session)| {
            project.is_dir()
                && session.is_file()
                && session.starts_with(session_root)
                && session
                    .extension()
                    .is_some_and(|extension| extension == "jsonl")
        });
    if !valid {
        return blocked_preview(
            LegacySourceKind::PiSessionPointer,
            &file.path,
            Some(file.sha256),
            1,
            "invalid_pi_pointer_boundary",
        );
    }

    LegacyStorePreview {
        source_kind: LegacySourceKind::PiSessionPointer,
        source_path: file.path.to_string_lossy().into_owned(),
        source_sha256: Some(file.sha256),
        record_count: 1,
        disposition: LegacyPreviewDisposition::RequiresRuntimeValidation,
        issue_codes: vec!["native_session_id_requires_runtime".to_string()],
    }
}

fn preview_opencode_bindings(profile_path: &Path) -> LegacyStorePreview {
    let path = profile_path.join(OPENCODE_BINDINGS_FILE);
    let file = match read_legacy_file(LegacySourceKind::OpenCodeBindings, path.clone()) {
        Ok(Some(file)) => file,
        Ok(None) => return missing_preview(LegacySourceKind::OpenCodeBindings, &path),
        Err(preview) => return preview,
    };
    let store = match serde_json::from_slice::<LegacyOpenCodeBindingStore>(&file.bytes) {
        Ok(store) => store,
        Err(_) => {
            return blocked_preview(
                LegacySourceKind::OpenCodeBindings,
                &file.path,
                Some(file.sha256),
                0,
                "invalid_json",
            );
        }
    };
    if store.version != 1 {
        return blocked_preview(
            LegacySourceKind::OpenCodeBindings,
            &file.path,
            Some(file.sha256),
            store.bindings.len(),
            "unsupported_store_version",
        );
    }

    let mut native_session_ids = HashSet::new();
    let valid = store.bindings.iter().all(|binding| {
        binding.runtime.product_id == OPENCODE_RUNTIME_PRODUCT_ID
            && binding.runtime.installation_id == OPENCODE_RUNTIME_INSTALLATION_ID
            && binding.runtime.adapter_id == OPENCODE_RUNTIME_ADAPTER_ID
            && binding.connection_id == OPENCODE_RUNTIME_CONNECTION_ID
            && valid_opencode_session_id(&binding.native_session_id)
            && native_session_ids.insert(binding.native_session_id.as_str())
            && binding.project_path.is_dir()
            && !binding.title.trim().is_empty()
            && binding.updated_at >= binding.created_at
    });
    if !valid {
        return blocked_preview(
            LegacySourceKind::OpenCodeBindings,
            &file.path,
            Some(file.sha256),
            store.bindings.len(),
            "invalid_binding_contract",
        );
    }

    LegacyStorePreview {
        source_kind: LegacySourceKind::OpenCodeBindings,
        source_path: file.path.to_string_lossy().into_owned(),
        source_sha256: Some(file.sha256),
        record_count: store.bindings.len(),
        disposition: LegacyPreviewDisposition::RequiresRuntimeValidation,
        issue_codes: vec!["native_sessions_require_runtime".to_string()],
    }
}

fn preview_lifemodel(profile_path: &Path) -> LegacyStorePreview {
    let path = profile_path.join(LIFEMODEL_FILE);
    let file = match read_legacy_file(LegacySourceKind::LifeModel, path.clone()) {
        Ok(Some(file)) => file,
        Ok(None) => return missing_preview(LegacySourceKind::LifeModel, &path),
        Err(preview) => return preview,
    };
    let store = match serde_json::from_slice::<LegacyLifeModelStore>(&file.bytes) {
        Ok(store) => store,
        Err(_) => {
            return blocked_preview(
                LegacySourceKind::LifeModel,
                &file.path,
                Some(file.sha256),
                0,
                "invalid_json",
            );
        }
    };
    let record_count = store.proposals.len()
        + store.items.len()
        + store.source_withdrawals.len()
        + store.injection_manifests.len();
    if store.version != 1 {
        return blocked_preview(
            LegacySourceKind::LifeModel,
            &file.path,
            Some(file.sha256),
            record_count,
            "unsupported_store_version",
        );
    }

    LegacyStorePreview {
        source_kind: LegacySourceKind::LifeModel,
        source_path: file.path.to_string_lossy().into_owned(),
        source_sha256: Some(file.sha256),
        record_count,
        disposition: LegacyPreviewDisposition::DeferredToP8,
        issue_codes: vec!["governance_migration_deferred_to_p8".to_string()],
    }
}

fn migration_pi_source(profile_path: &Path) -> Option<(ReadLegacyFile, PathBuf, PathBuf)> {
    let source = read_legacy_file(
        LegacySourceKind::PiSessionPointer,
        profile_path.join(PI_POINTER_FILE),
    )
    .ok()??;
    let pointer = serde_json::from_slice::<LegacyPiPointer>(&source.bytes).ok()?;
    let session_root = profile_path.join("sessions").canonicalize().ok()?;
    let project_path = pointer.project_path.canonicalize().ok()?;
    let session_file = pointer.session_file.canonicalize().ok()?;
    (project_path.is_dir()
        && session_file.is_file()
        && session_file.starts_with(session_root)
        && session_file
            .extension()
            .is_some_and(|extension| extension == "jsonl"))
    .then_some((source, project_path, session_file))
}

fn migration_opencode_source(
    profile_path: &Path,
) -> Option<(ReadLegacyFile, Vec<LegacyOpenCodeBinding>)> {
    let source = read_legacy_file(
        LegacySourceKind::OpenCodeBindings,
        profile_path.join(OPENCODE_BINDINGS_FILE),
    )
    .ok()??;
    let store = serde_json::from_slice::<LegacyOpenCodeBindingStore>(&source.bytes).ok()?;
    if store.version != 1 {
        return None;
    }
    let mut native_session_ids = HashSet::new();
    let valid = store.bindings.iter().all(|binding| {
        binding.runtime.product_id == OPENCODE_RUNTIME_PRODUCT_ID
            && binding.runtime.installation_id == OPENCODE_RUNTIME_INSTALLATION_ID
            && binding.runtime.adapter_id == OPENCODE_RUNTIME_ADAPTER_ID
            && binding.connection_id == OPENCODE_RUNTIME_CONNECTION_ID
            && valid_opencode_session_id(&binding.native_session_id)
            && native_session_ids.insert(binding.native_session_id.as_str())
            && binding.project_path.is_dir()
            && !binding.title.trim().is_empty()
            && binding.updated_at >= binding.created_at
    });
    valid.then_some((source, store.bindings))
}

fn finalize_opencode_bindings(
    database: &mut HostDatabase,
    source: &ReadLegacyFile,
    bindings: &[LegacyOpenCodeBinding],
) -> Result<bool, String> {
    let canonical_bindings = bindings
        .iter()
        .map(|binding| {
            binding
                .project_path
                .canonicalize()
                .map(|project_path| (binding, project_path))
                .map_err(|error| format!("Cannot resolve legacy OpenCode Project: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let transaction = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Cannot begin legacy OpenCode activation: {error}"))?;
    for (binding, project_path) in &canonical_bindings {
        let bound = transaction
            .query_row(
                "SELECT 1
                 FROM sessions s
                 JOIN projects p ON p.project_id = s.project_id
                 WHERE s.runtime_product_id = ?1
                   AND s.installation_id = ?2
                   AND s.adapter_id = ?3
                   AND s.connection_id = ?4
                   AND s.native_session_id = ?5
                   AND p.canonical_path = ?6
                 LIMIT 1",
                params![
                    OPENCODE_RUNTIME_PRODUCT_ID,
                    OPENCODE_RUNTIME_INSTALLATION_ID,
                    OPENCODE_RUNTIME_ADAPTER_ID,
                    OPENCODE_RUNTIME_CONNECTION_ID,
                    binding.native_session_id,
                    project_path.to_string_lossy()
                ],
                |_| Ok(()),
            )
            .optional()
            .map_err(|error| format!("Cannot verify migrated legacy OpenCode binding: {error}"))?
            .is_some();
        if !bound {
            return Ok(false);
        }
    }
    record_imported_source(
        &transaction,
        LegacySourceKind::OpenCodeBindings,
        source,
        bindings.len(),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit legacy OpenCode activation: {error}"))?;
    Ok(true)
}

fn record_imported_source(
    transaction: &rusqlite::Transaction<'_>,
    kind: LegacySourceKind,
    source: &ReadLegacyFile,
    record_count: usize,
) -> Result<(), String> {
    let record_count = i64::try_from(record_count)
        .map_err(|_| "Legacy source record count is out of range".to_string())?;
    let timestamp = now_millis();
    transaction
        .execute(
            "INSERT INTO legacy_migration_sources(
                source_kind, source_path, source_sha256, status, record_count,
                issue_code, previewed_at, imported_at
             ) VALUES (?1, ?2, ?3, 'imported', ?4, NULL, ?5, ?5)
             ON CONFLICT(source_kind, source_path, source_sha256) DO UPDATE SET
                status = 'imported',
                record_count = excluded.record_count,
                issue_code = NULL,
                imported_at = excluded.imported_at
             WHERE legacy_migration_sources.status != 'imported'",
            params![
                kind.as_str(),
                source.path.to_string_lossy(),
                source.sha256,
                record_count,
                timestamp
            ],
        )
        .map_err(|error| format!("Cannot record imported legacy source: {error}"))?;
    Ok(())
}

fn valid_opencode_session_id(value: &str) -> bool {
    value.starts_with("ses_")
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(64);
    for byte in digest {
        write!(&mut output, "{byte:02x}").expect("writing to a String cannot fail");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::{
        LegacyPreviewDisposition, LegacySourceKind, finalize_opencode_bindings_if_bound,
        finalize_pi_pointer_if_bound, preview_profile, sha256_hex,
    };
    use crate::{
        host_ids::{AdapterId, ConnectionId, InstallationId, RuntimeBuildId, RuntimeProductId},
        host_store::{
            HostStore,
            records::{
                NativeSessionLocatorKind, RuntimeConnectionKind, RuntimeDistribution,
                RuntimeRegistration,
            },
            session_binding_index::{
                ManagedNativeLocator, ManagedSessionRegistrationInput, register_managed_session,
                register_managed_session_with_locator,
            },
        },
        runtime_registry::{ManagedRuntimeDefinition, OPENCODE_RUNTIME, PI_RUNTIME},
    };
    use serde_json::json;
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TestProfile(PathBuf);

    impl TestProfile {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "farfold-legacy-preview-{name}-{}-{}",
                std::process::id(),
                TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestProfile {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn register_runtime(store: &HostStore, definition: ManagedRuntimeDefinition) {
        store
            .register_runtime(&RuntimeRegistration {
                runtime_product_id: RuntimeProductId::parse(definition.product_id).unwrap(),
                display_name: definition.display_name.to_string(),
                installation_id: InstallationId::parse(definition.installation_id).unwrap(),
                runtime_build_id: RuntimeBuildId::parse(definition.runtime_build_id).unwrap(),
                adapter_id: AdapterId::parse(definition.adapter_id).unwrap(),
                distribution: RuntimeDistribution::Managed,
                observed_version: definition.version.to_string(),
                artifact_sha256: definition.binary_sha256.to_string(),
                connection_id: ConnectionId::parse(definition.default_connection_id).unwrap(),
                connection_label: format!("{} native configuration", definition.display_name),
                connection_kind: RuntimeConnectionKind::ManagedLocal,
                created_at: 1,
                verified_at: 1,
            })
            .unwrap();
    }

    #[test]
    fn missing_legacy_files_are_explicit_and_nonfatal() {
        let profile = TestProfile::new("missing");
        let preview = preview_profile(&profile.0);

        assert_eq!(preview.sources.len(), 3);
        assert!(preview.sources.iter().all(|source| {
            source.disposition == LegacyPreviewDisposition::Missing
                && source.source_sha256.is_none()
                && source.record_count == 0
        }));
    }

    #[test]
    fn preview_validates_boundaries_without_reading_native_pi_history() {
        let profile = TestProfile::new("valid");
        let project = profile.0.join("project");
        let sessions = profile.0.join("sessions");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&sessions).unwrap();
        let pi_session = sessions.join("session.jsonl");
        fs::write(&pi_session, b"not parsed by migration preview").unwrap();
        fs::write(
            profile.0.join("last-pi-session.json"),
            serde_json::to_vec(&json!({
                "projectPath": project,
                "sessionFile": pi_session
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            profile.0.join("opencode-session-bindings.json"),
            serde_json::to_vec(&json!({
                "version": 1,
                "bindings": [{
                    "runtime": {
                        "productId": "opencode",
                        "installationId": "bundled-opencode-1.15.13-arm64",
                        "adapterId": "opencode-server-http-sse-v1"
                    },
                    "connectionId": "opencode-local-native-config-v1",
                    "nativeSessionId": "ses_preview",
                    "projectPath": project,
                    "title": "Preview",
                    "createdAt": 1,
                    "updatedAt": 2
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        let secret_marker = "SHOULD-NOT-APPEAR-IN-PREVIEW";
        fs::write(
            profile.0.join("lifemodel.json"),
            serde_json::to_vec(&json!({
                "version": 1,
                "enabled": true,
                "proposals": [{"sourceText": secret_marker}],
                "items": [{"value": secret_marker}],
                "sourceWithdrawals": [],
                "injectionManifests": []
            }))
            .unwrap(),
        )
        .unwrap();

        let preview = preview_profile(&profile.0);
        assert_eq!(preview, preview_profile(&profile.0));
        assert_eq!(
            preview.sources[0].disposition,
            LegacyPreviewDisposition::RequiresRuntimeValidation
        );
        assert_eq!(
            preview.sources[1].disposition,
            LegacyPreviewDisposition::RequiresRuntimeValidation
        );
        assert_eq!(
            preview.sources[2].disposition,
            LegacyPreviewDisposition::DeferredToP8
        );
        assert_eq!(preview.sources[2].record_count, 2);
        assert!(
            !serde_json::to_string(&preview)
                .unwrap()
                .contains(secret_marker)
        );
    }

    #[test]
    fn invalid_store_is_blocked_but_keeps_a_content_fingerprint() {
        let profile = TestProfile::new("invalid");
        fs::write(
            profile.0.join("opencode-session-bindings.json"),
            b"{invalid",
        )
        .unwrap();

        let preview = preview_profile(&profile.0);
        let source = preview
            .sources
            .iter()
            .find(|source| source.source_kind == LegacySourceKind::OpenCodeBindings)
            .unwrap();
        assert_eq!(source.disposition, LegacyPreviewDisposition::Blocked);
        assert_eq!(
            source.source_sha256.as_deref(),
            Some(sha256_hex(b"{invalid").as_str())
        );
        assert_eq!(source.issue_codes, vec!["invalid_json"]);
    }

    #[test]
    fn pi_source_is_recorded_only_after_the_exact_host_binding_exists() {
        let profile = TestProfile::new("pi-activation");
        let project = profile.0.join("project");
        let sessions = profile.0.join("sessions");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&sessions).unwrap();
        let session_file = sessions.join("session.jsonl");
        fs::write(&session_file, "{}\n").unwrap();
        fs::write(
            profile.0.join("last-pi-session.json"),
            serde_json::to_vec(&json!({
                "projectPath": project,
                "sessionFile": session_file
            }))
            .unwrap(),
        )
        .unwrap();
        let store = HostStore::open(profile.0.join("host.sqlite3"));
        register_runtime(&store, PI_RUNTIME);

        assert!(!finalize_pi_pointer_if_bound(&store, &profile.0).unwrap());
        register_managed_session_with_locator(
            &store,
            PI_RUNTIME,
            ManagedSessionRegistrationInput {
                native_session_id: "pi-native-session",
                working_copy_path: &project,
                title: "Pi Session",
                created_at: 2,
                updated_at: 3,
            },
            ManagedNativeLocator {
                kind: NativeSessionLocatorKind::PiSessionFile,
                path: &session_file,
                allowed_root: &sessions,
            },
        )
        .unwrap();
        assert!(finalize_pi_pointer_if_bound(&store, &profile.0).unwrap());
        let first_import = store
            .with_ready_database(|database| {
                database
                    .connection
                    .query_row(
                        "SELECT count(*), imported_at FROM legacy_migration_sources
                         WHERE source_kind = 'pi_session_pointer' AND status = 'imported'",
                        [],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert!(finalize_pi_pointer_if_bound(&store, &profile.0).unwrap());
        let second_import = store
            .with_ready_database(|database| {
                database
                    .connection
                    .query_row(
                        "SELECT count(*), imported_at FROM legacy_migration_sources
                         WHERE source_kind = 'pi_session_pointer' AND status = 'imported'",
                        [],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert_eq!(first_import, second_import);
        assert_eq!(first_import.0, 1);
    }

    #[test]
    fn opencode_source_waits_until_every_binding_has_host_evidence() {
        let profile = TestProfile::new("opencode-activation");
        let project = profile.0.join("project");
        fs::create_dir_all(&project).unwrap();
        fs::write(
            profile.0.join("opencode-session-bindings.json"),
            serde_json::to_vec(&json!({
                "version": 1,
                "bindings": [{
                    "runtime": {
                        "productId": OPENCODE_RUNTIME.product_id,
                        "installationId": OPENCODE_RUNTIME.installation_id,
                        "adapterId": OPENCODE_RUNTIME.adapter_id
                    },
                    "connectionId": OPENCODE_RUNTIME.default_connection_id,
                    "nativeSessionId": "ses_legacy",
                    "projectPath": project,
                    "title": "Legacy",
                    "createdAt": 2,
                    "updatedAt": 3
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        let store = HostStore::open(profile.0.join("host.sqlite3"));
        register_runtime(&store, OPENCODE_RUNTIME);

        assert!(!finalize_opencode_bindings_if_bound(&store, &profile.0).unwrap());
        register_managed_session(
            &store,
            OPENCODE_RUNTIME,
            ManagedSessionRegistrationInput {
                native_session_id: "ses_legacy",
                working_copy_path: &project,
                title: "Official title",
                created_at: 2,
                updated_at: 3,
            },
        )
        .unwrap();
        assert!(finalize_opencode_bindings_if_bound(&store, &profile.0).unwrap());
        assert_eq!(
            store
                .with_ready_database(|database| {
                    database
                        .connection
                        .query_row(
                            "SELECT record_count FROM legacy_migration_sources
                             WHERE source_kind = 'opencode_bindings' AND status = 'imported'",
                            [],
                            |row| row.get::<_, i64>(0),
                        )
                        .map_err(|error| error.to_string())
                })
                .unwrap(),
            1
        );
    }
}
