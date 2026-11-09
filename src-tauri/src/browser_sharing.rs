//! Temporary, explicitly granted access to one running public page.
//! Agent-specific eligibility lives in acp_client; no page bodies are retained here.
mod channel;
mod helper;
mod helper_io;
mod permission;
#[cfg(test)]
mod prompt_tests;
mod protocol;
mod screenshot_owner;
#[cfg(test)]
mod state_tests;
mod transport;
#[cfg(all(test, windows))]
mod windows_native_screenshot_tests;

use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, Webview};

use crate::acp_client::transient_mcp::{SessionMcpOwner, TransientMcpOpen};
use crate::browser_workspace::{BrowserInfo, BrowserWorkspace, FixedPageReadScope, PageReadLease};
use permission::{PendingPermission, PendingRequestInfo};
use transport::{SharedPage, TransportHandle};

const CONNECTING: u8 = 0;
const READY: u8 = 1;
const STOPPING: u8 = 2;
const STOP_FAILED: u8 = 3;
const CLOSED: u8 = 4;

#[derive(Clone, Default)]
pub(crate) struct BrowserSharing(Arc<Mutex<Vec<Arc<ToolSession>>>>);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShareTarget {
    agent_id: String,
    cwd: String,
    native_session_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShareInfo {
    task_key: String,
    label: String,
    agent_id: String,
    phase: &'static str,
    revision: u64,
    reason: Option<&'static str>,
    pending_request: Option<PendingRequestInfo>,
}

struct ShareState {
    phase: u8,
    ready: bool,
    ended: bool,
    prompt_active: bool,
    revision: u64,
    retiring: Option<FixedPageReadScope>,
    pending_request: Option<PendingPermission>,
    active_screenshot: Option<screenshot_owner::ActiveScreenshot>,
}

struct ToolSession {
    notify: Arc<dyn Fn(&str) + Send + Sync>,
    agent_id: String,
    cwd: String,
    native_session_id: OnceLock<String>,
    page: SharedPage,
    transport: OnceLock<TransportHandle>,
    state: Mutex<ShareState>,
    operation: tokio::sync::Mutex<()>,
}

impl ToolSession {
    fn task_key(&self) -> Option<String> {
        self.native_session_id
            .get()
            .map(|id| format!("{}:{}:{id}", self.agent_id, self.cwd))
    }

    fn changed(&self) {
        if let Some(task_key) = self.task_key() {
            (self.notify)(&task_key);
        }
    }

    fn tool_ready(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.ended || state.phase == CLOSED {
            return;
        }
        state.ready = true;
        if state.phase == CONNECTING {
            state.phase = READY;
        }
        state.revision = state.revision.saturating_add(1);
        drop(state);
        self.changed();
    }

    // Root state -> shared page -> read lease -> browser state is the only lock order.
    fn take_page(&self, state: &mut ShareState) {
        state.cancel_permission("网页读取请求已结束");
        state.clear_screenshot();
        let mut page = self.page.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(old) = page.take() {
            old.revoke();
        }
        if let Some(old) = state.retiring.take() {
            old.revoke();
        }
    }

    fn invalidated(self: &Arc<Self>, scope: &FixedPageReadScope) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut page = self.page.lock().unwrap_or_else(|e| e.into_inner());
        if state.ended {
            return;
        }
        let standing = page
            .as_ref()
            .is_some_and(|current| current.same_grant(scope));
        if standing {
            let old = page.take().expect("checked standing grant");
            old.revoke();
            state.retiring = Some(old);
        } else if state.retiring.is_none()
            && state.active_screenshot.as_ref().is_some_and(|active| {
                active.scope.same_request(scope) && !active.scope.grant_is_valid()
            })
        {
            // A first screenshot has no standing page grant, but it can
            // still own a response buffered in the helper after navigation.
            state.retire_screenshot();
        } else {
            return;
        }
        state.phase = STOPPING;
        state.revision = state.revision.saturating_add(1);
        drop(page);
        drop(state);
        self.changed();
        let owner = self.clone();
        let expected = scope.clone();
        tauri::async_runtime::spawn(async move {
            if standing {
                let _ = owner.stop_expected(&expected).await;
            } else {
                let _ = owner
                    .stop_if_retiring(|old| old.same_request(&expected))
                    .await;
            }
        });
    }

