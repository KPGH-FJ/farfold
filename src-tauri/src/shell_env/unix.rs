//! Login-shell environment resolution.
//!
//! GUI apps launched from Finder inherit a minimal environment that usually
//! lacks the user's PATH entries (e.g. `~/.opencode/bin`, nvm, Homebrew).
//! Resolving the user's login shell environment once lets us spawn agent
//! processes with the same PATH they would have in a terminal.

use std::collections::HashMap;
use std::io::Read as _;
use std::os::{fd::AsRawFd, unix::process::CommandExt};
use std::process::{Child, Command, Stdio};
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

fn terminate_shell(child: &mut Child) {
    // Only this probe's process group: shell startup can leave descendants holding stdout.
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn run_login_shell(shell: &str) -> Option<HashMap<String, String>> {
    run_shell_probe(shell, LOGIN_ENV_TIMEOUT, LOGIN_ENV_OUTPUT_CAP)
}

fn run_shell_probe(
    shell: &str,
    timeout: Duration,
    output_cap: usize,
) -> Option<HashMap<String, String>> {
    let mut child = Command::new(shell)
        .args(["-ilc", "env"])
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + timeout;
    let mut stdout = child.stdout.take()?;
    let fd = stdout.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        terminate_shell(&mut child);
        return None;
    }
    let mut buffer = Vec::new();
    let mut eof = false;
    let mut chunk = [0u8; 4096];
    loop {
        if Instant::now() >= deadline {
            terminate_shell(&mut child);
            return None;
        }
        while !eof {
            match stdout.read(&mut chunk) {
                Ok(0) => eof = true,
                Ok(count) if buffer.len() + count <= output_cap => {
                    buffer.extend_from_slice(&chunk[..count])
                }
                Ok(_) => {
                    terminate_shell(&mut child);
                    return None;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    terminate_shell(&mut child);
                    return None;
                }
            }
            if Instant::now() >= deadline {
                terminate_shell(&mut child);
                return None;
            }
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() && eof => {
                let env = parse_env_output(&String::from_utf8_lossy(&buffer));
                return (!env.is_empty()).then_some(env);
            }
            Ok(Some(status)) if !status.success() => {
                terminate_shell(&mut child);
                return None;
            }
            Err(_) => {
                terminate_shell(&mut child);
                return None;
            }
            _ => {}
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        let wait = if eof {
            remaining.min(Duration::from_millis(20))
        } else {
            remaining
        };
        let mut poll_fd = libc::pollfd {
            fd: if eof { -1 } else { fd },
            events: libc::POLLIN,
            revents: 0,
        };
        let result = unsafe {
            libc::poll(
                &mut poll_fd,
                1,
                wait.as_millis().min(i32::MAX as u128) as i32,
            )
        };
        if result < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            terminate_shell(&mut child);
            return None;
        }
    }
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
    fn access_regression_shell_timeout_is_bounded_while_stdout_is_open() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let shell = directory.path().join("slow-shell");
        std::fs::write(
            &shell,
            "#!/bin/sh\n/bin/sleep 1\n/usr/bin/printf 'PATH=/usr/bin:/bin\\n'\n",
        )
        .unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
        let start = Instant::now();
        assert!(
            run_shell_probe(shell.to_str().unwrap(), Duration::from_millis(75), 4096).is_none()
        );
        assert!(start.elapsed() < Duration::from_millis(750));
    }

    #[test]
    fn shell_probe_keeps_only_complete_bounded_success() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let shell = directory.path().join("fixture-shell");
        std::fs::write(
            &shell,
            "#!/bin/sh\nprintf 'PATH=/fixture/bin\\nFIXTURE=value\\n'\n",
        )
        .unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
        // This checks output shape; startup uses the same budget as the real login probe.
        let result = run_shell_probe(shell.to_str().unwrap(), LOGIN_ENV_TIMEOUT, 4096).unwrap();
        assert_eq!(result["FIXTURE"], "value");
        assert_eq!(result["PATH"], "/fixture/bin");
        assert!(run_shell_probe(shell.to_str().unwrap(), LOGIN_ENV_TIMEOUT, 8).is_none());
        std::fs::write(&shell, "#!/bin/sh\nprintf 'PATH=/partial\\n'\nexit 1\n").unwrap();
        assert!(run_shell_probe(shell.to_str().unwrap(), LOGIN_ENV_TIMEOUT, 4096).is_none());
    }

    #[test]
    fn shell_timeout_ends_descendants_that_keep_the_pipe_open() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let shell = directory.path().join("forking-shell");
        let marker = directory.path().join("unexpected-descendant-result");
        std::fs::write(
            &shell,
            format!(
                "#!/bin/sh\n(/bin/sleep 0.4; /usr/bin/printf alive > '{}') &\nexit 0\n",
                marker.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            run_shell_probe(shell.to_str().unwrap(), Duration::from_millis(75), 4096).is_none()
        );
        std::thread::sleep(Duration::from_millis(450));
        assert!(!marker.exists());
    }

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
