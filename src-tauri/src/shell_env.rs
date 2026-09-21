//! Login-shell environment resolution.
//!
//! GUI apps launched from Finder inherit a minimal environment that usually
//! lacks the user's PATH entries (e.g. `~/.opencode/bin`, nvm, Homebrew).
//! Resolving the user's login shell environment once lets us spawn agent
//! processes with the same PATH they would have in a terminal.

use std::collections::HashMap;
use std::io::Read as _;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

static LOGIN_ENV: OnceLock<HashMap<String, String>> = OnceLock::new();

fn parse_env_output(output: &str) -> HashMap<String, String> {
    let mut env = HashMap::new();
    for line in output.lines() {
        if let Some((name, value)) = line.split_once('=')
            && !name.is_empty()
        {
            env.insert(name.to_string(), value.to_string());
        }
    }
    env
}

/// Bound on `shell -ilc env`: a slow or interactive .zshrc must not stall
/// agent spawn paths. Output beyond this is truncated.
const LOGIN_ENV_TIMEOUT: Duration = Duration::from_secs(5);
const LOGIN_ENV_OUTPUT_CAP: usize = 1024 * 1024;

fn run_login_shell(shell: &str) -> Option<HashMap<String, String>> {
    let mut child = Command::new(shell)
        .args(["-ilc", "env"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + LOGIN_ENV_TIMEOUT;
    let mut stdout = child.stdout.take()?;
    let mut buffer = Vec::new();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => return None,
            Ok(None) if Instant::now() < deadline => {
                let _ = stdout.by_ref().take(4096).read_to_end(&mut buffer);
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let _ = stdout
        .take(LOGIN_ENV_OUTPUT_CAP.saturating_sub(buffer.len()) as u64)
        .read_to_end(&mut buffer);
    buffer.truncate(LOGIN_ENV_OUTPUT_CAP);
    let env = parse_env_output(&String::from_utf8_lossy(&buffer));
    if env.is_empty() { None } else { Some(env) }
}

/// Environment of the user's login shell (`$SHELL -ilc env`, falling back to
/// `zsh -ilc env`). Computed once and cached; empty if resolution failed.
pub fn login_shell_env() -> HashMap<String, String> {
    LOGIN_ENV
        .get_or_init(|| {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "zsh".to_string());
            run_login_shell(&shell)
                .or_else(|| run_login_shell("zsh"))
                .unwrap_or_default()
        })
        .clone()
}

/// Environment to use when spawning commands: the login-shell environment when
/// available, otherwise the current process environment.
pub fn command_env() -> HashMap<String, String> {
    let env = login_shell_env();
    if env.is_empty() {
        std::env::vars().collect()
    } else {
        env
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_env_has_nonempty_path_containing_bin() {
        let env = command_env();
        let path = env.get("PATH").expect("PATH must be set");
        assert!(!path.is_empty(), "PATH must not be empty");
        assert!(
            path.contains("bin"),
            "PATH should contain a bin dir: {path}"
        );
    }
}
