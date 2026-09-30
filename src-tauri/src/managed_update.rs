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
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt as _;

use crate::update_feed::UpdateRelease;

const UPDATE_ENDPOINT: Option<&str> = option_env!("FARFOLD_UPDATE_ENDPOINT");
const UPDATE_PUBLIC_KEY: Option<&str> = option_env!("FARFOLD_UPDATE_PUBLIC_KEY");
const UPDATE_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RELEASE_NOTES_CHARS: usize = 4_000;

/// A short-lived admission gate shared by existing work owners. It stores no
/// work history and never gates settings writes, approvals or stopping work.
#[derive(Default)]
pub(crate) struct UpdateAdmission(Arc<tokio::sync::RwLock<()>>);
pub(crate) type ActivityPermit = tokio::sync::OwnedRwLockReadGuard<()>;
type UpdatePermit = tokio::sync::OwnedRwLockWriteGuard<()>;
impl UpdateAdmission {
    pub(crate) fn activity(&self) -> Result<ActivityPermit, String> {
        self.0
            .clone()
            .try_read_owned()
            .map_err(|_| "正在更新应用，请等待重新打开后再开始操作".into())
    }
    pub(crate) fn update(&self) -> Result<UpdatePermit, String> {
        self.0.clone().try_write_owned().map_err(|_| {
            "请先完成当前任务、待处理事项、账号设置和安装，并确认未知结果后再更新".into()
        })
    }
}
fn admission() -> &'static UpdateAdmission {
    static GATE: OnceLock<UpdateAdmission> = OnceLock::new();
    GATE.get_or_init(Default::default)
}
pub(crate) fn activity() -> Result<ActivityPermit, String> {
    admission().activity()
}

#[derive(Default)]
pub struct ManagedUpdateAuthority {
    state: Mutex<ManagedUpdateState>,
}

#[derive(Default)]
struct ManagedUpdateState {
    check_status: ManagedUpdateCheckStatus,
    installing: bool,
    candidate: Option<ManagedUpdateCandidate>,
    restart_admission: Option<UpdatePermit>,
}

#[derive(Debug, Default, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ManagedUpdateCheckStatus {
    #[default]
    NotChecked,
    Checking,
    Available,
    UpToDate,
    Failed,
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
    check_status: ManagedUpdateCheckStatus,
    installing: bool,
    restart_pending: bool,
    current_version: &'static str,
    candidate: Option<ManagedUpdateCandidate>,
    blockers: Vec<ManagedUpdateBlocker>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedUpdateInstallInput {
    expected_candidate_token: String,
}

struct CheckGuard<'a> {
    authority: &'a ManagedUpdateAuthority,
    finished: bool,
}

impl CheckGuard<'_> {
    fn finish(
        mut self,
        outcome: Result<Option<ManagedUpdateCandidate>, String>,
    ) -> Result<(), String> {
        let mut state = self
            .authority
            .state
            .lock()
            .map_err(|_| "Managed update state is unavailable".to_string())?;
        match outcome {
            Ok(candidate) => {
                state.check_status = if candidate.is_some() {
                    ManagedUpdateCheckStatus::Available
                } else {
                    ManagedUpdateCheckStatus::UpToDate
                };
                state.candidate = candidate;
                self.finished = true;
                Ok(())
            }
            Err(error) => {
                state.check_status = ManagedUpdateCheckStatus::Failed;
                state.candidate = None;
                self.finished = true;
                Err(error)
            }
        }
    }
}

impl Drop for CheckGuard<'_> {
    fn drop(&mut self) {
        if !self.finished
            && let Ok(mut state) = self.authority.state.lock()
        {
            state.check_status = ManagedUpdateCheckStatus::Failed;
            state.candidate = None;
        }
    }
}

struct InstallGuard<'a> {
    authority: &'a ManagedUpdateAuthority,
    installed: bool,
}
enum InstallAction<'a> {
    Install(ManagedUpdateCandidate, InstallGuard<'a>),
    Restart,
}
impl InstallGuard<'_> {
    fn installed(mut self, permit: UpdatePermit) -> Result<(), String> {
        let mut state = self
            .authority
            .state
            .lock()
            .map_err(|_| "无法保留应用更新状态，请重新打开应用")?;
        state.restart_admission = Some(permit);
        state.installing = false;
        self.installed = true;
        Ok(())
    }
}
impl Drop for InstallGuard<'_> {
    fn drop(&mut self) {
        if !self.installed
            && let Ok(mut state) = self.authority.state.lock()
        {
            state.installing = false;
        }
    }
}

