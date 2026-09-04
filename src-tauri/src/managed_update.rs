use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fmt::Write as _,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{
    host_store::HostStore,
    interaction_registry::InteractionRegistry,
    opencode_runtime::{self, OpenCodeRuntime},
    pi_runtime::{self, PiRuntime},
    session_controller::HostSessionController,
    turn_coordinator::TurnCoordinator,
};

const UPDATE_ENDPOINT: Option<&str> = option_env!("FARFOLD_UPDATE_ENDPOINT");
const UPDATE_PUBLIC_KEY: Option<&str> = option_env!("FARFOLD_UPDATE_PUBLIC_KEY");
const UPDATE_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RELEASE_NOTES_CHARS: usize = 4_000;
const MAX_UPDATE_ARTIFACT_BYTES: usize = 512 * 1024 * 1024;

struct CheckedUpdate {
    native: Update,
    summary: ManagedUpdateCandidate,
    artifact: Option<Vec<u8>>,
}

#[derive(Default)]
pub struct ManagedUpdateAuthority {
    checking: AtomicBool,
    downloading: AtomicBool,
    candidate: Mutex<Option<CheckedUpdate>>,
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
    HostStorageRecovery,
    ActiveTurns,
    PendingInteractions,
    PiRuntimeNotStopped,
    OpenCodeRuntimeNotStopped,
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
    artifact_verified: bool,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedUpdateDownloadInput {
    expected_candidate_token: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedUpdateSnapshot {
    channel: &'static str,
    transport: &'static str,
    configuration: ManagedUpdateConfiguration,
    checking: bool,
    downloading: bool,
    current_version: &'static str,
    candidate: Option<ManagedUpdateCandidate>,
    blockers: Vec<ManagedUpdateBlocker>,
    check_enabled: bool,
    download_enabled: bool,
    activation_preflight_clear: bool,
}

#[derive(Debug, Clone, Copy)]
struct UpdateAdmission {
    configuration: ManagedUpdateConfiguration,
    host_ready: bool,
    active_turn_count: usize,
    pending_interaction_count: usize,
    pi_stopped: bool,
    opencode_stopped: bool,
}

struct CheckGuard<'a>(&'a AtomicBool);

impl Drop for CheckGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

struct DownloadGuard<'a>(&'a AtomicBool);

impl Drop for DownloadGuard<'_> {
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

fn admission_blockers(admission: UpdateAdmission) -> Vec<ManagedUpdateBlocker> {
    let mut blockers = Vec::new();
    match admission.configuration {
        ManagedUpdateConfiguration::Configured => {}
        ManagedUpdateConfiguration::Unconfigured => {
            blockers.push(ManagedUpdateBlocker::ReleaseInfrastructureUnconfigured);
        }
        ManagedUpdateConfiguration::Invalid => {
            blockers.push(ManagedUpdateBlocker::ReleaseInfrastructureInvalid);
        }
    }
    if !admission.host_ready {
        blockers.push(ManagedUpdateBlocker::HostStorageRecovery);
    }
    if admission.active_turn_count > 0 {
        blockers.push(ManagedUpdateBlocker::ActiveTurns);
    }
    if admission.pending_interaction_count > 0 {
        blockers.push(ManagedUpdateBlocker::PendingInteractions);
    }
    if !admission.pi_stopped {
        blockers.push(ManagedUpdateBlocker::PiRuntimeNotStopped);
    }
    if !admission.opencode_stopped {
        blockers.push(ManagedUpdateBlocker::OpenCodeRuntimeNotStopped);
    }
    blockers
}

fn candidate_token(update: &Update) -> String {
    let mut digest = Sha256::new();
    for value in [
        update.current_version.as_str(),
        update.version.as_str(),
        update.target.as_str(),
        update.download_url.as_str(),
        update.signature.as_str(),
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

fn candidate_summary(update: &Update) -> Result<ManagedUpdateCandidate, String> {
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
        artifact_verified: false,
    })
}

fn configured_updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    if update_configuration() != ManagedUpdateConfiguration::Configured {
        return Err("Managed updates are not configured for this Farfold build".to_string());
    }
    let endpoint = UPDATE_ENDPOINT.expect("configured endpoint");
    let public_key = UPDATE_PUBLIC_KEY.expect("configured public key");
    let endpoint = endpoint
        .parse()
        .map_err(|error| format!("Managed update endpoint is invalid: {error}"))?;
    app.updater_builder()
        .pubkey(public_key)
        .endpoints(vec![endpoint])
        .map_err(|error| format!("Managed update endpoint was rejected: {error}"))?
        .timeout(UPDATE_REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("Cannot initialize managed updater: {error}"))
}

