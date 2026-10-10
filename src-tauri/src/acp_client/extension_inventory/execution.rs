//! Shared inventory/management worker budget, independent of activity admission.
use super::types::*;
use std::sync::atomic::{AtomicUsize, Ordering};
static ACTIVE: AtomicUsize = AtomicUsize::new(0);
pub(in crate::acp_client) struct Permit;
pub(in crate::acp_client) fn acquire() -> Result<Permit> {
    ACTIVE
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |v| {
            (v < 2).then_some(v + 1)
        })
        .map(|_| Permit)
        .map_err(|_| Code::Busy.into())
}
impl Drop for Permit {
    fn drop(&mut self) {
        ACTIVE.fetch_sub(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
#[path = "execution_tests.rs"]
mod tests;
#[cfg(test)]
pub(in crate::acp_client) use tests::fixture_lock;
