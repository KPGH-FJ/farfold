use serde::{Deserialize, Serialize, de::IgnoredAny};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fmt::Write as _,
    fs,
    path::{Path, PathBuf},
};

use crate::runtime_registry::{
    OPENCODE_RUNTIME_ADAPTER_ID, OPENCODE_RUNTIME_CONNECTION_ID, OPENCODE_RUNTIME_INSTALLATION_ID,
    OPENCODE_RUNTIME_PRODUCT_ID,
};

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
    use super::{LegacyPreviewDisposition, LegacySourceKind, preview_profile, sha256_hex};
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
}
