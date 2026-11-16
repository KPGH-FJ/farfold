//! Bounded, cancellable candidate paths for the composer's `@` picker.
//! No watcher, saved index, file identity ledger or Agent-side configuration.
use crate::acp_client::manager::validate_cwd;
use serde::Serialize;
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::Webview;
use tokio::sync::Semaphore;
#[path = "project_index_read.rs"]
mod read;
#[path = "project_index_requests.rs"]
mod requests;
#[path = "project_index_scan.rs"]
mod scan;
pub use scan::ProjectFiles;

static SCAN_ADMISSION: Semaphore = Semaphore::const_new(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Failure {
    pub code: &'static str,
}
impl Failure {
    fn new(code: &'static str) -> Self {
        Self { code }
    }
}
fn caller(webview: &Webview) -> Result<(), Failure> {
    if crate::browser_workspace::caller_allowed(webview) {
        Ok(())
    } else {
        Err(Failure::new("unavailable"))
    }
}
async fn observe<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, Failure> + Send + 'static,
) -> Result<T, Failure> {
    crate::file_read_check::run(move || Ok(f()))
        .await
        .map_err(|message| {
            Failure::new(match crate::file_read_check::classify_error(&message) {
                crate::file_read_check::FailureKind::Pending => "readPending",
                crate::file_read_check::FailureKind::Busy => "readBusy",
                crate::file_read_check::FailureKind::Unavailable => "unavailable",
            })
        })?
}
async fn observe_scan<T: Send + 'static>(
    requests: &Arc<requests::Requests>,
    request_id: String,
    operation: impl FnOnce(String, &AtomicBool) -> Result<T, Failure> + Send + 'static,
) -> Result<T, Failure> {
    let (lease, permit) = requests.begin_with(&request_id, || {
        SCAN_ADMISSION
            .try_acquire()
            .map_err(|_| Failure::new("readBusy"))
    })?;
    observe(move || {
        // A cancelled or unobserved scan may still be in the OS. It retains
        // this limit so a rescan cannot take the remaining shared read slot.
        let _permit = permit;
        let lease = lease;
        if lease.flag.load(Ordering::Acquire) {
            return Err(Failure::new("cancelled"));
        }
        operation(request_id, &lease.flag)
    })
    .await
}
#[tauri::command]
pub async fn project_files(
    webview: Webview,
    cwd: String,
    request_id: String,
) -> Result<ProjectFiles, Failure> {
    caller(&webview)?;
    observe_scan(
        &requests::shared(),
        request_id,
        move |request_id, cancel| {
            let root = validate_cwd(&cwd).map_err(|_| Failure::new("unreadable"))?;
            scan::scan(&root, request_id, cancel, scan::Limits::default())
        },
    )
    .await
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cancellation {
    request_id: String,
    cancel_requested: bool,
}
#[tauri::command]
pub fn project_files_cancel(webview: Webview, request_id: String) -> Result<Cancellation, Failure> {
    caller(&webview)?;
    requests::shared().cancel(&request_id)?;
    Ok(Cancellation {
        request_id,
        cancel_requested: true,
    })
}
#[tauri::command]
pub async fn project_file_read(
    webview: Webview,
    cwd: String,
    path: String,
) -> Result<String, Failure> {
    caller(&webview)?;
    observe(move || {
        let root = validate_cwd(&cwd).map_err(|_| Failure::new("unreadable"))?;
        read::read(&root, Path::new(&path))
    })
    .await
}
