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
    clearing: AtomicBool,
    preparing: AtomicBool,
    serial: AtomicU64,
    pending: Mutex<Option<(u64, i32, bool)>>,
    exit_admission: Mutex<Option<crate::managed_update::UpdatePermit>>,
    copy_exit_admission: Mutex<Option<crate::managed_update::UpdatePermit>>,
    worktree_exit_admission: Mutex<Option<crate::managed_update::UpdatePermit>>,
}
pub(crate) struct ClearExitGuard<'a>(&'a DraftExit);
struct ExitPreparation<'a>(&'a AtomicBool);
impl Drop for ExitPreparation<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
impl Drop for ClearExitGuard<'_> {
    fn drop(&mut self) {
        self.0.clearing.store(false, Ordering::SeqCst);
    }
}
impl DraftExit {
    fn begin_preparation(
        &self,
        token: u64,
        installing: bool,
    ) -> Result<ExitPreparation<'_>, String> {
        let pending = self.pending.lock().map_err(|_| "暂时无法关闭，请重试")?;
        if !matches!(*pending, Some((current, _, false)) if current == token) {
            return Err("关闭请求已失效".into());
        }
        if self.clearing.load(Ordering::SeqCst) {
            return Err("正在清除数据，请等待完成后重新打开应用".into());
        }
        if installing {
            return Err("更新正在安装，请稍后再试".into());
        }
        self.preparing
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "正在准备退出，请稍后重试")?;
        Ok(ExitPreparation(&self.preparing))
    }
    pub(crate) fn begin_data_clear(&self) -> ClearExitGuard<'_> {
        self.clearing.store(true, Ordering::SeqCst);
        ClearExitGuard(self)
    }
    /// A successful data clear has already sealed the old database connection.
    /// Retain admission until process exit and invalidate any earlier save owner.
    /// The new renderer will load only the empty store after restart.
    pub(crate) fn prepare_cleared_restart(
        &self,
        permit: crate::managed_update::UpdatePermit,
        copy_permit: crate::managed_update::UpdatePermit,
        worktree_permit: crate::managed_update::UpdatePermit,
    ) {
        self.ready.store(false, Ordering::SeqCst);
        *self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
        *self
            .exit_admission
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(permit);
        *self
            .copy_exit_admission
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(copy_permit);
        *self
            .worktree_exit_admission
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(worktree_permit);
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn external_owner(&self) -> u64 {
        if !self.ready.load(Ordering::SeqCst) {
            return 0;
        }
        let Ok(token) = self.request(0) else {
            return 0;
        };
        self.pending
            .lock()
            .ok()
            .and_then(|pending| match *pending {
                Some((current, code, false))
                    if current == token && code != tauri::RESTART_EXIT_CODE =>
                {
                    Some(token)
                }
                _ => None,
            })
            .unwrap_or(0)
    }
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
    fn complete(
        &self,
        token: u64,
        installing: bool,
        admit: impl FnOnce() -> Result<Option<crate::managed_update::UpdatePermit>, String>,
    ) -> Result<i32, String> {
        let mut pending = self.pending.lock().map_err(|_| "暂时无法关闭，请重试")?;
        match *pending {
            Some((current, code, false)) if current == token => {
                if self.clearing.load(Ordering::SeqCst) {
                    return Err("正在清除数据，请等待完成后重新打开应用".into());
                }
                if installing {
                    return Err("更新正在安装，请稍后再试".into());
                }
                // Verify the exact save owner before taking admission. Restart
                // already owns it through ManagedUpdateAuthority.
                if code != tauri::RESTART_EXIT_CODE {
                    *self
                        .exit_admission
                        .lock()
                        .map_err(|_| "暂时无法关闭，请重试")? = admit()?;
                }
                *pending = Some((current, code, true));
                Ok(code)
            }
            _ => Err("关闭请求已失效".into()),
        }
    }

    fn cancel(&self, token: u64) -> Result<(), String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "暂时无法取消退出，请重试")?;
        match *pending {
            Some((current, _, false)) if current == token => {
                // Only withdraw this unacknowledged request. The installed
                // update and ManagedUpdateAuthority's restart admission stay.
                *pending = None;
                Ok(())
            }
            _ => Err("关闭请求已失效".into()),
        }
    }

    // An acknowledged normal exit may already be queued when installation
    // begins. Recheck before consuming it, retaining the original save owner.
    fn take_allowed(&self, installing: bool) -> (Option<u64>, Option<u64>) {
        let Ok(mut pending) = self.pending.lock() else {
            return (None, None);
        };
        match *pending {
            Some((token, code, true)) if installing || self.clearing.load(Ordering::SeqCst) => {
                *pending = Some((token, code, false));
                (None, Some(token))
            }
            Some((token, _, true)) => {
                *pending = None;
                (Some(token), None)
            }
            _ => (None, None),
        }
    }
}

