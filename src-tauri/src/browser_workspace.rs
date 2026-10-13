//! Public pages and verified local HTML own independent views without a Tauri bridge.
//! Public pages stay temporary; offline HTML has isolated, per-project/file storage.
//! Tools receive only a fixed, revocable public-page read scope.
#[path = "browser_workspace/browser_tools.rs"]
mod browser_tools;
#[path = "browser_workspace/local_html.rs"]
mod local_html;
#[path = "browser_workspace/local_preview.rs"]
mod local_preview;
#[path = "browser_workspace/preview_commands.rs"]
pub(crate) mod preview_commands;
use preview_commands::PreviewSource;
#[cfg(target_os = "macos")]
#[path = "browser_workspace/native.rs"]
mod native;
#[cfg(windows)]
#[path = "browser_workspace/windows/mod.rs"]
mod native;
#[path = "browser_workspace/native_request.rs"]
mod native_request;
#[path = "browser_workspace/page_read.rs"]
mod page_read;
#[path = "browser_workspace/page_store.rs"]
mod page_store;
#[path = "browser_workspace/policy.rs"]
mod policy;
#[path = "browser_workspace/tab_commands.rs"]
pub(crate) mod tab_commands;
#[cfg(test)]
#[path = "browser_workspace/tab_tests.rs"]
mod tab_tests;
#[cfg(test)]
#[path = "browser_workspace/tests.rs"]
mod tests;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, Url, Webview};

pub(crate) use browser_tools::{ControlReview, ToolFailure, ToolRequest};
pub(crate) use page_read::{FixedPageReadScope, PageReadLease};
pub use policy::Bounds;
#[cfg(test)]
pub(crate) use tests::sharing_scope_fixture;

const STATE_EVENT: &str = "browser-workspace:state";

#[derive(Clone, Default)]
pub struct BrowserWorkspace(Arc<Mutex<Store>>, Arc<tokio::sync::Mutex<()>>);

#[derive(Default)]
struct Store {
    next: u64,
    pages: BTreeMap<u64, Active>,
    selections: BTreeMap<String, tab_commands::SelectionState>,
    presented: Option<u64>,
    presentation_uncertain: Option<u64>,
    shutting_down: bool,
}

