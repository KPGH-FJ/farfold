//! Last actual Create boundary, emitted only by the Windows test binary.
//! No retry, injected failure, path, material or authority is introduced.
use std::cell::Cell;

pub(super) struct Observation {
    scope: &'static str,
    phase: Cell<&'static str>,
}
impl Observation {
    pub(super) fn new(scope: &'static str) -> Self {
        Self {
            scope,
            phase: Cell::new("entered"),
        }
    }
    pub(super) fn at(&self, phase: &'static str) {
        self.phase.set(phase);
        eprintln!(
            "FARFOLD_WINDOWS_CREATE_REACHED scope={} phase={phase}",
            self.scope
        );
    }
}
impl Drop for Observation {
    fn drop(&mut self) {
        eprintln!(
            "FARFOLD_WINDOWS_CREATE_BOUNDARY scope={} lastReached={}",
            self.scope,
            self.phase.get()
        );
    }
}
