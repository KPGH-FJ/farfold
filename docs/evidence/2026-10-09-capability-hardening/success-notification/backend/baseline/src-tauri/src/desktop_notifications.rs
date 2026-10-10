//! Optional, content-free desktop reminders. Submission is not proof of delivery.
//! The system receives only a digest of an existing index row, never its path.
mod diagnostic;
pub(crate) use diagnostic::DiagnosticSnapshot;
use diagnostic::{Attempt, DiagnosticStore, Reason, Stage};
#[cfg(target_os = "macos")]
mod native;
#[cfg(windows)]
#[path = "desktop_notifications/windows.rs"]
mod native;
#[cfg(any(windows, test))]
mod windows_payload;
use crate::meta_store::MetaStore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tauri::{AppHandle, Manager};

const SETTINGS_KEY: &str = "desktopNotifications.v1";
const READ_ERROR: &str = "提醒设置未能读取，桌面提醒保持关闭";
const SAVE_ERROR: &str = "提醒设置未能保存，仍使用之前的选择";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Preference {
    version: u8,
    enabled: bool,
    #[serde(default)]
    sound: bool,
}
fn read_preference(store: &MetaStore) -> Result<Preference, String> {
    let Some(value) = store.get_setting(SETTINGS_KEY).map_err(|_| READ_ERROR)? else {
        return Ok(Preference {
            version: 1,
            enabled: false,
            sound: false,
        });
    };
    let preference: Preference = serde_json::from_value(value).map_err(|_| READ_ERROR)?;
    if preference.version != 1 {
        return Err(READ_ERROR.into());
    }
    Ok(preference)
}
fn save_preference(store: &MetaStore, enabled: bool, sound: bool) -> Result<Preference, String> {
    read_preference(store)?;
    let preference = Preference {
        version: 1,
        enabled,
        sound,
    };
    let value = serde_json::to_value(&preference).map_err(|_| SAVE_ERROR)?;
    store
        .set_setting(SETTINGS_KEY, &value)
        .map_err(|_| SAVE_ERROR)?;
    Ok(preference)
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Permission {
    Unknown,
    #[cfg(any(target_os = "macos", test))]
    NotDetermined,
    Denied,
    Authorized,
    #[cfg(any(target_os = "macos", test))]
    Provisional,
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemSettings {
    permission: Permission,
    system_alert: Option<bool>,
    system_sound: Option<bool>,
}
impl SystemSettings {
    fn unknown() -> Self {
        Self {
            permission: Permission::Unknown,
            system_alert: None,
            system_sound: None,
        }
    }
    #[cfg(any(target_os = "macos", test))]
    fn from_native(permission: i32, alert: bool, sound: bool) -> Self {
        Self {
            permission: match permission {
                1 => Permission::NotDetermined,
                2 => Permission::Denied,
                3 => Permission::Authorized,
                4 => Permission::Provisional,
                _ => Permission::Unknown,
            },
            system_alert: Some(alert),
            system_sound: Some(sound),
        }
    }
    fn allowed(self) -> bool {
        match self.permission {
            Permission::Authorized => true,
            #[cfg(any(target_os = "macos", test))]
            Permission::Provisional => true,
            _ => false,
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationState {
    enabled: bool,
    sound: bool,
    click_requires_running: bool,
    #[serde(flatten)]
    system: SystemSettings,
}
fn snapshot(preference: Preference, system: SystemSettings) -> NotificationState {
    NotificationState {
        enabled: preference.enabled,
        sound: preference.sound,
        click_requires_running: cfg!(windows),
        system,
    }
}

fn save_confirmed_preference(
    store: &MetaStore,
    enabled: bool,
    sound: bool,
    system: SystemSettings,
) -> Result<Preference, String> {
    if enabled && system.permission == Permission::Unknown {
        return Err("系统通知许可尚未确认，原设置保持不变".into());
    }
    save_preference(store, enabled && system.allowed(), sound)
}

#[derive(Default)]
pub struct DesktopNotifications {
    seen: Mutex<VecDeque<(String, u64)>>,
    pending: Mutex<VecDeque<String>>,
    changes: tokio::sync::Mutex<()>,
    revision: AtomicU64,
    diagnostic: DiagnosticStore,
}
pub(crate) fn diagnostic_for(
    app: &AppHandle,
    renderer_nonce: &str,
    sequence: u64,
) -> Option<DiagnosticSnapshot> {
    app.state::<DesktopNotifications>()
        .diagnostic
        .for_attempt(renderer_nonce, sequence)
}
fn diagnostic_stop(app: &AppHandle, attempt: &Attempt, stage: Stage, reason: Reason) {
    app.state::<DesktopNotifications>()
        .diagnostic
        .update(attempt, |d| d.stop(stage, reason));
}
pub fn initialize(app: &AppHandle) {
    native::initialize(app);
}
pub fn handle_run_event(_event: &tauri::RunEvent) {
    #[cfg(windows)]
    if matches!(_event, tauri::RunEvent::Exit) {
        native::shutdown();
    }
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum NoticeKind {
    Approval,
    Question,
    Interrupted,
}
impl NoticeKind {
    fn body(self) -> &'static str {
        match self {
            Self::Approval => "有一项批准请求需要你处理。请回到 Farfold 查看。",
            Self::Question => "有一个问题需要你回答。请回到 Farfold 查看。",
            Self::Interrupted => "有一项工作需要你检查。请回到 Farfold 查看。",
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Submission {
    Suppressed,
    Submitted,
}

#[tauri::command]
pub async fn desktop_notifications_get(app: AppHandle) -> Result<NotificationState, String> {
    let preference = read_preference(app.state::<MetaStore>().inner())?;
    let system = native::settings(&app, false)
        .await
        .unwrap_or_else(|_| SystemSettings::unknown());
    Ok(snapshot(preference, system))
}
#[tauri::command]
pub async fn desktop_notifications_set(
    app: AppHandle,
    enabled: bool,
    sound: bool,
) -> Result<NotificationState, String> {
    let state = app.state::<DesktopNotifications>();
    let _change = state
        .changes
        .try_lock()
        .map_err(|_| "提醒设置正在保存，请稍后重试")?;
    state.revision.fetch_add(1, Ordering::SeqCst);
    let previous = read_preference(app.state::<MetaStore>().inner())?;
    // Disabling must work even when the system center is unavailable.
    let system = if enabled {
        native::settings(&app, !previous.enabled).await?
    } else {
        native::settings(&app, false)
            .await
            .unwrap_or_else(|_| SystemSettings::unknown())
    };
    let preference =
        save_confirmed_preference(app.state::<MetaStore>().inner(), enabled, sound, system)?;
    Ok(snapshot(preference, system))
}
fn claim(seen: &mut VecDeque<(String, u64)>, renderer: &str, sequence: u64) -> bool {
    if renderer.len() != 32
        || !renderer
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return false;
    }
    let key = (renderer.to_owned(), sequence);
    if sequence == 0 || seen.contains(&key) {
        return false;
    }
    seen.push_back(key);
    if seen.len() > 256 {
        seen.pop_front();
    }
    true
}
fn target_digest(key: &str) -> String {
    Sha256::digest(format!("farfold-notification-v1\0{key}"))
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn resolve_target(store: &MetaStore, digest: &str) -> Option<String> {
    if !valid_digest(digest) {
        return None;
    }
    let mut matches = store
        .list_sessions()
        .ok()?
        .into_iter()
        .filter(|row| target_digest(&row.id) == digest);
    let row = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    Some(row.id)
}
fn may_submit(app: &AppHandle, revision: u64, attempt: &Attempt) -> bool {
    let state = app.state::<DesktopNotifications>();
    let Ok(_change) = state.changes.try_lock() else {
        diagnostic_stop(app, attempt, Stage::Backend, Reason::ChangeBusy);
        return false;
    };
    may_submit_locked(app, revision, attempt, Stage::Backend)
}
// Caller keeps changes locked through the final, nonblocking system submission.
fn may_submit_locked(app: &AppHandle, revision: u64, attempt: &Attempt, stage: Stage) -> bool {
    let state = app.state::<DesktopNotifications>();
    if state.revision.load(Ordering::SeqCst) != revision {
        diagnostic_stop(app, attempt, stage, Reason::PreferenceChanged);
        return false;
    }
    match read_preference(app.state::<MetaStore>().inner()) {
        Ok(preference) if preference.enabled => {}
        Ok(_) => {
            diagnostic_stop(app, attempt, stage, Reason::PreferenceOff);
            return false;
        }
        Err(_) => {
            diagnostic_stop(app, attempt, stage, Reason::PreferenceUnreadable);
            return false;
        }
    }
    let Some(window) = app.get_webview_window("main") else {
        diagnostic_stop(app, attempt, stage, Reason::MainWindowMissing);
        return false;
    };
    // Capture the same queries used by the gate, never a later diagnostic read.
    let visible = window.is_visible().ok();
    let focused = window.is_focused().ok();
    let gate = diagnostic::window_gate(visible, focused);
    state.diagnostic.update(attempt, |d| {
        d.window_visible = visible;
        d.window_focused = focused;
        if let Err(reason) = gate {
            d.stop(stage, reason);
        }
    });
    gate.is_ok()
}
#[tauri::command]
pub async fn desktop_notification_submit(
    app: AppHandle,
    kind: NoticeKind,
    sequence: u64,
    target_key: String,
    renderer_nonce: String,
) -> Result<Submission, String> {
    let state = app.state::<DesktopNotifications>();
    let attempt = state.diagnostic.begin(&renderer_nonce, sequence);
    let revision = state.revision.load(Ordering::SeqCst);
    let claimed = {
        let mut seen = state.seen.lock().map_err(|_| {
            diagnostic_stop(&app, &attempt, Stage::Backend, Reason::ClaimUnavailable);
            "提醒未能提交"
        })?;
        claim(&mut seen, &renderer_nonce, sequence)
    };
    if !claimed {
        diagnostic_stop(
            &app,
            &attempt,
            Stage::Backend,
            if sequence == 0 || !diagnostic::valid_renderer(&renderer_nonce) {
                Reason::InvalidAttempt
            } else {
                Reason::Duplicate
            },
        );
        return Ok(Submission::Suppressed);
    }
    if !may_submit(&app, revision, &attempt) {
        return Ok(Submission::Suppressed);
    }
    let store = app.state::<MetaStore>();
    if store
        .get_session(&target_key)
        .map_err(|_| {
            diagnostic_stop(&app, &attempt, Stage::Backend, Reason::TargetLookupFailed);
            "提醒未能提交"
        })?
        .is_none()
    {
        diagnostic_stop(&app, &attempt, Stage::Backend, Reason::TargetMissing);
        return Ok(Submission::Suppressed);
    }
    let preference = read_preference(store.inner()).inspect_err(|_| {
        diagnostic_stop(&app, &attempt, Stage::Backend, Reason::PreferenceUnreadable);
    })?;
    let system = native::settings(&app, false).await.inspect_err(|_| {
        diagnostic_stop(&app, &attempt, Stage::Backend, Reason::SystemReadFailed);
    })?;
    state.diagnostic.update(&attempt, |d| d.system(system));
    if !system.allowed() {
        diagnostic_stop(&app, &attempt, Stage::Backend, Reason::SystemNotAllowed);
        return Ok(Submission::Suppressed);
    }
    if !may_submit(&app, revision, &attempt) {
        return Ok(Submission::Suppressed);
    }
    let sound = preference.sound && system.system_sound != Some(false);
    state
        .diagnostic
        .update(&attempt, |d| d.sound_requested = Some(sound));
    let submitted = native::submit(
        &app,
        target_digest(&target_key),
        kind.body(),
        sound,
        revision,
        attempt,
    )
    .await?;
    Ok(if submitted {
        Submission::Submitted
    } else {
        Submission::Suppressed
    })
}

fn activate(app: &AppHandle, digest: &str) {
    if resolve_target(app.state::<MetaStore>().inner(), digest).is_none() {
        return;
    }
    let state = app.state::<DesktopNotifications>();
    let Ok(mut pending) = state.pending.lock() else {
        return;
    };
    if !pending.iter().any(|d| d == digest) {
        pending.push_back(digest.into());
    }
    if pending.len() > 16 {
        pending.pop_front();
    }
    drop(pending);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    // Retain until the UI explicitly consumes it; an early launch event may have no listener yet.
    crate::ui_transport::emit_event(app, "desktop-notification:activate", ());
}
#[tauri::command]
pub fn desktop_notification_take_pending(app: AppHandle) -> Result<Vec<String>, String> {
    let state = app.state::<DesktopNotifications>();
    let mut pending = state.pending.lock().map_err(|_| "提醒对应的对话尚未确认")?;
    Ok(pending
        .drain(..)
        .filter_map(|digest| resolve_target(app.state::<MetaStore>().inner(), &digest))
        .collect())
}

#[cfg(test)]
#[path = "desktop_notifications/tests.rs"]
mod tests;
