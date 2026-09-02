use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::State;

use crate::runtime_registry::{ManagedRuntimeDefinition, RuntimeIdentity};

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
    runtime_build_id: &'static str,
    connection_id: &'static str,
    runtime_generation: Option<u64>,
    kind: String,
    native_envelope: Value,
    preservation: EventPreservation,
    received_at_ms: u64,
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

struct RouterState {
    stream_id: String,
    next_sequence: u64,
    dropped_total: u64,
    events: VecDeque<RoutedRuntimeEvent>,
}

#[derive(Clone)]
pub struct RuntimeEventRouter {
    capacity: usize,
    state: Arc<Mutex<RouterState>>,
}

impl Default for RuntimeEventRouter {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_EVENT_CAPACITY)
    }
}

impl RuntimeEventRouter {
    fn with_capacity(capacity: usize) -> Self {
        let instance = ROUTER_INSTANCE.fetch_add(1, Ordering::Relaxed);
        Self {
            capacity: capacity.max(1),
            state: Arc::new(Mutex::new(RouterState {
                stream_id: format!("host-{}-{}-{instance}", std::process::id(), now_millis()),
                next_sequence: 0,
                dropped_total: 0,
                events: VecDeque::with_capacity(capacity.max(1)),
            })),
        }
    }

    pub(crate) fn route(
        &self,
        definition: ManagedRuntimeDefinition,
        native_envelope: Value,
    ) -> Result<u64, String> {
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
            runtime_build_id: definition.runtime_build_id,
            connection_id: definition.default_connection_id,
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
        state.events.push_back(event);
        Ok(sequence)
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
        Ok(RuntimeEventBatch {
            stream_id: state.stream_id.clone(),
            requested_after: after_sequence,
            oldest_available,
            latest_sequence: state.next_sequence,
            next_after,
            has_more: next_after < state.next_sequence,
            gap,
            events,
        })
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
    use super::{EventPreservation, MAX_NATIVE_EVENT_BYTES, RuntimeEventRouter};
    use crate::runtime_registry::{OPENCODE_RUNTIME, PI_RUNTIME};
    use serde_json::json;
    use std::thread;

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
}
