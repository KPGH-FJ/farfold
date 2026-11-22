//! Process isolation for new App Server conversations in the approved Codex profile.
use super::super::extension_inventory::{Code, Result, launch::Directory};
use super::super::official_preflight::offline::{self, ReviewedProgram, SANDBOX_EXEC, quote};
use crate::meta_store::AgentRow;
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::{self, Permissions};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;

const PROFILE: &str = "codex-app-server";

struct Profile {
    root: PathBuf,
    identity: Directory,
}

impl Profile {
    fn open(app_data: &Path, original: &Path) -> Result<Self> {
        let base = app_data
            .canonicalize()
            .map_err(|_| Code::ConfigurationReadOnly)?;
        let uid = unsafe { libc::geteuid() };
        let metadata = base
            .symlink_metadata()
            .map_err(|_| Code::ConfigurationReadOnly)?;
        if base != app_data
            || !metadata.is_dir()
            || metadata.uid() != uid
            || metadata.mode() & 0o022 != 0
        {
            return Err(Code::ConfigurationReadOnly.into());
        }
        let root = base.join(PROFILE);
        if root.starts_with(original) || original.starts_with(&root) {
            return Err(Code::ConfigurationReadOnly.into());
        }
        let identity = Directory::open(root.to_str().ok_or(Code::ConfigurationReadOnly)?)?;
        let profile = Self { root, identity };
        if !profile.current() {
            return Err(Code::ConfigurationChanged.into());
        }
        Ok(profile)
    }

    fn current(&self) -> bool {
        let Ok(metadata) = self.root.symlink_metadata() else {
            return false;
        };
        metadata.is_dir()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o7777 == 0o700
            && self.identity.current()
    }

    fn auth_file_present(&self) -> bool {
        // Read file metadata only. This neither extracts credentials nor
        // authenticates the owner. The official account read handles identity.
        self.root
            .join("auth.json")
            .symlink_metadata()
            .is_ok_and(|metadata| {
                metadata.is_file()
                    && metadata.uid() == unsafe { libc::geteuid() }
                    && metadata.nlink() == 1
                    && metadata.mode() & 0o7177 == 0
                    && metadata.mode() & 0o400 != 0
                    && metadata.len() != 0
            })
    }
}

struct Selection {
    profile: Profile,
    program: ReviewedProgram,
    original: PathBuf,
    environment: HashMap<OsString, OsString>,
}

fn selection(row: &AgentRow, app_data: &Path) -> Result<Selection> {
    if !offline::available() {
        return Err(Code::PlatformUnsupported.into());
    }
    let environment = offline::reviewed_environment(row)?;
    let original = offline::reviewed_original_home(&environment)?;
    let program = offline::reviewed_program(row, &environment, &original)?;
    let profile = Profile::open(app_data, &original)?;
    if program.path().starts_with(&profile.root) {
        return Err(Code::EntryUnverified.into());
    }
    if !program.current() || !profile.current() {
        return Err(Code::ConfigurationChanged.into());
    }
    Ok(Selection {
        profile,
        program,
        original,
        environment,
    })
}

pub(super) fn ready(row: &AgentRow, app_data: &Path) -> bool {
    selection(row, app_data).is_ok_and(|selected| selected.profile.auth_file_present())
}

pub(super) struct Launch {
    pub(super) command: Option<Command>,
    profile: Profile,
    program: ReviewedProgram,
    workspace: Directory,
    pub(super) cwd: PathBuf,
    history_root: PathBuf,
    _scratch: tempfile::TempDir,
}

impl Launch {
    pub(super) fn history_root(&self) -> &Path {
        &self.history_root
    }

    pub(super) fn current(&self) -> bool {
        self.profile.current() && self.program.current() && self.workspace.current()
    }
}

