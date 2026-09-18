mod acp_client;
mod agent_catalog;
mod agent_discovery;
mod agent_install;
mod auth;
mod managed_update;
pub mod meta_store;
mod node_runtime;
mod performance_trace;
mod pty;
pub mod shell_env;
mod transport_security;
mod ui_transport;
mod update_feed;
mod update_metadata;

use tauri::{AppHandle, Manager};

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

fn should_stop_agents(event: &tauri::RunEvent) -> bool {
    matches!(event, tauri::RunEvent::Exit)
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
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _cwd| {
                activate_existing_instance(app);
            },
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(acp_client::manager::AcpManager::default())
        .manage(pty::PtyManager::default())
        .manage(managed_update::ManagedUpdateAuthority::default())
        .setup(move |app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            std::fs::create_dir_all(&app_data_dir)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            if !app.manage(meta_store::MetaStore::open(
                &meta_store::MetaStore::default_path(&app_data_dir),
            )?) {
                return Err(std::io::Error::other("meta store is already initialized").into());
            }
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
            agent_catalog::catalog_list,
            agent_catalog::catalog_scan,
            agent_install::agent_register,
            agent_install::agent_add_custom,
            agent_install::agent_install,
            agent_install::agent_remove,
            acp_client::manager::agent_connect,
            acp_client::manager::agent_disconnect,
            acp_client::manager::agent_status,
            acp_client::manager::agent_authenticate,
            acp_client::session_commands::session_open,
            acp_client::session_commands::session_prompt,
            acp_client::session_commands::session_cancel,
            acp_client::session_commands::session_set_config,
            acp_client::session_commands::session_permission_respond,
            acp_client::session_commands::session_list,
            acp_client::session_commands::session_close,
            acp_client::session_commands::session_touch,
            acp_client::session_commands::session_meta_rename,
            acp_client::session_commands::session_meta_pin,
            acp_client::session_commands::session_meta_archive,
            acp_client::session_commands::session_meta_delete,
            acp_client::session_commands::session_index_list,
            auth::auth_methods,
            auth::auth_run,
            auth::auth_set_api_key,
            auth::agent_logout,
            auth::settings_get,
            auth::settings_set,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_await,
            pty::pty_close,
            ui_transport::app_initial_snapshot,
            managed_update::managed_update_snapshot,
            managed_update::managed_update_check,
            managed_update::managed_update_install,
            performance_trace::host_performance_origin,
            performance_trace::host_performance_sample,
        ])
        .build(context)
        .expect("failed to build Farfold")
        .run(|app, event| {
            if should_stop_agents(&event) {
                app.state::<acp_client::manager::AcpManager>()
                    .stop_for_shutdown();
                app.state::<pty::PtyManager>().stop_for_shutdown();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{should_stop_agents, validate_profile_identity};
    use serde_json::Value;

    #[test]
    fn development_override_cannot_open_daily_use_storage() {
        assert!(validate_profile_identity("ai.farfold.desktop", true).is_err());
        assert!(validate_profile_identity("ai.farfold.desktop.dev", true).is_ok());
        assert!(validate_profile_identity("ai.farfold.desktop.p3qa", true).is_ok());
        assert!(validate_profile_identity("ai.farfold.desktop", false).is_ok());
    }

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
