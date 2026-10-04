#[path = "../backend-staging/browser_sharing/helper.rs"]
mod helper;

fn main() {
    std::process::exit(helper::run_if_requested().unwrap_or(17));
}