    fn tool_closed(&self, confirmed: bool) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.ready = false;
        state.cancel_permission("网页工具连接已结束");
        if confirmed {
            self.take_page(&mut state);
            state.phase = CLOSED;
        } else {
            let mut page = self.page.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(old) = page.take() {
                old.revoke();
                state.retiring = Some(old);
            }
            state.retire_screenshot();
            // A broken connection is not proof that a buffered stdout reply stopped.
            state.phase = if state.retiring.is_some() {
                STOP_FAILED
            } else {
                CLOSED
            };
        }
        state.revision = state.revision.saturating_add(1);
        drop(state);
        self.changed();
    }

    fn removable(&self) -> bool {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.ended && state.phase == CLOSED && state.retiring.is_none()
    }

    fn matches(&self, target: &ShareTarget) -> bool {
        self.agent_id == target.agent_id
            && self.cwd == target.cwd
            && self.native_session_id.get() == Some(&target.native_session_id)
    }

    fn info(&self, task: &str, label: &str) -> ShareInfo {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        // Empty label queries this exact conversation owner and reports the
        // actual page identity; it never grants authority to a UI-selected page.
        let owner_label = if label.is_empty() {
            self.page
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
                .map(|page| page.label().to_owned())
                .or_else(|| state.retiring.as_ref().map(|page| page.label().to_owned()))
                .or_else(|| {
                    state
                        .active_screenshot
                        .as_ref()
                        .map(|active| active.scope.label().to_owned())
                })
                .or_else(|| state.pending_request.as_ref().map(|p| p.info.label.clone()))
                .unwrap_or_default()
        } else {
            label.to_owned()
        };
        let label = owner_label.as_str();
        let (phase, reason) = match state.phase {
            CLOSED => ("unavailable", Some("tool_disconnected")),
            STOPPING => ("stopping", None),
            STOP_FAILED => ("stop_failed", Some("stop_unconfirmed")),
            CONNECTING => ("preparing", Some("tool_connecting")),
            _ => {
                let page = self.page.lock().unwrap_or_else(|e| e.into_inner());
                match page.as_ref() {
                    Some(page)
                        if page.task_key() == task && page.label() == label && page.is_valid() =>
                    {
                        ("shared", None)
                    }
                    Some(_) => ("stopping", Some("page_changed")),
                    None if state.active_screenshot.as_ref().is_some_and(|active| {
                        active.scope.task_key() == task && active.scope.label() == label
                    }) =>
                    {
                        ("reading", None)
                    }
                    None => ("unshared", None),
                }
            }
        };
        ShareInfo {
            task_key: task.into(),
            label: label.into(),
            agent_id: self.agent_id.clone(),
            phase,
            reason,
            revision: state.revision,
            pending_request: state.pending_request.as_ref().map(|p| p.info.clone()),
        }
    }

    async fn stop_expected(&self, expected: &FixedPageReadScope) -> Result<(), String> {
        self.stop_if_retiring(|old| old.same_grant(expected)).await
    }

    async fn stop_if_retiring(
        &self,
        matches: impl FnOnce(&FixedPageReadScope) -> bool,
    ) -> Result<(), String> {
        let _operation = self.operation.lock().await;
        let still_retiring = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retiring
            .as_ref()
            .is_some_and(matches);
        if still_retiring {
            self.stop_locked().await
        } else {
            Ok(())
        }
    }

    async fn stop_explicit(
        &self,
        task: &str,
        label: &str,
        expected_revision: u64,
    ) -> Result<(), String> {
        let _operation = self.operation.lock().await;
        let matches = {
            let current = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if current.revision != expected_revision {
                return Err("共享状态已变化，请重新检查后再试".into());
            }
            let page = self.page.lock().unwrap_or_else(|e| e.into_inner());
            let owns = |p: &FixedPageReadScope| p.task_key() == task && p.label() == label;
            page.as_ref().is_some_and(owns)
                || current.retiring.as_ref().is_some_and(owns)
                || current
                    .active_screenshot
                    .as_ref()
                    .is_some_and(|active| owns(&active.scope))
                || current
                    .pending_request
                    .as_ref()
                    .is_some_and(|p| p.info.task_key == task && p.info.label == label)
        };
        if matches {
            self.stop_locked().await
        } else {
            Ok(())
        }
    }

    async fn stop_locked(&self) -> Result<(), String> {
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.phase = STOPPING;
            state.cancel_permission("网页读取已停止");
            let mut page = self.page.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(old) = page.take() {
                old.revoke();
                state.retiring = Some(old);
            }
            state.retire_screenshot();
            state.revision = state.revision.saturating_add(1);
        }
        self.changed();
        let outcome = match self.transport.get() {
            Some(transport) => transport.quiesce().await,
            None => Err("停止共享尚未确认，请重试".into()),
        };
        {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if outcome.is_ok() {
                state.retiring.take();
            }
            state.phase = if outcome.is_err() {
                STOP_FAILED
            } else if state.ended || !state.ready {
                CLOSED
            } else {
                READY
            };
            state.revision = state.revision.saturating_add(1);
        }
        self.changed();
        outcome
    }

    async fn stop_page(&self, task: &str, label: &str) -> Result<(), String> {
        let _operation = self.operation.lock().await;
        let matches = {
            let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let page = self.page.lock().unwrap_or_else(|e| e.into_inner());
            let owns = |p: &FixedPageReadScope| p.task_key() == task && p.label() == label;
            page.as_ref().is_some_and(owns)
                || state.retiring.as_ref().is_some_and(owns)
                || state
                    .active_screenshot
                    .as_ref()
                    .is_some_and(|active| owns(&active.scope))
                || state
                    .pending_request
                    .as_ref()
                    .is_some_and(|p| p.info.task_key == task && p.info.label == label)
        };
        // A delayed stop for an old page must never revoke its replacement.
        if matches {
            self.stop_locked().await
        } else {
            Ok(())
        }
    }
}

