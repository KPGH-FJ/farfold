//! One volatile user decision for one already-issued MCP call. No page read,
//! Agent request, persisted approval or retargeting is performed here.
use super::{READY, ShareState, ToolSession};
use crate::browser_workspace::{BrowserInfo, ControlReview, FixedPageReadScope};
use serde::Serialize;
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

const PERMISSION_WAIT: Duration = Duration::from_secs(120);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingRequestInfo {
    pub request_id: String,
    pub task_key: String,
    pub label: String,
    pub url: String,
    pub page_revision: u64,
    pub phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub control: Option<ControlReview>,
}

pub(super) struct PendingPermission {
    pub info: PendingRequestInfo,
    deadline: Instant,
    reply: mpsc::Sender<Result<FixedPageReadScope, String>>,
    retirement: super::screenshot_owner::Receipt,
    owner: std::sync::Weak<ToolSession>,
}

pub(super) struct PermissionWait {
    result: mpsc::Receiver<Result<FixedPageReadScope, String>>,
    deadline: Instant,
    finish: Box<dyn Fn() + Send>,
    retirement: super::screenshot_owner::Receipt,
}
impl PermissionWait {
    pub(super) fn take_retirement(&self) -> Option<super::screenshot_owner::ScreenshotRetirement> {
        self.retirement
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
    }
    pub(super) fn poll(&self) -> Option<Result<FixedPageReadScope, String>> {
        // Check the deadline before consuming even a queued approval.
        if Instant::now() >= self.deadline {
            return Some(Err("等待网页读取确认已超时".into()));
        }
        match self.result.try_recv() {
            Ok(value) => Some(value),
            Err(mpsc::TryRecvError::Disconnected) => Some(Err("网页读取请求已结束".into())),
            Err(mpsc::TryRecvError::Empty) => None,
        }
    }
}
impl Drop for PermissionWait {
    fn drop(&mut self) {
        // Still in this wait means no native execution was admitted. Once the
        // worker takes it, that worker owns retirement through delivery ACK.
        if let Some(mut retirement) = self.take_retirement() {
            retirement.confirm();
        }
        (self.finish)();
    }
}

impl ShareState {
    pub(super) fn cancel_permission(&mut self, reason: &str) -> bool {
        if let Some(pending) = self.pending_request.take() {
            let _ = pending.reply.send(Err(reason.into()));
            self.revision = self.revision.saturating_add(1);
            true
        } else {
            false
        }
    }
}

impl ToolSession {
    #[cfg(test)]
    pub(super) fn request_permission(
        self: &Arc<Self>,
        page: BrowserInfo,
    ) -> Result<PermissionWait, String> {
        self.request_tool_permission(page, None)
    }

    pub(super) fn request_page_permission(
        self: &Arc<Self>,
        page: BrowserInfo,
        request: &crate::browser_workspace::ToolRequest,
    ) -> Result<PermissionWait, String> {
        let review = if request.requires_request_consent() {
            let grant = self.page.lock().map_err(|_| "网页状态暂时不可用")?;
            Some(match grant.as_ref() {
                Some(grant) => grant.review_control(request)?,
                None if !request.control() => ControlReview::screenshot(),
                None => return Err("请先允许读取当前网页".into()),
            })
        } else {
            None
        };
        self.request_tool_permission(page, review)
    }