impl ManagedUpdateAuthority {
    pub fn restart_pending(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.restart_admission.is_some())
            .unwrap_or(false)
    }
    pub fn is_installing(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.installing)
            .unwrap_or(true)
    }
    fn begin_check(&self) -> Result<CheckGuard<'_>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Managed update state is unavailable".to_string())?;
        if state.restart_admission.is_some() {
            return Err("更新已安装，请重启以完成更新".into());
        }
        if state.check_status == ManagedUpdateCheckStatus::Checking || state.installing {
            return Err("A managed update operation is already running".to_string());
        }
        state.candidate = None;
        state.check_status = ManagedUpdateCheckStatus::Checking;
        Ok(CheckGuard {
            authority: self,
            finished: false,
        })
    }

    fn begin_install(&self, token: &str) -> Result<InstallAction<'_>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Managed update state is unavailable".to_string())?;
        if state.check_status == ManagedUpdateCheckStatus::Checking || state.installing {
            return Err("A managed update operation is already running".to_string());
        }
        if token.len() != 64 {
            return Err("Managed update candidate authorization is invalid".to_string());
        }
        let expected = state.candidate.clone().ok_or_else(|| {
            "No verified managed update candidate is staged — run a check first".to_string()
        })?;
        if expected.candidate_token != token {
            return Err("Managed update candidate authorization does not match".to_string());
        }
        // An installed candidate remains the only authorized identity. A
        // failed event delivery or save retries only the restart barrier.
        if state.restart_admission.is_some() {
            return Ok(InstallAction::Restart);
        }
        state.installing = true;
        Ok(InstallAction::Install(
            expected,
            InstallGuard {
                authority: self,
                installed: false,
            },
        ))
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
    let state = authority
        .state
        .lock()
        .map_err(|_| "Managed update state is unavailable".to_string())?;
    Ok(ManagedUpdateSnapshot {
        configuration,
        check_status: state.check_status,
        installing: state.installing,
        restart_pending: state.restart_admission.is_some(),
        current_version: env!("CARGO_PKG_VERSION"),
        candidate: state.candidate.clone(),
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
    let guard = authority.begin_check()?;
    let outcome = async {
        let release = check_configured_release(&app).await?;
        verify_update_metadata(&app, &release)?;
        if release_is_newer(&release.current_version, &release.version)? {
            candidate_summary(&release).map(Some)
        } else {
            Ok(None)
        }
    }
    .await;
    // Publish the terminal status before constructing the command response.
    guard.finish(outcome)?;
    snapshot(&authority)
}

#[tauri::command]
pub async fn managed_update_install(
    app: AppHandle,
    authority: tauri::State<'_, ManagedUpdateAuthority>,
    input: ManagedUpdateInstallInput,
) -> Result<(), String> {
    let (expected, guard) = match authority.begin_install(&input.expected_candidate_token)? {
        InstallAction::Install(expected, guard) => (expected, guard),
        InstallAction::Restart => return crate::draft_exit::request_restart_after_save(&app),
    };
    let permit = admission().update()?;

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
    // Keep admission closed even when the renderer's last save fails. The
    // application bundle has changed; only saved-input recovery may proceed.
    guard.installed(permit)?;
    crate::draft_exit::request_restart_after_save(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn install(authority: &ManagedUpdateAuthority, token: char) -> InstallGuard<'_> {
        match authority
            .begin_install(&token.to_string().repeat(64))
            .unwrap()
        {
            InstallAction::Install(_, guard) => guard,
            InstallAction::Restart => panic!("candidate was already installed"),
        }
    }

    #[test]
    fn installed_update_can_retry_restart_without_claiming_installation() {
        let authority = ManagedUpdateAuthority::default();
        authority
            .begin_check()
            .unwrap()
            .finish(Ok(Some(candidate('e'))))
            .unwrap();
        let guard = install(&authority, 'e');
        let gate = UpdateAdmission::default();
        guard.installed(gate.update().unwrap()).unwrap();
        // A failed save-event delivery must not strand the app in the
        // download/install state or reopen admission to Agent work.
        assert!(!authority.is_installing());
        assert!(!snapshot(&authority).unwrap().installing);
        assert!(authority.restart_pending());
        assert!(snapshot(&authority).unwrap().restart_pending);
        assert!(gate.activity().is_err());
        assert!(authority.begin_check().is_err());
        assert!(authority.begin_install(&"f".repeat(64)).is_err());
        assert!(authority.begin_install("stale").is_err());
        for _ in 0..3 {
            assert!(matches!(
                authority.begin_install(&"e".repeat(64)).unwrap(),
                InstallAction::Restart
            ));
            // Retrying this action never starts download/install or releases
            // work admission, even after repeated notification failures.
            assert!(!authority.is_installing());
            assert!(gate.activity().is_err());
        }
        assert_eq!(
            snapshot(&authority)
                .unwrap()
                .candidate
                .unwrap()
                .candidate_token,
            "e".repeat(64)
        );
    }

    #[test]
    fn updates_require_quiescence_and_keep_new_work_out_until_restart() {
        let gate = UpdateAdmission::default();
        let task = gate.activity().unwrap();
        let account = gate.activity().unwrap();
        assert!(gate.update().is_err());
        drop(task);
        assert!(gate.update().is_err());
        drop(account);
        let authority = ManagedUpdateAuthority::default();
        authority
            .begin_check()
            .unwrap()
            .finish(Ok(Some(candidate('c'))))
            .unwrap();
        let guard = install(&authority, 'c');
        let update = gate.update().unwrap();
        assert!(gate.activity().is_err());
        guard.installed(update).unwrap();
        assert!(!authority.is_installing());
        assert!(authority.restart_pending());
        // Returning from install is not permission to start work while the
        // last draft save is awaiting confirmation or has failed.
        assert!(gate.activity().is_err());
        assert!(authority.begin_check().is_err());
        drop(authority);
        assert!(gate.activity().is_ok());
    }

    #[test]
    fn an_install_failure_releases_admission_and_ordinary_activity_can_resume() {
        let authority = ManagedUpdateAuthority::default();
        authority
            .begin_check()
            .unwrap()
            .finish(Ok(Some(candidate('d'))))
            .unwrap();
        let gate = UpdateAdmission::default();
        {
            let _guard = install(&authority, 'd');
            let _permit = gate.update().unwrap();
            assert!(authority.is_installing());
            assert!(gate.activity().is_err());
        }
        assert!(!authority.is_installing());
        assert!(gate.activity().is_ok());
    }

    fn candidate(token: char) -> ManagedUpdateCandidate {
        ManagedUpdateCandidate {
            candidate_token: token.to_string().repeat(64),
            current_version: "0.1.7".into(),
            version: "0.1.8".into(),
            target: "darwin-aarch64".into(),
            notes: None,
            checked_at: 1,
        }
    }

    #[test]
    fn checks_publish_terminal_state_and_discard_previous_candidates() {
        let authority = ManagedUpdateAuthority::default();
        assert_eq!(
            snapshot(&authority).unwrap().check_status,
            ManagedUpdateCheckStatus::NotChecked
        );
        authority
            .begin_check()
            .unwrap()
            .finish(Ok(Some(candidate('a'))))
            .unwrap();
        let found = snapshot(&authority).unwrap();
        assert_eq!(found.check_status, ManagedUpdateCheckStatus::Available);
        assert!(found.candidate.is_some());

        let check = authority.begin_check().unwrap();
        let checking = snapshot(&authority).unwrap();
        assert_eq!(checking.check_status, ManagedUpdateCheckStatus::Checking);
        assert!(checking.candidate.is_none());
        assert!(authority.begin_install(&"a".repeat(64)).is_err());
        assert!(check.finish(Err("network failure".into())).is_err());
        let failed = snapshot(&authority).unwrap();
        assert_eq!(failed.check_status, ManagedUpdateCheckStatus::Failed);
        assert!(failed.candidate.is_none());
        assert!(authority.begin_install(&"a".repeat(64)).is_err());

        authority.begin_check().unwrap().finish(Ok(None)).unwrap();
        let current = snapshot(&authority).unwrap();
        assert_eq!(current.check_status, ManagedUpdateCheckStatus::UpToDate);
        assert!(current.candidate.is_none());
    }

    #[test]
    fn cancelled_checks_and_concurrent_installs_cannot_leave_false_status() {
        let authority = ManagedUpdateAuthority::default();
        let check = authority.begin_check().unwrap();
        assert!(authority.begin_check().is_err());
        drop(check);
        assert_eq!(
            snapshot(&authority).unwrap().check_status,
            ManagedUpdateCheckStatus::Failed
        );

        authority
            .begin_check()
            .unwrap()
            .finish(Ok(Some(candidate('b'))))
            .unwrap();
        assert!(authority.begin_install(&"a".repeat(64)).is_err());
        let install = install(&authority, 'b');
        assert!(snapshot(&authority).unwrap().installing);
        assert!(authority.begin_check().is_err());
        assert!(authority.begin_install(&"b".repeat(64)).is_err());
        drop(install);
        assert!(!snapshot(&authority).unwrap().installing);
        assert!(authority.begin_check().is_ok());
    }
}
