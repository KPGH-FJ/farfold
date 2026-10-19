//! IPC future cancellation guard; no body, task, or Agent loop.
use super::history_admission::{Admission, Cancel, Failure, Owner};
use std::sync::Arc;

pub(super) struct RequestGuard {
    gate: Arc<Admission>,
    owner: Owner,
    receipt_id: u64,
}
impl RequestGuard {
    // Move the original Window-derived Owner here after enqueue(owner.clone()).
    // While waiting: original guard + Waiting + scheduler Entry. After acquire:
    // guard + mandatory granted request + Entry; no additional whole Owner copy.
    pub(super) fn new(gate: Arc<Admission>, owner: Owner, receipt_id: u64) -> Self {
        Self {
            gate,
            owner,
            receipt_id,
        }
    }
    pub(super) fn owner(&self) -> &Owner {
        &self.owner
    }
    pub(super) fn cancel(&self) -> Result<Cancel, Failure> {
        self.gate.cancel(self.receipt_id, &self.owner)
    }
}
impl Drop for RequestGuard {
    fn drop(&mut self) {
        // Dropping IPC/ack observation before offer must prevent later dispatch.
        // After commit this returns AlreadyStarting: escrow retains the charge,
        // and this local cancellation is NOT an Agent stop or completion proof.
        let _ = self.cancel();
    }
}
