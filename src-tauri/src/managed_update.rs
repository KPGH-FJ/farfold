//! Managed app updates: a verified check plus the Tauri updater's own
//! download/install.
//!
//! The check path is Farfold's own: fetch the signed release document, verify
//! the `farfoldMetadata` envelope (bundle id/target/arch/version/artifact
//! signature bound to the release pubkey), and summarize the candidate. The
//! install path delegates to `tauri-plugin-updater`, which performs its own
//! signature-verified download before swapping the bundle and restarting.

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use minisign_verify::{PublicKey, Signature};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt as _;

use crate::update_feed::UpdateRelease;

const UPDATE_ENDPOINT: Option<&str> = option_env!("FARFOLD_UPDATE_ENDPOINT");
const UPDATE_PUBLIC_KEY: Option<&str> = option_env!("FARFOLD_UPDATE_PUBLIC_KEY");
const UPDATE_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RELEASE_NOTES_CHARS: usize = 4_000;

#[derive(Default)]
pub struct ManagedUpdateAuthority {
    checking: AtomicBool,
    installing: AtomicBool,
    candidate: Mutex<Option<ManagedUpdateCandidate>>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ManagedUpdateConfiguration {
    Configured,
    Unconfigured,
    Invalid,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ManagedUpdateBlocker {
    ReleaseInfrastructureUnconfigured,
    ReleaseInfrastructureInvalid,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedUpdateCandidate {
    candidate_token: String,
    current_version: String,
    version: String,
    target: String,
    notes: Option<String>,
    checked_at: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedUpdateSnapshot {
    configuration: ManagedUpdateConfiguration,
    checking: bool,
    installing: bool,
    current_version: &'static str,
    candidate: Option<ManagedUpdateCandidate>,
    blockers: Vec<ManagedUpdateBlocker>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedUpdateInstallInput {
    expected_candidate_token: String,
}

struct CheckGuard<'a>(&'a AtomicBool);
impl Drop for CheckGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

struct InstallGuard<'a>(&'a AtomicBool);
impl Drop for InstallGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn classify_update_configuration(
    endpoint: Option<&str>,
    public_key: Option<&str>,
) -> ManagedUpdateConfiguration {
    match (endpoint, public_key) {
        (Some(endpoint), Some(public_key))
            if endpoint.starts_with("https://") && !public_key.trim().is_empty() =>
        {
            ManagedUpdateConfiguration::Configured
        }
        (None, None) => ManagedUpdateConfiguration::Unconfigured,
        _ => ManagedUpdateConfiguration::Invalid,
    }
}

fn update_configuration() -> ManagedUpdateConfiguration {
    classify_update_configuration(UPDATE_ENDPOINT, UPDATE_PUBLIC_KEY)
}

fn update_transport_policy(app: &AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|plugin| plugin.get("dangerousAcceptInvalidCerts"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

fn candidate_token(update: &UpdateRelease) -> String {
    let mut digest = Sha256::new();
    for value in [
        update.current_version.as_str(),
        update.version.as_str(),
        update.target.as_str(),
        update.download_url.as_str(),
        update.signature.as_str(),
        update.raw_json["farfoldMetadata"]["payload"]
            .as_str()
            .unwrap_or_default(),
    ] {
        digest.update(value.len().to_be_bytes());
        digest.update(value.as_bytes());
    }
    let mut encoded = String::with_capacity(64);
    for byte in digest.finalize() {
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

fn bounded_notes(notes: Option<&str>) -> Option<String> {
    notes
        .map(str::trim)
        .filter(|notes| !notes.is_empty())
        .map(|notes| notes.chars().take(MAX_RELEASE_NOTES_CHARS).collect())
}

fn candidate_summary(update: &UpdateRelease) -> Result<ManagedUpdateCandidate, String> {
    if update.download_url.scheme() != "https" {
        return Err("Managed update candidate artifact URL must use HTTPS".to_string());
    }
    if update.signature.trim().is_empty() {
        return Err("Managed update candidate omitted its artifact signature".to_string());
    }
    Ok(ManagedUpdateCandidate {
        candidate_token: candidate_token(update),
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        target: update.target.clone(),
        notes: bounded_notes(update.body.as_deref()),
        checked_at: now_millis(),
    })
}

fn decode_tauri_minisign_document(value: &str, label: &str) -> Result<String, String> {
    let decoded = BASE64_STANDARD
        .decode(value)
        .map_err(|_| format!("Managed update {label} is not valid base64"))?;
    String::from_utf8(decoded).map_err(|_| format!("Managed update {label} is not valid UTF-8"))
}

/// Minisign verification shared with the signed-metadata envelope check.
pub(crate) fn verify_artifact_signature(
    artifact: &[u8],
    encoded_signature: &str,
    encoded_public_key: &str,
) -> Result<(), String> {
    let public_key = decode_tauri_minisign_document(encoded_public_key, "public key")?;
    let public_key = PublicKey::decode(&public_key)
        .map_err(|_| "Managed update public key is invalid".to_string())?;
    let signature = decode_tauri_minisign_document(encoded_signature, "signature")?;
    let signature = Signature::decode(&signature)
        .map_err(|_| "Managed update artifact signature is invalid".to_string())?;
    public_key
        .verify(artifact, &signature, true)
        .map_err(|_| "Managed update artifact signature verification failed".to_string())
}

fn verify_update_metadata(app: &AppHandle, update: &UpdateRelease) -> Result<(), String> {
    crate::update_metadata::verify(
        &update.raw_json,
        UPDATE_PUBLIC_KEY.ok_or_else(|| "Managed update public key is unavailable".to_string())?,
        crate::update_metadata::ExpectedRelease {
            bundle_id: &app.config().identifier,
            target: &update.target,
            arch: std::env::consts::ARCH,
            version: &update.version,
            url: update.download_url.as_str(),
            artifact_signature: &update.signature,
        },
        now_millis() / 1000,
    )
}

async fn check_configured_release(app: &AppHandle) -> Result<UpdateRelease, String> {
    if update_configuration() != ManagedUpdateConfiguration::Configured {
        return Err("Managed updates are not configured for this Farfold build".to_string());
    }
    crate::update_feed::fetch(
        UPDATE_ENDPOINT.expect("configured endpoint"),
        &app.package_info().version.to_string(),
        std::env::consts::ARCH,
        update_transport_policy(app),
        UPDATE_REQUEST_TIMEOUT,
    )
    .await
}

fn release_is_newer(current: &str, candidate: &str) -> Result<bool, String> {
    let current = semver::Version::parse(current)
        .map_err(|_| "Managed update current version is invalid".to_string())?;
    let candidate = semver::Version::parse(candidate)
        .map_err(|_| "Managed update candidate version is invalid".to_string())?;
    Ok(candidate.cmp_precedence(&current).is_gt())
}

fn snapshot(authority: &ManagedUpdateAuthority) -> Result<ManagedUpdateSnapshot, String> {
    let configuration = update_configuration();
    let mut blockers = Vec::new();
    match configuration {
        ManagedUpdateConfiguration::Configured => {}
        ManagedUpdateConfiguration::Unconfigured => {
            blockers.push(ManagedUpdateBlocker::ReleaseInfrastructureUnconfigured);
        }
        ManagedUpdateConfiguration::Invalid => {
            blockers.push(ManagedUpdateBlocker::ReleaseInfrastructureInvalid);
        }
    }
    let candidate = authority
        .candidate
        .lock()
        .map_err(|_| "Managed update candidate state is unavailable".to_string())?
        .clone();
    Ok(ManagedUpdateSnapshot {
        configuration,
        checking: authority.checking.load(Ordering::SeqCst),
        installing: authority.installing.load(Ordering::SeqCst),
        current_version: env!("CARGO_PKG_VERSION"),
        candidate,
        blockers,
    })
}

#[tauri::command]
pub fn managed_update_snapshot(
    authority: tauri::State<'_, ManagedUpdateAuthority>,
) -> Result<ManagedUpdateSnapshot, String> {
    snapshot(&authority)
}

#[tauri::command]
pub async fn managed_update_check(
    app: AppHandle,
    authority: tauri::State<'_, ManagedUpdateAuthority>,
) -> Result<ManagedUpdateSnapshot, String> {
    if authority.checking.swap(true, Ordering::SeqCst) {
        return Err("A managed update check is already running".to_string());
    }
    let _guard = CheckGuard(&authority.checking);
    let release = check_configured_release(&app).await?;
    verify_update_metadata(&app, &release)?;
    if !release_is_newer(&release.current_version, &release.version)? {
        authority
            .candidate
            .lock()
            .map_err(|_| "Managed update candidate state is unavailable".to_string())?
            .take();
        return snapshot(&authority);
    }
    let summary = candidate_summary(&release)?;
    *authority
        .candidate
        .lock()
        .map_err(|_| "Managed update candidate state is unavailable".to_string())? = Some(summary);
    snapshot(&authority)
}

#[tauri::command]
pub async fn managed_update_install(
    app: AppHandle,
    authority: tauri::State<'_, ManagedUpdateAuthority>,
    input: ManagedUpdateInstallInput,
) -> Result<(), String> {
    if input.expected_candidate_token.len() != 64 {
        return Err("Managed update candidate authorization is invalid".to_string());
    }
    let expected = {
        let candidate = authority
            .candidate
            .lock()
            .map_err(|_| "Managed update candidate state is unavailable".to_string())?;
        candidate.clone().ok_or_else(|| {
            "No verified managed update candidate is staged — run a check first".to_string()
        })?
    };
    if expected.candidate_token != input.expected_candidate_token {
        return Err("Managed update candidate authorization does not match".to_string());
    }
    if authority.installing.swap(true, Ordering::SeqCst) {
        return Err("A managed update install is already running".to_string());
    }
    let _guard = InstallGuard(&authority.installing);

    let updater = app
        .updater()
        .map_err(|_| "Managed updater is unavailable".to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|_| "Managed update recheck failed".to_string())?
        .ok_or_else(|| "Managed update candidate is no longer available".to_string())?;
    if update.version != expected.version {
        return Err(format!(
            "Managed update candidate changed since the check ({} -> {}) — recheck before installing",
            expected.version, update.version
        ));
    }
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|_| "Managed update install failed".to_string())?;
    app.restart();
}
