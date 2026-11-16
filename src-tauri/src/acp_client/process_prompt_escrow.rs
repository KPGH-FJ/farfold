//! One process's transient prompt resources, not a completion task.
//! Resource destruction is NOT proof that a committed request stopped.
use super::super::{
    history_admission::{Failure, OfferedSlot, Permit},
    lifecycle::WorkLease,
};
use agent_client_protocol::{
    RawJsonRpcMessage, RawJsonRpcParams,
    schema::v1::{RequestId, Response},
};
use serde_json::Value;
use std::sync::{
    Arc, Mutex, Weak,
    atomic::{AtomicBool, Ordering},
};
use tokio::time::Instant;

#[derive(Clone, Default)]
pub(in crate::acp_client) struct PromptEscrow {
    state: Arc<Mutex<State>>,
    pool: Option<Arc<super::super::history_admission::Admission>>,
}
#[derive(Default)]
struct State {
    reaped: bool,
    resources: Vec<Resource>,
}
struct Resource {
    id: u64,
    session_id: String,
    wire: WirePrompt,
    slot: Option<OfferedSlot>,
    work: Option<WorkLease>,
    completed: Arc<AtomicBool>,
}
enum WirePrompt {
    Unsent,
    Sent(RequestId),
    Answered { error: bool },
}
impl Resource {
    // Called only after a known result or the exact process owner's OS boundary.
    fn finish(mut self) {
        // Release outside both escrow and lifecycle locks. Slot release may
        // synchronously wake another waiter. The old WorkLease is released
        // first so that wake cannot observe it as still active.
        drop(self.work.take());
        self.completed.store(true, Ordering::Release);
        if let Some(slot) = self.slot.take() {
            slot.release();
        }
    }
}
impl Drop for Resource {
    fn drop(&mut self) {
        // Abort/panic, poisoned escrow, or last-control destruction is unknown.
        // OfferedSlot's destructor does NOT release the admission entry.
        // Reuse the existing scalar/managed-update transfer, not a WorkLease
        // stored inside ConnectionLife (which would create an Arc cycle).
        if let Some(work) = self.work.take() {
            work.retain_until_terminated();
        }
    }
}

/// Non-owning observation authority for exactly one committed request.
/// Dropping or aborting any holder does nothing to active capacity.
#[derive(Clone)]
pub(in crate::acp_client) struct PromptObservation {
    cell: Weak<Mutex<State>>,
    id: u64,
    completed: Arc<AtomicBool>,
}
impl PromptEscrow {
    pub(in crate::acp_client) fn for_pool(
        pool: Arc<super::super::history_admission::Admission>,
    ) -> Self {
        Self {
            pool: Some(pool),
            ..Self::default()
        }
    }
    pub(in crate::acp_client) fn coordination_bytes() -> usize {
        std::mem::size_of::<(
            Self,
            State,
            Resource,
            PromptObservation,
            WorkLease,
            OfferedSlot,
        )>()
    }
    /// Synchronous final pre-SDK boundary. `work` and `permit` are still
    /// definitely unsent on any failure before commit_prompt succeeds.
    pub(in crate::acp_client) fn commit(
        &self,
        session_id: &str,
        permit: &Permit,
        work: WorkLease,
        deadline: Instant,
    ) -> Result<PromptObservation, Failure> {
        let pool = self.pool.as_ref().ok_or(Failure::Unavailable)?;
        if !permit.belongs_to(pool) {
            return Err(Failure::Invalid);
        }
        let mut state = self.state.lock().map_err(|_| Failure::Unavailable)?;
        if state.reaped {
            return Err(Failure::Closed);
        }
        // No potentially allocating Vec growth after the offer commits.
        state
            .resources
            .try_reserve(1)
            .map_err(|_| Failure::Unavailable)?;
        let session_id = session_id.to_owned();
        let completed = Arc::new(AtomicBool::new(false));
        // The scheduler lock linearizes actual-window closure, queued or
        // granted cancellation, the absolute deadline, and SDK-offer authority.
        // Lock order is escrow -> admission; no inverse path exists.
        let slot = permit.commit_prompt(deadline)?;
        let id = slot.id();
        state.resources.push(Resource {
            id,
            session_id,
            wire: WirePrompt::Unsent,
            slot: Some(slot),
            work: Some(work),
            completed: completed.clone(),
        });
        Ok(PromptObservation {
            cell: Arc::downgrade(&self.state),
            id,
            completed,
        })
    }

