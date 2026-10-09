mod acp_client;
mod agent_catalog;
mod agent_discovery;
mod agent_install;
mod api_endpoint;
mod api_test;
#[cfg(target_os = "macos")]
mod app_menu;
mod archive_zip;
mod auth;
mod browser_sharing;
mod browser_workspace;
mod conversation_directory;
mod credentials;
mod data_reset;
mod dependency_install;
mod desktop_notifications;
mod diagnostics;
mod draft_attachment;
mod draft_exit;
mod file_access;
mod file_copy_commands;
mod file_copy_jobs;
mod file_delivery;
mod file_delivery_commands;
mod file_read_check;
mod install_job;
mod installations;
mod lifemodel;
mod logging;
#[cfg(target_os = "macos")]
mod macos_quit;
mod managed_paths;
mod managed_programs;
mod managed_update;
mod manual_auth;
pub mod meta_store;
mod node_runtime;
mod npm_release;
mod performance_trace;
#[cfg(test)]
mod platform_tests;
mod process_platform;
mod program_launch;
#[cfg(test)]
mod program_launch_tests;
mod project_index;
mod prompt_templates_commands;
mod pty;
pub mod shell_env;
mod storage_recovery;
mod supervisor;
mod transport_security;
mod ui_transport;
mod update_feed;
mod update_metadata;
mod update_platform;
mod uv_runtime;
#[cfg(windows)]
mod windows_process;
mod work_policy;

