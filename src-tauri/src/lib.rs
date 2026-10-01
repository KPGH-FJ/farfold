mod acp_client;
mod agent_catalog;
mod agent_discovery;
mod agent_install;
mod api_endpoint;
mod api_test;
mod auth;
mod conversation_directory;
mod credentials;
mod dependency_install;
mod diagnostics;
mod draft_attachment;
mod draft_exit;
mod install_job;
mod installations;
mod lifemodel;
mod logging;
mod managed_update;
mod manual_auth;
pub mod meta_store;
mod node_runtime;
mod npm_release;
mod performance_trace;
mod program_launch;
#[cfg(test)]
mod program_launch_tests;
mod project_index;
mod pty;
pub mod shell_env;
mod supervisor;
mod transport_security;
mod ui_transport;
mod update_feed;
mod update_metadata;
mod uv_runtime;
mod work_policy;

use tauri::{AppHandle, Manager};

fn activate_existing_instance(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn should_stop_agents(event: &tauri::RunEvent) -> bool {
    matches!(event, tauri::RunEvent::Exit)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    performance_trace::start();
    let context = tauri::generate_context!();
    transport_security::ensure_rustls_crypto_provider();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _cwd| {
                activate_existing_instance(app);
            },
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(pty::PtyManager::default())
        .manage(draft_exit::DraftExit::default())
        .manage(diagnostics::DiagnosticsState::default())
        .manage(managed_update::ManagedUpdateAuthority::default())
        .setup(move |app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            std::fs::create_dir_all(&app_data_dir)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            logging::init(&logging::default_log_dir());
            logging::info(
                "app",
                format_args!("farfold {} started", env!("CARGO_PKG_VERSION")),
            );
            // Reap registered agent processes left behind by a crash or
            // force-quit before any connection work begins.
            supervisor::startup_cleanup(&app_data_dir);
            if !app.manage(acp_client::manager::AcpManager::new(
                logging::default_log_dir(),
                app_data_dir.clone(),
            )) {
                return Err(std::io::Error::other("acp manager is already initialized").into());
            }
            if !app.manage(meta_store::MetaStore::open(
                &meta_store::MetaStore::default_path(&app_data_dir),
            )?) {
                return Err(std::io::Error::other("meta store is already initialized").into());
            }
            lifemodel::ensure_defaults(app.state::<meta_store::MetaStore>().inner())?;
            if !app.manage(agent_catalog::AgentCatalog::new(app_data_dir.clone())) {
                return Err(std::io::Error::other("agent catalog is already initialized").into());
            }
            if !app.manage(node_runtime::NodeRuntimeState::new(app_data_dir)) {
                return Err(
                    std::io::Error::other("node runtime state is already initialized").into(),
                );
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            conversation_directory::app_default_working_directory,
            agent_catalog::catalog_list,
            agent_catalog::catalog_scan,
            agent_install::agent_register,
            agent_install::agent_add_custom,
            agent_install::agent_install,
            acp_client::preparation::agent_preparation,
            acp_client::preparation_actions::agent_preparation_action_run,
            dependency_install::agent_dependency_install,
            dependency_install::agent_dependency_cancel,
            install_job::agent_install_cancel,
            agent_install::agent_install_rollback,
            agent_install::agent_select_program,
            agent_install::agent_remove,
            installations::agent_installations,
            installations::agent_installation_select,
            installations::agent_installation_uninstall,
            acp_client::manager::agent_connect,
            acp_client::manager::agent_disconnect,
            acp_client::manager::agent_status,
            acp_client::session_commands::session_open,
            acp_client::session_commands::session_prompt,
            acp_client::session_commands::session_cancel,
            acp_client::session_commands::session_set_config,
            acp_client::session_commands::session_confirm_config,
            acp_client::session_commands::session_set_mode,
            acp_client::session_commands::session_permission_respond,
            acp_client::session_commands::session_elicitation_respond,
            acp_client::session_commands::session_list,
            acp_client::session_discovery::session_discover,
            acp_client::session_discovery::session_import_preview,
            acp_client::session_discovery::session_import_commit,
            acp_client::session_discovery::session_import_close,
            acp_client::session_commands::session_close,
            acp_client::session_commands::session_touch,
            acp_client::session_commands::session_meta_rename,
            acp_client::session_commands::session_meta_pin,
            acp_client::session_commands::session_meta_archive,
            acp_client::session_commands::session_delete,
            acp_client::session_commands::session_dismiss,
            acp_client::session_commands::session_index_list,
            manual_auth::auth_manual_get,
            manual_auth::auth_manual_set,
            manual_auth::auth_manual_run,
            credentials::credential_list,
            api_test::api_models,
            api_test::api_test,
            api_test::api_test_cancel,
            acp_client::service_connection::service_capabilities,
            credentials::credential_save,
            credentials::credential_revoke,
            credentials::credential_delete,
            auth::auth_methods,
            auth::auth_run,
            acp_client::auth_connection::auth_recheck,
            auth::auth_cancel,
            auth::auth_end,
            auth::agent_logout,
            work_policy::agent_work_get,
            work_policy::agent_work_set,
            auth::settings_get,
            auth::settings_set,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_await,
            pty::pty_close,
            project_index::project_files,
            project_index::project_file_read,
            draft_attachment::draft_attachment_check,
            draft_exit::app_drafts_ready,
            draft_exit::app_exit_after_save,
            ui_transport::app_initial_snapshot,
            diagnostics::diagnostics_preview,
            diagnostics::export_diagnostics,
            managed_update::managed_update_snapshot,
            managed_update::managed_update_check,
            managed_update::managed_update_install,
            performance_trace::host_performance_origin,
            performance_trace::host_performance_sample,
        ])
        .build(context)
        .expect("failed to build Farfold")
        .run(|app, event| {
            draft_exit::handle(app, &event);
            if should_stop_agents(&event) {
                app.state::<acp_client::manager::AcpManager>()
                    .stop_for_shutdown();
                app.state::<pty::PtyManager>().stop_for_shutdown();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::should_stop_agents;
    use serde_json::Value;

    #[test]
    fn agents_stop_on_the_final_run_event() {
        assert!(should_stop_agents(&tauri::RunEvent::Exit));
        assert!(!should_stop_agents(&tauri::RunEvent::Ready));
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
    fn bundle_resources_carry_no_agent_payloads() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json should remain valid JSON");
        let resources = config
            .pointer("/bundle/resources")
            .and_then(Value::as_object)
            .expect("bundle resources should be an object");
        for key in resources.keys() {
            assert!(
                !key.contains("adapter") && !key.contains("runtime") && !key.contains("scripts"),
                "bundled resource should not ship agent payloads: {key}"
            );
        }
        assert_eq!(config.pointer("/bundle/externalBin"), None);
    }
}
