//! Explicit one-shot official CLI inventory; no ACP session or configuration write.
pub(in crate::acp_client) mod execution;
pub(in crate::acp_client) mod launch;
pub(in crate::acp_client) mod mcp_targets;
pub(in crate::acp_client) mod output;
pub(in crate::acp_client) mod process;
pub(in crate::acp_client) mod requests;
pub(in crate::acp_client) mod skills_output;
mod skills_rpc;
pub(in crate::acp_client) mod targets;
mod types;
use crate::meta_store::MetaStore;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, Webview};
pub use types::*;

pub(in crate::acp_client) fn allowed(webview: &Webview) -> Result<()> {
    crate::browser_workspace::caller_allowed(webview)
        .then_some(())
        .ok_or_else(|| Code::Unavailable.into())
}
pub(in crate::acp_client) fn context(
    app: &AppHandle,
    webview: &Webview,
    command: &str,
) -> Result<MetaStore> {
    allowed(webview)?;
    if !app
        .try_state::<crate::storage_recovery::StorageRecoveryState>()
        .is_some_and(|state| state.allows(command))
    {
        return Err(Code::Unavailable.into());
    }
    app.try_state::<MetaStore>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| Code::Unavailable.into())
}
#[tauri::command]
pub async fn agent_extension_capabilities(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
) -> Result<ExtensionCapabilities> {
    let store = context(&app, &webview, "agent_extension_capabilities")?;
    if agent_id.is_empty() || agent_id.len() > 256 || agent_id.chars().any(char::is_control) {
        return Err(Code::InvalidRequest.into());
    }
    // Only public package metadata is read here; no shell, CLI, account or model.
    crate::file_read_check::run(move || {
        let row = store
            .get_agent(&agent_id)
            .map_err(|_| "unavailable".to_owned())?
            .ok_or_else(|| "unavailable".to_owned())?;
        Ok(launch::capabilities(&row))
    })
    .await
    .map_err(|_| Failure::from(Code::Unavailable))?
}