impl Drop for ToolSession {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        self.take_page(&mut state);
        if let Some(transport) = self.transport.get() {
            transport.shutdown();
        }
    }
}

impl SessionMcpOwner for ToolSession {
    fn fork_admissible(&self) -> bool {
        let Ok(_operation) = self.operation.try_lock() else {
            return false;
        };
        let Ok(state) = self.state.lock() else {
            return false;
        };
        let Ok(page) = self.page.lock() else {
            return false;
        };
        matches!(state.phase, READY | CLOSED)
            && !state.prompt_active
            && state.pending_request.is_none()
            && state.active_screenshot.is_none()
            && state.retiring.is_none()
            && page.is_none()
    }
    fn bind_session(&self, native_session_id: &str) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if native_session_id.is_empty() || state.ended {
            return Err("网页工具连接已结束".into());
        }
        self.native_session_id
            .set(native_session_id.into())
            .map_err(|_| "网页工具归属已确定".to_string())?;
        state.revision = state.revision.saturating_add(1);
        drop(state);
        self.changed();
        Ok(())
    }

    fn set_prompt_active(&self, active: bool) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.prompt_active = active && !state.ended;
        // This ends only an outstanding user decision. It is not a tool-end
        // receipt or a withdrawal of the user's independent page grant.
        if !state.prompt_active && state.cancel_permission("本次网页请求已取消") {
            drop(state);
            self.changed();
        }
    }

    fn revoke(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.ended = true;
        state.cancel_permission("当前对话已结束");
        {
            let mut page = self.page.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(old) = page.take() {
                old.revoke();
                state.retiring = Some(old);
            }
        }
        state.retire_screenshot();
        state.ready = false;
        state.phase = if state.retiring.is_some() {
            STOPPING
        } else {
            CLOSED
        };
        state.revision = state.revision.saturating_add(1);
        drop(state);
        // Route teardown cannot await: the registry retains this real tool owner
        // until the helper confirms its stdout barrier, or exposes a retry failure.
        if let Some(transport) = self.transport.get() {
            transport.shutdown();
        }
        self.changed();
    }
}

impl BrowserSharing {
    fn entries(&self) -> Vec<Arc<ToolSession>> {
        let mut entries = self.0.lock().unwrap_or_else(|e| e.into_inner());
        entries.retain(|entry| !entry.removable());
        entries.clone()
    }

