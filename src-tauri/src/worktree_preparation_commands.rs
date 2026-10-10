//! Main-window, bounded read observers; no project execution or durable jobs.
use crate::{
    meta_store::MetaStore,
    worktrees::{self, Worktrees},
};
use tauri::{AppHandle, Manager, Webview};

fn context(
    app: &AppHandle,
    webview: &Webview,
    command: &str,
) -> worktrees::Result<(Worktrees, MetaStore)> {
    if !crate::browser_workspace::caller_allowed(webview) {
        return Err(worktrees::Failure {
            code: "unavailable",
        });
    }
    // Keep the recovery-shell rule even if this function is invoked directly,
    // in addition to the dispatcher guard. No missing MetaStore initialization.
    if !app
        .try_state::<crate::storage_recovery::StorageRecoveryState>()
        .is_some_and(|s| s.allows(command))
    {
        return Err(worktrees::Failure {
            code: "storageUnavailable",
        });
    }
    let store = app
        .try_state::<MetaStore>()
        .ok_or(worktrees::Failure {
            code: "storageUnavailable",
        })?
        .inner()
        .clone();
    let manager = app
        .try_state::<Worktrees>()
        .ok_or(worktrees::Failure {
            code: "unavailable",
        })?
        .inner()
        .clone();
    Ok((manager, store))
}
fn fixed_failure(failure: worktrees::Failure) -> worktrees::Failure {
    worktrees::Failure {
        code: match failure.code {
            "unavailable" => "unavailable",
            "storageUnavailable" => "storageUnavailable",
            "storageUnknown" => "storageUnknown",
            "busy" => "busy",
            "changed" => "changed",
            "missing" => "missing",
            "unsafePath" => "unsafePath",
            "unsupportedGit" | "environmentOverride" => "unsupportedGit",
            "inspectionExpired" => "inspectionExpired",
            "capacity" => "capacity",
            _ => "unavailable",
        },
    }
}
async fn observe<T: Send + 'static>(
    f: impl FnOnce() -> worktrees::Result<T> + Send + 'static,
) -> worktrees::Result<T> {
    // Inner typed errors remain distinct from the observer's outer wait/busy
    // errors. Its permit and the manager permit live in the real blocking work.
    crate::file_read_check::run(move || Ok(f().map_err(fixed_failure)))
        .await
        .map_err(|message| worktrees::Failure {
            code: match crate::file_read_check::classify_error(&message) {
                crate::file_read_check::FailureKind::Pending => "readPending",
                crate::file_read_check::FailureKind::Busy => "readBusy",
                crate::file_read_check::FailureKind::Unavailable => "unavailable",
            },
        })?
}
#[tauri::command]
pub async fn worktree_preparation_inspect(
    app: AppHandle,
    webview: Webview,
    location_id: String,
    expected_revision: u64,
    project_relative_path: String,
) -> worktrees::Result<worktrees::PreparationInspection> {
    let (m, s) = context(&app, &webview, "worktree_preparation_inspect")?;
    observe(move || {
        m.preparation_inspect(&s, &location_id, expected_revision, &project_relative_path)
    })
    .await
}
#[tauri::command]
pub async fn worktree_preparation_validate(
    app: AppHandle,
    webview: Webview,
    inspection_id: String,
) -> worktrees::Result<worktrees::PreparationValidation> {
    let (m, s) = context(&app, &webview, "worktree_preparation_validate")?;
    observe(move || m.preparation_validate(&s, &inspection_id)).await
}
#[cfg(test)]
#[path = "worktree_preparation_command_tests.rs"]
mod tests;
