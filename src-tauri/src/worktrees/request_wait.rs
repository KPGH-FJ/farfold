//! Finite IPC waits; the ORIGINAL blocking closure keeps its resources and slot.
//! No task queue, durable job, cancellation, retry or second process controller.
use super::*;
use tokio::sync::Semaphore;

const REPLY_WAIT: Duration = Duration::from_secs(15);

#[derive(Clone, Copy)]
pub(crate) enum RequestClass {
    Work,
    Status,
    Cancel,
}

pub(super) struct Admission {
    work: Arc<Semaphore>,
    status: Arc<Semaphore>,
    cancel: Arc<Semaphore>,
}
impl Default for Admission {
    fn default() -> Self {
        Self {
            work: Arc::new(Semaphore::new(2)),
            status: Arc::new(Semaphore::new(1)),
            cancel: Arc::new(Semaphore::new(1)),
        }
    }
}
impl Admission {
    fn gate(&self, class: RequestClass) -> Arc<Semaphore> {
        match class {
            RequestClass::Work => self.work.clone(),
            RequestClass::Status => self.status.clone(),
            RequestClass::Cancel => self.cancel.clone(),
        }
    }
    async fn run<T: Send + 'static>(
        &self,
        class: RequestClass,
        wait: Duration,
        operation: impl FnOnce() -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let permit = self
            .gate(class)
            .try_acquire_owned()
            .map_err(|_| error("busy"))?;
        let worker = tauri::async_runtime::spawn_blocking(move || {
            // A timeout or discarded IPC response cannot unwind this actual
            // stack, drop native pins, or allow another unbounded OS request.
            let _permit = permit;
            operation()
        });
        tokio::time::timeout(wait, worker)
            .await
            .map_err(|_| error("unknown"))?
            .map_err(|_| error("unknown"))?
    }
}
impl Worktrees {
    pub(crate) async fn request<T: Send + 'static>(
        &self,
        class: RequestClass,
        operation: impl FnOnce() -> Result<T> + Send + 'static,
    ) -> Result<T> {
        self.0.requests.run(class, REPLY_WAIT, operation).await
    }
}

#[cfg(test)]
#[path = "request_wait_tests.rs"]
mod tests;
