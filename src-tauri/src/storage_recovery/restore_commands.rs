use super::{
    restore::{RestoreFailure, RestorePreview, RestoreReceipt},
    *,
};

#[tauri::command]
pub async fn storage_recovery_restore_preview(
    app: AppHandle,
    source: String,
) -> Result<RestorePreview, RestoreFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<StorageRecoveryState>();
        let mut state = state
            .0
            .lock()
            .map_err(|_| RestoreFailure::new("unavailable"))?;
        if state.editable || !state.status.ready {
            return Err(RestoreFailure::new("unavailable"));
        }
        let store = app
            .try_state::<MetaStore>()
            .ok_or_else(|| RestoreFailure::new("unavailable"))?;
        state.restore.preview(&store, Path::new(&source))
    })
    .await
    .map_err(|_| RestoreFailure::new("unavailable"))?
}
#[tauri::command]
pub async fn storage_recovery_restore_apply(
    app: AppHandle,
    id: String,
    keys: Vec<String>,
    backup_directory: String,
) -> Result<RestoreReceipt, RestoreFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<StorageRecoveryState>();
        let store = app.try_state::<MetaStore>();
        state.apply_startup_restore(store.as_deref(), &id, &keys, Path::new(&backup_directory))
    })
    .await
    // A worker failure cannot establish whether commit already happened.
    .map_err(|_| RestoreFailure::new("unknown"))?
}

impl StorageRecoveryState {
    pub(super) fn apply_startup_restore(
        &self,
        store: Option<&MetaStore>,
        id: &str,
        keys: &[String],
        backup_directory: &Path,
    ) -> Result<RestoreReceipt, RestoreFailure> {
        let _change = self.begin_change()?;
        let mut state = self
            .0
            .lock()
            .map_err(|_| RestoreFailure::new("unavailable"))?;
        if state.editable || !state.status.ready {
            return Err(RestoreFailure::new("unavailable"));
        }
        let store = store.ok_or_else(|| RestoreFailure::new("unavailable"))?;
        let path = state.path.clone();
        state
            .restore
            .apply(store, &path, id, keys, backup_directory)
    }
}

#[tauri::command]
pub fn storage_recovery_restore_receipt(
    app: AppHandle,
    id: String,
) -> Result<Option<RestoreReceipt>, RestoreFailure> {
    let state = app.state::<StorageRecoveryState>();
    let state = state
        .0
        .lock()
        .map_err(|_| RestoreFailure::new("unavailable"))?;
    Ok(state.restore.receipt(&id))
}
#[tauri::command]
pub fn storage_recovery_restore_cancel(app: AppHandle) -> Result<(), RestoreFailure> {
    let state = app.state::<StorageRecoveryState>();
    let mut state = state
        .0
        .lock()
        .map_err(|_| RestoreFailure::new("unavailable"))?;
    if state.editable {
        return Err(RestoreFailure::new("unavailable"));
    }
    state.restore.cancel();
    Ok(())
}
