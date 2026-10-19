//! Startup metadata for the existing PTY owner; no native resources here.
//! Metadata/notification only: contains no Native PTY, Child, Job, sink or env.
use std::sync::{
    Arc, Condvar, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread::JoinHandle;
use std::time::Duration;
const UNKNOWN: &str = "终端启动状态尚未确认，请等待当前操作结束";
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Stage {
    Reserved,
    Opening,
    Reader,
    Writer,
    Spawning,
    Attaching,
    Registering,
    Ready,
    Cleaning,
    Unknown,
    Closed,
}
struct State {
    stage: Stage,
    interested: bool,
    outcome: Option<Result<(), String>>,
    setup_closed: bool,
}
pub(super) struct Start {
    // Same Arc supplied by auth/preparation; ordinary PTY supplies its own Arc.
    pub(super) stop: Arc<AtomicBool>,
    state: Mutex<State>,
    changed: Condvar,
    // Actual Builder handle is retained; no second cleanup/reaper thread.
    thread: Mutex<Option<JoinHandle<()>>>,
}
impl Start {
    fn new(stop: Arc<AtomicBool>) -> Self {
        Self {
            stop,
            state: Mutex::new(State {
                stage: Stage::Reserved,
                interested: true,
                outcome: None,
                setup_closed: false,
            }),
            changed: Condvar::new(),
            thread: Mutex::new(None),
        }
    }
    pub(super) fn attach_thread(&self, thread: JoinHandle<()>) {
        // No native object has ever existed on the caller stack. The worker may
        // already be running, but its same Start Arc/slot cannot disappear.
        *self
            .thread
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(thread);
    }
    pub(super) fn stage(&self, stage: Stage) {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .stage = stage;
    }
    pub(super) fn stopped(&self, shutting_down: &AtomicBool) -> bool {
        self.stop.load(Ordering::SeqCst) || shutting_down.load(Ordering::SeqCst)
    }
    /// Proposed caller wait reuses existing CLOSE_TIMEOUT, NOT a kernel cap.
    /// Hold only this metadata mutex, never any PTY/registry mutex or native API.
    pub(super) fn wait_ready(&self, budget: Duration) -> Result<(), String> {
        let state = self.state.lock().map_err(|_| {
            self.stop.store(true, Ordering::SeqCst);
            UNKNOWN.to_string()
        })?;
        let (mut state, _) = self
            .changed
            .wait_timeout_while(state, budget, |s| s.outcome.is_none())
            .map_err(|_| {
                self.stop.store(true, Ordering::SeqCst);
                UNKNOWN.to_string()
            })?;
        // Recheck under the SAME lock as publish_ready. A ready winner is
        // returned, rather than discarded solely because the timer also fired.
        if let Some(result) = &state.outcome {
            return result.clone();
        }
        state.interested = false;
        self.stop.store(true, Ordering::SeqCst);
        Err(UNKNOWN.into()) // never AUTH_CANCELLED while cleanup is unconfirmed
    }
    /// Called with registry lock held, after IO/reader setup. register performs
    /// only the existing map insertion, no native call/destructor or callback.
    /// False means SAME owner must clean up; never publish a late terminal.
    pub(super) fn publish_ready(
        &self,
        shutting_down: &AtomicBool,
        register: impl FnOnce() -> Result<(), String>,
    ) -> Result<bool, String> {
        let mut state = self.state.lock().map_err(|_| UNKNOWN.to_string())?;
        if !state.interested || self.stopped(shutting_down) {
            return Ok(false);
        }
        register()?;
        state.stage = Stage::Ready;
        state.outcome = Some(Ok(()));
        drop(state);
        self.changed.notify_all();
        Ok(true)
    }
    /// ONLY after actual child/group cleanup (if any), slave/master destruction
    /// and retained auth sink release. Do not invent an exit frame/code for a
    /// never-created child. Error and cancellation both take this same barrier.
    pub(super) fn setup_failed_after_cleanup(&self, error: String) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.stage = Stage::Closed;
        state.setup_closed = true;
        state.outcome = Some(Err(error));
        drop(state);
        self.changed.notify_all();
    }
    pub(super) fn unknown(&self) {
        self.stop.store(true, Ordering::SeqCst);
        self.stage(Stage::Unknown);
        // No terminal outcome/notification, no slot release, no synthetic exit.
    }
    fn wait_quiescent(&self, budget: Duration) -> bool {
        let Ok(state) = self.state.lock() else {
            return false;
        };
        self.changed
            .wait_timeout_while(state, budget, |s| {
                s.stage != Stage::Ready && !s.setup_closed
            })
            .is_ok_and(|(state, _)| state.stage == Stage::Ready || state.setup_closed)
    }
    fn releasable(&self) -> bool {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.stage == Stage::Ready || state.setup_closed
    }
}
/// Exactly one unresolved startup per EXISTING manager; ready terminal owners
/// retain existing behavior. No queue and no automatic launch/retry loop.
#[derive(Clone, Default)]
pub(super) struct Slot(Arc<Mutex<Option<Arc<Start>>>>);
impl Slot {
    pub(super) fn reserve(
        &self,
        stop: Arc<AtomicBool>,
        shutting_down: &AtomicBool,
    ) -> Result<Arc<Start>, String> {
        let mut slot = self.0.lock().map_err(|_| UNKNOWN.to_string())?;
        if shutting_down.load(Ordering::SeqCst) {
            return Err("应用正在退出，请稍后重试".into());
        }
        if slot.is_some() {
            return Err("终端仍在准备或结束，请等待当前操作确认".into());
        }
        let start = Arc::new(Start::new(stop));
        *slot = Some(start.clone());
        Ok(start)
    }
    pub(super) fn cancel_pending(&self) {
        if let Some(start) = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
        {
            start.stop.store(true, Ordering::SeqCst);
        }
    }
    pub(super) fn wait_quiescent(&self, budget: Duration) -> bool {
        let pending = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        pending.is_none_or(|start| start.wait_quiescent(budget))
    }
    pub(super) fn release(&self, owner: &Arc<Start>) -> bool {
        if !owner.releasable() {
            return false;
        }
        let mut slot = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if slot
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, owner))
        {
            slot.take();
            true
        } else {
            false
        }
    }
    /// Builder::spawn returned Err before any native call could run. Its failed
    /// closure contains only owned launch arguments/activity/sink, never PTY IO.
    pub(super) fn owner_thread_never_started(&self, owner: &Arc<Start>, error: String) {
        owner.setup_failed_after_cleanup(error);
        self.release(owner);
    }
}

#[cfg(test)]
#[path = "startup_tests.rs"]
mod tests;
