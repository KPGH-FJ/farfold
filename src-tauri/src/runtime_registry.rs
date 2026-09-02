use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fmt::Write as _,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Manager};

pub(crate) const PI_RUNTIME_PRODUCT_ID: &str = "pi";
pub(crate) const PI_RUNTIME_INSTALLATION_ID: &str = "bundled-pi";
pub(crate) const PI_RUNTIME_BUILD_ID: &str =
    "pi@0.84.3+sha256:e844dc14981fc70c7f4c45c5ba5f8c237199891bd8520d1ed21fe78be6479dac";
pub(crate) const PI_RUNTIME_ADAPTER_ID: &str = "pi-rpc-jsonl";
pub(crate) const PI_RUNTIME_CONNECTION_ID: &str = "pi-local-native-config-v1";
pub(crate) const PI_RUNTIME_VERSION: &str = "0.84.3";
pub(crate) const PI_RUNTIME_BINARY_SHA256: &str =
    "e844dc14981fc70c7f4c45c5ba5f8c237199891bd8520d1ed21fe78be6479dac";

pub(crate) const OPENCODE_RUNTIME_PRODUCT_ID: &str = "opencode";
pub(crate) const OPENCODE_RUNTIME_INSTALLATION_ID: &str = "bundled-opencode-1.15.13-arm64";
pub(crate) const OPENCODE_RUNTIME_BUILD_ID: &str =
    "opencode@1.15.13+sha256:1cdcb7e426a863528a41ae8f9f6b65470b8395ddd48937229b01299ddc1085f0";
