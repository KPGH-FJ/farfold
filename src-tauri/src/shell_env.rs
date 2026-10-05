//! Preserve the platform environment; Windows has no Unix login-shell probe.
#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::{command_env, login_shell_env};
#[cfg(windows)]
pub fn login_shell_env() -> std::collections::HashMap<String, String> {
    let mut env: std::collections::HashMap<_, _> = std::env::vars().collect();
    // Windows names are case-insensitive. Consumers use one canonical PATH key.
    if let Some(name) = env
        .keys()
        .find(|key| key.eq_ignore_ascii_case("PATH"))
        .cloned()
        && let Some(value) = env.remove(&name)
    {
        env.insert("PATH".into(), value);
    }
    env
}
#[cfg(windows)]
pub fn command_env() -> std::collections::HashMap<String, String> {
    login_shell_env()
}
