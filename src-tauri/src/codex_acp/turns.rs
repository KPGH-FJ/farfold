//! Headless synthetic Turn contracts on the shared Host authorities. No Tauri entry.
use super::*;
use crate::{
    acp_session_operations::AcpSessionOperationKind,
    host_ids::{FarfoldSessionId, HostTurnId, RuntimeProfileId, WorkingCopyId},
    host_store::{
        HostStore, provider_projection::TurnProviderBindingAuthority,
        records::NativeSessionLocatorKind, session_open::SessionOpenTarget,
    },
    runtime_event_router::RuntimeEventRouter,
    turn_coordinator::{TurnAdmissionRequest, TurnCoordinator},
};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Context {
    pub farfold_session_id: FarfoldSessionId,
    pub host_turn_id: HostTurnId,
    pub working_copy_id: WorkingCopyId,
    pub thread: threads::ThreadRef,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum Item {
    #[serde(rename = "agentMessage")]
    AgentMessage { id: String, text: String },
    #[serde(rename = "reasoning")]
    Reasoning {
        id: String,
        summary: Vec<String>,
        content: Vec<String>,
    },
    #[serde(rename = "commandExecution")]
    CommandExecution { id: String, status: String },
    #[serde(rename = "fileChange")]
    FileChange { id: String, status: String },
}
pub(super) fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 256
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
}
fn terminal(s: &str) -> bool {
    matches!(s, "completed" | "failed" | "interrupted")
}
impl Item {
    fn validate(&self) -> Result<(), String> {
        let (id, valid) = match self {
            Self::AgentMessage { id, text } => (id, text.len() <= 65536),
            Self::Reasoning {
                id,
                summary,
                content,
            } => (
                id,
                summary.len() <= 64
                    && content.len() <= 64
                    && summary.iter().chain(content).all(|t| t.len() <= 65536),
            ),
            Self::CommandExecution { id, status } | Self::FileChange { id, status } => (
                id,
                matches!(
                    status.as_str(),
                    "inProgress" | "completed" | "failed" | "declined"
                ),
            ),
        };
        if !identifier(id) || !valid {
            return Err("Invalid safe native item projection".into());
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Payload {
    InteractionOpen {
        request: Value,
        native_mode: String,
        file_changes: Option<Vec<super::interactions::FileChange>>,
    },
    InteractionEnd {
        native_request_id: Value,
        item_id: String,
        resolution: String,
    },
    Started,
    Terminal {
        status: String,
    },
    ItemStarted {
        item: Item,
    },
    ItemCompleted {
        item: Item,
    },
    Delta {
        item_id: String,
        channel: String,
        delta: String,
        index: Option<u32>,
    },
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub context: Context,
    pub native_turn_id: String,
    #[serde(flatten)]
    pub payload: Payload,
}
impl Event {
    fn validate(&self) -> Result<(), String> {
        if !threads::native_id(&self.native_turn_id) {
            return Err("Invalid native Turn identity".into());
        }
        match &self.payload {
            Payload::InteractionOpen {
                request,
                native_mode,
                file_changes,
            } => {
                super::interactions::validate_request(
                    request,
                    native_mode,
                    &self.context,
                    &self.native_turn_id,
                )?;
                super::interactions::validate_changes(file_changes.as_deref(), request)
            }
            Payload::InteractionEnd {
                native_request_id,
                item_id,
                resolution,
            } => {
                if super::interactions::request_id(native_request_id)
                    && identifier(item_id)
                    && matches!(
                        resolution.as_str(),
                        "native_resolved"
                            | "terminal"
                            | "expired"
                            | "stop_requested"
                            | "mode_changed"
                    )
                {
                    Ok(())
                } else {
                    Err("Invalid interaction withdrawal".into())
                }
            }
            Payload::Terminal { status } if !terminal(status) => {
                Err("Unconfirmed Turn terminal".into())
            }
            Payload::ItemStarted { item } | Payload::ItemCompleted { item } => item.validate(),
            Payload::Delta {
                item_id,
                channel,
                delta,
                index,
            } => {
                let valid_index = if channel == "item/agentMessage/delta" {
                    index.is_none()
                } else {
                    matches!(
                        channel.as_str(),
                        "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta"
                    ) && index.is_some_and(|i| i < 64)
                };
                if !identifier(item_id) || delta.len() > 65536 || !valid_index {
                    Err("Invalid native text projection".into())
                } else {
                    Ok(())
                }
            }
            _ => Ok(()),
        }
    }
}
pub(super) struct Active {
    pub(super) context: Context,
    pub(super) native_id: Option<String>,
    operation: u64,
    coordinator: TurnCoordinator,
    pub(super) interrupt_requested: bool,
    scope: Scope,
    pub(super) steering: Option<String>,
    pub(super) steer_ids: std::collections::BTreeSet<String>,
}
#[derive(Default)]
pub(super) struct Control {
    pub(super) active: Option<Active>,
    pub(super) unknown: bool,
    pub(super) router: Option<RuntimeEventRouter>,
    pub(super) event_pump_stop: Option<Arc<std::sync::atomic::AtomicBool>>,
}
impl Control {
    pub(super) fn validate_event(&self, value: &Value) -> Result<Event, String> {
        let event: Event =
            serde_json::from_value(value.clone()).map_err(|_| "Invalid typed Turn event")?;
        event.validate()?;
        if serde_json::to_value(&event).map_err(|_| "Turn projection unavailable")? != *value {
            return Err("Unknown fields in public Turn channel".into());
        }
        let active = self.active.as_ref().ok_or("No Host Turn reservation")?;
        if event.context != active.context
            || active.native_id.as_ref() != Some(&event.native_turn_id)
        {
            return Err("Native Turn event differs from Host reservation".into());
        }
        Ok(event)
    }
    pub(super) fn mark_unknown(&mut self) -> Result<(), String> {
        self.unknown = true;
        if let Some(active) = &self.active {
            active
                .coordinator
                .mark_submission_unknown(&active.context.host_turn_id)?;
            if let Some(router) = &self.router {
                router.route(active.scope.binding()?, json!({"generation":active.scope.generation,"kind":"transport_error","payload":{"state":"unknown"}}))?;
            }
        }
        Ok(())
    }
}

pub(super) fn target(
    store: &HostStore,
    connection: &Connection,
    scope: &Scope,
    id: &FarfoldSessionId,
) -> Result<SessionOpenTarget, String> {
    scope.validate()?;
    let t = store.session_open_target(id)?;
    crate::session_controller::require_session_target(t.project_blockers())?;
    let thread = connection
        .threads
        .bound
        .as_ref()
        .ok_or("Original thread is not bound")?;
    thread.validate(&connection.workspace, &connection.profile_home)?;
    if &connection.scope != scope
        || connection.threads.unknown
        || t.archived_at.is_some()
        || t.runtime_product_id.as_str() != scope.runtime_product_id
        || t.installation_id.as_str() != scope.installation_id
        || t.runtime_build_id.as_str() != scope.runtime_build_id
        || t.adapter_id.as_str() != scope.adapter_id
        || t.connection_id.as_str() != scope.connection_id
        || t.native_session_id.as_str() != thread.native_thread_id
        || t.locator_kind != Some(NativeSessionLocatorKind::CodexTreeSessionId)
        || t.locator_value.as_deref() != Some(&thread.native_session_id)
        || t.working_copy_path != connection.workspace.cwd
        || connection.workspace.working_copy_id.as_ref() != Some(&t.working_copy_id)
    {
        return Err("Turn does not target the exact registered native Session".into());
    }
    let launch = store.current_owned_profile_launch(
        &t.binding(),
        &RuntimeProfileId::parse(&scope.profile_id).map_err(|e| e.to_string())?,
        scope.generation,
    )?;
    if launch.home != connection.profile_home
        || launch.cwd != t.working_copy_path
        || launch.working_copy_id != t.working_copy_id
    {
        return Err("Turn profile/Working Copy launch differs".into());
    }
    Ok(t)
}

impl configure::Runtime {
    pub fn turn_context(&self, scope: &Scope) -> Result<(Context, String), String> {
        let handle = self.connection()?;
        let c = handle.lock().map_err(|_| "Connection unavailable")?;
        if &c.scope != scope {
            return Err("Stale Turn generation".into());
        }
        let active = c.turns.active.as_ref().ok_or("No active Turn")?;
        Ok((
            active.context.clone(),
            active.native_id.clone().ok_or("Native Turn unconfirmed")?,
        ))
    }

    pub fn read_turn_history(
        &self,
        store: &HostStore,
        scope: &Scope,
        id: &FarfoldSessionId,
    ) -> Result<Vec<HistoryTurn>, String> {
        let (handle, pending, operation) = self.controller.exclusive(|| {
            let handle = self.connection()?;
            let mut c = handle.lock().map_err(|_| "Connection unavailable")?;
            target(store, &c, scope, id)?;
            if c.turns.unknown || c.turns.active.is_some() {
                return Err("Turn history unavailable while unsettled".into());
            }
            let unresolved = c.transport.has_unresolved_work()?;
            let operation = c.control.operations.begin_connection_config(unresolved)?;
            let pending = c
                .transport
                .begin_request_unbounded(
                    "_codex/turn/history",
                    json!({"scope":scope,"thread":c.threads.bound}),
                )
                .map_err(|_| "History dispatch unavailable")?;
            drop(c);
            Ok((handle, pending, operation))
        })?;
        let reply = pending.wait_timeout(Duration::from_secs(15));
        self.controller.exclusive(|| {
            if !Arc::ptr_eq(&self.connection()?, &handle) {
                return Err("Retired history read".into());
            }
            let mut c = handle.lock().map_err(|_| "Connection unavailable")?;
            let result = (|| {
                target(store, &c, scope, id)?;
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Receipt {
                    scope: Scope,
                    history: Vec<HistoryTurn>,
                }
                let r: Receipt = serde_json::from_value(reply.map_err(|_| "History unavailable")?)
                    .map_err(|_| "Invalid history receipt")?;
                if &r.scope != scope || r.history.len() > 64 {
                    return Err("History scope/size differs".into());
                }
                let mut ids = std::collections::BTreeSet::new();
                for t in &r.history {
                    if !threads::native_id(&t.native_turn_id)
                        || !terminal(&t.status)
                        || t.items.len() > 256
                        || !ids.insert(&t.native_turn_id)
                    {
                        return Err("Unconfirmed history Turn".into());
                    }
                    for item in &t.items {
                        item.validate()?;
                    }
                }
                Ok(r.history)
            })();
            if result.is_ok() {
                c.control.operations.complete(operation)?;
            } else {
                c.turns.mark_unknown()?;
            }
            result
        })
    }
    pub fn start_turn(
        &self,
        store: &HostStore,
        scope: &Scope,
        id: &FarfoldSessionId,
        coordinator: &TurnCoordinator,
        router: &RuntimeEventRouter,
        text: &str,
    ) -> Result<HostTurnId, String> {
        self.start_turn_receipt(store, scope, id, coordinator, router, text)
            .map(|(context, _)| context.host_turn_id)
    }

    pub(super) fn start_turn_receipt(
        &self,
        store: &HostStore,
        scope: &Scope,
        id: &FarfoldSessionId,
        coordinator: &TurnCoordinator,
        router: &RuntimeEventRouter,
        text: &str,
    ) -> Result<(Context, String), String> {
        if text.trim().is_empty() || text.len() > 65536 {
            return Err("Turn text empty or too large".into());
        }
        let model_observation = self.prepare_model(store, scope, id)?;
        let observed_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "Clock unavailable")?
            .as_millis() as u64;
        let (handle, pending, host_id) = self.controller.exclusive(|| {
            let handle = self.connection()?;
            let mut c = handle.lock().map_err(|_| "Connection unavailable")?;
            let t = target(store, &c, scope, id)?;
            if c.admission.as_ref()!=Some(&model_observation) { return Err("Model observation retired before admission".into()); }
            if let Some(stop) = &c.turns.event_pump_stop
                && (stop.load(std::sync::atomic::Ordering::Acquire)
                    || c.turns.router.as_ref().is_none_or(|r| !r.shares_stream_with(router)))
            {
                return Err("Original Host event consumer unavailable".into());
            }
            if c.turns.unknown
                || c.turns.active.is_some()
                || c.control.operations.is_pending()
                || c.transport.has_unresolved_work()?
            {
                return Err("Unsettled Codex operation blocks Turn admission".into());
            }
            let host = coordinator
                .admit(TurnAdmissionRequest {
                    farfold_session_id: id.clone(),
                    working_copy_id: t.working_copy_id.clone(),
                    runtime_product_id: t.runtime_product_id.clone(),
                    installation_id: t.installation_id.clone(),
                    runtime_connection_id: t.connection_id.clone(),
                    native_session_id: t.native_session_id.clone(),
                    runtime_generation: scope.generation,
                    started_at: SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map_err(|_| "Clock unavailable")?
                        .as_millis() as u64,
                    provider_connection_id: None,
                    provider_config_version_id: None,
                    runtime_provider_id: None,
                    runtime_model_id: None,
                    provider_binding_authority:
                        TurnProviderBindingAuthority::ActiveRuntimeSessionBinding,
                })
                .map_err(|e| e.to_string())?;
            let host_id = host.id().clone();
            let actual=model_observation.actual.as_ref().ok_or("Actual model missing")?;
            if let Err(e)=store.bind_native_turn_model_observation(&crate::host_store::provider_projection::NativeTurnModelObservationInput {
                host_turn_id:host_id.clone(), farfold_session_id:id.clone(), native_session_id:t.native_session_id.clone(),
                runtime:t.binding(),runtime_generation:scope.generation,runtime_provider_id:actual.provider.clone(),
                runtime_model_id:actual.catalog_model_id.clone(),native_model_id:actual.native_model.clone(),observed_at,
            }) { coordinator.cancel_submission(&host_id)?; return Err(e); }
            let operation = match c.control.operations.begin(
                AcpSessionOperationKind::Turn,
                Some(t.native_session_id.to_string()),
                Some(t.native_session_id.as_str()),
                false,
            ) {
                Ok(op) => op,
                Err(e) => {
                    coordinator.cancel_submission(&host_id)?;
                    return Err(e);
                }
            };
            let context = Context {
                farfold_session_id: id.clone(),
                host_turn_id: host_id.clone(),
                working_copy_id: t.working_copy_id,
                thread: c.threads.bound.clone().ok_or("Thread unavailable")?,
            };
            let command = json!({"action":"start","context":context,"text":text,"admission":model_observation});
            c.turns.router = Some(router.clone());
            c.turns.active = Some(Active {
                context,
                native_id: None,
                operation,
                coordinator: coordinator.clone(),
                interrupt_requested: false,
                scope: scope.clone(),
                steering: None,
                steer_ids: std::collections::BTreeSet::new(),
            });
            let pending = c
                .transport
                .begin_request_unbounded("_codex/turn", json!({"scope":scope,"command":command}));
            match pending {
                Ok(p) => {
                    drop(c);
                    Ok((handle, p, host_id))
                }
                Err(crate::acp_transport::AcpDispatchError::NotSent(_)) => {
                    c.control.operations.complete(operation)?;
                    c.turns.active = None;
                    coordinator.cancel_submission(&host_id)?;
                    Err("Turn not sent".into())
                }
                Err(_) => {
                    c.turns.mark_unknown()?;
                    Err("Turn dispatch unconfirmed".into())
                }
            }
        })?;
        let reply = pending.wait_timeout(Duration::from_secs(15));
        self.controller.exclusive(|| {
            let current = self.connection()?;
            if !Arc::ptr_eq(&current, &handle) {
                coordinator.mark_submission_unknown(&host_id)?;
                return Err("Retired Turn connection".into());
            }
            let mut c = handle.lock().map_err(|_| "Connection unavailable")?;
            if &c.scope != scope {
                coordinator.mark_submission_unknown(&host_id)?;
                return Err("Retired Turn generation".into());
            }
            if matches!(
                &reply,
                Err(crate::acp_transport::AcpDispatchError::Rejected { code: -32601, .. })
            ) {
                let active = c.turns.active.take().ok_or("Turn reservation missing")?;
                c.control.operations.complete(active.operation)?;
                coordinator.cancel_submission(&host_id)?;
                return Err("Production Turn entry is disabled".into());
            }
            let validated = (|| {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Receipt {
                    scope: Scope,
                    native_turn_id: String,
                    status: String,
                }
                let r: Receipt = serde_json::from_value(reply.map_err(|_| "Turn result unknown")?)
                    .map_err(|_| "Invalid Turn receipt")?;
                if &r.scope != scope
                    || !threads::native_id(&r.native_turn_id)
                    || r.status != "inProgress"
                {
                    return Err("Turn receipt identity/state mismatch");
                }
                target(store, &c, scope, id).map_err(|_| "Registered Turn target changed")?;
                Ok(r.native_turn_id)
            })();
            match validated {
                Ok(native) => {
                    c.turns
                        .active
                        .as_mut()
                        .ok_or("Reservation missing")?
                        .native_id = Some(native.clone());
                    coordinator.observe_codex_turn(&host_id, scope.generation)?;
                    Ok((
                        c.turns
                            .active
                            .as_ref()
                            .ok_or("Reservation missing")?
                            .context
                            .clone(),
                        native,
                    ))
                }
                Err(e) => {
                    c.turns.mark_unknown()?;
                    Err(e.into())
                }
            }
        })
    }

    pub fn interrupt_turn(
        &self,
        store: &HostStore,
        scope: &Scope,
        context: &Context,
        native_turn_id: &str,
    ) -> Result<(), String> {
        let (handle, pending) = self.controller.exclusive(|| {
            let handle = self.connection()?;
            let mut c = handle.lock().map_err(|_| "Connection unavailable")?;
            target(store, &c, scope, &context.farfold_session_id)?;
            let active = c.turns.active.as_ref().ok_or("No active Turn")?;
            if &active.context != context || active.native_id.as_deref() != Some(native_turn_id) || active.interrupt_requested {
                return Err("Interrupt identity differs from active Turn".into());
            }
            active.coordinator.request_abort(&context.farfold_session_id)?;
            c.turns.active.as_mut().ok_or("Missing Turn")?.interrupt_requested = true;
            let pending = match c.transport.begin_request_unbounded("_codex/turn", json!({"scope":scope,"command":{"action":"interrupt","context":context,"nativeTurnId":native_turn_id}})) {
                Ok(p) => p,
                Err(_) => { c.turns.mark_unknown()?; return Err("Interrupt dispatch unconfirmed".into()); }
            };
            drop(c); Ok((handle, pending))
        })?;
        let reply = pending.wait_timeout(Duration::from_secs(15));
        self.controller.exclusive(|| {
            let current = self.connection()?;
            if !Arc::ptr_eq(&current, &handle) {
                return Err("Retired interrupt connection".into());
            }
            let mut c = handle.lock().map_err(|_| "Connection unavailable")?;
            let expected = json!({"scope":scope,"nativeTurnId":native_turn_id,"accepted":true});
            if &c.scope != scope
                || c.turns.active.as_ref().is_none_or(|a| {
                    &a.context != context || a.native_id.as_deref() != Some(native_turn_id)
                })
            {
                return Err("Retired interrupt operation; later Turn unchanged".into());
            }
            if reply.ok().as_ref() != Some(&expected) {
                c.turns.mark_unknown()?;
                return Err("Interrupt outcome unknown; native terminal still required".into());
            }
            Ok(()) // Keep coordinator and shared operation occupancy until native terminal.
        })
    }

    pub fn poll_turn_events(&self, scope: &Scope) -> Result<Vec<Event>, String> {
        self.controller.exclusive(|| {
            let handle = self.connection()?;
            let mut c = handle.lock().map_err(|_| "Connection unavailable")?;
            if &c.scope != scope {
                return Err("Stale event generation".into());
            }
            if c.turns.event_pump_stop.is_some() {
                return Err("Host pump owns Codex event consumption".into());
            }
            c.consume_turn_events()
        })
    }
}

impl Connection {
    fn consume_turn_events(&mut self) -> Result<Vec<Event>, String> {
        let c = self;
        let scope = c.scope.clone();
        let events = match c.drain_validated_events() {
            Ok(events) => events,
            Err(e) => {
                c.turns.mark_unknown()?;
                return Err(e);
            }
        };
        let mut output = Vec::new();
        for raw in events {
            let event = if raw["method"] == "_codex/thread/event" {
                None
            } else {
                Some(c.turns.validate_event(&raw["params"]["turn"])?)
            };
            let binding = crate::runtime_registry::RuntimeBinding {
                product_id: crate::host_ids::RuntimeProductId::parse(&scope.runtime_product_id)
                    .map_err(|e| e.to_string())?,
                installation_id: crate::host_ids::InstallationId::parse(&scope.installation_id)
                    .map_err(|e| e.to_string())?,
                runtime_build_id: crate::host_ids::RuntimeBuildId::parse(&scope.runtime_build_id)
                    .map_err(|e| e.to_string())?,
                adapter_id: crate::host_ids::AdapterId::parse(&scope.adapter_id)
                    .map_err(|e| e.to_string())?,
                connection_id: crate::host_ids::ConnectionId::parse(&scope.connection_id)
                    .map_err(|e| e.to_string())?,
            };
            let routed = c
                .turns
                .router
                .as_ref()
                .ok_or("Turn event router not attached")?
                .route_acp(binding, scope.generation, &c.transport, raw);
            if let Err(e) = routed {
                c.turns.mark_unknown()?;
                return Err(e);
            }
            let Some(event) = event else {
                continue;
            };
            let active = c.turns.active.as_ref().ok_or("Missing Host Turn")?;
            if let Payload::Terminal { status } = &event.payload {
                active.coordinator.settle_codex_turn(
                    &active.context.host_turn_id,
                    scope.generation,
                    status,
                )?;
                let op = active.operation;
                c.control.operations.complete(op)?;
                c.turns.active = None;
                c.turns.unknown = false;
            }
            output.push(event);
        }
        Ok(output)
    }
}

mod facade;
pub use facade::{CommandInput as TurnCommandInput, Snapshot as TurnSnapshot};
mod history;
pub use history::Snapshot as HistorySnapshot;

#[cfg(test)]
pub(super) mod tests;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryTurn {
    pub native_turn_id: String,
    pub status: String,
    pub items: Vec<Item>,
}
