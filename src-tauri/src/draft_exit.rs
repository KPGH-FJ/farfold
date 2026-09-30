//! Normal exit waits for the renderer's latest unsent-input save. Agent
//! shutdown remains in the existing final Exit handler.
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct DraftExit {
    ready: AtomicBool,
    serial: AtomicU64,
    pending: Mutex<Option<(u64, i32, bool)>>,
}
impl DraftExit {
    fn request(&self, code: i32) -> Result<u64, String> {
        let mut pending = self.pending.lock().map_err(|_| "暂时无法关闭，请重试")?;
        if code == tauri::RESTART_EXIT_CODE
            && pending.is_some_and(|(_, old_code, _)| old_code != tauri::RESTART_EXIT_CODE)
        {
            *pending = None;
        }
        let (token, _, _) = *pending
            .get_or_insert_with(|| (self.serial.fetch_add(1, Ordering::SeqCst) + 1, code, false));
        Ok(token)
    }
    fn complete(&self, token: u64, installing: bool) -> Result<i32, String> {
        let mut pending = self.pending.lock().map_err(|_| "暂时无法关闭，请重试")?;
        match *pending {
            Some((current, code, false)) if current == token => {
                if installing {
                    return Err("更新正在安装，请稍后再试".into());
                }
                *pending = Some((current, code, true));
                Ok(code)
            }
            _ => Err("关闭请求已失效".into()),
        }
    }

    // An acknowledged normal exit may already be queued when installation
    // begins. Recheck before consuming it, retaining the original save owner.
    fn take_allowed(&self, installing: bool) -> (bool, Option<u64>) {
        let Ok(mut pending) = self.pending.lock() else {
            return (false, None);
        };
        match *pending {
            Some((token, code, true)) if installing => {
                *pending = Some((token, code, false));
                (false, Some(token))
            }
            Some((_, _, true)) => {
                *pending = None;
                (true, None)
            }
            _ => (false, None),
        }
    }
}

pub fn handle(app: &AppHandle, event: &tauri::RunEvent) {
    let state = app.state::<DraftExit>();
    if !state.ready.load(Ordering::SeqCst) {
        return;
    }
    match event {
        tauri::RunEvent::ExitRequested { api, code, .. } => {
            let installing = app
                .state::<crate::managed_update::ManagedUpdateAuthority>()
                .is_installing();
            let (allowed, deferred) = state.take_allowed(installing);
            if allowed {
                return;
            }
            api.prevent_exit();
            // Installation owns the on-disk app until it finishes. Its restart
            // will request the save barrier explicitly after the swap.
            if installing {
                if let Some(token) = deferred {
                    let _ = app.emit("app:exit-deferred", token);
                }
                return;
            }
            if app
                .state::<crate::managed_update::ManagedUpdateAuthority>()
                .restart_pending()
            {
                let _ = request_restart_after_save(app);
                return;
            }
            if let Ok(token) = state.request(code.unwrap_or(0)) {
                let _ = app.emit("app:save-before-exit", token);
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                }
            }
        }
        tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } => {
            api.prevent_close();
            app.exit(0);
        }
        _ => {}
    }
}

/// Tauri's restart exit code cannot be prevented. Ask the renderer to save
/// first; issue the actual restart only from the matching completion command.
pub fn request_restart_after_save(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<DraftExit>();
    if !state.ready.load(Ordering::SeqCst) {
        return Err("更新已安装，请在未发送内容保存后重新打开应用".into());
    }
    let token = state.request(tauri::RESTART_EXIT_CODE)?;
    app.emit("app:save-before-exit", token)
        .map_err(|_| "更新已安装，未能确认保存，请稍后重新打开应用".into())
}

#[tauri::command]
pub fn app_drafts_ready(app: AppHandle) {
    app.state::<DraftExit>().ready.store(true, Ordering::SeqCst);
}
#[tauri::command]
pub fn app_exit_after_save(app: AppHandle, token: u64) -> Result<(), String> {
    let installing = app
        .state::<crate::managed_update::ManagedUpdateAuthority>()
        .is_installing();
    let code = app.state::<DraftExit>().complete(token, installing)?;
    if code == tauri::RESTART_EXIT_CODE {
        app.request_restart();
    } else {
        app.exit(code);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_exit_keeps_one_owner_and_stale_save_cannot_authorize_exit() {
        let state = DraftExit::default();
        let token = state.request(9).unwrap();
        assert_eq!(state.request(0).unwrap(), token);
        assert!(state.complete(token + 1, false).is_err());
        assert_eq!(state.take_allowed(false), (false, None));
        assert_eq!(state.complete(token, false).unwrap(), 9);
        assert!(state.complete(token, false).is_err());
        assert_eq!(state.take_allowed(false), (true, None));
    }

    #[test]
    fn restart_supersedes_a_failed_normal_exit_and_rejects_its_late_save() {
        let state = DraftExit::default();
        let closing = state.request(0).unwrap();
        let restart = state.request(tauri::RESTART_EXIT_CODE).unwrap();
        assert_ne!(closing, restart);
        assert!(state.complete(closing, false).is_err());
        assert_eq!(
            state.complete(restart, false).unwrap(),
            tauri::RESTART_EXIT_CODE
        );
    }

    #[test]
    fn installation_rejects_old_save_and_rechecks_an_already_queued_exit() {
        let state = DraftExit::default();
        let closing = state.request(0).unwrap();
        assert!(state.complete(closing, true).is_err());
        assert_eq!(state.take_allowed(true), (false, None));
        assert_eq!(state.request(0).unwrap(), closing);
        assert_eq!(state.complete(closing, false).unwrap(), 0);
        assert_eq!(state.take_allowed(true), (false, Some(closing)));
        assert_eq!(state.take_allowed(false), (false, None));
        let restart = state.request(tauri::RESTART_EXIT_CODE).unwrap();
        assert!(state.complete(closing, false).is_err());
        assert_eq!(
            state.complete(restart, false).unwrap(),
            tauri::RESTART_EXIT_CODE
        );
        assert_eq!(state.take_allowed(false), (true, None));
    }
}