    pub(super) fn request_tool_permission(
        self: &Arc<Self>,
        page: BrowserInfo,
        control: Option<ControlReview>,
    ) -> Result<PermissionWait, String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if self.task_key().as_deref() != Some(page.task_key.as_str())
            || page.phase != "ready"
            || state.ended
            || !state.prompt_active
            || !state.ready
            || state.phase != READY
            || state.retiring.is_some()
        {
            return Err("当前网页或对话不可读取".into());
        }
        if state.pending_request.is_some() || state.active_screenshot.is_some() {
            return Err("请先处理原网页读取请求".into());
        }
        // Fresh per-request nonce, never a credential or a page authority.
        let mut bytes = [0u8; 16];
        if getrandom::fill(&mut bytes).is_err() {
            return Err("无法准备网页读取确认".into());
        }
        let request_id: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        let deadline = Instant::now()
            + if control.is_some() {
                Duration::from_secs(30)
            } else {
                PERMISSION_WAIT
            };
        let (reply, result) = mpsc::channel();
        let retirement = Arc::new(std::sync::Mutex::new(None));
        state.pending_request = Some(PendingPermission {
            info: PendingRequestInfo {
                request_id: request_id.clone(),
                task_key: page.task_key,
                label: page.label,
                url: page.url,
                page_revision: page.revision,
                phase: "awaiting_permission",
                control,
            },
            deadline,
            reply,
            retirement: retirement.clone(),
            owner: Arc::downgrade(self),
        });
        state.revision = state.revision.saturating_add(1);
        drop(state);
        self.changed();
        let owner = Arc::downgrade(self);
        Ok(PermissionWait {
            result,
            deadline,
            retirement,
            finish: Box::new(move || {
                if let Some(owner) = owner.upgrade() {
                    let mut state = owner.state.lock().unwrap_or_else(|e| e.into_inner());
                    if state
                        .pending_request
                        .as_ref()
                        .is_some_and(|p| p.info.request_id == request_id)
                    {
                        state.cancel_permission("网页读取请求已结束");
                        drop(state);
                        owner.changed();
                    }
                }
            }),
        })
    }

    pub(super) fn respond_permission(
        &self,
        task: &str,
        label: &str,
        request_id: &str,
        allow: bool,
        capture: impl FnOnce(&PendingRequestInfo) -> Result<FixedPageReadScope, String>,
    ) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let pending = state
            .pending_request
            .as_ref()
            .filter(|p| {
                p.info.request_id == request_id && p.info.task_key == task && p.info.label == label
            })
            .ok_or("此网页读取请求已结束，请查看当前对话")?;
        if state.ended
            || !state.ready
            || state.phase != READY
            || state.retiring.is_some()
            || Instant::now() >= pending.deadline
        {
            state.cancel_permission("网页读取请求已结束");
            drop(state);
            self.changed();
            return Err("此网页读取请求已结束，请查看当前对话".into());
        }
        // This describes the permission's lifetime, not whether a mutating
        // browser action was dispatched. Screenshots are still read-only.
        let one_shot = pending.info.control.is_some();
        let screenshot = pending
            .info
            .control
            .as_ref()
            .is_some_and(|review| review.kind == "screenshot");
        let result = if allow && one_shot {
            let grant = self.page.lock().map_err(|_| "网页状态暂时不可用")?.clone();
            match grant {
                Some(scope) if scope.task_key() == task && scope.label() == label => {
                    scope.one_shot()
                }
                Some(_) => Err("网页或对话已变化，请重新确认".into()),
                // A first screenshot captures only this confirmed request's
                // scope. It never creates a standing text/read permission.
                None if screenshot => capture(&pending.info).and_then(|scope| scope.one_shot()),
                None => Err("请先允许读取当前网页".into()),
            }
        } else if allow {
            capture(&pending.info)
        } else {
            Err("用户取消了本次网页读取".into())
        };
        let pending = state
            .pending_request
            .take()
            .expect("checked pending permission");
        let mut grant = self.page.lock().unwrap_or_else(|e| e.into_inner());
        let result = result.and_then(|scope| {
            if (!one_shot && grant.is_some())
                || !scope.is_valid()
                || scope.task_key() != task
                || scope.label() != label
            {
                if one_shot {
                    scope.cancel_action();
                } else {
                    scope.revoke();
                }
                Err("网页或对话已变化，请重新确认".into())
            } else {
                if !one_shot {
                    *grant = Some(scope.clone());
                }
                Ok(scope)
            }
        });
        let failure = result.as_ref().err().cloned();
        if screenshot && let Ok(scope) = &result {
            *pending
                .retirement
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = Some(state.approve_screenshot(
                pending.owner.clone(),
                pending.info.request_id.clone(),
                scope,
            ));
        }
        if let Err(undelivered) = pending.reply.send(result) {
            if let Some(retirement) = pending
                .retirement
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .as_mut()
            {
                retirement.confirm();
            }
            if let Ok(scope) = undelivered.0 {
                if one_shot {
                    scope.cancel_action();
                } else {
                    scope.revoke();
                }
                if !one_shot
                    && grant
                        .as_ref()
                        .is_some_and(|current| current.same_grant(&scope))
                {
                    *grant = None;
                }
            }
            state.revision = state.revision.saturating_add(1);
            drop(grant);
            drop(state);
            self.changed();
            return Err("此网页读取请求已结束，请查看当前对话".into());
        }
        state.revision = state.revision.saturating_add(1);
        drop(grant);
        drop(state);
        self.changed();
        if allow && let Some(error) = failure {
            return Err(error);
        }
        Ok(())
    }

    pub(super) fn invalidate_pending_page(&self, info: &BrowserInfo) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.pending_request.as_ref().is_some_and(|p| {
            p.info.task_key == info.task_key
                && p.info.label == info.label
                && (p.info.page_revision != info.revision
                    || p.info.url != info.url
                    || info.phase != "ready")
        }) && state.cancel_permission("网页已变化，本次读取已取消")
        {
            drop(state);
            self.changed();
        }
    }
}

#[cfg(test)]
#[path = "permission_tests.rs"]
mod tests;
