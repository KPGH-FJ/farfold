//! Fixed list → config/read/write → get. The newly saved executable is never launched.
use super::{
    domain::Domain,
    mcp_add_input::Input,
    requests::{self, Job},
    types::*,
};
use crate::{acp_client::extension_inventory as inventory, meta_store::MetaStore};
use tauri::{AppHandle, Webview};
#[derive(Clone, Copy)]
pub(super) enum Stage {
    List,
    AppServer,
    Get,
}
fn current(store: &MetaStore, job: &Job) -> Result<()> {
    job.within()?;
    job.source
        .current(store, job.snapshot().action != Action::Recheck)
}
fn list(
    store: &MetaStore,
    job: &Job,
    command: std::process::Command,
) -> Result<std::collections::HashSet<String>> {
    current(store, job)?;
    let mut bytes =
        inventory::process::run_owned(command, job, None, inventory::output::STDOUT_LIMIT)?;
    let result = inventory::output::names(&bytes);
    bytes.fill(0);
    current(store, job)?;
    result
}
pub(super) fn query(store: &MetaStore, job: &Job) -> Result<()> {
    current(store, job)?;
    inventory::launch::admission(job.source.row())?;
    let env = crate::shell_env::cached_command_env().ok_or(Code::EnvironmentUnavailable)?;
    run_with(store, job, |stage| match stage {
        Stage::List => inventory::launch::command(
            job.source.row(),
            job.source.cwd(),
            env.clone(),
            inventory::Kind::Mcp,
        ),
        Stage::AppServer => inventory::launch::command(
            job.source.row(),
            job.source.cwd(),
            env.clone(),
            inventory::Kind::Skills,
        ),
        Stage::Get => inventory::launch::mcp_get_command(
            job.source.row(),
            job.source.cwd(),
            env.clone(),
            &job.source.addition()?.input.name,
        ),
    })
}
pub(super) fn run_with(
    store: &MetaStore,
    job: &Job,
    mut command: impl FnMut(Stage) -> Result<std::process::Command>,
) -> Result<()> {
    current(store, job)?;
    let source = job.source.addition()?;
    let action = job.snapshot().action;
    if action != Action::Recheck
        && (source.catalogue.set.names.contains(&source.input.name)
            || list(store, job, command(Stage::List)?)?.contains(&source.input.name))
    {
        return Err(Code::NameConflict.into());
    }
    super::run_selected(store, job, command(Stage::AppServer)?)?;
    if action == Action::Inspect
        || (action == Action::Add && job.snapshot().write_ack == Ack::Rejected)
    {
        return Ok(());
    }
    current(store, job)?;
    let get = (|| {
        let mut bytes = inventory::process::run_owned(
            command(Stage::Get)?,
            job,
            None,
            inventory::output::STDOUT_LIMIT,
        )?;
        let result = super::mcp_add_plan::parse_report(&bytes, &source.input.name);
        bytes.fill(0);
        result
    })();
    let report = match get {
        Ok(v) => Some(v),
        Err(error)
            if action == Action::Recheck
                && matches!(error.code, Code::QueryFailed | Code::InvalidOutput) =>
        {
            // A failed get is never absence proof: only a complete official list is.
            if list(store, job, command(Stage::List)?)?.contains(&source.input.name) {
                return Err(error);
            }
            None
        }
        Err(error) => return Err(error),
    };
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
    let (observation, matching) =
        owned
            .addition()?
            .observation(&after, &directory, report.as_ref())?;
    job.update(|v| v.observation = Some(observation));
    job.observed_outcome(if matching {
        if action == Action::Add {
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
pub async fn agent_mcp_add_inspect(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    request_id: String,
    inventory_request_id: String,
    input_id: String,
    input: Input,
) -> Result<ChangeOperation> {
    let store = inventory::context(&app, &webview, "agent_mcp_add_inspect")?;
    let pair = requests::shared().begin_add_inspect(
        &agent_id,
        &request_id,
        &inventory_request_id,
        &input_id,
        input,
    )?;
    super::dispatch(&app, store, pair).await
}
#[tauri::command]
pub async fn agent_mcp_add_confirm(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    request_id: String,
    review_id: String,
) -> Result<ChangeOperation> {
    let store = inventory::context(&app, &webview, "agent_mcp_add_confirm")?;
    let pair = requests::shared().begin_confirm_domain(
        &agent_id,
        &request_id,
        &review_id,
        Domain::McpAdd,
    )?;
    super::dispatch(&app, store, pair).await
}
#[tauri::command]
pub async fn agent_mcp_add_recheck(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    request_id: String,
    operation_id: String,
) -> Result<ChangeOperation> {
    let store = inventory::context(&app, &webview, "agent_mcp_add_recheck")?;
    let pair = requests::shared().begin_recheck_domain(
        &agent_id,
        &request_id,
        &operation_id,
        Domain::McpAdd,
    )?;
    super::dispatch(&app, store, pair).await
}
#[tauri::command]
pub fn agent_mcp_add_status(
    webview: Webview,
    agent_id: String,
    request_id: String,
) -> Result<ChangeOperation> {
    inventory::allowed(&webview)?;
    Ok(requests::shared()
        .get_domain(&agent_id, &request_id, Domain::McpAdd)?
        .snapshot())
}
#[tauri::command]
pub fn agent_mcp_add_cancel(
    webview: Webview,
    agent_id: String,
    request_id: String,
) -> Result<Cancellation> {
    inventory::allowed(&webview)?;
    requests::shared().cancel_domain(&agent_id, &request_id, Domain::McpAdd)
}
