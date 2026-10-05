//! UserNotifications bridge. Tests never initialize the system center.
use super::{DesktopNotifications, SystemSettings};
use std::{
    ffi::{CStr, CString, c_char, c_void},
    sync::{
        OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

static APP: OnceLock<AppHandle> = OnceLock::new();
static AVAILABLE: AtomicBool = AtomicBool::new(false);
static NEXT_NOTICE: AtomicU64 = AtomicU64::new(1);
type SettingsReply = unsafe extern "C" fn(*mut c_void, i32, bool, bool, bool);
type SubmitReply = unsafe extern "C" fn(*mut c_void, bool);
unsafe extern "C" {
    fn ff_notifications_initialize(click: unsafe extern "C" fn(*const c_char)) -> bool;
    fn ff_notifications_settings(request: bool, context: *mut c_void, reply: SettingsReply)
    -> bool;
    fn ff_notifications_submit(
        id: *const c_char,
        target: *const c_char,
        body: *const c_char,
        sound: bool,
        context: *mut c_void,
        reply: SubmitReply,
    ) -> bool;
    fn ff_notifications_remove(id: *const c_char);
}

pub(super) fn initialize(app: &AppHandle) {
    if APP.set(app.clone()).is_err() {
        return;
    }
    // Tauri setup runs on the main thread. This only installs our delegate.
    AVAILABLE.store(
        unsafe { ff_notifications_initialize(clicked) },
        Ordering::SeqCst,
    );
}

unsafe extern "C" fn clicked(target: *const c_char) {
    if target.is_null() {
        return;
    }
    // The Objective-C delegate retains the string through this callback.
    let target = unsafe { CStr::from_ptr(target) }.to_str().unwrap_or("");
    if let Some(app) = APP.get() {
        super::activate(app, target);
    }
}

type SettingsResult = oneshot::Sender<Result<SystemSettings, String>>;
unsafe extern "C" fn settings_reply(
    context: *mut c_void,
    permission: i32,
    alert: bool,
    sound: bool,
    success: bool,
) {
    // Ownership transfers exactly once on a successful native start.
    let sender = unsafe { Box::from_raw(context.cast::<SettingsResult>()) };
    let _ = sender.send(if success {
        Ok(SystemSettings::from_native(permission, alert, sound))
    } else {
        Err("系统通知许可尚未确认，请重新检查".into())
    });
}

pub(super) async fn settings(app: &AppHandle, request: bool) -> Result<SystemSettings, String> {
    if !AVAILABLE.load(Ordering::SeqCst) {
        return Err("系统通知暂不可用".into());
    }
    let (send, receive) = oneshot::channel();
    app.run_on_main_thread(move || {
        let context = Box::into_raw(Box::new(send));
        if !unsafe { ff_notifications_settings(request, context.cast(), settings_reply) } {
            unsafe { settings_reply(context.cast(), 0, false, false, false) };
        }
    })
    .map_err(|_| "系统通知暂不可用")?;
    tokio::time::timeout(Duration::from_secs(if request { 60 } else { 5 }), receive)
        .await
        .map_err(|_| "系统通知许可尚未确认，请重新检查")?
        .map_err(|_| "系统通知许可尚未确认，请重新检查")?
}

struct SubmitContext {
    reply: oneshot::Sender<Result<bool, String>>,
    app: AppHandle,
    id: String,
    revision: u64,
}
unsafe extern "C" fn submit_reply(context: *mut c_void, success: bool) {
    let context = unsafe { Box::from_raw(context.cast::<SubmitContext>()) };
    let current = context
        .app
        .state::<DesktopNotifications>()
        .revision
        .load(Ordering::SeqCst);
    if current != context.revision {
        remove(&context.app, &context.id);
        let _ = context.reply.send(Ok(false));
    } else {
        let _ = context.reply.send(if success {
            Ok(true)
        } else {
            Err("提醒未能提交".into())
        });
    }
}

pub(super) async fn submit(
    app: &AppHandle,
    target: String,
    body: &'static str,
    sound: bool,
    revision: u64,
) -> Result<bool, String> {
    if !AVAILABLE.load(Ordering::SeqCst) {
        return Err("系统通知暂不可用".into());
    }
    let id = format!(
        "farfold-{}",
        super::target_digest(&format!(
            "{}:{:?}:{}",
            std::process::id(),
            std::time::SystemTime::now(),
            NEXT_NOTICE.fetch_add(1, Ordering::SeqCst)
        ))
    );
    let (reply, receive) = oneshot::channel();
    let owned = app.clone();
    app.run_on_main_thread(move || {
        // Recheck at the actual system submission, not when a JS event arrived.
        let gate_app = owned.clone();
        let gate = gate_app.state::<DesktopNotifications>();
        let Ok(_change) = gate.changes.try_lock() else {
            let _ = reply.send(Ok(false));
            return;
        };
        if !super::may_submit_locked(&owned, revision)
            || super::resolve_target(
                owned.state::<crate::meta_store::MetaStore>().inner(),
                &target,
            )
            .is_none()
        {
            let _ = reply.send(Ok(false));
            return;
        }
        let context = Box::new(SubmitContext {
            reply,
            app: owned,
            id: id.clone(),
            revision,
        });
        let strings = (CString::new(id), CString::new(target), CString::new(body));
        let (Ok(id), Ok(target), Ok(body)) = strings else {
            let _ = context.reply.send(Err("提醒未能提交".into()));
            return;
        };
        let pointer = Box::into_raw(context);
        if !unsafe {
            ff_notifications_submit(
                id.as_ptr(),
                target.as_ptr(),
                body.as_ptr(),
                sound,
                pointer.cast(),
                submit_reply,
            )
        } {
            unsafe { submit_reply(pointer.cast(), false) };
        }
    })
    .map_err(|_| "提醒未能提交")?;
    // No automatic retry: a missing receipt does not mean the OS rejected it.
    tokio::time::timeout(Duration::from_secs(5), receive)
        .await
        .map_err(|_| "提醒提交结果尚未确认，不会自动重试")?
        .map_err(|_| "提醒提交结果尚未确认，不会自动重试")?
}

fn remove(app: &AppHandle, id: &str) {
    let Ok(id) = CString::new(id) else {
        return;
    };
    let _ = app.run_on_main_thread(move || unsafe { ff_notifications_remove(id.as_ptr()) });
}
