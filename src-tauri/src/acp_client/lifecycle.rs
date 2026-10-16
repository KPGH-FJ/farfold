//! In-memory ownership of one connection. No Agent execution or persisted ledger.
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::watch;

#[cfg(test)]
#[path = "lifecycle/retention_tests.rs"]
mod retention_tests;

pub(crate) const CONNECTING: u8 = 0;
pub(crate) const READY: u8 = 1;
pub(crate) const CLOSED: u8 = 2;
pub(crate) const FAILED: u8 = 3;
pub(crate) const CLOSING: u8 = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CloseReason {
    Idle,
    User,
    Shutdown,
    Configuration,
    StartupFailed,
    Unexpected,
}

/// Transient opening reservations; shared holders release one key only when
/// its last real owner ends. Nothing here is written to the conversation index.
#[derive(Clone, Default)]
pub(crate) struct OpenReservations(Arc<Mutex<HashMap<OpenKey, Weak<ReservedOpen>>>>);
type OpenKey = (String, PathBuf, Option<String>);
pub(crate) struct OpenReservation(Arc<ReservedOpen>);
impl Clone for OpenReservation {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}
struct ReservedOpen {
    owner: OpenReservations,
    key: OpenKey,
    exclusive_native: AtomicBool,
}
impl OpenReservations {
    pub fn reserve(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
    ) -> Result<OpenReservation, String> {
        self.reserve_open(agent_id, cwd, Some(session_id))
    }
    pub fn reserve_open(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: Option<&str>,
    ) -> Result<OpenReservation, String> {
        let (reservation, exclusive) = self.claim(agent_id, cwd, session_id)?;
        if !exclusive {
            return Err("此对话上次打开尚未结束，请等待结果后重试".into());
        }
        Ok(reservation)
    }
    /// A confirmed remote creation may collide with an opening already in
    /// progress. Keep a holder even in that case so one process cannot release
    /// the other process's unresolved native identity.
    pub fn claim(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: Option<&str>,
    ) -> Result<(OpenReservation, bool), String> {
        self.claim_with_scope(agent_id, cwd, session_id, false)
    }
    /// A newly returned fork ID must exclude known pending opens across
    /// projects, and keep that same exclusion throughout its handoff.
    pub(crate) fn claim_fork(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
    ) -> Result<(OpenReservation, bool), String> {
        self.claim_with_scope(agent_id, cwd, Some(session_id), true)
    }
    fn claim_with_scope(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: Option<&str>,
        exclusive_native: bool,
    ) -> Result<(OpenReservation, bool), String> {
        let key = (
            agent_id.to_owned(),
            cwd.to_path_buf(),
            session_id.map(str::to_owned),
        );
        // Keep upgraded owners until after the map guard drops. The last Arc's
        // destructor itself removes its key under this same mutex.
        let mut live = Vec::new();
        let mut entries = self.0.lock().map_err(|_| "无法读取对话打开状态")?;
        live.extend(entries.values().filter_map(Weak::upgrade));
        if let Some(entry) = live.iter().find(|entry| {
            entry.key == key
                || (session_id.is_some()
                    && entry.key.0 == agent_id
                    && entry.key.2.as_deref() == session_id
                    && (exclusive_native || entry.exclusive_native.load(Ordering::SeqCst)))
        }) {
            if exclusive_native {
                entry.exclusive_native.store(true, Ordering::SeqCst);
            }
            return Ok((OpenReservation(entry.clone()), false));
        }
        let entry = Arc::new(ReservedOpen {
            owner: self.clone(),
            key: key.clone(),
            exclusive_native: AtomicBool::new(exclusive_native),
        });
        entries.insert(key, Arc::downgrade(&entry));
        Ok((OpenReservation(entry), true))
    }
}
impl Drop for ReservedOpen {
    fn drop(&mut self) {
        if let Ok(mut entries) = self.owner.0.lock() {
            // A new holder may have replaced the expired weak entry while this
            // destructor waited for the lock. Never remove its reservation.
            if entries
                .get(&self.key)
                .is_some_and(|entry| std::ptr::eq(entry.as_ptr(), self))
            {
                entries.remove(&self.key);
            }
        }
    }
}

