mod acp_adapter;
mod acp_client_resources;
mod acp_provider_profile;
mod acp_runtime;
mod acp_session_operations;
mod acp_transport;
mod capability_authority;
pub mod codex_acp;
mod codex_installation;
mod codex_interactions;
mod codex_models;
mod codex_runtime;
mod codex_sessions;
mod codex_transport;
mod codex_turns;
pub mod host_ids;
pub mod host_store;
mod interaction_registry;
mod lifemodel;
mod host_runtime_adapter;
mod live_session_projection;
mod managed_provider;
mod managed_update;
mod opencode_acp;
mod opencode_question_acp_adapter;
mod performance_trace;
mod pi_acp;
#[cfg(test)]
mod pi_acp_contract_tests;
mod pi_acp_interactions;
mod pi_capabilities;
mod pi_runtime;
mod project_file_reference;
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
mod update_feed;
mod update_metadata;
mod update_recovery;

use pi_capabilities::PiCapabilities;
use pi_runtime::PiRuntime;
use tauri::{AppHandle, Manager};

pub const MANAGED_UPDATE_SMOKE_ARGUMENT: &str = "--farfold-managed-update-smoke-v1";
pub const OPENCODE_QUESTION_ACP_ADAPTER_ARGUMENT: &str =
    opencode_question_acp_adapter::OPENCODE_QUESTION_ACP_ADAPTER_ARGUMENT;

const P3_QA_EVENT_CAPACITY: usize = 8;

fn validate_profile_identity(
    identifier: &str,
    development_build: bool,
) -> Result<(), &'static str> {
    if development_build && identifier == "ai.farfold.desktop" {
        return Err(
            "A development build cannot open the Farfold daily-use profile. Use the default development configuration.",
        );
    }
    Ok(())
}

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
    app.state::<turn_coordinator::TurnCoordinator>()
        .abort_for_shutdown(&app.state::<PiRuntime>());
    let pi = app.state::<PiRuntime>();
    if let Ok(generation) = pi_runtime::running_generation(&pi)
        && let Err(error) = session_controller::sync_pi_session(app, generation)
    {
        eprintln!("[farfold] cannot persist Pi Session before exit: {error}");
    }
    if let Err(error) = app.state::<codex_runtime::CodexRuntime>().stop() {
        eprintln!("[farfold] cannot confirm Codex shutdown: {error}");
    }
    if let Err(error) = app.state::<pi_acp::PiAcpRuntime>().stop_for_shutdown() {
        eprintln!("[farfold] cannot confirm Pi ACP shutdown: {error}");
    }
    if let Err(error) = app
        .state::<opencode_acp::OpenCodeAcpRuntime>()
        .stop_for_shutdown()
    {
        eprintln!("[farfold] cannot confirm OpenCode ACP shutdown: {error}");
    }
    let capabilities = app.state::<PiCapabilities>();
    if let Err(error) = pi_capabilities::stop_process(&capabilities) {
        eprintln!("[farfold] cannot stop Pi capability bridge: {error}");
    }
    let runtime = app.state::<PiRuntime>();
    if let Err(error) = pi_runtime::stop_process(&runtime, None) {
        eprintln!("[farfold] cannot stop Pi Runtime: {error}");
    }
}

pub fn run_managed_update_smoke(database_path: std::path::PathBuf) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(&database_path)
        .map_err(|_| "Managed update smoke database is unavailable".to_string())?;
    if !metadata.file_type().is_file() {
        return Err("Managed update smoke database is not a regular file".to_string());
    }
    match host_store::HostDatabaseOpen::open(database_path) {
        host_store::HostDatabaseOpen::Ready(database) => drop(database),
        host_store::HostDatabaseOpen::Recovery(recovery) => {
            return Err(format!(
                "Managed update candidate rejected the Host snapshot: {}",
                recovery.reason()
            ));
        }
    }
    let executable = std::env::current_exe()
        .map_err(|_| "Cannot resolve managed update candidate executable".to_string())?;
    let resource_dir = executable
        .parent()
        .and_then(std::path::Path::parent)
        .map(|contents| contents.join("Resources"))
        .ok_or_else(|| "Cannot resolve managed update candidate resources".to_string())?;
    for definition in [
        runtime_registry::PI_RUNTIME,
        runtime_registry::OPENCODE_RUNTIME,
    ] {
        runtime_registry::verify_managed_installation_in_resource_dir(&resource_dir, definition)?;
    }
    Ok(())
}

