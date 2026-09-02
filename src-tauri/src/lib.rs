mod capability_authority;
pub mod host_ids;
pub mod host_store;
mod lifemodel;
mod opencode_bindings;
mod opencode_protocol;
mod opencode_runtime;
mod pi_capabilities;
mod pi_runtime;
mod runtime_event_router;
mod runtime_host;
mod runtime_registry;
mod runtime_supervisor;

use opencode_runtime::OpenCodeRuntime;
use pi_capabilities::PiCapabilities;
use pi_runtime::PiRuntime;
use tauri::{AppHandle, Manager};

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
        .manage(runtime_event_router::RuntimeEventRouter::default())
        .manage(OpenCodeRuntime::default())
        .manage(PiRuntime::default())
        .manage(runtime_supervisor::RuntimeSupervisor::default())
        .setup(|app| {
            let database_path = app
                .path()
                .app_data_dir()
                .map_err(|error| std::io::Error::other(error.to_string()))?
                .join("farfold-host.sqlite3");
            if !app.manage(host_store::HostStore::open(database_path)) {
                return Err(std::io::Error::other("Host storage is already initialized").into());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            capability_authority::runtime_capability_snapshot,
            host_store::host_storage_status,
            host_store::host_legacy_migration_preview,
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
