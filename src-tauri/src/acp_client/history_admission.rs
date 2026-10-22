//! Parameterized cold-history admission; logical payload ownership only.
//! No SDK handler, transcript ledger, process work or environment switch.
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};
use tokio::sync::oneshot;

#[derive(Clone, Copy)]
pub(super) struct Policy {
    pub active: usize,
    pub pending: usize,
    pub bytes: usize,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Failure {
    Full,
    Payload,
    Closed,
    Cancelled,
    Invalid,
    Unavailable,
}
#[derive(Clone, Debug)]
pub(super) struct Owner {
    window: String,
    open_token: String,
    agent: String,
    authority: Arc<()>,
}
impl PartialEq for Owner {
    fn eq(&self, other: &Self) -> bool {
        self.window == other.window
            && self.open_token == other.open_token
            && self.agent == other.agent
            && Arc::ptr_eq(&self.authority, &other.authority)
    }
}
impl Eq for Owner {}
impl Owner {
    pub(super) fn belongs_to(&self, agent: &str) -> bool {
        self.agent == agent
    }
    pub(super) fn charge(&self, charge: &mut Charge) -> Result<(), Failure> {
        // Conservatively cover the request/waiter/registry coordination copies.
        for _ in 0..3 {
            charge.add(std::mem::size_of::<Self>())?;
            charge.text(&self.window)?;
            charge.text(&self.open_token)?;
            charge.text(&self.agent)?;
        }
        Ok(())
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Waiting,
    Granted,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Cancel {
    CancelledWaiting,
    AlreadyStarting,
    NotFound,
}
// Cold entries retain the existing last-Slot-drop semantics. Prompt entries
// explicitly distinguish pre-offer cancellation from committed/unknown work.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Offer {
    Cold,
    Reserved,
    Cancelled,
    Committed,
}
struct Entry {
    renderer: Option<delivery::Renderer>,
    offer: Offer,
    owner: Owner,
    cost: usize,
    phase: Phase,
    reply: Option<oneshot::Sender<Result<Permit, Failure>>>,
}
struct State {
    closed: bool,
    windows: HashMap<String, Arc<()>>,
    next: u64,
    active: usize,
    waiting: usize,
    retained: usize,
    last_agent: Option<String>,
    entries: HashMap<u64, Entry>,
    agents: VecDeque<String>,
    pending: HashMap<String, VecDeque<u64>>,
}
pub(super) struct Admission {
    policy: Policy,
    state: Mutex<State>,
}
pub(super) struct Waiting {
    gate: Arc<Admission>,
    owner: Owner,
    id: u64,
    queued: bool,
    acquired: bool,
    receive: Option<oneshot::Receiver<Result<Permit, Failure>>>,
}
#[derive(Clone)]
pub(super) struct Permit {
    _slot: Arc<Slot>,
}
struct Slot {
    gate: Arc<Admission>,
    id: u64,
}
type Delivery = (u64, oneshot::Sender<Result<Permit, Failure>>);

impl Admission {
    pub(super) fn production() -> Arc<Self> {
        // Initial engineering bounds, not measured RSS or an optimum.
        Self::new(Policy {
            active: 2,
            pending: 32,
            bytes: 8 * 1024 * 1024,
        })
        .expect("valid cold-history policy")
    }
    pub(super) fn new(policy: Policy) -> Result<Arc<Self>, Failure> {
        if policy.active == 0 || policy.bytes == 0 {
            return Err(Failure::Invalid);
        }
        Ok(Arc::new(Self {
            policy,
            state: Mutex::new(State {
                closed: false,
                windows: HashMap::new(),
                next: 0,
                active: 0,
                waiting: 0,
                retained: 0,
                last_agent: None,
                entries: HashMap::new(),
                agents: VecDeque::new(),
                pending: HashMap::new(),
            }),
        }))
    }
    pub(super) fn policy(&self) -> Policy {
        self.policy
    }
    pub(super) fn register_window(&self, window: &tauri::WebviewWindow) -> Result<(), Failure> {
        self.register_window_label(window.label())
    }
    fn register_window_label(&self, label: &str) -> Result<(), Failure> {
        let mut state = self.state.lock().map_err(|_| Failure::Unavailable)?;
        if state.closed {
            return Err(Failure::Closed);
        }
        // Called only for actual application windows at setup, never by a token
        // payload or per-open handler. Closing removes this one live entry.
        state
            .windows
            .entry(label.to_owned())
            .or_insert_with(|| Arc::new(()));
        Ok(())
    }
    pub(super) fn owner(
        &self,
        window: &tauri::Window,
        token: &str,
        agent: &str,
    ) -> Result<Owner, Failure> {
        self.owner_label(window.label(), token, agent)
    }
    fn owner_label(&self, window: &str, token: &str, agent: &str) -> Result<Owner, Failure> {
        if token.is_empty() || token.len() > 128 || token.chars().any(char::is_control) {
            return Err(Failure::Invalid);
        }
        let state = self.state.lock().map_err(|_| Failure::Unavailable)?;
        let authority = state.windows.get(window).ok_or(Failure::Closed)?.clone();
        if state.closed {
            return Err(Failure::Closed);
        }
        Ok(Owner {
            window: window.to_owned(),
            open_token: token.to_owned(),
            agent: agent.to_owned(),
            authority,
        })
    }
    pub(super) fn current_owner(&self, owner: &Owner) -> bool {
        self.state.lock().is_ok_and(|state| {
            !state.closed
                && state
                    .windows
                    .get(&owner.window)
                    .is_some_and(|authority| Arc::ptr_eq(authority, &owner.authority))
        })
    }
    pub(super) fn cancel_token(
        self: &Arc<Self>,
        window: &tauri::Window,
        token: &str,
    ) -> Result<Cancel, Failure> {
        self.cancel_label_token(window.label(), token)
    }
    fn cancel_label_token(self: &Arc<Self>, window: &str, token: &str) -> Result<Cancel, Failure> {
        if token.is_empty() || token.len() > 128 || token.chars().any(char::is_control) {
            return Err(Failure::Invalid);
        }
        let state = self.state.lock().map_err(|_| Failure::Unavailable)?;
        let entry = state
            .windows
            .get(window)
            .and_then(|authority| {
                state.entries.iter().find(|(_, entry)| {
                    entry.owner.window == window
                        && entry.owner.open_token == token
                        && Arc::ptr_eq(authority, &entry.owner.authority)
                })
            })
            .map(|(id, entry)| (*id, entry.owner.clone()));
        drop(state);
        match entry {
            Some((id, owner)) => self.cancel(id, &owner),
            None => Ok(Cancel::NotFound),
        }
    }
    pub(super) fn close_window(self: &Arc<Self>, window: &str) -> Result<(), Failure> {
        let mut state = self.state.lock().map_err(|_| Failure::Unavailable)?;
        let Some(authority) = state.windows.remove(window) else {
            return Ok(());
        };
        for entry in state.entries.values_mut() {
            if entry.offer == Offer::Reserved && Arc::ptr_eq(&authority, &entry.owner.authority) {
                entry.offer = Offer::Cancelled;
            }
        }
        Self::retire_destroyed_renderer(&mut state, &authority);
        let ids: Vec<_> = state
            .entries
            .iter()
            .filter_map(|(id, entry)| {
                (entry.phase == Phase::Waiting && Arc::ptr_eq(&authority, &entry.owner.authority))
                    .then_some(*id)
            })
            .collect();
        let replies: Vec<_> = ids
            .into_iter()
            .filter_map(|id| Self::take_waiting(&mut state, id).reply)
            .collect();
        let deliveries = self.grant(&mut state);
        drop(state);
        for reply in replies {
            let _ = reply.send(Err(Failure::Cancelled));
        }
        self.deliver(deliveries);
        Ok(())
    }
    #[cfg(test)]
    pub(super) fn counts(&self) -> (usize, usize, usize) {
        let s = self.state.lock().unwrap();
        (s.active, s.waiting, s.retained)
    }
    pub(super) fn enqueue(self: &Arc<Self>, owner: Owner, cost: usize) -> Result<Waiting, Failure> {
        self.enqueue_kind(owner, cost, Offer::Cold)
    }
    pub(super) fn enqueue_prompt(
        self: &Arc<Self>,
        owner: Owner,
        cost: usize,
    ) -> Result<Waiting, Failure> {
        self.enqueue_kind(owner, cost, Offer::Reserved)
    }
    fn enqueue_kind(
        self: &Arc<Self>,
        owner: Owner,
        cost: usize,
        offer: Offer,
    ) -> Result<Waiting, Failure> {
        let policy = self.policy;
        // `cost` MUST include the entire retained request and expected-source
        // snapshot, not just these three labels. No payload copy lives here.
        if cost == 0 || cost > policy.bytes {
            return Err(Failure::Payload);
        }
        let (send, receive) = oneshot::channel();
        let mut s = self.state.lock().map_err(|_| Failure::Unavailable)?;
        if s.closed
            || !s
                .windows
                .get(&owner.window)
                .is_some_and(|authority| Arc::ptr_eq(authority, &owner.authority))
        {
            return Err(Failure::Closed);
        }
        if s.entries
            .values()
            .any(|e| e.owner.window == owner.window && e.owner.open_token == owner.open_token)
        {
            return Err(Failure::Invalid);
        }
        let immediate = s.active < policy.active && s.agents.is_empty();
        if (!immediate && s.waiting >= policy.pending)
            || s.retained
                .checked_add(cost)
                .is_none_or(|n| n > policy.bytes)
        {
            return Err(Failure::Full);
        }
        // Never wrap/reuse operation authority. No terminal-ID map is retained.
        s.next = s
            .next
            .checked_add(1)
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or(Failure::Unavailable)?;
        let id = s.next;
        s.retained += cost;
        s.waiting += 1;
        let agent = owner.agent.clone();
        s.entries.insert(
            id,
            Entry {
                renderer: None,
                offer,
                owner: owner.clone(),
                cost,
                phase: Phase::Waiting,
                reply: Some(send),
            },
        );
        if !s.pending.contains_key(&agent) {
            s.agents.push_back(agent.clone());
        }
        s.pending.entry(agent).or_default().push_back(id);
        let deliveries = self.grant(&mut s);
        let queued = s
            .entries
            .get(&id)
            .is_some_and(|entry| entry.phase == Phase::Waiting);
        drop(s);
        self.deliver(deliveries);
        Ok(Waiting {
            gate: self.clone(),
            owner,
            id,
            queued,
            acquired: false,
            receive: Some(receive),
        })
    }
    // Single lock linearizes enqueue/cancel/grant/release. Never call a Channel,
    // sender, user callback, OS function or await while this lock is held.
    fn grant(&self, s: &mut State) -> Vec<Delivery> {
        let mut ready = Vec::new();
        while !s.closed && s.active < self.policy.active {
            // Remember the last grant even when its queue temporarily emptied.
            // If both agents wait now, do not grant that same agent twice.
            if s.agents.len() > 1 && s.agents.front() == s.last_agent.as_ref() {
                let recent = s.agents.pop_front().expect("two agents");
                s.agents.push_back(recent);
            }
            let Some(agent) = s.agents.pop_front() else {
                break;
            };
            s.last_agent = Some(agent.clone());
            let (id, remains) = {
                let q = s.pending.get_mut(&agent).expect("nonempty agent queue");
                (q.pop_front().expect("one queued operation"), !q.is_empty())
            };
            if remains {
                s.agents.push_back(agent.clone());
            } else {
                s.pending.remove(&agent);
            }
            let e = s.entries.get_mut(&id).expect("registered waiter");
            e.phase = Phase::Granted;
            s.waiting -= 1;
            s.active += 1;
            ready.push((id, e.reply.take().expect("one grant receiver")));
        }
        ready
    }
    fn deliver(self: &Arc<Self>, deliveries: Vec<Delivery>) {
        for (id, send) in deliveries {
            // A lost/unconsumed grant has no started work. Dropping this Slot
            // releases exactly once and advances a survivor outside the lock.
            let _ = send.send(Ok(Permit {
                _slot: Arc::new(Slot {
                    gate: self.clone(),
                    id,
                }),
            }));
        }
    }
    pub(super) fn cancel(self: &Arc<Self>, id: u64, owner: &Owner) -> Result<Cancel, Failure> {
        let mut s = self.state.lock().map_err(|_| Failure::Unavailable)?;
        let Some(e) = s.entries.get(&id).filter(|e| e.owner == *owner) else {
            return Ok(Cancel::NotFound);
        };
        if e.phase == Phase::Granted {
            if e.offer == Offer::Reserved {
                s.entries.get_mut(&id).expect("same locked entry").offer = Offer::Cancelled;
                // Capacity still belongs to its actual last pre-offer Slot;
                // a command already queued in the pump cannot now offer it.
                return Ok(Cancel::CancelledWaiting);
            }
            return Ok(if e.offer == Offer::Cancelled {
                Cancel::CancelledWaiting
            } else {
                Cancel::AlreadyStarting
            });
        }
        let e = Self::take_waiting(&mut s, id);
        let deliveries = self.grant(&mut s);
        drop(s);
        if let Some(send) = e.reply {
            let _ = send.send(Err(Failure::Cancelled));
        }
        self.deliver(deliveries);
        Ok(Cancel::CancelledWaiting)
    }
    fn take_waiting(s: &mut State, id: u64) -> Entry {
        let e = s.entries.remove(&id).expect("registered waiting owner");
        let q = s.pending.get_mut(&e.owner.agent).expect("waiting agent");
        q.retain(|queued| *queued != id);
        if q.is_empty() {
            s.pending.remove(&e.owner.agent);
            s.agents.retain(|a| *a != e.owner.agent);
        }
        s.waiting -= 1;
        s.retained -= e.cost;
        e
    }
    fn release(self: &Arc<Self>, id: u64) {
        self.release_kind(id, false);
    }
    fn release_kind(self: &Arc<Self>, id: u64, confirmed: bool) {
        // A poisoned owner is unknown: do not invent released capacity.
        let Ok(mut s) = self.state.lock() else {
            return;
        };
        let Some(e) = s.entries.get_mut(&id) else {
            return;
        };
        if (e.offer == Offer::Committed) != confirmed {
            return;
        }
        if let Some(renderer) = &mut e.renderer {
            renderer.native_done = true;
            if !renderer.renderer_done {
                return;
            }
        }
        let e = s.entries.remove(&id).expect("same locked entry");
        assert!(e.phase == Phase::Granted);
        s.active -= 1;
        s.retained -= e.cost;
        let deliveries = self.grant(&mut s);
        drop(s);
        self.deliver(deliveries);
    }
    pub(super) fn shutdown(self: &Arc<Self>) -> Result<(), Failure> {
        let mut s = self.state.lock().map_err(|_| Failure::Unavailable)?;
        s.closed = true;
        s.windows.clear();
        for entry in s.entries.values_mut() {
            if entry.offer == Offer::Reserved {
                entry.offer = Offer::Cancelled;
            }
        }
        let ids: Vec<_> = s
            .entries
            .iter()
            .filter_map(|(id, e)| (e.phase == Phase::Waiting).then_some(*id))
            .collect();
        let mut replies = Vec::new();
        for id in ids {
            let e = s.entries.remove(&id).expect("waiting entry");
            s.waiting -= 1;
            s.retained -= e.cost;
            if let Some(send) = e.reply {
                replies.push(send);
            }
        }
        s.agents.clear();
        s.pending.clear();
        // Granted owners remain registered/charged until their real Slot drops.
        drop(s);
        for send in replies {
            let _ = send.send(Err(Failure::Closed));
        }
        Ok(())
    }
}
impl Waiting {
    pub(super) fn queued(&self) -> bool {
        self.queued
    }
    // Server-issued receipt; cancellation still requires the actual Owner.
    pub(super) fn receipt_id(&self) -> u64 {
        self.id
    }
    #[cfg(test)]
    pub(super) fn id(&self) -> u64 {
        self.id
    }
    pub(super) async fn acquire(mut self) -> Result<Permit, Failure> {
        let result = self
            .receive
            .take()
            .expect("one waiter")
            .await
            .map_err(|_| Failure::Unavailable)?;
        self.acquired = result.is_ok();
        result
    }
}
impl Drop for Waiting {
    fn drop(&mut self) {
        if self.acquired {
            return;
        }
        let _ = self.gate.cancel(self.id, &self.owner);
    }
}
impl Drop for Slot {
    fn drop(&mut self) {
        self.gate.release(self.id);
    }
}

// A release capability, not an RAII permit. If all process/observer owners
// disappear without a fact, Drop only destroys this handle. The one existing
// admission entry stays charged (bounded by active policy), with no body,
// lifecycle, process-control or self-reference retained in the queue.
pub(super) struct OfferedSlot {
    gate: Arc<Admission>,
    id: u64,
}
impl OfferedSlot {
    pub(super) fn id(&self) -> u64 {
        self.id
    }
    pub(super) fn release(self) {
        self.gate.release_kind(self.id, true);
    }
}
impl Permit {
    pub(super) fn belongs_to(&self, gate: &Arc<Admission>) -> bool {
        Arc::ptr_eq(&self._slot.gate, gate)
    }
    pub(super) fn commit_prompt(
        &self,
        deadline: tokio::time::Instant,
    ) -> Result<OfferedSlot, Failure> {
        let gate = &self._slot.gate;
        let mut s = gate.state.lock().map_err(|_| Failure::Unavailable)?;
        if s.closed {
            return Err(Failure::Closed);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(Failure::Cancelled);
        }
        let e = s.entries.get(&self._slot.id).ok_or(Failure::Invalid)?;
        if !s
            .windows
            .get(&e.owner.window)
            .is_some_and(|a| Arc::ptr_eq(a, &e.owner.authority))
        {
            return Err(Failure::Closed);
        }
        if e.offer == Offer::Cancelled {
            return Err(Failure::Cancelled);
        }
        if e.phase != Phase::Granted || e.offer != Offer::Reserved {
            return Err(Failure::Invalid);
        }
        s.entries
            .get_mut(&self._slot.id)
            .expect("same locked entry")
            .offer = Offer::Committed;
        Ok(OfferedSlot {
            gate: gate.clone(),
            id: self._slot.id,
        })
    }
}

/// Logical retained-request charge, not an allocator/RSS measurement.
/// Walk all unknown config values iteratively; no JSON/body/config copy or log.
pub(super) struct Charge {
    used: usize,
    limit: usize,
}
impl Charge {
    pub(super) fn new(limit: usize) -> Self {
        Self { used: 0, limit }
    }
    pub(super) fn add(&mut self, amount: usize) -> Result<(), Failure> {
        self.used = self
            .used
            .checked_add(amount)
            .filter(|n| *n <= self.limit)
            .ok_or(Failure::Payload)?;
        Ok(())
    }
    pub(super) fn text(&mut self, value: &str) -> Result<(), Failure> {
        self.add(std::mem::size_of::<String>())?;
        self.add(value.len())
    }
    pub(super) fn json(&mut self, value: &serde_json::Value) -> Result<(), Failure> {
        let mut todo = vec![value];
        while let Some(value) = todo.pop() {
            self.add(std::mem::size_of::<serde_json::Value>())?;
            match value {
                serde_json::Value::String(s) => self.text(s)?,
                serde_json::Value::Number(n) => {
                    // Includes arbitrary-precision storage if another crate ever
                    // enables it; stream to a counter, never stringify/copy it.
                    struct Counter<'a>(&'a mut Charge);
                    impl std::io::Write for Counter<'_> {
                        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                            self.0
                                .add(bytes.len())
                                .map_err(|_| std::io::Error::other("payload"))?;
                            Ok(bytes.len())
                        }
                        fn flush(&mut self) -> std::io::Result<()> {
                            Ok(())
                        }
                    }
                    serde_json::to_writer(Counter(self), n).map_err(|_| Failure::Payload)?;
                }
                serde_json::Value::Array(a) => {
                    // Charge before extending the auxiliary stack.
                    self.add(
                        a.len()
                            .checked_mul(std::mem::size_of::<&serde_json::Value>())
                            .ok_or(Failure::Payload)?,
                    )?;
                    todo.extend(a.iter());
                }
                serde_json::Value::Object(m) => {
                    self.add(
                        m.len()
                            .checked_mul(std::mem::size_of::<&serde_json::Value>())
                            .ok_or(Failure::Payload)?,
                    )?;
                    for (key, value) in m {
                        self.text(key)?;
                        todo.push(value);
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }
    pub(super) fn finish(self) -> usize {
        self.used
    }
}

#[path = "history_delivery.rs"]
mod delivery;
pub use delivery::{Ack as HistoryDeliveryAck, Receipt as HistoryDeliveryReceipt};
#[cfg(test)]
#[path = "history_delivery_tests.rs"]
mod delivery_tests;

#[cfg(test)]
#[path = "history_admission_tests.rs"]
mod tests;
