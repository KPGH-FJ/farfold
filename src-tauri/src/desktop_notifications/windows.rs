//! Installed Windows desktop toasts through the official WinRT API.
//! Setting() is the actual system decision. Windows does not expose separate
//! banner/sound settings here, and no cold-start COM activator is registered.
use super::{
    DesktopNotifications, NoticeKind, Permission, SystemSettings,
    diagnostic::{Attempt, Reason, Stage},
};
use std::collections::VecDeque;
use std::sync::{
    Mutex, OnceLock,
    atomic::{AtomicU64, Ordering},
};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager};
use windows::{
    Data::Xml::Dom::XmlDocument,
    Foundation::TypedEventHandler,
    UI::Notifications::{
        NotificationMirroring, NotificationSetting, ToastFailedEventArgs, ToastNotification,
        ToastNotificationManager, ToastNotifier,
    },
    Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize},
    core::{HSTRING, IInspectable},
};

const APP_ID: &str = "ai.farfold.desktop";
const GROUP: &str = "farfold-work";
const UNAVAILABLE: &str = "系统通知状态无法读取，请确认已安装此应用并检查系统通知设置";
static NEXT: AtomicU64 = AtomicU64::new(1);

struct Apartment(bool);
impl Apartment {
    fn enter() -> Result<Self, String> {
        match unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
            Ok(()) => Ok(Self(true)),
            // The Tauri main thread may already have an STA. Preserve that
            // apartment and do not uninitialize somebody else's ownership.
            Err(error) if error.code().0 == 0x80010106u32 as i32 => Ok(Self(false)),
            Err(_) => Err(UNAVAILABLE.into()),
        }
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        if self.0 {
            unsafe { RoUninitialize() };
        }
    }
}

struct Notice {
    id: u64,
    tag: String,
    toast: ToastNotification,
    activated: i64,
    failed: i64,
}
impl Drop for Notice {
    fn drop(&mut self) {
        let _ = self.toast.RemoveActivated(self.activated);
        let _ = self.toast.RemoveFailed(self.failed);
    }
}
fn notices() -> &'static Mutex<VecDeque<Notice>> {
    static NOTICES: OnceLock<Mutex<VecDeque<Notice>>> = OnceLock::new();
    NOTICES.get_or_init(Default::default)
}
fn forget(id: u64) {
    // Release the map before unsubscribing: callbacks may be synchronous.
    let removed = notices().lock().ok().and_then(|mut values| {
        values
            .iter()
            .position(|n| n.id == id)
            .and_then(|index| values.remove(index))
    });
    drop(removed);
}
fn notifier() -> Result<ToastNotifier, String> {
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID))
        .map_err(|_| UNAVAILABLE.into())
}
fn system(notifier: &ToastNotifier) -> Result<SystemSettings, String> {
    let setting = notifier.Setting().map_err(|_| UNAVAILABLE)?;
    let permission = match setting {
        NotificationSetting::Enabled => Permission::Authorized,
        NotificationSetting::DisabledForApplication
        | NotificationSetting::DisabledForUser
        | NotificationSetting::DisabledByGroupPolicy
        | NotificationSetting::DisabledByManifest => Permission::Denied,
        _ => Permission::Unknown,
    };
    Ok(SystemSettings {
        permission,
        system_alert: None,
        system_sound: None,
    })
}

pub(super) fn initialize(_app: &AppHandle) {
    // No notification, registration or authorization prompt on application start.
}
pub(super) async fn settings(_app: &AppHandle, _request: bool) -> Result<SystemSettings, String> {
    // Enabling is still an explicit application preference. Windows users grant
    // or deny it in system settings; there is no fabricated request/acknowledgement.
    tokio::time::timeout(
        Duration::from_secs(5),
        tauri::async_runtime::spawn_blocking(|| {
            let _apartment = Apartment::enter()?;
            system(&notifier()?)
        }),
    )
    .await
    .map_err(|_| "系统通知许可尚未确认，请重新检查")?
    .map_err(|_| UNAVAILABLE)?
}

