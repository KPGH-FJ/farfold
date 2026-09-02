use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::State;

use crate::{
    runtime_event_router::RoutedRuntimeEvent,
    runtime_registry::{ManagedRuntimeDefinition, OPENCODE_RUNTIME, PI_RUNTIME, RuntimeIdentity},
};

const PI_DIALOG_METHODS: &[&str] = &["select", "confirm", "input", "editor"];

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InteractionKind {
    PiExtensionDialog,
    OpenCodePermission,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum InteractionState {
    Pending,
    Responding,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct InteractionKey {
    installation_id: &'static str,
    generation: u64,
    interaction_id: String,
}

#[derive(Debug, Clone)]
struct PendingInteraction {
    definition: ManagedRuntimeDefinition,
    key: InteractionKey,
    native_session_id: Option<String>,
    kind: InteractionKind,
    state: InteractionState,
}

#[derive(Default)]
struct RegistryState {
    latest_generations: HashMap<&'static str, u64>,
    interactions: HashMap<InteractionKey, PendingInteraction>,
}

#[derive(Clone, Default)]
pub struct InteractionRegistry {
    state: Arc<Mutex<RegistryState>>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InteractionSnapshot {
    runtime: RuntimeIdentity,
    runtime_generation: u64,
    interaction_id: String,
    native_session_id: Option<String>,
    kind: InteractionKind,
    state: InteractionState,
}

impl InteractionRegistry {
    pub(crate) fn advance_generation(
        &self,
        definition: ManagedRuntimeDefinition,
        generation: u64,
    ) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Interaction Registry is unavailable".to_string())?;
        if state
            .latest_generations
            .get(definition.installation_id)
            .is_some_and(|latest| *latest >= generation)
        {
            return Ok(());
        }
        state
            .latest_generations
            .insert(definition.installation_id, generation);
        state
            .interactions
            .retain(|key, _| key.installation_id != definition.installation_id);
        Ok(())
    }

    pub(crate) fn apply(&self, event: &RoutedRuntimeEvent) -> Result<(), String> {
        let Some(generation) = event.runtime_generation() else {
            return Ok(());
        };
        let definition = match event.runtime().installation_id.as_str() {
            id if id == PI_RUNTIME.installation_id => PI_RUNTIME,
            id if id == OPENCODE_RUNTIME.installation_id => OPENCODE_RUNTIME,
            _ => return Ok(()),
        };
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Interaction Registry is unavailable".to_string())?;
        let latest = state
            .latest_generations
            .entry(definition.installation_id)
            .or_insert(generation);
        if generation < *latest {
            return Ok(());
        }
        if generation > *latest {
            *latest = generation;
            state
                .interactions
                .retain(|key, _| key.installation_id != definition.installation_id);
        }
        if event.kind() == "lifecycle"
            && event
                .native_envelope()
                .pointer("/payload/state")
                .and_then(Value::as_str)
                == Some("terminated")
        {
            state.interactions.retain(|key, _| {
                key.installation_id != definition.installation_id || key.generation != generation
            });
            return Ok(());
        }
        match definition.product_id {
            "pi" => observe_pi(&mut state, definition, generation, event),
            "opencode" => observe_opencode(&mut state, definition, generation, event),
            _ => {}
        }
        Ok(())
    }

    pub(crate) fn begin_response(
        &self,
        definition: ManagedRuntimeDefinition,
        generation: u64,
        interaction_id: &str,
        native_session_id: Option<&str>,
    ) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Interaction Registry is unavailable".to_string())?;
        if state
            .latest_generations
            .get(definition.installation_id)
            .is_some_and(|latest| *latest != generation)
        {
            return Err(format!(
                "{} interaction belongs to a stale Runtime generation",
                definition.display_name
            ));
        }
        let key = InteractionKey {
            installation_id: definition.installation_id,
            generation,
            interaction_id: interaction_id.to_string(),
        };
        let interaction = state.interactions.get_mut(&key).ok_or_else(|| {
            format!(
                "{} interaction is unknown or no longer pending",
                definition.display_name
            )
        })?;
        if interaction.native_session_id.as_deref() != native_session_id {
            return Err(format!(
                "{} interaction does not belong to the supplied native Session",
                definition.display_name
            ));
        }
        if interaction.state != InteractionState::Pending {
            return Err(format!(
                "{} interaction response is already in flight",
                definition.display_name
            ));
        }
        interaction.state = InteractionState::Responding;
        Ok(())
    }

    pub(crate) fn finish_response(
        &self,
        definition: ManagedRuntimeDefinition,
        generation: u64,
        interaction_id: &str,
        succeeded: bool,
    ) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Interaction Registry is unavailable".to_string())?;
        let key = InteractionKey {
            installation_id: definition.installation_id,
            generation,
            interaction_id: interaction_id.to_string(),
        };
        if succeeded {
            state.interactions.remove(&key);
        } else if let Some(interaction) = state.interactions.get_mut(&key)
            && interaction.state == InteractionState::Responding
        {
            interaction.state = InteractionState::Pending;
        }
        Ok(())
    }

    pub(crate) fn snapshots(&self) -> Result<Vec<InteractionSnapshot>, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Interaction Registry is unavailable".to_string())?;
        let mut snapshots = state
            .interactions
            .values()
            .map(|interaction| InteractionSnapshot {
                runtime: interaction.definition.identity(),
                runtime_generation: interaction.key.generation,
                interaction_id: interaction.key.interaction_id.clone(),
                native_session_id: interaction.native_session_id.clone(),
                kind: interaction.kind,
                state: interaction.state,
            })
            .collect::<Vec<_>>();
        snapshots.sort_by(|left, right| {
            left.runtime
                .installation_id
                .cmp(&right.runtime.installation_id)
                .then(left.interaction_id.cmp(&right.interaction_id))
        });
        Ok(snapshots)
    }
}

