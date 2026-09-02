use tauri::{State, ipc::Channel};

use crate::runtime_event_router::{
    RuntimeEventDelivery, RuntimeEventRouter, RuntimeEventSubscription,
};

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
