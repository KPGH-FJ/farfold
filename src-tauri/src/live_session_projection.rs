use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::State;

use crate::{
    host_ids::{ConnectionId, InstallationId, RuntimeBuildId},
    runtime_event_router::RoutedRuntimeEvent,
    runtime_registry::{OPENCODE_RUNTIME, PI_RUNTIME, RuntimeBinding, RuntimeIdentity},
};

const PI_KNOWN_PASSIVE_EVENTS: &[&str] = &[
    "agent_end",
    "turn_start",
    "turn_end",
    "message_start",
    "message_update",
    "message_end",
    "bash_execution_update",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "queue_update",
    "compaction_start",
    "compaction_end",
    "auto_retry_end",
    "summarization_retry_scheduled",
    "summarization_retry_attempt_start",
    "summarization_retry_finished",
    "extension_error",
    "extension_ui_request",
];

const OPENCODE_KNOWN_PASSIVE_EVENTS: &[&str] = &[
    "server.connected",
    "server.heartbeat",
    "sync",
    "models-dev.refreshed",
    "session.created",
    "session.updated",
    "message.updated",
    "message.part.delta",
    "message.part.updated",
    "message.part.removed",
    "message.removed",
    "permission.asked",
    "permission.replied",
    "session.diff",
    "session.compacted",
];

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeActivity {
    Unobserved,
    Ready,
    Idle,
    Working,
    Retrying,
    Stopped,
    Degraded,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProjectionConfidence {
    Current,
    ReconciliationRequired,
}

struct ProjectionSlot {
    definition: RuntimeBinding,
    runtime_generation: Option<u64>,
    latest_sequence: u64,
    activity: RuntimeActivity,
    confidence: ProjectionConfidence,
    reconciliation_reason: Option<&'static str>,
    unknown_event_count: u64,
    stale_generation_count: u64,
}

impl ProjectionSlot {
    fn new(definition: RuntimeBinding) -> Self {
        Self {
            definition,
            runtime_generation: None,
            latest_sequence: 0,
            activity: RuntimeActivity::Unobserved,
            confidence: ProjectionConfidence::Current,
            reconciliation_reason: None,
            unknown_event_count: 0,
            stale_generation_count: 0,
        }
    }

    fn reset_for_generation(&mut self, generation: u64) {
        self.runtime_generation = Some(generation);
        self.activity = match self.definition.product_id.as_str() {
            "pi" | "opencode" => RuntimeActivity::Ready,
            _ => RuntimeActivity::Unobserved,
        };
        self.confidence = ProjectionConfidence::Current;
        self.reconciliation_reason = None;
    }

    fn require_reconciliation(&mut self, reason: &'static str) {
        self.confidence = ProjectionConfidence::ReconciliationRequired;
        self.reconciliation_reason = Some(reason);
    }
}

struct ProjectionState {
    latest_global_sequence: u64,
    slots: HashMap<InstallationId, ProjectionSlot>,
}

#[derive(Clone)]
pub struct LiveSessionProjection {
    state: Arc<Mutex<ProjectionState>>,
}

impl Default for LiveSessionProjection {
    fn default() -> Self {
        let slots = [PI_RUNTIME, OPENCODE_RUNTIME]
            .into_iter()
            .map(|definition| {
                let binding: RuntimeBinding = definition.into();
                (
                    binding.installation_id.clone(),
                    ProjectionSlot::new(binding),
                )
            })
            .collect();
        Self {
            state: Arc::new(Mutex::new(ProjectionState {
                latest_global_sequence: 0,
                slots,
            })),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProjectionSnapshot {
    runtime: RuntimeIdentity,
    runtime_build_id: RuntimeBuildId,
    connection_id: ConnectionId,
    runtime_generation: Option<u64>,
    latest_sequence: u64,
    activity: RuntimeActivity,
    confidence: ProjectionConfidence,
    reconciliation_reason: Option<&'static str>,
    unknown_event_count: u64,
    stale_generation_count: u64,
}

impl LiveSessionProjection {
    pub(crate) fn activate_connection(
        &self,
        definition: RuntimeBinding,
        generation: u64,
    ) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Live Session projection is unavailable")?;
        if let Some(existing) = state.slots.get(&definition.installation_id) {
            if existing.definition == definition && existing.runtime_generation == Some(generation)
            {
                return Ok(());
            }
            if existing
                .runtime_generation
                .is_some_and(|current| current >= generation)
            {
                return Err("Cannot activate a stale Runtime connection generation".into());
            }
        }
        let mut slot = ProjectionSlot::new(definition.clone());
        slot.reset_for_generation(generation);
        state.slots.insert(definition.installation_id.clone(), slot);
        Ok(())
    }

    pub(crate) fn connection_activation_failed(&self, definition: &RuntimeBinding) {
        if let Ok(mut state) = self.state.lock()
            && let Some(slot) = state.slots.get_mut(&definition.installation_id)
            && &slot.definition == definition
        {
            slot.activity = RuntimeActivity::Degraded;
            slot.require_reconciliation("runtime_connection_activation_failed");
        }
    }

    pub(crate) fn register(&self, definition: RuntimeBinding) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Live Session projection is unavailable")?;
        match state.slots.entry(definition.installation_id.clone()) {
            std::collections::hash_map::Entry::Occupied(existing)
                if existing.get().definition != definition =>
            {
                Err("Runtime event provenance does not match the registered connection".into())
            }
            std::collections::hash_map::Entry::Occupied(_) => Ok(()),
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(ProjectionSlot::new(definition));
                Ok(())
            }
        }
    }

    fn snapshot(slot: &ProjectionSlot) -> RuntimeProjectionSnapshot {
        RuntimeProjectionSnapshot {
            runtime: slot.definition.identity(),
            runtime_build_id: slot.definition.runtime_build_id.clone(),
            connection_id: slot.definition.connection_id.clone(),
            runtime_generation: slot.runtime_generation,
            latest_sequence: slot.latest_sequence,
            activity: slot.activity,
            confidence: slot.confidence,
            reconciliation_reason: slot.reconciliation_reason,
            unknown_event_count: slot.unknown_event_count,
            stale_generation_count: slot.stale_generation_count,
        }
    }

    pub(crate) fn apply(&self, event: &RoutedRuntimeEvent) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Live Session projection is unavailable".to_string())?;
        if event.sequence() != state.latest_global_sequence.saturating_add(1) {
            for slot in state.slots.values_mut() {
                slot.require_reconciliation("host_sequence_discontinuity");
            }
        }
        state.latest_global_sequence = event.sequence();
        let installation_id =
            InstallationId::parse(&event.runtime().installation_id).map_err(|e| e.to_string())?;
        let Some(slot) = state.slots.get_mut(&installation_id) else {
            return Ok(());
        };
        slot.latest_sequence = event.sequence();
        let Some(generation) = event.runtime_generation() else {
            slot.require_reconciliation("runtime_generation_missing");
            return Ok(());
        };
        match slot.runtime_generation {
            Some(current) if generation < current => {
                slot.stale_generation_count = slot.stale_generation_count.saturating_add(1);
                return Ok(());
            }
            Some(current) if generation > current => {
                slot.reset_for_generation(generation);
                slot.require_reconciliation("runtime_generation_changed");
            }
            None => slot.reset_for_generation(generation),
            Some(_) => {}
        }
        match slot.definition.product_id.as_str() {
            "pi" => apply_pi(slot, event),
            "opencode" => apply_opencode(slot, event),
            "codex" if slot.definition.adapter_id.as_str() == "codex-app-server" => {
                use crate::codex_turns::ActivityUpdate;
                match crate::codex_turns::project_activity(event.kind(), event.native_envelope()) {
                    ActivityUpdate::Changed(activity) => slot.activity = activity,
                    ActivityUpdate::Reconciled => {
                        slot.activity = RuntimeActivity::Idle;
                        slot.confidence = ProjectionConfidence::Current;
                        slot.reconciliation_reason = None;
                    }
                    ActivityUpdate::Reconcile => {
                        slot.activity = RuntimeActivity::Degraded;
                        slot.require_reconciliation("codex_runtime_requires_reconciliation");
                    }
                    ActivityUpdate::UnknownEvent => {
                        slot.unknown_event_count = slot.unknown_event_count.saturating_add(1);
                    }
                    ActivityUpdate::Unchanged => {}
                }
            }
            _ => {
                slot.unknown_event_count = slot.unknown_event_count.saturating_add(1);
            }
        }
        Ok(())
    }

    pub(crate) fn snapshots(&self) -> Result<Vec<RuntimeProjectionSnapshot>, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Live Session projection is unavailable".to_string())?;
        let mut snapshots: Vec<_> = state.slots.values().map(Self::snapshot).collect();
        // Keep established peer order, then stable order for dynamic installs.
        snapshots.sort_by(|a, b| {
            let rank = |s: &RuntimeProjectionSnapshot| match s.runtime.installation_id.as_str() {
                id if id == PI_RUNTIME.installation_id => 0,
                id if id == OPENCODE_RUNTIME.installation_id => 1,
                _ => 2,
            };
            rank(a)
                .cmp(&rank(b))
                .then_with(|| a.runtime.installation_id.cmp(&b.runtime.installation_id))
        });
        Ok(snapshots)
    }

    pub(crate) fn snapshot_for(
        &self,
        definition: impl Into<RuntimeBinding>,
    ) -> Result<RuntimeProjectionSnapshot, String> {
        let definition = definition.into();
        let state = self
            .state
            .lock()
            .map_err(|_| "Live Session projection is unavailable".to_string())?;
        state
            .slots
            .get(&definition.installation_id)
            .filter(|slot| slot.definition == definition)
            .map(Self::snapshot)
            .ok_or_else(|| {
                format!(
                    "Unknown Runtime installation: {}",
                    definition.installation_id
                )
            })
    }

    pub(crate) fn mark_reconciled(
        &self,
        definition: impl Into<RuntimeBinding>,
        generation: u64,
        working: Option<bool>,
    ) -> Result<(), String> {
        let definition = definition.into();
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Live Session projection is unavailable".to_string())?;
        let slot = state
            .slots
            .get_mut(&definition.installation_id)
            .ok_or_else(|| {
                format!(
                    "Unknown Runtime installation: {}",
                    definition.installation_id
                )
            })?;
        if slot.definition != definition {
            return Err("Cannot reconcile a different Runtime connection or build".into());
        }
        if slot
            .runtime_generation
            .is_some_and(|current| current > generation)
        {
            return Err(format!(
                "Cannot reconcile stale {} generation {generation}",
                definition.product_id
            ));
        }
        if slot.runtime_generation != Some(generation) {
            slot.reset_for_generation(generation);
        }
        if let Some(working) = working {
            slot.activity = if working {
                RuntimeActivity::Working
            } else {
                RuntimeActivity::Idle
            };
        }
        slot.confidence = ProjectionConfidence::Current;
        slot.reconciliation_reason = None;
        Ok(())
    }
}

