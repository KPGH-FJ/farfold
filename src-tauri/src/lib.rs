mod capability_authority;
pub mod host_ids;
pub mod host_store;
mod interaction_registry;
mod lifemodel;
mod live_session_projection;
mod opencode_bindings;
mod opencode_protocol;
mod opencode_runtime;
mod pi_capabilities;
mod pi_runtime;
mod runtime_event_router;
mod runtime_host;
mod runtime_registry;
mod runtime_supervisor;
mod session_reconciler;
mod ui_transport;

use opencode_runtime::OpenCodeRuntime;
use pi_capabilities::PiCapabilities;
use pi_runtime::PiRuntime;
use tauri::{AppHandle, Manager};

const P3_QA_EVENT_CAPACITY: usize = 8;

fn activate_existing_instance(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn should_stop_child_runtimes(event: &tauri::RunEvent) -> bool {
    matches!(event, tauri::RunEvent::Exit)
}

fn stop_child_runtimes(app: &AppHandle) {
    let capabilities = app.state::<PiCapabilities>();
    if let Err(error) = pi_capabilities::stop_process(&capabilities) {
        eprintln!("[farfold] cannot stop Pi capability bridge: {error}");
    }
    let runtime = app.state::<PiRuntime>();
    if let Err(error) = pi_runtime::stop_process(&runtime, None) {
        eprintln!("[farfold] cannot stop Pi Runtime: {error}");
    }
    let runtime = app.state::<OpenCodeRuntime>();
    if let Err(error) = opencode_runtime::stop_process(&runtime) {
        eprintln!("[farfold] cannot stop OpenCode Runtime: {error}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let live_projection = live_session_projection::LiveSessionProjection::default();
    let interaction_registry = interaction_registry::InteractionRegistry::default();
    let event_router = if option_env!("FARFOLD_P3_QA") == Some("1") {
        runtime_event_router::RuntimeEventRouter::with_capacity_and_observers(
            P3_QA_EVENT_CAPACITY,
            Some(live_projection.clone()),
            Some(interaction_registry.clone()),
        )
    } else {
        runtime_event_router::RuntimeEventRouter::with_observers(
            live_projection.clone(),
            interaction_registry.clone(),
        )
    };
    let interaction_registry_for_setup = interaction_registry.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _cwd| {
                activate_existing_instance(app);
            },
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(lifemodel::LifeModelRepository::default())
        .manage(opencode_bindings::OpenCodeBindingRepository::default())
        .manage(PiCapabilities::default())
        .manage(live_projection)
        .manage(interaction_registry)
        .manage(event_router)
        .manage(OpenCodeRuntime::default())
        .manage(PiRuntime::default())
        .manage(runtime_supervisor::RuntimeSupervisor::default())
        .setup(move |app| {
            let database_path = app
                .path()
                .app_data_dir()
                .map_err(|error| std::io::Error::other(error.to_string()))?
                .join("farfold-host.sqlite3");
            let host_store = host_store::HostStore::open(database_path);
            interaction_registry_for_setup
                .attach_host_store(host_store.clone())
                .map_err(std::io::Error::other)?;
            if !app.manage(host_store) {
                return Err(std::io::Error::other("Host storage is already initialized").into());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            capability_authority::runtime_capability_snapshot,
            host_store::host_storage_status,
            host_store::host_legacy_migration_preview,
            host_store::session_attention::session_attention_snapshot,
            host_store::session_binding_index::app_restore_state,
            host_store::session_binding_index::session_binding_index_snapshot,
            host_store::session_binding_index::session_draft_get,
            host_store::session_binding_index::session_draft_set,
            host_store::session_binding_index::session_draft_clear,
            host_store::session_binding_index::session_metadata_update,
            host_store::session_deletion::session_deletion_preview,
            host_store::working_copy_manager::working_copy_snapshot,
            host_store::working_copy_manager::working_copy_registration_preview,
            pi_capabilities::pi_capabilities_start,
            pi_capabilities::pi_capabilities_send,
            pi_capabilities::pi_capabilities_poll,
            lifemodel::lifemodel_snapshot,
            lifemodel::lifemodel_create_proposal,
            lifemodel::lifemodel_update_proposal,
            lifemodel::lifemodel_approve_proposal,
            lifemodel::lifemodel_reject_proposal,
            lifemodel::lifemodel_delete_item,
            lifemodel::lifemodel_withdraw_source,
            lifemodel::lifemodel_set_enabled,
            lifemodel::lifemodel_prepare_injection,
            lifemodel::lifemodel_finish_injection,
            runtime_host::runtime_discover,
            runtime_host::opencode_runtime_discover,
            runtime_supervisor::opencode_runtime_start,
            runtime_supervisor::opencode_runtime_status,
            opencode_runtime::opencode_runtime_readiness,
            runtime_supervisor::opencode_runtime_stop,
            runtime_supervisor::runtime_supervisor_snapshot,
            runtime_supervisor::runtime_supervisor_reset,
            runtime_event_router::runtime_event_snapshot,
            live_session_projection::live_projection_snapshot,
            interaction_registry::interaction_registry_snapshot,
            session_reconciler::reconcile_pi_session,
            session_reconciler::reconcile_opencode_session,
            ui_transport::host_initial_snapshot,
            ui_transport::runtime_event_subscribe,
            ui_transport::runtime_event_unsubscribe,
            opencode_runtime::opencode_runtime_poll_events,
            opencode_runtime::opencode_runtime_diagnostics,
            opencode_protocol::opencode_provider_snapshot,
            opencode_protocol::opencode_session_create,
            opencode_protocol::opencode_session_list,
            opencode_protocol::opencode_session_messages,
            opencode_protocol::opencode_prompt_async,
            opencode_protocol::opencode_session_abort,
            opencode_protocol::opencode_permission_respond,
            opencode_bindings::opencode_binding_list,
            opencode_bindings::opencode_binding_remember,
            runtime_host::runtime_start,
            runtime_host::runtime_send,
            runtime_host::runtime_stop,
            runtime_host::runtime_status,
            runtime_host::runtime_list_sessions,
            runtime_host::runtime_project_readiness,
            runtime_host::runtime_remember_session,
            runtime_host::runtime_poll_events,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Farfold")
        .run(|app, event| {
            if should_stop_child_runtimes(&event) {
                stop_child_runtimes(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::should_stop_child_runtimes;

    #[test]
    fn child_runtimes_stop_on_the_final_run_event() {
        assert!(should_stop_child_runtimes(&tauri::RunEvent::Exit));
        assert!(!should_stop_child_runtimes(&tauri::RunEvent::Ready));
    }
}
