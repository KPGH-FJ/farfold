//! Content-free IPC delivery samples, not transport admission or a memory cap.
//! Each actual sink owns at most one unacknowledged sample. No event is retained.
use super::{history_admission::Owner, manager::AcpManager};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
    time::Instant,
};
use tauri::{
    AppHandle, Manager as _, Webview, Window,
    ipc::{Channel, InvokeResponseBody, IpcResponse},
};

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    events: u64,
    serialized_bytes: u64,
    samples: u64,
    consumed_samples: u64,
    discarded_samples: u64,
    consumer_error_samples: u64,
    unacknowledged_retired_samples: u64,
    send_failures: u64,
    latency_micros_total: u64,
    latency_micros_max: u64,
}
impl Totals {
    fn add(&mut self, other: &Self) {
        macro_rules! sum { ($($name:ident),*) => { $(self.$name = self.$name.saturating_add(other.$name);)* }; }
        sum!(
            events,
            serialized_bytes,
            samples,
            consumed_samples,
            discarded_samples,
            consumer_error_samples,
            unacknowledged_retired_samples,
            send_failures,
            latency_micros_total
        );
        self.latency_micros_max = self.latency_micros_max.max(other.latency_micros_max);
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    totals: Totals,
    live_owners: usize,
    pending_samples: usize,
    oldest_pending_millis: u64,
}
#[derive(Default)]
struct RegistryState {
    owners: HashMap<String, Registered>,
    retired: Totals,
}
struct Registered {
    observation: Weak<Observation>,
    state: Arc<Mutex<State>>,
}
#[derive(Default)]
pub(super) struct Registry(Mutex<RegistryState>);
struct Pending {
    id: u64,
    sequence: u64,
    started: Instant,
}
#[derive(Default)]
struct State {
    totals: Totals,
    pending: Option<Pending>,
    retired: bool,
}
pub(super) struct Observation {
    id: String,
    owner: Owner,
    token: String,
    state: Arc<Mutex<State>>,
    registry: Weak<Registry>,
}
impl Registry {
    fn create(self: &Arc<Self>, owner: Owner, token: String) -> Result<Arc<Observation>, String> {
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|_| "无法核对界面接收状态")?;
        let id = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let observation = Arc::new(Observation {
            id,
            owner,
            token,
            state: Arc::new(Mutex::new(State::default())),
            registry: Arc::downgrade(self),
        });
        self.0
            .lock()
            .map_err(|_| "无法核对界面接收状态")?
            .owners
            .insert(
                observation.id.clone(),
                Registered {
                    observation: Arc::downgrade(&observation),
                    state: observation.state.clone(),
                },
            );
        Ok(observation)
    }
    fn owners(&self) -> Vec<Arc<Observation>> {
        self.0
            .lock()
            .map(|state| {
                state
                    .owners
                    .values()
                    .filter_map(|entry| entry.observation.upgrade())
                    .collect()
            })
            .unwrap_or_default()
    }
    pub(super) fn retire_invalid(&self, admission: &super::history_admission::Admission) {
        for observation in self.owners() {
            if !admission.current_owner(&observation.owner) {
                observation.retire();
            }
        }
    }
    fn snapshot(&self) -> Snapshot {
        let registry = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let mut snapshot = Snapshot {
            totals: registry.retired,
            live_owners: 0,
            pending_samples: 0,
            oldest_pending_millis: 0,
        };
        // Registry -> state is also retirement's lock order. Holding only state
        // separately never acquires the registry. Entries retain counters, not
        // their sink: an owner currently dropping is still counted exactly once.
        for entry in registry.owners.values() {
            let state = entry.state.lock().unwrap_or_else(|e| e.into_inner());
            snapshot.live_owners += 1;
            snapshot.totals.add(&state.totals);
            if let Some(pending) = &state.pending {
                snapshot.pending_samples += 1;
                snapshot.oldest_pending_millis = snapshot
                    .oldest_pending_millis
                    .max(pending.started.elapsed().as_millis().min(u64::MAX as u128) as u64);
            }
        }
        snapshot
    }
    fn acknowledge(&self, owner: &Owner, receipt: Receipt) -> Result<bool, String> {
        let observation = self
            .0
            .lock()
            .map_err(|_| "无法核对界面接收状态")?
            .owners
            .get(&receipt.observer_id)
            .and_then(|entry| entry.observation.upgrade());
        let Some(observation) = observation else {
            return Ok(false);
        };
        if &observation.owner != owner {
            return Ok(false);
        }
        let mut state = observation
            .state
            .lock()
            .map_err(|_| "无法核对界面接收状态")?;
        if state.retired {
            return Ok(false);
        }
        let Some(pending) = &state.pending else {
            return Ok(false);
        };
        if receipt.sample_id != pending.id.to_string()
            || receipt.sequence != pending.sequence.to_string()
        {
            return Ok(false);
        }
        let elapsed = pending.started.elapsed().as_micros().min(u64::MAX as u128) as u64;
        state.pending = None;
        match receipt.outcome {
            Outcome::Consumed => {
                state.totals.consumed_samples = state.totals.consumed_samples.saturating_add(1)
            }
            Outcome::Discarded => {
                state.totals.discarded_samples = state.totals.discarded_samples.saturating_add(1)
            }
            Outcome::Error => {
                state.totals.consumer_error_samples =
                    state.totals.consumer_error_samples.saturating_add(1)
            }
        }
        state.totals.latency_micros_total =
            state.totals.latency_micros_total.saturating_add(elapsed);
        state.totals.latency_micros_max = state.totals.latency_micros_max.max(elapsed);
        Ok(true)
    }
}
impl Observation {
    fn retire(&self) {
        let Some(registry) = self.registry.upgrade() else {
            return;
        };
        let mut registry = registry.0.lock().unwrap_or_else(|e| e.into_inner());
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.retired {
            return;
        }
        state.retired = true;
        if state.pending.take().is_some() {
            state.totals.unacknowledged_retired_samples = state
                .totals
                .unacknowledged_retired_samples
                .saturating_add(1);
        }
        // Random IDs do not substitute for exact-object retirement.
        if registry
            .owners
            .get(&self.id)
            .is_some_and(|entry| std::ptr::eq(entry.observation.as_ptr(), self))
        {
            registry.owners.remove(&self.id);
            registry.retired.add(&state.totals);
        }
    }
}
impl Drop for Observation {
    fn drop(&mut self) {
        self.retire();
    }
}

