//! Local agent discovery.
//!
//! Candidate directories come from the login-shell PATH plus the well-known
//! install locations GUI apps do not inherit (`~/.opencode/bin`, nvm, npm
//! globals, Homebrew). Discovery is a probe only — presence is reported, and
//! compatibility is decided by the ACP handshake at connect time, not here.

use std::io::Read as _;
use std::os::{fd::AsRawFd, unix::process::CommandExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::agent_catalog::{AgentDef, builtin_defs};
use crate::shell_env;

const VERSION_TIMEOUT: Duration = Duration::from_secs(10);
/// Bound on `--version` output we bother parsing.
const VERSION_OUTPUT_CAP: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredBinary {
    pub agent_id: String,
    pub path: String,
    pub version: Option<String>,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// All directories probed for agent binaries: login-shell PATH entries plus
/// the standard install locations, deduplicated, existing dirs only.
pub fn candidate_dirs() -> Vec<PathBuf> {
    let env = shell_env::command_env();
    let mut dirs: Vec<PathBuf> = env
        .get("PATH")
        .map(|path| {
            path.split(':')
                .filter(|entry| !entry.is_empty())
                .map(PathBuf::from)
                .collect()
        })
        .unwrap_or_default();

    if let Some(home) = home_dir() {
        for extra in [".opencode/bin", ".local/bin", ".npm-global/bin"] {
            dirs.push(home.join(extra));
        }
        let nvm_root = home.join(".nvm/versions/node");
        dirs.extend(nvm_bin_dirs(&nvm_root));
    }
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));

    let mut seen = std::collections::HashSet::new();
    dirs.retain(|dir| dir.is_dir() && seen.insert(dir.clone()));
    dirs
}

fn nvm_bin_dirs(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut versions: Vec<_> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            let version = semver::Version::parse(name.strip_prefix('v').unwrap_or(name)).ok()?;
            let bin = entry.path().join("bin");
            bin.is_dir().then_some((version, bin))
        })
        .collect();
    versions.sort_by(|a, b| b.0.cmp(&a.0));
    // Match discovery's per-Agent bound. Preserve several intentional installs
    // without walking the user's filesystem or assuming PATH lists every copy.
    versions
        .into_iter()
        .take(16)
        .map(|(_, path)| path)
        .collect()
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    path.is_file()
        && std::fs::metadata(path)
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
}

/// Locate `binary` in `dirs`. Returns the first match (PATH order wins).
pub fn find_binary(binary: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    if binary.contains('/') {
        let path = PathBuf::from(binary);
        return is_executable(&path).then_some(path);
    }
    dirs.iter()
        .map(|dir| dir.join(binary))
        .find(|path| is_executable(path))
}

fn parse_version_output(output: &str) -> Option<String> {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return None;
    }
    // First semver-ish token, else the first line trimmed.
    for token in trimmed.split_whitespace() {
        let token = token.trim_matches(|c: char| c == 'v' || c == '(' || c == ')' || c == ',');
        if semver::Version::parse(token).is_ok() {
            return Some(token.to_string());
        }
    }
    trimmed
        .lines()
        .next()
        .map(|line| line.chars().take(80).collect())
}

/// Run `<binary> --version` with a hard timeout; output is capped.
pub fn probe_version(binary: &Path) -> Option<String> {
    version_output(binary, VERSION_TIMEOUT, || Ok(()))
        .ok()
        .flatten()
        .and_then(|output| parse_version_output(&output))
}

struct VersionChild(Child);

