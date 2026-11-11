use super::*;
use tauri::Manager;

#[tauri::command]
pub async fn session_tool_change_start(
    app: tauri::AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
    connection_id: String,
    operation_id: String,
    change: Change,
) -> Reply {
    let cwd = super::super::manager::validate_cwd_async(&cwd)
        .await
        .map_err(|_| ChangeError::from(Code::Changed).before_dispatch())?;
    app.state::<AcpManager>()
        .change_start(
            &app.state::<MetaStore>(),
            &agent_id,
            &cwd,
            &session_id,
            &connection_id,
            &operation_id,
            change,
            tokio::time::Instant::now() + BUDGET,
        )
        .await
}
#[tauri::command]
pub async fn session_tool_change_status(
    app: tauri::AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
    connection_id: String,
    operation_id: String,
) -> Reply {
    let cwd = super::super::manager::validate_cwd_async(&cwd)
        .await
        .map_err(|_| Code::Changed)?;
    app.state::<AcpManager>().change_status(
        &agent_id,
        &cwd,
        &session_id,
        &connection_id,
        &operation_id,
    )
}
#[tauri::command]
pub async fn session_tool_change_items(
    app: tauri::AppHandle,
    agent_id: String,
    cwd: String,
    session_id: String,
    connection_id: String,
) -> Result<Vec<Item>, ChangeError> {
    let cwd = super::super::manager::validate_cwd_async(&cwd)
        .await
        .map_err(|_| Code::Changed)?;
    app.state::<AcpManager>()
        .change_items(&agent_id, &cwd, &session_id, &connection_id)
}
