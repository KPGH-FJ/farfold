use serde::Serialize;
use tauri::{State, ipc::Channel};

use crate::{
    host_store::{HostStorageStatus, HostStore},
    opencode_runtime::OpenCodeRuntime,
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
    runtimes: Vec<RuntimeSupervisorSnapshot>,
}

#[tauri::command]
pub fn host_initial_snapshot(
    router: State<'_, RuntimeEventRouter>,
    storage: State<'_, HostStore>,
    supervisor: State<'_, RuntimeSupervisor>,
    pi: State<'_, PiRuntime>,
    opencode: State<'_, OpenCodeRuntime>,
) -> Result<HostInitialSnapshot, String> {
    let event_cursor = router.cursor()?;
    let storage = storage.status()?;
    let runtimes = supervisor.snapshots(&pi, &opencode)?;
    Ok(HostInitialSnapshot {
        event_cursor,
        storage,
        runtimes,
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