fn insert_interaction(
    state: &mut RegistryState,
    definition: ManagedRuntimeDefinition,
    generation: u64,
    interaction_id: &str,
    native_session_id: Option<&str>,
    kind: InteractionKind,
) {
    if interaction_id.is_empty() || interaction_id.len() > 128 {
        return;
    }
    let key = InteractionKey {
        installation_id: definition.installation_id,
        generation,
        interaction_id: interaction_id.to_string(),
    };
    state
        .interactions
        .entry(key.clone())
        .or_insert_with(|| PendingInteraction {
            definition,
            key,
            native_session_id: native_session_id.map(str::to_string),
            kind,
            state: InteractionState::Pending,
        });
}

fn observe_pi(
    state: &mut RegistryState,
    definition: ManagedRuntimeDefinition,
    generation: u64,
    event: &RoutedRuntimeEvent,
) {
    if event.kind() != "rpc" {
        return;
    }
    let Some(payload) = event.native_envelope().get("payload") else {
        return;
    };
    if payload.get("type").and_then(Value::as_str) != Some("extension_ui_request") {
        return;
    }
    let Some(method) = payload.get("method").and_then(Value::as_str) else {
        return;
    };
    if !PI_DIALOG_METHODS.contains(&method) {
        return;
    }
    if let Some(id) = payload.get("id").and_then(Value::as_str) {
        insert_interaction(
            state,
            definition,
            generation,
            id,
            None,
            InteractionKind::PiExtensionDialog,
        );
    }
}

fn observe_opencode(
    state: &mut RegistryState,
    definition: ManagedRuntimeDefinition,
    generation: u64,
    event: &RoutedRuntimeEvent,
) {
    if event.kind() != "sse" {
        return;
    }
    let Some(payload) = event.native_envelope().get("payload") else {
        return;
    };
    let payload = payload.get("payload").unwrap_or(payload);
    let Some(properties) = payload.get("properties") else {
        return;
    };
    match payload.get("type").and_then(Value::as_str) {
        Some("permission.asked") => {
            if let (Some(id), Some(session_id)) = (
                properties.get("id").and_then(Value::as_str),
                properties.get("sessionID").and_then(Value::as_str),
            ) {
                insert_interaction(
                    state,
                    definition,
                    generation,
                    id,
                    Some(session_id),
                    InteractionKind::OpenCodePermission,
                );
            }
        }
        Some("permission.replied") => {
            if let Some(id) = properties.get("requestID").and_then(Value::as_str) {
                state.interactions.remove(&InteractionKey {
                    installation_id: definition.installation_id,
                    generation,
                    interaction_id: id.to_string(),
                });
            }
        }
        _ => {}
    }
}

