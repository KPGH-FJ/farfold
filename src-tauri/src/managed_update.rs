use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use minisign_verify::{PublicKey, Signature};
use reqwest::header::ACCEPT;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fmt::Write as _,
    process::{Command, Stdio},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{
    host_store::HostStore,
    interaction_registry::InteractionRegistry,
    opencode_runtime::{self, OpenCodeRuntime},
    pi_runtime::{self, PiRuntime},
    session_controller::HostSessionController,
    turn_coordinator::TurnCoordinator,
    update_candidate::{StagedCandidateBundle, stage_candidate_archive},
    update_recovery::{
        PrepareUpdateRecoveryInput, UpdateActivationIntent, activate_candidate_bundle,
        cancel_prepared_recovery_unit, current_committed_recovery, prepare_update_recovery_unit,
        request_post_commit_discard, request_post_commit_rollback, resume_post_commit_discard,
    },
};

const UPDATE_ENDPOINT: Option<&str> = option_env!("FARFOLD_UPDATE_ENDPOINT");
const UPDATE_PUBLIC_KEY: Option<&str> = option_env!("FARFOLD_UPDATE_PUBLIC_KEY");
const UPDATE_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RELEASE_NOTES_CHARS: usize = 4_000;
const MAX_UPDATE_ARTIFACT_BYTES: usize = 512 * 1024 * 1024;
const CANDIDATE_SMOKE_TIMEOUT: Duration = Duration::from_secs(30);
const POST_COMMIT_ROLLBACK_CONFIRMATION: &str = "ROLL BACK FARFOLD UPDATE";
const POST_COMMIT_DISCARD_CONFIRMATION: &str = "DISCARD FARFOLD UPDATE ROLLBACK";

struct CheckedUpdate {
    native: Update,
    summary: ManagedUpdateCandidate,
    artifact: Option<Vec<u8>>,
    staged: Option<StagedCandidateBundle>,
    recovery: Option<UpdateActivationIntent>,
}

#[derive(Default)]
pub struct ManagedUpdateAuthority {
    checking: AtomicBool,
    downloading: AtomicBool,
    preparing: AtomicBool,
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
    PostCommitRecoveryRetained,
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
    bundle_preflight_verified: bool,
    side_by_side_smoke_verified: bool,
    candidate_host_schema_version: Option<u64>,
    candidate_main_executable_sha256: Option<String>,
    activation_recovery_prepared: bool,
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
    preparing: bool,
    current_version: &'static str,
    candidate: Option<ManagedUpdateCandidate>,
    blockers: Vec<ManagedUpdateBlocker>,
    check_enabled: bool,
    download_enabled: bool,
    prepare_activation_enabled: bool,
    cancel_prepared_activation_enabled: bool,
    activate_enabled: bool,
    activation_preflight_clear: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedUpdateRecoverySnapshot {
    rollback_available: bool,
    operation_id: Option<String>,
    from_version: Option<String>,
    to_version: Option<String>,
    required_confirmation: &'static str,
    discard_enabled: bool,
    required_discard_confirmation: &'static str,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedUpdateRollbackInput {
    expected_operation_id: String,
    confirmation: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedUpdateDiscardRecoveryInput {
    expected_operation_id: String,
    confirmation: String,
}

#[derive(Debug, Clone, Copy)]
struct UpdateAdmission {
    configuration: ManagedUpdateConfiguration,
    host_ready: bool,
    active_turn_count: usize,
    pending_interaction_count: usize,
    pi_stopped: bool,
    opencode_stopped: bool,
    post_commit_recovery_retained: bool,
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

struct PreparingGuard<'a>(&'a AtomicBool);

impl Drop for PreparingGuard<'_> {
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

fn validate_candidate_authorization(value: &str) -> Result<(), String> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err("Managed update candidate authorization is invalid".to_string())
    }
}

fn validate_recovery_operation_id(value: &str) -> Result<(), String> {
    if !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'-')
    {
        Ok(())
    } else {
        Err("Managed update recovery operation ID is invalid".to_string())
    }
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
    if admission.post_commit_recovery_retained {
        blockers.push(ManagedUpdateBlocker::PostCommitRecoveryRetained);
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
        bundle_preflight_verified: false,
        side_by_side_smoke_verified: false,
        candidate_host_schema_version: None,
        candidate_main_executable_sha256: None,
        activation_recovery_prepared: false,
    })
}

