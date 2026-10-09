use super::{
    database_restore::{Preview, Status},
    restore::RestoreFailure,
    *,
};

fn require_shell(app: &AppHandle, state: &Recovery) -> Result<(), RestoreFailure> {
    if state.status.ready || state.editable || app.try_state::<MetaStore>().is_some() {
        return Err(RestoreFailure::new("unavailable"));
    }
    Ok(())
}

#[tauri::command]
pub async fn storage_recovery_database_preview(
    app: AppHandle,
    source: String,
) -> Result<Preview, RestoreFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<StorageRecoveryState>();
        let _change = state.begin_change()?;
        let mut state = state
            .0
            .lock()
            .map_err(|_| RestoreFailure::new("unavailable"))?;
        require_shell(&app, &state)?;
        let path = state.path.clone();
        state.replacement.preview(&path, Path::new(&source))
    })
    .await
    .map_err(|_| RestoreFailure::new("unavailable"))?
}
#[tauri::command]
pub async fn storage_recovery_database_apply(
    app: AppHandle,
    id: String,
) -> Result<Status, RestoreFailure> {
    change(app, id, false).await
}
#[tauri::command]
pub async fn storage_recovery_database_continue(
    app: AppHandle,
    id: String,
) -> Result<Status, RestoreFailure> {
    change(app, id, true).await
}
async fn change(app: AppHandle, id: String, continuing: bool) -> Result<Status, RestoreFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<StorageRecoveryState>();
        let _change = state.begin_change()?;
        let mut state = state
            .0
            .lock()
            .map_err(|_| RestoreFailure::new("unavailable"))?;
        require_shell(&app, &state)?;
        let path = state.path.clone();
        let result = if continuing {
            state.replacement.resume(&path, &id)
        } else {
            state.replacement.apply(&path, &id)
        };
        state.refresh_replacement();
        result
    })
    .await
    .map_err(|_| RestoreFailure::new("unknown"))?
}
#[tauri::command]
pub async fn storage_recovery_database_status(
    app: AppHandle,
) -> Result<Option<Status>, RestoreFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<StorageRecoveryState>();
        let mut state = state
            .0
            .lock()
            .map_err(|_| RestoreFailure::new("unavailable"))?;
        require_shell(&app, &state)?;
        state.refresh_replacement();
        Ok(state.status.database_replacement.clone())
    })
    .await
    .map_err(|_| RestoreFailure::new("unknown"))?
}
#[tauri::command]
pub fn storage_recovery_database_cancel(app: AppHandle) -> Result<(), RestoreFailure> {
    let state = app.state::<StorageRecoveryState>();
    let _change = state.begin_change()?;
    let mut state = state
        .0
        .lock()
        .map_err(|_| RestoreFailure::new("unavailable"))?;
    require_shell(&app, &state)?;
    let path = state.path.clone();
    state.replacement.cancel(&path)
}
#[tauri::command]
pub async fn storage_recovery_database_restart(
    app: AppHandle,
    id: String,
) -> Result<(), RestoreFailure> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<StorageRecoveryState>();
        let _change = state.begin_change()?;
        let state = state
            .0
            .lock()
            .map_err(|_| RestoreFailure::new("unavailable"))?;
        require_shell(&app, &state)?;
        let receipt = database_restore::inspect(&state.path)?
            .ok_or_else(|| RestoreFailure::new("unknown"))?;
        if receipt.id.as_deref() != Some(&id) || !receipt.can_restart {
            return Err(RestoreFailure::new("unknown"));
        }
        // No MetaStore or editable renderer has existed in this process.
        // Atomically promote admission; no other operation can enter a gap.
        _change.reserve_exit()?;
        drop(state);
        app.request_restart();
        Ok(())
    })
    .await
    .map_err(|_| RestoreFailure::new("unknown"))?
}
