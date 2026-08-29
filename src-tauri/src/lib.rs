mod pi_auth;
mod pi_runtime;

use pi_runtime::PiRuntime;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(PiRuntime::default())
        .invoke_handler(tauri::generate_handler![
            pi_auth::pi_auth_status,
            pi_auth::pi_auth_set_api_key,
            pi_auth::pi_auth_remove,
            pi_runtime::pi_runtime_start,
            pi_runtime::pi_runtime_send,
            pi_runtime::pi_runtime_stop,
            pi_runtime::pi_runtime_status,
            pi_runtime::pi_runtime_list_sessions,
            pi_runtime::pi_runtime_remember_session,
            pi_runtime::pi_runtime_poll_events,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Farfold")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                let runtime = app.state::<PiRuntime>();
                let _ = pi_runtime::stop_process(&runtime, None);
            }
        });
}
