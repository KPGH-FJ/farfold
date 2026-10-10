//! Test-only deterministic retirement; never adjusts active work or production limits.
use super::*;
impl Requests {
    pub(in crate::acp_client) fn expire_settled_for_test(&self, id: &str) {
        let entries = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(request) = entries.get(id).filter(|r| !r.active()) {
            *request.touched.lock().unwrap_or_else(|p| p.into_inner()) =
                Instant::now() - RETENTION - Duration::from_secs(1);
        }
    }
}
