use flate2::read::GzDecoder;
use serde::Deserialize;
use std::{
    collections::HashSet,
    io::Cursor,
    path::{Component, Path, PathBuf},
    process::Command,
};
use tempfile::TempDir;

use crate::runtime_registry::file_sha256;

const MAX_ARCHIVE_ENTRIES: usize = 50_000;
const MAX_ARCHIVE_PATH_BYTES: usize = 1_024;
const MAX_UNPACKED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_METADATA_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseManifest {
    format_version: u32,
    app_version: String,
    host_schema_version: u64,
    runtimes: Vec<ReleaseRuntime>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseRuntime {
    product_id: String,
    version: String,
    resource_path: String,
    sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CandidateBundleInspection {
    pub(crate) bundle_id: String,
    pub(crate) version: String,
    pub(crate) host_schema_version: u64,
    pub(crate) main_executable_sha256: String,
    main_executable_name: String,
}

struct ExtractedCandidate {
    _directory: TempDir,
    app_path: PathBuf,
}

pub(crate) struct StagedCandidateBundle {
    _directory: TempDir,
    pub(crate) app_path: PathBuf,
    pub(crate) main_executable_path: PathBuf,
    pub(crate) inspection: CandidateBundleInspection,
}

fn bounded_normal_path(path: &Path) -> Result<Vec<String>, String> {
    let path_text = path.to_string_lossy();
    if path_text.len() > MAX_ARCHIVE_PATH_BYTES {
        return Err("Managed update archive path is too long".to_string());
    }
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                let value = value
                    .to_str()
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "Managed update archive path is not valid UTF-8".to_string())?;
                components.push(value.to_string());
            }
            _ => return Err("Managed update archive path is unsafe".to_string()),
        }
    }
    if components.is_empty() {
        return Err("Managed update archive contains an empty path".to_string());
    }
    Ok(components)
}

fn extract_candidate_archive(artifact: &[u8]) -> Result<ExtractedCandidate, String> {
    let directory = tempfile::Builder::new()
        .prefix("farfold-update-candidate-")
        .tempdir()
        .map_err(|_| "Cannot reserve managed update candidate directory".to_string())?;
    let decoder = GzDecoder::new(Cursor::new(artifact));
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|_| "Managed update artifact is not a valid tar.gz archive".to_string())?;
    let mut root: Option<String> = None;
    let mut seen = HashSet::new();
    let mut entry_count = 0_usize;
    let mut unpacked_bytes = 0_u64;

    for entry in entries {
        let mut entry =
            entry.map_err(|_| "Managed update archive contains an invalid entry".to_string())?;
        entry_count = entry_count
            .checked_add(1)
            .ok_or_else(|| "Managed update archive entry count overflowed".to_string())?;
        if entry_count > MAX_ARCHIVE_ENTRIES {
            return Err("Managed update archive contains too many entries".to_string());
        }
        let path = entry
            .path()
            .map_err(|_| "Managed update archive contains an invalid path".to_string())?
            .into_owned();
        let components = bounded_normal_path(&path)?;
        let entry_root = components[0].clone();
        if !entry_root.ends_with(".app") {
            return Err("Managed update archive root is not a macOS application".to_string());
        }
        match &root {
            Some(root) if root != &entry_root => {
                return Err("Managed update archive contains multiple roots".to_string());
            }
            None => root = Some(entry_root),
            _ => {}
        }
        let normalized_path: PathBuf = components.iter().collect();
        if !seen.insert(normalized_path) {
            return Err("Managed update archive contains a duplicate path".to_string());
        }
        let entry_type = entry.header().entry_type();
        if !entry_type.is_file() && !entry_type.is_dir() {
            return Err("Managed update archive contains a link or special file".to_string());
        }
        unpacked_bytes = unpacked_bytes
            .checked_add(entry.header().size().unwrap_or(u64::MAX))
            .ok_or_else(|| "Managed update archive size overflowed".to_string())?;
        if unpacked_bytes > MAX_UNPACKED_BYTES {
            return Err("Managed update archive expands beyond the allowed size".to_string());
        }
        let destination = directory.path().join(&path);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|_| "Cannot prepare managed update candidate path".to_string())?;
        }
        if !entry
            .unpack_in(directory.path())
            .map_err(|_| "Cannot unpack managed update candidate".to_string())?
        {
            return Err("Managed update archive attempted to escape staging".to_string());
        }
    }

    let root = root.ok_or_else(|| "Managed update archive is empty".to_string())?;
    Ok(ExtractedCandidate {
        app_path: directory.path().join(root),
        _directory: directory,
    })
}

