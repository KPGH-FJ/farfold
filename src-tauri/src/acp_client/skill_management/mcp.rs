//! MCP preference commands share the skill review registry and actual worker lease.
use super::{
    requests::{self, Job},
    types::*,
};
use crate::{acp_client::extension_inventory as inventory, meta_store::MetaStore};
use inventory::Kind;
use tauri::{AppHandle, Webview};
#[derive(Clone, Copy)]
pub(super) enum Stage {
    Get,
    AppServer,
}
fn get_with(
    store: &MetaStore,
    job: &Job,
    command: std::process::Command,
) -> Result<inventory::mcp_targets::Report> {
    job.within()?;
    job.source
        .current(store, job.snapshot().action == Action::Inspect)?;
    let target = job.source.mcp()?;
    let mut bytes =
        inventory::process::run_owned(command, job, None, inventory::output::STDOUT_LIMIT)?;
    let result = inventory::mcp_targets::report(&bytes, target);
    bytes.fill(0);
    job.within()?;
    job.source
        .current(store, job.snapshot().action == Action::Inspect)?;
    result
}
pub(super) fn query(store: &MetaStore, job: &Job) -> Result<()> {
    inventory::launch::admission(job.source.row())?;
    let environment = crate::shell_env::cached_command_env().ok_or(Code::EnvironmentUnavailable)?;
    run_with(store, job, |stage| match stage {
        Stage::Get => inventory::launch::mcp_get_command(
            job.source.row(),
            job.source.cwd(),
            environment.clone(),
            &job.source.mcp()?.name,
        ),
        Stage::AppServer => inventory::launch::command(
            job.source.row(),
            job.source.cwd(),
            environment.clone(),
            Kind::Skills,
        ),
    })
}
// The production flow uses the fixed launch closure above. Tests supply only
// synthetic peer Commands here; no IPC accepts a program, method or arguments.
pub(super) fn run_with(
    store: &MetaStore,
    job: &Job,
    mut command: impl FnMut(Stage) -> Result<std::process::Command>,
) -> Result<()> {
    *job.mcp_report.lock().unwrap_or_else(|p| p.into_inner()) =
        Some(get_with(store, job, command(Stage::Get)?)?);
    super::run_selected(store, job, command(Stage::AppServer)?)?;
    if job.snapshot().action == Action::SetEnabled && job.snapshot().write_ack != Ack::Rejected {
        // The second official get is part of the original action/deadline.
        let report = get_with(store, job, command(Stage::Get)?)?;
        let (after, directory) = job
            .mcp_readback
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
            .ok_or(Code::InvalidOutput)?;
        super::rpc::observe_mcp(job, &after, &directory, &report, true)?;
    }
    Ok(())
}
#[tauri::command]
pub async fn agent_mcp_change_inspect(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    request_id: String,
    inventory_request_id: String,
    item_id: usize,
    enabled: bool,
) -> Result<ChangeOperation> {
    let store = inventory::context(&app, &webview, "agent_mcp_change_inspect")?;
    let pair = requests::shared().begin_inspect_kind(
        &agent_id,
        &request_id,
        &inventory_request_id,
        item_id,
        enabled,
        Kind::Mcp,
    )?;
    super::dispatch(&app, store, pair).await
}
#[tauri::command]
pub async fn agent_mcp_change_confirm(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    request_id: String,
    review_id: String,
) -> Result<ChangeOperation> {
    let store = inventory::context(&app, &webview, "agent_mcp_change_confirm")?;
    let pair =
        requests::shared().begin_confirm_kind(&agent_id, &request_id, &review_id, Kind::Mcp)?;
    super::dispatch(&app, store, pair).await
}
#[tauri::command]
pub async fn agent_mcp_change_recheck(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    request_id: String,
    operation_id: String,
) -> Result<ChangeOperation> {
    let store = inventory::context(&app, &webview, "agent_mcp_change_recheck")?;
    let pair =
        requests::shared().begin_recheck_kind(&agent_id, &request_id, &operation_id, Kind::Mcp)?;
    super::dispatch(&app, store, pair).await
}
#[tauri::command]
pub fn agent_mcp_change_status(
    webview: Webview,
    agent_id: String,
    request_id: String,
) -> Result<ChangeOperation> {
    inventory::allowed(&webview)?;
    Ok(requests::shared()
        .get_kind(&agent_id, &request_id, Kind::Mcp)?
        .snapshot())
}
#[tauri::command]
pub fn agent_mcp_change_cancel(
    webview: Webview,
    agent_id: String,
    request_id: String,
) -> Result<Cancellation> {
    inventory::allowed(&webview)?;
    requests::shared().cancel_kind(&agent_id, &request_id, Kind::Mcp)
}
