use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::State;

use crate::{
    host_ids::{InstallationId, NativeSessionId},
    host_store::{
        HostStore,
        session_attention::{OpenSessionAttention, SessionAttentionKind, SessionAttentionStatus},
    },
    runtime_event_router::RoutedRuntimeEvent,
    runtime_registry::{OPENCODE_RUNTIME, PI_RUNTIME, RuntimeBinding, RuntimeIdentity},
};

const PI_DIALOG_METHODS: &[&str] = &["select", "confirm", "input", "editor"];

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InteractionKind {
    PiExtensionDialog,
    OpenCodePermission,
    OpenCodeQuestion,
    CodexNative,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum InteractionState {
    Pending,
    Responding,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct InteractionKey {
    installation_id: InstallationId,
    generation: u64,
    interaction_id: String,
}

#[derive(Debug, Clone)]
struct PendingInteraction {
    definition: RuntimeBinding,
    key: InteractionKey,
    native_session_id: Option<String>,
    kind: InteractionKind,
    state: InteractionState,
    expires_at: Option<Instant>,
    codex: Option<crate::codex_interactions::CodexInteraction>,
    pi_acp: Option<crate::pi_acp_interactions::PiAcpDialog>,
    codex_acp: Option<crate::codex_acp::interactions::Interaction>,
}

#[derive(Default)]
struct RegistryState {
    latest_generations: HashMap<InstallationId, (RuntimeBinding, u64)>,
    interactions: HashMap<InteractionKey, PendingInteraction>,
}

#[derive(Clone, Default)]
pub struct InteractionRegistry {
    state: Arc<Mutex<RegistryState>>,
    host_store: Arc<Mutex<Option<HostStore>>>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    codex: Option<crate::codex_interactions::CodexInteraction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pi_acp: Option<crate::pi_acp_interactions::PiAcpDialog>,
    #[serde(skip_serializing_if = "Option::is_none")]
    codex_acp: Option<crate::codex_acp::interactions::Interaction>,
}

impl InteractionRegistry {
    pub(crate) fn is_current_connection(
        &self,
        binding: &RuntimeBinding,
        generation: u64,
    ) -> Result<bool, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Interaction Registry is unavailable")?;
        Ok(state
            .latest_generations
            .get(&binding.installation_id)
            .is_some_and(|(current, revision)| current == binding && *revision == generation))
    }

    pub(crate) fn pi_acp_dialog_by_native_id(
        &self,
        binding: &RuntimeBinding,
        generation: u64,
        session: &str,
        native_request_id: &str,
    ) -> Result<Option<crate::pi_acp_interactions::PiAcpDialog>, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Interaction Registry is unavailable")?;
        if !state
            .latest_generations
            .get(&binding.installation_id)
            .is_some_and(|(current, revision)| current == binding && *revision == generation)
        {
            return Ok(None);
        }
        Ok(state
            .interactions
            .values()
            .filter(|pending| {
                pending.definition == *binding && pending.key.generation == generation
            })
            .filter_map(|pending| pending.pi_acp.as_ref())
            .find(|dialog| {
                dialog.native_session_id == session && dialog.native_request_id == native_request_id
            })
            .cloned())
    }

    pub(crate) fn activate_connection(
        &self,
        definition: RuntimeBinding,
        generation: u64,
    ) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Interaction Registry is unavailable")?;
        if let Some((binding, current)) = state.latest_generations.get(&definition.installation_id)
            && (*current > generation || (*current == generation && binding != &definition))
        {
            return Err("Cannot activate a stale interaction connection generation".into());
        }
        state.latest_generations.insert(
            definition.installation_id.clone(),
            (definition.clone(), generation),
        );
        // Keep invalidated entries until their durable stale transition succeeds.
        // The new generation barrier prevents their display or reply meanwhile.
        let retired = state
            .interactions
            .values()
            .filter(|interaction| {
                interaction.key.installation_id == definition.installation_id
                    && (interaction.definition != definition
                        || interaction.key.generation != generation)
            })
            .cloned()
            .collect::<Vec<_>>();
        drop(state);
        self.persist(
            retired
                .iter()
                .cloned()
                .map(|interaction| {
                    InteractionPersistence::Transition(interaction, SessionAttentionStatus::Stale)
                })
                .collect(),
        )?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Interaction Registry is unavailable")?;
        for interaction in retired {
            state.interactions.remove(&interaction.key);
        }
        Ok(())
    }

    pub(crate) fn attach_host_store(&self, store: HostStore) -> Result<(), String> {
        let mut attached = self
            .host_store
            .lock()
            .map_err(|_| "Interaction Registry Host store is unavailable".to_string())?;
        if attached.is_some() {
            return Err("Interaction Registry Host store is already attached".to_string());
        }
        *attached = Some(store);
        Ok(())
    }

    pub(crate) fn advance_generation(
        &self,
        definition: impl Into<RuntimeBinding>,
        generation: u64,
    ) -> Result<(), String> {
        let definition = definition.into();
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Interaction Registry is unavailable".to_string())?;
        if state
            .latest_generations
            .get(&definition.installation_id)
            .is_some_and(|(binding, _)| binding != &definition)
        {
            return Err("Interaction installation binding has changed".into());
        }
        if state
            .latest_generations
            .get(&definition.installation_id)
            .is_some_and(|(binding, latest)| binding == &definition && *latest >= generation)
        {
            return Ok(());
        }
        state.latest_generations.insert(
            definition.installation_id.clone(),
            (definition.clone(), generation),
        );
        let persistence = remove_installation_interactions(
            &mut state,
            &definition.installation_id,
            None,
            SessionAttentionStatus::Stale,
        );
        drop(state);
        self.persist(persistence)
    }

    pub(crate) fn apply(&self, event: &RoutedRuntimeEvent) -> Result<(), String> {
        let Some(generation) = event.runtime_generation() else {
            return Ok(());
        };
        let definition = match event.runtime().installation_id.as_str() {
            id if id == PI_RUNTIME.installation_id => RuntimeBinding::from(PI_RUNTIME),
            id if id == OPENCODE_RUNTIME.installation_id => RuntimeBinding::from(OPENCODE_RUNTIME),
            _ if event.runtime().product_id.as_str() == "opencode"
                && event.runtime().adapter_id.as_str() == "opencode-acp-stdio-v1" =>
            {
                event.binding()?
            }
            _ if event.runtime().product_id.as_str() == "pi"
                && event.runtime().adapter_id.as_str()
                    == crate::pi_acp_interactions::PI_ACP_ADAPTER_ID =>
            {
                event.binding()?
            }
            _ if event.runtime().product_id.as_str() == "codex"
                && matches!(
                    event.runtime().adapter_id.as_str(),
                    "codex-app-server" | "codex-acp-stdio-v1"
                ) =>
            {
                event.binding()?
            }
            _ => return Ok(()),
        };
        if !event.matches_binding(&definition) {
            return Err("Interaction event does not match its full Runtime binding".into());
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Interaction Registry is unavailable".to_string())?;
        let latest = state
            .latest_generations
            .entry(definition.installation_id.clone())
            .or_insert((definition.clone(), generation));
        if latest.0 != definition || generation < latest.1 {
            return Ok(());
        }
        let mut persistence = Vec::new();
        if generation > latest.1 {
            latest.1 = generation;
            persistence.extend(remove_installation_interactions(
                &mut state,
                &definition.installation_id,
                None,
                SessionAttentionStatus::Stale,
            ));
        }
        if event.kind() == "lifecycle"
            && event
                .native_envelope()
                .pointer("/payload/state")
                .and_then(Value::as_str)
                == Some("terminated")
        {
            persistence.extend(remove_installation_interactions(
                &mut state,
                &definition.installation_id,
                Some(generation),
                SessionAttentionStatus::Stale,
            ));
        } else {
            let observed = match definition.product_id.as_str() {
                "pi" => {
                    if definition.adapter_id.as_str()
                        == crate::pi_acp_interactions::PI_ACP_ADAPTER_ID
                    {
                        persistence.extend(observe_pi_acp(
                            &mut state,
                            &definition,
                            generation,
                            event,
                        )?);
                    } else {
                        observe_pi(&mut state, &definition, generation, event);
                    }
                    None
                }
                "opencode" => observe_opencode(&mut state, &definition, generation, event),
                "codex" => {
                    if definition.adapter_id.as_str() == "codex-acp-stdio-v1" {
                        persistence.extend(observe_codex_acp(
                            &mut state,
                            &definition,
                            generation,
                            event,
                        )?);
                    } else {
                        persistence.extend(observe_codex(
                            &mut state,
                            &definition,
                            generation,
                            event,
                        )?);
                    }
                    None
                }
                _ => None,
            };
            persistence.extend(observed);
            if definition.product_id.as_str() == "opencode"
                && let Some(session_id) = opencode_idle_session(event)
            {
                persistence.extend(remove_session_interactions(
                    &mut state,
                    &definition,
                    generation,
                    session_id,
                ));
            }
        }
        drop(state);
        self.persist(persistence)
    }


    pub(crate) fn codex_request(
        &self,
        definition: &RuntimeBinding,
        generation: u64,
        id: &str,
        session: &str,
    ) -> Result<crate::codex_interactions::CodexInteraction, String> {
        let state = self.state.lock().map_err(|_| "交互状态不可用")?;
        state
            .interactions
            .get(&InteractionKey {
                installation_id: definition.installation_id.clone(),
                generation,
                interaction_id: id.into(),
            })
            .filter(|p| {
                &p.definition == definition
                    && p.native_session_id.as_deref() == Some(session)
                    && p.state == InteractionState::Pending
            })
            .and_then(|p| p.codex.clone())
            .ok_or_else(|| "Codex 交互不属于此会话、已回复或已失效".into())
    }

    pub(crate) fn codex_acp_request(
        &self,
        binding: &RuntimeBinding,
        generation: u64,
        key: &str,
    ) -> Result<crate::codex_acp::interactions::Interaction, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "Interaction Registry unavailable")?;
        if !state
            .latest_generations
            .get(&binding.installation_id)
            .is_some_and(|(b, g)| b == binding && *g == generation)
        {
            return Err("Retired interaction generation".into());
        }
        state
            .interactions
            .get(&InteractionKey {
                installation_id: binding.installation_id.clone(),
                generation,
                interaction_id: key.into(),
            })
            .filter(|p| p.definition == *binding && p.state == InteractionState::Pending)
            .and_then(|p| p.codex_acp.clone())
            .ok_or_else(|| "Interaction unavailable or already responding".into())
    }

    pub(crate) fn begin_response(
        &self,
        definition: impl Into<RuntimeBinding>,
        generation: u64,
        interaction_id: &str,
        native_session_id: Option<&str>,
    ) -> Result<(), String> {
        let definition = definition.into();
        self.expire_native_timeouts()?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Interaction Registry is unavailable".to_string())?;
        if state
            .latest_generations
            .get(&definition.installation_id)
            .is_some_and(|(binding, latest)| binding != &definition || *latest != generation)
        {
            return Err(format!(
                "{} interaction belongs to a stale Runtime generation",
                definition.product_id
            ));
        }
        let key = InteractionKey {
            installation_id: definition.installation_id.clone(),
            generation,
            interaction_id: interaction_id.to_string(),
        };
        let interaction = state.interactions.get_mut(&key).ok_or_else(|| {
            format!(
                "{} interaction is unknown or no longer pending",
                definition.product_id
            )
        })?;
        if interaction.definition != definition
            || interaction.native_session_id.as_deref() != native_session_id
        {
            return Err(format!(
                "{} interaction does not belong to the supplied native Session",
                definition.product_id
            ));
        }
        if interaction.state != InteractionState::Pending {
            return Err(format!(
                "{} interaction response is already in flight",
                definition.product_id
            ));
        }
        interaction.state = InteractionState::Responding;
        Ok(())
    }

    pub(crate) fn finish_response(
        &self,
        definition: impl Into<RuntimeBinding>,
        generation: u64,
        interaction_id: &str,
        succeeded: bool,
    ) -> Result<(), String> {
        let definition = definition.into();
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Interaction Registry is unavailable".to_string())?;
        let key = InteractionKey {
            installation_id: definition.installation_id.clone(),
            generation,
            interaction_id: interaction_id.to_string(),
        };
        if state
            .interactions
            .get(&key)
            .is_some_and(|pending| pending.definition != definition)
        {
            return Err("Interaction response belongs to another Runtime binding".into());
        }
        let persistence = if succeeded {
            state.interactions.remove(&key).map(|interaction| {
                InteractionPersistence::Transition(interaction, SessionAttentionStatus::Closed)
            })
        } else if let Some(interaction) = state.interactions.get_mut(&key)
            && interaction.state == InteractionState::Responding
        {
            interaction.state = InteractionState::Pending;
            None
        } else {
            None
        };
        drop(state);
        self.persist(persistence.into_iter().collect())
    }

    pub(crate) fn has_pending_for_session(
        &self,
        binding: &RuntimeBinding,
        generation: u64,
        native_session_id: &str,
    ) -> Result<bool, String> {
        self.expire_native_timeouts()?;
        let state = self
            .state
            .lock()
            .map_err(|_| "Interaction Registry is unavailable")?;
        Ok(state.interactions.values().any(|interaction| {
            interaction.definition == *binding
                && interaction.key.generation == generation
                && interaction.native_session_id.as_deref() == Some(native_session_id)
        }))
    }

    pub(crate) fn snapshots(&self) -> Result<Vec<InteractionSnapshot>, String> {
        self.expire_native_timeouts()?;
        let state = self
            .state
            .lock()
            .map_err(|_| "Interaction Registry is unavailable".to_string())?;
        let mut snapshots = state
            .interactions
            .values()
            .filter(|interaction| {
                state
                    .latest_generations
                    .get(&interaction.key.installation_id)
                    .is_some_and(|(binding, generation)| {
                        binding == &interaction.definition
                            && *generation == interaction.key.generation
                    })
            })
            .map(|interaction| InteractionSnapshot {
                runtime: interaction.definition.identity(),
                runtime_generation: interaction.key.generation,
                interaction_id: interaction.key.interaction_id.clone(),
                native_session_id: interaction.native_session_id.clone(),
                kind: interaction.kind,
                state: interaction.state,
                codex: interaction.codex.clone(),
                pi_acp: interaction.pi_acp.clone(),
                codex_acp: interaction.codex_acp.clone(),
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

    fn expire_native_timeouts(&self) -> Result<(), String> {
        let now = Instant::now();
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Interaction Registry is unavailable".to_string())?;
        let expired = state
            .interactions
            .iter()
            .filter(|(_, interaction)| {
                interaction
                    .expires_at
                    .is_some_and(|deadline| now >= deadline)
            })
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        let persistence = expired
            .into_iter()
            .filter_map(|key| state.interactions.remove(&key))
            .map(|interaction| {
                InteractionPersistence::Transition(interaction, SessionAttentionStatus::Stale)
            })
            .collect();
        drop(state);
        self.persist(persistence)
    }

    fn persist(&self, actions: Vec<InteractionPersistence>) -> Result<(), String> {
        if actions.is_empty() {
            return Ok(());
        }
        let store = self
            .host_store
            .lock()
            .map_err(|_| "Interaction Registry Host store is unavailable".to_string())?
            .clone();
        let Some(store) = store else {
            return Ok(());
        };
        for action in actions {
            let interaction = action.interaction();
            let Some(native_session_id) = interaction.native_session_id.as_deref() else {
                continue;
            };
            let native_session_id =
                NativeSessionId::parse(native_session_id).map_err(|error| error.to_string())?;
            let Some(farfold_session_id) = store
                .resolve_farfold_session(interaction.definition.clone(), &native_session_id)?
            else {
                continue;
            };
            let input = OpenSessionAttention {
                farfold_session_id: &farfold_session_id,
                kind: SessionAttentionKind::RuntimeInteraction,
                runtime_generation: interaction.key.generation,
                native_interaction_id: Some(&interaction.key.interaction_id),
            };
            match &action {
                InteractionPersistence::Open(interaction) => {
                    let (attention, _) = store.open_session_attention(input)?;
                    if attention.status != SessionAttentionStatus::Open {
                        self.discard_interaction(&interaction.key)?;
                    }
                }
                InteractionPersistence::Transition(_, target) => {
                    store.transition_matching_session_attention(input, *target)?;
                }
            }
        }
        Ok(())
    }

    fn discard_interaction(&self, key: &InteractionKey) -> Result<(), String> {
        self.state
            .lock()
            .map_err(|_| "Interaction Registry is unavailable".to_string())?
            .interactions
            .remove(key);
        Ok(())
    }
}

enum InteractionPersistence {
    Open(PendingInteraction),
    Transition(PendingInteraction, SessionAttentionStatus),
}

impl InteractionPersistence {
    fn interaction(&self) -> &PendingInteraction {
        match self {
            Self::Open(interaction) | Self::Transition(interaction, _) => interaction,
        }
    }
}

fn remove_installation_interactions(
    state: &mut RegistryState,
    installation_id: &InstallationId,
    generation: Option<u64>,
    target: SessionAttentionStatus,
) -> Vec<InteractionPersistence> {
    let keys = state
        .interactions
        .keys()
        .filter(|key| {
            &key.installation_id == installation_id
                && generation.is_none_or(|generation| key.generation == generation)
        })
        .cloned()
        .collect::<Vec<_>>();
    keys.into_iter()
        .filter_map(|key| state.interactions.remove(&key))
        .map(|interaction| InteractionPersistence::Transition(interaction, target))
        .collect()
}

fn insert_interaction(
    state: &mut RegistryState,
    definition: &RuntimeBinding,
    generation: u64,
    interaction_id: &str,
    native_session_id: Option<&str>,
    kind: InteractionKind,
    timeout: Option<Duration>,
) {
    if interaction_id.is_empty() || interaction_id.len() > 128 {
        return;
    }
    let key = InteractionKey {
        installation_id: definition.installation_id.clone(),
        generation,
        interaction_id: interaction_id.to_string(),
    };
    state
        .interactions
        .entry(key.clone())
        .or_insert_with(|| PendingInteraction {
            definition: definition.clone(),
            key,
            native_session_id: native_session_id.map(str::to_string),
            kind,
            state: InteractionState::Pending,
            // Use the native timeout only. A Host deadline never manufactures
            // an approval/cancellation reply or a task terminal event.
            expires_at: timeout.and_then(|duration| Instant::now().checked_add(duration)),
            codex: None,
            pi_acp: None,
            codex_acp: None,
        });
}

// Only the Codex adapter's verified interaction event opens a request. Raw
// RPC remains evidence, but cannot create a second interaction authority.
fn observe_codex_acp(
    state: &mut RegistryState,
    definition: &RuntimeBinding,
    generation: u64,
    event: &RoutedRuntimeEvent,
) -> Result<Vec<InteractionPersistence>, String> {
    use crate::codex_acp::{
        Scope,
        interactions::Interaction,
        turns::{Event, Payload},
    };
    if matches!(event.kind(), "transport_error" | "transport_gap") {
        return Ok(remove_installation_interactions(
            state,
            &definition.installation_id,
            Some(generation),
            SessionAttentionStatus::Stale,
        ));
    }
    let raw = &event.native_envelope()["payload"];
    if event.kind() != "acp" || raw["method"] != "_codex/turn/event" {
        return Ok(vec![]);
    }
    let scope: Scope = serde_json::from_value(raw["params"]["scope"].clone())
        .map_err(|_| "Invalid scoped interaction")?;
    if scope.binding()? != *definition || scope.generation != generation {
        return Err("Interaction binding differs".into());
    }
    let turn: Event = serde_json::from_value(raw["params"]["turn"].clone())
        .map_err(|_| "Invalid typed Turn interaction")?;
    if matches!(turn.payload, Payload::InteractionOpen { .. }) {
        let interaction = Interaction::from_event(scope, &turn)?;
        let key = InteractionKey {
            installation_id: definition.installation_id.clone(),
            generation,
            interaction_id: interaction.request.key.clone(),
        };
        if state.interactions.contains_key(&key) {
            return Err("Duplicate native interaction event".into());
        }
        if state
            .interactions
            .values()
            .filter(|p| p.definition == *definition)
            .count()
            >= 32
        {
            return Err("Native interaction pressure".into());
        }
        insert_interaction(
            state,
            definition,
            generation,
            &interaction.request.key,
            Some(&interaction.context.thread.native_thread_id),
            InteractionKind::CodexNative,
            None,
        );
        let pending = state
            .interactions
            .get_mut(&key)
            .ok_or("Interaction registration unavailable")?;
        pending.codex_acp = Some(interaction);
        return Ok(vec![InteractionPersistence::Open(pending.clone())]);
    }
    if let Payload::InteractionEnd {
        native_request_id,
        item_id,
        resolution,
    } = turn.payload
    {
        if !matches!(
            resolution.as_str(),
            "native_resolved" | "terminal" | "expired" | "stop_requested" | "mode_changed"
        ) {
            return Err("Unknown interaction resolution".into());
        }
        let keys = state
            .interactions
            .iter()
            .filter(|(_, p)| {
                p.definition == *definition
                    && p.key.generation == generation
                    && p.codex_acp.as_ref().is_some_and(|r| {
                        r.context == turn.context
                            && r.native_turn_id == turn.native_turn_id
                            && r.request.item_id == item_id
                            && r.request.native_request["id"] == native_request_id
                    })
            })
            .map(|(k, _)| k.clone())
            .collect::<Vec<_>>();
        return Ok(keys
            .into_iter()
            .filter_map(|k| state.interactions.remove(&k))
            .map(|p| {
                InteractionPersistence::Transition(
                    p,
                    if resolution == "native_resolved" {
                        SessionAttentionStatus::Closed
                    } else {
                        SessionAttentionStatus::Stale
                    },
                )
            })
            .collect());
    }
    Ok(vec![])
}

fn observe_codex(
    state: &mut RegistryState,
    definition: &RuntimeBinding,
    generation: u64,
    event: &RoutedRuntimeEvent,
) -> Result<Vec<InteractionPersistence>, String> {
    let payload = &event.native_envelope()["payload"];
    if event.kind() == "codex_interaction" {
        let request = crate::codex_interactions::CodexInteraction::parse(payload.clone())?;
        let key = InteractionKey {
            installation_id: definition.installation_id.clone(),
            generation,
            interaction_id: request.key.clone(),
        };
        if state.interactions.contains_key(&key) {
            return Ok(vec![]);
        }
        if state
            .interactions
            .values()
            .filter(|p| p.definition == *definition)
            .count()
            >= 32
        {
            return Err("Codex 待处理交互超过限制".into());
        }
        insert_interaction(
            state,
            definition,
            generation,
            &request.key,
            Some(&request.thread_id),
            InteractionKind::CodexNative,
            None,
        );
        let interaction = state
            .interactions
            .get_mut(&key)
            .ok_or("无法登记 Codex 交互")?;
        interaction.codex = Some(request);
        return Ok(vec![InteractionPersistence::Open(interaction.clone())]);
    }
    let is_failure = matches!(
        event.kind(),
        "transport_gap" | "transport_error" | "codex_interactions_invalidated"
    );
    let raw = event.kind() == "codex_rpc";
    let resolved = raw && payload["method"] == "serverRequest/resolved";
    let completed = raw && payload["method"] == "turn/completed";
    let resolved_key = if resolved {
        Some(crate::codex_interactions::request_key(
            &payload["params"]["requestId"],
        )?)
    } else {
        None
    };
    let keys = state
        .interactions
        .iter()
        .filter(|(_, p)| p.definition == *definition && p.key.generation == generation)
        .filter(|(_, p)| {
            is_failure
                || p.codex.as_ref().is_some_and(|r| {
                    r.thread_id == payload["params"]["threadId"].as_str().unwrap_or("")
                        && ((resolved
                            && resolved_key
                                == crate::codex_interactions::request_key(&r.native_request["id"])
                                    .ok())
                            || (completed && payload["params"]["turn"]["id"] == r.turn_id))
                })
        })
        .map(|(k, _)| k.clone())
        .collect::<Vec<_>>();
    Ok(keys
        .into_iter()
        .filter_map(|k| state.interactions.remove(&k))
        .map(|p| {
            InteractionPersistence::Transition(
                p,
                if resolved {
                    SessionAttentionStatus::Closed
                } else {
                    SessionAttentionStatus::Stale
                },
            )
        })
        .collect())
}

fn observe_pi_acp(
    state: &mut RegistryState,
    definition: &RuntimeBinding,
    generation: u64,
    event: &RoutedRuntimeEvent,
) -> Result<Option<InteractionPersistence>, String> {
    if event.kind() != "acp" {
        return Ok(None);
    }
    let envelope = &event.native_envelope()["payload"];
    match envelope["method"].as_str() {
        Some("elicitation/create") => {
            let dialog = crate::pi_acp_interactions::PiAcpDialog::parse(envelope)?;
            let key = InteractionKey {
                installation_id: definition.installation_id.clone(),
                generation,
                interaction_id: dialog.request_key.clone(),
            };
            if state.interactions.contains_key(&key)
                || state.interactions.values().any(|existing| {
                    existing.definition == *definition
                        && existing.key.generation == generation
                        && existing.pi_acp.as_ref().is_some_and(|pi| {
                            pi.native_session_id == dialog.native_session_id
                                && pi.native_request_id == dialog.native_request_id
                        })
                })
            {
                return Err("Pi ACP dialog identity is already pending".into());
            }
            insert_interaction(
                state,
                definition,
                generation,
                &dialog.request_key,
                Some(&dialog.native_session_id),
                InteractionKind::PiExtensionDialog,
                None,
            );
            let pending = state
                .interactions
                .get_mut(&key)
                .ok_or("Pi ACP request key is invalid")?;
            pending.pi_acp = Some(dialog);
            Ok(Some(InteractionPersistence::Open(pending.clone())))
        }
        Some("_pi/ui_withdrawn") => {
            let withdrawn = crate::pi_acp_interactions::PiAcpWithdrawal::parse(envelope)?;
            let key = state
                .interactions
                .iter()
                .find(|(_, pending)| {
                    pending.definition == *definition
                        && pending.key.generation == generation
                        && pending.pi_acp.as_ref().is_some_and(|dialog| {
                            dialog.native_session_id == withdrawn.native_session_id
                                && dialog.native_request_id == withdrawn.native_request_id
                        })
                })
                .map(|(key, _)| key.clone());
            Ok(key
                .and_then(|key| state.interactions.remove(&key))
                .map(|pending| {
                    InteractionPersistence::Transition(pending, SessionAttentionStatus::Stale)
                }))
        }
        _ => Ok(None),
    }
}

fn observe_pi(
    state: &mut RegistryState,
    definition: &RuntimeBinding,
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
            payload
                .get("timeout")
                .and_then(Value::as_u64)
                .filter(|timeout| *timeout > 0)
                .map(Duration::from_millis),
        );
    }
}

