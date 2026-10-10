//! In-memory, fixed-page observation authority. No tool receives UI command access.
use super::{BrowserWorkspace, PageSnapshot, ReadTicket, native};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

#[cfg(test)]
#[path = "page_read_tests.rs"]
mod tests;

const STOPPED: &str = "网页共享已停止，请重新允许读取";

#[derive(Clone, Default)]
pub(crate) struct PageReadLease(Arc<Mutex<bool>>);

impl PageReadLease {
    /// This is only a local read gate, not proof of an Agent or task's identity.
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Linearizes with observation start and each guarded, nonblocking write.
    /// This ACK does not recall bytes already written or finish a transport frame.
    pub(crate) fn revoke(&self) {
        *self.0.lock().unwrap_or_else(|error| error.into_inner()) = true;
    }

    fn with_live<T>(&self, action: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let lease = self.0.lock().map_err(|_| STOPPED)?;
        if *lease {
            return Err(STOPPED.into());
        }
        // Hold the gate through action: check-then-act would allow a queued read
        // or final output to begin after revoke returned.
        let result = action();
        drop(lease);
        result
    }
}

#[derive(Clone)]
pub(crate) struct FixedPageReadScope {
    workspace: BrowserWorkspace,
    ticket: ReadTicket,
    // Only the private manual constructor omits a lease.
    lease: Option<PageReadLease>,
    expected_url: Option<String>,
    pub(super) observation: Arc<Mutex<Option<super::browser_tools::Observation>>>,
    action_lease: Option<PageReadLease>,
}

impl BrowserWorkspace {
    /// The caller must already own an explicit user grant for this task/page.
    /// Tool arguments must never be used to create or replace this scope.
    pub(crate) fn capture_read_scope(
        &self,
        task: &str,
        label: &str,
        expected_revision: u64,
        lease: PageReadLease,
    ) -> Result<FixedPageReadScope, String> {
        let (ticket, expected_url) = {
            let store = self.0.lock().map_err(|_| "网页状态暂时不可用")?;
            let active = store
                .active
                .as_ref()
                .filter(|active| {
                    !store.shutting_down
                        && active.info.task_key == task
                        && active.info.label == label
                        && active.info.revision == expected_revision
                        && active.info.phase == "ready"
                        && active.shareable()
                        && !active.closing
                })
                .ok_or("网页已变化，请重新确认要分享的页面")?;
            (
                ReadTicket {
                    id: active.id,
                    task_key: active.info.task_key.clone(),
                    label: active.info.label.clone(),
                    navigation: active.navigation,
                },
                active.info.url.clone(),
            )
        };
        let scope = FixedPageReadScope {
            workspace: self.clone(),
            ticket,
            lease: Some(lease),
            expected_url: Some(expected_url),
            observation: Arc::new(Mutex::new(None)),
            action_lease: None,
        };
        scope.with_valid(|| Ok(()))?;
        Ok(scope)
    }

    pub(super) fn manual_read_scope(
        &self,
        task: &str,
        label: &str,
    ) -> Result<FixedPageReadScope, String> {
        Ok(FixedPageReadScope {
            workspace: self.clone(),
            ticket: self.read_ticket(task, label)?,
            lease: None,
            expected_url: None,
            observation: Arc::new(Mutex::new(None)),
            action_lease: None,
        })
    }
}

impl FixedPageReadScope {
    /// Only a fast, nonblocking action is allowed. Never await, poll a transport,
    /// or reenter BrowserWorkspace/this lease while holding this gate.
    /// The broker must gate EVERY nonblocking output write, not just this read.
    pub(crate) fn with_valid<T>(
        &self,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.with_lease(|| self.workspace.with_read_ticket(&self.ticket, |_| action()))
    }

    fn with_lease<T>(&self, action: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let with_action = || match &self.action_lease {
            Some(lease) => lease.with_live(action),
            None => action(),
        };
        match &self.lease {
            Some(lease) => lease.with_live(with_action),
            None => with_action(),
        }
    }

    // Called inside the actual main-thread closure, immediately around ff_browser_read.
    pub(super) fn observe<T>(
        &self,
        start: impl FnOnce(u64, Option<&str>) -> Result<T, String>,
    ) -> Result<T, String> {
        self.with_valid(|| start(self.ticket.id, self.expected_url.as_deref()))
    }

    pub(crate) fn task_key(&self) -> &str {
        &self.ticket.task_key
    }

    pub(crate) fn label(&self) -> &str {
        &self.ticket.label
    }

    pub(super) fn native_id(&self) -> u64 {
        self.ticket.id
    }

    pub(super) fn navigation(&self) -> u64 {
        self.ticket.navigation
    }

    pub(super) fn matches_url(&self, url: &str) -> bool {
        self.expected_url
            .as_ref()
            .is_some_and(|expected| expected == url)
    }

    /// An approved operation inherits page withdrawal and also owns a separate
    /// one-shot gate. Cancelling it must not withdraw the general read grant.
    pub(crate) fn one_shot(&self) -> Result<Self, String> {
        self.with_valid(|| Ok(()))?;
        let mut scope = self.clone();
        scope.action_lease = Some(PageReadLease::new());
        Ok(scope)
    }

    /// Every request, including a read, gets a separate delivery/dispatch gate.
    /// Preserve an already-issued one-shot control decision instead of replacing it.
    pub(crate) fn request_scope(&self) -> Self {
        let mut scope = self.clone();
        if scope.action_lease.is_none() {
            scope.action_lease = Some(PageReadLease::new());
        }
        scope
    }

    pub(crate) fn grant_is_valid(&self) -> bool {
        let action = || self.workspace.with_read_ticket(&self.ticket, |_| Ok(()));
        match &self.lease {
            Some(lease) => lease.with_live(action),
            None => action(),
        }
        .is_ok()
    }

    pub(crate) fn cancel_action(&self) {
        if let Some(lease) = &self.action_lease {
            lease.revoke();
        }
    }

    pub(crate) fn same_grant(&self, other: &Self) -> bool {
        self.ticket == other.ticket
            && self.expected_url == other.expected_url
            && matches!((&self.lease, &other.lease), (Some(left), Some(right))
                if Arc::ptr_eq(&left.0, &right.0))
    }

    pub(crate) fn revoke(&self) {
        if let Some(lease) = &self.lease {
            lease.revoke();
        }
    }

    pub(crate) fn is_valid(&self) -> bool {
        self.with_valid(|| Ok(())).is_ok()
    }

    fn complete(&self, raw: &str) -> Result<PageSnapshot, String> {
        // A detected login input must not become readable again under the same
        // grant merely because a later DOM update removes that input. Revoke
        // before proceeding to any output or another observation.
        if raw.len() <= 300_000
            && let Ok(page) = serde_json::from_str::<super::NativeSnapshot>(raw)
        {
            if page.blocked {
                self.revoke();
                return Err("页面含登录输入，已停止读取；请关闭并改用公开网页".into());
            }
            if self
                .expected_url
                .as_ref()
                .is_some_and(|expected| page.url != *expected)
            {
                self.revoke();
                return Err("网页已变化，请重新确认要分享的页面".into());
            }
        }
        self.with_lease(|| self.workspace.complete_read(&self.ticket, raw))
    }

    pub(crate) async fn read(&self, app: &AppHandle) -> Result<PageSnapshot, String> {
        self.with_valid(|| Ok(()))?;
        let raw = native::read(app, self.clone()).await?;
        self.complete(&raw)
    }
}