struct AbandonOnDrop {
    request: Arc<requests::Request>,
    armed: bool,
}
impl Drop for AbandonOnDrop {
    fn drop(&mut self) {
        if self.armed {
            self.request.operation.abandon();
        }
    }
}
async fn wait_for_result(request: Arc<requests::Request>) -> Result<InventoryOperation> {
    let mut changed = request.changed.subscribe();
    let mut guard = AbandonOnDrop {
        request: request.clone(),
        armed: true,
    };
    let deadline = tokio::time::Instant::from_std(request.deadline);
    loop {
        if let Some(snapshot) = changed.borrow().clone()
            && (snapshot.settled || snapshot.state == State::PendingCleanup)
        {
            guard.armed = false;
            return Ok(snapshot);
        }
        tokio::select! {
            _ = tokio::time::sleep_until(deadline + Duration::from_secs(7)) => {
                request.operation.abandon();
                request.progress(State::PendingCleanup, Some(Code::PendingCleanup));
                guard.armed = false;
                return request.snapshot().ok_or_else(|| Code::UnknownRequest.into());
            }
            result = changed.changed() => {
                if result.is_err() { return Err(Code::Unavailable.into()); }
            }
        }
    }
}
fn within(request: &requests::Request) -> Result<()> {
    if Instant::now() >= request.deadline {
        return Err(Code::TimedOut.into());
    }
    if !request.operation.interested() {
        return Err(Code::Cancelled.into());
    }
    Ok(())
}
fn query(
    store: &MetaStore,
    request: &requests::Request,
    row: &crate::meta_store::AgentRow,
) -> Result<InventorySnapshot> {
    within(request)?;
    let current = store
        .get_agent(&request.agent)
        .map_err(|_| Code::Unavailable)?;
    if !current
        .as_ref()
        .is_some_and(|next| launch::same_selection(row, next))
    {
        return Err(Code::SelectionChanged.into());
    }
    launch::admission(row)?;
    within(request)?;
    let cwd = request.cwd.as_deref().ok_or(Code::InvalidRequest)?;
    let directory = Arc::new(launch::Directory::open(cwd)?);
    within(request)?;
    // Do not create a second environment-probe lifecycle inside this query.
    let environment = crate::shell_env::cached_command_env().ok_or(Code::EnvironmentUnavailable)?;
    let kind = request.kind.ok_or(Code::InvalidRequest)?;
    let command = launch::command(row, cwd, environment, kind)?;
    within(request)?;
    let current = store
        .get_agent(&request.agent)
        .map_err(|_| Code::Unavailable)?;
    if !current
        .as_ref()
        .is_some_and(|next| launch::same_selection(row, next))
        || !directory.current()
    {
        return Err(Code::SelectionChanged.into());
    }
    let snapshot = match kind {
        Kind::Mcp => {
            let mut bytes = process::run(command, request)?;
            let result = output::parse_private(&bytes)
                .and_then(|(snapshot, entries)| Ok((snapshot, entries, output::names(&bytes)?)));
            bytes.fill(0);
            let (snapshot, entries, names) = result?;
            *request
                .mcp_targets
                .lock()
                .unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(mcp_targets::TargetSet {
                row: row.clone(),
                directory: directory.clone(),
                entries,
                names,
            }));
            InventorySnapshot::Mcp(snapshot)
        }
        Kind::Skills => {
            let (snapshot, entries) = process::run_skills_private(command, request)?;
            *request.targets.lock().unwrap_or_else(|p| p.into_inner()) =
                Some(Arc::new(targets::TargetSet {
                    row: row.clone(),
                    directory: directory.clone(),
                    entries,
                }));
            InventorySnapshot::Skills(snapshot)
        }
    };
    within(request)?;
    let current = store
        .get_agent(&request.agent)
        .map_err(|_| Code::Unavailable)?;
    if !current
        .as_ref()
        .is_some_and(|next| launch::same_selection(row, next))
        || !directory.current()
    {
        return Err(Code::SelectionChanged.into());
    }
    Ok(snapshot)
}
async fn execute_selected(
    store: MetaStore,
    request: Arc<requests::Request>,
    activity: crate::managed_update::ActivityPermit,
    row: crate::meta_store::AgentRow,
    scope: Option<super::manager::AccountScope>,
) {
    let configuration = tokio::select! {
        guard = crate::install_job::configuration_guard(&request.agent) => guard,
        _ = request.operation.cancelled() => { request.finish(Err(Code::Cancelled.into())); return; },
        _ = tokio::time::sleep_until(tokio::time::Instant::from_std(request.deadline)) => {
            request.finish(Err(Code::TimedOut.into())); return;
        }
    };
    let execution = match execution::acquire() {
        Ok(value) => value,
        Err(error) => {
            request.finish(Err(error));
            return;
        }
    };
    let observer = request.clone();
    // The detached task/real blocking closure owns all permits, not IPC delivery.
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _execution = execution;
        let activity = activity;
        let scope = scope;
        let configuration = configuration;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            query(&store, &request, &row)
        }))
        .unwrap_or_else(|_| Err(Code::Unavailable.into()));
        // process::ChildOwner has finished group/pipe cleanup before query returns.
        drop(scope);
        drop(configuration);
        drop(activity);
        request.finish(result);
    })
    .await;
    if result.is_err() {
        observer.finish(Err(Code::Unavailable.into()));
    }
}
#[tauri::command]
pub async fn agent_extension_inventory_read(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    cwd: String,
    request_id: String,
    selection_id: String,
    kind: Kind,
) -> Result<InventoryOperation> {
    let store = context(&app, &webview, "agent_extension_inventory_read")?;
    let activity = crate::managed_update::activity().map_err(|_| Code::Busy)?;
    let (request, fresh) =
        requests::shared().begin(&agent_id, &cwd, &request_id, &selection_id, kind)?;
    if fresh {
        match launch::selections().get(&agent_id, &selection_id, Instant::now()) {
            Ok(selected) => {
                let scope = if kind == Kind::Skills {
                    app.try_state::<super::manager::AcpManager>()
                        .ok_or_else(|| Failure::from(Code::Unavailable))
                        .and_then(|manager| skills_scope(&manager, &selected))
                } else {
                    Ok(None)
                };
                let scope = match scope {
                    Ok(scope) => scope,
                    Err(error) => {
                        request.finish(Err(error));
                        return wait_for_result(request).await;
                    }
                };
                tauri::async_runtime::spawn(execute_selected(
                    store,
                    request.clone(),
                    activity,
                    selected,
                    scope,
                ));
            }
            Err(error) => {
                drop(activity);
                request.finish(Err(error));
            }
        }
    } else {
        drop(activity);
    }
    wait_for_result(request).await
}
#[tauri::command]
pub fn agent_extension_inventory_status(
    webview: Webview,
    agent_id: String,
    request_id: String,
) -> Result<InventoryOperation> {
    allowed(&webview)?;
    requests::shared()
        .get(&agent_id, &request_id)?
        .snapshot()
        .ok_or_else(|| Code::UnknownRequest.into())
}
#[tauri::command]
pub fn agent_extension_inventory_cancel(
    webview: Webview,
    agent_id: String,
    request_id: String,
) -> Result<Cancellation> {
    // Stop/query remain independent of store readiness and editable state.
    allowed(&webview)?;
    requests::shared().cancel(&agent_id, &request_id)
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod skills_tests;

pub(in crate::acp_client) fn skills_scope(
    manager: &super::manager::AcpManager,
    row: &crate::meta_store::AgentRow,
) -> Result<Option<super::manager::AccountScope>> {
    if manager
        .shutting_down
        .load(std::sync::atomic::Ordering::SeqCst)
        || manager.candidate_pending(&row.id).map_err(|_| Code::Busy)?
    {
        return Err(Code::Busy.into());
    }
    manager
        .reserve_preparation_action(row, &row.command, &row.args)
        .map(Some)
        .map_err(|_| Code::Busy.into())
}

#[cfg(test)]
mod skills_lifecycle_tests;
