//! Revocable admission for a normal unsent draft before it can launch an Agent.
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU8, Ordering},
    },
};
use tauri::{AppHandle, Manager as _, Webview, Window};
use tokio::sync::{Notify, OwnedMutexGuard};

use super::{history_admission::Owner, manager::AcpManager};

const WAITING: u8 = 0;
const ADMITTED: u8 = 1;
const WITHDRAWN: u8 = 2;
const SUPERSEDED: &str = "草稿设置已变化，本次未开始";
const UNAVAILABLE: &str = "无法确认草稿连接，本次未开始";

type Registrations = Mutex<HashMap<String, Weak<DraftWait>>>;

#[derive(Clone, Default)]
pub(super) struct DraftWaits(Arc<Registrations>);

pub(super) struct DraftWait {
    token: String,
    owner: Owner,
    registry: Weak<Registrations>,
    phase: AtomicU8,
    withdrawn: Notify,
}

impl DraftWaits {
    pub(super) fn register(&self, token: &str, owner: Owner) -> Result<Arc<DraftWait>, String> {
        let mut items = self.0.lock().map_err(|_| UNAVAILABLE)?;
        if items
            .get(token)
            .is_some_and(|item| item.strong_count() != 0)
        {
            return Err(UNAVAILABLE.into());
        }
        let wait = Arc::new(DraftWait {
            token: token.to_owned(),
            owner,
            registry: Arc::downgrade(&self.0),
            phase: AtomicU8::new(WAITING),
            withdrawn: Notify::new(),
        });
        items.insert(token.to_owned(), Arc::downgrade(&wait));
        Ok(wait)
    }

    pub(super) fn withdraw(&self, token: &str, caller: &Owner) -> Result<bool, String> {
        let wait = self
            .0
            .lock()
            .map_err(|_| UNAVAILABLE)?
            .get(token)
            .and_then(Weak::upgrade);
        let Some(wait) = wait.filter(|wait| wait.owner.same_window_token(caller)) else {
            return Ok(false);
        };
        if wait
            .phase
            .compare_exchange(WAITING, WITHDRAWN, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Ok(false);
        }
        // Retain a notification even if this request has not reached its wait.
        wait.withdrawn.notify_one();
        Ok(true)
    }
}

impl DraftWait {
    pub(super) async fn admit(
        &self,
        agent: &str,
        window_is_current: impl FnOnce(&Owner) -> bool,
    ) -> Result<OwnedMutexGuard<()>, String> {
        if !self.owner.belongs_to(agent) {
            return Err(UNAVAILABLE.into());
        }
        let guard = tokio::select! {
            biased;
            _ = self.withdrawn.notified() => return Err(SUPERSEDED.into()),
            guard = crate::install_job::configuration_guard(agent) => guard,
        };
        if !window_is_current(&self.owner) {
            return Err(UNAVAILABLE.into());
        }
        self.phase
            .compare_exchange(WAITING, ADMITTED, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| SUPERSEDED)?;
        Ok(guard)
    }
}

impl Drop for DraftWait {
    fn drop(&mut self) {
        if let Some(registry) = self.registry.upgrade()
            && let Ok(mut items) = registry.lock()
            && items
                .get(&self.token)
                .is_some_and(|item| std::ptr::eq(item.as_ptr(), self))
        {
            items.remove(&self.token);
        }
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftWaitReceipt {
    pub(super) open_token: String,
}

#[tauri::command]
pub fn session_cancel_waiting_draft(
    app: AppHandle,
    webview: Webview,
    window: Window,
    open_token: String,
) -> Result<bool, String> {
    if !crate::browser_workspace::caller_allowed(&webview) {
        return Err("请从主界面操作".into());
    }
    let manager = app.state::<AcpManager>();
    let caller = manager
        .history_admission
        .owner(&window, &open_token, "")
        .map_err(super::cold_history_open::error)?;
    manager.draft_waits.withdraw(&open_token, &caller)
}