fn regular_bounded_file(path: &Path, label: &str, max_bytes: u64) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| format!("Managed update candidate omitted {label}"))?;
    if !metadata.file_type().is_file() || metadata.len() > max_bytes {
        return Err(format!("Managed update candidate {label} is invalid"));
    }
    Ok(())
}

fn safe_resource_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    let components = bounded_normal_path(path)?;
    if components.len() < 2 {
        return Err("Managed update Runtime resource path is incomplete".to_string());
    }
    Ok(components.iter().collect())
}

fn safe_file_name(value: &str, label: &str) -> Result<PathBuf, String> {
    let components = bounded_normal_path(Path::new(value))?;
    if components.len() != 1 {
        return Err(format!("Managed update candidate {label} is invalid"));
    }
    Ok(components.iter().collect())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn inspect_extracted_candidate(
    app_path: &Path,
    expected_version: &str,
    expected_bundle_id: &str,
) -> Result<CandidateBundleInspection, String> {
    let info_path = app_path.join("Contents/Info.plist");
    regular_bounded_file(&info_path, "Info.plist", MAX_METADATA_BYTES)?;
    let info = plist::Value::from_file(&info_path)
        .map_err(|_| "Managed update candidate Info.plist is invalid".to_string())?;
    let info = info
        .as_dictionary()
        .ok_or_else(|| "Managed update candidate Info.plist is not a dictionary".to_string())?;
    let bundle_id = info
        .get("CFBundleIdentifier")
        .and_then(plist::Value::as_string)
        .ok_or_else(|| "Managed update candidate omitted its bundle identifier".to_string())?;
    if bundle_id != expected_bundle_id {
        return Err("Managed update candidate bundle identifier does not match".to_string());
    }
    let version = info
        .get("CFBundleShortVersionString")
        .and_then(plist::Value::as_string)
        .ok_or_else(|| "Managed update candidate omitted its version".to_string())?;
    if version != expected_version {
        return Err("Managed update candidate version does not match metadata".to_string());
    }
    let executable = info
        .get("CFBundleExecutable")
        .and_then(plist::Value::as_string)
        .ok_or_else(|| "Managed update candidate omitted its executable name".to_string())?;
    let executable = safe_file_name(executable, "executable name")?;
    let executable_path = app_path.join("Contents/MacOS").join(&executable);
    regular_bounded_file(&executable_path, "main executable", MAX_UNPACKED_BYTES)?;

    let manifest_path = app_path.join("Contents/Resources/release-manifest.json");
    regular_bounded_file(&manifest_path, "release manifest", MAX_METADATA_BYTES)?;
    let manifest: ReleaseManifest = serde_json::from_reader(
        std::fs::File::open(&manifest_path)
            .map_err(|_| "Cannot open managed update release manifest".to_string())?,
    )
    .map_err(|_| "Managed update release manifest is invalid".to_string())?;
    if manifest.format_version != 1
        || manifest.app_version != expected_version
        || manifest.host_schema_version == 0
    {
        return Err("Managed update release manifest identity does not match".to_string());
    }
    if manifest.runtimes.len() != 2 {
        return Err("Managed update release manifest has an unexpected Runtime set".to_string());
    }
    let mut runtime_products = HashSet::new();
    for runtime in &manifest.runtimes {
        if !matches!(runtime.product_id.as_str(), "pi" | "opencode")
            || !runtime_products.insert(runtime.product_id.as_str())
            || runtime.version.trim().is_empty()
            || !valid_sha256(&runtime.sha256)
        {
            return Err("Managed update release manifest has an invalid Runtime".to_string());
        }
        let expected_path = match runtime.product_id.as_str() {
            "pi" => "pi-runtime/pi",
            "opencode" => "opencode-runtime/opencode",
            _ => unreachable!("Runtime product was checked"),
        };
        if runtime.resource_path != expected_path {
            return Err("Managed update Runtime resource path does not match".to_string());
        }
        let path = safe_resource_path(&runtime.resource_path)?;
        let path = app_path.join("Contents/Resources").join(path);
        regular_bounded_file(&path, "Runtime artifact", MAX_UNPACKED_BYTES)?;
        if file_sha256(&path)? != runtime.sha256.to_ascii_lowercase() {
            return Err("Managed update Runtime artifact digest does not match".to_string());
        }
    }

    Ok(CandidateBundleInspection {
        bundle_id: bundle_id.to_string(),
        version: version.to_string(),
        host_schema_version: manifest.host_schema_version,
        main_executable_sha256: file_sha256(&executable_path)?,
        main_executable_name: executable
            .to_str()
            .expect("safe executable name is valid UTF-8")
            .to_string(),
    })
}

pub(crate) fn stage_candidate_archive(
    artifact: &[u8],
    expected_version: &str,
    expected_bundle_id: &str,
) -> Result<StagedCandidateBundle, String> {
    let extracted = extract_candidate_archive(artifact)?;
    let inspection =
        inspect_extracted_candidate(&extracted.app_path, expected_version, expected_bundle_id)?;
    let output = Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(&extracted.app_path)
        .output()
        .map_err(|_| "Cannot run managed update code-signature verification".to_string())?;
    if !output.status.success() {
        return Err("Managed update candidate code signature is invalid".to_string());
    }
    let main_executable_path = extracted
        .app_path
        .join("Contents/MacOS")
        .join(&inspection.main_executable_name);
    Ok(StagedCandidateBundle {
        _directory: extracted._directory,
        app_path: extracted.app_path,
        main_executable_path,
        inspection,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        ReleaseManifest, extract_candidate_archive, inspect_extracted_candidate, safe_file_name,
        stage_candidate_archive,
    };
    use crate::{
        host_store::CURRENT_SCHEMA_VERSION,
        runtime_registry::{OPENCODE_RUNTIME, PI_ACP_RUNTIME, file_sha256},
    };
    use flate2::{Compression, write::GzEncoder};
    use sha2::{Digest, Sha256};
    use std::{fmt::Write as _, io::Cursor, process::Command};

    fn sha256(value: &[u8]) -> String {
        let digest = Sha256::digest(value);
        let mut encoded = String::with_capacity(digest.len() * 2);
        for byte in digest {
            write!(&mut encoded, "{byte:02x}").unwrap();
        }
        encoded
    }

    fn append(builder: &mut tar::Builder<GzEncoder<Vec<u8>>>, path: &str, value: &[u8]) {
        let mut header = tar::Header::new_gnu();
        header.set_size(value.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        builder
            .append_data(&mut header, path, Cursor::new(value))
            .unwrap();
    }

    fn archive(version: &str, include_link: bool) -> Vec<u8> {
        let info = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>ai.farfold.test</string>
<key>CFBundleShortVersionString</key><string>{version}</string>
<key>CFBundleExecutable</key><string>farfold</string>
</dict></plist>"#
        );
        let manifest = serde_json::json!({
            "formatVersion": 1,
            "appVersion": version,
            "hostSchemaVersion": 7,
            "runtimes": [
                {"productId":"pi","version":"1","resourcePath":"pi-runtime/pi","sha256":sha256(b"pi")},
                {"productId":"opencode","version":"1","resourcePath":"opencode-runtime/opencode","sha256":sha256(b"opencode")}
            ]
        });
        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut builder = tar::Builder::new(encoder);
        append(
            &mut builder,
            "Farfold.app/Contents/Info.plist",
            info.as_bytes(),
        );
        append(&mut builder, "Farfold.app/Contents/MacOS/farfold", b"host");
        append(
            &mut builder,
            "Farfold.app/Contents/Resources/release-manifest.json",
            manifest.to_string().as_bytes(),
        );
        append(
            &mut builder,
            "Farfold.app/Contents/Resources/pi-runtime/pi",
            b"pi",
        );
        append(
            &mut builder,
            "Farfold.app/Contents/Resources/opencode-runtime/opencode",
            b"opencode",
        );
        if include_link {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            header.set_mode(0o777);
            header.set_link_name("../../outside").unwrap();
            header.set_cksum();
            builder
                .append_data(
                    &mut header,
                    "Farfold.app/Contents/Resources/escape",
                    Cursor::new([]),
                )
                .unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    fn archive_directory(path: &std::path::Path) -> Vec<u8> {
        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut builder = tar::Builder::new(encoder);
        builder.append_dir_all("Farfold.app", path).unwrap();
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn candidate_archive_binds_bundle_version_manifest_and_runtime_digests() {
        let extracted = extract_candidate_archive(&archive("2.0.0", false)).unwrap();
        let inspected =
            inspect_extracted_candidate(&extracted.app_path, "2.0.0", "ai.farfold.test").unwrap();
        assert_eq!(inspected.version, "2.0.0");
        assert_eq!(inspected.bundle_id, "ai.farfold.test");
        assert_eq!(inspected.host_schema_version, 7);
        assert_eq!(inspected.main_executable_sha256, sha256(b"host"));
        assert!(
            inspect_extracted_candidate(&extracted.app_path, "2.0.1", "ai.farfold.test").is_err()
        );
    }

    #[test]
    fn candidate_archive_rejects_links_before_unpacking() {
        assert!(extract_candidate_archive(&archive("2.0.0", true)).is_err());
        assert!(safe_file_name("../farfold", "executable name").is_err());
        assert!(safe_file_name("nested/farfold", "executable name").is_err());
    }

    #[test]
    fn candidate_archive_requires_an_intact_macos_code_signature() {
        let extracted = extract_candidate_archive(&archive("2.0.0", false)).unwrap();
        let executable = extracted.app_path.join("Contents/MacOS/farfold");
        std::fs::copy("/usr/bin/true", &executable).unwrap();
        let signed = Command::new("/usr/bin/codesign")
            .args(["--force", "--deep", "--sign", "-"])
            .arg(&extracted.app_path)
            .output()
            .unwrap();
        assert!(signed.status.success());
        let expected_main_sha256 = file_sha256(&executable).unwrap();

        let valid_archive = archive_directory(&extracted.app_path);
        let staged = stage_candidate_archive(&valid_archive, "2.0.0", "ai.farfold.test").unwrap();
        assert_eq!(
            staged.inspection.main_executable_sha256,
            expected_main_sha256
        );

        std::fs::write(&executable, b"tampered after signing").unwrap();
        let tampered_archive = archive_directory(&extracted.app_path);
        assert!(stage_candidate_archive(&tampered_archive, "2.0.0", "ai.farfold.test").is_err());
    }

    #[test]
    fn repository_release_manifest_matches_compiled_release_identity() {
        let manifest: ReleaseManifest =
            serde_json::from_str(include_str!("../resources/release-manifest.json")).unwrap();
        assert_eq!(manifest.format_version, 1);
        assert_eq!(manifest.app_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(
            manifest.host_schema_version,
            u64::try_from(CURRENT_SCHEMA_VERSION).unwrap()
        );
        assert_eq!(manifest.runtimes.len(), 2);
        for definition in [PI_ACP_RUNTIME, OPENCODE_RUNTIME] {
            let runtime = manifest
                .runtimes
                .iter()
                .find(|runtime| runtime.product_id == definition.product_id)
                .unwrap();
            assert_eq!(runtime.version, definition.version);
            assert_eq!(runtime.resource_path, definition.binary_resource_path);
            assert_eq!(runtime.sha256, definition.binary_sha256);
        }
    }
}