pub(super) fn launch(
    row: &AgentRow,
    app_data: &Path,
    cwd: &Path,
    model: &str,
    effort: &str,
) -> Result<Launch> {
    let Selection {
        profile,
        program,
        original,
        environment,
    } = selection(row, app_data)?;
    if !profile.auth_file_present() {
        return Err(Code::Unavailable.into());
    }
    let cwd = cwd.canonicalize().map_err(|_| Code::CwdUnavailable)?;
    if cwd.starts_with(&profile.root) || cwd.starts_with(&original) {
        return Err(Code::CwdUnavailable.into());
    }
    let workspace = Directory::open(cwd.to_str().ok_or(Code::CwdUnavailable)?)?;
    let tmp = std::env::temp_dir()
        .canonicalize()
        .map_err(|_| Code::CwdUnavailable)?;
    if tmp.starts_with(&profile.root) {
        return Err(Code::CwdUnavailable.into());
    }
    let scratch = tempfile::Builder::new()
        .prefix("farfold-codex-conversation-")
        .permissions(Permissions::from_mode(0o700))
        .tempdir_in(tmp)
        .map_err(|_| Code::CwdUnavailable)?;
    let root = scratch.path();
    let profile_file = root.join("offline.sb");
    let policy = policy(&profile.root, program.path(), root, &cwd)?;
    fs::write(&profile_file, policy).map_err(|_| Code::CwdUnavailable)?;

    let mut command = Command::new(SANDBOX_EXEC);
    command
        .arg("-f")
        .arg(profile_file)
        .arg(program.path())
        .current_dir(root)
        .envs(environment)
        .env("CODEX_HOME", &profile.root)
        .env("CODEX_SQLITE_HOME", &profile.root)
        .env("TMPDIR", root)
        .env("RUST_LOG", "off")
        .env("CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED", "1");
    for name in [
        "CFFIXED_USER_HOME",
        "__CFPREFERENCES_AVOID_DAEMON",
        "SSH_AUTH_SOCK",
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "OPENAI_BASE_URL",
        "OPENAI_ORG",
        "OPENAI_ORGANIZATION",
        "OPENAI_PROJECT",
        "OPENAI_PROJECT_ID",
        "CHATGPT_BASE_URL",
        "CODEX_APP_SERVER_LOGIN_ISSUER",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    ] {
        command.env_remove(name);
    }
    command
        .arg("-c")
        .arg(format!("log_dir={}", quote(root)?))
        .arg("-c")
        .arg(format!("sqlite_home={}", quote(&profile.root)?))
        .arg("-c")
        .arg(format!(
            "model={}",
            serde_json::to_string(model).map_err(|_| Code::InvalidRequest)?
        ))
        .arg("-c")
        .arg(format!(
            "model_reasoning_effort={}",
            serde_json::to_string(effort).map_err(|_| Code::InvalidRequest)?
        ));
    for option in [
        "cli_auth_credentials_store=\"file\"",
        "model_provider=\"openai\"",
        "sandbox_mode=\"read-only\"",
        "approval_policy=\"on-request\"",
        "approvals_reviewer=\"user\"",
        "web_search=\"disabled\"",
        "analytics.enabled=false",
        "features.shell_tool=false",
        "features.unified_exec=false",
        "features.apps=false",
        "features.plugins=false",
        "features.browser_use=false",
    ] {
        command.args(["-c", option]);
    }
    command.args(["app-server", "--listen", "stdio://"]);
    offline::prevent_inherited_connections(&mut command)?;

    let launch = Launch {
        command: Some(command),
        history_root: profile.root.join("sessions"),
        profile,
        program,
        workspace,
        cwd,
        _scratch: scratch,
    };
    if !launch.current() {
        return Err(Code::ConfigurationChanged.into());
    }
    Ok(launch)
}

fn policy(profile: &Path, program: &Path, scratch: &Path, cwd: &Path) -> Result<String> {
    let mut lines = offline::blocked_runtime_policy();
    lines.extend([
        format!(
            "(allow process-exec file-read* (literal {}))",
            quote(program)?
        ),
        format!(
            "(allow file-read* file-write* (subpath {}) (subpath {}))",
            quote(profile)?,
            quote(scratch)?
        ),
        format!(
            "(deny file-write* (literal {}))",
            quote(&profile.join("auth.json"))?
        ),
    ]);
    // Only pathname metadata is needed to identify the chosen directory. The
    // selected workspace's files and original Agent homes never become readable.
    for path in [
        profile,
        program,
        scratch,
        cwd,
        Path::new("/usr/bin"),
        Path::new("/System/Volumes/Data"),
        Path::new("/Library"),
        Path::new("/etc"),
        Path::new("/tmp"),
        Path::new("/var"),
    ]
    .into_iter()
    .flat_map(Path::ancestors)
    {
        lines.push(format!(
            "(allow file-read-metadata (literal {}))",
            quote(path)?
        ));
    }
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::DirBuilder;
    use std::os::unix::fs::{DirBuilderExt, symlink};

    #[test]
    fn private_profile_rejects_foreign_paths_and_replacement() {
        let app_data = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let base = app_data.path().canonicalize().unwrap();
        let original = other.path().canonicalize().unwrap();
        let path = base.join(PROFILE);
        assert!(Profile::open(&base, &base).is_err());
        symlink(other.path(), &path).unwrap();
        assert!(Profile::open(&base, &original).is_err());
        fs::remove_file(&path).unwrap();

        DirBuilder::new().mode(0o700).create(&path).unwrap();
        let profile = Profile::open(&base, &original).unwrap();
        assert!(!profile.auth_file_present());
        let auth = path.join("auth.json");
        let other_auth = other.path().join("auth.json");
        fs::write(&other_auth, b"not credentials").unwrap();
        symlink(&other_auth, &auth).unwrap();
        assert!(!profile.auth_file_present());
        fs::remove_file(&auth).unwrap();
        fs::write(&auth, b"not credentials").unwrap();
        fs::set_permissions(&auth, Permissions::from_mode(0o600)).unwrap();
        assert!(profile.auth_file_present());
        let copy = path.join("auth-alias");
        fs::hard_link(&auth, &copy).unwrap();
        assert!(!profile.auth_file_present());

        fs::rename(&path, base.join("previous")).unwrap();
        DirBuilder::new().mode(0o700).create(path).unwrap();
        assert!(!profile.current());
    }

    #[test]
    fn policy_limits_process_network_and_workspace() {
        let result = policy(
            Path::new("/app/isolated"),
            Path::new("/bin/native"),
            Path::new("/tmp/owned"),
            Path::new("/home/user/selected"),
        )
        .unwrap();
        let write_rules: Vec<_> = result
            .lines()
            .filter(|line| line.starts_with("(allow") && line.contains("file-write"))
            .collect();
        assert_eq!(
            write_rules,
            ["(allow file-read* file-write* (subpath \"/app/isolated\") (subpath \"/tmp/owned\"))"]
        );
        assert!(result.contains("(deny network*)"));
        assert!(result.contains("process-fork"));
        assert!(result.contains("(allow file-read-metadata (literal \"/home/user/selected\"))"));
    }
}
