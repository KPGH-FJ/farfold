#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = farfold_lib::run_process_helper_if_requested() {
        std::process::exit(code);
    }
    if let Some(code) = farfold_lib::run_browser_helper_if_requested() {
        std::process::exit(code);
    }
    farfold_lib::run();
}