    pub(crate) fn prepare(
        &self,
        app: &AppHandle,
        agent_id: &str,
        cwd: &Path,
    ) -> Result<TransientMcpOpen, String> {
        let notify_app = app.clone();
        let session = Arc::new(ToolSession {
            notify: Arc::new(move |task_key| {
                let _ = notify_app.emit_to(
                    EventTarget::webview("main"),
                    "browser-sharing:changed",
                    serde_json::json!({"taskKey":task_key}),
                );
            }),
            agent_id: agent_id.into(),
            cwd: cwd.to_string_lossy().into_owned(),
            native_session_id: OnceLock::new(),
            page: Arc::new(Mutex::new(None)),
            transport: OnceLock::new(),
            state: Mutex::new(ShareState {
                phase: CONNECTING,
                ready: false,
                ended: false,
                prompt_active: false,
                revision: 1,
                retiring: None,
                pending_request: None,
                active_screenshot: None,
            }),
            operation: tokio::sync::Mutex::new(()),
        });
        let ready_owner = Arc::downgrade(&session);
        let closed_owner = Arc::downgrade(&session);
        let closed_registry = Arc::downgrade(&self.0);
        let invalidated_owner = Arc::downgrade(&session);
        let permission_owner = Arc::downgrade(&session);
        let workspace = app.state::<BrowserWorkspace>().inner().clone();
        let (transport, launch) = transport::start(
            app.clone(),
            session.page.clone(),
            Arc::new(move || {
                if let Some(owner) = ready_owner.upgrade() {
                    owner.tool_ready();
                }
            }),
            Arc::new(move |confirmed| {
                if let Some(owner) = closed_owner.upgrade() {
                    owner.tool_closed(confirmed);
                }
                if let Some(registry) = closed_registry.upgrade() {
                    registry
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .retain(|entry| !entry.removable());
                }
            }),
            Arc::new(move |request: &crate::browser_workspace::ToolRequest| {
                let owner = permission_owner.upgrade().ok_or("当前对话已结束")?;
                let task = owner.task_key().ok_or("网页工具尚未准备完成")?;
                let page = workspace.permission_page(&task)?;
                let wait = owner.request_page_permission(page.clone(), request)?;
                // Close the metadata-snapshot -> pending-registration race.
                // Later changes see the registered request and invalidate it.
                let current = workspace.permission_page(&task)?;
                if current.label != page.label
                    || current.revision != page.revision
                    || current.url != page.url
                {
                    return Err("网页已变化，本次读取已取消".into());
                }
                Ok(wait)
            }),
            Arc::new(move |scope| {
                if let Some(owner) = invalidated_owner.upgrade() {
                    owner.invalidated(&scope);
                }
            }),
        )?;
        if session.transport.set(transport).is_err() {
            return Err("无法准备网页工具".into());
        }
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(session.clone());
        Ok(TransientMcpOpen::new(launch.into_server(), session))
    }

    fn entry(&self, target: &ShareTarget, task: &str) -> Result<Option<Arc<ToolSession>>, String> {
        if target.agent_id.is_empty()
            || target.native_session_id.is_empty()
            || !Path::new(&target.cwd).is_absolute()
            || task
                != format!(
                    "{}:{}:{}",
                    target.agent_id, target.cwd, target.native_session_id
                )
        {
            return Err("当前对话已变化，请重新打开网页".into());
        }
        let found: Vec<_> = self
            .entries()
            .into_iter()
            .filter(|entry| entry.matches(target))
            .collect();
        if found.len() > 1 {
            return Err("网页工具归属尚未确认，请重新连接对话".into());
        }
        Ok(found.into_iter().next())
    }

    fn info(&self, target: &ShareTarget, task: &str, label: &str) -> Result<ShareInfo, String> {
        Ok(match self.entry(target, task)? {
            Some(entry) => entry.info(task, label),
            None => ShareInfo {
                task_key: task.into(),
                label: label.into(),
                agent_id: target.agent_id.clone(),
                phase: "unavailable",
                revision: 0,
                reason: Some("tool_not_connected"),
                pending_request: None,
            },
        })
    }

    pub(crate) async fn stop_page(&self, task: &str, label: &str) -> Result<(), String> {
        for entry in self.entries() {
            entry.stop_page(task, label).await?;
        }
        Ok(())
    }

    pub(crate) fn page_changed(&self, info: &BrowserInfo) {
        for entry in self.entries() {
            entry.invalidate_pending_page(info);
            let invalid = {
                let state = entry.state.lock().unwrap_or_else(|e| e.into_inner());
                let page = entry.page.lock().unwrap_or_else(|e| e.into_inner());
                let changed = |scope: &FixedPageReadScope| {
                    scope.task_key() == info.task_key
                        && scope.label() == info.label
                        && !scope.grant_is_valid()
                };
                page.as_ref()
                    .filter(|scope| changed(scope))
                    .or_else(|| {
                        state
                            .active_screenshot
                            .as_ref()
                            .map(|active| &active.scope)
                            .filter(|scope| changed(scope))
                    })
                    .cloned()
            };
            if let Some(scope) = invalid {
                entry.invalidated(&scope);
            }
        }
    }

