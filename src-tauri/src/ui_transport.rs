//! Transport helpers between Rust state and the single React UI.
//!
//! `app_initial_snapshot` is the one-shot read the frontend issues at
//! startup to restore the agent roster and settings; everything else flows
//! through [`emit_event`] on the app's event channel.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::meta_store::{AgentRow, MetaStore};

/// Emit a named event to all windows. Failures are logged, never fatal —
/// the UI re-pulls snapshots on startup anyway.
pub fn emit_event<T: Serialize + Clone>(app: &AppHandle, name: &str, payload: T) {
    if let Err(error) = app.emit(name, &payload) {
        eprintln!("[farfold] failed to emit {name}: {error}");
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppInitialSnapshot {
    pub agents: Vec<AgentRow>,
    pub settings: serde_json::Map<String, serde_json::Value>,
}

#[tauri::command]
pub fn app_initial_snapshot(app: AppHandle) -> Result<AppInitialSnapshot, String> {
    let store = app.state::<MetaStore>();
    let agents = store.list_agents()?;
    let settings: serde_json::Map<String, serde_json::Value> =
        store.list_settings()?.into_iter().collect();
    Ok(AppInitialSnapshot { agents, settings })
}
