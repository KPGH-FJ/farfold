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

#[tauri::command]
pub async fn worktree_recycle_inspect(
    app: AppHandle,
    webview: Webview,
    action: worktrees::RecycleAction,
    record_id: String,
    expected_revision: u64,
) -> worktrees::Result<worktrees::RecycleInspection> {
    let (m, s) = context(&app, &webview)?;
    run(move || m.recycle_inspect(&s, action, &record_id, expected_revision)).await
}
#[tauri::command]
pub async fn worktree_recycle_prepare(
    app: AppHandle,
    webview: Webview,
    operation_id: String,
    inspection_id: String,
    action: worktrees::RecycleAction,
    expected_draft_baseline: worktrees::DraftBaseline,
) -> worktrees::Result<worktrees::Reply> {
    let (m, s) = context(&app, &webview)?;
    run(move || {
        m.prepare_recycle(
            &s,
            &operation_id,
            worktrees::RecycleInput {
                inspection_id,
                action,
                expected_draft_baseline,
            },
            |path| {
                crate::acp_client::manager::runtime()
                    .block_on(
                        app.state::<crate::acp_client::manager::AcpManager>()
                            .release_for_directory_maintenance(path),
                    )
                    .map_err(|_| worktrees::Failure {
                        code: "connectionUnconfirmed",
                    })
            },
        )
    })
    .await
}
#[tauri::command]
pub async fn worktree_recycle_check(
    app: AppHandle,
    webview: Webview,
    record_id: String,
    expected_revision: u64,
) -> worktrees::Result<worktrees::Listing> {
    let (m, s) = context(&app, &webview)?;
    run(move || m.recycle_check(&s, &record_id, expected_revision)).await
}

#[tauri::command]
pub async fn worktree_remove_inspect(
    app: AppHandle,
    webview: Webview,
    record_id: String,
    expected_revision: u64,
) -> worktrees::Result<worktrees::RemoveInspection> {
    let (m, s) = context(&app, &webview)?;
    run(move || m.remove_inspect(&s, &record_id, expected_revision)).await
}
#[tauri::command]
pub async fn worktree_remove_prepare(
    app: AppHandle,
    webview: Webview,
    operation_id: String,
    inspection_id: String,
    expected_draft_baseline: worktrees::DraftBaseline,
) -> worktrees::Result<worktrees::Reply> {
    let (m, s) = context(&app, &webview)?;
    run(move || {
        m.prepare_remove(
            &s,
            &operation_id,
            worktrees::RemoveInput {
                inspection_id,
                expected_draft_baseline,
            },
            |path| {
                crate::acp_client::manager::runtime()
                    .block_on(
                        app.state::<crate::acp_client::manager::AcpManager>()
                            .release_for_directory_maintenance(path),
                    )
                    .map_err(|_| worktrees::Failure {
                        code: "connectionUnconfirmed",
                    })
            },
        )
    })
    .await
}
// Keep the six explicit confirmation fields in the shared IPC contract; App/Webview are injected.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn worktree_remove_confirm(
    app: AppHandle,
    webview: Webview,
    operation_id: String,
    record_id: String,
    expected_revision: u64,
    recovery_id: String,
    recovery_sha256: String,
    manifest_sha256: String,
) -> worktrees::Result<worktrees::Reply> {
    let (m, s) = context(&app, &webview)?;
    run(move || {
        m.confirm_remove(
            &s,
            &operation_id,
            worktrees::RemoveConfirmation {
                record_id,
                expected_revision,
                recovery_id,
                recovery_sha256,
                manifest_sha256,
            },
        )
    })
    .await
}
#[tauri::command]
pub async fn worktree_recovery_check(
    app: AppHandle,
    webview: Webview,
    recovery_id: String,
    expected_revision: u64,
) -> worktrees::Result<worktrees::Listing> {
    let (m, s) = context(&app, &webview)?;
    run(move || m.recovery_check(&s, &recovery_id, expected_revision)).await
}

#[tauri::command]
pub async fn worktree_recover_prepare(
    app: AppHandle,
    webview: Webview,
    operation_id: String,
    recovery_id: String,
    expected_revision: u64,
    parent_path: String,
    directory_name: String,
) -> worktrees::Result<worktrees::Reply> {
    let (m, s) = context(&app, &webview)?;
    run(move || {
        m.prepare_recover(
            &s,
            &operation_id,
            worktrees::RecoverInput {
                recovery_id,
                expected_revision,
                parent_path,
                directory_name,
            },
        )
    })
    .await
}