pub fn run_opencode_question_acp_adapter() -> Result<(), String> {
    opencode_question_acp_adapter::run_opencode_question_acp_adapter()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    performance_trace::start();
    let context = tauri::generate_context!();
    validate_profile_identity(
        &context.config().identifier,
        tauri::is_dev() || cfg!(debug_assertions),
    )
    .expect("unsafe Farfold profile identity");
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
        .manage(runtime_registry::ManagedRuntimeInstallationOperations::default())
        .manage(interaction_registry)
        .manage(event_router)
        .manage(opencode_acp::OpenCodeAcpRuntime::default())
        .manage(pi_acp::PiAcpRuntime::default())
        .manage(codex_runtime::CodexRuntime::default())
        .manage(codex_acp::configure::Runtime::default())
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
            let current_executable = std::env::current_exe()
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            let update_startup = update_recovery::reconcile_managed_update_before_host_open(
                &app_data_dir,
                &current_executable,
            )
            .map_err(std::io::Error::other)?;
            if let update_recovery::UpdateStartupDisposition::ResumeRollback(intent) =
                &update_startup
            {
                update_recovery::rollback_candidate_startup(
                    &app_data_dir,
                    &current_executable,
                    &database_path,
                    intent.as_ref().clone(),
                )
                .map_err(std::io::Error::other)?;
                app.handle().restart();
            }
            let initialized = (|| -> Result<_, String> {
                let storage_activation =
                    host_store::portable_import_activation::process_pending_storage_activation(
                        &database_path,
                    )?;
                let host_store = host_store::HostStore::open(&database_path);
                host_store::working_copy_manager::reconcile_managed_worktrees_on_startup(
                    &host_store,
                    &app_data_dir,
                )?;
                host_store::managed_worktree_removal::reconcile_managed_worktree_removals_on_startup(
                    &host_store,
                )?;
                host_store::turn_changes::reconcile_interrupted_captures(&host_store)?;
                if host_store.is_ready()? {
                    lifemodel::reconcile_interrupted_injections(&host_store)?;
                }
                if let update_recovery::UpdateStartupDisposition::ValidateCandidate(intent) =
                    &update_startup
                {
                    if !host_store.is_ready()? {
                        return Err("Managed update candidate opened Host storage in recovery mode"
                            .to_string());
                    }
                    for definition in [
                        runtime_registry::PI_RUNTIME,
                        runtime_registry::OPENCODE_RUNTIME,
                    ] {
                        runtime_registry::verify_managed_installation(app.handle(), definition)?;
                    }
                    update_recovery::commit_candidate_startup(
                        &app_data_dir,
                        &current_executable,
                        intent.as_ref().clone(),
                    )?;
                }
                Ok((storage_activation, host_store))
            })();
            let (storage_activation, host_store) = match initialized {
                Ok(initialized) => initialized,
                Err(reason) => {
                    if let update_recovery::UpdateStartupDisposition::ValidateCandidate(intent) =
                        update_startup
                    {
                        update_recovery::rollback_candidate_startup(
                            &app_data_dir,
                            &current_executable,
                            &database_path,
                            *intent,
                        )
                        .map_err(|rollback| {
                            std::io::Error::other(format!(
                                "Managed update startup failed: {reason}; rollback failed: {rollback}"
                            ))
                        })?;
                        app.handle().restart();
                    }
                    return Err(std::io::Error::other(reason).into());
                }
            };
            if !app.manage(storage_activation) {
                return Err(std::io::Error::other(
                    "Host storage activation state is already initialized",
                )
                .into());
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
            host_store::portable_export::host_portable_export_create,
            host_store::portable_export::host_portable_export_preview,
            host_store::portable_export::host_portable_import_preview,
            host_store::portable_export::host_portable_import_stage,
            host_store::portable_import_activation::host_portable_import_activation_request,
            host_store::portable_import_activation::host_storage_activation_status,
            host_store::portable_import_activation::host_recovery_restore_request,
            host_store::portable_import_activation::host_recovery_reset_request,
            host_store::provider_projection::host_provider_connection_upsert,
            host_store::provider_projection::host_provider_projection_record,
            host_store::provider_projection::host_provider_projection_snapshot,
            managed_provider::managed_provider_api_key_save,
            managed_provider::managed_provider_correct_ordinary_zhipu_developer_role,
            managed_provider::managed_provider_apply_pi,
            managed_provider::managed_provider_connection_list,
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
            host_store::turn_changes::turn_change_file_preview,
            host_store::turn_changes::turn_change_path_diff_preview,
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
            managed_update::managed_update_prepare_activation,
            managed_update::managed_update_cancel_prepared_activation,
            managed_update::managed_update_activate,
            managed_update::managed_update_recovery_snapshot,
            managed_update::managed_update_request_rollback,
            managed_update::managed_update_discard_recovery,
            codex_runtime::codex_connection_start,
            codex_acp::workspace::host_codex_acp_workspace,
            codex_acp::sessions::host_codex_acp_session_context,
            codex_acp::operations::host_codex_acp_operation,
            codex_runtime::codex_connection_stop,
            codex_runtime::codex_connection_status,
            codex_runtime::codex_account_action,
            codex_runtime::codex_model_catalog,
            codex_runtime::host_codex_turn_submit,
            codex_runtime::host_codex_turn_interrupt,
            codex_runtime::host_codex_interaction_reply,
            codex_runtime::host_codex_turn_steer,
            opencode_acp::opencode_acp_status,
            pi_acp::pi_acp_status,
            pi_acp::pi_acp_workspace,
            pi_acp::pi_acp_respond_dialog,
            pi_acp::pi_acp_set_config_option,
            pi_acp::pi_acp_apply_provider,
            pi_acp::native_auth::pi_acp_native_auth,
            turn_coordinator::host_pi_acp_turn_submit,
            turn_coordinator::host_pi_acp_turn_abort,
            turn_coordinator::host_pi_acp_intervene,
            codex_installation::codex_installation_candidates,
            codex_installation::codex_installation_inspect,
            codex_installation::codex_installation_list,
            codex_installation::codex_installation_accept,
            codex_installation::codex_installation_recheck,
            runtime_host::runtime_discover,
            runtime_registry::managed_runtime_installation_candidates,
            runtime_registry::managed_runtime_installation_accept,
            runtime_registry::managed_runtime_installation_cancel,
            runtime_registry::managed_runtime_installation_inspect,
            runtime_registry::managed_runtime_installation_install,
            runtime_registry::managed_runtime_installation_list,
            runtime_registry::managed_runtime_installation_status,
            runtime_supervisor::runtime_supervisor_snapshot,
            runtime_supervisor::runtime_supervisor_reset,
            runtime_event_router::runtime_event_snapshot,
            live_session_projection::live_projection_snapshot,
            interaction_registry::interaction_registry_snapshot,
            session_reconciler::reconcile_pi_session,
            session_controller::host_session_open,
            project_file_reference::host_open_project_file,
            project_file_reference::host_project_file_references,
            project_file_reference::host_reveal_project_file,
            session_controller::host_session_create,
            session_controller::host_session_metadata_update,
            session_controller::host_session_focus,
            session_controller::host_managed_runtime_stop,
            turn_coordinator::turn_coordinator_snapshot,
            turn_coordinator::host_pi_turn_submit,
            turn_coordinator::host_pi_turn_abort,
            ui_transport::host_initial_snapshot,
            ui_transport::runtime_event_subscribe,
            ui_transport::runtime_event_unsubscribe,
            turn_coordinator::host_opencode_acp_turn_submit,
            turn_coordinator::host_opencode_acp_turn_abort,
            opencode_acp::opencode_acp_permission_respond,
            opencode_acp::opencode_acp_question_respond,
            opencode_acp::opencode_acp_set_config_option,
            runtime_host::runtime_send,
            runtime_host::runtime_history,
            performance_trace::host_performance_origin,
            performance_trace::host_performance_sample,
            runtime_host::runtime_status,
            runtime_host::runtime_project_readiness,
        ])
        .build(context)
        .expect("failed to build Farfold")
        .run(|app, event| {
            if should_stop_child_runtimes(&event) {
                stop_child_runtimes(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{should_stop_child_runtimes, validate_profile_identity};
    use serde_json::Value;

    #[test]
    fn development_override_cannot_open_daily_use_storage() {
        assert!(validate_profile_identity("ai.farfold.desktop", true).is_err());
        assert!(validate_profile_identity("ai.farfold.desktop.dev", true).is_ok());
        assert!(validate_profile_identity("ai.farfold.desktop.p3qa", true).is_ok());
        assert!(validate_profile_identity("ai.farfold.desktop", false).is_ok());
    }

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

    #[test]
    fn script_launchers_are_sealed_resources_not_macos_nested_code() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json should remain valid JSON");
        let bundle = config
            .pointer("/bundle")
            .expect("the macOS bundle configuration should exist");
        assert_eq!(bundle.pointer("/externalBin"), None);
        assert_eq!(
            bundle.pointer("/resources/..~1scripts~1pi-sidecar-wrapper.sh"),
            Some(&Value::String(
                "farfold-runtime/pi-sidecar-wrapper.sh".to_string()
            ))
        );
        assert_eq!(
            bundle.pointer("/resources/..~1scripts~1pi-capability-wrapper.sh"),
            Some(&Value::String(
                "farfold-runtime/pi-capability-wrapper.sh".to_string()
            ))
        );
    }
}
