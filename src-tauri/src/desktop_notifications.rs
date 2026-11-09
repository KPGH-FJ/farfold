//! Optional, content-free desktop reminders. Submission is not proof of delivery.
//! The system receives only a digest of an existing index row, never its path.
mod diagnostic;
mod tickets;
pub(crate) use diagnostic::DiagnosticSnapshot;
use diagnostic::{Attempt, DiagnosticStore, Reason, Stage};
pub use tickets::Withdrawal;
use tickets::{Rejection, Ticket, Tickets};
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
    #[serde(default, rename = "successEnabled")]
    success_enabled: bool,
    #[serde(default)]
    sound: bool,
}
fn read_preference(store: &MetaStore) -> Result<Preference, String> {
    let Some(value) = store.get_setting(SETTINGS_KEY).map_err(|_| READ_ERROR)? else {
        return Ok(Preference {
            version: 1,
            enabled: false,
            success_enabled: false,
            sound: false,
        });
    };
    let preference: Preference = serde_json::from_value(value).map_err(|_| READ_ERROR)?;
    if preference.version != 1 {
        return Err(READ_ERROR.into());
    }
    Ok(preference)
}
fn save_preference(
    store: &MetaStore,
    enabled: bool,
    success_enabled: bool,
    sound: bool,
) -> Result<Preference, String> {
    read_preference(store)?;
    let preference = Preference {
        version: 1,
        enabled,
        success_enabled,
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
    success_enabled: bool,
    sound: bool,
    click_requires_running: bool,
    #[serde(flatten)]
    system: SystemSettings,
}
fn snapshot(preference: Preference, system: SystemSettings) -> NotificationState {
    NotificationState {
        enabled: preference.enabled,
        success_enabled: preference.success_enabled,
        sound: preference.sound,
        click_requires_running: cfg!(windows),
        system,
    }
}

fn save_confirmed_preference(
    store: &MetaStore,
    enabled: bool,
    success_enabled: bool,
    sound: bool,
    system: SystemSettings,
) -> Result<Preference, String> {
    let previous = read_preference(store)?;
    if system.permission == Permission::Unknown {
        // Unknown permission cannot enable a new kind or change an enabled
        // sound choice, but explicitly disabling one kind preserves the other.
        if requests_permission(&previous, enabled, success_enabled)
            || ((enabled || success_enabled) && sound != previous.sound)
        {
            return Err("系统通知许可尚未确认，原设置保持不变".into());
        }
        return save_preference(store, enabled, success_enabled, sound);
    }
    save_preference(
        store,
        // An unchanged saved choice is not a new authorization request. A
        // denial while disabling the other kind must not erase that choice.
        enabled && (previous.enabled || system.allowed()),
        success_enabled && (previous.success_enabled || system.allowed()),
        sound,
    )
}

fn requests_permission(previous: &Preference, enabled: bool, success_enabled: bool) -> bool {
    (enabled && !previous.enabled) || (success_enabled && !previous.success_enabled)
}

#[derive(Default)]
pub struct DesktopNotifications {
    tickets: Tickets,
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
    Success,
}
impl NoticeKind {
    fn body(self) -> &'static str {
        match self {
            Self::Approval => "有一项批准请求需要你处理。请回到 Farfold 查看。",
            Self::Question => "有一个问题需要你回答。请回到 Farfold 查看。",
            Self::Interrupted => "有一项工作需要你检查。请回到 Farfold 查看。",
            Self::Success => "有一项工作已完成。请回到 Farfold 查看。",
        }
    }
}
impl Preference {
    fn enabled_for(&self, kind: NoticeKind) -> bool {
        match kind {
            NoticeKind::Success => self.success_enabled,
            NoticeKind::Approval | NoticeKind::Question | NoticeKind::Interrupted => self.enabled,
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
    success_enabled: bool,
    sound: bool,
) -> Result<NotificationState, String> {
    let state = app.state::<DesktopNotifications>();
    let _change = state
        .changes
        .try_lock()
        .map_err(|_| "提醒设置正在保存，请稍后重试")?;
    state.revision.fetch_add(1, Ordering::SeqCst);
    let previous = read_preference(app.state::<MetaStore>().inner())?;
    let request = requests_permission(&previous, enabled, success_enabled);
    let only_disabling = !request
        && sound == previous.sound
        && ((previous.enabled && !enabled) || (previous.success_enabled && !success_enabled));
    // Disabling either kind works even when the system center is unavailable.
    let system = if (enabled || success_enabled) && !only_disabling {
        native::settings(&app, request).await?
    } else {
        native::settings(&app, false)
            .await
            .unwrap_or_else(|_| SystemSettings::unknown())
    };
    let preference = save_confirmed_preference(
        app.state::<MetaStore>().inner(),
        enabled,
        success_enabled,
        sound,
        system,
    )?;
    Ok(snapshot(preference, system))
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
// Shared by the initial gate and both platforms' final submission gates.
fn preference_gate(
    store: &MetaStore,
    kind: NoticeKind,
    expected_revision: u64,
    current_revision: u64,
) -> Result<(), Reason> {
    if expected_revision != current_revision {
        return Err(Reason::PreferenceChanged);
    }
    match read_preference(store) {
        Ok(preference) if preference.enabled_for(kind) => Ok(()),
        Ok(_) => Err(Reason::PreferenceOff),
        Err(_) => Err(Reason::PreferenceUnreadable),
    }
}

fn may_submit(
    app: &AppHandle,
    ticket: &Ticket,
    kind: NoticeKind,
    revision: u64,
    attempt: &Attempt,
) -> bool {
    let state = app.state::<DesktopNotifications>();
    let Ok(_change) = state.changes.try_lock() else {
        diagnostic_stop(app, attempt, Stage::Backend, Reason::ChangeBusy);
        return false;
    };
    may_submit_locked(app, ticket, kind, revision, attempt, Stage::Backend)
}
// Caller keeps changes locked through the final, nonblocking system submission.
fn may_submit_locked(
    app: &AppHandle,
    ticket: &Ticket,
    kind: NoticeKind,
    revision: u64,
    attempt: &Attempt,
    stage: Stage,
) -> bool {
    let state = app.state::<DesktopNotifications>();
    if !ticket.pending() {
        diagnostic_stop(app, attempt, stage, Reason::AttemptRetired);
        return false;
    }
    if let Err(reason) = preference_gate(
        app.state::<MetaStore>().inner(),
        kind,
        revision,
        state.revision.load(Ordering::SeqCst),
    ) {
        diagnostic_stop(app, attempt, stage, reason);
        return false;
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
    let ticket = match state.tickets.claim(&renderer_nonce, sequence) {
        Ok(ticket) => ticket,
        Err(rejection) => {
            diagnostic_stop(
                &app,
                &attempt,
                Stage::Backend,
                match rejection {
                    Rejection::Invalid => Reason::InvalidAttempt,
                    Rejection::Duplicate => Reason::Duplicate,
                    Rejection::OutOfOrder => Reason::AttemptOutOfOrder,
                    Rejection::Capacity | Rejection::Unavailable => Reason::ClaimUnavailable,
                },
            );
            return Ok(Submission::Suppressed);
        }
    };
    if !may_submit(&app, &ticket, kind, revision, &attempt) {
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
    if !may_submit(&app, &ticket, kind, revision, &attempt) {
        return Ok(Submission::Suppressed);
    }
    let sound = preference.sound && system.system_sound != Some(false);
    state
        .diagnostic
        .update(&attempt, |d| d.sound_requested = Some(sound));
    let submitted = native::submit(
        &app,
        target_digest(&target_key),
        kind,
        sound,
        revision,
        attempt,
        ticket,
    )
    .await?;
    Ok(if submitted {
        Submission::Submitted
    } else {
        Submission::Suppressed
    })
}

#[tauri::command]
pub fn desktop_notification_withdraw(
    app: AppHandle,
    renderer_nonce: String,
    sequence: u64,
) -> Withdrawal {
    app.state::<DesktopNotifications>()
        .tickets
        .withdraw(&renderer_nonce, sequence)
}

fn queue_activation(pending: &mut VecDeque<String>, digest: &str) {
    pending.retain(|queued| queued != digest);
    pending.push_back(digest.into());
    if pending.len() > 16 {
        pending.pop_front();
    }
}

fn activate(app: &AppHandle, digest: &str) {
    if resolve_target(app.state::<MetaStore>().inner(), digest).is_none() {
        return;
    }
    let state = app.state::<DesktopNotifications>();
    let Ok(mut pending) = state.pending.lock() else {
        return;
    };
    queue_activation(&mut pending, digest);
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
