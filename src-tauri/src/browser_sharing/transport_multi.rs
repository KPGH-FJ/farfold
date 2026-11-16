//! One conversation controller for independently authenticated helper channels.
//! A helper lifetime is not the conversation lifetime. Unknown output survives
//! helper replacement and only exact per-channel barriers can settle withdrawal.
use super::*;
#[path = "transport_multi_hub.rs"]
mod hub;
#[path = "transport_multi_start.rs"]
mod start;
pub(crate) use start::{MachLaunch, OwnerCheck, start_mach};

#[derive(Default)]
struct State {
    epoch: u64,
    retiring: bool,
    closed: bool,
    unknown: bool,
    reading: Option<u64>,
    catalog_delivered: bool,
}
#[derive(Default)]
pub(super) struct Gate(Mutex<State>);
impl Gate {
    pub(super) fn retire(&self) -> u64 {
        let mut s = self.0.lock().unwrap_or_else(|e| e.into_inner());
        s.retiring = true;
        match s.epoch.checked_add(1) {
            Some(epoch) => s.epoch = epoch,
            None => {
                s.closed = true;
                s.unknown = true;
            }
        }
        s.epoch
    }
    fn settle(&self, epoch: u64) -> bool {
        let mut s = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if s.unknown {
            return false;
        }
        if s.epoch == epoch && !s.closed {
            s.retiring = false;
        }
        true
    }
    pub(super) fn close(&self) {
        let mut s = self.0.lock().unwrap_or_else(|e| e.into_inner());
        s.closed = true;
        s.retiring = true;
    }
    fn poison(&self) {
        let mut s = self.0.lock().unwrap_or_else(|e| e.into_inner());
        s.unknown = true;
        s.retiring = true;
    }
    fn unknown(&self) -> bool {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).unknown
    }
    pub(super) fn available(&self) -> bool {
        let s = self.0.lock().unwrap_or_else(|e| e.into_inner());
        !s.closed && !s.retiring && !s.unknown
    }
    fn acquire(&self, id: u64) -> bool {
        let mut s = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if s.closed || s.retiring || s.unknown || s.reading.is_some() {
            return false;
        }
        s.reading = Some(id);
        true
    }
    fn release(&self, id: u64) {
        let mut s = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if s.reading == Some(id) {
            s.reading = None;
        }
    }
}
pub(super) struct ChannelLease {
    id: u64,
    gate: Arc<Gate>,
    live: hub::CallbackLive,
}
impl super::stream::ChannelPolicy for ChannelLease {
    fn admit(&self) -> bool {
        (self.live)() && self.gate.acquire(self.id)
    }
    fn available(&self) -> bool {
        (self.live)() && self.gate.available()
    }
    fn catalog_available(&self) -> bool {
        let state = self.gate.0.lock().unwrap_or_else(|e| e.into_inner());
        (self.live)()
            && state.catalog_delivered
            && !state.closed
            && !state.retiring
            && !state.unknown
    }
    fn catalog_delivered(&self) {
        let mut state = self.gate.0.lock().unwrap_or_else(|e| e.into_inner());
        if (self.live)() && !state.closed && !state.retiring && !state.unknown {
            state.catalog_delivered = true;
        }
    }
    fn observe(&self, wire: &Wire) {
        if wire.idle() {
            self.gate.release(self.id);
        }
    }
}
impl ChannelLease {
    fn finished(&self, clean: bool) {
        if !clean {
            self.gate.poison();
        }
        self.gate.release(self.id);
    }
}

#[cfg(test)]
#[path = "transport_multi_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "transport_multi_wire_tests.rs"]
mod wire_tests;

#[cfg(test)]
#[path = "transport_multi_native_tests.rs"]
mod native_tests;
