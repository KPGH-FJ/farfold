fn main() {
    if let Some(code) = farfold_lib::run_browser_helper_if_requested() {
        std::process::exit(code);
    }
    farfold_lib::run();
}
