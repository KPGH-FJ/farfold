//! Recovery never substitutes an empty store. Only successful initialization
//! opens the application command gate; original materials are preserved.
mod database_commands;
mod database_restore;
mod error;
mod export;
pub use database_commands::*;
pub(crate) mod restore;
mod restore_commands;
pub use restore_commands::*;
#[cfg(test)]
mod restore_tests;
#[cfg(test)]
mod tests;

use crate::meta_store::MetaStore;
pub use error::StorageIssue;
pub(crate) use error::{io_receipt, sqlite_receipt};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicU8, Ordering},
    },
};
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryStatus {
    pub ready: bool,
    pub issue: Option<StorageIssue>,
    pub data_directory: String,
    pub database_replacement_available: bool,
    pub database_replacement: Option<database_restore::Status>,
}
struct Recovery {
    path: PathBuf,
    // Once any database was observed, disappearance must never create an empty replacement.
    observed_database: bool,
    status: RecoveryStatus,
    editable: bool,
    restore: restore::RestoreState,
    replacement: database_restore::State,
}
pub struct StorageRecoveryState(Mutex<Recovery>, AtomicU8);
const AVAILABLE: u8 = 0;
const CHANGING: u8 = 1;
const EXITING: u8 = 2;
struct ChangeGuard<'a>(&'a AtomicU8);
impl Drop for ChangeGuard<'_> {
    fn drop(&mut self) {
        let _ = self
            .0
            .compare_exchange(CHANGING, AVAILABLE, Ordering::SeqCst, Ordering::SeqCst);
    }
}
impl ChangeGuard<'_> {
    fn reserve_exit(&self) -> Result<(), restore::RestoreFailure> {
        self.0
            .compare_exchange(CHANGING, EXITING, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| restore::RestoreFailure::new("unavailable"))?;
        Ok(())
    }
}

impl StorageRecoveryState {
    pub fn new(path: PathBuf) -> Self {
        let observed_database = existing_material(&path)
            .map(|files| !files.is_empty())
            .unwrap_or(true);
        let data_directory = path
            .parent()
            .unwrap_or(Path::new(""))
            .to_string_lossy()
            .into_owned();
        Self(
            Mutex::new(Recovery {
                path,
                observed_database,
                editable: false,
                restore: restore::RestoreState::default(),
                replacement: database_restore::State::default(),
                status: RecoveryStatus {
                    ready: false,
                    issue: None,
                    data_directory,
                    database_replacement_available: database_restore::supported(),
                    database_replacement: None,
                },
            }),
            AtomicU8::new(AVAILABLE),
        )
    }
    fn begin_change(&self) -> Result<ChangeGuard<'_>, restore::RestoreFailure> {
        self.1
            .compare_exchange(AVAILABLE, CHANGING, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| restore::RestoreFailure::new("unavailable"))?;
        Ok(ChangeGuard(&self.1))
    }
    pub(crate) fn mark_editable(&self) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|_| "资料尚未就绪，请重试")?;
        if !state.status.ready || state.restore.active() || state.replacement.active() {
            return Err("资料恢复尚未完成，请先完成或取消恢复".into());
        }
        state.editable = true;
        Ok(())
    }
    pub fn allows(&self, command: &str) -> bool {
        self.0
            .lock()
            .map(|state| {
                if !state.status.ready || state.restore.active() || state.replacement.active() {
                    return command_allowed(false, command);
                }
                state.editable
                    || command_allowed(false, command)
                    || matches!(
                        command,
                        "settings_get"
                            | "app_drafts_ready"
                            | "host_performance_origin"
                            | "host_performance_sample"
                    )
            })
            .unwrap_or(false)
    }
}

/// Only these exact SQLite paths belong to this recovery operation. A leftover
/// journal/WAL is evidence of prior data even when the main file is missing.
pub(crate) fn existing_material(path: &Path) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let mut name = path.as_os_str().to_os_string();
        name.push(suffix);
        let candidate = PathBuf::from(name);
        match candidate.symlink_metadata() {
            Ok(_) => paths.push(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_receipt(error)),
        }
    }
    Ok(paths)
}

fn command_allowed(ready: bool, command: &str) -> bool {
    ready
        || matches!(
            command,
            "storage_recovery_status"
                | "storage_recovery_retry"
                | "storage_recovery_export"
                | "storage_recovery_reveal"
                | "storage_recovery_restore_preview"
                | "storage_recovery_restore_apply"
                | "storage_recovery_restore_receipt"
                | "storage_recovery_restore_cancel"
                | "storage_recovery_database_preview"
                | "storage_recovery_database_apply"
                | "storage_recovery_database_status"
                | "storage_recovery_database_continue"
                | "storage_recovery_database_cancel"
                | "storage_recovery_database_restart"
        )
}

