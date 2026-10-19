//! Body-free delivery facts in the existing history admission entry.
//! Neither fact alone releases a pipeline. No Slot/Entry self-reference.
use super::*;

pub(super) struct Renderer {
    pub(super) native_done: bool,
    pub(super) renderer_done: bool,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub receipt_id: u64,
    pub open_token: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ack {
    receipt_id: u64,
    open_token: String,
    outcome: &'static str,
}

impl Admission {
    /// Called by the original public command's private progress closure before
    /// it offers any load/fork. Raw Agent events cannot call this authority.
    pub(in crate::acp_client) fn arm_renderer(&self, owner: &Owner) -> Result<Receipt, Failure> {
        let mut s = self.state.lock().map_err(|_| Failure::Unavailable)?;
        if s.closed
            || !s
                .windows
                .get(&owner.window)
                .is_some_and(|authority| Arc::ptr_eq(authority, &owner.authority))
        {
            return Err(Failure::Closed);
        }
        let (id, entry) = s
            .entries
            .iter_mut()
            .find(|(_, entry)| entry.owner == *owner)
            .ok_or(Failure::Invalid)?;
        if entry.phase != Phase::Granted || entry.offer != Offer::Cold {
            return Err(Failure::Invalid);
        }
        entry.renderer.get_or_insert(Renderer {
            native_done: false,
            renderer_done: false,
        });
        Ok(Receipt {
            receipt_id: *id,
            open_token: owner.open_token.clone(),
        })
    }

    /// Reads only the original entry: no new ID, retirement or assertion
    /// that a failed phase reached the renderer.
    pub(in crate::acp_client) fn existing_renderer(
        &self,
        owner: &Owner,
    ) -> Result<Option<Receipt>, Failure> {
        let s = self.state.lock().map_err(|_| Failure::Unavailable)?;
        if s.closed
            || !s
                .windows
                .get(&owner.window)
                .is_some_and(|authority| Arc::ptr_eq(authority, &owner.authority))
        {
            return Err(Failure::Closed);
        }
        Ok(s.entries
            .iter()
            .find(|(_, entry)| entry.owner == *owner)
            .and_then(|(id, entry)| {
                entry.renderer.as_ref().map(|_| Receipt {
                    receipt_id: *id,
                    open_token: owner.open_token.clone(),
                })
            }))
    }

    pub(in crate::acp_client) fn acknowledge_renderer(
        self: &Arc<Self>,
        owner: &Owner,
        receipt_id: u64,
    ) -> Result<Ack, Failure> {
        if receipt_id == 0 || receipt_id > 9_007_199_254_740_991 {
            return Err(Failure::Invalid);
        }
        let mut s = self.state.lock().map_err(|_| Failure::Unavailable)?;
        if s.closed
            || !s
                .windows
                .get(&owner.window)
                .is_some_and(|authority| Arc::ptr_eq(authority, &owner.authority))
        {
            return Err(Failure::Closed);
        }
        let Some(entry) = s.entries.get_mut(&receipt_id) else {
            // IDs never wrap/reuse. This says only no such retained slot,
            // never that native work ended or a preview/fork was cancelled.
            return Ok(Ack {
                receipt_id,
                open_token: owner.open_token.clone(),
                outcome: "notRetained",
            });
        };
        if entry.owner != *owner || entry.phase != Phase::Granted || entry.offer != Offer::Cold {
            return Err(Failure::Invalid);
        }
        let renderer = entry.renderer.as_mut().ok_or(Failure::Invalid)?;
        renderer.renderer_done = true;
        let native_done = renderer.native_done;
        if native_done {
            Self::remove_delivery_entry(&mut s, receipt_id);
        }
        let deliveries = self.grant(&mut s);
        drop(s);
        self.deliver(deliveries);
        Ok(Ack {
            receipt_id,
            open_token: owner.open_token.clone(),
            outcome: "acknowledged",
        })
    }

    pub(super) fn remove_delivery_entry(s: &mut State, id: u64) {
        let entry = s.entries.remove(&id).expect("same locked delivery");
        assert!(entry.phase == Phase::Granted && entry.offer == Offer::Cold);
        s.active -= 1;
        s.retained -= entry.cost;
    }

    pub(super) fn retire_destroyed_renderer(s: &mut State, authority: &Arc<()>) {
        // Called only by the existing actual WindowEvent::Destroyed chain.
        // A reused label's new Arc does not match these original owners.
        let mut finished = Vec::new();
        for (id, entry) in &mut s.entries {
            if !Arc::ptr_eq(&entry.owner.authority, authority) {
                continue;
            }
            if let Some(renderer) = &mut entry.renderer {
                renderer.renderer_done = true;
                if renderer.native_done {
                    finished.push(*id);
                }
            }
        }
        for id in finished {
            Self::remove_delivery_entry(s, id);
        }
    }
}