/// Serialized once by Tauri. Counting uses that exact string's length, not a
/// second serialization, raw-body log, or estimate of allocator/renderer memory.
pub struct DeliveryEvent {
    event: Value,
    observation: Arc<Observation>,
}
impl IpcResponse for DeliveryEvent {
    fn body(self) -> tauri::Result<InvokeResponseBody> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Stamp<'a> {
            open_token: &'a str,
            observer_id: &'a str,
            sequence: String,
            #[serde(skip_serializing_if = "Option::is_none")]
            sample_id: Option<String>,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Envelope<'a> {
            farfold_delivery: Stamp<'a>,
            event: Value,
        }
        let mut state = self
            .observation
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let sequence = state.totals.events.saturating_add(1);
        let sample_id = if !state.retired
            && state.pending.is_none()
            && state.totals.samples < u64::MAX
            && state.totals.events < u64::MAX
        {
            let id = state.totals.samples.saturating_add(1);
            state.totals.samples = id;
            state.pending = Some(Pending {
                id,
                sequence,
                started: Instant::now(),
            });
            Some(id.to_string())
        } else {
            None
        };
        let body = serde_json::to_string(&Envelope {
            farfold_delivery: Stamp {
                open_token: &self.observation.token,
                observer_id: &self.observation.id,
                sequence: sequence.to_string(),
                sample_id,
            },
            event: self.event,
        })?;
        if !state.retired {
            state.totals.events = sequence;
            state.totals.serialized_bytes = state
                .totals
                .serialized_bytes
                .saturating_add(body.len() as u64);
        }
        Ok(InvokeResponseBody::Json(body))
    }
}

#[derive(Clone)]
pub(super) enum DeliveryChannel {
    Observed(Channel<DeliveryEvent>, Arc<Observation>),
    // Existing internal non-WebView callers retain their exact event surface.
    Direct(Channel<Value>),
}
impl From<Channel<Value>> for DeliveryChannel {
    fn from(channel: Channel<Value>) -> Self {
        Self::Direct(channel)
    }
}
impl DeliveryChannel {
    pub(super) fn new(
        manager: &AcpManager,
        window: &Window,
        agent: &str,
        token: &str,
        channel: Channel<DeliveryEvent>,
    ) -> Result<Self, String> {
        let owner = manager
            .history_admission
            .owner(window, token, agent)
            .map_err(super::cold_history_open::error)?;
        let observation = manager
            .delivery_observations
            .create(owner, token.to_owned())?;
        Ok(Self::Observed(channel, observation))
    }
    pub(super) fn send(&self, event: Value) -> tauri::Result<()> {
        match self {
            Self::Direct(channel) => channel.send(event),
            Self::Observed(channel, observation) => {
                let result = channel.send(DeliveryEvent {
                    event,
                    observation: observation.clone(),
                });
                if result.is_err()
                    && let Ok(mut state) = observation.state.lock()
                    && !state.retired
                {
                    state.totals.send_failures = state.totals.send_failures.saturating_add(1);
                }
                result
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    observer_id: String,
    sample_id: String,
    sequence: String,
    outcome: Outcome,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Outcome {
    Consumed,
    Discarded,
    Error,
}

#[tauri::command]
pub fn session_delivery_observation_ack(
    app: AppHandle,
    webview: Webview,
    window: Window,
    agent_id: String,
    open_token: String,
    receipt: Receipt,
) -> Result<bool, String> {
    if !crate::browser_workspace::caller_allowed(&webview) {
        return Err("请从主界面操作".into());
    }
    let manager = app.state::<AcpManager>();
    let owner = manager
        .history_admission
        .owner(&window, &open_token, &agent_id)
        .map_err(super::cold_history_open::error)?;
    manager.delivery_observations.acknowledge(&owner, receipt)
}
#[tauri::command]
pub fn session_delivery_observation_snapshot(
    app: AppHandle,
    webview: Webview,
) -> Result<Snapshot, String> {
    if !crate::browser_workspace::caller_allowed(&webview) {
        return Err("请从主界面操作".into());
    }
    let manager = app.state::<AcpManager>();
    manager
        .delivery_observations
        .retire_invalid(&manager.history_admission);
    Ok(manager.delivery_observations.snapshot())
}

#[cfg(test)]
#[path = "delivery_observation_tests.rs"]
mod tests;