fn opencode_idle_session(event: &RoutedRuntimeEvent) -> Option<&str> {
    if event.kind() != "sse" {
        return None;
    }
    let outer = event.native_envelope().get("payload")?;
    let native = outer.get("payload").unwrap_or(outer);
    let properties = native.get("properties")?;
    let idle = native.get("type").and_then(Value::as_str) == Some("session.idle")
        || (native.get("type").and_then(Value::as_str) == Some("session.status")
            && properties.pointer("/status/type").and_then(Value::as_str) == Some("idle"));
    if idle {
        properties.get("sessionID").and_then(Value::as_str)
    } else {
        None
    }
}

fn remove_session_interactions(
    state: &mut RegistryState,
    definition: &RuntimeBinding,
    generation: u64,
    native_session_id: &str,
) -> Vec<InteractionPersistence> {
    let keys = state
        .interactions
        .iter()
        .filter(|(key, interaction)| {
            key.installation_id == definition.installation_id
                && key.generation == generation
                && interaction.native_session_id.as_deref() == Some(native_session_id)
        })
        .map(|(key, _)| key.clone())
        .collect::<Vec<_>>();
    keys.into_iter()
        .filter_map(|key| state.interactions.remove(&key))
        .map(|interaction| {
            InteractionPersistence::Transition(interaction, SessionAttentionStatus::Stale)
        })
        .collect()
}

