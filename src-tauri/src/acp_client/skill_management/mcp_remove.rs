//! Remove only a reviewed disabled leaf; successful full list is absence proof.
use super::{
    domain::Domain,
    requests::{self, Job},
    types::*,
};
use crate::{acp_client::extension_inventory as inventory, meta_store::MetaStore};
use tauri::{AppHandle, Webview};
#[derive(Clone, Copy)]
pub(super) enum Stage {
    Get,
    AppServer,
    List,
}
fn current(store: &MetaStore, job: &Job) -> Result<()> {
    job.within()?;
    job.source
        .current(store, job.snapshot().action != Action::Recheck)
}
pub(super) fn query(store: &MetaStore, job: &Job) -> Result<()> {
    current(store, job)?;
    inventory::launch::admission(job.source.row())?;
    let env = crate::shell_env::cached_command_env().ok_or(Code::EnvironmentUnavailable)?;
    run_with(store, job, |stage| match stage {
        Stage::Get => inventory::launch::mcp_get_command(
            job.source.row(),
            job.source.cwd(),
            env.clone(),
            &job.source.mcp()?.name,
        ),
        Stage::AppServer => inventory::launch::command(
            job.source.row(),
            job.source.cwd(),
            env.clone(),
            inventory::Kind::Skills,
        ),
        Stage::List => inventory::launch::command(
            job.source.row(),
            job.source.cwd(),
            env.clone(),
            inventory::Kind::Mcp,
        ),
    })
}
pub(super) fn run_with(
    store: &MetaStore,
    job: &Job,
    mut command: impl FnMut(Stage) -> Result<std::process::Command>,
) -> Result<()> {
    current(store, job)?;
    let action = job.snapshot().action;
    if action != Action::Recheck {
        let mut bytes = inventory::process::run_owned(
            command(Stage::Get)?,
            job,
            None,
            inventory::output::STDOUT_LIMIT,
        )?;
        let report = inventory::mcp_targets::report(&bytes, job.source.mcp()?);
        bytes.fill(0);
        *job.mcp_report.lock().unwrap_or_else(|p| p.into_inner()) = Some(report?);
        current(store, job)?;
    }
    super::run_selected(store, job, command(Stage::AppServer)?)?;
    if action == Action::Inspect
        || (action == Action::Remove && job.snapshot().write_ack == Ack::Rejected)
    {
        return Ok(());
    }
    current(store, job)?;
    let mut bytes = inventory::process::run_owned(
        command(Stage::List)?,
        job,
        None,
        inventory::output::STDOUT_LIMIT,
    )?;
    let presence = inventory::output::presence(&bytes, &job.source.mcp()?.name);
    bytes.fill(0);
    let presence = presence?;
    current(store, job)?;
    let (after, directory) = job
        .mcp_readback
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
        .ok_or(Code::InvalidOutput)?;
    let owned = job
        .plan
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
        .ok_or(Code::InvalidOutput)?;
    let (observation, matching) = owned.removal()?.observation(&after, &directory, presence);
    // Never expose observed/verified data before the actual owner finishes.
    job.observed(observation);
    job.observed_outcome(if matching {
        if action == Action::Remove {
            Outcome::Verified
        } else {
            Outcome::Observed
        }
    } else {
        Outcome::Mismatch
    });
    Ok(())
}
#[tauri::command]
pub async fn agent_mcp_remove_inspect(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    request_id: String,
    inventory_request_id: String,
    item_id: usize,
) -> Result<ChangeOperation> {
    let store = inventory::context(&app, &webview, "agent_mcp_remove_inspect")?;
    let pair = requests::shared().begin_remove_inspect(
        &agent_id,
        &request_id,
        &inventory_request_id,
        item_id,
    )?;
    super::dispatch(&app, store, pair).await
}
#[tauri::command]
pub async fn agent_mcp_remove_confirm(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    request_id: String,
    review_id: String,
) -> Result<ChangeOperation> {
    let store = inventory::context(&app, &webview, "agent_mcp_remove_confirm")?;
    let pair = requests::shared().begin_confirm_domain(
        &agent_id,
        &request_id,
        &review_id,
        Domain::McpRemove,
    )?;
    super::dispatch(&app, store, pair).await
}
#[tauri::command]
pub async fn agent_mcp_remove_recheck(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    request_id: String,
    operation_id: String,
) -> Result<ChangeOperation> {
    let store = inventory::context(&app, &webview, "agent_mcp_remove_recheck")?;
    let pair = requests::shared().begin_recheck_domain(
        &agent_id,
        &request_id,
        &operation_id,
        Domain::McpRemove,
    )?;
    super::dispatch(&app, store, pair).await
}
#[tauri::command]
pub fn agent_mcp_remove_status(
    webview: Webview,
    agent_id: String,
    request_id: String,
) -> Result<ChangeOperation> {
    inventory::allowed(&webview)?;
    Ok(requests::shared()
        .get_domain(&agent_id, &request_id, Domain::McpRemove)?
        .snapshot())
}
#[tauri::command]
pub fn agent_mcp_remove_cancel(
    webview: Webview,
    agent_id: String,
    request_id: String,
) -> Result<Cancellation> {
    inventory::allowed(&webview)?;
    requests::shared().cancel_domain(&agent_id, &request_id, Domain::McpRemove)
}