#[tauri::command]
pub fn interaction_registry_snapshot(
    registry: State<'_, InteractionRegistry>,
) -> Result<Vec<InteractionSnapshot>, String> {
    registry.snapshots()
}

#[cfg(test)]
mod tests {
    use super::InteractionRegistry;
    use crate::{
        runtime_event_router::RuntimeEventRouter,
        runtime_registry::{OPENCODE_RUNTIME, PI_RUNTIME},
    };
    use serde_json::json;

    #[test]
    fn pi_dialog_response_is_single_flight_and_generation_scoped() {
        let registry = InteractionRegistry::default();
        let router =
            RuntimeEventRouter::with_capacity_and_observers(8, None, Some(registry.clone()));
        router
            .route(
                PI_RUNTIME,
                json!({
                    "generation": 2,
                    "kind": "rpc",
                    "payload": { "type": "extension_ui_request", "id": "dialog-1", "method": "confirm" }
                }),
            )
            .unwrap();
        registry
            .begin_response(PI_RUNTIME, 2, "dialog-1", None)
            .unwrap();
        assert!(
            registry
                .begin_response(PI_RUNTIME, 2, "dialog-1", None)
                .is_err()
        );
        registry
            .finish_response(PI_RUNTIME, 2, "dialog-1", false)
            .unwrap();
        registry
            .begin_response(PI_RUNTIME, 2, "dialog-1", None)
            .unwrap();

        router
            .route(
                PI_RUNTIME,
                json!({ "generation": 3, "kind": "lifecycle", "payload": { "state": "started" } }),
            )
            .unwrap();
        assert!(
            registry
                .begin_response(PI_RUNTIME, 2, "dialog-1", None)
                .is_err()
        );
        assert!(registry.snapshots().unwrap().is_empty());
    }

    #[test]
    fn opencode_permission_requires_its_exact_native_session() {
        let registry = InteractionRegistry::default();
        let router =
            RuntimeEventRouter::with_capacity_and_observers(8, None, Some(registry.clone()));
        router
            .route(
                OPENCODE_RUNTIME,
                json!({
                    "generation": 4,
                    "kind": "sse",
                    "payload": {
                        "type": "permission.asked",
                        "properties": { "id": "per_1", "sessionID": "ses_1" }
                    }
                }),
            )
            .unwrap();
        assert!(
            registry
                .begin_response(OPENCODE_RUNTIME, 4, "per_1", Some("ses_wrong"))
                .is_err()
        );
        registry
            .begin_response(OPENCODE_RUNTIME, 4, "per_1", Some("ses_1"))
            .unwrap();
        registry
            .finish_response(OPENCODE_RUNTIME, 4, "per_1", true)
            .unwrap();
        assert!(registry.snapshots().unwrap().is_empty());
    }

    #[test]
    fn fire_and_forget_pi_ui_updates_are_not_pending_interactions() {
        let registry = InteractionRegistry::default();
        let router =
            RuntimeEventRouter::with_capacity_and_observers(8, None, Some(registry.clone()));
        router
            .route(
                PI_RUNTIME,
                json!({
                    "generation": 1,
                    "kind": "rpc",
                    "payload": { "type": "extension_ui_request", "id": "status-1", "method": "setStatus" }
                }),
            )
            .unwrap();
        assert!(registry.snapshots().unwrap().is_empty());
    }

    #[test]
    fn runtime_termination_discards_unanswered_interactions() {
        let registry = InteractionRegistry::default();
        let router =
            RuntimeEventRouter::with_capacity_and_observers(8, None, Some(registry.clone()));
        router
            .route(
                PI_RUNTIME,
                json!({
                    "generation": 6,
                    "kind": "rpc",
                    "payload": { "type": "extension_ui_request", "id": "dialog-6", "method": "input" }
                }),
            )
            .unwrap();
        assert_eq!(registry.snapshots().unwrap().len(), 1);
        router
            .route(
                PI_RUNTIME,
                json!({
                    "generation": 6,
                    "kind": "lifecycle",
                    "payload": { "state": "terminated", "reason": "exited" }
                }),
            )
            .unwrap();
        assert!(registry.snapshots().unwrap().is_empty());
    }
}
