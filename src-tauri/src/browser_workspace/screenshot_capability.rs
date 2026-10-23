//! Only the MCP worker calls this bounded prerequisite query. A positive result
//! admits a permission request, never certifies a particular page's pixels.
use tauri::AppHandle;

#[cfg(target_os = "macos")]
pub(crate) fn for_mcp_worker(app: &AppHandle) -> bool {
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    // Worker::serve is on its dedicated background thread. The main thread
    // only answers this read-only factory query and never waits on itself.
    if app
        .run_on_main_thread(move || {
            let _ = send.send(super::native::screenshot_supported());
        })
        .is_err()
    {
        return false;
    }
    receive.recv_timeout(std::time::Duration::from_secs(8)) == Ok(true)
}

#[cfg(windows)]
pub(crate) fn for_mcp_worker(_: &AppHandle) -> bool {
    // WebView2's actual per-view interfaces, isolated world, closed roots,
    // visibility and before/after capture guards are checked by the native
    // operation. There is no process-global readiness claim here.
    true
}
