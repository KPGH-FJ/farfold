//! Explicit, finite management of packages already reported by the official CLI.
mod catalog;
mod cli;
mod requests;
mod types;
use crate::{acp_client::extension_inventory as inventory, meta_store::MetaStore};
use requests::{Input, Job, Plan};
use std::{
    sync::{Arc, Mutex, atomic::AtomicBool},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, Webview};
pub use types::*;

fn query(store: &MetaStore, job: &Job) -> Result<()> {
    job.within()?;
    job.source.current(store)?;
    match &job.input {
        Input::Inventory { .. } => {
            let entries = cli::read(job, None)?;
            job.source.current(store)?;
            job.within()?;
            let public = catalog::public(&entries);
            *job.entries.lock().unwrap_or_else(|p| p.into_inner()) = Some(entries);
            job.update(|v| v.catalog = Some(public));
        }
        Input::Inspect { install, .. } => {
            let entry = job.entry.as_ref().ok_or(Code::TargetUnavailable)?;
            let entries = cli::read(job, Some(&entry.marketplace_name))?;
            let current = catalog::exact(&entries, entry)?;
            if current != entry {
                return Err(Code::TargetChanged.into());
            }
            current.admitted(*install)?;
            job.source.current(store)?;
            job.within()?;
            let public = PluginReview {
                review_id: requests::review_id()?,
                agent_id: job.source.row.id.clone(),
                cwd: job.source.cwd.clone(),
                target: job.snapshot().target.ok_or(Code::TargetUnavailable)?,
                install: *install,
                observed_at_ms: now_ms(),
                valid_for_ms: 300_000,
                scope: SCOPE,
                session_applicability: "unverified",
            };
            *job.review.lock().unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(Plan {
                public: public.clone(),
                entry: entry.clone(),
                source: job.source.clone(),
                born: Instant::now(),
                consumed: AtomicBool::new(false),
                acknowledged_version: Mutex::new(None),
            }));
            job.update(|v| v.review = Some(public));
        }
        Input::Confirm { .. } => {
            let plan = job.plan.as_ref().ok_or(Code::ReviewExpired)?;
            if plan.born.elapsed() >= requests::TTL {
                return Err(Code::ReviewExpired.into());
            }
            let before = cli::read(job, Some(&plan.entry.marketplace_name))?;
            if catalog::exact(&before, &plan.entry)? != &plan.entry {
                return Err(Code::TargetChanged.into());
            }
            plan.entry.admitted(plan.public.install)?;
            job.source.current(store)?;
            job.within()?;
            cli::write(job, &plan.entry, plan.public.install)?;
            observe(store, job, false)?;
        }
        Input::Recheck { .. } => observe(store, job, true)?,
    }
    job.source.current(store)?;
    job.within()
}
fn observe(store: &MetaStore, job: &Job, recheck: bool) -> Result<()> {
    let plan = job.plan.as_ref().ok_or(Code::TargetUnavailable)?;
    job.source.current(store)?;
    let entries = cli::read(job, Some(&plan.entry.marketplace_name))?;
    let current = catalog::exact(&entries, &plan.entry)?;
    if !current.same_origin(&plan.entry) {
        return Err(Code::TargetChanged.into());
    }
    job.source.current(store)?;
    job.within()?;
    job.update(|v| {
        v.observation = Some(PluginObservation {
            observed_at_ms: now_ms(),
            reported_installed: current.installed,
            reported_enabled: current.enabled,
            session_applicability: "unverified",
        })
    });
    let version = plan
        .acknowledged_version
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    let version_known = if plan.public.install {
        version
            .as_ref()
            .is_none_or(|expected| current.version.as_ref() == Some(expected))
    } else {
        current.version == plan.entry.version
    };
    if !version_known {
        return Err(Code::WriteUncertain.into());
    }
    let matches = current.installed == plan.public.install;
    job.update(|v| {
        v.outcome = Some(if !matches {
            Outcome::Mismatch
        } else if recheck {
            Outcome::Observed
        } else {
            Outcome::Verified
        })
    });
    Ok(())
}
async fn execute(app: AppHandle, store: MetaStore, job: Arc<Job>) {
    let admission: Result<_> = (|| {
        let activity = crate::managed_update::activity().map_err(|_| Code::Busy)?;
        let manager = app
            .try_state::<crate::acp_client::manager::AcpManager>()
            .ok_or(Code::Unavailable)?;
        if manager
            .shutting_down
            .load(std::sync::atomic::Ordering::SeqCst)
            || manager
                .candidate_pending(&job.source.row.id)
                .map_err(|_| Code::Busy)?
        {
            return Err(Code::Busy.into());
        }
        let scope = manager
            .reserve_plugin_configuration(&job.source.row)
            .map_err(|_| Code::Busy)?;
        let execution = inventory::execution::acquire()?;
        Ok((activity, scope, execution))
    })();
    let (activity, scope, execution) = match admission {
        Ok(v) => v,
        Err(error) => {
            job.finish(Some(error));
            return;
        }
    };
    let configuration = tokio::select! {
        v=crate::install_job::configuration_guard(&job.source.row.id)=>v,
        _=job.operation.cancelled()=>{job.finish(Some(Code::Cancelled.into()));return;},
        _=tokio::time::sleep_until(tokio::time::Instant::from_std(job.deadline))=>{job.finish(Some(Code::TimedOut.into()));return;}
    };
    let observer = job.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| query(&store, &job)))
            .unwrap_or_else(|_| Err(Code::Unavailable.into()));
        // run_owned has reaped child/group and both pipes before any admission ends.
        drop(configuration);
        drop(execution);
        drop(scope);
        drop(activity);
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
async fn dispatch(
    app: AppHandle,
    store: MetaStore,
    pair: (Arc<Job>, bool),
) -> Result<PluginOperation> {
    let (job, fresh) = pair;
    if fresh {
        tauri::async_runtime::spawn(execute(app, store, job.clone()));
    }
    let mut changes = job.changed.subscribe();
    let mut observer = Observer(job.clone(), true);
    loop {
        let value = changes.borrow().clone();
        if value.settled || value.state == State::PendingCleanup {
            observer.1 = false;
            return Ok(value);
        }
        tokio::select! {
            result=changes.changed()=>{if result.is_err(){return Err(Code::Unavailable.into());}},
            _=tokio::time::sleep_until(tokio::time::Instant::from_std(job.deadline+Duration::from_secs(7)))=>{
                job.operation.abandon();use inventory::process::Control;job.pending_cleanup();observer.1=false;return Ok(job.snapshot());
            }
        }
    }
}
#[tauri::command]
pub async fn agent_plugin_inventory_read(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    request_id: String,
    selection_id: String,
    cwd: String,
) -> Result<PluginOperation> {
    let store = inventory::context(&app, &webview, "agent_plugin_inventory_read")?;
    let pair = requests::shared().inventory(&agent_id, &request_id, &selection_id, &cwd)?;
    dispatch(app, store, pair).await
}
#[tauri::command]
pub async fn agent_plugin_change_inspect(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    request_id: String,
    inventory_request_id: String,
    item_id: usize,
    install: bool,
) -> Result<PluginOperation> {
    let store = inventory::context(&app, &webview, "agent_plugin_change_inspect")?;
    let pair = requests::shared().inspect(
        &agent_id,
        &request_id,
        &inventory_request_id,
        item_id,
        install,
    )?;
    dispatch(app, store, pair).await
}
#[tauri::command]
pub async fn agent_plugin_change_confirm(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    request_id: String,
    review_id: String,
) -> Result<PluginOperation> {
    let store = inventory::context(&app, &webview, "agent_plugin_change_confirm")?;
    let pair = requests::shared().confirm(&agent_id, &request_id, &review_id)?;
    dispatch(app, store, pair).await
}
#[tauri::command]
pub async fn agent_plugin_change_recheck(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    request_id: String,
    operation_id: String,
) -> Result<PluginOperation> {
    let store = inventory::context(&app, &webview, "agent_plugin_change_recheck")?;
    let pair = requests::shared().recheck(&agent_id, &request_id, &operation_id)?;
    dispatch(app, store, pair).await
}
#[tauri::command]
pub fn agent_plugin_operation_status(
    webview: Webview,
    agent_id: String,
    request_id: String,
) -> Result<PluginOperation> {
    inventory::allowed(&webview)?;
    Ok(requests::shared().get(&agent_id, &request_id)?.snapshot())
}
#[tauri::command]
pub fn agent_plugin_operation_cancel(
    webview: Webview,
    agent_id: String,
    request_id: String,
) -> Result<Cancellation> {
    inventory::allowed(&webview)?;
    requests::shared().cancel(&agent_id, &request_id)
}
#[cfg(all(test, target_os = "macos"))]
mod tests;