fn apply_pi(slot: &mut ProjectionSlot, event: &RoutedRuntimeEvent) {
    match event.kind() {
        "lifecycle" => match event
            .native_envelope()
            .pointer("/payload/state")
            .and_then(Value::as_str)
        {
            Some("started") => slot.activity = RuntimeActivity::Ready,
            Some("terminated") => slot.activity = RuntimeActivity::Stopped,
            Some("error") => {
                slot.activity = RuntimeActivity::Degraded;
                slot.require_reconciliation("pi_lifecycle_error");
            }
            _ => {}
        },
        "protocol_error" => {
            slot.activity = RuntimeActivity::Degraded;
            slot.require_reconciliation("pi_protocol_error");
        }
        "rpc" => {
            let event_type = event
                .native_envelope()
                .pointer("/payload/type")
                .and_then(Value::as_str);
            match event_type {
                Some("agent_start") => slot.activity = RuntimeActivity::Working,
                Some("agent_settled") => slot.activity = RuntimeActivity::Idle,
                Some("auto_retry_start") => slot.activity = RuntimeActivity::Retrying,
                Some(known) if PI_KNOWN_PASSIVE_EVENTS.contains(&known) => {}
                Some(_) | None => {
                    slot.unknown_event_count = slot.unknown_event_count.saturating_add(1);
                }
            }
        }
        _ => {
            slot.unknown_event_count = slot.unknown_event_count.saturating_add(1);
        }
    }
}

