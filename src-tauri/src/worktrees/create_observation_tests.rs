//! Last actual Create boundary, emitted only by the Windows test binary.
//! No retry, injected failure, path, material or authority is introduced.
use std::cell::Cell;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

pub(super) struct Observation {
    scope: &'static str,
    phase: Cell<&'static str>,
    instance: u64,
    started: Instant,
}
impl Observation {
    pub(super) fn new(scope: &'static str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        Self {
            scope,
            phase: Cell::new("entered"),
            instance: NEXT.fetch_add(1, Ordering::Relaxed),
            started: Instant::now(),
        }
    }
    pub(super) fn at(&self, phase: &'static str) {
        self.phase.set(phase);
        eprintln!(
            "FARFOLD_WINDOWS_CREATE_REACHED pid={} instance={} scope={} elapsedMs={} phase={phase}",
            std::process::id(),
            self.instance,
            self.scope,
            self.started.elapsed().as_millis()
        );
    }
}
impl Drop for Observation {
    fn drop(&mut self) {
        eprintln!(
            "FARFOLD_WINDOWS_CREATE_BOUNDARY pid={} instance={} scope={} elapsedMs={} lastReached={}",
            std::process::id(),
            self.instance,
            self.scope,
            self.started.elapsed().as_millis(),
            self.phase.get()
        );
    }
}
