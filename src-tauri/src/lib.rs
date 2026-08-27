mod pi_runtime;

use pi_runtime::PiRuntime;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(PiRuntime::default())
        .invoke_handler(tauri::generate_handler![
            pi_runtime::pi_runtime_start,
            pi_runtime::pi_runtime_send,
            pi_runtime::pi_runtime_stop,
            pi_runtime::pi_runtime_status,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Farfold");
}
