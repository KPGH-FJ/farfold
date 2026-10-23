//! Backlog ownership, not a transcript limit or an allocator/RSS estimate.
//! Already admitted finite frames may cross the watermark. Pressure pauses the
//! next stdout line; it never discards events, cancels work or stops a process.
use serde::Serialize;
use std::{
    io,
    sync::{Arc, Mutex, OnceLock, Weak},
    task::{Context, Waker},
};
const QUEUED_BYTES: usize = 4 * 1024 * 1024;
const QUEUED_ITEMS: usize = 256;
#[derive(Default)]
struct State {
    bytes: u128,
    items: u128,
    waiters: Vec<Weak<Mutex<Option<Waker>>>>,
}
pub(super) struct Budget {
    state: Mutex<State>,
    bytes: usize,
    items: usize,
}
impl Budget {
    pub(super) fn shared() -> Arc<Self> {
        static BUDGET: OnceLock<Arc<Budget>> = OnceLock::new();
        BUDGET
            .get_or_init(|| Self::new(QUEUED_BYTES, QUEUED_ITEMS))
            .clone()
    }
    pub(super) fn independent() -> Arc<Self> {
        Self::new(QUEUED_BYTES, QUEUED_ITEMS)
    }
    pub(super) fn saturated(&self) -> bool {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.bytes >= self.bytes as u128 || state.items >= self.items as u128
    }
    pub(super) fn new(bytes: usize, items: usize) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State::default()),
            bytes,
            items,
        })
    }
    pub(super) fn watch(self: &Arc<Self>) -> Admission {
        let wake = Arc::new(Mutex::new(None));
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .waiters
            .push(Arc::downgrade(&wake));
        Admission {
            budget: self.clone(),
            wake,
        }
    }
    pub(super) fn hold(self: &Arc<Self>, bytes: usize) -> Lease {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.bytes = state.bytes.saturating_add(bytes as u128);
        state.items = state.items.saturating_add(1);
        Lease {
            budget: self.clone(),
            bytes,
        }
    }
    pub(super) fn json(self: &Arc<Self>, value: &impl Serialize) -> Lease {
        // Count actual serialization without constructing a duplicate body.
        struct Count(usize);
        impl io::Write for Count {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.0 = self.0.saturating_add(bytes.len());
                Ok(bytes.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let mut count = Count(0);
        let bytes = if serde_json::to_writer(&mut count, value).is_ok() {
            count.0
        } else {
            usize::MAX
        };
        self.hold(bytes)
    }
    #[cfg(test)]
    pub(super) fn retained(&self) -> (usize, usize) {
        let state = self.state.lock().unwrap();
        (
            state.bytes.min(usize::MAX as u128) as usize,
            state.items.min(usize::MAX as u128) as usize,
        )
    }
}
pub(super) struct Admission {
    budget: Arc<Budget>,
    wake: Arc<Mutex<Option<Waker>>>,
}
impl Admission {
    pub(super) fn ready(&self, cx: &Context<'_>) -> bool {
        let state = self.budget.state.lock().unwrap_or_else(|e| e.into_inner());
        let ready =
            state.bytes < self.budget.bytes as u128 && state.items < self.budget.items as u128;
        let mut wake = self.wake.lock().unwrap_or_else(|e| e.into_inner());
        if ready {
            *wake = None;
        } else if !wake.as_ref().is_some_and(|w| w.will_wake(cx.waker())) {
            *wake = Some(cx.waker().clone());
        }
        ready
    }
}
impl Drop for Admission {
    fn drop(&mut self) {
        // A connection can close before it holds any body. Its registration
        // must retire without depending on a later, unrelated Lease release.
        let owned = Arc::as_ptr(&self.wake);
        self.budget
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .waiters
            .retain(|entry| !std::ptr::eq(entry.as_ptr(), owned));
    }
}
pub(super) struct Lease {
    budget: Arc<Budget>,
    bytes: usize,
}
impl Drop for Lease {
    fn drop(&mut self) {
        let mut wakes = Vec::new();
        {
            let mut state = self.budget.state.lock().unwrap_or_else(|e| e.into_inner());
            state.bytes = state.bytes.saturating_sub(self.bytes as u128);
            state.items = state.items.saturating_sub(1);
            state.waiters.retain(|entry| {
                let Some(entry) = entry.upgrade() else {
                    return false;
                };
                if let Some(waker) = entry.lock().unwrap_or_else(|e| e.into_inner()).take() {
                    wakes.push(waker);
                }
                true
            });
        }
        for wake in wakes {
            wake.wake();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Wakes(AtomicUsize);
    impl std::task::Wake for Wakes {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    #[test]
    fn retired_admissions_leave_no_registration_without_creating_a_lease() {
        let budget = Budget::new(10, 2);
        for _ in 0..128 {
            let admission = budget.watch();
            assert_eq!(budget.state.lock().unwrap().waiters.len(), 1);
            drop(admission);
            assert_eq!(budget.state.lock().unwrap().waiters.len(), 0);
        }
        assert_eq!(budget.retained(), (0, 0));
    }
    #[test]
    fn retiring_other_admissions_keeps_the_live_waiter_and_its_wakeup() {
        let budget = Budget::new(10, 2);
        let admission = budget.watch();
        for _ in 0..128 {
            drop(budget.watch());
            assert_eq!(budget.state.lock().unwrap().waiters.len(), 1);
        }
        let wake = Arc::new(Wakes(AtomicUsize::new(0)));
        let waker = Waker::from(wake.clone());
        let cx = Context::from_waker(&waker);
        let lease = budget.hold(11);
        assert!(!admission.ready(&cx));
        drop(budget.watch());
        assert_eq!(budget.state.lock().unwrap().waiters.len(), 1);
        assert_eq!(wake.0.load(Ordering::SeqCst), 0);
        drop(lease);
        assert_eq!(wake.0.load(Ordering::SeqCst), 1);
        assert!(admission.ready(&cx));
        drop(admission);
        assert_eq!(budget.state.lock().unwrap().waiters.len(), 0);
    }
    #[test]
    fn current_owned_batch_can_cross_watermark_and_only_last_real_release_resumes() {
        let budget = Budget::new(10, 2);
        let admission = budget.watch();
        let wake = Arc::new(Wakes(AtomicUsize::new(0)));
        let waker = Waker::from(wake.clone());
        let cx = Context::from_waker(&waker);
        let first = budget.hold(11);
        let second = budget.hold(12);
        assert!(!admission.ready(&cx));
        assert_eq!(budget.retained(), (23, 2));
        drop(first);
        assert!(!admission.ready(&cx));
        drop(second);
        assert!(admission.ready(&cx));
        assert_eq!(budget.retained(), (0, 0));
        assert_eq!(wake.0.load(Ordering::SeqCst), 2);
    }
    #[test]
    fn json_count_is_exact_and_never_copies_or_hides_other_live_leases() {
        let budget = Budget::new(1024, 10);
        let value = serde_json::json!({"unknown":"中文\\\"","nested":[null,true,42]});
        let a = budget.json(&value);
        assert_eq!(
            budget.retained(),
            (serde_json::to_vec(&value).unwrap().len(), 1)
        );
        let b = budget.hold(usize::MAX);
        drop(b);
        assert_eq!(
            budget.retained(),
            (serde_json::to_vec(&value).unwrap().len(), 1)
        );
        drop(a);
        assert_eq!(budget.retained(), (0, 0));
    }
}
