//! Dock/Apple-event Quit shares the existing exit owner; no delegate changes.
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

static APP: OnceLock<AppHandle> = OnceLock::new();
unsafe extern "C" {
    fn ff_app_quit_initialize(owner: extern "C" fn() -> u64, request: extern "C" fn()) -> bool;
    fn ff_app_quit_complete(owner: u64, saved: bool);
}

pub(crate) fn handle(app: &AppHandle, event: &tauri::RunEvent) {
    if !matches!(event, tauri::RunEvent::Ready) || APP.set(app.clone()).is_err() {
        return;
    }
    // Ready follows AppKit's launch handlers; installing earlier could be
    // overwritten by AppKit's default quit Apple-event handler.
    if !unsafe { ff_app_quit_initialize(owner, request) } {
        crate::logging::warn("app_quit", "Apple-event quit handler unavailable");
    }
}

extern "C" fn owner() -> u64 {
    let Some(app) = APP.get() else {
        return 0;
    };
    let update = app.state::<crate::managed_update::ManagedUpdateAuthority>();
    if update.is_installing() || update.restart_pending() {
        return 0;
    }
    app.state::<crate::draft_exit::DraftExit>().external_owner()
}

extern "C" fn request() {
    if let Some(app) = APP.get() {
        app.exit(0);
    }
}

/// Called synchronously from the main event loop, only after its final exit
/// recheck consumed this owner. A save acknowledgement alone is insufficient.
pub(crate) fn reply_allowed(token: u64) {
    unsafe { ff_app_quit_complete(token, true) };
}

pub(crate) fn reply_cancelled(app: &AppHandle, token: u64) {
    if APP.get().is_none() {
        return;
    }
    if app
        .run_on_main_thread(move || unsafe { ff_app_quit_complete(token, false) })
        .is_err()
    {
        crate::logging::warn("app_quit", "Apple-event quit reply unconfirmed");
    }
}