/// Native identity ownership follows delivery, not just route registration.
/// Failed or undelivered opens transfer the lease to confirmed process reaping.
pub(crate) struct OpenIdentity {
    life: Arc<ConnectionLife>,
    opening: Option<OpenReservation>,
}
impl OpenIdentity {
    pub fn new(life: Arc<ConnectionLife>, opening: Option<OpenReservation>) -> Self {
        Self { life, opening }
    }
    pub fn replace(&mut self, opening: OpenReservation) {
        self.opening = Some(opening);
    }
    pub fn delivered(&mut self) {
        self.opening.take();
    }
}
impl Drop for OpenIdentity {
    fn drop(&mut self) {
        if let Some(opening) = self.opening.take() {
            self.life.retain_opening(opening);
        }
    }
}

struct Activity {
    last: Instant,
    operations: HashSet<String>,
    views: HashSet<(String, String)>,
    sessions: usize,
    close_reason: Option<CloseReason>,
    closing_opens: Vec<OpenReservation>,
    closing_admissions: Vec<crate::managed_update::ActivityPermit>,
    starting_admission: Option<crate::managed_update::ActivityPermit>,
    detached_work: u64,
}
pub(crate) struct ConnectionLife {
    pub state: Arc<AtomicU8>,
    pub work: Arc<AtomicU64>,
    activity: Mutex<Activity>,
    stop: watch::Sender<bool>,
    done: watch::Sender<Option<Result<(), String>>>,
}
impl ConnectionLife {
    pub fn retain_opening(&self, opening: OpenReservation) {
        if let Ok(mut activity) = self.activity.lock()
            && !matches!(self.state.load(Ordering::SeqCst), CLOSED | FAILED)
        {
            activity.closing_opens.push(opening);
        }
    }
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Arc::new(AtomicU8::new(CONNECTING)),
            work: Arc::new(AtomicU64::new(0)),
            activity: Mutex::new(Activity {
                last: Instant::now(),
                operations: HashSet::new(),
                views: HashSet::new(),
                sessions: 0,
                close_reason: None,
                closing_opens: Vec::new(),
                closing_admissions: Vec::new(),
                starting_admission: None,
                detached_work: 0,
            }),
            stop: watch::channel(false).0,
            done: watch::channel(None).0,
        })
    }
    pub fn stop_receiver(&self) -> watch::Receiver<bool> {
        self.stop.subscribe()
    }
    pub fn touch(&self) {
        if let Ok(mut state) = self.activity.lock() {
            state.last = Instant::now();
        }
    }
    /// A view holds this exact process without starting work or extending a timer.
    pub fn hold_view(&self, window: &str, owner: &str, retain: bool) -> Result<bool, String> {
        if owner.is_empty() || owner.len() > 128 {
            return Err("无法识别当前页面，请重新打开".into());
        }
        let mut activity = self.activity.lock().map_err(|_| "无法读取连接状态")?;
        let key = (window.to_owned(), owner.to_owned());
        if retain {
            if self.state.load(Ordering::SeqCst) != READY {
                return Ok(false);
            }
            activity.views.insert(key);
        } else if activity.views.remove(&key) {
            activity.last = Instant::now();
        }
        Ok(true)
    }
    pub fn release_views(&self, window: &str) -> Result<(), String> {
        let mut activity = self.activity.lock().map_err(|_| "无法读取连接状态")?;
        let before = activity.views.len();
        activity
            .views
            .retain(|(owner_window, _)| owner_window != window);
        if activity.views.len() != before {
            activity.last = Instant::now();
        }
        Ok(())
    }
    /// Recovery capability alone cannot prove this conversation is safe to evict.
    /// An open which fails after the Agent created its conversation keeps this
    /// retention until process termination; only a registered route can release it.
    pub fn session(self: &Arc<Self>) -> Result<SessionRetention, String> {
        let mut activity = self.activity.lock().map_err(|_| "无法读取连接状态")?;
        if self.state.load(Ordering::SeqCst) != READY {
            return Err("连接正在关闭，请稍后重试".into());
        }
        activity.sessions += 1;
        activity.last = Instant::now();
        Ok(SessionRetention {
            life: self.clone(),
            registered: false,
        })
    }
    pub fn close_reason(&self) -> Option<CloseReason> {
        self.activity
            .lock()
            .ok()
            .and_then(|activity| activity.close_reason)
    }
    pub fn ready(&self) -> Result<(), String> {
        let mut guard = self.activity.lock().map_err(|_| "无法读取连接状态")?;
        self.state
            .compare_exchange(CONNECTING, READY, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| {
                guard.starting_admission.take();
            })
            .map_err(|_| "连接已结束，请重试".into())
    }
    pub fn work(self: &Arc<Self>) -> Result<WorkLease, String> {
        let admission = crate::managed_update::activity()?;
        let mut state = self.activity.lock().map_err(|_| "无法读取连接状态")?;
        if self.state.load(Ordering::SeqCst) != READY {
            return Err("连接正在关闭，请稍后重试".into());
        }
        if state.operations.contains("account_change") {
            return Err("此 Agent 正在处理账号设置，请等待结果后再发送".into());
        }
        state.last = Instant::now();
        self.work.fetch_add(1, Ordering::SeqCst);
        Ok(WorkLease {
            life: self.clone(),
            admission: Some(admission),
            retained: false,
        })
    }
    pub(crate) fn retain_startup(
        &self,
        admission: crate::managed_update::ActivityPermit,
    ) -> Result<(), String> {
        self.activity
            .lock()
            .map_err(|_| "无法读取连接状态")?
            .starting_admission = Some(admission);
        Ok(())
    }
    pub fn operation(self: &Arc<Self>, key: String) -> Result<OperationLease, String> {
        let admission = crate::managed_update::activity()?;
        let mut state = self.activity.lock().map_err(|_| "无法读取连接状态")?;
        if self.state.load(Ordering::SeqCst) != READY {
            return Err("连接正在关闭，请稍后重试".into());
        }
        if (key == "account_change"
            && (self.work.load(Ordering::SeqCst) != 0
                || !state.operations.is_empty()
                || !state.closing_opens.is_empty()))
            || (key != "authentication" && state.operations.contains("account_change"))
        {
            return Err("请先完成此 Agent 的任务、待处理事项及账号操作".into());
        }
        if !state.operations.insert(key.clone()) {
            return Err("上次操作尚未结束，请等待或断开后重试".into());
        }
        state.last = Instant::now();
        Ok(OperationLease {
            life: self.clone(),
            key,
            opening: None,
            admission: Some(admission),
        })
    }
    /// Check and mark under the same lock used by admission; never remove a stale key.
    pub fn close(&self, force: bool, idle: Option<Duration>) -> Result<bool, String> {
        self.close_for(
            force,
            idle,
            if idle.is_some() {
                CloseReason::Idle
            } else {
                CloseReason::User
            },
        )
    }
    pub fn close_for(
        &self,
        force: bool,
        idle: Option<Duration>,
        reason: CloseReason,
    ) -> Result<bool, String> {
        let mut state = self.activity.lock().map_err(|_| "无法读取连接状态")?;
        if self.state.load(Ordering::SeqCst) >= CLOSED {
            return Ok(false);
        }
        if !force && self.work.load(Ordering::SeqCst) != 0 {
            return if idle.is_some() {
                Ok(false)
            } else {
                Err("此 Agent 仍有进行中的任务或待处理事项，请先完成后再执行此操作".into())
            };
        }
        if let Some(idle) = idle
            && (!state.operations.is_empty()
                || !state.views.is_empty()
                || state.sessions != 0
                || state.last.elapsed() < idle
                || self.state.load(Ordering::SeqCst) != READY)
        {
            return Ok(false);
        }
        state.close_reason = Some(reason);
        self.state.store(CLOSING, Ordering::SeqCst);
        self.stop.send_replace(true);
        Ok(true)
    }
    /// Configuration changes (program selection, install, access removal, app
    /// data clearing) end the process without a separate user step. Safe idle
    /// connections are released automatically; work, account/auth operations
    /// or opens whose remote result was never confirmed still block honestly.
    /// Retained views and registered conversations do not: their records are
    /// persisted already and reopen on the next launch target.
    pub(crate) fn release_for_configuration(&self) -> Result<bool, String> {
        let mut activity = self.activity.lock().map_err(|_| "无法读取连接状态")?;
        if self.state.load(Ordering::SeqCst) >= CLOSED {
            return Ok(false);
        }
        if self.work.load(Ordering::SeqCst) != 0
            || !activity.operations.is_empty()
            || !activity.closing_opens.is_empty()
        {
            return Err(
                "此 Agent 仍有进行中的任务、待处理事项或未确认的操作，请先完成后再执行此操作"
                    .into(),
            );
        }
        activity.close_reason = Some(CloseReason::Configuration);
        activity.last = Instant::now();
        self.state.store(CLOSING, Ordering::SeqCst);
        self.stop.send_replace(true);
        Ok(true)
    }
    pub fn finish(&self, outcome: Result<(), String>) {
        // The process owner calls this only after actual reap. Release any open
        // operation abandoned during shutdown at the same completion boundary.
        let closing_opens = if let Ok(mut activity) = self.activity.lock() {
            self.state.store(
                if outcome.is_ok() { CLOSED } else { FAILED },
                Ordering::SeqCst,
            );
            activity.starting_admission.take();
            activity.closing_admissions.clear();
            self.work.fetch_sub(
                std::mem::take(&mut activity.detached_work),
                Ordering::SeqCst,
            );
            std::mem::take(&mut activity.closing_opens)
        } else {
            Vec::new()
        };
        drop(closing_opens);
        self.done.send_replace(Some(outcome));
    }
    /// The process owner already confirmed this connection's termination
    /// outcome, so nothing is in flight and no wait is needed.
    pub(crate) fn finished(&self) -> bool {
        self.done.borrow().is_some()
    }
    pub async fn closed(&self) -> Result<(), String> {
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut done = self.done.subscribe();
            loop {
                if let Some(result) = done.borrow().clone() {
                    return result;
                }
                done.changed()
                    .await
                    .map_err(|_| "无法确认连接已关闭".to_string())?;
            }
        })
        .await
        .map_err(|_| "连接进程尚未确认结束，请稍后重试".to_string())?
    }
    /// Account mutations must not release shared credentials while a closing
    /// process could still finish them. This waits for the exact process owner.
    pub async fn terminated(&self) {
        let mut done = self.done.subscribe();
        while done.borrow().is_none() {
            if done.changed().await.is_err() {
                break;
            }
        }
    }
}
pub(crate) struct SessionRetention {
    life: Arc<ConnectionLife>,
    registered: bool,
}
impl SessionRetention {
    pub fn registered(mut self) -> Self {
        self.registered = true;
        self
    }
    pub fn retain_until_terminated(mut self) {
        // Dropping a local route does not confirm remote close or recoverability.
        self.registered = false;
    }
}
impl Drop for SessionRetention {
    fn drop(&mut self) {
        if self.registered
            && let Ok(mut activity) = self.life.activity.lock()
        {
            activity.sessions -= 1;
            activity.last = Instant::now();
        }
    }
}
pub(crate) struct WorkLease {
    life: Arc<ConnectionLife>,
    admission: Option<crate::managed_update::ActivityPermit>,
    retained: bool,
}
impl WorkLease {
    pub fn belongs_to(&self, life: &Arc<ConnectionLife>) -> bool {
        Arc::ptr_eq(&self.life, life)
    }
    /// An observer ending cannot prove the external work ended. Transfer its
    /// existing admission to the process owner without keeping an Arc cycle.
    pub(crate) fn retain_until_terminated(mut self) {
        if let Ok(mut state) = self.life.activity.lock()
            && !matches!(self.life.state.load(Ordering::SeqCst), CLOSED | FAILED)
        {
            state.detached_work += 1;
            if let Some(admission) = self.admission.take() {
                state.closing_admissions.push(admission);
            }
            self.retained = true;
        }
    }
}
impl Drop for WorkLease {
    fn drop(&mut self) {
        if self.retained {
            return;
        }
        if let Ok(mut state) = self.life.activity.lock() {
            self.life.work.fetch_sub(1, Ordering::SeqCst);
            state.last = Instant::now();
            if self.life.state.load(Ordering::SeqCst) == CLOSING
                && let Some(admission) = self.admission.take()
            {
                state.closing_admissions.push(admission);
            }
        }
    }
}
pub(crate) struct OperationLease {
    life: Arc<ConnectionLife>,
    key: String,
    opening: Option<OpenReservation>,
    admission: Option<crate::managed_update::ActivityPermit>,
}
impl OperationLease {
    pub fn opening(&self) -> Option<OpenReservation> {
        self.opening.clone()
    }
    pub fn with_opening(mut self, opening: Option<OpenReservation>) -> Self {
        self.opening = opening;
        self
    }
}
impl Drop for OperationLease {
    fn drop(&mut self) {
        if let Ok(mut state) = self.life.activity.lock() {
            state.operations.remove(&self.key);
            state.last = Instant::now();
            if self.life.state.load(Ordering::SeqCst) == CLOSING
                && let Some(admission) = self.admission.take()
            {
                state.closing_admissions.push(admission);
            }
            if self.life.state.load(Ordering::SeqCst) == CLOSING
                && let Some(opening) = self.opening.take()
            {
                state.closing_opens.push(opening);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tool_observer_exit_retains_work_and_update_until_process_completion() {
        let gate = crate::managed_update::UpdateAdmission::default();
        let life = ConnectionLife::new();
        life.ready().unwrap();
        let mut work = life.work().unwrap();
        work.admission = Some(gate.activity().unwrap());
        work.retain_until_terminated();
        assert_eq!(life.work.load(Ordering::SeqCst), 1);
        assert!(gate.update().is_err());
        assert!(life.close(false, None).is_err());
        life.close(true, None).unwrap();
        assert!(gate.update().is_err());
        life.finish(Ok(()));
        assert_eq!(life.work.load(Ordering::SeqCst), 0);
        assert!(gate.update().is_ok());
    }
    #[test]
    fn update_admission_waits_for_startup_or_real_closing_completion() {
        let gate = crate::managed_update::UpdateAdmission::default();
        let life = ConnectionLife::new();
        life.retain_startup(gate.activity().unwrap()).unwrap();
        assert!(gate.update().is_err());
        life.ready().unwrap();
        assert!(gate.update().is_ok());
        let mut operation = life.operation("fixture".into()).unwrap();
        operation.admission = Some(gate.activity().unwrap());
        life.close(true, None).unwrap();
        drop(operation);
        assert!(gate.update().is_err());
        life.finish(Ok(()));
        assert!(gate.update().is_ok());
    }

    #[test]
    fn terminating_work_retains_update_protection_until_child_reap() {
        let gate = crate::managed_update::UpdateAdmission::default();
        let life = ConnectionLife::new();
        life.ready().unwrap();
        let mut work = life.work().unwrap();
        work.admission = Some(gate.activity().unwrap());
        life.close(true, None).unwrap();
        drop(work);
        assert!(gate.update().is_err());
        life.finish(Ok(()));
        assert!(gate.update().is_ok());
    }
    #[test]
    fn account_change_and_work_are_mutually_exclusive() {
        let life = ConnectionLife::new();
        life.ready().unwrap();
        let work = life.work().unwrap();
        assert!(life.operation("account_change".into()).is_err());
        drop(work);
        let account = life.operation("account_change".into()).unwrap();
        assert!(life.work().is_err());
        assert!(life.operation("open:new".into()).is_err());
        assert!(life.operation("authentication".into()).is_ok());
        drop(account);
        assert!(life.work().is_ok());
    }
    #[test]
    fn closing_restore_keeps_cross_source_reservation_until_process_completion() {
        let opens = OpenReservations::default();
        let life = ConnectionLife::new();
        life.ready().unwrap();
        let path = Path::new("/project");
        let reserved = opens.reserve("agent", path, "session").unwrap();
        let operation = life
            .operation("open:session".into())
            .unwrap()
            .with_opening(Some(reserved));
        life.close(true, None).unwrap();
        drop(operation);
        assert!(opens.reserve("agent", path, "session").is_err());
        assert!(opens.reserve("agent", path, "other-session").is_ok());
        assert!(opens.reserve("other-agent", path, "session").is_ok());
        life.finish(Ok(()));
        assert!(opens.reserve("agent", path, "session").is_ok());
    }

    #[test]
    fn work_admission_and_idle_close_share_one_decision() {
        let life = ConnectionLife::new();
        life.ready().unwrap();
        let work = life.work().unwrap();
        assert!(!life.close(false, Some(Duration::ZERO)).unwrap());
        assert!(life.close(false, None).is_err());
        drop(work);
        assert!(life.close(false, Some(Duration::ZERO)).unwrap());
        assert!(life.work().is_err());
    }
}