fn opencode_native_event(event: &RoutedRuntimeEvent) -> Option<(&str, &Value)> {
    let outer = event.native_envelope().get("payload")?;
    let native = outer.get("payload").unwrap_or(outer);
    Some((native.get("type")?.as_str()?, native.get("properties")?))
}

fn apply_opencode(slot: &mut ProjectionSlot, event: &RoutedRuntimeEvent) {
    if matches!(event.kind(), "protocol_error" | "transport_error") {
        slot.activity = RuntimeActivity::Degraded;
        slot.require_reconciliation("opencode_transport_error");
        return;
    }
    if event.kind() == "acp" {
        let Some(method) = event
            .native_envelope()
            .pointer("/payload/method")
            .and_then(Value::as_str)
        else {
            slot.unknown_event_count = slot.unknown_event_count.saturating_add(1);
            return;
        };
        match method {
            "session/update" => match event
                .native_envelope()
                .pointer("/payload/params/update/sessionUpdate")
                .and_then(Value::as_str)
            {
                Some("agent_message_chunk")
                | Some("tool_call")
                | Some("tool_call_update")
                | Some("plan") => slot.activity = RuntimeActivity::Working,
                Some("usage_update") | Some("config_option_update") => {}
                Some(_) | None => {
                    slot.unknown_event_count = slot.unknown_event_count.saturating_add(1);
                }
            },
            "session/request_permission" => slot.activity = RuntimeActivity::Working,
            _ => slot.unknown_event_count = slot.unknown_event_count.saturating_add(1),
        }
        return;
    }
    if event.kind() != "sse" {
        slot.unknown_event_count = slot.unknown_event_count.saturating_add(1);
        return;
    }
    let Some((event_type, properties)) = opencode_native_event(event) else {
        slot.unknown_event_count = slot.unknown_event_count.saturating_add(1);
        return;
    };
    match event_type {
        "session.status" => match properties.pointer("/status/type").and_then(Value::as_str) {
            Some("busy") => slot.activity = RuntimeActivity::Working,
            Some("idle") => slot.activity = RuntimeActivity::Idle,
            Some("retry") => slot.activity = RuntimeActivity::Retrying,
            _ => slot.unknown_event_count = slot.unknown_event_count.saturating_add(1),
        },
        "session.idle" => slot.activity = RuntimeActivity::Idle,
        "session.error" => {
            // This is also a recoverable diagnostic, not an activity transition.
            slot.require_reconciliation("opencode_session_error");
        }
        known if OPENCODE_KNOWN_PASSIVE_EVENTS.contains(&known) => {}
        _ => slot.unknown_event_count = slot.unknown_event_count.saturating_add(1),
    }
}

