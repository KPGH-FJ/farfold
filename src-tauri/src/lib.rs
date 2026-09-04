mod capability_authority;
pub mod host_ids;
pub mod host_store;
mod interaction_registry;
mod lifemodel;
mod live_session_projection;
mod managed_update;
mod opencode_bindings;
mod opencode_protocol;
mod opencode_runtime;
mod pi_capabilities;
mod pi_runtime;
mod runtime_event_router;
mod runtime_host;
mod runtime_registry;
mod runtime_supervisor;
mod session_controller;
mod session_reconciler;
mod transport_security;
mod turn_coordinator;
mod ui_transport;
mod update_candidate;

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
    transport_security::ensure_rustls_crypto_provider();
    let live_projection = live_session_projection::LiveSessionProjection::default();
    let interaction_registry = interaction_registry::InteractionRegistry::default();
    let turn_coordinator = turn_coordinator::TurnCoordinator::default();
    let event_router = if option_env!("FARFOLD_P3_QA") == Some("1") {
        runtime_event_router::RuntimeEventRouter::with_capacity_and_all_observers(
            P3_QA_EVENT_CAPACITY,
            Some(live_projection.clone()),
            Some(interaction_registry.clone()),
            Some(turn_coordinator.clone()),
        )
    } else {
        runtime_event_router::RuntimeEventRouter::with_all_observers(
            live_projection.clone(),
            interaction_registry.clone(),
            turn_coordinator.clone(),
        )
    };
    let interaction_registry_for_setup = interaction_registry.clone();
    let turn_coordinator_for_setup = turn_coordinator.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _cwd| {
                activate_existing_instance(app);
            },
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PiCapabilities::default())
        .manage(live_projection)
        .manage(managed_update::ManagedUpdateAuthority::default())
        .manage(interaction_registry)
        .manage(event_router)
        .manage(OpenCodeRuntime::default())
        .manage(PiRuntime::default())
        .manage(runtime_supervisor::RuntimeSupervisor::default())
        .manage(session_controller::HostSessionController::default())
        .manage(turn_coordinator)
        .setup(move |app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            let database_path = app_data_dir.join("farfold-host.sqlite3");
            let storage_activation =
                host_store::portable_import_activation::process_pending_storage_activation(
                    &database_path,
                )
                .map_err(std::io::Error::other)?;
            if !app.manage(storage_activation) {
                return Err(std::io::Error::other(
                    "Host storage activation state is already initialized",
                )
                .into());
            }
            let host_store = host_store::HostStore::open(database_path);
            host_store::working_copy_manager::reconcile_managed_worktrees_on_startup(
                &host_store,
                &app_data_dir,
            )
            .map_err(std::io::Error::other)?;
            host_store::managed_worktree_removal::reconcile_managed_worktree_removals_on_startup(
                &host_store,
            )
            .map_err(std::io::Error::other)?;
            host_store::turn_changes::reconcile_interrupted_captures(&host_store)
                .map_err(std::io::Error::other)?;
            if host_store.is_ready().map_err(std::io::Error::other)?
                && let Err(reason) = lifemodel::migrate_legacy_store(&app_data_dir, &host_store)
            {
                host_store
                    .enter_recovery(format!("Legacy LifeModel migration failed: {reason}"))
                    .map_err(std::io::Error::other)?;
            }
            if host_store.is_ready().map_err(std::io::Error::other)? {
                lifemodel::reconcile_interrupted_injections(&host_store)
                    .map_err(std::io::Error::other)?;
            }
            interaction_registry_for_setup
                .attach_host_store(host_store.clone())
                .map_err(std::io::Error::other)?;
            turn_coordinator_for_setup
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
            host_store::portable_export::host_portable_export_create,
            host_store::portable_export::host_portable_export_preview,
            host_store::portable_export::host_portable_import_preview,
            host_store::portable_export::host_portable_import_stage,
            host_store::portable_import_activation::host_portable_import_activation_request,
            host_store::portable_import_activation::host_storage_activation_status,
            host_store::portable_import_activation::host_recovery_restore_request,
            host_store::portable_import_activation::host_recovery_reset_request,
            host_store::project_relocation::project_relocation_preview,
            host_store::project_relocation::project_relocation_activate,
            host_store::session_attention::session_attention_snapshot,
            host_store::session_binding_index::app_restore_state,
            host_store::session_binding_index::host_navigation_snapshot,
            host_store::session_binding_index::session_binding_index_snapshot,
            host_store::session_binding_index::session_draft_get,
            host_store::session_binding_index::session_draft_set,
            host_store::session_binding_index::session_draft_clear,
            host_store::session_deletion::session_deletion_preview,
            host_store::session_deletion::session_metadata_delete,
            host_store::session_open::host_session_open_preview,
            host_store::turn_changes::turn_change_review_snapshot,
            host_store::turn_changes::turn_change_review_mark,
            host_store::working_copy_manager::working_copy_snapshot,
            host_store::working_copy_manager::working_copy_registration_preview,
            host_store::working_copy_manager::managed_worktree_creation_preview,
            host_store::working_copy_manager::managed_worktree_create,
            host_store::managed_worktree_removal::managed_worktree_removal_preview,
            host_store::managed_worktree_removal::managed_worktree_remove,
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
            lifemodel::lifemodel_preview_last_source_resolution,
            lifemodel::lifemodel_resolve_last_source,
            lifemodel::lifemodel_set_enabled,
            lifemodel::lifemodel_prepare_injection,
            managed_update::managed_update_snapshot,
            managed_update::managed_update_check,
            managed_update::managed_update_download,
            runtime_host::runtime_discover,
            runtime_host::opencode_runtime_discover,
            runtime_supervisor::opencode_runtime_status,
            opencode_runtime::opencode_runtime_readiness,
            runtime_supervisor::runtime_supervisor_snapshot,
            runtime_supervisor::runtime_supervisor_reset,
            runtime_event_router::runtime_event_snapshot,
            live_session_projection::live_projection_snapshot,
            interaction_registry::interaction_registry_snapshot,
            session_reconciler::reconcile_pi_session,
            session_reconciler::reconcile_opencode_session,
            session_controller::host_session_open,
            session_controller::host_pi_session_create,
            session_controller::host_pi_active_session_sync,
            session_controller::host_opencode_session_create,
            session_controller::host_session_metadata_update,
            session_controller::host_managed_runtime_stop,
            turn_coordinator::turn_coordinator_snapshot,
            turn_coordinator::host_pi_turn_submit,
            turn_coordinator::host_pi_turn_abort,
            ui_transport::host_initial_snapshot,
            ui_transport::runtime_event_subscribe,
            ui_transport::runtime_event_unsubscribe,
            opencode_runtime::opencode_runtime_diagnostics,
            opencode_protocol::opencode_provider_snapshot,
            opencode_protocol::opencode_session_list,
            opencode_protocol::opencode_session_messages,
            turn_coordinator::host_opencode_turn_submit,
            turn_coordinator::host_opencode_turn_abort,
            opencode_protocol::opencode_permission_respond,
            runtime_host::runtime_send,
            runtime_host::runtime_status,
            runtime_host::runtime_project_readiness,
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
    use serde_json::Value;

    #[test]
    fn child_runtimes_stop_on_the_final_run_event() {
        assert!(should_stop_child_runtimes(&tauri::RunEvent::Exit));
        assert!(!should_stop_child_runtimes(&tauri::RunEvent::Ready));
    }

    #[test]
    fn default_build_supplies_a_non_null_updater_plugin_config() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json should remain valid JSON");
        let updater = config.pointer("/plugins/updater").expect(
            "the updater plugin needs an object even when release infrastructure is absent",
        );
        assert!(updater.is_object());
        assert_eq!(updater.pointer("/endpoints"), Some(&Value::Array(vec![])));
        assert_eq!(
            updater.pointer("/pubkey"),
            Some(&Value::String(String::new()))
        );
        assert_eq!(updater.pointer("/dangerousInsecureTransportProtocol"), None);
        assert_eq!(updater.pointer("/dangerousAcceptInvalidCerts"), None);
        assert_eq!(updater.pointer("/dangerousAcceptInvalidHostnames"), None);
    }
}
