//! Fixed public CLI commands. No shell, Agent request, or private RPC forwarding.
use super::{
    catalog::{self, Entry},
    requests::Job,
    sources::{self, Marketplace},
    types::*,
};
use crate::acp_client::extension_inventory::{self as inventory, process};
use serde::Deserialize;
use std::{path::Path, process::Command, sync::atomic::Ordering};

fn command(
    job: &Job,
    action: &str,
    marketplace: Option<&str>,
    selector: Option<&str>,
) -> Result<Command> {
    inventory::launch::admission(&job.source.row)?;
    let mut command = Command::new(&job.source.row.command);
    command.args(&job.source.row.args).args(["cli", "plugin"]);
    if action == "sources" {
        command.args(["marketplace", "list", "--json"]);
    } else if action == "list" {
        let marketplace = marketplace.ok_or(Code::InvalidRequest)?;
        command.arg("list");
        command.args(["--available", "--json"]);
        command.arg(format!("--marketplace={marketplace}"));
    } else if matches!(action, "add" | "remove") {
        command
            .arg(action)
            .args(["--json", "--"])
            .arg(selector.ok_or(Code::InvalidRequest)?);
    } else {
        return Err(Code::InvalidRequest.into());
    }
    command
        .current_dir(&job.source.cwd)
        .envs(&job.source.environment)
        .envs(job.source.row.env.iter().cloned());
    Ok(command)
}
pub(super) fn sources(job: &Job) -> Result<Vec<Marketplace>> {
    job.within()?;
    job.update(|v| v.phase = Phase::Reading);
    let mut bytes = process::run_owned(
        command(job, "sources", None, None)?,
        job,
        None,
        inventory::output::STDOUT_LIMIT,
    )?;
    let result = sources::parse(&bytes);
    bytes.fill(0);
    job.within()?;
    result
}
pub(super) fn read(job: &Job, marketplace: &str) -> Result<Vec<Entry>> {
    job.within()?;
    job.update(|v| v.phase = Phase::Reading);
    let mut bytes = process::run_owned(
        command(job, "list", Some(marketplace), None)?,
        job,
        None,
        inventory::output::STDOUT_LIMIT,
    )?;
    let result = catalog::parse(&bytes);
    bytes.fill(0);
    let entries = result?;
    if entries.iter().any(|v| v.marketplace_name != marketplace) {
        return Err(Code::InvalidOutput.into());
    }
    job.within()?;
    Ok(entries)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddOutput {
    plugin_id: String,
    name: String,
    marketplace_name: String,
    version: String,
    installed_path: String,
    auth_policy: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveOutput {
    plugin_id: String,
    name: String,
    marketplace_name: String,
}
pub(super) fn write(job: &Job, entry: &Entry, install: bool) -> Result<()> {
    job.within()?;
    let selector = entry.selector()?;
    let command = command(
        job,
        if install { "add" } else { "remove" },
        None,
        Some(&selector),
    )?;
    job.update(|v| v.phase = Phase::Writing);
    job.effectful.store(true, Ordering::SeqCst);
    let result = process::run_owned(command, job, None, inventory::output::STDOUT_LIMIT);
    job.effectful.store(false, Ordering::SeqCst);
    let mut bytes = result?;
    let result = (|| {
        if !inventory::output::bounded_depth(&bytes) {
            return Err(Code::InvalidOutput.into());
        }
        if install {
            let out: AddOutput = serde_json::from_slice(&bytes).map_err(|_| Code::InvalidOutput)?;
            if out.plugin_id != entry.plugin_id
                || out.name != entry.name
                || out.marketplace_name != entry.marketplace_name
                || out.auth_policy != entry.auth_policy
                || out.version.is_empty()
                || out.version.len() > 256
                || out.version.chars().any(char::is_control)
                || out.installed_path.len() > 4096
                || !Path::new(&out.installed_path).is_absolute()
                || out.installed_path.chars().any(char::is_control)
            {
                return Err(Code::InvalidOutput.into());
            }
            *job.plan
                .as_ref()
                .ok_or(Code::InvalidRequest)?
                .acknowledged_version
                .lock()
                .unwrap_or_else(|p| p.into_inner()) = Some(out.version);
        } else {
            let out: RemoveOutput =
                serde_json::from_slice(&bytes).map_err(|_| Code::InvalidOutput)?;
            if out.plugin_id != entry.plugin_id
                || out.name != entry.name
                || out.marketplace_name != entry.marketplace_name
            {
                return Err(Code::InvalidOutput.into());
            }
        }
        job.update(|v| v.write_ack = Ack::Ok);
        Ok(())
    })();
    bytes.fill(0);
    result
}
#[cfg(all(test, target_os = "macos"))]
pub(super) fn arguments(
    job: &Job,
    action: &str,
    marketplace: Option<&str>,
    selector: Option<&str>,
) -> Result<Vec<String>> {
    Ok(command(job, action, marketplace, selector)?
        .get_args()
        .map(|v| v.to_string_lossy().into_owned())
        .collect())
}
