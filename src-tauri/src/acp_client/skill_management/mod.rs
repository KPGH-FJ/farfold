//! Explicit, reviewed single-skill preferences through a fixed official interface.
mod domain;
pub mod mcp;
pub mod mcp_add;
mod mcp_add_input;
mod mcp_add_plan;
mod mcp_http_url;
mod mcp_plan;
pub mod mcp_remove;
mod mcp_remove_plan;
mod plan;
mod requests;
mod rpc;
mod types;
use crate::{acp_client::extension_inventory as inventory, meta_store::MetaStore};
use requests::Job;
use std::{sync::Arc, time::Duration};
use tauri::{AppHandle, Manager, Webview};
pub use types::*;

fn query(store: &MetaStore, job: &Job) -> Result<()> {
    if job.source.domain() == domain::Domain::McpRemove {
        return mcp_remove::query(store, job);
    }
    if job.source.domain() == domain::Domain::McpAdd {
        return mcp_add::query(store, job);
    }
    if job.source.kind() == inventory::Kind::Mcp {
        return mcp::query(store, job);
    }
    job.within()?;
    job.source
        .current(store, job.snapshot().action == Action::Inspect)?;
    inventory::launch::admission(job.source.row())?;
    let env = crate::shell_env::cached_command_env().ok_or(Code::EnvironmentUnavailable)?;
    let command = inventory::launch::command(
        job.source.row(),
        job.source.cwd(),
        env,
        inventory::Kind::Skills,
    )?;
    run_selected(store, job, command)
}
fn run_selected(store: &MetaStore, job: &Job, command: std::process::Command) -> Result<()> {
    job.within()?;
    job.source
        .current(store, job.snapshot().action == Action::Inspect)?;
    job.phase(Phase::Starting);
    let mut exchange = rpc::Exchange::new(job, store)?;
    let mut out = inventory::process::run_owned(command, job, Some(&mut exchange), 4194304)?;
    let result = exchange.finish(&out);
    out.fill(0);
    result?;
    job.source
        .current(store, job.snapshot().action == Action::Inspect)?;
    Ok(())
}
async fn execute(
    store: MetaStore,
    job: Arc<Job>,
    activity: crate::managed_update::ActivityPermit,
    scope: crate::acp_client::manager::AccountScope,
) {
    execute_with(store, job, activity, scope, query).await;
}
async fn execute_with(
    store: MetaStore,
    job: Arc<Job>,
    activity: crate::managed_update::ActivityPermit,
    scope: crate::acp_client::manager::AccountScope,
    run: impl FnOnce(&MetaStore, &Job) -> Result<()> + Send + 'static,
) {
    let execution = match inventory::execution::acquire() {
        Ok(v) => v,
        Err(e) => {
            job.finish(Some(e));
            return;
        }
    };
    let configuration = tokio::select! {
        guard=crate::install_job::configuration_guard(&job.source.row().id)=>guard,
        _=job.operation.cancelled()=>{job.finish(Some(Code::Cancelled.into()));return;},
        _=tokio::time::sleep_until(tokio::time::Instant::from_std(job.deadline))=>{job.finish(Some(Code::TimedOut.into()));return;}
    };
    let observer = job.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        // All admission guards are held until run_owned has ended child/group/pipes.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&store, &job)))
            .unwrap_or_else(|_| Err(Code::Unavailable.into()));
        drop(scope);
        drop(configuration);
        drop(activity);
        drop(execution);
        let result = result.and_then(|_| {
            if job.snapshot().action == Action::Inspect {
                let plan = job
                    .plan
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone()
                    .ok_or(Code::InvalidOutput)?;
                requests::shared().publish_review(&job, plan)?;
            }
            Ok(())
        });
        job.finish(result.err());
    })
    .await;
    if result.is_err() {
        observer.finish(Some(Code::Unavailable.into()));
    }
}
struct Observer(Arc<Job>, bool);
impl Drop for Observer {
    fn drop(&mut self) {
        if self.1 {
            self.0.operation.abandon();
        }
    }
}
async fn wait(job: Arc<Job>) -> Result<ChangeOperation> {
    let mut changes = job.changed.subscribe();
    let mut observer = Observer(job.clone(), true);
    loop {
        let value = changes.borrow().clone();
        if value.settled || value.state == State::PendingCleanup {
            observer.1 = false;
            return Ok(value);
        }
        tokio::select! {
            changed=changes.changed()=>{if changed.is_err(){return Err(Code::Unavailable.into());}},
            _=tokio::time::sleep_until(tokio::time::Instant::from_std(job.deadline+Duration::from_secs(7)))=>{
                job.operation.abandon();
                use inventory::process::Control;
                job.pending_cleanup();observer.1=false;return Ok(job.snapshot());
            }
        }
    }
}
async fn dispatch(
    app: &AppHandle,
    store: MetaStore,
    pair: (Arc<Job>, bool),
) -> Result<ChangeOperation> {
    let (job, fresh) = pair;
    if fresh {
        let admission = (|| {
            let activity = crate::managed_update::activity().map_err(|_| Code::Busy)?;
            let manager = app
                .try_state::<crate::acp_client::manager::AcpManager>()
                .ok_or(Code::Unavailable)?;
            let scope =
                inventory::skills_scope(&manager, job.source.row())?.ok_or(Code::Unavailable)?;
            Ok((activity, scope))
        })();
        match admission {
            Ok((activity, scope)) => {
                tauri::async_runtime::spawn(execute(store, job.clone(), activity, scope));
            }
            Err(error) => job.finish(Some(error)),
        }
    }
    wait(job).await
}
#[tauri::command]
pub async fn agent_skill_change_inspect(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    request_id: String,
    inventory_request_id: String,
    item_id: usize,
    enabled: bool,
) -> Result<ChangeOperation> {
    let store = inventory::context(&app, &webview, "agent_skill_change_inspect")?;
    let pair = requests::shared().begin_inspect(
        &agent_id,
        &request_id,
        &inventory_request_id,
        item_id,
        enabled,
    )?;
    dispatch(&app, store, pair).await
}
#[tauri::command]
pub async fn agent_skill_change_confirm(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    request_id: String,
    review_id: String,
) -> Result<ChangeOperation> {
    let store = inventory::context(&app, &webview, "agent_skill_change_confirm")?;
    let pair = requests::shared().begin_confirm(&agent_id, &request_id, &review_id)?;
    dispatch(&app, store, pair).await
}
#[tauri::command]
pub async fn agent_skill_change_recheck(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    request_id: String,
    operation_id: String,
) -> Result<ChangeOperation> {
    let store = inventory::context(&app, &webview, "agent_skill_change_recheck")?;
    let pair = requests::shared().begin_recheck(&agent_id, &request_id, &operation_id)?;
    dispatch(&app, store, pair).await
}
#[tauri::command]
pub fn agent_skill_change_status(
    webview: Webview,
    agent_id: String,
    request_id: String,
) -> Result<ChangeOperation> {
    inventory::allowed(&webview)?;
    Ok(requests::shared().get(&agent_id, &request_id)?.snapshot())
}
#[tauri::command]
pub fn agent_skill_change_cancel(
    webview: Webview,
    agent_id: String,
    request_id: String,
) -> Result<Cancellation> {
    inventory::allowed(&webview)?;
    requests::shared().cancel(&agent_id, &request_id)
}
#[cfg(test)]
mod independent_tests;
#[cfg(test)]
mod tests;

#[cfg(test)]
mod mcp_independent_tests;

#[cfg(test)]
mod mcp_tests;

#[cfg(test)]
mod mcp_add_tests;

#[cfg(test)]
mod mcp_add_independent_tests;

#[cfg(test)]
mod mcp_remove_tests;

#[cfg(test)]
mod mcp_remove_independent_tests;

#[cfg(test)]
mod mcp_http_independent_tests;
#[cfg(test)]
mod mcp_http_lifecycle_tests;
#[cfg(test)]
mod mcp_http_tests;