fn artifact_buffer(content_length: Option<u64>, limit: usize) -> Result<Vec<u8>, String> {
    let announced = content_length
        .map(usize::try_from)
        .transpose()
        .map_err(|_| "Managed update artifact length is not representable".to_string())?;
    if announced.is_some_and(|length| length > limit) {
        return Err(format!(
            "Managed update artifact exceeds the {limit}-byte limit"
        ));
    }
    let capacity = announced.unwrap_or_default().min(limit);
    let mut artifact = Vec::new();
    artifact
        .try_reserve_exact(capacity)
        .map_err(|_| "Managed update artifact buffer cannot be reserved".to_string())?;
    Ok(artifact)
}

fn append_artifact_chunk(artifact: &mut Vec<u8>, chunk: &[u8], limit: usize) -> Result<(), String> {
    let next_length = artifact
        .len()
        .checked_add(chunk.len())
        .ok_or_else(|| "Managed update artifact length overflowed".to_string())?;
    if next_length > limit {
        return Err(format!(
            "Managed update artifact exceeds the {limit}-byte limit"
        ));
    }
    artifact
        .try_reserve(chunk.len())
        .map_err(|_| "Managed update artifact buffer cannot grow".to_string())?;
    artifact.extend_from_slice(chunk);
    Ok(())
}

fn decode_tauri_minisign_document(value: &str, label: &str) -> Result<String, String> {
    let decoded = BASE64_STANDARD
        .decode(value)
        .map_err(|_| format!("Managed update {label} is not valid base64"))?;
    String::from_utf8(decoded).map_err(|_| format!("Managed update {label} is not valid UTF-8"))
}

fn verify_artifact_signature(
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

async fn download_verified_artifact(update: &Update, public_key: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(2))
        .timeout(UPDATE_REQUEST_TIMEOUT)
        .build()
        .map_err(|_| "Cannot create managed update client".to_string())?;
    let mut response = client
        .get(update.download_url.clone())
        .header(ACCEPT, "application/octet-stream")
        .send()
        .await
        .map_err(|_| "Managed update download failed".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Managed update download returned HTTP {}",
            response.status()
        ));
    }
    let mut artifact = artifact_buffer(response.content_length(), MAX_UPDATE_ARTIFACT_BYTES)?;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Managed update download failed".to_string())?
    {
        append_artifact_chunk(&mut artifact, &chunk, MAX_UPDATE_ARTIFACT_BYTES)?;
    }
    verify_artifact_signature(&artifact, &update.signature, public_key)?;
    Ok(artifact)
}

fn run_candidate_smoke(staged: &StagedCandidateBundle, store: &HostStore) -> Result<(), String> {
    if !staged.app_path.is_dir() || !staged.main_executable_path.is_file() {
        return Err("Managed update candidate staging is unavailable".to_string());
    }
    let directory = tempfile::Builder::new()
        .prefix("farfold-update-smoke-")
        .tempdir()
        .map_err(|_| "Cannot reserve managed update smoke directory".to_string())?;
    let database_path = directory.path().join("farfold-host.sqlite3");
    store.create_consistent_snapshot(&database_path)?;
    let mut child = Command::new(&staged.main_executable_path)
        .arg(crate::MANAGED_UPDATE_SMOKE_ARGUMENT)
        .arg(&database_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Cannot start managed update candidate smoke".to_string())?;
    let deadline = Instant::now() + CANDIDATE_SMOKE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => {
                return Err("Managed update candidate smoke failed".to_string());
            }
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Managed update candidate smoke timed out".to_string());
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Cannot observe managed update candidate smoke".to_string());
            }
        }
    }
}

fn configured_updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    if update_configuration() != ManagedUpdateConfiguration::Configured {
        return Err("Managed updates are not configured for this Farfold build".to_string());
    }
    let endpoint = UPDATE_ENDPOINT.expect("configured endpoint");
    let public_key = UPDATE_PUBLIC_KEY.expect("configured public key");
    let endpoint = endpoint
        .parse()
        .map_err(|_| "Managed update endpoint is invalid".to_string())?;
    app.updater_builder()
        .pubkey(public_key)
        .endpoints(vec![endpoint])
        .map_err(|_| "Managed update endpoint was rejected".to_string())?
        .timeout(UPDATE_REQUEST_TIMEOUT)
        .build()
        .map_err(|_| "Cannot initialize managed updater".to_string())
}