    /// Keep only the request identity and the shape of its first wire reply.
    /// The SDK still owns matching, decoding and delivery to the session pump.
    pub(in crate::acp_client) fn inspect(&self, message: &RawJsonRpcMessage, outgoing: bool) {
        match (outgoing, message) {
            (true, RawJsonRpcMessage::Request(request))
                if request.method.as_ref() == "session/prompt" =>
            {
                let Some(RawJsonRpcParams::Object(params)) = request.params.as_ref() else {
                    return;
                };
                let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
                    return;
                };
                if let Ok(mut state) = self.state.lock()
                    && let Some(resource) = state.resources.iter_mut().find(|resource| {
                        resource.session_id == session_id
                            && matches!(resource.wire, WirePrompt::Unsent)
                    })
                {
                    resource.wire = WirePrompt::Sent(request.id.clone());
                }
            }
            (false, RawJsonRpcMessage::Response(response)) => {
                let Some(id) = message.response_id() else {
                    return;
                };
                if let Ok(mut state) = self.state.lock()
                    && let Some(resource) = state.resources.iter_mut().find(|resource| {
                        matches!(&resource.wire, WirePrompt::Sent(request) if request == id)
                    })
                {
                    resource.wire = WirePrompt::Answered { error: matches!(response, Response::Error { .. }) };
                }
            }
            _ => {}
        }
    }

    /// ONLY the exact Child/OwnedGroup owner calls this, immediately before
    /// ProcessControl.done becomes Some, after exit + group-ended are facts.
    /// An unexpected nonzero exit still qualifies; `stop()`/EOF/timeout do not.
    pub(super) fn process_reaped(&self, _reaped: super::ReapedProcess) {
        let resources = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            state.reaped = true;
            std::mem::take(&mut state.resources)
        };
        for resource in resources {
            resource.finish();
        }
    }
}
impl PromptObservation {
    pub(in crate::acp_client) fn receipt_id(&self) -> u64 {
        self.id
    }

    pub(in crate::acp_client) fn matched_wire_error(&self) -> bool {
        self.cell.upgrade().is_some_and(|cell| {
            cell.lock().is_ok_and(|state| {
                state.resources.iter().any(|resource| {
                    resource.id == self.id
                        && matches!(resource.wire, WirePrompt::Answered { error: true })
                })
            })
        })
    }
    /// Input is the existing successfully decoded/serialized response result;
    /// no raw Agent event, error string, timeout or UI state grants authority.
    pub(in crate::acp_client) fn observe(&self, outcome: &Result<Value, String>) {
        if !outcome.as_ref().is_ok_and(|value| {
            matches!(
                value.get("stopReason").and_then(Value::as_str),
                Some("end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled")
            )
        }) {
            return;
        }
        let Some(cell) = self.cell.upgrade() else {
            return;
        };
        let resource = {
            let Ok(mut state) = cell.lock() else { return };
            state
                .resources
                .iter()
                .position(|r| r.id == self.id)
                .map(|index| state.resources.swap_remove(index))
        };
        if let Some(resource) = resource {
            resource.finish();
        }
    }

    /// Only an explicit finish sets this fact. Weak/missing/poisoned is not
    /// completion, and an already known terminal cannot revert on cell Drop.
    pub(in crate::acp_client) fn unresolved(&self) -> bool {
        !self.completed.load(Ordering::Acquire)
    }
}

#[cfg(test)]
#[path = "process_prompt_escrow_tests.rs"]
mod tests;