struct Active {
    id: u64,
    info: BrowserInfo,
    origin: Url,
    local_storage: Option<local_html::StoragePartition>,
    preview: Option<PreviewSource>,
    navigation: u64,
    closing: bool,
    withdrawing: bool,
    creation_pending: bool,
    read_gate: PageReadLease,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInfo {
    pub task_key: String,
    pub label: String,
    pub url: String,
    /// Present only for a verified, offline local HTML document. Never shareable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_file_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_storage_persistent: Option<bool>,
    pub phase: String,
    pub revision: u64,
    pub error: Option<String>,
}

#[derive(Clone, PartialEq, Eq)]
struct ReadTicket {
    id: u64,
    task_key: String,
    label: String,
    navigation: u64,
    selection_revision: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSnapshot {
    task_key: String,
    label: String,
    url: String,
    title: String,
    text: String,
    observed_at_ms: u64,
    revision: u64,
}

#[derive(Deserialize)]
struct NativeSnapshot {
    blocked: bool,
    #[serde(default)]
    url: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    text: String,
}

/// Tauri invokes its run-event callback on the application's main event loop.
/// Never wait for async command serialization during window destruction/exit.
fn should_close_for_event(event: &tauri::RunEvent) -> bool {
    matches!(event, tauri::RunEvent::Exit)
        || matches!(event, tauri::RunEvent::WindowEvent {
            label, event, ..
        } if should_close_for_window(label, event))
}

fn should_close_for_window(label: &str, event: &tauri::WindowEvent) -> bool {
    label == "main" && matches!(event, tauri::WindowEvent::Destroyed)
}

pub fn handle_run_event(app: &AppHandle, event: &tauri::RunEvent) {
    if !should_close_for_event(event) {
        return;
    }
    let state = app.state::<BrowserWorkspace>();
    state.begin_shutdown();
    if let Some(sharing) = app.try_state::<crate::browser_sharing::BrowserSharing>() {
        sharing.shutdown();
    }
    if native::close_all_on_main_thread() {
        state.acknowledge_shutdown();
    }
}

fn publish(app: &AppHandle, info: BrowserInfo) {
    tab_commands::publish_tabs(app, &info.task_key);
    if let Some(sharing) = app.try_state::<crate::browser_sharing::BrowserSharing>() {
        sharing.page_changed(&info);
    }
    let _ = app.emit_to(EventTarget::webview("main"), STATE_EVENT, info);
}

pub fn caller_allowed(webview: &Webview) -> bool {
    let Ok(url) = webview.url() else { return false };
    caller_allowed_for_config(
        webview.label(),
        &url,
        webview.app_handle().config(),
        cfg!(windows),
    )
}

/// Inputs come from Tauri IPC context and trusted app config. The explicit
/// platform argument keeps the production Windows mapping testable on macOS.
pub(crate) fn caller_allowed_for_config(
    label: &str,
    url: &Url,
    config: &tauri::Config,
    windows: bool,
) -> bool {
    let Some(main) = config
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
    else {
        return false;
    };
    let development = if cfg!(debug_assertions) {
        config.build.dev_url.as_ref()
    } else {
        None
    };
    let packaged = policy::MainAppOrigin::for_platform(windows, main.use_https_scheme);
    policy::caller_is_main(label, url, packaged, development)
}

fn require_main(webview: &Webview) -> Result<(), String> {
    if caller_allowed(webview) {
        Ok(())
    } else {
        Err("此页面不能操作应用".into())
    }
}

#[tauri::command]
pub async fn browser_workspace_open(
    webview: Webview,
    app: AppHandle,
    state: State<'_, BrowserWorkspace>,
    task_key: String,
    url: String,
    bounds: Bounds,
) -> Result<BrowserInfo, String> {
    require_main(&webview)?;
    bounds.validate()?;
    let url = policy::validate_public_url(&url)?;
    policy::validate_task_key(&task_key)?;
    let _operation = state.1.lock().await;
    let (id, _, _) = state.reserve(&task_key, url.clone())?;
    let shared = state.inner().clone();
    let creation = native::create(&app, shared.clone(), id, bounds, url.to_string()).await;
    if creation.is_err() {
        if let Some(info) = shared.event(id, 1, 2, "") {
            publish(&app, info);
        }
        // Reservation already owns a possibly-created native surface. Return
        // its failed state and exact identity so the caller can close/retry it;
        // an unlabelled error would strand that owner after a missing ACK.
        return shared.info(id);
    }
    shared.creation_confirmed(id)?;
    let info = shared.info(id)?;
    publish(&app, info.clone());
    Ok(info)
}

/// Read the exact verified disk version before creating any executable surface.
/// This owns bytes in memory, never grants WebKit filesystem access.
#[tauri::command]
pub async fn browser_workspace_open_html(
    webview: Webview,
    app: AppHandle,
    state: State<'_, BrowserWorkspace>,
    task_key: String,
    project_directory: String,
    file: crate::file_delivery::VerifiedFile,
    bounds: Bounds,
) -> Result<BrowserInfo, String> {
    require_main(&webview)?;
    bounds.validate()?;
    policy::validate_task_key(&task_key)?;
    let document = crate::file_read_check::run(move || {
        local_html::read_document(std::path::Path::new(&project_directory), &file)
    })
    .await?;
    let _operation = state.1.lock().await;
    let (id, _, _) = state.reserve_html(&task_key, document.name, document.storage.clone())?;
    let shared = state.inner().clone();
    let creation = native::create_html(
        &app,
        shared.clone(),
        id,
        bounds,
        document.storage,
        document.html,
    )
    .await;
    if creation.is_err() {
        if let Some(info) = shared.event(id, 1, 2, "") {
            publish(&app, info);
        }
        return shared.info(id);
    }
    shared.creation_confirmed(id)?;
    let info = shared.info(id)?;
    publish(&app, info.clone());
    Ok(info)
}

#[tauri::command]
pub async fn browser_workspace_navigate(
    webview: Webview,
    app: AppHandle,
    state: State<'_, BrowserWorkspace>,
    task_key: String,
    label: String,
    url: String,
) -> Result<BrowserInfo, String> {
    require_main(&webview)?;
    let _operation = state.1.lock().await;
    let id = state.identity(&task_key, &label)?;
    let url = {
        let store = state.0.lock().map_err(|_| "网页状态暂时不可用")?;
        let active = store.pages.get(&id).ok_or("网页已关闭")?;
        if active.preview.is_some() {
            active
                .allowed_url(&url)
                .ok_or("此地址不在已选择的网页范围内")?
        } else {
            policy::validate_public_url(&url)?
        }
    };
    let info = state.navigate(id, url.clone())?;
    publish(&app, info);
    let token = state.navigation(id)?;
    if let Some(sharing) = app.try_state::<crate::browser_sharing::BrowserSharing>()
        && let Err(error) = sharing.stop_page(&task_key, &label).await
    {
        if let Some(info) = state.event(id, token, 2, "") {
            publish(&app, info);
        }
        return Err(error);
    }
    if let Err(error) = if state.is_preview(id) {
        native::navigate_preview(&app, state.inner().clone(), id, token, url.to_string()).await
    } else {
        native::navigate(&app, state.inner().clone(), id, token, url.to_string()).await
    } {
        if let Some(info) = state.event(id, token, 2, "") {
            publish(&app, info);
        }
        return Err(error);
    }
    state.info(id)
}

#[tauri::command]
pub async fn browser_workspace_resize(
    webview: Webview,
    app: AppHandle,
    state: State<'_, BrowserWorkspace>,
    task_key: String,
    label: String,
    bounds: Bounds,
) -> Result<(), String> {
    require_main(&webview)?;
    bounds.validate()?;
    let _operation = state.1.lock().await;
    let id = state.identity(&task_key, &label)?;
    if !state.can_operate(id, None) {
        return Err("网页正在关闭".into());
    }
    native::resize(&app, id, bounds).await
}

#[tauri::command]
pub async fn browser_workspace_set_visible(
    webview: Webview,
    app: AppHandle,
    state: State<'_, BrowserWorkspace>,
    task_key: String,
    label: String,
    visible: bool,
    bounds: Option<Bounds>,
) -> Result<(), String> {
    require_main(&webview)?;
    if visible {
        bounds
            .as_ref()
            .ok_or("网页区域尚不可见，请展开后重试")?
            .validate()?;
    }
    let _operation = state.1.lock().await;
    let id = state.identity(&task_key, &label)?;
    if !state.can_operate(id, None) {
        return Err("网页正在关闭".into());
    }
    // Presentation only: no navigation revision or permission is changed.
    tab_commands::set_visibility_owned(&app, &state, id, visible, bounds).await
}

#[tauri::command]
pub async fn browser_workspace_snapshot(
    webview: Webview,
    app: AppHandle,
    state: State<'_, BrowserWorkspace>,
    task_key: String,
    label: String,
) -> Result<PageSnapshot, String> {
    require_main(&webview)?;
    state.manual_read_scope(&task_key, &label)?.read(&app).await
}

#[tauri::command]
pub async fn browser_workspace_close(
    webview: Webview,
    app: AppHandle,
    state: State<'_, BrowserWorkspace>,
    task_key: String,
    label: String,
) -> Result<(), String> {
    require_main(&webview)?;
    let _operation = state.1.lock().await;
    close_owned(&app, &state, &task_key, &label).await
}

/// Explicit user action. Close this exact page before clearing only the data
/// in its dedicated offline store. No other project's or file's data is enumerated.
#[tauri::command]
pub async fn browser_workspace_clear_html_storage(
    webview: Webview,
    app: AppHandle,
    state: State<'_, BrowserWorkspace>,
    task_key: String,
    label: String,
) -> Result<(), String> {
    require_main(&webview)?;
    let _operation = state.1.lock().await;
    let storage = state.local_storage(&task_key, &label)?;
    if !native::persistent_html_supported() {
        return Err("此系统中的本地网页使用临时存档，关闭网页即可清除".into());
    }
    close_owned(&app, &state, &task_key, &label).await?;
    native::clear_html_storage(&app, storage).await
}

async fn close_owned(
    app: &AppHandle,
    state: &BrowserWorkspace,
    task: &str,
    label: &str,
) -> Result<(), String> {
    if let Some((id, info)) = state.close(task, label)? {
        publish(app, info);
        if let Some(sharing) = app.try_state::<crate::browser_sharing::BrowserSharing>()
            && let Err(error) = sharing.stop_page(task, label).await
        {
            if let Some(info) = state.close_failed(id) {
                publish(app, info);
            }
            return Err(error);
        }
        if let Err(error) = native::close(app, id).await {
            if let Some(info) = state.close_failed(id) {
                publish(app, info);
            }
            return Err(error);
        }
        if let Some(info) = state.acknowledge_close(id) {
            publish(app, info);
        }
    }
    Ok(())
}
