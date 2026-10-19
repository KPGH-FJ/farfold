//! Serialize only the tests which actually consume the shared production budget.
pub(in crate::acp_client) fn fixture_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let thread = std::thread::current();
    let test = thread.name().unwrap_or("<unnamed>");
    eprintln!(
        "FARFOLD_FIXTURE_LOCK {}",
        serde_json::json!({"phase":"WAIT","pid":std::process::id(),"test":test})
    );
    let guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    eprintln!(
        "FARFOLD_FIXTURE_LOCK {}",
        serde_json::json!({"phase":"ACQUIRED","pid":std::process::id(),"test":test})
    );
    guard
}
