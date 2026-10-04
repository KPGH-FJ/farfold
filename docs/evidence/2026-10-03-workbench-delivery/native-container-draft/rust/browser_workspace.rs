//! Public-page workspace. Independent WK subview; never registered as a Tauri
//! webview, never receives Tauri IPC initialization, and never exposed to Agents.
#[path = "browser_workspace/native.rs"]
mod native;
#[path = "browser_workspace/policy.rs"]
mod policy;
#[cfg(test)]
#[path = "browser_workspace/tests.rs"]
mod tests;

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, Url, Webview};

pub use policy::Bounds;

const STATE_EVENT: &str = "browser-workspace:state";

#[derive(Clone, Default)]
pub struct BrowserWorkspace(Arc<Mutex<Store>>);

#[derive(Default)]
struct Store {
    next: u64,
    active: Option<Active>,
}

struct Active {
    id: u64,
    info: BrowserInfo,
    origin: Url,
    navigation: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInfo {
    pub task_key: String,
    pub label: String,
    pub url: String,
    pub phase: String,
    pub revision: u64,
    pub error: Option<String>,
}

#[derive(Clone)]
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
        policy::validate_task_key(task)?;
        let mut store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        store.next = store.next.checked_add(1).ok_or("请重开应用后再试")?;
        let id = store.next;
        let old = store.active.take().map(|active| active.id);
        let info = BrowserInfo {
            task_key: task.into(), label: format!("public-page-{id}"), url: url.to_string(),
            phase: "loading".into(), revision: 1, error: None,
        };
        store.active = Some(Active { id, info: info.clone(), origin: url, navigation: 1 });
        Ok((id, old, info))
    }

    fn info(&self, id: u64) -> Result<BrowserInfo, String> {
        let store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        Ok(store.active.as_ref().filter(|a| a.id == id).ok_or("网页已关闭或已更换")?.info.clone())
    }

    fn identity(&self, task: &str, label: &str) -> Result<u64, String> {
        let store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        let active = store.active.as_ref().ok_or("请先打开公开网页")?;
        if active.info.task_key != task || active.info.label != label {
            return Err("网页已关闭或已更换，请重新打开".into());
        }
        Ok(active.id)
    }

    fn navigate(&self, id: u64, url: Url) -> Result<BrowserInfo, String> {
        let mut store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        let active = store.active.as_mut().filter(|a| a.id == id).ok_or("网页已关闭或已更换")?;
        // Only this explicit user command may authorize a different origin.
        active.origin = url.clone();
        active.navigation += 1;
        active.info.revision += 1;
        active.info.url = url.to_string();
        active.info.phase = "loading".into();
        active.info.error = None;
        Ok(active.info.clone())
    }

    fn policy(&self, id: u64, text: &str) -> bool {
        let Ok(url) = policy::validate_public_url(text) else { return false };
        let Ok(mut store) = self.0.lock() else { return false };
        let Some(active) = store.active.as_mut().filter(|a| a.id == id) else { return false };
        if !policy::same_origin(&active.origin, &url) { return false; }
        active.navigation += 1;
        active.info.revision += 1;
        active.info.phase = "loading".into();
        active.info.error = None;
        active.info.url = url.to_string();
        true
    }

    fn event(&self, id: u64, kind: i32, raw_url: &str) -> Option<BrowserInfo> {
        let mut store = self.0.lock().ok()?;
        let active = store.active.as_mut().filter(|a| a.id == id)?;
        match kind {
            0 => { active.navigation += 1; active.info.phase = "loading".into(); }
            1 => {
                let valid = policy::validate_public_url(raw_url).ok()
                    .filter(|url| policy::same_origin(url, &active.origin));
                if let Some(url) = valid {
                    active.info.url = url.to_string();
                    active.info.phase = "ready".into();
                    active.info.error = None;
                } else {
                    active.navigation += 1;
                    active.info.phase = "blocked".into();
                    active.info.error = Some("此页面未获准读取，请输入公开网页地址".into());
                }
            }
            2 => {
                active.navigation += 1;
                active.info.phase = "error".into();
                active.info.error = Some("网页未能加载，请重新打开后再试".into());
            }
            3 => {
                active.navigation += 1;
                active.info.phase = "blocked".into();
                active.info.error = Some("此跳转未打开；如需查看，请明确输入公开网页地址。这里不用于登录".into());
            }
            _ => return None,
        }
        active.info.revision += 1;
        Some(active.info.clone())
    }

    fn read_ticket(&self, task: &str, label: &str) -> Result<ReadTicket, String> {
        let id = self.identity(task, label)?;
        let store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        let active = store.active.as_ref().filter(|a| a.id == id).ok_or("网页已关闭或已更换")?;
        if active.info.phase != "ready" { return Err("请等待公开网页加载完成后再读取".into()); }
        Ok(ReadTicket { id, task_key: task.into(), label: label.into(), navigation: active.navigation })
    }

    fn complete_read(&self, ticket: &ReadTicket, raw: &str) -> Result<PageSnapshot, String> {
        if raw.len() > 300_000 { return Err("网页返回内容过大".into()); }
        let page: NativeSnapshot = serde_json::from_str(raw).map_err(|_| "未能读取网页内容")?;
        let store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        let active = store.active.as_ref().filter(|a| a.id == ticket.id
            && a.info.task_key == ticket.task_key && a.info.label == ticket.label
            && a.navigation == ticket.navigation && a.info.phase == "ready")
            .ok_or("网页已变化，本次读取已取消，请重新读取")?;
        if page.blocked { return Err("页面含登录输入，已停止读取；请关闭并改用公开网页".into()); }
        let url = policy::validate_public_url(&page.url)?;
        if !policy::same_origin(&url, &active.origin) { return Err("网页已变化，本次读取已取消".into()); }
        if page.title.chars().count() > 512 || page.text.chars().count() > 65_536 { return Err("网页返回内容过大".into()); }
        Ok(PageSnapshot {
            task_key: ticket.task_key.clone(), label: ticket.label.clone(), url: url.to_string(),
            title: page.title, text: page.text, revision: active.info.revision,
            observed_at_ms: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64,
        })
    }

    fn close(&self, task: &str, label: &str) -> Result<Option<(u64, BrowserInfo)>, String> {
        let mut store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
        if !store.active.as_ref().is_some_and(|a| a.info.task_key == task && a.info.label == label) {
            return Ok(None);
        }
        let mut active = store.active.take().ok_or("网页已关闭")?;
        active.info.phase = "closed".into();
        active.info.revision += 1;
        active.info.error = None;
        Ok(Some((active.id, active.info)))
    }
}

