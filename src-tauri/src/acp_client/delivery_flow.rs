//! An owned, transient delivery queue. Tauri's Channel carries only a small
//! wake-up; one pull may be outstanding per owner. Payload credit is released
//! only by that pull's receipt or real window destruction, never by IPC enqueue.
use super::{delivery_observation::Observation, history_admission::Owner, transient_pressure};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex, Weak},
};
use tauri::{
    AppHandle, Manager as _, Webview, Window,
    ipc::{Channel, InvokeResponseBody, IpcResponse},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Wake {
    farfold_delivery_wake: WakeIdentity,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WakeIdentity {
    queue_id: String,
    open_token: String,
}

#[derive(Default)]
pub(super) struct Registry(Mutex<HashMap<String, Arc<Queue>>>, Mutex<Totals>);
#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    consumed: u64,
    discarded: u64,
    errors: u64,
    transferred_replay: u64,
    transferred_control: u64,
    retired_queued: u64,
    window_destroyed_inflight: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    totals: Totals,
    queued: usize,
    inflight: usize,
    retired_inflight: usize,
}
struct Entry {
    sequence: u64,
    body: String,
    _credit: transient_pressure::Lease,
}
struct Flight {
    sequence: u64,
    _credit: transient_pressure::Lease,
}
#[derive(Default)]
struct State {
    entries: VecDeque<Entry>,
    in_flight: Option<Flight>,
    next: u64,
    notified: bool,
    closed: bool,
    retired: bool,
}
struct Queue {
    id: String,
    token: String,
    owner: Owner,
    channel: Channel<Wake>,
    state: Mutex<State>,
    registry: Weak<Registry>,
    _observation: Arc<Observation>,
    budget: Arc<transient_pressure::Budget>,
}
#[derive(Clone)]
pub(super) struct Sender(Arc<Producer>);
struct Producer {
    queue: Arc<Queue>,
}
impl Drop for Producer {
    fn drop(&mut self) {
        let empty = {
            let mut state = self.queue.state.lock().unwrap_or_else(|e| e.into_inner());
            state.closed = true;
            state.entries.is_empty() && state.next == 0
        };
        if empty {
            self.queue.retire();
        }
    }
}
impl Registry {
    pub(super) fn create(
        self: &Arc<Self>,
        owner: Owner,
        token: String,
        channel: Channel<Wake>,
        observation: Arc<Observation>,
    ) -> Result<Sender, String> {
        self.create_with_budget(
            owner,
            token,
            channel,
            observation,
            transient_pressure::Budget::shared(),
        )
    }
    fn create_with_budget(
        self: &Arc<Self>,
        owner: Owner,
        token: String,
        channel: Channel<Wake>,
        observation: Arc<Observation>,
        budget: Arc<transient_pressure::Budget>,
    ) -> Result<Sender, String> {
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|_| "无法接收对话内容")?;
        let id: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let queue = Arc::new(Queue {
            id: id.clone(),
            token,
            owner,
            channel,
            state: Mutex::default(),
            registry: Arc::downgrade(self),
            _observation: observation,
            budget,
        });
        self.0
            .lock()
            .map_err(|_| "无法接收对话内容")?
            .insert(id, queue.clone());
        Ok(Sender(Arc::new(Producer { queue })))
    }
    fn owned(&self, owner: &Owner, id: &str) -> Option<Arc<Queue>> {
        self.0
            .lock()
            .ok()?
            .get(id)
            .filter(|queue| &queue.owner == owner)
            .cloned()
    }
    pub(super) fn retire_invalid(&self, admission: &super::history_admission::Admission) {
        let queues: Vec<_> = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect();
        for queue in queues {
            if !admission.current_owner(&queue.owner) {
                queue.retire_window();
            }
        }
    }
    pub(super) fn snapshot(&self) -> Snapshot {
        let queues: Vec<_> = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect();
        let mut snapshot = Snapshot {
            totals: *self.1.lock().unwrap_or_else(|e| e.into_inner()),
            queued: 0,
            inflight: 0,
            retired_inflight: 0,
        };
        for queue in queues {
            let state = queue.state.lock().unwrap_or_else(|e| e.into_inner());
            snapshot.queued += state.entries.len();
            snapshot.inflight += usize::from(state.in_flight.is_some());
            snapshot.retired_inflight += usize::from(state.retired && state.in_flight.is_some());
        }
        snapshot
    }
}
impl Sender {
    pub(super) fn send(&self, body: String) -> tauri::Result<()> {
        let queue = &self.0.queue;
        let notify = {
            let mut state = queue.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.retired || state.closed {
                return Err(std::io::Error::other("delivery retired").into());
            }
            let sequence = state
                .next
                .checked_add(1)
                .ok_or_else(|| std::io::Error::other("delivery counter exhausted"))?;
            state.next = sequence;
            let credit = queue.budget.hold(body.len());
            state.entries.push_back(Entry {
                sequence,
                body,
                _credit: credit,
            });
            let notify = !state.notified;
            state.notified = true;
            notify
        };
        if notify {
            let sent = queue.channel.send(Wake {
                farfold_delivery_wake: WakeIdentity {
                    queue_id: queue.id.clone(),
                    open_token: queue.token.clone(),
                },
            });
            if sent.is_err() {
                queue.retire();
            }
            sent
        } else {
            Ok(())
        }
    }
}
impl Queue {
    fn pull(&self) -> Result<Pulled, String> {
        let mut state = self.state.lock().map_err(|_| "无法接收对话内容")?;
        if state.retired {
            return Err("对话内容接收已结束".into());
        }
        // Repeating an uncertain pull could apply the same event twice. It is
        // never a retry mechanism: the caller must retire the failed delivery.
        if state.in_flight.is_some() {
            return Err("上一份内容尚未确认接收".into());
        }
        let Some(entry) = state.entries.front() else {
            state.notified = false;
            return Ok(Pulled(None));
        };
        let sequence = entry.sequence;
        let body = entry.body.clone();
        state.in_flight = Some(Flight {
            sequence,
            _credit: self.budget.hold(body.len()),
        });
        Ok(Pulled(Some((sequence, body))))
    }
    fn acknowledge(&self, receipt: Receipt) -> bool {
        let retired = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if state
                .in_flight
                .as_ref()
                .map(|flight| flight.sequence.to_string())
                .as_deref()
                != Some(receipt.sequence.as_str())
            {
                return false;
            }
            // Outcomes describe transport ownership, not task success. Buffered
            // history and queued fork-result work remain in their original owner.
            state.in_flight = None;
            state.entries.pop_front();
            state.retired
        };
        self.totals(|totals| {
            let count = match receipt.outcome {
                Outcome::Consumed => &mut totals.consumed,
                Outcome::Discarded => &mut totals.discarded,
                Outcome::Error => &mut totals.errors,
                Outcome::TransferredReplay => &mut totals.transferred_replay,
                Outcome::TransferredControl => &mut totals.transferred_control,
            };
            *count = count.saturating_add(1);
        });
        if retired {
            self.remove();
        }
        true
    }
    fn retire(&self) {
        let (count, inflight) = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.retired {
                return;
            }
            state.retired = true;
            let count = state.entries.len();
            state.entries.clear();
            (count, state.in_flight.is_some())
        };
        self.totals(|totals| {
            totals.retired_queued = totals.retired_queued.saturating_add(count as u64)
        });
        // A returned invoke body may still be in transit. Logical disposal
        // retires the original queue, but cannot claim that copy disappeared.
        if !inflight {
            self.remove();
        }
    }
    fn retire_window(&self) {
        self.retire();
        let had_flight = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .in_flight
            .take()
            .is_some();
        if had_flight {
            self.totals(|totals| {
                totals.window_destroyed_inflight =
                    totals.window_destroyed_inflight.saturating_add(1)
            });
        }
        self.remove();
    }
    fn totals(&self, update: impl FnOnce(&mut Totals)) {
        if let Some(registry) = self.registry.upgrade() {
            update(&mut registry.1.lock().unwrap_or_else(|e| e.into_inner()));
        }
    }
    fn remove(&self) {
        if let Some(registry) = self.registry.upgrade() {
            let mut entries = registry.0.lock().unwrap_or_else(|e| e.into_inner());
            if entries
                .get(&self.id)
                .is_some_and(|queue| std::ptr::eq(queue.as_ref(), self))
            {
                entries.remove(&self.id);
            }
        }
    }
}
pub struct Pulled(Option<(u64, String)>);
impl IpcResponse for Pulled {
    fn body(self) -> tauri::Result<InvokeResponseBody> {
        // The event string was already serialized by the observation envelope;
        // no parse/normalize cycle changes unknown Agent content.
        Ok(InvokeResponseBody::Json(match self.0 {
            Some((sequence, body)) => format!("{{\"sequence\":\"{sequence}\",\"event\":{body}}}"),
            None => "null".into(),
        }))
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    sequence: String,
    outcome: Outcome,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Outcome {
    Consumed,
    Discarded,
    Error,
    TransferredReplay,
    TransferredControl,
}
fn owner(
    manager: &super::manager::AcpManager,
    webview: &Webview,
    window: &Window,
    agent: &str,
    token: &str,
) -> Result<Owner, String> {
    if !crate::browser_workspace::caller_allowed(webview) {
        return Err("请从主界面操作".into());
    }
    manager
        .history_admission
        .owner(window, token, agent)
        .map_err(super::cold_history_open::error)
}
#[tauri::command]
pub fn session_delivery_pull(
    app: AppHandle,
    webview: Webview,
    window: Window,
    agent_id: String,
    open_token: String,
    queue_id: String,
) -> Result<Pulled, String> {
    let manager = app.state::<super::manager::AcpManager>();
    let owner = owner(&manager, &webview, &window, &agent_id, &open_token)?;
    let queue = manager
        .delivery_observations
        .1
        .owned(&owner, &queue_id)
        .ok_or("对话内容接收已结束")?;
    queue.pull()
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn session_delivery_ack(
    app: AppHandle,
    webview: Webview,
    window: Window,
    agent_id: String,
    open_token: String,
    queue_id: String,
    receipt: Receipt,
) -> Result<bool, String> {
    let manager = app.state::<super::manager::AcpManager>();
    let owner = owner(&manager, &webview, &window, &agent_id, &open_token)?;
    Ok(manager
        .delivery_observations
        .1
        .owned(&owner, &queue_id)
        .is_some_and(|queue| queue.acknowledge(receipt)))
}
#[tauri::command]
pub fn session_delivery_retire(
    app: AppHandle,
    webview: Webview,
    window: Window,
    agent_id: String,
    open_token: String,
    queue_id: String,
) -> Result<bool, String> {
    let manager = app.state::<super::manager::AcpManager>();
    let owner = owner(&manager, &webview, &window, &agent_id, &open_token)?;
    if let Some(queue) = manager.delivery_observations.1.owned(&owner, &queue_id) {
        queue.retire();
        Ok(true)
    } else {
        Ok(false)
    }
}

#[cfg(test)]
#[path = "delivery_flow_tests.rs"]
mod tests;