impl Recovery {
    fn initialize(&mut self, install: impl FnOnce(MetaStore) -> Result<(), String>) {
        if self.status.ready || self.replacement.active() {
            return;
        }
        match self.open().and_then(install) {
            Ok(()) => {
                self.status.ready = true;
                self.status.issue = None;
            }
            Err(error) => self.status.issue = Some(StorageIssue::from_receipt(&error)),
        }
        self.refresh_replacement();
    }
    fn refresh_replacement(&mut self) {
        self.status.database_replacement = database_restore::inspect(&self.path)
            .unwrap_or_else(|_| Some(database_restore::Status::blocked()));
    }
    fn open(&mut self) -> Result<MetaStore, String> {
        self.observed_database |= database_restore::startup(&self.path)
            .map_err(|_| "FARFOLD_STORAGE:unknown:资料恢复尚未完成".to_string())?;
        self.observed_database |= !existing_material(&self.path)?.is_empty();
        match self.path.symlink_metadata() {
            Ok(_) => self.observed_database = true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if self.observed_database {
                    return Err("FARFOLD_STORAGE:missing:之前的资料文件不在原位置".into());
                }
            }
            Err(error) => return Err(io_receipt(error)),
        }
        let result = MetaStore::open(&self.path).and_then(|store| {
            crate::lifemodel::ensure_defaults(&store)?;
            Ok(store)
        });
        // Failed initialization can still have created the file. Preserve that fact for retry.
        self.observed_database |= self.path.symlink_metadata().is_ok();
        result
    }
}

/// Invoked after every non-storage State is registered. Holding the recovery
/// mutex serializes retries/exports and keeps the command gate closed until
/// MetaStore exists and all required initialization has succeeded.
pub fn initialize(app: &AppHandle) -> Result<RecoveryStatus, String> {
    let state = app.state::<StorageRecoveryState>();
    let mut recovery = state
        .0
        .lock()
        .map_err(|_| "暂时无法检查资料，请重新打开应用")?;
    if recovery.status.ready {
        return Ok(recovery.status.clone());
    }
    recovery.initialize(|store| {
        if !app.manage(store) {
            return Err("资料已经打开，请重新打开应用".into());
        }
        let notifications = app.clone();
        // Native delegates require the main thread, including after a retry.
        if app
            .run_on_main_thread(move || crate::desktop_notifications::initialize(&notifications))
            .is_err()
        {
            crate::logging::warn(
                "storage_recovery",
                "notification initialization unavailable",
            );
        }
        Ok(())
    });
    Ok(recovery.status.clone())
}

#[tauri::command]
pub fn storage_recovery_status(app: AppHandle) -> Result<RecoveryStatus, String> {
    app.state::<StorageRecoveryState>()
        .0
        .lock()
        .map(|state| state.status.clone())
        .map_err(|_| "暂时无法读取资料状态".into())
}
#[tauri::command]
pub async fn storage_recovery_retry(app: AppHandle) -> Result<RecoveryStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<StorageRecoveryState>();
        let _change = state
            .begin_change()
            .map_err(|_| "暂时无法检查资料，请稍后重试")?;
        initialize(&app)
    })
    .await
    .map_err(|_| "暂时无法检查资料，请重试")?
}

/// The non-editable shell has no renderer save owner. Reserve exit against
/// whole-database mutations with the same atomic admission as those commands.
pub fn handle_run_event(app: &AppHandle, event: &tauri::RunEvent) {
    if app.try_state::<MetaStore>().is_some() {
        return;
    }
    let Some(state) = app.try_state::<StorageRecoveryState>() else {
        return;
    };
    match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            if state
                .1
                .compare_exchange(AVAILABLE, EXITING, Ordering::SeqCst, Ordering::SeqCst)
                == Err(CHANGING)
            {
                api.prevent_exit();
            }
        }
        tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } => {
            api.prevent_close();
            if state
                .1
                .compare_exchange(AVAILABLE, EXITING, Ordering::SeqCst, Ordering::SeqCst)
                != Err(CHANGING)
            {
                app.exit(0);
            }
        }
        _ => {}
    }
}
#[tauri::command]
pub async fn storage_recovery_export(
    app: AppHandle,
    directory: String,
) -> Result<export::ExportReceipt, export::ExportFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<StorageRecoveryState>();
        let recovery = state
            .0
            .lock()
            .map_err(|_| export::ExportFailure::new("暂时无法保存恢复副本", None))?;
        let store = app.try_state::<MetaStore>();
        export::export(&recovery.path, store.as_deref(), Path::new(&directory))
    })
    .await
    .map_err(|_| export::ExportFailure::new("暂时无法保存恢复副本", None))?
}
#[tauri::command]
pub fn storage_recovery_reveal(app: AppHandle) -> Result<(), String> {
    let state = app.state::<StorageRecoveryState>();
    let recovery = state.0.lock().map_err(|_| "暂时无法打开资料位置")?;
    let directory = recovery.path.parent().ok_or("无法找到资料位置")?;
    tauri_plugin_opener::open_path(directory, None::<&str>)
        .map_err(|_| "无法打开资料位置，请检查目录是否可访问".into())
}