#[allow(clippy::too_many_arguments)]
fn snapshot(
    authority: &ManagedUpdateAuthority,
    store: &HostStore,
    turns: &TurnCoordinator,
    interactions: &InteractionRegistry,
    pi: &PiRuntime,
    opencode: &OpenCodeRuntime,
) -> Result<ManagedUpdateSnapshot, String> {
    let admission = UpdateAdmission {
        configuration: update_configuration(),
        host_ready: store.is_ready()?,
        active_turn_count: turns.snapshot()?.active_turn_count(),
        pending_interaction_count: interactions.snapshots()?.len(),
        pi_stopped: pi_runtime::is_stopped(pi)?,
        opencode_stopped: opencode_runtime::is_stopped(opencode)?,
    };
    let blockers = admission_blockers(admission);
    let candidate = authority
        .candidate
        .lock()
        .map_err(|_| "Managed update candidate state is unavailable".to_string())?
        .as_ref()
        .map(|candidate| {
            let mut summary = candidate.summary.clone();
            summary.artifact_verified = candidate.artifact.is_some();
            summary
        });
    let checking = authority.checking.load(Ordering::SeqCst);
    let downloading = authority.downloading.load(Ordering::SeqCst);
    let check_enabled = admission.configuration == ManagedUpdateConfiguration::Configured
        && admission.host_ready
        && !checking
        && !downloading;
    let download_enabled = candidate
        .as_ref()
        .is_some_and(|candidate| !candidate.artifact_verified)
        && admission.configuration == ManagedUpdateConfiguration::Configured
        && admission.host_ready
        && !checking
        && !downloading;
    let activation_preflight_clear = candidate
        .as_ref()
        .is_some_and(|candidate| candidate.artifact_verified)
        && blockers.is_empty()
        && !checking
        && !downloading;
    Ok(ManagedUpdateSnapshot {
        channel: "stable",
        transport: "tauri_v2_updater",
        configuration: admission.configuration,
        checking,
        downloading,
        current_version: env!("CARGO_PKG_VERSION"),
        candidate,
        blockers,
        check_enabled,
        download_enabled,
        activation_preflight_clear,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn managed_update_snapshot(
    controller: State<'_, HostSessionController>,
    authority: State<'_, ManagedUpdateAuthority>,
    store: State<'_, HostStore>,
    turns: State<'_, TurnCoordinator>,
    interactions: State<'_, InteractionRegistry>,
    pi: State<'_, PiRuntime>,
    opencode: State<'_, OpenCodeRuntime>,
) -> Result<ManagedUpdateSnapshot, String> {
    controller.exclusive(|| snapshot(&authority, &store, &turns, &interactions, &pi, &opencode))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn managed_update_check(
    app: AppHandle,
    authority: State<'_, ManagedUpdateAuthority>,
    store: State<'_, HostStore>,
    turns: State<'_, TurnCoordinator>,
    interactions: State<'_, InteractionRegistry>,
    pi: State<'_, PiRuntime>,
    opencode: State<'_, OpenCodeRuntime>,
) -> Result<ManagedUpdateSnapshot, String> {
    if update_configuration() != ManagedUpdateConfiguration::Configured {
        return Err("Managed updates are not configured for this Farfold build".to_string());
    }
    if !store.is_ready()? {
        return Err("Managed update checks are unavailable in Host recovery mode".to_string());
    }
    if authority.downloading.load(Ordering::SeqCst) {
        return Err("A managed update download is already running".to_string());
    }
    authority
        .checking
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "A managed update check is already running".to_string())?;
    let _guard = CheckGuard(&authority.checking);
    let updater = configured_updater(&app)?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("Managed update check failed: {error}"))?;
    let checked = update
        .map(|native| {
            let summary = candidate_summary(&native)?;
            Ok::<CheckedUpdate, String>(CheckedUpdate {
                native,
                summary,
                artifact: None,
            })
        })
        .transpose()?;
    *authority
        .candidate
        .lock()
        .map_err(|_| "Managed update candidate state is unavailable".to_string())? = checked;
    snapshot(&authority, &store, &turns, &interactions, &pi, &opencode)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn managed_update_download(
    authority: State<'_, ManagedUpdateAuthority>,
    store: State<'_, HostStore>,
    turns: State<'_, TurnCoordinator>,
    interactions: State<'_, InteractionRegistry>,
    pi: State<'_, PiRuntime>,
    opencode: State<'_, OpenCodeRuntime>,
    input: ManagedUpdateDownloadInput,
) -> Result<ManagedUpdateSnapshot, String> {
    if update_configuration() != ManagedUpdateConfiguration::Configured {
        return Err("Managed updates are not configured for this Farfold build".to_string());
    }
    if !store.is_ready()? {
        return Err("Managed update downloads are unavailable in Host recovery mode".to_string());
    }
    if authority.checking.load(Ordering::SeqCst) {
        return Err("A managed update check is already running".to_string());
    }
    authority
        .downloading
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "A managed update download is already running".to_string())?;
    let _guard = DownloadGuard(&authority.downloading);
    let update = {
        let candidate = authority
            .candidate
            .lock()
            .map_err(|_| "Managed update candidate state is unavailable".to_string())?;
        let candidate = candidate
            .as_ref()
            .ok_or_else(|| "No managed update candidate has been checked".to_string())?;
        if candidate.summary.candidate_token != input.expected_candidate_token {
            return Err("Managed update candidate authorization is stale".to_string());
        }
        if candidate.artifact.is_some() {
            return Err("Managed update candidate artifact is already verified".to_string());
        }
        candidate.native.clone()
    };
    let artifact = update.download(|_, _| {}, || {}).await.map_err(|error| {
        format!("Managed update download or signature verification failed: {error}")
    })?;
    if artifact.len() > MAX_UPDATE_ARTIFACT_BYTES {
        return Err(format!(
            "Managed update artifact exceeds the {MAX_UPDATE_ARTIFACT_BYTES}-byte limit"
        ));
    }
    {
        let mut candidate = authority
            .candidate
            .lock()
            .map_err(|_| "Managed update candidate state is unavailable".to_string())?;
        let candidate = candidate
            .as_mut()
            .ok_or_else(|| "Managed update candidate changed during download".to_string())?;
        if candidate.summary.candidate_token != input.expected_candidate_token {
            return Err("Managed update candidate changed during download".to_string());
        }
        candidate.artifact = Some(artifact);
    }
    snapshot(&authority, &store, &turns, &interactions, &pi, &opencode)
}

#[cfg(test)]
mod tests {
    use super::{
        ManagedUpdateBlocker, ManagedUpdateConfiguration, UpdateAdmission, admission_blockers,
        bounded_notes, classify_update_configuration,
    };

    #[test]
    fn current_build_reports_missing_release_infrastructure_truthfully() {
        assert_eq!(
            classify_update_configuration(None, None),
            ManagedUpdateConfiguration::Unconfigured
        );
        assert_eq!(
            admission_blockers(UpdateAdmission {
                configuration: classify_update_configuration(None, None),
                host_ready: true,
                active_turn_count: 0,
                pending_interaction_count: 0,
                pi_stopped: true,
                opencode_stopped: true,
            }),
            vec![ManagedUpdateBlocker::ReleaseInfrastructureUnconfigured]
        );
    }

    #[test]
    fn activation_admission_names_every_live_state_blocker() {
        assert_eq!(
            admission_blockers(UpdateAdmission {
                configuration: ManagedUpdateConfiguration::Configured,
                host_ready: false,
                active_turn_count: 1,
                pending_interaction_count: 2,
                pi_stopped: false,
                opencode_stopped: false,
            }),
            vec![
                ManagedUpdateBlocker::HostStorageRecovery,
                ManagedUpdateBlocker::ActiveTurns,
                ManagedUpdateBlocker::PendingInteractions,
                ManagedUpdateBlocker::PiRuntimeNotStopped,
                ManagedUpdateBlocker::OpenCodeRuntimeNotStopped,
            ]
        );
    }

    #[test]
    fn release_notes_are_bounded_before_crossing_ipc() {
        let notes = "x".repeat(4_010);
        assert_eq!(bounded_notes(Some(&notes)).unwrap().chars().count(), 4_000);
        assert_eq!(bounded_notes(Some("  hello  ")).as_deref(), Some("hello"));
    }
}