fn publish(app: &AppHandle, info: BrowserInfo) {
    let _ = app.emit_to(EventTarget::webview("main"), STATE_EVENT, info);
}

pub fn caller_allowed(webview: &Webview) -> bool {
    let Ok(url) = webview.url() else { return false };
    let development = if cfg!(debug_assertions) { webview.app_handle().config().build.dev_url.as_ref() } else { None };
    policy::caller_is_main(webview.label(), &url, development)
}

fn require_main(webview: &Webview) -> Result<(), String> {
    if caller_allowed(webview) { Ok(()) } else { Err("此页面不能操作应用".into()) }
}

#[tauri::command]
pub async fn browser_workspace_open(webview: Webview, app: AppHandle, state: State<'_, BrowserWorkspace>, task_key: String, url: String, bounds: Bounds) -> Result<BrowserInfo, String> {
    require_main(&webview)?;
    bounds.validate()?;
    let url = policy::validate_public_url(&url)?;
    let (id, previous, _) = state.reserve(&task_key, url.clone())?;
    let shared = state.inner().clone();
    let creation = native::create(&app, shared.clone(), id, previous, bounds, url.to_string()).await;
    if let Err(error) = creation {
        if let Some(info) = shared.event(id, 2, "") { publish(&app, info); }
        return Err(error);
    }
    let info = shared.info(id)?;
    publish(&app, info.clone());
    Ok(info)
}

#[tauri::command]
pub async fn browser_workspace_navigate(webview: Webview, app: AppHandle, state: State<'_, BrowserWorkspace>, task_key: String, label: String, url: String) -> Result<BrowserInfo, String> {
    require_main(&webview)?;
    let url = policy::validate_public_url(&url)?;
    let id = state.identity(&task_key, &label)?;
    let info = state.navigate(id, url.clone())?;
    publish(&app, info);
    native::navigate(&app, id, url.to_string()).await?;
    state.info(id)
}

#[tauri::command]
pub async fn browser_workspace_resize(webview: Webview, app: AppHandle, state: State<'_, BrowserWorkspace>, task_key: String, label: String, bounds: Bounds) -> Result<(), String> {
    require_main(&webview)?;
    bounds.validate()?;
    let id = state.identity(&task_key, &label)?;
    native::resize(&app, id, bounds).await
}

#[tauri::command]
pub async fn browser_workspace_snapshot(webview: Webview, app: AppHandle, state: State<'_, BrowserWorkspace>, task_key: String, label: String) -> Result<PageSnapshot, String> {
    require_main(&webview)?;
    let ticket = state.read_ticket(&task_key, &label)?;
    let raw = tokio::time::timeout(Duration::from_secs(8), native::read(&app, ticket.id)).await
        .map_err(|_| "网页读取未完成，请关闭网页后重新打开")??;
    state.complete_read(&ticket, &raw)
}

#[tauri::command]
pub async fn browser_workspace_close(webview: Webview, app: AppHandle, state: State<'_, BrowserWorkspace>, task_key: String, label: String) -> Result<(), String> {
    require_main(&webview)?;
    if let Some((id, info)) = state.close(&task_key, &label)? {
        publish(&app, info);
        native::close(&app, id).await?;
    }
    Ok(())
}
