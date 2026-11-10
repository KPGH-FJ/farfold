use super::*;

impl Availability {
    pub(crate) fn unavailable() -> Arc<Self> {
        Self::with_available(false)
    }

    pub(crate) fn enable_for_test(&self) {
        self.available.store(true, Ordering::SeqCst);
        self.configuration_available.store(true, Ordering::SeqCst);
    }
}
