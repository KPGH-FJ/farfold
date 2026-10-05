//! Public pages and verified local HTML share one independent WK view without a Tauri bridge.
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
#[path = "browser_workspace/native.rs"]
mod native;
#[path = "browser_workspace/page_read.rs"]
mod page_read;
#[path = "browser_workspace/policy.rs"]
mod policy;
#[cfg(test)]
#[path = "browser_workspace/tests.rs"]
mod tests;

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, Url, Webview};

pub(crate) use browser_tools::{ControlReview, ToolRequest};
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
    active: Option<Active>,
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

impl BrowserWorkspace {
    fn reserve(&self, task: &str, url: Url) -> Result<(u64, Option<u64>, BrowserInfo), String> {
        self.reserve_page(task, url, None, None)
    }

    fn reserve_html(
        &self,
        task: &str,
        name: String,
        storage: local_html::StoragePartition,
    ) -> Result<(u64, Option<u64>, BrowserInfo), String> {
        self.reserve_page(task, storage.origin.clone(), Some(name), Some(storage))
    }

    fn reserve_page(
        &self,
        task: &str,
        url: Url,
        local_file_name: Option<String>,
        local_storage: Option<local_html::StoragePartition>,
    ) -> Result<(u64, Option<u64>, BrowserInfo), String> {
        policy::validate_task_key(task)?;
        let mut store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        if store.shutting_down {
            return Err("应用页面正在关闭，请重新打开后再试".into());
        }
        if store.active.is_some() {
            return Err("请等待原网页关闭确认后再打开".into());
        }
        store.next = store.next.checked_add(1).ok_or("请重开应用后再试")?;
        let id = store.next;
        let old = None;
        let info = BrowserInfo {
            task_key: task.into(),
            label: if local_file_name.is_some() {
                format!("local-html-{id}")
            } else {
                format!("public-page-{id}")
            },
            url: local_file_name.clone().unwrap_or_else(|| url.to_string()),
            local_storage_persistent: local_storage
                .as_ref()
                .map(|_| native::persistent_html_supported()),
            local_file_name,
            preview_mode: None,
            phase: "loading".into(),
            revision: 1,
            error: None,
        };
        store.active = Some(Active {
            id,
            info: info.clone(),
            origin: url,
            local_storage,
            preview: None,
            navigation: 1,
            closing: false,
        });
        Ok((id, old, info))
    }

    fn info(&self, id: u64) -> Result<BrowserInfo, String> {
        let store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        Ok(store
            .active
            .as_ref()
            .filter(|a| a.id == id)
            .ok_or("网页已关闭或已更换")?
            .info
            .clone())
    }

    /// Permission requests capture only safe metadata for this exact ready page.
    pub(crate) fn permission_page(&self, task: &str) -> Result<BrowserInfo, String> {
        let store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        store
            .active
            .as_ref()
            .filter(|active| {
                !store.shutting_down
                    && !active.closing
                    && active.info.task_key == task
                    && active.info.phase == "ready"
                    && active.shareable()
            })
            .map(|active| active.info.clone())
            .ok_or_else(|| "请先打开此对话的公开网页".into())
    }

    fn identity(&self, task: &str, label: &str) -> Result<u64, String> {
        let store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        let active = store.active.as_ref().ok_or("请先打开公开网页")?;
        if active.info.task_key != task || active.info.label != label {
            return Err("网页已关闭或已更换，请重新打开".into());
        }
        Ok(active.id)
    }

    fn local_storage(
        &self,
        task: &str,
        label: &str,
    ) -> Result<local_html::StoragePartition, String> {
        let store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        store
            .active
            .as_ref()
            .filter(|a| !a.closing && a.info.task_key == task && a.info.label == label)
            .and_then(|a| a.local_storage.clone())
            .ok_or_else(|| "请先打开要清除存档的本地网页".into())
    }

    fn navigate(&self, id: u64, url: Url) -> Result<BrowserInfo, String> {
        let mut store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        let active = store
            .active
            .as_mut()
            .filter(|a| a.id == id)
            .ok_or("网页已关闭或已更换")?;
        if active.closing {
            return Err("网页正在关闭，请重试关闭后再打开".into());
        }
        if active.preview.is_some() {
            if active.allowed_url(url.as_str()).is_none() {
                return Err("此跳转不在已选择的网页范围内".into());
            }
        } else if active.info.local_file_name.is_some() {
            return Err("本地网页不能跳转到网站，请关闭后从网页入口打开".into());
        }
        // Only this explicit user command may authorize a different origin.
        if active.preview.is_none() {
            active.origin = url.clone();
        }
        active.navigation += 1;
        active.info.revision += 1;
        active.info.url = url.to_string();
        active.info.phase = "loading".into();
        active.info.error = None;
        Ok(active.info.clone())
    }

    pub(super) fn is_preview(&self, id: u64) -> bool {
        self.0.lock().is_ok_and(|s| {
            s.active
                .as_ref()
                .is_some_and(|a| a.id == id && a.preview.is_some())
        })
    }

