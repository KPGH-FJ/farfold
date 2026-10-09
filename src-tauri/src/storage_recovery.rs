//! Recovery never substitutes an empty store. Only successful initialization
//! opens the application command gate; original files stay at the same path.
mod error;
mod export;
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
    sync::Mutex,
};
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryStatus {
    pub ready: bool,
    pub issue: Option<StorageIssue>,
    pub data_directory: String,
}
struct Recovery {
    path: PathBuf,
    // Once any database was observed, disappearance must never create an empty replacement.
    observed_database: bool,
    status: RecoveryStatus,
    editable: bool,
    restore: restore::RestoreState,
}
pub struct StorageRecoveryState(Mutex<Recovery>);

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
        Self(Mutex::new(Recovery {
            path,
            observed_database,
            editable: false,
            restore: restore::RestoreState::default(),
            status: RecoveryStatus {
                ready: false,
                issue: None,
                data_directory,
            },
        }))
    }
    pub(crate) fn mark_editable(&self) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|_| "资料尚未就绪，请重试")?;
        if !state.status.ready || state.restore.active() {
            return Err("资料恢复尚未完成，请先完成或取消恢复".into());
        }
        state.editable = true;
        Ok(())
    }
    pub fn allows(&self, command: &str) -> bool {
        self.0
            .lock()
            .map(|state| {
                if !state.status.ready || state.restore.active() {
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
        )
}

impl Recovery {
    fn initialize(&mut self, install: impl FnOnce(MetaStore) -> Result<(), String>) {
        if self.status.ready {
            return;
        }
        match self.open().and_then(install) {
            Ok(()) => {
                self.status.ready = true;
                self.status.issue = None;
            }
            Err(error) => self.status.issue = Some(StorageIssue::from_receipt(&error)),
        }
    }
    fn open(&mut self) -> Result<MetaStore, String> {
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
    tauri::async_runtime::spawn_blocking(move || initialize(&app))
        .await
        .map_err(|_| "暂时无法检查资料，请重试")?
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