impl Drop for VersionChild {
    fn drop(&mut self) {
        // A wrapper may exit before its descendants close stdout. The probe
        // owns this group, including after the leader has already exited.
        unsafe {
            libc::kill(-(self.0.id() as i32), libc::SIGKILL);
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Shared bounded probe for discovery and install preparation. Cancellation
/// is checked even when no output arrives or a descendant retains the pipe.
pub(crate) fn version_output(
    binary: &Path,
    timeout: Duration,
    check: impl Fn() -> Result<(), String>,
) -> Result<Option<String>, String> {
    check()?;
    let child = Command::new(binary)
        .arg("--version")
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(child) = child else { return Ok(None) };
    let mut child = VersionChild(child);
    let Some(mut stdout) = child.0.stdout.take() else {
        return Ok(None);
    };
    let deadline = Instant::now() + timeout;
    let fd = stdout.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Ok(None);
    }
    let mut buffer = Vec::new();
    let mut eof = false;
    let mut chunk = [0u8; 4096];
    loop {
        check()?;
        if Instant::now() >= deadline {
            return Ok(None);
        }
        while !eof {
            check()?;
            if Instant::now() >= deadline {
                return Ok(None);
            }
            match stdout.read(&mut chunk) {
                Ok(0) => eof = true,
                Ok(count) if buffer.len() + count <= VERSION_OUTPUT_CAP => {
                    buffer.extend_from_slice(&chunk[..count]);
                }
                Ok(_) => return Ok(None),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return Ok(None),
            }
        }
        match child.0.try_wait() {
            Ok(Some(status)) if status.success() && eof => {
                return Ok(Some(String::from_utf8_lossy(&buffer).trim().to_string()));
            }
            Ok(Some(status)) if !status.success() => return Ok(None),
            Err(_) => return Ok(None),
            _ => {}
        }
        let wait = deadline
            .saturating_duration_since(Instant::now())
            .min(Duration::from_millis(20));
        let mut poll_fd = libc::pollfd {
            fd: if eof { -1 } else { fd },
            events: libc::POLLIN,
            revents: 0,
        };
        let result = unsafe { libc::poll(&mut poll_fd, 1, wait.as_millis() as i32) };
        if result < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return Ok(None);
        }
    }
}

/// Probe every catalog def's `discovery_binary` across `candidate_dirs()`.
/// Returns one entry per found binary (PATH order decides which copy wins).
pub fn discover() -> Vec<DiscoveredBinary> {
    let dirs = candidate_dirs();
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut found = Vec::new();
    for def in builtin_defs() {
        let mut seen = std::collections::HashSet::new();
        for dir in &dirs {
            let path = dir.join(def.discovery_binary);
            if !is_executable(&path) {
                continue;
            }
            let Ok(path) = path.canonicalize() else {
                continue;
            };
            if !seen.insert(path.clone()) {
                continue;
            }
            let version = if Instant::now() < deadline {
                probe_version(&path)
            } else {
                None
            };
            found.push(DiscoveredBinary {
                agent_id: def.id.into(),
                path: path.to_string_lossy().into_owned(),
                version,
            });
            if seen.len() >= 16 {
                break;
            }
        }
    }
    found
}

pub fn discover_def(def: &AgentDef, dirs: &[PathBuf]) -> Option<DiscoveredBinary> {
    let path = find_binary(def.discovery_binary, dirs)?;
    Some(DiscoveredBinary {
        agent_id: def.id.to_string(),
        path: path.to_string_lossy().into_owned(),
        version: probe_version(&path),
    })
}

/// Validation for `agent_add_custom` / `register_discovered`: the path must be
/// an existing executable file. Returns the normalized absolute path.
pub fn validate_executable_path(raw: &str) -> Result<PathBuf, String> {
    if raw.trim().is_empty() {
        return Err("command path is empty".to_string());
    }
    let path = PathBuf::from(raw);
    if !path.exists() {
        return Err(format!("command does not exist: {raw}"));
    }
    if !path.is_file() {
        return Err(format!("command is not a file: {raw}"));
    }
    if !is_executable(&path) {
        return Err(format!("command is not executable: {raw}"));
    }
    path.canonicalize()
        .map_err(|error| format!("cannot resolve {raw}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nvm_discovery_keeps_multiple_installs_in_numeric_version_order() {
        let directory = tempfile::tempdir().unwrap();
        for version in ["v9.9.0", "v10.0.0", "v22.0.0", "v24.1.0"] {
            std::fs::create_dir_all(directory.path().join(version).join("bin")).unwrap();
        }
        let dirs = nvm_bin_dirs(directory.path());
        assert_eq!(dirs.len(), 4);
        assert_eq!(dirs[0], directory.path().join("v24.1.0/bin"));
        assert_eq!(dirs[3], directory.path().join("v9.9.0/bin"));
    }

    #[test]
    fn parse_version_prefers_semver_tokens() {
        assert_eq!(
            parse_version_output("opencode 1.15.13 (build abc)").as_deref(),
            Some("1.15.13")
        );
        assert_eq!(
            parse_version_output("codex-cli 0.143.0").as_deref(),
            Some("0.143.0")
        );
        assert!(parse_version_output("").is_none());
    }

    #[test]
    fn validate_executable_path_rejects_missing_and_dirs() {
        assert!(validate_executable_path("").is_err());
        assert!(validate_executable_path("/definitely/not/here").is_err());
        assert!(validate_executable_path("/tmp").is_err());
        assert!(validate_executable_path("/bin/ls").is_ok());
    }

    #[test]
    fn probe_version_reads_real_binary() {
        // /bin/echo ignores --version and prints it back — exercises the
        // spawn+read path without depending on a real agent.
        let output = probe_version(Path::new("/bin/echo"));
        assert_eq!(output.as_deref(), Some("--version"));
    }

    #[test]
    fn version_probe_rejects_hanging_failed_and_oversized_output() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("version-probe");
        for script in [
            "#!/bin/sh\n/bin/sleep 2\n/usr/bin/printf 'v1.2.3\\n'\n",
            "#!/bin/sh\n/usr/bin/printf 'v1.2.3\\n'\nexit 1\n",
            "#!/bin/sh\nwhile :; do printf '0123456789abcdef'; done\n",
        ] {
            std::fs::write(&binary, script).unwrap();
            std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
            let started = Instant::now();
            assert!(
                version_output(&binary, Duration::from_millis(75), || Ok(()))
                    .unwrap()
                    .is_none()
            );
            assert!(started.elapsed() < Duration::from_millis(750));
        }
    }

    #[test]
    fn candidate_dirs_are_existing_dirs_without_dupes() {
        let dirs = candidate_dirs();
        assert!(!dirs.is_empty());
        assert!(dirs.iter().all(|dir| dir.is_dir()));
        let unique: std::collections::HashSet<_> = dirs.iter().collect();
        assert_eq!(unique.len(), dirs.len());
    }
}
