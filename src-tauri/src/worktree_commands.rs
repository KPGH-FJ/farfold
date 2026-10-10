//! Main-window only, explicit operations. A dropped IPC wait never retries Git.
use crate::{
    meta_store::MetaStore,
    worktrees::{self, Worktrees},
};
use tauri::{AppHandle, Manager, Webview};
fn context(app: &AppHandle, webview: &Webview) -> worktrees::Result<(Worktrees, MetaStore)> {
    if !crate::browser_workspace::caller_allowed(webview) {
        return Err(worktrees::Failure {
            code: "unavailable",
        });
    }
    let store = app
        .try_state::<MetaStore>()
        .ok_or(worktrees::Failure {
            code: "storageUnavailable",
        })?
        .inner()
        .clone();
    Ok((app.state::<Worktrees>().inner().clone(), store))
}
async fn run<T: Send + 'static>(
    f: impl FnOnce() -> worktrees::Result<T> + Send + 'static,
) -> worktrees::Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| worktrees::Failure { code: "unknown" })?
}
#[tauri::command]
pub async fn worktree_inspect(
    app: AppHandle,
    webview: Webview,
    path: String,
) -> worktrees::Result<worktrees::Inspection> {
    let (m, s) = context(&app, &webview)?;
    run(move || m.inspect(&s, &path)).await
}
#[tauri::command]
pub async fn worktree_refs(
    app: AppHandle,
    webview: Webview,
    inspection_id: String,
    cursor: Option<String>,
) -> worktrees::Result<worktrees::Refs> {
    let (m, _) = context(&app, &webview)?;
    run(move || m.refs(&inspection_id, cursor.as_deref())).await
}
#[tauri::command]
pub async fn worktree_list(
    app: AppHandle,
    webview: Webview,
) -> worktrees::Result<worktrees::Listing> {
    let (m, s) = context(&app, &webview)?;
    run(move || m.list(&s)).await
}
#[tauri::command]
pub async fn worktree_prepare_create(
    app: AppHandle,
    webview: Webview,
    operation_id: String,
    inspection_id: String,
    parent_path: String,
    directory_name: String,
    branch: worktrees::Branch,
) -> worktrees::Result<worktrees::Reply> {
    let (m, s) = context(&app, &webview)?;
    run(move || {
        m.prepare(
            &s,
            &operation_id,
            worktrees::Create {
                inspection_id,
                parent_path,
                directory_name,
                branch,
            },
        )
    })
    .await
}
#[tauri::command]
pub async fn worktree_start(
    app: AppHandle,
    webview: Webview,
    operation_id: String,
) -> worktrees::Result<worktrees::Reply> {
    let (m, s) = context(&app, &webview)?;
    run(move || m.start(&s, &operation_id)).await
}
#[tauri::command]
pub async fn worktree_status(
    app: AppHandle,
    webview: Webview,
    operation_id: String,
) -> worktrees::Result<worktrees::Reply> {
    let (m, s) = context(&app, &webview)?;
    run(move || m.status(&s, &operation_id)).await
}
#[tauri::command]
pub async fn worktree_cancel(
    app: AppHandle,
    webview: Webview,
    operation_id: String,
) -> worktrees::Result<worktrees::Reply> {
    let (m, s) = context(&app, &webview)?;
    run(move || m.cancel(&s, &operation_id)).await
}
#[tauri::command]
pub async fn worktree_recheck(
    app: AppHandle,
    webview: Webview,
    operation_id: String,
) -> worktrees::Result<worktrees::Reply> {
    let (m, s) = context(&app, &webview)?;
    run(move || m.recheck(&s, &operation_id)).await
}
#[tauri::command]
pub async fn worktree_adopt(
    app: AppHandle,
    webview: Webview,
    operation_id: String,
    inspection_id: String,
    tree_path: String,
) -> worktrees::Result<worktrees::Reply> {
    let (m, s) = context(&app, &webview)?;
    run(move || m.adopt(&s, &operation_id, &inspection_id, &tree_path)).await
}
#[tauri::command]
pub async fn worktree_check_location(
    app: AppHandle,
    webview: Webview,
    location_id: String,
) -> worktrees::Result<worktrees::Location> {
    let (m, s) = context(&app, &webview)?;
    run(move || m.check_location(&s, &location_id)).await
}
#[tauri::command]
pub async fn worktree_forget(
    app: AppHandle,
    webview: Webview,
    location_id: String,
    expected_revision: u64,
) -> worktrees::Result<worktrees::Forgotten> {
    let (m, s) = context(&app, &webview)?;
    run(move || m.forget(&s, &location_id, expected_revision)).await
}

#[tauri::command]
pub async fn worktree_acknowledge(
    app: AppHandle,
    webview: Webview,
    operation_id: String,
) -> worktrees::Result<worktrees::Reply> {
    let (m, s) = context(&app, &webview)?;
    run(move || m.acknowledge(&s, &operation_id)).await
}
