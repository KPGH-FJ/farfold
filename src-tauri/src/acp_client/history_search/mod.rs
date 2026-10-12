//! Explicit selected-history search through a bounded official read-only surface.
mod requests;
mod rpc;
mod source;
mod text;
mod types;
use crate::{
    acp_client::{
        extension_inventory as inventory,
        manager::{AccountScope, AcpManager},
    },
    meta_store::MetaStore,
};
use requests::Job;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, Webview};
pub use types::*;
struct ChildControl<'a> {
    job: &'a Job,
    deadline: Instant,
}
impl inventory::process::Control for ChildControl<'_> {
    fn interested(&self) -> bool {
        self.job.operation.interested()
    }
    fn deadline(&self) -> Instant {
        self.deadline
    }
    fn pending_cleanup(&self) {
        inventory::process::Control::pending_cleanup(self.job);
    }
}
fn run_selected(job: &Job, index: usize, command: std::process::Command) -> Result<rpc::Read> {
    job.within()?;
    let control = ChildControl {
        job,
        deadline: job.deadline.min(Instant::now() + Duration::from_secs(15)),
    };
    let mut exchange = rpc::Exchange::new(job, index);
    let result = inventory::process::run_owned(command, &control, Some(&mut exchange), 8388608);
    match result {
        Ok(mut out) => {
            let result = exchange.finish(&out, None);
            out.fill(0);
            Ok(result)
        }
        Err(error) => Ok(exchange.finish(&[], Some(Failure::from(error)))),
    }
}
fn query(store: &MetaStore, job: &Job) -> Result<()> {
    query_with(store, job, |_, row| {
        let env = crate::shell_env::cached_command_env().ok_or(Code::EnvironmentUnavailable)?;
        Ok(inventory::launch::command(
            &job.source.agent,
            &row.cwd,
            env,
            inventory::Kind::Skills,
        )?)
    })
}
fn query_with(
    store: &MetaStore,
    job: &Job,
    mut command: impl FnMut(usize, &crate::meta_store::SessionRow) -> Result<std::process::Command>,
) -> Result<()> {
    for (index, row) in job.source.rows.iter().enumerate() {
        job.within()?;
        job.source.current(store)?;
        if job.snapshot().hits.len() >= 200 {
            job.update(|v| {
                v.rows[index].state = RowState::Skipped;
                v.rows[index].code = Some(Code::ResultLimit);
            });
            continue;
        }
        job.update(|v| {
            if job.operation.interested() {
                v.state = State::Running;
                v.code = None;
                v.rows[index].state = RowState::Reading;
            }
        });
        let result: Result<()> = (|| {
            let directory = inventory::launch::Directory::open(&row.cwd)?;
            let command = command(index, row)?;
            job.within()?;
            job.source.current(store)?;
            let read = run_selected(job, index, command)?;
            job.within()?;
            if !directory.current() {
                return Err(Code::CwdUnavailable.into());
            }
            job.source.current(store)?;
            read.publish(job, index)
        })();
        if let Err(error) = result {
            job.row_failed(index, error.code);
            if matches!(
                error.code,
                Code::Cancelled | Code::SelectionChanged | Code::IndexChanged
            ) || Instant::now() >= job.deadline
            {
                return Err(error);
            }
        }
    }
    Ok(())
}
async fn execute(
    store: MetaStore,
    job: Arc<Job>,
    activity: crate::managed_update::ActivityPermit,
    scope: AccountScope,
) {
    execute_with(store, job, activity, scope, query).await;
}
async fn execute_with(
    store: MetaStore,
    job: Arc<Job>,
    activity: crate::managed_update::ActivityPermit,
    scope: AccountScope,
    run: impl FnOnce(&MetaStore, &Job) -> Result<()> + Send + 'static,
) {
    let execution = match inventory::execution::acquire() {
        Ok(v) => v,
        Err(e) => {
            job.finish(Some(Failure::from(e).code));
            return;
        }
    };
    let configuration = tokio::select! {
     guard=crate::install_job::configuration_guard(&job.source.agent.id)=>guard,
     _=job.operation.cancelled()=>{job.finish(Some(Code::Cancelled));return;},
     _=tokio::time::sleep_until(tokio::time::Instant::from_std(job.deadline))=>{job.finish(Some(Code::TimedOut));return;}
    };
    let observer = job.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&store, &job)))
            .unwrap_or_else(|_| Err(Code::Unavailable.into()));
        // Real owned process runner finishes child, group, pipes before these gates release.
        drop(scope);
        drop(configuration);
        drop(activity);
        drop(execution);
        job.finish(result.err().map(|e| e.code));
    })
    .await;
    if result.is_err() {
        observer.finish(Some(Code::Unavailable));
    }
}
#[tauri::command]
pub async fn history_search_capabilities(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    row_ids: Vec<String>,
) -> Result<Selection> {
    let store = inventory::context(&app, &webview, "history_search_capabilities")?;
    crate::file_read_check::run(move || {
        let manager = app
            .try_state::<AcpManager>()
            .ok_or_else(|| "unavailable".to_string())?;
        Ok(source::capabilities(&store, &manager, &agent_id, &row_ids))
    })
    .await
    .map_err(|_| Code::Unavailable)?
}
#[tauri::command]
pub async fn history_search_start(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    request_id: String,
    selection_id: String,
    query: String,
) -> Result<Reply> {
    let store = inventory::context(&app, &webview, "history_search_start")?;
    let request = Request {
        agent_id,
        request_id,
        selection_id,
        query,
    };
    let pair = requests::shared().begin(request.clone(), || {
        let selected = source::selected(&request.agent_id, &request.selection_id)?;
        selected.current(&store)?;
        Ok(selected)
    })?;
    let (job, fresh) = pair;
    if fresh {
        let admission: Result<_> = (|| {
            let activity = crate::managed_update::activity().map_err(|_| Code::Busy)?;
            let manager = app.try_state::<AcpManager>().ok_or(Code::Unavailable)?;
            job.source.unopened(&manager)?;
            let scope =
                inventory::skills_scope(&manager, &job.source.agent)?.ok_or(Code::Unavailable)?;
            job.source.unopened(&manager)?;
            job.source.current(&store)?;
            Ok((activity, scope))
        })();
        match admission {
            Ok((activity, scope)) => {
                tauri::async_runtime::spawn(execute(store, job.clone(), activity, scope));
            }
            Err(error) => job.finish(Some(error.code)),
        }
    }
    // Admission is acknowledged immediately. Progress observation never owns worker lifetime.
    Ok(Reply::Operation {
        operation: Box::new(job.snapshot()),
    })
}
#[tauri::command]
pub fn history_search_status(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    request_id: String,
) -> Result<Reply> {
    inventory::context(&app, &webview, "history_search_status")?;
    requests::shared().reply(&agent_id, &request_id, false)
}
#[tauri::command]
pub fn history_search_cancel(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    request_id: String,
) -> Result<Reply> {
    inventory::context(&app, &webview, "history_search_cancel")?;
    requests::shared().reply(&agent_id, &request_id, true)
}
#[tauri::command]
pub fn history_search_release(
    app: AppHandle,
    webview: Webview,
    agent_id: String,
    request_id: String,
) -> Result<bool> {
    inventory::context(&app, &webview, "history_search_release")?;
    requests::shared().release(&agent_id, &request_id)
}
#[cfg(test)]
mod tests;