/// Process ownership helper dispatches before GUI, logging or Agent work.
pub fn run_process_helper_if_requested() -> Option<i32> {
    #[cfg(windows)]
    {
        windows_process::run_if_requested()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

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
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(app_menu::create)
        .on_menu_event(app_menu::handle);
    builder
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _cwd| {
                activate_existing_instance(app);
            },
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(browser_workspace::BrowserWorkspace::default())
        .manage(browser_sharing::BrowserSharing::default())
        .manage(pty::PtyManager::default())
        .manage(draft_exit::DraftExit::default())
        .manage(file_copy_jobs::FileCopyJobs::default())
        .manage(desktop_notifications::DesktopNotifications::default())
        .manage(diagnostics::DiagnosticsState::default())
        .manage(managed_update::ManagedUpdateAuthority::default())
        .setup(move |app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            #[cfg(windows)]
            let log_dir = app
                .path()
                .app_log_dir()
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            #[cfg(not(windows))]
            let log_dir = logging::default_log_dir();
            logging::init(&log_dir);
            logging::info(
                "app",
                format_args!("farfold {} started", env!("CARGO_PKG_VERSION")),
            );
            // Reap registered agent processes left behind by a crash or
            // force-quit before any connection work begins.
            supervisor::startup_cleanup(&app_data_dir);
            let connection_events = app.handle().clone();
            if !app.manage(
                acp_client::manager::AcpManager::new(
                    logging::default_log_dir(),
                    app_data_dir.clone(),
                )
                .with_status_sink(std::sync::Arc::new(move |status| {
                    ui_transport::emit_event(&connection_events, "agent:status", status);
                })),
            ) {
                return Err(std::io::Error::other("acp manager is already initialized").into());
            }
            if !app.manage(agent_catalog::AgentCatalog::new(app_data_dir.clone())) {
                return Err(std::io::Error::other("agent catalog is already initialized").into());
            }
            if !app.manage(node_runtime::NodeRuntimeState::new(app_data_dir.clone())) {
                return Err(
                    std::io::Error::other("node runtime state is already initialized").into(),
                );
            }
            app.manage(storage_recovery::StorageRecoveryState::new(
                meta_store::MetaStore::default_path(&app_data_dir),
            ));
            // Storage errors stay in a limited recovery shell. Do not mount the
            // editable UI or expose commands that require a missing MetaStore.
            storage_recovery::initialize(app.handle())?;
            Ok(())
        })
        .invoke_handler(|invoke| {
            if !browser_workspace::caller_allowed(invoke.message.webview_ref()) {
                invoke.resolver.reject("此页面不能操作应用");
                return true;
            }
            let storage = invoke
                .message
                .webview_ref()
                .app_handle()
                .try_state::<storage_recovery::StorageRecoveryState>();
            if !storage.is_some_and(|state| state.allows(invoke.message.command())) {
                invoke.resolver.reject("本机资料尚未就绪，请先完成资料恢复");
                return true;
            }
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                storage_recovery::storage_recovery_status,
                storage_recovery::storage_recovery_retry,
                storage_recovery::storage_recovery_export,
                storage_recovery::storage_recovery_reveal,
                storage_recovery::storage_recovery_restore_preview,
                storage_recovery::storage_recovery_restore_apply,
                storage_recovery::storage_recovery_restore_receipt,
                storage_recovery::storage_recovery_restore_cancel,
                storage_recovery::storage_recovery_database_preview,
                storage_recovery::storage_recovery_database_apply,
                storage_recovery::storage_recovery_database_status,
                storage_recovery::storage_recovery_database_continue,
                storage_recovery::storage_recovery_database_cancel,
                storage_recovery::storage_recovery_database_restart,
                browser_sharing::browser_share_status,
                browser_sharing::browser_share_allow,
                browser_sharing::browser_share_respond,
                browser_sharing::browser_share_stop,
                browser_workspace::browser_workspace_open,
                browser_workspace::browser_workspace_open_html,
                browser_workspace::preview_commands::browser_workspace_open_directory,
                browser_workspace::preview_commands::browser_workspace_open_development,
                browser_workspace::browser_workspace_clear_html_storage,
                browser_workspace::browser_workspace_navigate,
                browser_workspace::browser_workspace_resize,
                browser_workspace::browser_workspace_set_visible,
                browser_workspace::browser_workspace_snapshot,
                browser_workspace::browser_workspace_close,
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
                data_reset::farfold_data_clear,
                installations::agent_installations,
                installations::agent_installation_select,
                installations::agent_installation_uninstall,
                acp_client::manager::agent_connect,
                acp_client::manager::agent_disconnect,
                acp_client::manager::agent_status,
                acp_client::manager::connection_retention::agent_connection_hold,
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
                acp_client::session_commands::session_detach_for_config_check,
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
                auth::auth_key_save,
                auth::auth_run,
                acp_client::auth_connection::auth_recheck,
                acp_client::auth_connection::auth_refresh,
                auth::auth_cancel,
                auth::auth_end,
                auth::agent_logout,
                work_policy::agent_work_get,
                work_policy::agent_work_set,
                auth::settings_get,
                auth::settings_set,
                prompt_templates_commands::prompt_templates_save,
                desktop_notifications::desktop_notifications_get,
                desktop_notifications::desktop_notifications_set,
                desktop_notifications::desktop_notification_submit,
                desktop_notifications::desktop_notification_take_pending,
                pty::pty_spawn,
                pty::pty_write,
                pty::pty_resize,
                pty::pty_await,
                pty::pty_close,
                project_index::project_files,
                project_index::project_file_read,
                file_delivery_commands::file_delivery_inspect,
                file_delivery_commands::file_delivery_inspect_selected,
                file_delivery_commands::file_delivery_check_revision,
                file_delivery_commands::file_delivery_read_text,
                file_delivery_commands::file_delivery_read_text_block,
                file_delivery_commands::file_delivery_read_visual,
                file_delivery_commands::file_delivery_read_workbook,
                file_delivery_commands::file_delivery_read_docx,
                file_copy_commands::file_copy_prepare,
                file_copy_commands::file_copy_start,
                file_copy_commands::file_copy_status,
                file_copy_commands::file_copy_cancel,
                file_copy_commands::file_copy_release,
                file_delivery_commands::file_delivery_export_text,
                file_delivery_commands::file_delivery_open,
                file_delivery_commands::file_delivery_open_selected_location,
                file_delivery_commands::file_delivery_reveal_selected_location,
                file_delivery_commands::file_delivery_reveal,
                file_delivery_commands::file_delivery_reveal_location,
                draft_attachment::draft_attachment_check,
                draft_attachment::draft_attachment_image,
                draft_exit::app_drafts_ready,
                draft_exit::app_exit_after_save,
                draft_exit::app_exit_cancel,
                ui_transport::app_initial_snapshot,
                diagnostics::diagnostics_preview,
                diagnostics::export_diagnostics,
                managed_update::managed_update_snapshot,
                managed_update::managed_update_check,
                managed_update::managed_update_install,
                performance_trace::host_performance_origin,
                performance_trace::host_performance_sample,
            ];
            handler(invoke)
        })
        .build(context)
        .expect("failed to build Farfold")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            macos_quit::handle(app, &event);
            browser_workspace::handle_run_event(app, &event);
            desktop_notifications::handle_run_event(&event);
            draft_exit::handle(app, &event);
            storage_recovery::handle_run_event(app, &event);
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } = &event
            {
                let _ = app
                    .state::<acp_client::manager::AcpManager>()
                    .release_window_holds(label);
            }
            if should_stop_agents(&event) {
                app.state::<acp_client::manager::AcpManager>()
                    .stop_for_shutdown();
                app.state::<pty::PtyManager>().stop_for_shutdown();
            }
        });
}

/// Dispatch the private MCP transport before any normal application setup.
pub fn run_browser_helper_if_requested() -> Option<i32> {
    browser_sharing::run_helper_if_requested()
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
