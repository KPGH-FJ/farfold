//! Page execution is separate from the local protocol/output ownership loop.
use super::*;

type Read = Arc<
    dyn Fn(
            FixedPageReadScope,
            ToolRequest,
            Arc<AtomicBool>,
            mpsc::Sender<Result<Value, ToolFailure>>,
        ) -> tauri::async_runtime::JoinHandle<()>
        + Send
        + Sync,
>;

#[derive(Clone)]
pub(super) struct Execution {
    pub(super) screenshots: bool,
    pub(super) read: Read,
}
impl Execution {
    pub(super) fn native(app: AppHandle) -> Self {
        Self {
            screenshots: crate::browser_workspace::screenshot_capability::for_mcp_worker(&app),
            read: Arc::new(move |scope, request, finished, send| {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let result = scope.tool(&app, request).await;
                    finished.store(true, Ordering::Release);
                    let _ = send.send(result);
                })
            }),
        }
    }
}
