use std::collections::{BTreeMap, HashMap};
use std::ffi::OsStr;
use std::fs::{self, DirBuilder, File, Metadata};
use std::io::Read;
use std::os::unix::fs::{DirBuilderExt, FileExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::acp_client::extension_inventory::{self, Code, Result};
use crate::meta_store::AgentRow;
use sha2::{Digest, Sha256};

const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";
const ADAPTER_NPM: &str = "node_modules/@agentclientprotocol/codex-acp";
const CLI_NPM: &str = "@openai/codex";
const MAX_ARG0_ENTRIES: usize = 128;

#[cfg(target_arch = "aarch64")]
const PLATFORM: (&str, &str) = ("@openai/codex-darwin-arm64", "aarch64-apple-darwin");
#[cfg(target_arch = "x86_64")]
const PLATFORM: (&str, &str) = ("@openai/codex-darwin-x64", "x86_64-apple-darwin");

#[derive(PartialEq, Eq)]
struct Stamp {
    device: u64,
    inode: u64,
    mode: u32,
    owner: u32,
    links: u64,
}

impl From<&Metadata> for Stamp {
    fn from(value: &Metadata) -> Self {
        Self {
            device: value.dev(),
            inode: value.ino(),
            mode: value.mode(),
            owner: value.uid(),
            links: value.nlink(),
        }
    }
}

struct Identity {
    path: PathBuf,
    file: File,
    stamp: Stamp,
    hash: [u8; 32],
}

impl Identity {
    fn capture(path: PathBuf, uid: u32) -> Option<Self> {
        let file = regular(&path)?;
        let stamp = Stamp::from(&file.metadata().ok()?);
        // The official reader opens this file O_RDWR and normalizes its mode to
        // 0644. Admission never permits chmod, creation, or alternate contents.
        if stamp.owner != uid || stamp.links != 1 || stamp.mode & 0o7777 != 0o644 {
            return None;
        }
        let hash = identity_hash(&file)?;
        let identity = Self {
            path,
            file,
            stamp,
            hash,
        };
        identity.unchanged().then_some(identity)
    }

    fn unchanged(&self) -> bool {
        fs::symlink_metadata(&self.path)
            .ok()
            .as_ref()
            .map(Stamp::from)
            .as_ref()
            == Some(&self.stamp)
            && self.file.metadata().ok().as_ref().map(Stamp::from).as_ref() == Some(&self.stamp)
            && identity_hash(&self.file) == Some(self.hash)
    }
}

fn identity_hash(file: &File) -> Option<[u8; 32]> {
    let mut bytes = [0u8; 65];
    let count = file.read_at(&mut bytes, 0).ok()?;
    let contents = bytes.get(..count)?;
    let identity = contents.strip_suffix(b"\n").unwrap_or(contents);
    let identity = identity.strip_suffix(b"\r").unwrap_or(identity);
    if identity.len() != 36
        || !identity.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
    {
        return None;
    }
    Some(Sha256::digest(contents).into())
}

pub(super) struct Launch {
    pub(super) command: Option<Command>,
    pub(super) cwd: PathBuf,
    _scratch: tempfile::TempDir,
    identity: Identity,
    arg0: PathBuf,
    arg0_stamp: Stamp,
    arg0_entries: BTreeMap<PathBuf, Stamp>,
    uid: u32,
    native: PathBuf,
    native_stamp: Stamp,
}

impl Launch {
    pub(super) fn unchanged(&self) -> bool {
        self.identity.unchanged()
            && directory(&self.arg0, self.uid).ok().as_ref() == Some(&self.arg0_stamp)
            && arg0_entries(&self.arg0, self.uid).ok().as_ref() == Some(&self.arg0_entries)
            && regular(&self.native)
                .and_then(|file| file.metadata().ok())
                .as_ref()
                .map(Stamp::from)
                .as_ref()
                == Some(&self.native_stamp)
    }
}

pub(super) fn available() -> bool {
    regular(Path::new(SANDBOX_EXEC))
        .and_then(|file| file.metadata().ok())
        .is_some_and(|metadata| {
            metadata.uid() == 0
                && metadata.mode() & 0o6022 == 0
                && crate::process_platform::executable(Path::new(SANDBOX_EXEC))
        })
}

pub(super) fn launch(row: &AgentRow) -> Result<Launch> {
    if !available() {
        return Err(Code::PlatformUnsupported.into());
    }
    extension_inventory::launch::admission(row)?;
    let environment = crate::shell_env::cached_command_env().ok_or(Code::EnvironmentUnavailable)?;
    let mut effective: HashMap<_, _> = std::env::vars_os().collect();
    effective.extend(
        environment
            .into_iter()
            .map(|(key, value)| (key.into(), value.into())),
    );
    effective.extend(
        row.env
            .iter()
            .cloned()
            .map(|(key, value)| (key.into(), value.into())),
    );
    if effective.iter().any(|(key, value)| {
        (!value.is_empty() && key.as_encoded_bytes().starts_with(b"DYLD_"))
            || value == OsStr::new(crate::auth::KEYCHAIN_MARKER)
    }) {
        return Err(Code::EnvironmentUnavailable.into());
    }
    let uid = unsafe { libc::geteuid() };
    let original = original_home(&effective, uid)?;
    let identity = Identity::capture(original.join("installation_id"), uid)
        .ok_or(Code::ConfigurationReadOnly)?;

    // Keep the executable selected by the reviewed registration. The direct
    // native entry avoids executing Node or an environment wrapper inside the
    // isolated process. Neither package nor executable is version- or SHA-pinned.
    let native = native_program(row, effective.get(OsStr::new("CODEX_PATH")).map(Path::new))
        .filter(|path| !path.starts_with(&original))
        .ok_or(Code::EntryUnverified)?;
    let native_stamp = regular(&native)
        .and_then(|file| file.metadata().ok())
        .filter(|metadata| {
            (metadata.uid() == uid || metadata.uid() == 0)
                && metadata.mode() & 0o6022 == 0
                && crate::process_platform::executable(&native)
        })
        .as_ref()
        .map(Stamp::from)
        .ok_or(Code::EntryUnverified)?;

    directory(&original.join("tmp"), uid)?;
    let arg0 = original.join("tmp/arg0-macos");
    let arg0_stamp = directory(&arg0, uid)?;
    if arg0_stamp.mode & 0o7777 != 0o700 {
        return Err(Code::ConfigurationReadOnly.into());
    }
    let arg0_entries = arg0_entries(&arg0, uid)?;

    let tmp = std::env::temp_dir()
        .canonicalize()
        .map_err(|_| Code::CwdUnavailable)?;
    if tmp.starts_with(&original) {
        return Err(Code::CwdUnavailable.into());
    }
    let scratch = tempfile::Builder::new()
        .prefix("farfold-codex-preparation-")
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir_in(tmp)
        .map_err(|_| Code::CwdUnavailable)?;
    let root = scratch.path();
    if directory(root, uid)?.mode & 0o7777 != 0o700 {
        return Err(Code::CwdUnavailable.into());
    }
    let cwd = scratch_child(root, "work")?;
    let log = scratch_child(root, "log")?;
    let sqlite = scratch_child(root, "sqlite")?;
    let runtime_tmp = scratch_child(root, "tmp")?;
    let profile = root.join("offline.sb");
    let policy = policy(&original, &native, root, &arg0, &arg0_entries, uid)?;
    fs::write(&profile, policy).map_err(|_| Code::CwdUnavailable)?;

    let mut command = Command::new(SANDBOX_EXEC);
    command
        .arg("-f")
        .arg(profile)
        .arg(&native)
        .current_dir(&cwd)
        .envs(effective);
    command
        .env("TMPDIR", runtime_tmp)
        .env("RUST_LOG", "off")
        .env("CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED", "1")
        .env("CODEX_SQLITE_HOME", &sqlite);
    for name in [
        "SSH_AUTH_SOCK",
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
        .arg(format!("log_dir={}", quote(&log)?))
        .arg("-c")
        .arg(format!("sqlite_home={}", quote(&sqlite)?));
    for option in [
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
    prevent_inherited_connections(&mut command)?;
    let launch = Launch {
        command: Some(command),
        cwd,
        _scratch: scratch,
        identity,
        arg0,
        arg0_stamp,
        arg0_entries,
        uid,
        native,
        native_stamp,
    };
    if !launch.unchanged() {
        return Err(Code::ConfigurationChanged.into());
    }
    Ok(launch)
}

fn prevent_inherited_connections(command: &mut Command) -> Result<()> {
    const SCAN_MAX: libc::c_int = 1_048_576;
    let mut limits = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    let mut system_limit: libc::c_int = 0;
    let mut system_limit_size = std::mem::size_of_val(&system_limit);
    // A preexisting live socket could otherwise bypass a connect-time deny.
    // In the child before exec, mark all non-stdio descriptors close-on-exec.
    if unsafe {
        libc::getrlimit(libc::RLIMIT_NOFILE, &mut limits) != 0
            || libc::sysctlbyname(
                c"kern.maxfilesperproc".as_ptr(),
                std::ptr::from_mut(&mut system_limit).cast(),
                &mut system_limit_size,
                std::ptr::null_mut(),
                0,
            ) != 0
    } || limits.rlim_cur > SCAN_MAX as libc::rlim_t
        || !(3..=SCAN_MAX).contains(&system_limit)
    {
        return Err(Code::PlatformUnsupported.into());
    }
    unsafe {
        command.pre_exec(move || {
            for fd in 3..=SCAN_MAX {
                let flags = libc::fcntl(fd, libc::F_GETFD);
                if flags >= 0
                    && flags & libc::FD_CLOEXEC == 0
                    && libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) == -1
                {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    Ok(())
}

fn original_home(
    environment: &HashMap<std::ffi::OsString, std::ffi::OsString>,
    uid: u32,
) -> Result<PathBuf> {
    let home = environment
        .get(OsStr::new("HOME"))
        .map(PathBuf::from)
        .ok_or(Code::EnvironmentUnavailable)?;
    directory(&home, uid)?;
    let original = environment
        .get(OsStr::new("CODEX_HOME"))
        .map_or_else(|| home.join(".codex"), PathBuf::from);
    if original == home || !original.starts_with(&home) {
        return Err(Code::EnvironmentUnavailable.into());
    }
    directory(&original, uid)?;
    Ok(original)
}

fn native_program(row: &AgentRow, override_path: Option<&Path>) -> Option<PathBuf> {
    if let Some(path) = override_path {
        if !path.is_absolute() {
            return None;
        }
        let selected = path.canonicalize().ok()?;
        if let Some(package) = selected.ancestors().find(|dir| dir.ends_with(PLATFORM.0)) {
            return native_from_package(package).filter(|native| native == &selected);
        }
        let wrapper = selected.parent()?.parent()?;
        if !wrapper.ends_with(CLI_NPM) || selected != wrapper.join("bin/codex.js") {
            return None;
        }
        return native_from_wrapper(wrapper);
    }
    let entry = Path::new(row.args.first()?).canonicalize().ok()?;
    let package = entry.ancestors().find(|path| path.ends_with(ADAPTER_NPM))?;
    let modules = package.parent()?.parent()?;
    let wrapper = package.join("node_modules").join(CLI_NPM);
    if wrapper.symlink_metadata().is_ok() {
        native_from_wrapper(&wrapper)
    } else {
        native_from_wrapper(&modules.join(CLI_NPM))
    }
}

fn native_from_wrapper(wrapper: &Path) -> Option<PathBuf> {
    if !package_named(wrapper, &[CLI_NPM]) || regular(&wrapper.join("bin/codex.js")).is_none() {
        return None;
    }
    let nested = wrapper.join("node_modules").join(PLATFORM.0);
    let hoisted = wrapper.parent()?.parent()?.join(PLATFORM.0);
    if nested.symlink_metadata().is_ok() {
        native_from_package(&nested)
    } else if hoisted.symlink_metadata().is_ok() {
        native_from_package(&hoisted)
    } else {
        native_bundle(wrapper)
    }
}

fn native_from_package(package: &Path) -> Option<PathBuf> {
    package_named(package, &[CLI_NPM, PLATFORM.0])
        .then(|| native_bundle(package))
        .flatten()
}

fn native_bundle(package: &Path) -> Option<PathBuf> {
    let binary = package.join("vendor").join(PLATFORM.1).join("bin/codex");
    regular(&binary)?;
    Some(binary)
}

fn package_named(package: &Path, names: &[&str]) -> bool {
    let Some(file) = regular(&package.join("package.json")) else {
        return false;
    };
    let mut bytes = Vec::new();
    if file.take(65_537).read_to_end(&mut bytes).is_err() || bytes.len() > 65_536 {
        return false;
    }
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|manifest| {
            manifest
                .get("name")?
                .as_str()
                .map(|name| names.contains(&name))
        })
        == Some(true)
}

fn regular(path: &Path) -> Option<File> {
    if !path.is_absolute() || path.canonicalize().ok()? != path {
        return None;
    }
    let file = File::options()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .ok()?;
    let metadata = file.metadata().ok()?;
    (metadata.is_file() && Stamp::from(&metadata) == Stamp::from(&path.symlink_metadata().ok()?))
        .then_some(file)
}

fn directory(path: &Path, uid: u32) -> Result<Stamp> {
    let metadata = path
        .symlink_metadata()
        .map_err(|_| Code::ConfigurationReadOnly)?;
    if !metadata.is_dir()
        || metadata.uid() != uid
        || metadata.mode() & 0o022 != 0
        || path.canonicalize().as_deref().ok() != Some(path)
    {
        return Err(Code::ConfigurationReadOnly.into());
    }
    Ok(Stamp::from(&metadata))
}

fn arg0_entries(path: &Path, uid: u32) -> Result<BTreeMap<PathBuf, Stamp>> {
    let mut entries = BTreeMap::new();
    for entry in fs::read_dir(path).map_err(|_| Code::ConfigurationReadOnly)? {
        let path = entry.map_err(|_| Code::ConfigurationReadOnly)?.path();
        if entries.len() >= MAX_ARG0_ENTRIES {
            return Err(Code::ConfigurationReadOnly.into());
        }
        entries.insert(path.clone(), directory(&path, uid)?);
    }
    Ok(entries)
}

fn scratch_child(root: &Path, name: &str) -> Result<PathBuf> {
    let result = root.join(name);
    DirBuilder::new()
        .mode(0o700)
        .create(&result)
        .map_err(|_| Code::CwdUnavailable)?;
    Ok(result)
}

fn policy(
    original: &Path,
    native: &Path,
    scratch: &Path,
    arg0: &Path,
    preexisting: &BTreeMap<PathBuf, Stamp>,
    uid: u32,
) -> Result<String> {
    let mut lines = vec![
        "(version 1)".into(), "(allow default)".into(), "(deny network*)".into(),
        "(deny file-read*)".into(), "(deny file-write*)".into(), "(deny process-exec)".into(),
        "(deny process-fork)".into(),
        "(deny mach-lookup)".into(), "(deny appleevent-send)".into(),
        "(deny user-preference-read user-preference-write)".into(),
        "(allow user-preference-read (preference-domain \"com.openai.codex\"))".into(),
        "(allow mach-lookup (global-name \"com.apple.cfprefsd.agent\") (global-name \"com.apple.cfprefsd.daemon\"))".into(),
        "(allow sysctl-read)".into(), "(allow system-info (info-type \"vfs.disk-space\"))".into(),
        "(allow file-read* (require-all (subpath \"/System\") (require-not (subpath \"/System/Volumes\"))) (subpath \"/usr/lib\") (subpath \"/usr/share\") (subpath \"/private/etc\") (subpath \"/private/var/db/timezone\") (literal \"/\") (literal \"/dev/null\") (literal \"/dev/random\") (literal \"/dev/urandom\"))".into(),
        format!("(allow process-exec file-read* (literal {}))", quote(native)?),
        format!("(allow file-read* (subpath {}) (subpath {}))", quote(scratch)?, quote(arg0)?),
        format!("(allow file-write* (subpath {}))", quote(scratch)?),
        // The vendor reasserts the already verified 0700 mode and uses a new
        // randomly named helper directory. No preexisting child is writable.
        format!("(allow file-write-mode (literal {}))", quote(arg0)?),
        // Seatbelt cannot distinguish an O_RDWR open from a later data write at
        // this exact pathname. The vendor's valid UUID branch only reads and
        // locks. We verify the same file, mode and bytes again after exit.
        format!("(allow file-write-data (literal {}))", quote(&original.join("installation_id"))?),
    ];
    let root = arg0
        .to_str()
        .filter(|text| {
            text.bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"/ ._-".contains(&c))
        })
        .ok_or(Code::ConfigurationReadOnly)?
        .replace('.', "[.]");
    lines.push(format!(
        "(allow file-write* (regex #\"^{root}/codex-arg0{}(/.*)?$\"))",
        "[A-Za-z0-9]".repeat(6)
    ));
    for path in preexisting.keys() {
        lines.push(format!("(deny file-write* (subpath {}))", quote(path)?));
    }
    let migration = original.join(".sandbox_migration");
    for path in [
        original.join("sessions"),
        original.join("archived_sessions"),
    ] {
        lines.push(format!(
            "(deny file-read* file-write* (subpath {}))",
            quote(&path)?
        ));
    }
    for name in [
        "config.toml",
        "requirements.toml",
        "auth.json",
        "models_cache.json",
        "installation_id",
    ] {
        let path = original.join(name);
        if path.symlink_metadata().is_ok() && regular(&path).is_none() {
            return Err(Code::ConfigurationReadOnly.into());
        }
        lines.push(format!("(allow file-read* (literal {}))", quote(&path)?));
    }
    // Executable lookup and config walkers may stat intermediate directories;
    // only these exact ancestors get metadata, never file contents.
    for path in [
        original,
        native,
        scratch,
        arg0,
        Path::new("/usr/bin"),
        Path::new("/System/Volumes/Data"),
        Path::new("/Library"),
        Path::new("/etc"),
        Path::new("/tmp"),
        Path::new("/var"),
        &migration,
    ]
    .into_iter()
    .flat_map(Path::ancestors)
    {
        lines.push(format!(
            "(allow file-read-metadata (literal {}))",
            quote(path)?
        ));
    }
    let rules = original.join("rules");
    if rules.symlink_metadata().is_ok() {
        directory(&rules, uid)?;
        lines.push(format!("(allow file-read* (literal {}))", quote(&rules)?));
        for (index, entry) in fs::read_dir(&rules)
            .map_err(|_| Code::ConfigurationReadOnly)?
            .enumerate()
        {
            let path = entry.map_err(|_| Code::ConfigurationReadOnly)?.path();
            if index >= 32
                || path.extension() != Some(OsStr::new("rules"))
                || regular(&path).is_none()
            {
                return Err(Code::ConfigurationReadOnly.into());
            }
            lines.push(format!("(allow file-read* (literal {}))", quote(&path)?));
        }
    }
    Ok(lines.join("\n"))
}

fn quote(path: &Path) -> Result<String> {
    let text = path
        .to_str()
        .filter(|text| !text.chars().any(char::is_control))
        .ok_or(Code::InvalidExecutablePath)?;
    serde_json::to_string(text).map_err(|_| Code::InvalidExecutablePath.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installation_identity_rejects_replacement_and_protected_modes() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().canonicalize().unwrap().join("installation_id");
        let original = b"81234567-1234-1234-1234-0123456789ab\n";
        fs::write(&path, original).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let uid = fs::metadata(&path).unwrap().uid();
        assert!(Identity::capture(path.clone(), uid).is_none());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let first = Identity::capture(path.clone(), uid).unwrap();
        assert!(first.unchanged());
        let replacement = path.with_extension("replacement");
        fs::write(&replacement, original).unwrap();
        fs::set_permissions(&replacement, fs::Permissions::from_mode(0o644)).unwrap();
        fs::rename(replacement, &path).unwrap();
        assert!(!first.unchanged());
    }

    #[test]
    fn policy_denies_network_and_old_state_with_narrow_startup_exceptions() {
        let root = tempfile::tempdir().unwrap();
        let work = root.path().canonicalize().unwrap();
        let original = work.join("original");
        let arg0 = original.join("tmp/arg0-macos");
        let old = arg0.join("codex-arg0aB9dFs");
        let uid = fs::metadata(&work).unwrap().uid();
        let preexisting =
            BTreeMap::from([(old.clone(), Stamp::from(&fs::metadata(&work).unwrap()))]);
        let value = policy(
            &original,
            &work.join("native"),
            &work.join("scratch"),
            &arg0,
            &preexisting,
            uid,
        )
        .unwrap();
        assert_eq!(
            value
                .lines()
                .filter(|line| line.contains("network"))
                .collect::<Vec<_>>(),
            ["(deny network*)"]
        );
        assert!(value.contains("(deny process-fork)"));
        assert!(value.contains(&format!(
            "(deny file-write* (subpath {}))",
            quote(&old).unwrap()
        )));
        for name in ["sessions", "archived_sessions"] {
            assert!(value.contains(&format!(
                "(deny file-read* file-write* (subpath {}))",
                quote(&original.join(name)).unwrap()
            )));
        }
        let identity = quote(&original.join("installation_id")).unwrap();
        assert_eq!(
            value
                .lines()
                .filter(|line| line.starts_with("(allow file-write") && line.contains(&identity))
                .collect::<Vec<_>>(),
            [format!("(allow file-write-data (literal {identity}))")]
        );
    }
}