pub(super) async fn submit(
    app: &AppHandle,
    target: String,
    kind: NoticeKind,
    sound: bool,
    revision: u64,
    attempt: Attempt,
    ticket: super::Ticket,
) -> Result<bool, String> {
    let owned = app.clone();
    let queued_attempt = attempt.clone();
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        tauri::async_runtime::spawn_blocking(move || {
            let app = owned;
            let attempt = queued_attempt;
            let _apartment = Apartment::enter().inspect_err(|_| {
                super::diagnostic_stop(&app, &attempt, Stage::Native, Reason::NativeUnavailable);
            })?;
            let notifier = notifier().inspect_err(|_| {
                super::diagnostic_stop(&app, &attempt, Stage::Native, Reason::NativeUnavailable);
            })?;
            let system = system(&notifier).inspect_err(|_| {
                super::diagnostic_stop(&app, &attempt, Stage::Native, Reason::SystemReadFailed);
            })?;
            app.state::<DesktopNotifications>()
                .diagnostic
                .update(&attempt, |d| d.system(system));
            if !system.allowed() {
                super::diagnostic_stop(&app, &attempt, Stage::Native, Reason::SystemNotAllowed);
                return Ok(false);
            }
            let xml = XmlDocument::new().map_err(|_| "提醒未能提交")?;
            xml.LoadXml(&HSTRING::from(super::windows_payload::toast_xml(
                kind.body(),
                sound,
            )))
            .map_err(|_| "提醒未能提交")?;
            let toast =
                ToastNotification::CreateToastNotification(&xml).map_err(|_| "提醒未能提交")?;
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let tag = super::target_digest(&format!(
                "{}:{:?}:{id}",
                std::process::id(),
                SystemTime::now()
            ))[..16]
                .to_owned();
            toast
                .SetTag(&HSTRING::from(&tag))
                .map_err(|_| "提醒未能提交")?;
            toast
                .SetGroup(&HSTRING::from(GROUP))
                .map_err(|_| "提醒未能提交")?;
            // Keep the reminder on this computer; the target digest is only meaningful here.
            toast
                .SetNotificationMirroring(NotificationMirroring::Disabled)
                .map_err(|_| "提醒未能提交")?;
            let clicked_app = app.clone();
            let clicked_target = target.clone();
            let clicked_notice = tag.clone();
            let activated = toast
                .Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(
                    move |_, _| {
                        clicked_app
                            .state::<DesktopNotifications>()
                            .diagnostic
                            .observe_notice(&clicked_notice, |d| d.clicked = true);
                        let app = clicked_app.clone();
                        let target = clicked_target.clone();
                        let _ =
                            clicked_app.run_on_main_thread(move || super::activate(&app, &target));
                        forget(id);
                        Ok(())
                    },
                ))
                .map_err(|_| "提醒未能提交")?;
            // Dismissed(TimedOut) only means the banner faded out. Retain the
            // activation callback while the toast may remain in the notification
            // center; ownership is bounded by eviction, activation/failure/exit.
            let failed_app = app.clone();
            let failed_notice = tag.clone();
            let failed = toast
                .Failed(
                    &TypedEventHandler::<ToastNotification, ToastFailedEventArgs>::new(
                        move |_, _| {
                            failed_app
                                .state::<DesktopNotifications>()
                                .diagnostic
                                .notice_failed(&failed_notice);
                            forget(id);
                            Ok(())
                        },
                    ),
                )
                .map_err(|_| "提醒未能提交")?;
            let notice = Notice {
                id,
                tag: tag.clone(),
                toast: toast.clone(),
                activated,
                failed,
            };
            let state = app.state::<DesktopNotifications>();
            let Ok(_change) = state.changes.try_lock() else {
                super::diagnostic_stop(&app, &attempt, Stage::Native, Reason::ChangeBusy);
                return Ok(false);
            };
            if !super::may_submit_locked(&app, &ticket, kind, revision, &attempt, Stage::Native) {
                return Ok(false);
            }
            if !super::target_current(
                app.state::<crate::meta_store::MetaStore>().inner(),
                &target,
                kind,
            ) {
                super::diagnostic_stop(&app, &attempt, Stage::Native, Reason::TargetUnconfirmed);
                return Ok(false);
            }
            // Complete fallible registration and old-notice cleanup before
            // consuming this ticket. Do not hold the map during OS callbacks.
            let evicted = {
                let mut values = notices().lock().map_err(|_| "提醒未能提交")?;
                values.push_back(notice);
                if values.len() > 128 {
                    values.pop_front()
                } else {
                    None
                }
            };
            if let Some(old) = evicted {
                remove(&notifier, &old);
            }
            let submitted = ticket.dispatch(|| {
                state.diagnostic.show_notice(&attempt, &tag, || {
                    if notifier.Show(&toast).is_err() {
                        forget(id);
                        return Err("提醒未能提交".into());
                    }
                    // Accepted by the system API, never described as visible or delivered.
                    Ok(true)
                })
            });
            submitted.unwrap_or_else(|| {
                // Withdrawal won after registration but before Show. Remove
                // only this new notice and release its subscribed callbacks.
                forget(id);
                super::diagnostic_stop(&app, &attempt, Stage::Native, Reason::AttemptRetired);
                Ok(false)
            })
        }),
    )
    .await;
    match result {
        Err(_) | Ok(Err(_)) => {
            app.state::<DesktopNotifications>()
                .diagnostic
                .update(&attempt, |d| d.unconfirmed());
            Err("提醒提交结果尚未确认，不会自动重试".into())
        }
        Ok(Ok(result)) => {
            if result.is_err() {
                app.state::<DesktopNotifications>()
                    .diagnostic
                    .update(&attempt, |d| d.bridge_start_failed());
            }
            result
        }
    }
}

fn remove(notifier: &ToastNotifier, notice: &Notice) {
    let _ = notifier.Hide(&notice.toast);
    if let Ok(history) = ToastNotificationManager::History() {
        let _ = history.RemoveGroupedTagWithId(
            &HSTRING::from(&notice.tag),
            &HSTRING::from(GROUP),
            &HSTRING::from(APP_ID),
        );
    }
}

pub(super) fn shutdown() {
    let Ok(_apartment) = Apartment::enter() else {
        return;
    };
    let Ok(notifier) = notifier() else {
        return;
    };
    let removed = notices()
        .lock()
        .map(|mut values| std::mem::take(&mut *values))
        .unwrap_or_default();
    for notice in removed {
        remove(&notifier, &notice);
    }
}