#[tauri::command]
pub fn live_projection_snapshot(
    projection: State<'_, LiveSessionProjection>,
) -> Result<Vec<RuntimeProjectionSnapshot>, String> {
    projection.snapshots()
}

#[cfg(test)]
mod tests {
    use super::{LiveSessionProjection, ProjectionConfidence, RuntimeActivity};
    use crate::{
        runtime_event_router::RuntimeEventRouter,
        runtime_registry::{OPENCODE_RUNTIME, PI_RUNTIME},
    };
    use serde_json::json;

    fn router() -> (RuntimeEventRouter, LiveSessionProjection) {
        let projection = LiveSessionProjection::default();
        let router =
            RuntimeEventRouter::with_capacity_and_observers(16, Some(projection.clone()), None);
        (router, projection)
    }

    #[test]
    fn codex_activity_waits_for_adapter_settlement_and_verified_resume() {
        use crate::host_ids::*;
        use crate::runtime_registry::RuntimeBinding;
        let (router, projection) = router();
        let binding = RuntimeBinding {
            product_id: RuntimeProductId::parse("codex").unwrap(),
            installation_id: InstallationId::parse("codex-install").unwrap(),
            runtime_build_id: RuntimeBuildId::parse("codex-build").unwrap(),
            adapter_id: AdapterId::parse("codex-app-server").unwrap(),
            connection_id: ConnectionId::parse("codex-stdio").unwrap(),
        };
        let send = |generation, kind, payload| {
            router
                .route(
                    binding.clone(),
                    json!({"generation":generation,"kind":kind,"payload":payload}),
                )
                .unwrap()
        };
        let snapshot = || projection.snapshot_for(binding.clone()).unwrap();
        send(2, "lifecycle", json!({"state":"initialized"}));
        assert_eq!(snapshot().activity, RuntimeActivity::Ready);
        send(2, "codex_turn_state", json!({"phase":"executing"}));
        send(2, "codex_rpc", json!({"method":"turn/completed"}));
        assert_eq!(snapshot().activity, RuntimeActivity::Working);
        send(2, "codex_turn_state", json!({"phase":"unknown"}));
        assert_eq!(snapshot().activity, RuntimeActivity::Degraded);
        send(2, "codex_rpc", json!({"method":"item/completed"}));
        assert_eq!(
            snapshot().confidence,
            ProjectionConfidence::ReconciliationRequired
        );
        send(2, "codex_turn_state", json!({"phase":"interrupted"}));
        send(2, "lifecycle", json!({"state":"terminated"}));
        assert_eq!(snapshot().activity, RuntimeActivity::Stopped);
        send(3, "lifecycle", json!({"state":"initialized"}));
        send(2, "codex_session_opened", json!({"nativeSessionId":"old"}));
        assert_eq!(
            snapshot().confidence,
            ProjectionConfidence::ReconciliationRequired
        );
        send(
            3,
            "codex_session_opened",
            json!({"nativeSessionId":"thread"}),
        );
        assert_eq!(snapshot().activity, RuntimeActivity::Idle);
        assert_eq!(snapshot().confidence, ProjectionConfidence::Current);
        send(3, "codex_rpc", json!({"method":"future/event"}));
        assert_eq!(snapshot().unknown_event_count, 1);
        send(3, "transport_gap", json!({"dropped":1}));
        assert_eq!(snapshot().activity, RuntimeActivity::Degraded);
    }

