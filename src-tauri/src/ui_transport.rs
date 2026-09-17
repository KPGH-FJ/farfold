use serde::Serialize;
use tauri::{AppHandle, Manager, State, ipc::Channel};

use crate::{
    host_store::{HostStorageStatus, HostStore, session_binding_index::HostNavigationSnapshot},
    interaction_registry::{InteractionRegistry, InteractionSnapshot},
    live_session_projection::{LiveSessionProjection, RuntimeProjectionSnapshot},
    pi_runtime::PiRuntime,
    runtime_event_router::{
        RuntimeEventCursor, RuntimeEventDelivery, RuntimeEventRouter, RuntimeEventSubscription,
    },
    runtime_supervisor::{RuntimeSupervisor, RuntimeSupervisorSnapshot},
};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostInitialSnapshot {
    event_cursor: RuntimeEventCursor,
    storage: HostStorageStatus,
    navigation: HostNavigationSnapshot,
    runtimes: Vec<RuntimeSupervisorSnapshot>,
    live_projections: Vec<RuntimeProjectionSnapshot>,
    pending_interactions: Vec<InteractionSnapshot>,
}

#[tauri::command]
pub fn host_initial_snapshot(app: AppHandle) -> Result<HostInitialSnapshot, String> {
    let router = app.state::<RuntimeEventRouter>();
    let storage = app.state::<HostStore>();
    let supervisor = app.state::<RuntimeSupervisor>();
    let pi = app.state::<PiRuntime>();
    let codex = app.state::<crate::codex_runtime::CodexRuntime>();
    let projection = app.state::<LiveSessionProjection>();
    let interactions = app.state::<InteractionRegistry>();
    let event_cursor = router.cursor()?;
    let navigation = storage.navigation_snapshot()?;
    let runtimes = supervisor.snapshots(&pi, &codex, &storage)?;
    let storage = storage.status()?;
    let live_projections = projection.snapshots()?;
    let pending_interactions = interactions.snapshots()?;
    Ok(HostInitialSnapshot {
        event_cursor,
        storage,
        navigation,
        runtimes,
        live_projections,
        pending_interactions,
    })
}

#[tauri::command]
pub fn runtime_event_subscribe(
    router: State<'_, RuntimeEventRouter>,
    on_event: Channel<RuntimeEventDelivery>,
    after_sequence: Option<u64>,
    limit: Option<usize>,
) -> Result<RuntimeEventSubscription, String> {
    router.subscribe(on_event, after_sequence, limit)
}

#[tauri::command]
pub fn runtime_event_unsubscribe(
    router: State<'_, RuntimeEventRouter>,
    subscription_id: u32,
) -> Result<bool, String> {
    router.unsubscribe(subscription_id)
}
