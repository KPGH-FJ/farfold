use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{State, ipc::Channel};

use crate::host_ids::{ConnectionId, RuntimeBuildId};
use crate::interaction_registry::{InteractionRegistry, InteractionSnapshot};
use crate::live_session_projection::{LiveSessionProjection, RuntimeProjectionSnapshot};
use crate::runtime_registry::{RuntimeBinding, RuntimeIdentity};
use crate::turn_coordinator::TurnCoordinator;

const DEFAULT_EVENT_CAPACITY: usize = 2_048;
const MAX_SNAPSHOT_EVENTS: usize = 512;
const MAX_NATIVE_EVENT_BYTES: usize = 1024 * 1024;
static ROUTER_INSTANCE: AtomicU64 = AtomicU64::new(0);

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EventPreservation {
    Native,
    OversizedDropped,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoutedRuntimeEvent {
    stream_id: String,
    sequence: u64,
    runtime: RuntimeIdentity,
    runtime_build_id: RuntimeBuildId,
    connection_id: ConnectionId,
    runtime_generation: Option<u64>,
    kind: String,
    native_envelope: Value,
    preservation: EventPreservation,
    received_at_ms: u64,
}

impl RoutedRuntimeEvent {
    pub(crate) fn matches_binding(&self, binding: &RuntimeBinding) -> bool {
        self.runtime == binding.identity()
            && self.runtime_build_id == binding.runtime_build_id
            && self.connection_id == binding.connection_id
    }

    pub(crate) fn binding(&self) -> Result<RuntimeBinding, String> {
        Ok(RuntimeBinding {
            product_id: crate::host_ids::RuntimeProductId::parse(&self.runtime.product_id)
                .map_err(|e| e.to_string())?,
            installation_id: crate::host_ids::InstallationId::parse(&self.runtime.installation_id)
                .map_err(|e| e.to_string())?,
            adapter_id: crate::host_ids::AdapterId::parse(&self.runtime.adapter_id)
                .map_err(|e| e.to_string())?,
            runtime_build_id: self.runtime_build_id.clone(),
            connection_id: self.connection_id.clone(),
        })
    }

    pub(crate) fn sequence(&self) -> u64 {
        self.sequence
    }

    pub(crate) fn runtime(&self) -> &RuntimeIdentity {
        &self.runtime
    }

    pub(crate) fn runtime_generation(&self) -> Option<u64> {
        self.runtime_generation
    }

    pub(crate) fn kind(&self) -> &str {
        &self.kind
    }

    pub(crate) fn native_envelope(&self) -> &Value {
        &self.native_envelope
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SequenceGap {
    requested_after: u64,
    oldest_available: u64,
    latest_sequence: u64,
    dropped_total: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventBatch {
    stream_id: String,
    requested_after: Option<u64>,
    oldest_available: Option<u64>,
    latest_sequence: u64,
    next_after: u64,
    has_more: bool,
    gap: Option<SequenceGap>,
    events: Vec<RoutedRuntimeEvent>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RuntimeEventDelivery {
    State {
        #[serde(rename = "streamId")]
        stream_id: String,
        #[serde(rename = "latestSequence")]
        latest_sequence: u64,
        #[serde(rename = "liveProjections")]
        live_projections: Vec<RuntimeProjectionSnapshot>,
        #[serde(rename = "pendingInteractions")]
        pending_interactions: Vec<InteractionSnapshot>,
    },
    Ready {
        snapshot: RuntimeEventBatch,
        #[serde(rename = "liveProjections")]
        live_projections: Vec<RuntimeProjectionSnapshot>,
        #[serde(rename = "pendingInteractions")]
        pending_interactions: Vec<InteractionSnapshot>,
    },
    Event {
        event: Box<RoutedRuntimeEvent>,
        projection: Option<RuntimeProjectionSnapshot>,
        #[serde(rename = "pendingInteractions")]
        pending_interactions: Vec<InteractionSnapshot>,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventSubscription {
    subscription_id: u32,
    stream_id: String,
    latest_sequence: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventCursor {
    stream_id: String,
    latest_sequence: u64,
    oldest_available: Option<u64>,
    dropped_total: u64,
}

struct RouterState {
    stream_id: String,
    next_sequence: u64,
    dropped_total: u64,
    events: VecDeque<RoutedRuntimeEvent>,
    subscribers: HashMap<u32, Channel<RuntimeEventDelivery>>,
}

#[derive(Clone)]
pub struct RuntimeEventRouter {
    capacity: usize,
    projection: Option<LiveSessionProjection>,
    interactions: Option<InteractionRegistry>,
    turns: Option<TurnCoordinator>,
    state: Arc<Mutex<RouterState>>,
}

impl Default for RuntimeEventRouter {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_EVENT_CAPACITY)
    }
}

impl RuntimeEventRouter {
    pub(crate) fn shares_stream_with(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.state, &other.state)
    }

    fn with_capacity(capacity: usize) -> Self {
        Self::with_capacity_and_observers(capacity, None, None)
    }

    pub(crate) fn with_capacity_and_observers(
        capacity: usize,
        projection: Option<LiveSessionProjection>,
        interactions: Option<InteractionRegistry>,
    ) -> Self {
        Self::with_capacity_and_all_observers(capacity, projection, interactions, None)
    }

    pub(crate) fn with_capacity_and_all_observers(
        capacity: usize,
        projection: Option<LiveSessionProjection>,
        interactions: Option<InteractionRegistry>,
        turns: Option<TurnCoordinator>,
    ) -> Self {
        let instance = ROUTER_INSTANCE.fetch_add(1, Ordering::Relaxed);
        Self {
            capacity: capacity.max(1),
            projection,
            interactions,
            turns,
            state: Arc::new(Mutex::new(RouterState {
                stream_id: format!("host-{}-{}-{instance}", std::process::id(), now_millis()),
                next_sequence: 0,
                dropped_total: 0,
                events: VecDeque::with_capacity(capacity.max(1)),
                subscribers: HashMap::new(),
            })),
        }
    }

    pub(crate) fn with_all_observers(
        projection: LiveSessionProjection,
        interactions: InteractionRegistry,
        turns: TurnCoordinator,
    ) -> Self {
        Self::with_capacity_and_all_observers(
            DEFAULT_EVENT_CAPACITY,
            Some(projection),
            Some(interactions),
            Some(turns),
        )
    }

    // Only the lifecycle owner calls this after the previous connection has
    // stopped and a new process has initialized. Events cannot replace identity.
    pub(crate) fn activate_connection(
        &self,
        binding: RuntimeBinding,
        generation: u64,
    ) -> Result<(), String> {
        if let Some(projection) = &self.projection {
            projection.activate_connection(binding.clone(), generation)?;
        }
        if let Some(interactions) = &self.interactions
            && let Err(error) = interactions.activate_connection(binding.clone(), generation)
        {
            if let Some(projection) = &self.projection {
                projection.connection_activation_failed(&binding);
            }
            return Err(error);
        }
        Ok(())
    }

    pub(crate) fn route_acp(
        &self,
        binding: RuntimeBinding,
        generation: u64,
        transport: &crate::acp_transport::AcpTransport,
        payload: Value,
    ) -> Result<u64, String> {
        let pi = binding.product_id.as_str() == "pi"
            && binding.adapter_id.as_str() == crate::pi_acp_interactions::PI_ACP_ADAPTER_ID;
        let prepared = if pi {
            crate::pi_acp_interactions::before_route(
                self.interactions.as_ref(),
                transport,
                &binding,
                generation,
                &payload,
            )
        } else {
            Ok(())
        };
        let routed = self.route(
            binding.clone(),
            json!({"generation":generation,"kind":"acp","payload":payload}),
        );
        let result = prepared.and(routed);
        if pi && result.is_err() && transport.stop().is_ok() {
            let _ = self.route(binding, json!({"generation":generation,"kind":"lifecycle","payload":{"state":"terminated"}}));
        }
        result
    }

    pub(crate) fn route(
        &self,
        definition: impl Into<RuntimeBinding>,
        native_envelope: Value,
    ) -> Result<u64, String> {
        let definition = definition.into();
        if let Some(projection) = &self.projection {
            projection.register(definition.clone())?;
        }
        let runtime_generation = native_envelope.get("generation").and_then(Value::as_u64);
        let native_kind = native_envelope
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let native_bytes = serde_json::to_vec(&native_envelope)
            .map_err(|error| format!("Cannot size Runtime event envelope: {error}"))?;
        let (kind, native_envelope, preservation) = if native_bytes.len() <= MAX_NATIVE_EVENT_BYTES
        {
            (native_kind, native_envelope, EventPreservation::Native)
        } else {
            (
                "oversized_event".to_string(),
                json!({
                    "originalKind": native_kind,
                    "byteLength": native_bytes.len(),
                    "reason": "native_envelope_exceeds_host_limit"
                }),
                EventPreservation::OversizedDropped,
            )
        };
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Runtime event router is unavailable".to_string())?;
        state.next_sequence = state.next_sequence.saturating_add(1);
        let sequence = state.next_sequence;
        let event = RoutedRuntimeEvent {
            stream_id: state.stream_id.clone(),
            sequence,
            runtime: definition.identity(),
            runtime_build_id: definition.runtime_build_id.clone(),
            connection_id: definition.connection_id.clone(),
            runtime_generation,
            kind,
            native_envelope,
            preservation,
            received_at_ms: now_millis(),
        };
        if state.events.len() == self.capacity {
            state.events.pop_front();
            state.dropped_total = state.dropped_total.saturating_add(1);
        }
        state.events.push_back(event.clone());
        let projection_result = self
            .projection
            .as_ref()
            .map(|projection| projection.apply(&event))
            .transpose();
        let projection_snapshot = if projection_result.is_ok() {
            self.projection
                .as_ref()
                .map(|projection| projection.snapshot_for(definition))
                .transpose()?
        } else {
            None
        };
        let interaction_result = self
            .interactions
            .as_ref()
            .map(|interactions| interactions.apply(&event))
            .transpose();
        let pending_interactions = if interaction_result.is_ok() {
            self.interactions
                .as_ref()
                .map(InteractionRegistry::snapshots)
                .transpose()?
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let turn_result = self
            .turns
            .as_ref()
            .map(|turns| turns.apply(&event))
            .transpose();
        let delivery = RuntimeEventDelivery::Event {
            event: Box::new(event),
            projection: projection_snapshot,
            pending_interactions,
        };
        state
            .subscribers
            .retain(|_, channel| channel.send(delivery.clone()).is_ok());
        projection_result?;
        interaction_result?;
        turn_result?;
        Ok(sequence)
    }

    fn snapshot_locked(
        state: &RouterState,
        after_sequence: Option<u64>,
        requested_limit: Option<usize>,
    ) -> RuntimeEventBatch {
        let limit = requested_limit
            .unwrap_or(MAX_SNAPSHOT_EVENTS)
            .clamp(1, MAX_SNAPSHOT_EVENTS);
        let oldest_available = state.events.front().map(|event| event.sequence);
        let baseline = after_sequence.unwrap_or_else(|| {
            oldest_available
                .unwrap_or(state.next_sequence.saturating_add(1))
                .saturating_sub(1)
        });
        let gap = after_sequence.and_then(|requested_after| {
            oldest_available
                .filter(|oldest| requested_after.saturating_add(1) < *oldest)
                .map(|oldest| SequenceGap {
                    requested_after,
                    oldest_available: oldest,
                    latest_sequence: state.next_sequence,
                    dropped_total: state.dropped_total,
                })
        });
        let effective_after = gap
            .as_ref()
            .map(|gap| gap.oldest_available.saturating_sub(1))
            .unwrap_or(baseline);
        let events = state
            .events
            .iter()
            .filter(|event| event.sequence > effective_after)
            .take(limit)
            .cloned()
            .collect::<Vec<_>>();
        let next_after = events
            .last()
            .map(|event| event.sequence)
            .unwrap_or(effective_after);
        RuntimeEventBatch {
            stream_id: state.stream_id.clone(),
            requested_after: after_sequence,
            oldest_available,
            latest_sequence: state.next_sequence,
            next_after,
            has_more: next_after < state.next_sequence,
            gap,
            events,
        }
    }

    pub(crate) fn snapshot(
        &self,
        after_sequence: Option<u64>,
        requested_limit: Option<usize>,
    ) -> Result<RuntimeEventBatch, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Runtime event router is unavailable".to_string())?;
        Ok(Self::snapshot_locked(
            &state,
            after_sequence,
            requested_limit,
        ))
    }

    pub(crate) fn subscribe(
        &self,
        channel: Channel<RuntimeEventDelivery>,
        after_sequence: Option<u64>,
        limit: Option<usize>,
    ) -> Result<RuntimeEventSubscription, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Runtime event router is unavailable".to_string())?;
        let snapshot = Self::snapshot_locked(&state, after_sequence, limit);
        let live_projections = self
            .projection
            .as_ref()
            .map(LiveSessionProjection::snapshots)
            .transpose()?
            .unwrap_or_default();
        let pending_interactions = self
            .interactions
            .as_ref()
            .map(InteractionRegistry::snapshots)
            .transpose()?
            .unwrap_or_default();
        channel
            .send(RuntimeEventDelivery::Ready {
                snapshot: snapshot.clone(),
                live_projections,
                pending_interactions,
            })
            .map_err(|error| format!("Cannot open Runtime event channel: {error}"))?;
        let subscription = RuntimeEventSubscription {
            subscription_id: channel.id(),
            stream_id: state.stream_id.clone(),
            latest_sequence: state.next_sequence,
        };
        state.subscribers.insert(channel.id(), channel);
        Ok(subscription)
    }

    // Publish reconciled Host state without inventing a native event or advancing its cursor.
    pub(crate) fn publish_state(&self) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Runtime event router is unavailable".to_string())?;
        let delivery = RuntimeEventDelivery::State {
            stream_id: state.stream_id.clone(),
            latest_sequence: state.next_sequence,
            live_projections: self
                .projection
                .as_ref()
                .map(LiveSessionProjection::snapshots)
                .transpose()?
                .unwrap_or_default(),
            pending_interactions: self
                .interactions
                .as_ref()
                .map(InteractionRegistry::snapshots)
                .transpose()?
                .unwrap_or_default(),
        };
        state
            .subscribers
            .retain(|_, channel| channel.send(delivery.clone()).is_ok());
        Ok(())
    }

    pub(crate) fn cursor(&self) -> Result<RuntimeEventCursor, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Runtime event router is unavailable".to_string())?;
        Ok(RuntimeEventCursor {
            stream_id: state.stream_id.clone(),
            latest_sequence: state.next_sequence,
            oldest_available: state.events.front().map(|event| event.sequence),
            dropped_total: state.dropped_total,
        })
    }

    pub(crate) fn unsubscribe(&self, subscription_id: u32) -> Result<bool, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Runtime event router is unavailable".to_string())?;
        Ok(state.subscribers.remove(&subscription_id).is_some())
    }
}

#[tauri::command]
pub fn runtime_event_snapshot(
    router: State<'_, RuntimeEventRouter>,
    after_sequence: Option<u64>,
    limit: Option<usize>,
) -> Result<RuntimeEventBatch, String> {
    router.snapshot(after_sequence, limit)
}

#[cfg(test)]
mod tests {
    #[test]
    fn acp_managed_connection_activation_replaces_only_older_generation() {
        use crate::{host_ids::*, runtime_registry::RuntimeBinding};
        let projection = super::LiveSessionProjection::default();
        let interactions = super::InteractionRegistry::default();
        let router = super::RuntimeEventRouter::with_capacity_and_observers(
            16,
            Some(projection.clone()),
            Some(interactions.clone()),
        );
        let first = RuntimeBinding {
            product_id: RuntimeProductId::parse("opencode").unwrap(),
            installation_id: InstallationId::parse("acp-shared-install").unwrap(),
            runtime_build_id: RuntimeBuildId::parse("acp-fixed-build").unwrap(),
            adapter_id: AdapterId::parse("opencode-acp-stdio-v1").unwrap(),
            connection_id: ConnectionId::parse("native-connection").unwrap(),
        };
        let mut managed = first.clone();
        managed.connection_id = ConnectionId::parse("managed-connection").unwrap();
        let question = |generation| {
            serde_json::json!({
                "generation":generation,"kind":"acp","payload":{
                    "jsonrpc":"2.0","id":"same-question","method":"elicitation/create",
                    "params":{"sessionId":"ses_qa","message":"Choose","mode":"form",
                        "requestedSchema":{"type":"object","properties":{}}}
                }
            })
        };
        router.activate_connection(first.clone(), 1).unwrap();
        router.route(first.clone(), question(1)).unwrap();
        assert_eq!(interactions.snapshots().unwrap().len(), 1);
        assert!(router.activate_connection(managed.clone(), 1).is_err());
        assert!(router.route(managed.clone(), question(2)).is_err());
        router.activate_connection(managed.clone(), 2).unwrap();
        assert!(interactions.snapshots().unwrap().is_empty());
        assert!(router.route(first.clone(), question(1)).is_err());
        assert!(
            interactions
                .begin_response(first, 1, "same-question", Some("ses_qa"))
                .is_err()
        );
        router.route(managed.clone(), question(2)).unwrap();
        interactions
            .begin_response(managed.clone(), 2, "same-question", Some("ses_qa"))
            .unwrap();
        assert_eq!(
            serde_json::to_value(projection.snapshot_for(managed.clone()).unwrap()).unwrap()["runtimeGeneration"],
            2
        );
        let temporary = tempfile::tempdir().unwrap();
        let store = crate::host_store::HostStore::open(temporary.path().join("host.sqlite3"));
        interactions.attach_host_store(store.clone()).unwrap();
        let maintenance_token = "a".repeat(64);
        store.begin_maintenance(&maintenance_token).unwrap();
        let mut next = managed.clone();
        next.connection_id = ConnectionId::parse("next-managed-connection").unwrap();
        assert!(router.activate_connection(next.clone(), 3).is_err());
        let failed = serde_json::to_value(projection.snapshot_for(next.clone()).unwrap()).unwrap();
        assert_eq!(failed["confidence"], "reconciliation_required");
        assert_eq!(failed["activity"], "degraded");
        assert!(interactions.snapshots().unwrap().is_empty());
        assert!(
            interactions
                .begin_response(managed, 2, "same-question", Some("ses_qa"))
                .is_err()
        );
        store.end_maintenance(&maintenance_token).unwrap();
        router.activate_connection(next.clone(), 4).unwrap();
        router.route(next.clone(), question(4)).unwrap();
        interactions
            .begin_response(next, 4, "same-question", Some("ses_qa"))
            .unwrap();
    }

    #[test]
    fn dynamic_provenance_preserves_native_data_without_falling_back_to_pi() {
        use crate::{
            host_ids::*, live_session_projection::RuntimeActivity, runtime_registry::RuntimeBinding,
        };
        let projection = super::LiveSessionProjection::default();
        let router = super::RuntimeEventRouter::with_capacity_and_observers(
            8,
            Some(projection.clone()),
            Some(super::InteractionRegistry::default()),
        );
        let binding = RuntimeBinding {
            product_id: RuntimeProductId::parse("codex").unwrap(),
            installation_id: InstallationId::parse("system-installation-fixture").unwrap(),
            runtime_build_id: RuntimeBuildId::parse("runtime-build-fixture").unwrap(),
            adapter_id: AdapterId::parse("codex-app-server").unwrap(),
            connection_id: ConnectionId::parse("connection-fixture").unwrap(),
        };
        let native = serde_json::json!({"kind":"rpc","generation":2,"payload":{"type":"agent_start","opaque":"native-field"}});
        router.route(binding.clone(), native.clone()).unwrap();
        let snapshot = projection.snapshot_for(binding.clone()).unwrap();
        let value = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(
            value["activity"],
            serde_json::to_value(RuntimeActivity::Unobserved).unwrap()
        );
        assert_eq!(value["unknownEventCount"], 1);
        assert_eq!(
            router.snapshot(None, None).unwrap().events[0].native_envelope,
            native
        );
        let mut changed = binding.clone();
        changed.connection_id = ConnectionId::parse("another-connection").unwrap();
        assert!(projection.snapshot_for(changed.clone()).is_err());
        assert!(
            projection
                .mark_reconciled(changed.clone(), 3, Some(false))
                .is_err()
        );
        assert!(
            router
                .route(changed, serde_json::json!({"kind":"rpc","generation":3}))
                .is_err()
        );
        assert_eq!(router.cursor().unwrap().latest_sequence, 1);
        router
            .route(
                binding.clone(),
                serde_json::json!({"kind":"rpc","generation":1}),
            )
            .unwrap();
        let value = serde_json::to_value(projection.snapshot_for(binding).unwrap()).unwrap();
        assert_eq!(value["staleGenerationCount"], 1);
        assert_eq!(value["runtimeGeneration"], 2);
        assert_eq!(projection.snapshots().unwrap().len(), 3);
    }
    use super::{
        DEFAULT_EVENT_CAPACITY, EventPreservation, MAX_NATIVE_EVENT_BYTES, RuntimeEventRouter,
    };
    use crate::runtime_registry::{OPENCODE_RUNTIME, PI_RUNTIME};
    use crate::{
        interaction_registry::InteractionRegistry, live_session_projection::LiveSessionProjection,
    };
    use serde_json::json;
    use std::{
        sync::{Arc, Mutex},
        thread,
    };
    use tauri::ipc::{Channel, InvokeResponseBody};

    #[test]
    fn unknown_native_envelopes_are_preserved_with_monotonic_sequence() {
        let router = RuntimeEventRouter::with_capacity(4);
        let first = json!({
            "generation": 7,
            "kind": "rpc",
            "payload": { "type": "future.pi.event", "opaque": [1, 2, 3] }
        });
        let second = json!({
            "generation": 9,
            "kind": "sse",
            "payload": { "type": "future.opencode.event", "opaque": { "a": true } }
        });
        assert_eq!(router.route(PI_RUNTIME, first.clone()).unwrap(), 1);
        assert_eq!(router.route(OPENCODE_RUNTIME, second.clone()).unwrap(), 2);

        let batch = router.snapshot(None, None).unwrap();
        assert_eq!(batch.events.len(), 2);
        assert_eq!(batch.events[0].sequence, 1);
        assert_eq!(batch.events[0].native_envelope, first);
        assert_eq!(batch.events[1].sequence, 2);
        assert_eq!(batch.events[1].native_envelope, second);
        assert_eq!(batch.events[1].preservation, EventPreservation::Native);
        assert!(batch.gap.is_none());
    }

    #[test]
    fn overflow_is_reported_as_an_explicit_sequence_gap() {
        let router = RuntimeEventRouter::with_capacity(2);
        for value in 1..=4 {
            router
                .route(PI_RUNTIME, json!({ "kind": "rpc", "payload": value }))
                .unwrap();
        }

        let batch = router.snapshot(Some(0), None).unwrap();
        let gap = batch.gap.unwrap();
        assert_eq!(gap.oldest_available, 3);
        assert_eq!(gap.latest_sequence, 4);
        assert_eq!(gap.dropped_total, 2);
        assert_eq!(batch.events[0].sequence, 3);
        assert_eq!(batch.events[1].sequence, 4);
    }

    #[test]
    fn oversized_envelope_becomes_bounded_loss_evidence() {
        let router = RuntimeEventRouter::with_capacity(2);
        let oversized = "x".repeat(MAX_NATIVE_EVENT_BYTES + 1);
        router
            .route(
                PI_RUNTIME,
                json!({ "generation": 1, "kind": "rpc", "payload": oversized }),
            )
            .unwrap();
        let batch = router.snapshot(None, None).unwrap();
        assert_eq!(
            batch.events[0].preservation,
            EventPreservation::OversizedDropped
        );
        assert_eq!(batch.events[0].kind, "oversized_event");
        assert_eq!(
            batch.events[0].native_envelope["reason"],
            "native_envelope_exceeds_host_limit"
        );
    }

    #[test]
    fn concurrent_routes_remain_strictly_ordered_in_the_ring() {
        let router = RuntimeEventRouter::with_capacity(64);
        let threads = (0..8)
            .map(|worker| {
                let router = router.clone();
                thread::spawn(move || {
                    for item in 0..8 {
                        router
                            .route(
                                PI_RUNTIME,
                                json!({ "kind": "rpc", "payload": { "worker": worker, "item": item } }),
                            )
                            .unwrap();
                    }
                })
            })
            .collect::<Vec<_>>();
        for thread in threads {
            thread.join().unwrap();
        }
        let batch = router.snapshot(None, Some(64)).unwrap();
        assert_eq!(batch.events.len(), 64);
        assert!(
            batch
                .events
                .windows(2)
                .all(|events| events[0].sequence + 1 == events[1].sequence)
        );
    }

    #[test]
    fn channel_receives_ready_before_strictly_newer_live_events() {
        let router = RuntimeEventRouter::with_capacity(8);
        router
            .route(PI_RUNTIME, json!({ "kind": "rpc", "payload": 1 }))
            .unwrap();
        let deliveries = Arc::new(Mutex::new(Vec::new()));
        let captured = deliveries.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(value) = body {
                captured
                    .lock()
                    .unwrap()
                    .push(serde_json::from_str::<serde_json::Value>(&value)?);
            }
            Ok(())
        });
        let subscription = router.subscribe(channel, Some(0), None).unwrap();
        router
            .route(PI_RUNTIME, json!({ "kind": "rpc", "payload": 2 }))
            .unwrap();

        let deliveries = deliveries.lock().unwrap();
        assert_eq!(deliveries[0]["type"], "ready");
        assert_eq!(deliveries[0]["snapshot"]["latestSequence"], 1);
        assert_eq!(deliveries[0]["liveProjections"], json!([]));
        assert_eq!(deliveries[0]["pendingInteractions"], json!([]));
        assert_eq!(deliveries[1]["type"], "event");
        assert_eq!(deliveries[1]["event"]["sequence"], 2);
        assert_eq!(subscription.latest_sequence, 1);
    }

    #[test]
    fn ready_contains_projection_from_the_same_subscription_cut() {
        let projection = LiveSessionProjection::default();
        let interactions = InteractionRegistry::default();
        let router = RuntimeEventRouter::with_capacity_and_observers(
            DEFAULT_EVENT_CAPACITY,
            Some(projection),
            Some(interactions),
        );
        router
            .route(
                PI_RUNTIME,
                json!({
                    "generation": 1,
                    "kind": "lifecycle",
                    "payload": { "state": "started" }
                }),
            )
            .unwrap();
        let deliveries = Arc::new(Mutex::new(Vec::new()));
        let captured = deliveries.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(value) = body {
                captured
                    .lock()
                    .unwrap()
                    .push(serde_json::from_str::<serde_json::Value>(&value)?);
            }
            Ok(())
        });

        router.subscribe(channel, Some(0), None).unwrap();

        let deliveries = deliveries.lock().unwrap();
        let pi = deliveries[0]["liveProjections"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["runtime"]["productId"] == "pi")
            .unwrap();
        assert_eq!(deliveries[0]["snapshot"]["latestSequence"], 1);
        assert_eq!(pi["latestSequence"], 1);
        assert_eq!(pi["activity"], "ready");
        assert_eq!(pi["confidence"], "current");
    }

    #[test]
    fn explicit_unsubscribe_stops_live_delivery() {
        let router = RuntimeEventRouter::with_capacity(8);
        let deliveries = Arc::new(Mutex::new(0_usize));
        let captured = deliveries.clone();
        let channel = Channel::new(move |_| {
            *captured.lock().unwrap() += 1;
            Ok(())
        });
        let subscription = router.subscribe(channel, None, None).unwrap();
        assert!(router.unsubscribe(subscription.subscription_id).unwrap());
        router
            .route(PI_RUNTIME, json!({ "kind": "rpc", "payload": 1 }))
            .unwrap();
        assert_eq!(*deliveries.lock().unwrap(), 1);
    }

    #[test]
    fn cursor_captured_before_state_read_supports_loss_aware_catch_up() {
        let router = RuntimeEventRouter::with_capacity(8);
        let cursor = router.cursor().unwrap();
        router
            .route(PI_RUNTIME, json!({ "kind": "rpc", "payload": 1 }))
            .unwrap();
        let catch_up = router.snapshot(Some(cursor.latest_sequence), None).unwrap();
        assert_eq!(cursor.latest_sequence, 0);
        assert_eq!(catch_up.events.len(), 1);
        assert_eq!(catch_up.events[0].sequence, 1);
        assert!(catch_up.gap.is_none());
    }
}