    #[test]
    fn pi_activity_is_reduced_only_from_documented_events() {
        let (router, projection) = router();
        router
            .route(
                PI_RUNTIME,
                json!({ "generation": 2, "kind": "rpc", "payload": { "type": "agent_start" } }),
            )
            .unwrap();
        assert_eq!(
            projection.snapshots().unwrap()[0].activity,
            RuntimeActivity::Working
        );
        router
            .route(
                PI_RUNTIME,
                json!({ "generation": 2, "kind": "rpc", "payload": { "type": "agent_settled" } }),
            )
            .unwrap();
        assert_eq!(
            projection.snapshots().unwrap()[0].activity,
            RuntimeActivity::Idle
        );
    }

    #[test]
    fn opencode_error_requires_reconciliation_without_inventing_an_activity_transition() {
        let (router, projection) = router();
        router
            .route(
                OPENCODE_RUNTIME,
                json!({
                    "generation": 3,
                    "kind": "sse",
                    "payload": { "payload": {
                        "type": "session.status",
                        "properties": { "status": { "type": "retry" } }
                    } }
                }),
            )
            .unwrap();
        assert_eq!(
            projection.snapshots().unwrap()[1].activity,
            RuntimeActivity::Retrying
        );
        router
            .route(
                OPENCODE_RUNTIME,
                json!({
                    "generation": 3,
                    "kind": "sse",
                    "payload": { "payload": {
                        "type": "session.error",
                        "properties": { "error": { "message": "provider failed" } }
                    } }
                }),
            )
            .unwrap();
        let snapshot = &projection.snapshots().unwrap()[1];
        assert_eq!(snapshot.activity, RuntimeActivity::Retrying);
        assert_eq!(
            snapshot.confidence,
            ProjectionConfidence::ReconciliationRequired
        );
    }

    #[test]
    fn unknown_and_stale_generation_events_never_invent_activity() {
        let (router, projection) = router();
        router
            .route(
                PI_RUNTIME,
                json!({ "generation": 5, "kind": "rpc", "payload": { "type": "future.event" } }),
            )
            .unwrap();
        router
            .route(
                PI_RUNTIME,
                json!({ "generation": 4, "kind": "rpc", "payload": { "type": "agent_start" } }),
            )
            .unwrap();
        let snapshot = &projection.snapshots().unwrap()[0];
        assert_eq!(snapshot.activity, RuntimeActivity::Ready);
        assert_eq!(snapshot.unknown_event_count, 1);
        assert_eq!(snapshot.stale_generation_count, 1);
    }

    #[test]
    fn a_new_runtime_generation_requires_official_reconciliation() {
        let (router, projection) = router();
        for generation in [1, 2] {
            router
                .route(
                    PI_RUNTIME,
                    json!({ "generation": generation, "kind": "lifecycle", "payload": { "state": "started" } }),
                )
                .unwrap();
        }
        let snapshot = &projection.snapshots().unwrap()[0];
        assert_eq!(snapshot.runtime_generation, Some(2));
        assert_eq!(
            snapshot.confidence,
            ProjectionConfidence::ReconciliationRequired
        );
        assert_eq!(
            snapshot.reconciliation_reason,
            Some("runtime_generation_changed")
        );
    }

    #[test]
    fn official_reconciliation_clears_only_a_current_or_newer_generation() {
        let (router, projection) = router();
        for generation in [1, 2] {
            router
                .route(
                    PI_RUNTIME,
                    json!({ "generation": generation, "kind": "lifecycle", "payload": { "state": "started" } }),
                )
                .unwrap();
        }

        assert!(
            projection
                .mark_reconciled(PI_RUNTIME, 1, Some(false))
                .is_err()
        );
        projection
            .mark_reconciled(PI_RUNTIME, 2, Some(true))
            .unwrap();
        let snapshot = &projection.snapshots().unwrap()[0];
        assert_eq!(snapshot.runtime_generation, Some(2));
        assert_eq!(snapshot.activity, RuntimeActivity::Working);
        assert_eq!(snapshot.confidence, ProjectionConfidence::Current);
        assert_eq!(snapshot.reconciliation_reason, None);
    }
}