    fn can_operate(&self, id: u64, navigation: Option<u64>) -> bool {
        self.0.lock().ok().is_some_and(|store| {
            store.active.as_ref().is_some_and(|a| {
                a.id == id && !a.closing && navigation.is_none_or(|n| n == a.navigation)
            })
        })
    }

    /// User input takes control back without inspecting its contents. Keep the
    /// page visible, but invalidate every outstanding observation/operation.
    pub(super) fn manual_activity(&self, id: u64) -> Option<(u64, BrowserInfo)> {
        let mut store = self.0.lock().ok()?;
        let active = store
            .active
            .as_mut()
            .filter(|a| a.id == id && !a.closing && a.info.phase == "ready")?;
        active.navigation = active.navigation.checked_add(1)?;
        active.info.revision = active.info.revision.checked_add(1)?;
        Some((active.navigation, active.info.clone()))
    }

    fn navigation(&self, id: u64) -> Result<u64, String> {
        let store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        Ok(store
            .active
            .as_ref()
            .filter(|a| a.id == id && !a.closing)
            .ok_or("网页已关闭或正在关闭")?
            .navigation)
    }

    fn policy(&self, id: u64, text: &str) -> bool {
        let Ok(store) = self.0.lock() else {
            return false;
        };
        let Some(active) = store.active.as_ref().filter(|a| a.id == id && !a.closing) else {
            return false;
        };
        if active.preview.is_some() {
            return active.allowed_url(text).is_some();
        }
        if active.info.local_file_name.is_some() {
            // Only the exact initial in-memory load is admitted. No local path,
            // subframe or later same-origin navigation acquires a file grant.
            return active.info.phase == "loading" && text == active.origin.as_str();
        }
        policy::validate_public_url(text).is_ok_and(|url| policy::same_origin(&active.origin, &url))
    }

    // A link is claimed BEFORE native loadRequest; didStart never invents a token.
    fn link_navigation(&self, id: u64, text: &str) -> Option<(u64, BrowserInfo)> {
        let mut store = self.0.lock().ok()?;
        let a = store.active.as_mut().filter(|a| a.id == id && !a.closing)?;
        if !a.shareable() {
            return None;
        }
        let url = a.allowed_url(text)?;
        a.navigation = a.navigation.checked_add(1)?;
        a.info.revision += 1;
        a.info.url = url.to_string();
        a.info.phase = "loading".into();
        a.info.error = None;
        Some((a.navigation, a.info.clone()))
    }

    fn event(&self, id: u64, navigation: u64, kind: i32, raw_url: &str) -> Option<BrowserInfo> {
        let mut store = self.0.lock().ok()?;
        let active = store
            .active
            .as_mut()
            .filter(|a| a.id == id && !a.closing && a.navigation == navigation)?;
        // Navigation terminal callbacks cannot revive ready/blocked/error states.
        if matches!(kind, 0..=2) && active.info.phase != "loading" {
            return None;
        }
        match kind {
            0 => {}
            1 => {
                let valid = active.allowed_url(raw_url);
                if let Some(url) = valid {
                    if active.shareable() {
                        active.info.url = url.to_string();
                    }
                    active.info.phase = "ready".into();
                    active.info.error = None;
                } else {
                    active.info.phase = "blocked".into();
                    active.info.error = Some("此页面未获准读取，请输入公开网页地址".into());
                }
            }
            2 | 5 => {
                active.info.phase = "error".into();
                active.info.error = Some("网页未能加载，请重新打开后再试".into());
            }
            3 => {
                active.info.phase = "blocked".into();
                active.info.error =
                    Some("此跳转未打开；请明确输入公开网页地址。脚本和表单跳转暂不支持".into());
            }
            _ => return None,
        }
        active.info.revision += 1;
        Some(active.info.clone())
    }

    fn read_ticket(&self, task: &str, label: &str) -> Result<ReadTicket, String> {
        let id = self.identity(task, label)?;
        let store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        let active = store
            .active
            .as_ref()
            .filter(|a| a.id == id)
            .ok_or("网页已关闭或已更换")?;
        if !active.shareable() {
            return Err("本地网页暂不提供网页读取或分享".into());
        }
        if active.closing || active.info.phase != "ready" {
            return Err("请等待公开网页加载完成后再读取".into());
        }
        Ok(ReadTicket {
            id,
            task_key: task.into(),
            label: label.into(),
            navigation: active.navigation,
        })
    }