    pub(crate) fn shutdown(&self) {
        // Final application teardown is not a user-facing stop receipt.
        let entries = std::mem::take(&mut *self.0.lock().unwrap_or_else(|e| e.into_inner()));
        for entry in entries {
            entry.revoke();
        }
    }
}

fn require_main(webview: &Webview) -> Result<(), String> {
    if crate::browser_workspace::caller_allowed(webview) {
        Ok(())
    } else {
        Err("此页面不能操作应用".into())
    }
}

#[tauri::command]
pub(crate) fn browser_share_status(
    webview: Webview,
    app: AppHandle,
    state: State<'_, BrowserSharing>,
    task_key: String,
    label: String,
    target: ShareTarget,
) -> Result<ShareInfo, String> {
    require_main(&webview)?;
    let mut info = state.info(&target, &task_key, &label)?;
    if info.reason == Some("tool_not_connected")
        && let Some(reason) = app
            .state::<crate::acp_client::manager::AcpManager>()
            .browser_tool_unavailable(
                &target.agent_id,
                Path::new(&target.cwd),
                &target.native_session_id,
            )
    {
        info.reason = Some(reason.reason());
    }
    Ok(info)
}

#[tauri::command]
pub(crate) async fn browser_share_allow(
    webview: Webview,
    app: AppHandle,
    state: State<'_, BrowserSharing>,
    task_key: String,
    label: String,
    target: ShareTarget,
    expected_page_revision: u64,
) -> Result<ShareInfo, String> {
    require_main(&webview)?;
    let entry = state
        .entry(&target, &task_key)?
        .ok_or("当前对话尚未接通网页工具")?;
    let _operation = entry.operation.lock().await;
    {
        let state = entry.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.pending_request.is_some() {
            return Err("请在对话中确认本次网页读取".into());
        }
        if state.active_screenshot.is_some() {
            return Err("请先处理原网页读取请求".into());
        }
        if !state.ready || state.ended || state.phase != READY || state.retiring.is_some() {
            return Err("当前对话尚未接通网页工具，请稍后重试".into());
        }
    }
    let page = app.state::<BrowserWorkspace>().capture_read_scope(
        &task_key,
        &label,
        expected_page_revision,
        PageReadLease::new(),
    )?;
    {
        let mut state = entry.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut grant = entry.page.lock().unwrap_or_else(|e| e.into_inner());
        if state.ended
            || !state.ready
            || state.phase != READY
            || state.retiring.is_some()
            || state.pending_request.is_some()
            || state.active_screenshot.is_some()
            || !page.is_valid()
        {
            page.revoke();
            return Err("网页或对话已变化，请重新允许读取".into());
        }
        if grant.is_some() {
            page.revoke();
            return Err("请先停止当前网页共享，再重新允许读取".into());
        }
        *grant = Some(page);
        state.revision = state.revision.saturating_add(1);
    }
    entry.changed();
    Ok(entry.info(&task_key, &label))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn browser_share_respond(
    webview: Webview,
    app: AppHandle,
    state: State<'_, BrowserSharing>,
    task_key: String,
    label: String,
    target: ShareTarget,
    request_id: String,
    allow: bool,
) -> Result<ShareInfo, String> {
    require_main(&webview)?;
    let entry = state
        .entry(&target, &task_key)?
        .ok_or("当前对话尚未接通网页工具")?;
    let _operation = entry.operation.lock().await;
    entry.respond_permission(&task_key, &label, &request_id, allow, |pending| {
        app.state::<BrowserWorkspace>().capture_read_scope(
            &pending.task_key,
            &pending.label,
            pending.page_revision,
            PageReadLease::new(),
        )
    })?;
    Ok(entry.info(&task_key, &label))
}

#[tauri::command]
pub(crate) async fn browser_share_stop(
    webview: Webview,
    state: State<'_, BrowserSharing>,
    task_key: String,
    label: String,
    target: ShareTarget,
    expected_revision: u64,
) -> Result<ShareInfo, String> {
    require_main(&webview)?;
    if let Some(entry) = state.entry(&target, &task_key)? {
        entry
            .stop_explicit(&task_key, &label, expected_revision)
            .await?;
    }
    state.info(&target, &task_key, &label)
}

/// Called before normal application setup, single-instance hooks or user storage.
pub fn run_helper_if_requested() -> Option<i32> {
    helper::run_if_requested()
}