fn json_rpc_id_key(value: &Value) -> Option<String> {
    if let Some(id) = value.as_str() {
        return Some(id.to_string());
    }
    if value.is_i64() || value.is_u64() {
        return Some(value.to_string());
    }
    None
}

fn observe_opencode(
    state: &mut RegistryState,
    definition: &RuntimeBinding,
    generation: u64,
    event: &RoutedRuntimeEvent,
) -> Option<InteractionPersistence> {
    if event.kind() == "acp" {
        let payload = event.native_envelope().get("payload")?;
        let method = payload.get("method").and_then(Value::as_str)?;
        if method != "session/request_permission" && method != "elicitation/create" {
            return None;
        }
        let id = json_rpc_id_key(payload.get("id")?)?;
        let session_id = payload
            .pointer("/params/sessionId")
            .and_then(Value::as_str)?;
        let kind = if method == "elicitation/create" {
            InteractionKind::OpenCodeQuestion
        } else {
            InteractionKind::OpenCodePermission
        };
        insert_interaction(
            state,
            definition,
            generation,
            &id,
            Some(session_id),
            kind,
            None,
        );
        let key = InteractionKey {
            installation_id: definition.installation_id.clone(),
            generation,
            interaction_id: id,
        };
        return state
            .interactions
            .get(&key)
            .cloned()
            .map(InteractionPersistence::Open);
    }
    if event.kind() != "sse" {
        return None;
    }
    let payload = event.native_envelope().get("payload")?;
    let payload = payload.get("payload").unwrap_or(payload);
    let properties = payload.get("properties")?;
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
                    None,
                );
                let key = InteractionKey {
                    installation_id: definition.installation_id.clone(),
                    generation,
                    interaction_id: id.to_string(),
                };
                return state
                    .interactions
                    .get(&key)
                    .cloned()
                    .map(InteractionPersistence::Open);
            }
        }
        Some("permission.replied") => {
            if let Some(id) = properties.get("requestID").and_then(Value::as_str) {
                return state
                    .interactions
                    .remove(&InteractionKey {
                        installation_id: definition.installation_id.clone(),
                        generation,
                        interaction_id: id.to_string(),
                    })
                    .map(|interaction| {
                        InteractionPersistence::Transition(
                            interaction,
                            SessionAttentionStatus::Closed,
                        )
                    });
            }
        }
        _ => {}
    }
    None
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
        host_ids::{AdapterId, ConnectionId, InstallationId, RuntimeBuildId, RuntimeProductId},
        host_store::{
            HostStore,
            records::{RuntimeConnectionKind, RuntimeDistribution, RuntimeRegistration},
            session_attention::{SessionAttentionKind, SessionAttentionStatus},
            session_binding_index::{NativeSessionRegistrationInput, register_native_session},
        },
        runtime_event_router::RuntimeEventRouter,
        runtime_registry::{OPENCODE_RUNTIME, PI_RUNTIME},
    };
    use serde_json::json;
    use std::{fs, path::PathBuf};

    #[test]
    fn codex_requests_use_full_binding_and_native_resolution_in_shared_registry() {
        use crate::runtime_registry::RuntimeBinding;
        let registry = InteractionRegistry::default();
        let router =
            RuntimeEventRouter::with_capacity_and_observers(16, None, Some(registry.clone()));
        let binding = RuntimeBinding {
            product_id: RuntimeProductId::parse("codex").unwrap(),
            installation_id: InstallationId::parse("selected-codex").unwrap(),
            runtime_build_id: RuntimeBuildId::parse("codex@0.143.0").unwrap(),
            adapter_id: AdapterId::parse("codex-app-server").unwrap(),
            connection_id: ConnectionId::parse("private-stdio").unwrap(),
        };
        let native = json!({"id":8,"method":"item/fileChange/requestApproval","params":{"threadId":"thread","turnId":"turn","itemId":"patch"}});
        router
            .route(
                binding.clone(),
                json!({"generation":2,"kind":"codex_rpc","payload":native}),
            )
            .unwrap();
        assert!(registry.snapshots().unwrap().is_empty());
        router
            .route(
                binding.clone(),
                json!({"generation":2,"kind":"codex_interaction","payload":native}),
            )
            .unwrap();
        let key = crate::codex_interactions::CodexInteraction::parse(native)
            .unwrap()
            .key;
        assert_eq!(registry.snapshots().unwrap().len(), 1);
        assert!(registry.codex_request(&binding, 1, &key, "thread").is_err());
        assert!(
            registry
                .codex_request(&binding, 2, &key, "another")
                .is_err()
        );
        let mut wrong = binding.clone();
        wrong.connection_id = ConnectionId::parse("other-stdio").unwrap();
        assert!(registry.codex_request(&wrong, 2, &key, "thread").is_err());
        registry
            .begin_response(binding.clone(), 2, &key, Some("thread"))
            .unwrap();
        assert!(
            registry
                .begin_response(binding.clone(), 2, &key, Some("thread"))
                .is_err()
        );
        router.route(binding.clone(),json!({"generation":2,"kind":"codex_rpc","payload":{"method":"serverRequest/resolved","params":{"threadId":"another","requestId":8}}})).unwrap();
        assert_eq!(registry.snapshots().unwrap().len(), 1);
        router.route(binding.clone(),json!({"generation":2,"kind":"codex_rpc","payload":{"method":"serverRequest/resolved","params":{"threadId":"thread","requestId":8}}})).unwrap();
        assert!(registry.snapshots().unwrap().is_empty());
        router.route(binding.clone(),json!({"generation":2,"kind":"codex_interaction","payload":{"id":9,"method":"item/fileChange/requestApproval","params":{"threadId":"thread","turnId":"next-turn","itemId":"patch"}}})).unwrap();
        registry.advance_generation(binding.clone(), 3).unwrap();
        assert!(registry.snapshots().unwrap().is_empty());
        assert!(
            registry
                .begin_response(binding, 2, &key, Some("thread"))
                .is_err()
        );
    }

    #[test]
    fn dynamic_interactions_require_exact_binding_and_expire_on_generation_change() {
        use super::{InteractionKind, insert_interaction};
        use crate::runtime_registry::RuntimeBinding;
        let registry = InteractionRegistry::default();
        let binding = RuntimeBinding {
            product_id: RuntimeProductId::parse("test-runtime").unwrap(),
            installation_id: InstallationId::parse("dynamic-installation").unwrap(),
            runtime_build_id: RuntimeBuildId::parse("test@1").unwrap(),
            adapter_id: AdapterId::parse("test-adapter").unwrap(),
            connection_id: ConnectionId::parse("private-test").unwrap(),
        };
        registry.advance_generation(binding.clone(), 7).unwrap();
        insert_interaction(
            &mut registry.state.lock().unwrap(),
            &binding,
            7,
            "native-request",
            Some("native-session"),
            InteractionKind::OpenCodePermission,
            None,
        );
        let mut other = binding.clone();
        other.connection_id = ConnectionId::parse("other-private-test").unwrap();
        assert!(
            registry
                .has_pending_for_session(&binding, 7, "native-session")
                .unwrap()
        );
        assert!(
            !registry
                .has_pending_for_session(&other, 7, "native-session")
                .unwrap()
        );
        assert!(
            !registry
                .has_pending_for_session(&binding, 8, "native-session")
                .unwrap()
        );
        assert!(
            !registry
                .has_pending_for_session(&binding, 7, "other-session")
                .unwrap()
        );
        assert!(registry.advance_generation(other.clone(), 8).is_err());
        assert!(
            registry
                .begin_response(other.clone(), 7, "native-request", Some("native-session"))
                .is_err()
        );
        assert!(
            registry
                .finish_response(other, 7, "native-request", true)
                .is_err()
        );
        assert_eq!(registry.snapshots().unwrap().len(), 1);
        assert!(
            registry
                .begin_response(binding.clone(), 7, "native-request", Some("wrong-session"))
                .is_err()
        );
        registry
            .begin_response(binding.clone(), 7, "native-request", Some("native-session"))
            .unwrap();
        assert!(
            registry
                .has_pending_for_session(&binding, 7, "native-session")
                .unwrap()
        );
        assert!(
            registry
                .begin_response(binding.clone(), 7, "native-request", Some("native-session"))
                .is_err()
        );
        registry.advance_generation(binding.clone(), 8).unwrap();
        registry
            .finish_response(binding.clone(), 7, "native-request", false)
            .unwrap();
        assert!(registry.snapshots().unwrap().is_empty());
        assert!(
            registry
                .begin_response(binding, 7, "native-request", Some("native-session"))
                .is_err()
        );
    }

    #[test]
    fn an_event_cannot_borrow_a_known_installation_with_another_connection() {
        let registry = InteractionRegistry::default();
        let router =
            RuntimeEventRouter::with_capacity_and_observers(8, None, Some(registry.clone()));
        let mut binding = crate::runtime_registry::RuntimeBinding::from(PI_RUNTIME);
        binding.connection_id = ConnectionId::parse("wrong-connection").unwrap();
        assert!(router.route(binding, json!({"generation":1,"kind":"rpc","payload":{"type":"extension_ui_request","id":"request","method":"confirm"}})).is_err());
        assert!(registry.snapshots().unwrap().is_empty());
    }

    struct TestHost(PathBuf);

    impl TestHost {
        fn new(name: &str) -> (Self, HostStore) {
            let path = std::env::temp_dir().join(format!(
                "farfold-interaction-registry-{name}-{}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            let project = path.join("project");
            fs::create_dir_all(&project).unwrap();
            let store = HostStore::open(path.join("host.sqlite3"));
            store
                .register_runtime(&RuntimeRegistration {
                    runtime_product_id: RuntimeProductId::parse(OPENCODE_RUNTIME.product_id)
                        .unwrap(),
                    display_name: OPENCODE_RUNTIME.display_name.to_string(),
                    installation_id: InstallationId::parse(OPENCODE_RUNTIME.installation_id)
                        .unwrap(),
                    runtime_build_id: RuntimeBuildId::parse(OPENCODE_RUNTIME.runtime_build_id)
                        .unwrap(),
                    adapter_id: AdapterId::parse(OPENCODE_RUNTIME.adapter_id).unwrap(),
                    distribution: RuntimeDistribution::Managed,
                    observed_version: OPENCODE_RUNTIME.version.to_string(),
                    artifact_sha256: OPENCODE_RUNTIME.binary_sha256.to_string(),
                    connection_id: ConnectionId::parse(OPENCODE_RUNTIME.default_connection_id)
                        .unwrap(),
                    connection_label: "OpenCode native configuration".to_string(),
                    connection_kind: RuntimeConnectionKind::ManagedLocal,
                    created_at: 1,
                    verified_at: 1,
                })
                .unwrap();
            register_native_session(
                &store,
                OPENCODE_RUNTIME,
                NativeSessionRegistrationInput {
                    native_session_id: "ses_1",
                    working_copy_path: &project,
                    title: "Session",
                    created_at: 2,
                    updated_at: 2,
                },
            )
            .unwrap();
            (Self(path), store)
        }
    }

    impl Drop for TestHost {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

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
    fn pi_acp_forms_use_shared_registry_and_exact_withdrawal_identity() {
        let registry = InteractionRegistry::default();
        let router =
            RuntimeEventRouter::with_capacity_and_observers(32, None, Some(registry.clone()));
        let mut binding = crate::runtime_registry::RuntimeBinding::from(PI_RUNTIME);
        binding.installation_id = InstallationId::parse("pi-acp-fixture-install").unwrap();
        binding.adapter_id =
            AdapterId::parse(crate::pi_acp_interactions::PI_ACP_ADAPTER_ID).unwrap();
        binding.connection_id = ConnectionId::parse("pi-acp-fixture-profile").unwrap();
        router.activate_connection(binding.clone(), 2).unwrap();
        let form = crate::pi_acp_interactions::form_fixture();
        let envelope =
            |generation, payload| json!({"generation":generation,"kind":"acp","payload":payload});
        router
            .route(binding.clone(), envelope(2, form.clone()))
            .unwrap();
        let snapshots = registry.snapshots().unwrap();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].interaction_id, "7");
        assert_eq!(
            snapshots[0].pi_acp.as_ref().unwrap().native_request_id,
            "native-dialog"
        );
        assert!(
            registry
                .begin_response(binding.clone(), 2, "native-dialog", Some("native-session"))
                .is_err()
        );
        assert!(
            registry
                .begin_response(binding.clone(), 2, "7", Some("other-session"))
                .is_err()
        );
        let withdraw = |session, id| json!({"jsonrpc":"2.0","method":"_pi/ui_withdrawn","params":{"sessionId":session,"nativeRequestId":id,"version":1,"reason":"timeout"}});
        router
            .route(
                binding.clone(),
                envelope(2, withdraw("other-session", "native-dialog")),
            )
            .unwrap();
        router
            .route(
                binding.clone(),
                envelope(2, withdraw("native-session", "wrong-id")),
            )
            .unwrap();
        router
            .route(
                binding.clone(),
                envelope(1, withdraw("native-session", "native-dialog")),
            )
            .unwrap();
        assert_eq!(registry.snapshots().unwrap().len(), 1);
        router
            .route(
                binding.clone(),
                envelope(2, withdraw("native-session", "native-dialog")),
            )
            .unwrap();
        assert!(registry.snapshots().unwrap().is_empty());
        assert!(
            registry
                .begin_response(binding.clone(), 2, "7", Some("native-session"))
                .is_err()
        );
        router.activate_connection(binding.clone(), 3).unwrap();
        router.route(binding.clone(), envelope(3, form)).unwrap();
        router
            .route(
                binding.clone(),
                envelope(2, withdraw("native-session", "native-dialog")),
            )
            .unwrap();
        assert_eq!(registry.snapshots().unwrap().len(), 1);
        registry
            .begin_response(binding.clone(), 3, "7", Some("native-session"))
            .unwrap();
        registry.finish_response(binding, 3, "7", true).unwrap();
        assert!(registry.snapshots().unwrap().is_empty());
    }

    #[test]
    fn opencode_idle_expires_only_matching_permissions_without_a_reply_event() {
        let registry = InteractionRegistry::default();
        let router =
            RuntimeEventRouter::with_capacity_and_observers(16, None, Some(registry.clone()));
        for (id, session) in [
            ("per_1", "ses_1"),
            ("per_2", "ses_1"),
            ("per_other", "ses_other"),
        ] {
            router
                .route(
                    OPENCODE_RUNTIME,
                    json!({"generation": 4, "kind":"sse", "payload": {
                        "type":"permission.asked", "properties":{"id":id,"sessionID":session}
                    }}),
                )
                .unwrap();
        }
        router
            .route(
                OPENCODE_RUNTIME,
                json!({"generation":3,"kind":"sse","payload":{
                    "type":"session.idle","properties":{"sessionID":"ses_1"}
                }}),
            )
            .unwrap();
        assert_eq!(registry.snapshots().unwrap().len(), 3);
        router.route(OPENCODE_RUNTIME, json!({"generation":4,"kind":"sse","payload":{
            "type":"session.status","properties":{"sessionID":"ses_1","status":{"type":"idle"}}
        }})).unwrap();
        let remaining = registry.snapshots().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].interaction_id, "per_other");
        assert!(
            registry
                .begin_response(OPENCODE_RUNTIME, 4, "per_1", Some("ses_1"))
                .is_err()
        );
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

    #[test]
    fn opencode_attention_persists_only_bounded_identity_and_closes_on_reply() {
        let (_root, host) = TestHost::new("durable");
        let registry = InteractionRegistry::default();
        registry.attach_host_store(host.clone()).unwrap();
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
                        "properties": {
                            "id": "per_1",
                            "sessionID": "ses_1",
                            "permission": "contains-runtime-native-payload"
                        }
                    }
                }),
            )
            .unwrap();
        let attention = host.session_attention_snapshot().unwrap();
        assert_eq!(attention.len(), 1);
        assert_eq!(attention[0].kind, SessionAttentionKind::RuntimeInteraction);
        assert_eq!(attention[0].status, SessionAttentionStatus::Open);
        assert_eq!(attention[0].native_interaction_id.as_deref(), Some("per_1"));
        assert!(
            !serde_json::to_string(&attention)
                .unwrap()
                .contains("permission")
        );

        registry
            .begin_response(OPENCODE_RUNTIME, 4, "per_1", Some("ses_1"))
            .unwrap();
        registry
            .finish_response(OPENCODE_RUNTIME, 4, "per_1", true)
            .unwrap();
        let attention = host.session_attention_snapshot().unwrap();
        assert_eq!(attention.len(), 1);
        assert_eq!(attention[0].status, SessionAttentionStatus::Closed);
        assert!(registry.snapshots().unwrap().is_empty());

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
        assert!(registry.snapshots().unwrap().is_empty());
        assert_eq!(
            host.session_attention_snapshot().unwrap()[0].status,
            SessionAttentionStatus::Closed
        );
    }

    
    #[test]
    fn generation_change_marks_durable_attention_stale() {
        let (_root, host) = TestHost::new("stale");
        let registry = InteractionRegistry::default();
        registry.attach_host_store(host.clone()).unwrap();
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
        router
            .route(
                OPENCODE_RUNTIME,
                json!({ "generation": 5, "kind": "lifecycle", "payload": { "state": "started" } }),
            )
            .unwrap();

        assert_eq!(
            host.session_attention_snapshot().unwrap()[0].status,
            SessionAttentionStatus::Stale
        );
        assert!(registry.snapshots().unwrap().is_empty());
    }
    #[test]
    fn native_pi_timeout_removes_attention_but_keeps_untimed_dialogs() {
        let registry = InteractionRegistry::default();
        let router =
            RuntimeEventRouter::with_capacity_and_observers(8, None, Some(registry.clone()));
        for (id, timeout) in [("timed", Some(1)), ("untimed", None)] {
            router
                .route(
                    PI_RUNTIME,
                    json!({
                        "generation": 2, "kind": "rpc",
                        "payload": { "type": "extension_ui_request", "id": id,
                            "method": "confirm", "timeout": timeout }
                    }),
                )
                .unwrap();
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
        let pending = registry.snapshots().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].interaction_id, "untimed");
    }

    #[test]
    fn native_pi_timeout_rejects_a_late_reply_without_a_prior_snapshot() {
        let registry = InteractionRegistry::default();
        let router =
            RuntimeEventRouter::with_capacity_and_observers(8, None, Some(registry.clone()));
        router
            .route(
                PI_RUNTIME,
                json!({
                    "generation": 2, "kind": "rpc",
                    "payload": { "type": "extension_ui_request", "id": "timed",
                        "method": "input", "timeout": 1 }
                }),
            )
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        assert!(
            registry
                .begin_response(PI_RUNTIME, 2, "timed", None)
                .is_err()
        );
        registry
            .finish_response(PI_RUNTIME, 2, "timed", false)
            .unwrap();
        assert!(registry.snapshots().unwrap().is_empty());
    }
}