    fn complete_read(&self, ticket: &ReadTicket, raw: &str) -> Result<PageSnapshot, String> {
        if raw.len() > 300_000 {
            return Err("网页返回内容过大".into());
        }
        let page: NativeSnapshot = serde_json::from_str(raw).map_err(|_| "未能读取网页内容")?;
        self.with_read_ticket(ticket, |active| {
            if page.blocked {
                return Err("页面含登录输入，已停止读取；请关闭并改用公开网页".into());
            }
            let url = active
                .allowed_url(&page.url)
                .ok_or("网页已变化，本次读取已取消")?;
            if page.title.chars().count() > 512 || page.text.chars().count() > 65_536 {
                return Err("网页返回内容过大".into());
            }
            Ok(PageSnapshot {
                task_key: ticket.task_key.clone(),
                label: ticket.label.clone(),
                url: url.to_string(),
                title: page.title,
                text: page.text,
                revision: active.info.revision,
                observed_at_ms: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
                    .min(u64::MAX as u128) as u64,
            })
        })
    }

    fn with_read_ticket<T>(
        &self,
        ticket: &ReadTicket,
        action: impl FnOnce(&Active) -> Result<T, String>,
    ) -> Result<T, String> {
        let store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        let active = store
            .active
            .as_ref()
            .filter(|a| {
                !store.shutting_down
                    && a.id == ticket.id
                    && a.info.task_key == ticket.task_key
                    && a.info.label == ticket.label
                    && !a.closing
                    && a.navigation == ticket.navigation
                    && a.info.phase == "ready"
                    && a.shareable()
            })
            .ok_or("网页已变化，本次读取已取消，请重新读取")?;
        // Keep ownership/navigation stable through a fast nonblocking action.
        action(active)
    }

    fn close(&self, task: &str, label: &str) -> Result<Option<(u64, BrowserInfo)>, String> {
        let mut store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        if !store
            .active
            .as_ref()
            .is_some_and(|a| a.info.task_key == task && a.info.label == label)
        {
            return Ok(None);
        }
        let active = store.active.as_mut().ok_or("网页已关闭")?;
        active.closing = true;
        if let Some(preview) = &active.preview {
            preview.revoke();
        }
        active.info.phase = "loading".into();
        active.info.revision += 1;
        active.info.error = None;
        Ok(Some((active.id, active.info.clone())))
    }

    fn acknowledge_close(&self, id: u64) -> Option<BrowserInfo> {
        let mut store = self.0.lock().ok()?;
        if !store
            .active
            .as_ref()
            .is_some_and(|a| a.id == id && a.closing)
        {
            return None;
        }
        let mut active = store.active.take()?;
        active.info.phase = "closed".into();
        active.info.revision += 1;
        active.info.error = None;
        Some(active.info)
    }

    fn close_failed(&self, id: u64) -> Option<BrowserInfo> {
        let mut store = self.0.lock().ok()?;
        let active = store.active.as_mut().filter(|a| a.id == id && a.closing)?;
        active.info.phase = "error".into();
        active.info.error = Some("网页关闭未确认，请重试关闭".into());
        active.info.revision += 1;
        Some(active.info.clone())
    }

    fn active_info(&self) -> Result<Option<BrowserInfo>, String> {
        Ok(self
            .0
            .lock()
            .map_err(|_| "网页状态暂时不可用")?
            .active
            .as_ref()
            .map(|a| a.info.clone()))
    }

    /// Revoke before synchronous native teardown. Pending main-thread creation
    /// and observation completions must no longer be allowed to act or deliver.
    fn begin_shutdown(&self) {
        let mut store = self.0.lock().unwrap_or_else(|error| error.into_inner());
        store.shutting_down = true;
        if let Some(active) = store.active.as_mut() {
            active.closing = true;
            if let Some(preview) = &active.preview {
                preview.revoke();
            }
            active.info.phase = "loading".into();
            active.info.revision = active.info.revision.saturating_add(1);
        }
    }

    fn acknowledge_shutdown(&self) {
        let mut store = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if store.shutting_down {
            store.active = None;
        }
    }
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
    if let Some(sharing) = app.try_state::<crate::browser_sharing::BrowserSharing>() {
        sharing.page_changed(&info);
    }
    let _ = app.emit_to(EventTarget::webview("main"), STATE_EVENT, info);
}

pub fn caller_allowed(webview: &Webview) -> bool {
    let Ok(url) = webview.url() else { return false };
    let development = if cfg!(debug_assertions) {
        webview.app_handle().config().build.dev_url.as_ref()
    } else {
        None
    };
    policy::caller_is_main(webview.label(), &url, development)
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
    if let Some(old) = state.active_info()? {
        close_owned(&app, &state, &old.task_key, &old.label).await?;
    }
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
    let document = tauri::async_runtime::spawn_blocking(move || {
        local_html::read_document(std::path::Path::new(&project_directory), &file)
    })
    .await
    .map_err(|_| "无法读取本地网页，请重新核实文件")??;
    let _operation = state.1.lock().await;
    if let Some(old) = state.active_info()? {
        close_owned(&app, &state, &old.task_key, &old.label).await?;
    }
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
        let active = store
            .active
            .as_ref()
            .filter(|a| a.id == id)
            .ok_or("网页已关闭")?;
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
    native::set_visible(&app, state.inner().clone(), id, visible, bounds).await
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