pub(crate) const OPENCODE_RUNTIME_ADAPTER_ID: &str = "opencode-server-http-sse-v1";
pub(crate) const OPENCODE_RUNTIME_CONNECTION_ID: &str = "opencode-local-native-config-v1";
pub(crate) const OPENCODE_RUNTIME_VERSION: &str = "1.15.13";
pub(crate) const OPENCODE_RUNTIME_BINARY_SHA256: &str =
    "1cdcb7e426a863528a41ae8f9f6b65470b8395ddd48937229b01299ddc1085f0";

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ManagedRuntimeKey {
    Pi,
    Opencode,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeIdentity {
    pub(crate) product_id: String,
    pub(crate) installation_id: String,
    pub(crate) adapter_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ManagedRuntimeDefinition {
    pub(crate) product_id: &'static str,
    pub(crate) installation_id: &'static str,
    pub(crate) runtime_build_id: &'static str,
    pub(crate) adapter_id: &'static str,
    pub(crate) default_connection_id: &'static str,
    pub(crate) display_name: &'static str,
    pub(crate) version: &'static str,
    pub(crate) distribution: &'static str,
    pub(crate) protocol: &'static str,
    pub(crate) binary_resource_path: &'static str,
    pub(crate) binary_sha256: &'static str,
}

impl ManagedRuntimeDefinition {
    pub(crate) fn identity(self) -> RuntimeIdentity {
        RuntimeIdentity {
            product_id: self.product_id.to_string(),
            installation_id: self.installation_id.to_string(),
            adapter_id: self.adapter_id.to_string(),
        }
    }
}

impl ManagedRuntimeKey {
    pub(crate) fn definition(self) -> ManagedRuntimeDefinition {
        match self {
            Self::Pi => PI_RUNTIME,
            Self::Opencode => OPENCODE_RUNTIME,
        }
    }
}

pub(crate) const PI_RUNTIME: ManagedRuntimeDefinition = ManagedRuntimeDefinition {
    product_id: PI_RUNTIME_PRODUCT_ID,
    installation_id: PI_RUNTIME_INSTALLATION_ID,
    runtime_build_id: PI_RUNTIME_BUILD_ID,
    adapter_id: PI_RUNTIME_ADAPTER_ID,
    default_connection_id: PI_RUNTIME_CONNECTION_ID,
    display_name: "Pi",
    version: PI_RUNTIME_VERSION,
    distribution: "bundled",
    protocol: "pi-rpc-jsonl",
    binary_resource_path: "pi-runtime/pi",
    binary_sha256: PI_RUNTIME_BINARY_SHA256,
};

pub(crate) const OPENCODE_RUNTIME: ManagedRuntimeDefinition = ManagedRuntimeDefinition {
    product_id: OPENCODE_RUNTIME_PRODUCT_ID,
    installation_id: OPENCODE_RUNTIME_INSTALLATION_ID,
    runtime_build_id: OPENCODE_RUNTIME_BUILD_ID,
    adapter_id: OPENCODE_RUNTIME_ADAPTER_ID,
    default_connection_id: OPENCODE_RUNTIME_CONNECTION_ID,
    display_name: "OpenCode",
    version: OPENCODE_RUNTIME_VERSION,
    distribution: "bundled",
    protocol: "opencode-server-http-sse",
    binary_resource_path: "opencode-runtime/opencode",
    binary_sha256: OPENCODE_RUNTIME_BINARY_SHA256,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ObservedRuntimeInstallation {
    pub(crate) definition: ManagedRuntimeDefinition,
    pub(crate) binary_path: PathBuf,
    pub(crate) observed_version: String,
    pub(crate) artifact_sha256: String,
}

pub(crate) fn pi_identity() -> RuntimeIdentity {
    PI_RUNTIME.identity()
}

pub(crate) fn opencode_identity() -> RuntimeIdentity {
    OPENCODE_RUNTIME.identity()
}

fn development_binary_path(definition: ManagedRuntimeDefinition) -> Option<PathBuf> {
    let prepared = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(definition.binary_resource_path);
    if prepared.is_file() {
        return Some(prepared);
    }
    #[cfg(debug_assertions)]
    if definition.product_id == OPENCODE_RUNTIME_PRODUCT_ID
        && let Some(path) = std::env::var_os("FARFOLD_OPENCODE_BINARY")
    {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

fn managed_binary_path(
    app: &AppHandle,
    definition: ManagedRuntimeDefinition,
) -> Result<PathBuf, String> {
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|directory| directory.join(definition.binary_resource_path))
        .filter(|path| path.is_file());
    bundled
        .or_else(|| development_binary_path(definition))
        .ok_or_else(|| {
            format!(
                "Cannot locate the pinned {} Runtime artifact",
                definition.display_name
            )
        })
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| {
        format!(
            "Cannot open managed Runtime artifact {}: {error}",
            path.display()
        )
    })?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| {
            format!(
                "Cannot read managed Runtime artifact {}: {error}",
                path.display()
            )
        })?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    let digest = digest.finalize();
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(encoded)
}

fn binary_version(path: &Path, display_name: &str) -> Result<String, String> {
    let output = Command::new(path)
        .arg("--version")
        .output()
        .map_err(|error| format!("Cannot inspect {display_name} Runtime version: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "{display_name} Runtime version check failed with status {}",
            output.status
        ));
    }
    String::from_utf8(output.stdout)
        .map(|value| value.trim().to_string())
        .map_err(|error| format!("{display_name} Runtime returned a non-UTF-8 version: {error}"))
}

pub(crate) fn verify_managed_installation(
    app: &AppHandle,
    definition: ManagedRuntimeDefinition,
) -> Result<ObservedRuntimeInstallation, String> {
    let binary_path = managed_binary_path(app, definition)?;
    let artifact_sha256 = file_sha256(&binary_path)?;
    if artifact_sha256 != definition.binary_sha256 {
        return Err(format!(
            "{} Runtime digest mismatch: expected {}, found {}",
            definition.display_name, definition.binary_sha256, artifact_sha256
        ));
    }
    let observed_version = binary_version(&binary_path, definition.display_name)?;
    if observed_version != definition.version {
        return Err(format!(
            "{} Runtime version mismatch: expected {}, found {}",
            definition.display_name, definition.version, observed_version
        ));
    }
    Ok(ObservedRuntimeInstallation {
        definition,
        binary_path,
        observed_version,
        artifact_sha256,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        OPENCODE_RUNTIME, OPENCODE_RUNTIME_BINARY_SHA256, OPENCODE_RUNTIME_VERSION, PI_RUNTIME,
        PI_RUNTIME_BINARY_SHA256, PI_RUNTIME_VERSION, file_sha256,
    };
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };

    static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn registry_keeps_every_runtime_identity_dimension_distinct() {
        for definition in [PI_RUNTIME, OPENCODE_RUNTIME] {
            assert_ne!(definition.product_id, definition.installation_id);
            assert_ne!(definition.installation_id, definition.runtime_build_id);
            assert_ne!(definition.runtime_build_id, definition.adapter_id);
            assert_ne!(definition.adapter_id, definition.default_connection_id);
            assert!(definition.runtime_build_id.contains(definition.version));
            assert!(
                definition
                    .runtime_build_id
                    .contains(definition.binary_sha256)
            );
        }
    }

    #[test]
    fn registry_pins_match_fetch_scripts() {
        let pi_script = include_str!("../../scripts/fetch-pi-sidecar.sh");
        assert!(pi_script.contains(&format!("PI_VERSION=\"{PI_RUNTIME_VERSION}\"")));
        assert!(pi_script.contains(&format!("PI_BINARY_SHA256=\"{PI_RUNTIME_BINARY_SHA256}\"")));

        let opencode_script = include_str!("../../scripts/fetch-opencode-sidecar.sh");
        assert!(
            opencode_script.contains(&format!("OPENCODE_VERSION=\"{OPENCODE_RUNTIME_VERSION}\""))
        );
        assert!(opencode_script.contains(&format!(
            "OPENCODE_BINARY_SHA256=\"{OPENCODE_RUNTIME_BINARY_SHA256}\""
        )));
    }

    #[test]
    fn artifact_digest_is_streamed_from_the_actual_file() {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "farfold-runtime-registry-{}-{sequence}.bin",
            std::process::id()
        ));
        fs::write(&path, b"farfold-runtime").unwrap();
        let digest = file_sha256(&path).unwrap();
        fs::remove_file(path).unwrap();
        assert_eq!(
            digest,
            "8c1017b5b78c85c188678ff847e7081c16ab138a51483e271a67697ccf9c2e6e"
        );
    }
}