pub fn handle(app: &AppHandle, event: &tauri::RunEvent) {
    let state = app.state::<DraftExit>();
    if !state.ready.load(Ordering::SeqCst) {
        // A copy admitted before renderer startup acknowledgement still owns
        // real OS work. Never rely solely on the renderer's exit UI.
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let mut copies = state
                .copy_exit_admission
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let mut worktrees = state
                .worktree_exit_admission
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if copies.is_none() || worktrees.is_none() {
                copies.take();
                worktrees.take();
                let store = app.try_state::<crate::meta_store::MetaStore>();
                let admit = || {
                    admit_file_exit(
                        &app.state::<crate::file_copy_jobs::FileCopyJobs>(),
                        &app.state::<crate::worktrees::Worktrees>(),
                        store.as_deref(),
                        false,
                    )
                };
                // Storage can be open while the renderer is still in recovery.
                let admission = if store.is_some() {
                    app.state::<crate::storage_recovery::StorageRecoveryState>()
                        .admit_startup_exit(admit)
                } else {
                    admit()
                };
                match admission {
                    Ok((copy, worktree)) => {
                        *copies = Some(copy);
                        *worktrees = Some(worktree);
                    }
                    Err(_) => api.prevent_exit(),
                }
            }
        } else if let tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } = event
            && app.try_state::<crate::meta_store::MetaStore>().is_some()
        {
            // Keep the recovery window available if the exit is blocked.
            api.prevent_close();
            app.exit(0);
        }
        return;
    }
    match event {
        tauri::RunEvent::ExitRequested { api, code, .. } => {
            let installing = app
                .state::<crate::managed_update::ManagedUpdateAuthority>()
                .is_installing();
            let (allowed, deferred) = state.take_allowed(installing);
            if deferred.is_some() {
                state
                    .copy_exit_admission
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .take();
            }
            if deferred.is_some() {
                state
                    .worktree_exit_admission
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .take();
            }
            if let Some(owner) = allowed {
                #[cfg(target_os = "macos")]
                crate::macos_quit::reply_allowed(owner);
                #[cfg(not(target_os = "macos"))]
                let _ = owner;
                return;
            }
            api.prevent_exit();
            // Installation owns the on-disk app until it finishes. Its restart
            // will request the save barrier explicitly after the swap.
            if installing || state.clearing.load(Ordering::SeqCst) {
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
    app.emit("app:save-before-restart", token)
        .map_err(|_| "更新已安装，未能确认保存，请稍后重新打开应用".into())
}

#[tauri::command]
pub fn app_drafts_ready(app: AppHandle) -> Result<(), String> {
    app.state::<crate::storage_recovery::StorageRecoveryState>()
        .mark_editable()?;
    app.state::<DraftExit>().ready.store(true, Ordering::SeqCst);
    Ok(())
}
#[tauri::command]
pub async fn app_exit_after_save(
    app: AppHandle,
    token: u64,
    confirm_activity: Option<bool>,
) -> Result<(), String> {
    let state = app.state::<DraftExit>();
    let _preparation = state.begin_preparation(
        token,
        app.state::<crate::managed_update::ManagedUpdateAuthority>()
            .is_installing(),
    )?;
    // Separate from confirm_activity: confirmed Agent interruption never
    // cancels a filesystem write, nor permits a late copy after this point.
    let store = app.try_state::<crate::meta_store::MetaStore>();
    let (copy_permit, worktree_permit) = admit_file_exit(
        &app.state::<crate::file_copy_jobs::FileCopyJobs>(),
        &app.state::<crate::worktrees::Worktrees>(),
        store.as_deref(),
        confirm_activity == Some(true),
    )?;
    // Remove only tools owned by this live connection before taking the quiet
    // exit permit. An explicit existing interruption decision still permits
    // exit if native cleanup is unknown; local permissions are revoked either way.
    if crate::browser_sharing::prepare_shutdown(&app)
        .await
        .is_err()
        && confirm_activity != Some(true)
    {
        // This is an unresolved tool removal, not a draft save failure. The
        // existing confirmation flow lets the user stay or explicitly exit.
        return Err("BROWSER_TOOL_EXIT_REVIEW_REQUIRED".into());
    }
    let installing = app
        .state::<crate::managed_update::ManagedUpdateAuthority>()
        .is_installing();
    let code = app.state::<DraftExit>().complete(token, installing, || {
        match crate::managed_update::quiet_exit() {
            Ok(permit) => Ok(Some(permit)),
            Err(_) if confirm_activity == Some(true) => Ok(None),
            Err(error) => Err(error),
        }
    })?;
    *app.state::<DraftExit>()
        .copy_exit_admission
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(copy_permit);
    *app.state::<DraftExit>()
        .worktree_exit_admission
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(worktree_permit);
    if code == tauri::RESTART_EXIT_CODE {
        app.request_restart();
    } else {
        app.exit(code);
    }
    Ok(())
}

fn admit_file_exit(
    copies: &crate::file_copy_jobs::FileCopyJobs,
    worktrees: &crate::worktrees::Worktrees,
    store: Option<&crate::meta_store::MetaStore>,
    confirm: bool,
) -> Result<
    (
        crate::managed_update::UpdatePermit,
        crate::managed_update::UpdatePermit,
    ),
    String,
> {
    let copy = copies
        .seal_exit_with_confirmation(confirm)
        .map_err(|error| {
            if error == "EXIT_CONFIRMATION_REQUIRED" {
                "FILE_COPY_EXIT_REVIEW_REQUIRED".into()
            } else {
                error
            }
        })?;
    let worktree = worktrees.seal_exit(store, confirm).map_err(|error| {
        if error == "EXIT_CONFIRMATION_REQUIRED" {
            "WORKTREE_EXIT_REVIEW_REQUIRED".into()
        } else {
            error
        }
    })?;
    Ok((copy, worktree))
}

#[tauri::command]
pub fn app_exit_cancel(app: AppHandle, token: u64) -> Result<(), String> {
    app.state::<DraftExit>().cancel(token)?;
    #[cfg(target_os = "macos")]
    crate::macos_quit::reply_cancelled(&app, token);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn asynchronous_exit_cleanup_keeps_one_current_owner_and_releases_on_failure() {
        let state = DraftExit::default();
        let owner = state.request(0).unwrap();
        assert!(state.begin_preparation(owner + 1, false).is_err());
        assert!(state.begin_preparation(owner, true).is_err());
        let preparation = state.begin_preparation(owner, false).unwrap();
        assert!(state.begin_preparation(owner, false).is_err());
        // Cancellation while cleanup is in flight must invalidate the final exit.
        state.cancel(owner).unwrap();
        assert!(
            state
                .complete(owner, false, || panic!("stale cleanup must not admit exit"))
                .is_err()
        );
        let next = state.request(0).unwrap();
        assert!(state.begin_preparation(next, false).is_err());
        drop(preparation);
        let retry = state.begin_preparation(next, false).unwrap();
        drop(retry);
        assert_eq!(state.complete(next, false, || Ok(None)).unwrap(), 0);
        assert!(state.begin_preparation(next, false).is_err());
    }

    #[test]
    fn unacknowledged_restart_can_stay_in_app_without_allowing_exit() {
        let state = DraftExit::default();
        let token = state.request(tauri::RESTART_EXIT_CODE).unwrap();
        assert!(
            state.cancel(token).is_ok(),
            "the user can withdraw this save/restart request"
        );
        assert!(state.complete(token, false, || Ok(None)).is_err());
        assert_eq!(state.take_allowed(false), (None, None));
        let next = state.request(tauri::RESTART_EXIT_CODE).unwrap();
        assert_ne!(next, token);
    }
    #[test]
    fn data_clear_blocks_quit_then_restarts_without_saving_old_drafts() {
        let gate = crate::managed_update::UpdateAdmission::default();
        let state = DraftExit::default();
        state.ready.store(true, Ordering::SeqCst);
        let owner = state.request(0).unwrap();
        state.complete(owner, false, || Ok(None)).unwrap();
        let clearing = state.begin_data_clear();
        assert_eq!(state.take_allowed(false), (None, Some(owner)));
        assert!(state.complete(owner, false, || Ok(None)).is_err());
        let copies = crate::file_copy_jobs::FileCopyJobs::default();
        let worktrees = crate::worktrees::Worktrees::default();
        state.prepare_cleared_restart(
            gate.update().unwrap(),
            copies.seal_exit().unwrap(),
            worktrees.seal_exit(None, false).unwrap(),
        );
        assert!(worktrees.seal_exit(None, false).is_err());
        assert!(
            copies.seal_exit().is_err(),
            "copy admission is retained until the cleared restart"
        );
        assert!(!state.ready.load(Ordering::SeqCst));
        assert!(state.complete(owner, false, || Ok(None)).is_err());
        assert!(gate.activity().is_err());
        drop(clearing);
        assert!(
            gate.activity().is_err(),
            "restart keeps admission until process exit"
        );
    }

    #[test]
    fn failed_clear_releases_its_quit_barrier() {
        let state = DraftExit::default();
        let owner = state.request(0).unwrap();
        let clearing = state.begin_data_clear();
        assert!(state.complete(owner, false, || Ok(None)).is_err());
        drop(clearing);
        assert_eq!(state.complete(owner, false, || Ok(None)).unwrap(), 0);
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn apple_event_owner_requires_ready_and_reuses_only_unconfirmed_normal_exit() {
        let state = DraftExit::default();
        assert_eq!(state.external_owner(), 0);
        assert!(state.pending.lock().unwrap().is_none());
        state.ready.store(true, Ordering::SeqCst);
        let owner = state.external_owner();
        assert_ne!(owner, 0);
        assert_eq!(state.external_owner(), owner);
        assert_eq!(state.request(0).unwrap(), owner);
        assert!(state.complete(owner, false, || Err("busy".into())).is_err());
        assert_eq!(state.external_owner(), owner);
        state.cancel(owner).unwrap();
        let next = state.external_owner();
        assert_ne!(next, owner);
        assert!(state.complete(owner, false, || Ok(None)).is_err());
        assert_eq!(state.external_owner(), next);
        state.complete(next, false, || Ok(None)).unwrap();
        assert_eq!(state.external_owner(), 0);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn apple_event_cannot_take_over_an_installed_restart() {
        let state = DraftExit::default();
        state.ready.store(true, Ordering::SeqCst);
        let token = state.request(tauri::RESTART_EXIT_CODE).unwrap();
        assert_eq!(state.external_owner(), 0);
        assert_eq!(state.request(tauri::RESTART_EXIT_CODE).unwrap(), token);
    }
    #[test]
    fn quiet_exit_keeps_new_activity_out_after_save() {
        let gate = crate::managed_update::UpdateAdmission::default();
        let state = DraftExit::default();
        let token = state.request(0).unwrap();
        assert_eq!(
            state
                .complete(token, false, || gate.update().map(Some))
                .unwrap(),
            0
        );
        assert!(gate.activity().is_err());
        assert_eq!(state.take_allowed(false), (Some(token), None));
        assert!(gate.activity().is_err());
        drop(state);
        assert!(gate.activity().is_ok());
    }

    #[test]
    fn active_work_requires_acknowledgement_and_can_still_cancel() {
        let gate = crate::managed_update::UpdateAdmission::default();
        let _work = gate.activity().unwrap();
        let state = DraftExit::default();
        let token = state.request(0).unwrap();
        assert!(
            state
                .complete(token, false, || gate.update().map(Some))
                .is_err()
        );
        assert_eq!(state.take_allowed(false), (None, None));
        assert!(state.cancel(token + 1).is_err());
        assert!(state.cancel(token).is_ok());
        assert!(
            state
                .complete(token, false, || panic!(
                    "stale token cannot acquire admission"
                ))
                .is_err()
        );
        let next = state.request(0).unwrap();
        assert_ne!(next, token);
        // Represents the separately confirmed user decision, not a stop receipt.
        assert_eq!(state.complete(next, false, || Ok(None)).unwrap(), 0);
        assert!(state.cancel(next).is_err());
    }

    #[test]
    fn acknowledged_restart_keeps_its_own_admission_and_cannot_be_cancelled() {
        let state = DraftExit::default();
        let token = state.request(tauri::RESTART_EXIT_CODE).unwrap();
        assert_eq!(
            state
                .complete(token, false, || panic!("restart admission already held"))
                .unwrap(),
            tauri::RESTART_EXIT_CODE
        );
        assert!(state.cancel(token).is_err());
    }
    #[test]
    fn repeated_exit_keeps_one_owner_and_stale_save_cannot_authorize_exit() {
        let state = DraftExit::default();
        let token = state.request(9).unwrap();
        assert_eq!(state.request(0).unwrap(), token);
        assert!(state.complete(token + 1, false, || Ok(None)).is_err());
        assert_eq!(state.take_allowed(false), (None, None));
        assert_eq!(state.complete(token, false, || Ok(None)).unwrap(), 9);
        assert!(state.complete(token, false, || Ok(None)).is_err());
        assert_eq!(state.take_allowed(false), (Some(token), None));
    }

    #[test]
    fn restart_supersedes_a_failed_normal_exit_and_rejects_its_late_save() {
        let state = DraftExit::default();
        let closing = state.request(0).unwrap();
        let restart = state.request(tauri::RESTART_EXIT_CODE).unwrap();
        assert_ne!(closing, restart);
        assert!(state.complete(closing, false, || Ok(None)).is_err());
        assert_eq!(
            state.complete(restart, false, || Ok(None)).unwrap(),
            tauri::RESTART_EXIT_CODE
        );
    }

    #[test]
    fn installation_rejects_old_save_and_rechecks_an_already_queued_exit() {
        let state = DraftExit::default();
        let closing = state.request(0).unwrap();
        assert!(state.complete(closing, true, || Ok(None)).is_err());
        assert_eq!(state.take_allowed(true), (None, None));
        assert_eq!(state.request(0).unwrap(), closing);
        assert_eq!(state.complete(closing, false, || Ok(None)).unwrap(), 0);
        assert_eq!(state.take_allowed(true), (None, Some(closing)));
        assert_eq!(state.take_allowed(false), (None, None));
        let restart = state.request(tauri::RESTART_EXIT_CODE).unwrap();
        assert!(state.complete(closing, false, || Ok(None)).is_err());
        assert_eq!(
            state.complete(restart, false, || Ok(None)).unwrap(),
            tauri::RESTART_EXIT_CODE
        );
        assert_eq!(state.take_allowed(false), (Some(restart), None));
    }

    #[test]
    fn late_installation_cannot_release_a_saved_quit_owner() {
        let state = DraftExit::default();
        let owner = state.request(0).unwrap();
        // This represents explicit busy-work confirmation: save succeeded but
        // there is no quiet permit protecting against a late installation.
        state.complete(owner, false, || Ok(None)).unwrap();
        let mut replies = Vec::new();
        let (allowed, deferred) = state.take_allowed(true);
        replies.extend(allowed);
        assert!(replies.is_empty());
        assert_eq!(deferred, Some(owner));
        // Merely finishing installation cannot restore the retired approval.
        replies.extend(state.take_allowed(false).0);
        assert!(replies.is_empty());
        assert!(state.complete(owner + 1, false, || Ok(None)).is_err());
        assert_eq!(state.request(0).unwrap(), owner);
        state.complete(owner, false, || Ok(None)).unwrap();
        replies.extend(state.take_allowed(false).0);
        replies.extend(state.take_allowed(false).0);
        assert_eq!(replies, [owner]);
    }
}

#[cfg(test)]
#[path = "draft_exit_worktree_tests.rs"]
mod worktree_tests;
