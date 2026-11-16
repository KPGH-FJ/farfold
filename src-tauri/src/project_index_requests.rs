//! Short-lived cancellation flags only; no saved index or operation history.
use super::Failure;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
const CAPACITY: usize = 64;
const RETENTION: Duration = Duration::from_secs(300);
#[derive(Default)]
pub(super) struct Requests(Mutex<HashMap<String, Entry>>);
struct Entry {
    flag: Arc<AtomicBool>,
    running: bool,
    touched: Instant,
}
pub(super) struct Lease {
    owner: Arc<Requests>,
    id: String,
    pub flag: Arc<AtomicBool>,
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut entries) = self.owner.0.lock()
            && let Some(entry) = entries.get_mut(&self.id)
        {
            entry.running = false;
            entry.touched = Instant::now();
        }
    }
}
pub(super) fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
pub(super) fn shared() -> Arc<Requests> {
    static REQUESTS: OnceLock<Arc<Requests>> = OnceLock::new();
    REQUESTS
        .get_or_init(|| Arc::new(Requests::default()))
        .clone()
}
impl Requests {
    fn entries(&self) -> Result<std::sync::MutexGuard<'_, HashMap<String, Entry>>, Failure> {
        let mut entries = self.0.lock().map_err(|_| Failure::new("unavailable"))?;
        // Never free a live OS worker's identity on timeout, IPC drop or cancel.
        entries.retain(|_, e| e.running || e.touched.elapsed() < RETENTION);
        Ok(entries)
    }
    pub(super) fn begin_with<T>(
        self: &Arc<Self>,
        id: &str,
        admit: impl FnOnce() -> Result<T, Failure>,
    ) -> Result<(Lease, T), Failure> {
        if !valid_id(id) {
            return Err(Failure::new("invalidRequest"));
        }
        let mut entries = self.entries()?;
        if let Some(entry) = entries.get(id) {
            return Err(Failure::new(if entry.flag.load(Ordering::Acquire) {
                "cancelled"
            } else {
                "requestConflict"
            }));
        }
        if entries.len() >= CAPACITY {
            return Err(Failure::new("readBusy"));
        }
        // Refusing a fresh scan must not fill the request table with retries.
        let permit = admit()?;
        let flag = Arc::new(AtomicBool::new(false));
        entries.insert(
            id.into(),
            Entry {
                flag: flag.clone(),
                running: true,
                touched: Instant::now(),
            },
        );
        Ok((
            Lease {
                owner: self.clone(),
                id: id.into(),
                flag,
            },
            permit,
        ))
    }
    pub fn cancel(&self, id: &str) -> Result<(), Failure> {
        if !valid_id(id) {
            return Err(Failure::new("invalidRequest"));
        }
        let mut entries = self.entries()?;
        if let Some(entry) = entries.get_mut(id) {
            entry.flag.store(true, Ordering::Release);
            entry.touched = Instant::now();
        } else {
            if entries.len() >= CAPACITY {
                return Err(Failure::new("readBusy"));
            }
            entries.insert(
                id.into(),
                Entry {
                    flag: Arc::new(AtomicBool::new(true)),
                    running: false,
                    touched: Instant::now(),
                },
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        file_read_check::tests::PRODUCTION_CHECKS,
        project_index::{observe, observe_scan, read},
    };
    use std::path::Path;
    const A: &str = "00000000-0000-4000-8000-000000000001";
    const B: &str = "00000000-0000-4000-8000-000000000002";
    const C: &str = "00000000-0000-4000-8000-000000000003";
    impl Requests {
        fn begin(self: &Arc<Self>, id: &str) -> Result<Lease, Failure> {
            self.begin_with(id, || Ok(())).map(|(lease, ())| lease)
        }
    }
    #[test]
    fn early_cancel_prevents_late_start_and_only_matches_exact_id() {
        let r = Arc::new(Requests::default());
        r.cancel(A).unwrap();
        assert_eq!(r.begin(A).err().unwrap().code, "cancelled");
        let other = r.begin(B).unwrap();
        assert!(!other.flag.load(Ordering::Acquire));
        r.cancel(B).unwrap();
        assert!(other.flag.load(Ordering::Acquire));
    }
    #[test]
    fn completed_and_running_ids_cannot_start_twice() {
        let r = Arc::new(Requests::default());
        let lease = r.begin(A).unwrap();
        assert_eq!(r.begin(A).err().unwrap().code, "requestConflict");
        drop(lease);
        assert_eq!(r.begin(A).err().unwrap().code, "requestConflict");
    }
    #[test]
    fn full_registry_does_not_evict_a_live_worker() {
        let r = Arc::new(Requests::default());
        let live = r.begin(A).unwrap();
        for i in 2..=CAPACITY {
            r.cancel(&format!("00000000-0000-4000-8000-{i:012x}"))
                .unwrap();
        }
        r.0.lock().unwrap().get_mut(A).unwrap().touched =
            Instant::now() - RETENTION - Duration::from_secs(1);
        assert_eq!(
            r.begin("00000000-0000-4000-8000-ffffffffffff")
                .err()
                .unwrap()
                .code,
            "readBusy"
        );
        r.cancel(A).unwrap();
        assert!(live.flag.load(Ordering::Acquire));
    }
    #[test]
    fn expired_inactive_flags_are_bounded_not_persistent_history() {
        let r = Arc::new(Requests::default());
        r.cancel(A).unwrap();
        r.0.lock().unwrap().get_mut(A).unwrap().touched =
            Instant::now() - RETENTION - Duration::from_secs(1);
        let new = r.begin(B).unwrap();
        assert_eq!(r.0.lock().unwrap().len(), 1);
        drop(new);
    }
    #[test]
    fn malformed_ids_cannot_allocate_slots() {
        let r = Arc::new(Requests::default());
        for id in ["", "../cancel", "00000000-0000-4000-8000-00000000000Z"] {
            assert_eq!(r.cancel(id).unwrap_err().code, "invalidRequest");
        }
        assert!(r.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn dropped_observer_keeps_real_worker_identity_and_cancellation_flag() {
        let _checks = PRODUCTION_CHECKS.lock().await;
        let r = Arc::new(Requests::default());
        let lease = r.begin(A).unwrap();
        let (started, started_rx) = tokio::sync::oneshot::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let (finished, finished_rx) = tokio::sync::oneshot::channel();
        let observer = tokio::spawn(crate::file_read_check::run(move || {
            let lease = lease;
            let _ = started.send(());
            release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
            let cancelled = lease.flag.load(Ordering::Acquire);
            drop(lease);
            let _ = finished.send(cancelled);
            Ok(())
        }));
        tokio::time::timeout(Duration::from_secs(3), started_rx)
            .await
            .unwrap()
            .unwrap();
        observer.abort();
        let _ = observer.await;
        assert!(r.0.lock().unwrap()[A].running);
        assert_eq!(r.begin(A).err().unwrap().code, "requestConflict");
        r.cancel(A).unwrap();
        release.send(()).unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(3), finished_rx)
                .await
                .unwrap()
                .unwrap()
        );
        assert!(!r.0.lock().unwrap()[A].running);
    }

    #[tokio::test]
    async fn real_read_pending_keeps_the_worker_live_until_it_returns() {
        let _checks = PRODUCTION_CHECKS.lock().await;
        let r = Arc::new(Requests::default());
        let lease = r.begin(A).unwrap();
        let (started, started_rx) = tokio::sync::oneshot::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let (finished, finished_rx) = tokio::sync::oneshot::channel();
        let observer = tokio::spawn(crate::file_read_check::run(move || {
            let lease = lease;
            let _ = started.send(());
            release_rx.recv_timeout(Duration::from_secs(20)).unwrap();
            let cancelled = lease.flag.load(Ordering::Acquire);
            drop(lease);
            let _ = finished.send(cancelled);
            Ok(())
        }));
        tokio::time::timeout(Duration::from_secs(3), started_rx)
            .await
            .unwrap()
            .unwrap();
        let message = tokio::time::timeout(Duration::from_secs(18), observer)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(
            crate::file_read_check::classify_error(&message),
            crate::file_read_check::FailureKind::Pending
        );
        assert!(r.0.lock().unwrap()[A].running);
        // Even well beyond the tombstone retention, a real worker stays owned.
        r.0.lock().unwrap().get_mut(A).unwrap().touched =
            Instant::now() - RETENTION - Duration::from_secs(1);
        assert_eq!(r.begin(A).err().unwrap().code, "requestConflict");
        r.cancel(A).unwrap();
        release.send(()).unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(3), finished_rx)
                .await
                .unwrap()
                .unwrap()
        );
        assert!(!r.0.lock().unwrap()[A].running);
    }

    #[tokio::test]
    async fn cancelled_scan_and_rescan_leave_a_slot_for_the_explicit_file_read() {
        let _checks = PRODUCTION_CHECKS.lock().await;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        std::fs::write(root.join("text"), "explicit read").unwrap();
        let requests = Arc::new(Requests::default());
        let (started_a, ready_a) = tokio::sync::oneshot::channel();
        let (release_a, blocked_a) = std::sync::mpsc::channel();
        let owner_a = requests.clone();
        let scan_a = tokio::spawn(async move {
            observe_scan(&owner_a, A.into(), move |_, cancelled| {
                started_a.send(()).unwrap();
                blocked_a.recv_timeout(Duration::from_secs(6)).unwrap();
                Ok(cancelled.load(Ordering::Acquire))
            })
            .await
        });
        tokio::time::timeout(Duration::from_secs(2), ready_a)
            .await
            .unwrap()
            .unwrap();
        requests.cancel(A).unwrap();
        assert!(requests.0.lock().unwrap()[A].running);

        let (started_b, ready_b) = tokio::sync::oneshot::channel();
        let (release_b, blocked_b) = std::sync::mpsc::channel();
        let owner_b = requests.clone();
        let scan_b = tokio::spawn(async move {
            observe_scan(&owner_b, B.into(), move |_, _| {
                started_b.send(()).unwrap();
                blocked_b.recv_timeout(Duration::from_secs(6)).unwrap();
                Ok(())
            })
            .await
        });
        // The admission refusal drops the closure and closes its start signal.
        // On old code that signal proves the second worker still holds a slot.
        let second_worker_started = tokio::time::timeout(Duration::from_secs(2), ready_b)
            .await
            .unwrap()
            .is_ok();
        let second_request_registered = requests.0.lock().unwrap().contains_key(B);
        let explicit = observe(move || read::read(&root, Path::new("text"))).await;
        let _ = release_b.send(());
        release_a.send(()).unwrap();
        let second = scan_b.await.unwrap();
        assert_eq!(scan_a.await.unwrap(), Ok(true));
        assert_eq!(explicit, Ok("explicit read".to_owned()));
        assert!(!second_worker_started);
        assert!(!second_request_registered);
        assert_eq!(second, Err(Failure::new("readBusy")));
        assert_eq!(
            observe_scan(&requests, C.into(), |_, _| Ok(())).await,
            Ok(())
        );
    }
}