#[allow(clippy::too_many_arguments)]
fn snapshot(
    app: &AppHandle,
    authority: &ManagedUpdateAuthority,
    store: &HostStore,
    turns: &TurnCoordinator,
    interactions: &InteractionRegistry,
    pi: &PiRuntime,
    opencode: &OpenCodeRuntime,
) -> Result<ManagedUpdateSnapshot, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Cannot resolve managed update recovery directory".to_string())?;
    let current_executable = std::env::current_exe()
        .map_err(|_| "Cannot resolve current Farfold executable".to_string())?;
    let admission = UpdateAdmission {
        configuration: update_configuration(),
        host_ready: store.is_ready()?,
        active_turn_count: turns.snapshot()?.active_turn_count(),
        pending_interaction_count: interactions.snapshots()?.len(),
        pi_stopped: pi_runtime::is_stopped(pi)?,
        opencode_stopped: opencode_runtime::is_stopped(opencode)?,
        post_commit_recovery_retained: current_committed_recovery(
            &app_data_dir,
            &current_executable,
        )?
        .is_some(),
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
            summary.bundle_preflight_verified = candidate.staged.is_some();
            summary.side_by_side_smoke_verified = candidate.staged.is_some();
            summary.candidate_host_schema_version = candidate
                .staged
                .as_ref()
                .map(|staged| staged.inspection.host_schema_version);
            summary.candidate_main_executable_sha256 = candidate
                .staged
                .as_ref()
                .map(|staged| staged.inspection.main_executable_sha256.clone());
            summary.activation_recovery_prepared = candidate.recovery.is_some();
            summary
        });
    let checking = authority.checking.load(Ordering::SeqCst);
    let downloading = authority.downloading.load(Ordering::SeqCst);
    let preparing = authority.preparing.load(Ordering::SeqCst);
    let recovery_prepared = candidate
        .as_ref()
        .is_some_and(|candidate| candidate.activation_recovery_prepared);
    let check_enabled = admission.configuration == ManagedUpdateConfiguration::Configured
        && admission.host_ready
        && !checking
        && !downloading
        && !preparing
        && !recovery_prepared
        && !admission.post_commit_recovery_retained;
    let download_enabled = candidate
        .as_ref()
        .is_some_and(|candidate| !candidate.artifact_verified)
        && admission.configuration == ManagedUpdateConfiguration::Configured
        && admission.host_ready
        && !checking
        && !downloading
        && !preparing
        && !recovery_prepared
        && !admission.post_commit_recovery_retained;
    let activation_preflight_clear = candidate.as_ref().is_some_and(|candidate| {
        candidate.artifact_verified
            && candidate.bundle_preflight_verified
            && candidate.side_by_side_smoke_verified
    }) && blockers.is_empty()
        && !checking
        && !downloading
        && !preparing;
    let prepare_activation_enabled = activation_preflight_clear && !recovery_prepared;
    let cancel_prepared_activation_enabled =
        recovery_prepared && !checking && !downloading && !preparing;
    let activate_enabled = activation_preflight_clear && recovery_prepared;
    Ok(ManagedUpdateSnapshot {
        channel: "stable",
        transport: "tauri_v2_updater",
        configuration: admission.configuration,
        checking,
        downloading,
        preparing,
        current_version: env!("CARGO_PKG_VERSION"),
        candidate,
        blockers,
        check_enabled,
        download_enabled,
        prepare_activation_enabled,
        cancel_prepared_activation_enabled,
        activate_enabled,
        activation_preflight_clear,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn managed_update_snapshot(
    app: AppHandle,
    controller: State<'_, HostSessionController>,
    authority: State<'_, ManagedUpdateAuthority>,
    store: State<'_, HostStore>,
    turns: State<'_, TurnCoordinator>,
    interactions: State<'_, InteractionRegistry>,
    pi: State<'_, PiRuntime>,
    opencode: State<'_, OpenCodeRuntime>,
) -> Result<ManagedUpdateSnapshot, String> {
    controller.inspect(|| {
        snapshot(
            &app,
            &authority,
            &store,
            &turns,
            &interactions,
            &pi,
            &opencode,
        )
    })
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
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Cannot resolve managed update recovery directory".to_string())?;
    let current_executable = std::env::current_exe()
        .map_err(|_| "Cannot resolve current Farfold executable".to_string())?;
    if current_committed_recovery(&app_data_dir, &current_executable)?.is_some() {
        return Err(
            "Accept or roll back the retained update recovery point before checking again"
                .to_string(),
        );
    }
    if authority.downloading.load(Ordering::SeqCst) {
        return Err("A managed update download is already running".to_string());
    }
    if authority.preparing.load(Ordering::SeqCst) {
        return Err("A managed update recovery preparation is already running".to_string());
    }
    if authority
        .candidate
        .lock()
        .map_err(|_| "Managed update candidate state is unavailable".to_string())?
        .as_ref()
        .is_some_and(|candidate| candidate.recovery.is_some())
    {
        return Err("A managed update activation is already prepared".to_string());
    }
    authority
        .checking
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "A managed update check is already running".to_string())?;
    let guard = CheckGuard(&authority.checking);
    let updater = configured_updater(&app)?;
    let update = updater
        .check()
        .await
        .map_err(|_| "Managed update check failed".to_string())?;
    let checked = update
        .map(|native| {
            let summary = candidate_summary(&native)?;
            Ok::<CheckedUpdate, String>(CheckedUpdate {
                native,
                summary,
                artifact: None,
                staged: None,
                recovery: None,
            })
        })
        .transpose()?;
    *authority
        .candidate
        .lock()
        .map_err(|_| "Managed update candidate state is unavailable".to_string())? = checked;
    drop(guard);
    snapshot(
        &app,
        &authority,
        &store,
        &turns,
        &interactions,
        &pi,
        &opencode,
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn managed_update_download(
    app: AppHandle,
    authority: State<'_, ManagedUpdateAuthority>,
    store: State<'_, HostStore>,
    turns: State<'_, TurnCoordinator>,
    interactions: State<'_, InteractionRegistry>,
    pi: State<'_, PiRuntime>,
    opencode: State<'_, OpenCodeRuntime>,
    input: ManagedUpdateDownloadInput,
) -> Result<ManagedUpdateSnapshot, String> {
    validate_candidate_authorization(&input.expected_candidate_token)?;
    if update_configuration() != ManagedUpdateConfiguration::Configured {
        return Err("Managed updates are not configured for this Farfold build".to_string());
    }
    if !store.is_ready()? {
        return Err("Managed update downloads are unavailable in Host recovery mode".to_string());
    }
    if authority.checking.load(Ordering::SeqCst) {
        return Err("A managed update check is already running".to_string());
    }
    if authority.preparing.load(Ordering::SeqCst) {
        return Err("A managed update recovery preparation is already running".to_string());
    }
    authority
        .downloading
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "A managed update download is already running".to_string())?;
    let guard = DownloadGuard(&authority.downloading);
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
    let public_key = UPDATE_PUBLIC_KEY.expect("configured public key");
    let artifact = download_verified_artifact(&update, public_key).await?;
    let expected_version = update.version.clone();
    let expected_bundle_id = app.config().identifier.clone();
    let smoke_store = store.inner().clone();
    let (artifact, staged) = tauri::async_runtime::spawn_blocking(move || {
        let staged = stage_candidate_archive(&artifact, &expected_version, &expected_bundle_id)?;
        run_candidate_smoke(&staged, &smoke_store)?;
        Ok::<_, String>((artifact, staged))
    })
    .await
    .map_err(|_| "Managed update candidate preflight did not complete".to_string())??;
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
        candidate.staged = Some(staged);
    }
    drop(guard);
    snapshot(
        &app,
        &authority,
        &store,
        &turns,
        &interactions,
        &pi,
        &opencode,
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn managed_update_prepare_activation(
    app: AppHandle,
    controller: State<'_, HostSessionController>,
    authority: State<'_, ManagedUpdateAuthority>,
    store: State<'_, HostStore>,
    turns: State<'_, TurnCoordinator>,
    interactions: State<'_, InteractionRegistry>,
    pi: State<'_, PiRuntime>,
    opencode: State<'_, OpenCodeRuntime>,
    input: ManagedUpdateDownloadInput,
) -> Result<ManagedUpdateSnapshot, String> {
    validate_candidate_authorization(&input.expected_candidate_token)?;
    if update_configuration() != ManagedUpdateConfiguration::Configured {
        return Err("Managed updates are not configured for this Farfold build".to_string());
    }
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Cannot resolve managed update recovery directory".to_string())?;
    let current_executable = std::env::current_exe()
        .map_err(|_| "Cannot resolve current Farfold executable".to_string())?;
    let current_schema = store.current_schema_version()?;
    if crate::host_store::portable_import_activation::has_pending_storage_activation(&app_data_dir)
    {
        return Err("Managed update conflicts with a pending Host storage activation".to_string());
    }
    let candidate_token = input.expected_candidate_token;
    let prepared_input = controller.begin_maintenance(&candidate_token, || {
        let current = snapshot(
            &app,
            &authority,
            &store,
            &turns,
            &interactions,
            &pi,
            &opencode,
        )?;
        if !current.prepare_activation_enabled {
            return Err("Managed update activation preflight is not clear".to_string());
        }
        authority
            .preparing
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "A managed update recovery preparation is already running".to_string())?;
        if let Err(error) = turns.begin_maintenance(&candidate_token) {
            authority.preparing.store(false, Ordering::SeqCst);
            return Err(error);
        }
        if let Err(error) = store.begin_maintenance(&candidate_token) {
            let _ = turns.end_maintenance(&candidate_token);
            authority.preparing.store(false, Ordering::SeqCst);
            return Err(error);
        }
        let admission_still_clear = (|| -> Result<bool, String> {
            Ok(
                !crate::host_store::portable_import_activation::has_pending_storage_activation(
                    &app_data_dir,
                ) && interactions.snapshots()?.is_empty()
                    && pi_runtime::is_stopped(&pi)?
                    && opencode_runtime::is_stopped(&opencode)?,
            )
        })();
        if !matches!(admission_still_clear, Ok(true)) {
            let _ = store.end_maintenance(&candidate_token);
            let _ = turns.end_maintenance(&candidate_token);
            authority.preparing.store(false, Ordering::SeqCst);
            return match admission_still_clear {
                Ok(false) => {
                    Err("Managed update activation state changed during admission".to_string())
                }
                Err(error) => Err(error),
                Ok(true) => unreachable!(),
            };
        }
        let result = (|| {
            let mut candidate = authority
                .candidate
                .lock()
                .map_err(|_| "Managed update candidate state is unavailable".to_string())?;
            let candidate = candidate
                .as_mut()
                .ok_or_else(|| "No managed update candidate has been checked".to_string())?;
            if candidate.summary.candidate_token != candidate_token {
                return Err("Managed update candidate authorization is stale".to_string());
            }
            let artifact = candidate
                .artifact
                .take()
                .ok_or_else(|| "Managed update candidate artifact is unavailable".to_string())?;
            let staged = candidate
                .staged
                .as_ref()
                .ok_or_else(|| "Managed update candidate staging is unavailable".to_string())?;
            Ok((
                artifact,
                candidate.summary.current_version.clone(),
                candidate.summary.version.clone(),
                staged.inspection.bundle_id.clone(),
                staged.inspection.main_executable_sha256.clone(),
                staged.inspection.host_schema_version,
            ))
        })();
        if result.is_err() {
            let _ = store.end_maintenance(&candidate_token);
            let _ = turns.end_maintenance(&candidate_token);
            authority.preparing.store(false, Ordering::SeqCst);
        }
        result
    });

    let (artifact, from_version, to_version, bundle_id, candidate_main, candidate_schema) =
        match prepared_input {
            Ok(value) => value,
            Err(error) => return Err(error),
        };
    let preparing_guard = PreparingGuard(&authority.preparing);
    let recovery_store = store.inner().clone();
    let token_for_prepare = candidate_token.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        let result = prepare_update_recovery_unit(
            &recovery_store,
            PrepareUpdateRecoveryInput {
                app_data_dir: &app_data_dir,
                current_executable: &current_executable,
                artifact: &artifact,
                candidate_token: &token_for_prepare,
                from_version: &from_version,
                to_version: &to_version,
                bundle_id: &bundle_id,
                candidate_main_sha256: &candidate_main,
                current_host_schema_version: current_schema,
                candidate_host_schema_version: candidate_schema,
            },
        );
        (artifact, result)
    })
    .await
    .map_err(|_| "Managed update recovery preparation did not complete".to_string());

    let mut preparation_error = None;
    match prepared {
        Ok((artifact, result)) => {
            let mut candidate = authority
                .candidate
                .lock()
                .map_err(|_| "Managed update candidate state is unavailable".to_string())?;
            let candidate = candidate
                .as_mut()
                .ok_or_else(|| "Managed update candidate changed during preparation".to_string())?;
            candidate.artifact = Some(artifact);
            match result {
                Ok(intent) if candidate.summary.candidate_token == candidate_token => {
                    candidate.recovery = Some(intent);
                }
                Ok(_) => {
                    preparation_error =
                        Some("Managed update candidate changed during preparation".to_string());
                }
                Err(error) => preparation_error = Some(error),
            }
        }
        Err(error) => preparation_error = Some(error),
    }
    if let Some(error) = preparation_error {
        if let Err(cleanup) = controller.finish_maintenance(&candidate_token, || {
            store.end_maintenance(&candidate_token)?;
            turns.end_maintenance(&candidate_token)
        }) {
            return Err(format!(
                "{error}; Host maintenance cleanup failed: {cleanup}"
            ));
        }
        return Err(error);
    }
    drop(preparing_guard);
    snapshot(
        &app,
        &authority,
        &store,
        &turns,
        &interactions,
        &pi,
        &opencode,
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn managed_update_cancel_prepared_activation(
    app: AppHandle,
    controller: State<'_, HostSessionController>,
    authority: State<'_, ManagedUpdateAuthority>,
    store: State<'_, HostStore>,
    turns: State<'_, TurnCoordinator>,
    interactions: State<'_, InteractionRegistry>,
    pi: State<'_, PiRuntime>,
    opencode: State<'_, OpenCodeRuntime>,
    input: ManagedUpdateDownloadInput,
) -> Result<ManagedUpdateSnapshot, String> {
    validate_candidate_authorization(&input.expected_candidate_token)?;
    if authority.preparing.load(Ordering::SeqCst) {
        return Err("Managed update recovery preparation is still running".to_string());
    }
    let candidate_token = input.expected_candidate_token;
    controller.finish_maintenance(&candidate_token, || {
        {
            let candidate = authority
                .candidate
                .lock()
                .map_err(|_| "Managed update candidate state is unavailable".to_string())?;
            let candidate = candidate
                .as_ref()
                .ok_or_else(|| "No managed update candidate has been checked".to_string())?;
            if candidate.summary.candidate_token != candidate_token || candidate.recovery.is_none()
            {
                return Err("Managed update cancellation authorization is stale".to_string());
            }
        }
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|_| "Cannot resolve managed update recovery directory".to_string())?;
        if !cancel_prepared_recovery_unit(&app_data_dir, &candidate_token)? {
            return Err("Managed update recovery preparation is missing".to_string());
        }
        let mut candidate = authority
            .candidate
            .lock()
            .map_err(|_| "Managed update candidate state is unavailable".to_string())?;
        if let Some(candidate) = candidate.as_mut() {
            candidate.recovery = None;
        }
        store.end_maintenance(&candidate_token)?;
        turns.end_maintenance(&candidate_token)?;
        snapshot(
            &app,
            &authority,
            &store,
            &turns,
            &interactions,
            &pi,
            &opencode,
        )
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn managed_update_activate(
    app: AppHandle,
    controller: State<'_, HostSessionController>,
    authority: State<'_, ManagedUpdateAuthority>,
    store: State<'_, HostStore>,
    turns: State<'_, TurnCoordinator>,
    interactions: State<'_, InteractionRegistry>,
    pi: State<'_, PiRuntime>,
    opencode: State<'_, OpenCodeRuntime>,
    input: ManagedUpdateDownloadInput,
) -> Result<(), String> {
    validate_candidate_authorization(&input.expected_candidate_token)?;
    if authority.preparing.load(Ordering::SeqCst) {
        return Err("Managed update recovery preparation is still running".to_string());
    }
    let candidate_token = input.expected_candidate_token;
    controller.with_maintenance(&candidate_token, || {
        let current = snapshot(
            &app,
            &authority,
            &store,
            &turns,
            &interactions,
            &pi,
            &opencode,
        )?;
        if !current.activate_enabled {
            return Err("Managed update activation is not ready".to_string());
        }
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|_| "Cannot resolve managed update recovery directory".to_string())?;
        let current_executable = std::env::current_exe()
            .map_err(|_| "Cannot resolve current Farfold executable".to_string())?;
        let mut candidate = authority
            .candidate
            .lock()
            .map_err(|_| "Managed update candidate state is unavailable".to_string())?;
        let candidate = candidate
            .as_mut()
            .ok_or_else(|| "No managed update candidate has been checked".to_string())?;
        if candidate.summary.candidate_token != candidate_token {
            return Err("Managed update candidate authorization is stale".to_string());
        }
        let intent = candidate
            .recovery
            .as_ref()
            .ok_or_else(|| "Managed update recovery preparation is missing".to_string())?;
        let staged = candidate
            .staged
            .as_ref()
            .ok_or_else(|| "Managed update candidate staging is unavailable".to_string())?;
        let installed = activate_candidate_bundle(
            &app_data_dir,
            &current_executable,
            &staged.app_path,
            &staged.main_executable_path,
            intent,
        )?;
        candidate.recovery = Some(installed);
        Ok(())
    })?;
    app.restart()
}

#[tauri::command]
pub fn managed_update_recovery_snapshot(
    app: AppHandle,
    controller: State<'_, HostSessionController>,
) -> Result<ManagedUpdateRecoverySnapshot, String> {
    controller.inspect(|| recovery_snapshot(&app))
}

fn recovery_snapshot(app: &AppHandle) -> Result<ManagedUpdateRecoverySnapshot, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Cannot resolve managed update recovery directory".to_string())?;
    let current_executable = std::env::current_exe()
        .map_err(|_| "Cannot resolve current Farfold executable".to_string())?;
    let recovery = current_committed_recovery(&app_data_dir, &current_executable)?;
    Ok(ManagedUpdateRecoverySnapshot {
        rollback_available: recovery.is_some(),
        operation_id: recovery.as_ref().map(|intent| intent.operation_id.clone()),
        from_version: recovery.as_ref().map(|intent| intent.from_version.clone()),
        to_version: recovery.as_ref().map(|intent| intent.to_version.clone()),
        required_confirmation: POST_COMMIT_ROLLBACK_CONFIRMATION,
        discard_enabled: recovery.is_some(),
        required_discard_confirmation: POST_COMMIT_DISCARD_CONFIRMATION,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn managed_update_request_rollback(
    app: AppHandle,
    controller: State<'_, HostSessionController>,
    authority: State<'_, ManagedUpdateAuthority>,
    store: State<'_, HostStore>,
    turns: State<'_, TurnCoordinator>,
    interactions: State<'_, InteractionRegistry>,
    pi: State<'_, PiRuntime>,
    opencode: State<'_, OpenCodeRuntime>,
    input: ManagedUpdateRollbackInput,
) -> Result<(), String> {
    validate_recovery_operation_id(&input.expected_operation_id)?;
    if input.confirmation != POST_COMMIT_ROLLBACK_CONFIRMATION {
        return Err("Managed update rollback confirmation does not match".to_string());
    }
    if authority.checking.load(Ordering::SeqCst)
        || authority.downloading.load(Ordering::SeqCst)
        || authority.preparing.load(Ordering::SeqCst)
    {
        return Err("Managed update work is still active".to_string());
    }
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Cannot resolve managed update recovery directory".to_string())?;
    let current_executable = std::env::current_exe()
        .map_err(|_| "Cannot resolve current Farfold executable".to_string())?;
    let recovery = current_committed_recovery(&app_data_dir, &current_executable)?
        .ok_or_else(|| "No rollback point matches the current Farfold build".to_string())?;
    let token = recovery.candidate_token.clone();
    controller.begin_maintenance(&token, || {
        if recovery.operation_id != input.expected_operation_id
            || !store.is_ready()?
            || turns.snapshot()?.active_turn_count() != 0
            || !interactions.snapshots()?.is_empty()
            || !pi_runtime::is_stopped(&pi)?
            || !opencode_runtime::is_stopped(&opencode)?
            || crate::host_store::portable_import_activation::has_pending_storage_activation(
                &app_data_dir,
            )
        {
            return Err("Managed update rollback admission is not clear".to_string());
        }
        turns.begin_maintenance(&token)?;
        if let Err(error) = store.begin_maintenance(&token) {
            let _ = turns.end_maintenance(&token);
            return Err(error);
        }
        let requested = (|| {
            if !interactions.snapshots()?.is_empty()
                || !pi_runtime::is_stopped(&pi)?
                || !opencode_runtime::is_stopped(&opencode)?
                || crate::host_store::portable_import_activation::has_pending_storage_activation(
                    &app_data_dir,
                )
            {
                return Err("Managed update rollback state changed during admission".to_string());
            }
            request_post_commit_rollback(
                &app_data_dir,
                &current_executable,
                &input.expected_operation_id,
            )?;
            Ok(())
        })();
        if requested.is_err() {
            let _ = store.end_maintenance(&token);
            let _ = turns.end_maintenance(&token);
        }
        requested
    })?;
    app.restart()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn managed_update_discard_recovery(
    app: AppHandle,
    controller: State<'_, HostSessionController>,
    authority: State<'_, ManagedUpdateAuthority>,
    store: State<'_, HostStore>,
    turns: State<'_, TurnCoordinator>,
    interactions: State<'_, InteractionRegistry>,
    pi: State<'_, PiRuntime>,
    opencode: State<'_, OpenCodeRuntime>,
    input: ManagedUpdateDiscardRecoveryInput,
) -> Result<ManagedUpdateRecoverySnapshot, String> {
    validate_recovery_operation_id(&input.expected_operation_id)?;
    if input.confirmation != POST_COMMIT_DISCARD_CONFIRMATION {
        return Err("Managed update recovery discard confirmation does not match".to_string());
    }
    if authority.checking.load(Ordering::SeqCst)
        || authority.downloading.load(Ordering::SeqCst)
        || authority.preparing.load(Ordering::SeqCst)
    {
        return Err("Managed update work is still active".to_string());
    }
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Cannot resolve managed update recovery directory".to_string())?;
    let current_executable = std::env::current_exe()
        .map_err(|_| "Cannot resolve current Farfold executable".to_string())?;
    let recovery = current_committed_recovery(&app_data_dir, &current_executable)?
        .ok_or_else(|| "No rollback point matches the current Farfold build".to_string())?;
    let token = recovery.candidate_token.clone();
    controller.exclusive(|| {
        if recovery.operation_id != input.expected_operation_id
            || !store.is_ready()?
            || turns.snapshot()?.active_turn_count() != 0
            || !interactions.snapshots()?.is_empty()
            || !pi_runtime::is_stopped(&pi)?
            || !opencode_runtime::is_stopped(&opencode)?
            || crate::host_store::portable_import_activation::has_pending_storage_activation(
                &app_data_dir,
            )
        {
            return Err("Managed update recovery discard admission is not clear".to_string());
        }
        turns.begin_maintenance(&token)?;
        if let Err(error) = store.begin_maintenance(&token) {
            let _ = turns.end_maintenance(&token);
            return Err(error);
        }
        let discarded = (|| {
            if !interactions.snapshots()?.is_empty()
                || !pi_runtime::is_stopped(&pi)?
                || !opencode_runtime::is_stopped(&opencode)?
                || crate::host_store::portable_import_activation::has_pending_storage_activation(
                    &app_data_dir,
                )
            {
                return Err(
                    "Managed update recovery discard state changed during admission".to_string(),
                );
            }
            request_post_commit_discard(
                &app_data_dir,
                &current_executable,
                &input.expected_operation_id,
            )?;
            if !resume_post_commit_discard(&app_data_dir, &current_executable)? {
                return Err("Managed update recovery discard intent disappeared".to_string());
            }
            Ok(())
        })();
        let store_cleanup = store.end_maintenance(&token);
        let turn_cleanup = turns.end_maintenance(&token);
        discarded?;
        store_cleanup?;
        turn_cleanup?;
        Ok(())
    })?;
    recovery_snapshot(&app)
}

#[cfg(test)]
mod tests {
    use super::{
        BASE64_STANDARD, ManagedUpdateBlocker, ManagedUpdateConfiguration, UpdateAdmission,
        admission_blockers, append_artifact_chunk, artifact_buffer, bounded_notes,
        classify_update_configuration, decode_tauri_minisign_document,
        validate_candidate_authorization, validate_recovery_operation_id,
        verify_artifact_signature,
    };
    use base64::Engine as _;

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
                post_commit_recovery_retained: false,
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
                post_commit_recovery_retained: true,
            }),
            vec![
                ManagedUpdateBlocker::HostStorageRecovery,
                ManagedUpdateBlocker::ActiveTurns,
                ManagedUpdateBlocker::PendingInteractions,
                ManagedUpdateBlocker::PiRuntimeNotStopped,
                ManagedUpdateBlocker::OpenCodeRuntimeNotStopped,
                ManagedUpdateBlocker::PostCommitRecoveryRetained,
            ]
        );
    }

    #[test]
    fn release_notes_are_bounded_before_crossing_ipc() {
        let notes = "x".repeat(4_010);
        assert_eq!(bounded_notes(Some(&notes)).unwrap().chars().count(), 4_000);
        assert_eq!(bounded_notes(Some("  hello  ")).as_deref(), Some("hello"));
    }

    #[test]
    fn update_authorizations_are_bounded_before_state_access() {
        assert!(validate_candidate_authorization(&"a".repeat(64)).is_ok());
        assert!(validate_candidate_authorization(&"A".repeat(64)).is_err());
        assert!(validate_candidate_authorization(&"a".repeat(65)).is_err());
        assert!(validate_recovery_operation_id("123-456-0").is_ok());
        assert!(validate_recovery_operation_id("../Current.app").is_err());
        assert!(validate_recovery_operation_id(&"1".repeat(97)).is_err());
    }

    #[test]
    fn artifact_allocation_is_bounded_before_and_during_download() {
        assert!(artifact_buffer(Some(9), 8).is_err());
        let mut artifact = artifact_buffer(Some(4), 8).unwrap();
        append_artifact_chunk(&mut artifact, b"1234", 8).unwrap();
        append_artifact_chunk(&mut artifact, b"5678", 8).unwrap();
        assert_eq!(artifact, b"12345678");
        assert!(append_artifact_chunk(&mut artifact, b"9", 8).is_err());
        assert_eq!(artifact, b"12345678");
    }

    #[test]
    fn malformed_tauri_signature_material_fails_closed() {
        assert!(decode_tauri_minisign_document("not base64", "signature").is_err());
        assert!(verify_artifact_signature(b"artifact", "bm90IGEgc2ln", "bm90IGEga2V5").is_err());
    }

    #[test]
    fn tauri_signature_material_verifies_and_detects_tampering() {
        let public_key = "untrusted comment: minisign public key E7620F1842B4E81F\n\
RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
        let signature = "untrusted comment: signature from minisign secret key\n\
RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\n\
trusted comment: timestamp:1555779966\tfile:test\n\
QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";
        let encoded_public_key = BASE64_STANDARD.encode(public_key);
        let encoded_signature = BASE64_STANDARD.encode(signature);
        verify_artifact_signature(b"test", &encoded_signature, &encoded_public_key).unwrap();
        assert!(
            verify_artifact_signature(b"tampered", &encoded_signature, &encoded_public_key)
                .is_err()
        );
    }
}
