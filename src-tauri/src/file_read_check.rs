//! Bounded replies for explicit, read-only file checks. File writes never use this.
use std::{
    sync::{Arc, OnceLock},
    time::Duration,
};

use tokio::sync::Semaphore;

use crate::file_delivery::DeliveryError;

const WAIT_EXPIRED: &str =
    "文件检查尚未返回，后台可能仍在检查。请查看系统访问提示；仍无响应时，保存工作后退出重开。";
const CHECK_BUSY: &str =
    "已有文件检查尚未结束，本次未开始新检查。请稍后重试；仍无响应时，保存工作后退出重开。";
const MAX_IN_FLIGHT: usize = 2;
const CHECK_WAIT: Duration = Duration::from_secs(15);
static ADMISSION: OnceLock<Arc<Semaphore>> = OnceLock::new();

/// Classifies only this module's fixed outer failures, without changing admission
/// or the lifetime of an already started OS check.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum FailureKind {
    Pending,
    Busy,
    Unavailable,
}
pub(crate) fn classify_error(message: &str) -> FailureKind {
    match message {
        WAIT_EXPIRED => FailureKind::Pending,
        CHECK_BUSY => FailureKind::Busy,
        _ => FailureKind::Unavailable,
    }
}

pub(crate) async fn run<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    // Callers supply only locally normalized messages, never raw OS errors.
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let admission = ADMISSION
        .get_or_init(|| Arc::new(Semaphore::new(MAX_IN_FLIGHT)))
        .clone();
    let global = crate::managed_update::activity().map_err(|_| CHECK_BUSY.to_owned())?;
    run_with(admission, CHECK_WAIT, move || {
        let _global = global;
        operation()
    })
    .await
}

async fn run_with<T, F>(
    admission: Arc<Semaphore>,
    wait: Duration,
    operation: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let permit = admission
        .try_acquire_owned()
        .map_err(|_| CHECK_BUSY.to_owned())?;
    let check = tauri::async_runtime::spawn_blocking(move || {
        // A started OS call cannot be aborted. Keep its slot until the real
        // operation returns, even if the response times out or is dropped.
        let _permit = permit;
        operation()
    });
    // Dropping this handle only discards the late read result. It does not
    // cancel the blocking closure, release its slot, or change any disk data.
    tokio::time::timeout(wait, check)
        .await
        .map_err(|_| WAIT_EXPIRED.to_owned())?
        .map_err(|_| DeliveryError::Unavailable.message().to_owned())?
}

#[cfg(test)]
#[path = "file_read_check_tests.rs"]
pub(crate) mod tests;
