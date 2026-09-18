//! Local agent discovery.
//!
//! Candidate directories come from the login-shell PATH plus the well-known
//! install locations GUI apps do not inherit (`~/.opencode/bin`, nvm, npm
//! globals, Homebrew). Discovery is a probe only — presence is reported, and
//! compatibility is decided by the ACP handshake at connect time, not here.

use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
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
        // Newest two nvm node installs (lexicographic order puts the largest
        // version last, which is what we want).
        let nvm_root = home.join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&nvm_root) {
            let mut versions: Vec<PathBuf> = entries
                .flatten()
                .map(|entry| entry.path().join("bin"))
                .filter(|path| path.is_dir())
                .collect();
            versions.sort();
            dirs.extend(versions.into_iter().rev().take(2));
        }
    }
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));

    let mut seen = std::collections::HashSet::new();
    dirs.retain(|dir| dir.is_dir() && seen.insert(dir.clone()));
    dirs
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
    let mut child = Command::new(binary)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + VERSION_TIMEOUT;
    let mut stdout = child.stdout.take()?;
    let mut buffer = Vec::new();
    let result = loop {
        match child.try_wait() {
            Ok(Some(_)) => break true,
            Ok(None) if Instant::now() < deadline => {
                // Drain incrementally so a chatty agent cannot fill the pipe
                // and block on write.
                let _ = stdout.by_ref().take(4096).read_to_end(&mut buffer);
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    if !result {
        return None;
    }
    let _ = stdout
        .take((VERSION_OUTPUT_CAP - buffer.len().min(VERSION_OUTPUT_CAP)) as u64)
        .read_to_end(&mut buffer);
    buffer.truncate(VERSION_OUTPUT_CAP);
    parse_version_output(&String::from_utf8_lossy(&buffer))
}

/// Probe every catalog def's `discovery_binary` across `candidate_dirs()`.
/// Returns one entry per found binary (PATH order decides which copy wins).
pub fn discover() -> Vec<DiscoveredBinary> {
    let dirs = candidate_dirs();
    builtin_defs()
        .iter()
        .filter_map(|def| discover_def(def, &dirs))
        .collect()
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
    fn candidate_dirs_are_existing_dirs_without_dupes() {
        let dirs = candidate_dirs();
        assert!(!dirs.is_empty());
        assert!(dirs.iter().all(|dir| dir.is_dir()));
        let unique: std::collections::HashSet<_> = dirs.iter().collect();
        assert_eq!(unique.len(), dirs.len());
    }
}
