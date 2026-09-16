use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    ffi::CString,
    fs::{File, Metadata, OpenOptions},
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt},
            process::{CommandExt, ExitStatusExt},
        },
    },
    path::{Component, Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::Duration,
};

const MAX_TEXT: usize = 64 * 1024;
const MAX_TERMINALS: usize = 8;
static NEXT_FILE: AtomicU64 = AtomicU64::new(1);

// One instance belongs to one ACP connection. No global Runtime state or
// credentials are used; session activation and connection shutdown revoke it.
pub(crate) struct AcpClientResources {
    root: PathBuf,
    directory: File,
    state: Mutex<ResourceState>,
    next_terminal: AtomicU64,
}

#[derive(Default)]
struct ResourceState {
    session: Option<String>,
    closed: bool,
    reads: HashMap<PathBuf, FileVersion>,
    terminals: HashMap<String, Arc<Terminal>>,
}

#[derive(Clone, PartialEq, Eq)]
struct FileVersion(u64, u64, u64, i64, i64, i64, i64);

impl FileVersion {
    fn of(value: &Metadata) -> Self {
        Self(
            value.dev(),
            value.ino(),
            value.len(),
            value.mtime(),
            value.mtime_nsec(),
            value.ctime(),
            value.ctime_nsec(),
        )
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileRequest {
    session_id: String,
    path: PathBuf,
    content: Option<String>,
    line: Option<usize>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct EnvironmentVariable {
    name: String,
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalRequest {
    session_id: String,
    terminal_id: Option<String>,
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: Vec<EnvironmentVariable>,
    cwd: Option<PathBuf>,
    output_byte_limit: Option<usize>,
}

impl AcpClientResources {
    pub(crate) fn new(root: &Path) -> Result<Self, String> {
        let root = root
            .canonicalize()
            .map_err(|_| "ACP Working Copy is unavailable")?;
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&root)
            .map_err(|_| "Cannot open ACP Working Copy")?;
        Ok(Self {
            root,
            directory,
            state: Mutex::new(ResourceState::default()),
            next_terminal: AtomicU64::new(1),
        })
    }

    pub(crate) fn supports(method: &str) -> bool {
        matches!(
            method,
            "fs/read_text_file"
                | "fs/write_text_file"
                | "terminal/create"
                | "terminal/output"
                | "terminal/wait_for_exit"
                | "terminal/kill"
                | "terminal/release"
        )
    }

    pub(crate) fn bind(&self, session: Option<&str>) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "ACP resources are unavailable")?;
        if state.closed {
            return Err("ACP resources have been revoked".into());
        }
        if state.session.as_deref() != session {
            for (_, terminal) in state.terminals.drain() {
                terminal.release();
            }
            state.reads.clear();
            state.session = session.map(str::to_owned);
        }
        Ok(())
    }

    pub(crate) fn shutdown(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
            state.session = None;
            for (_, terminal) in state.terminals.drain() {
                terminal.release();
            }
            state.reads.clear();
        }
    }

    pub(crate) fn has_live_terminals(&self) -> Result<bool, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "ACP resources are unavailable")?;
        for terminal in state.terminals.values() {
            if terminal.status()?.is_none() {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn require_session(state: &ResourceState, session: &str) -> Result<(), String> {
        if state.closed || state.session.as_deref() != Some(session) {
            return Err("ACP resource request does not belong to the active session".into());
        }
        Ok(())
    }

    fn relative(&self, path: &Path) -> Result<PathBuf, String> {
        if !path.is_absolute() || path.as_os_str().len() > 16 * 1024 {
            return Err("ACP file paths must be absolute".into());
        }
        let relative = path
            .strip_prefix(&self.root)
            .map_err(|_| "Path is outside the ACP Working Copy")?;
        if relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err("ACP paths cannot traverse parent directories".into());
        }
        Ok(relative.to_path_buf())
    }

    fn parent(&self, relative: &Path) -> Result<(File, CString), String> {
        let name = relative.file_name().ok_or("ACP requires a file path")?;
        let mut parent = self
            .directory
            .try_clone()
            .map_err(|_| "Cannot open Working Copy descriptor")?;
        for component in relative.parent().unwrap_or(Path::new("")).components() {
            parent = open_at(
                &parent,
                component.as_os_str(),
                libc::O_RDONLY | libc::O_DIRECTORY,
                0,
            )?;
        }
        let name = CString::new(name.as_bytes()).map_err(|_| "Invalid ACP filename")?;
        Ok((parent, name))
    }

    fn file(&self, method: &str, params: Value) -> Result<Value, String> {
        let input: FileRequest =
            serde_json::from_value(params).map_err(|_| "Invalid ACP file request")?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "ACP resources are unavailable")?;
        Self::require_session(&state, &input.session_id)?;
        let relative = self.relative(&input.path)?;
        let (parent, name) = self.parent(&relative)?;
        if method == "fs/read_text_file" {
            if state.reads.len() >= 256 && !state.reads.contains_key(&relative) {
                return Err("ACP read revision limit reached for this session".into());
            }
            let file = open_at(
                &parent,
                relative.file_name().unwrap(),
                libc::O_RDONLY | libc::O_NONBLOCK,
                0,
            )?;
            let metadata = file.metadata().map_err(|_| "Cannot inspect ACP file")?;
            if !metadata.is_file() || metadata.len() > MAX_TEXT as u64 {
                return Err("ACP file is not a supported small text file".into());
            }
            let mut bytes = Vec::new();
            file.take((MAX_TEXT + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|_| "Cannot read ACP file")?;
            if bytes.len() > MAX_TEXT || bytes.contains(&0) {
                return Err("ACP file is binary or exceeds the text limit".into());
            }
            let text = String::from_utf8(bytes).map_err(|_| "ACP file is not UTF-8 text")?;
            let first = input.line.unwrap_or(1);
            if first == 0 {
                return Err("ACP line numbers start at 1".into());
            }
            let content: String = text
                .split_inclusive('\n')
                .skip(first - 1)
                .take(input.limit.unwrap_or(usize::MAX))
                .collect();
            state.reads.insert(relative, FileVersion::of(&metadata));
            return Ok(json!({"content":content}));
        }
        let content = input.content.ok_or("ACP write requires content")?;
        if content.len() > MAX_TEXT || content.contains('\0') {
            return Err("ACP write exceeds the text limit or contains binary data".into());
        }
        let existing = match open_at(
            &parent,
            relative.file_name().unwrap(),
            libc::O_RDONLY | libc::O_NONBLOCK,
            0,
        ) {
            Ok(file) => {
                let metadata = file
                    .metadata()
                    .map_err(|_| "Cannot inspect ACP write target")?;
                if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() > MAX_TEXT as u64
                {
                    return Err("ACP write target is not a supported single-link text file".into());
                }
                let mut bytes = Vec::new();
                file.take((MAX_TEXT + 1) as u64)
                    .read_to_end(&mut bytes)
                    .map_err(|_| "Cannot inspect ACP write target")?;
                if bytes.len() > MAX_TEXT
                    || bytes.contains(&0)
                    || std::str::from_utf8(&bytes).is_err()
                {
                    return Err("ACP write target is binary or exceeds the text limit".into());
                }
                Some(metadata)
            }
            Err(_) => {
                let mut stat: libc::stat = unsafe { std::mem::zeroed() };
                let result = unsafe {
                    libc::fstatat(
                        parent.as_raw_fd(),
                        name.as_ptr(),
                        &mut stat,
                        libc::AT_SYMLINK_NOFOLLOW,
                    )
                };
                if result == 0
                    || std::io::Error::last_os_error().kind() != std::io::ErrorKind::NotFound
                {
                    return Err("ACP write target is inaccessible or a symbolic link".into());
                }
                None
            }
        };
        if state
            .reads
            .get(&relative)
            .is_some_and(|version| existing.as_ref().map(FileVersion::of).as_ref() != Some(version))
        {
            return Err(
                "File changed since this session read it; read the current file before writing"
                    .into(),
            );
        }
        let temporary = format!(
            ".farfold-acp-write-{}-{}",
            std::process::id(),
            NEXT_FILE.fetch_add(1, Ordering::Relaxed)
        );
        let temporary_name = CString::new(temporary.as_bytes()).unwrap();
        let mut file = open_at(
            &parent,
            std::ffi::OsStr::new(&temporary),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            existing.as_ref().map_or(0o600, |m| m.mode() & 0o777),
        )?;
        let result = (|| {
            file.write_all(content.as_bytes())
                .and_then(|()| file.sync_all())
                .map_err(|_| "Cannot write ACP text file")?;
            if unsafe {
                libc::renameat(
                    parent.as_raw_fd(),
                    temporary_name.as_ptr(),
                    parent.as_raw_fd(),
                    name.as_ptr(),
                )
            } != 0
            {
                return Err("Cannot commit ACP text file".to_string());
            }
            state.reads.remove(&relative);
            Ok(json!({}))
        })();
        if result.is_err() {
            unsafe {
                libc::unlinkat(parent.as_raw_fd(), temporary_name.as_ptr(), 0);
            }
        }
        result
    }

    pub(crate) fn handle(&self, method: &str, params: Value) -> Result<Value, String> {
        if method.starts_with("fs/") {
            return self.file(method, params);
        }
        let input: TerminalRequest =
            serde_json::from_value(params).map_err(|_| "Invalid ACP terminal request")?;
        let terminal = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "ACP resources are unavailable")?;
            Self::require_session(&state, &input.session_id)?;
            if method == "terminal/create" {
                if state.terminals.len() >= MAX_TERMINALS {
                    return Err("ACP terminal limit reached; release an existing terminal".into());
                }
                let cwd = input.cwd.as_deref().unwrap_or(&self.root);
                let relative = self.relative(cwd)?;
                let mut directory = self
                    .directory
                    .try_clone()
                    .map_err(|_| "Cannot open terminal Working Copy")?;
                for component in relative.components() {
                    directory = open_at(
                        &directory,
                        component.as_os_str(),
                        libc::O_RDONLY | libc::O_DIRECTORY,
                        0,
                    )?;
                }
                let terminal = Arc::new(Terminal::spawn(input, directory)?);
                let id = format!(
                    "terminal-{}",
                    self.next_terminal.fetch_add(1, Ordering::Relaxed)
                );
                state.terminals.insert(id.clone(), terminal);
                return Ok(json!({"terminalId":id}));
            }
            let id = input
                .terminal_id
                .as_deref()
                .ok_or("Missing ACP terminal id")?;
            let terminal = state
                .terminals
                .get(id)
                .cloned()
                .ok_or("ACP terminal is unavailable or released")?;
            if method == "terminal/release" {
                state.terminals.remove(id);
            }
            terminal
        };
        match method {
            "terminal/output" => terminal.output(),
            "terminal/wait_for_exit" => terminal.wait(),
            "terminal/kill" => {
                terminal.kill();
                Ok(json!({}))
            }
            "terminal/release" => {
                terminal.release();
                Ok(json!({}))
            }
            _ => Err("Unsupported ACP resource method".into()),
        }
    }
}

impl Drop for AcpClientResources {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn open_at(parent: &File, name: &std::ffi::OsStr, flags: i32, mode: u32) -> Result<File, String> {
    let name = CString::new(name.as_bytes()).map_err(|_| "Invalid ACP path")?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            mode as libc::c_uint,
        )
    };
    if fd < 0 {
        return Err("Cannot open ACP path without following symbolic links".into());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

struct Output {
    bytes: Vec<u8>,
    truncated: bool,
    readers: usize,
    failed: bool,
}
struct Terminal {
    child: Mutex<Child>,
    output: Arc<Mutex<Output>>,
    group: libc::pid_t,
    killed: AtomicBool,
    released: AtomicBool,
    limit: usize,
}

impl Terminal {
    fn spawn(input: TerminalRequest, directory: File) -> Result<Self, String> {
        let command = input
            .command
            .filter(|value| !value.is_empty())
            .ok_or("ACP terminal requires a command")?;
        if input.args.len() > 256 || input.env.len() > 128 {
            return Err("ACP terminal request exceeds limits".into());
        }
        let mut process = Command::new(command);
        process
            .args(input.args)
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        for variable in input.env {
            if variable.name.is_empty()
                || variable.name.contains(['=', '\0'])
                || variable.value.contains('\0')
            {
                return Err("Invalid ACP terminal environment".into());
            }
            process.env(variable.name, variable.value);
        }
        // fchdir uses the validated directory descriptor, not a path that can be
        // replaced by a symlink between validation and spawning.
        unsafe {
            process.pre_exec(move || {
                if libc::fchdir(directory.as_raw_fd()) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = process
            .spawn()
            .map_err(|_| "Cannot start ACP terminal command")?;
        let group = child.id() as libc::pid_t;
        let output = Arc::new(Mutex::new(Output {
            bytes: Vec::new(),
            truncated: false,
            readers: 2,
            failed: false,
        }));
        let limit = input.output_byte_limit.unwrap_or(MAX_TEXT).min(MAX_TEXT);
        let pipes: [Box<dyn Read + Send>; 2] = [
            Box::new(child.stdout.take().unwrap()),
            Box::new(child.stderr.take().unwrap()),
        ];
        for mut pipe in pipes {
            let output = output.clone();
            if thread::Builder::new()
                .name("acp-terminal-output".into())
                .spawn(move || {
                    let mut buffer = [0u8; 4096];
                    loop {
                        match pipe.read(&mut buffer) {
                            Ok(0) => break,
                            Ok(count) => {
                                let Ok(mut output) = output.lock() else {
                                    return;
                                };
                                output.bytes.extend_from_slice(&buffer[..count]);
                                if output.bytes.len() > limit {
                                    let excess = output.bytes.len() - limit;
                                    output.bytes.drain(..excess);
                                    output.truncated = true;
                                }
                            }
                            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                                continue;
                            }
                            Err(_) => {
                                if let Ok(mut output) = output.lock() {
                                    output.failed = true;
                                }
                                break;
                            }
                        }
                    }
                    if let Ok(mut output) = output.lock() {
                        output.readers = output.readers.saturating_sub(1);
                    }
                })
                .is_err()
            {
                unsafe {
                    libc::kill(-group, libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
                return Err("Cannot capture ACP terminal output".into());
            }
        }
        Ok(Self {
            child: Mutex::new(child),
            output,
            group,
            killed: AtomicBool::new(false),
            released: AtomicBool::new(false),
            limit,
        })
    }

    fn kill(&self) {
        if !self.killed.swap(true, Ordering::AcqRel) {
            unsafe {
                libc::kill(-self.group, libc::SIGKILL);
            }
        }
    }

    fn release(&self) {
        self.released.store(true, Ordering::Release);
        self.kill();
        if let Ok(mut child) = self.child.lock() {
            let _ = child.wait();
        }
    }

    fn status(&self) -> Result<Option<ExitStatus>, String> {
        let result = self
            .child
            .lock()
            .map_err(|_| "ACP terminal state is unavailable")?
            .try_wait()
            .map_err(|_| "Cannot inspect ACP terminal exit")?;
        if result.is_some() {
            self.kill();
        }
        Ok(result)
    }

    fn output(&self) -> Result<Value, String> {
        if self.released.load(Ordering::Acquire) {
            return Err("ACP terminal has been released".into());
        }
        let status = self.status()?;
        let output = self
            .output
            .lock()
            .map_err(|_| "ACP terminal output unavailable")?;
        if output.failed {
            return Err("ACP terminal output read failed; output may be incomplete".into());
        }
        let mut bytes = output.bytes.as_slice();
        if output.truncated {
            while bytes.first().is_some_and(|byte| byte & 0xc0 == 0x80) {
                bytes = &bytes[1..];
            }
        }
        let text = String::from_utf8_lossy(bytes);
        let mut start = text.len().saturating_sub(self.limit);
        while !text.is_char_boundary(start) {
            start += 1;
        }
        Ok(
            json!({"output":&text[start..],"truncated":output.truncated || start > 0,"exitStatus":if output.readers == 0 { status.map(exit_status) } else { None }}),
        )
    }

    fn wait(&self) -> Result<Value, String> {
        loop {
            if self.released.load(Ordering::Acquire) {
                return Err("ACP terminal was released while waiting".into());
            }
            if let Some(status) = self.status()?
                && self
                    .output
                    .lock()
                    .map_err(|_| "ACP terminal output unavailable")?
                    .readers
                    == 0
            {
                return Ok(exit_status(status));
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        self.release();
    }
}

fn exit_status(status: ExitStatus) -> Value {
    json!({"exitCode":status.code(),"signal":status.signal().map(|value| value.to_string())})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, AcpClientResources) {
        let directory = tempfile::tempdir().unwrap();
        let resources = AcpClientResources::new(directory.path()).unwrap();
        resources.bind(Some("session")).unwrap();
        (directory, resources)
    }

    #[test]
    fn text_files_are_scoped_bounded_and_protect_external_edits() {
        let (_directory, resources) = fixture();
        let path = resources.root.join("file.txt");
        resources
            .handle(
                "fs/write_text_file",
                json!({"sessionId":"session","path":path,"content":"one\ntwo\n"}),
            )
            .unwrap();
        assert_eq!(
            resources
                .handle(
                    "fs/read_text_file",
                    json!({"sessionId":"session","path":path,"line":2,"limit":1})
                )
                .unwrap()["content"],
            "two\n"
        );
        std::fs::write(&path, "external edit\n").unwrap();
        assert!(
            resources
                .handle(
                    "fs/write_text_file",
                    json!({"sessionId":"session","path":path,"content":"stale"})
                )
                .unwrap_err()
                .contains("changed")
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "external edit\n");
        resources
            .handle(
                "fs/read_text_file",
                json!({"sessionId":"session","path":path}),
            )
            .unwrap();
        resources
            .handle(
                "fs/write_text_file",
                json!({"sessionId":"session","path":path,"content":"new\n"}),
            )
            .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new\n");
        assert!(
            resources
                .handle(
                    "fs/read_text_file",
                    json!({"sessionId":"other","path":path})
                )
                .is_err()
        );
        assert!(
            resources
                .handle(
                    "fs/read_text_file",
                    json!({"sessionId":"session","path":path,"line":0})
                )
                .is_err()
        );
        assert!(
            resources
                .handle(
                    "fs/read_text_file",
                    json!({"sessionId":"session","path":resources.root.join("../outside")})
                )
                .is_err()
        );
    }

    #[test]
    fn symbolic_links_binary_large_and_hardlink_targets_are_not_written() {
        let (_directory, resources) = fixture();
        let outside = tempfile::tempdir().unwrap();
        let external = outside.path().join("keep");
        std::fs::write(&external, "keep").unwrap();
        std::os::unix::fs::symlink(&external, resources.root.join("link")).unwrap();
        std::os::unix::fs::symlink(outside.path(), resources.root.join("directory-link")).unwrap();
        std::fs::hard_link(&external, resources.root.join("hardlink")).unwrap();
        std::fs::write(resources.root.join("binary"), b"a\0b").unwrap();
        std::fs::write(resources.root.join("large"), vec![b'x'; MAX_TEXT + 1]).unwrap();
        for name in ["link", "directory-link/keep", "hardlink", "binary", "large"] {
            assert!(resources.handle("fs/write_text_file", json!({"sessionId":"session","path":resources.root.join(name),"content":"overwrite"})).is_err(), "{name}");
        }
        for name in ["link", "directory-link/keep", "binary", "large"] {
            assert!(
                resources
                    .handle(
                        "fs/read_text_file",
                        json!({"sessionId":"session","path":resources.root.join(name)})
                    )
                    .is_err(),
                "{name}"
            );
        }
        assert_eq!(std::fs::read_to_string(external).unwrap(), "keep");
        assert!(!std::fs::read_dir(&resources.root).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".farfold-acp-write")
        }));
    }

    #[test]
    fn terminal_output_is_bounded_waits_for_exit_and_release_revokes_it() {
        let (_directory, resources) = fixture();
        let created = resources.handle("terminal/create", json!({"sessionId":"session","command":"/bin/sh","args":["-c","printf 123456789; printf error >&2"],"outputByteLimit":6})).unwrap();
        let params = json!({"sessionId":"session","terminalId":created["terminalId"]});
        assert_eq!(
            resources
                .handle("terminal/wait_for_exit", params.clone())
                .unwrap()["exitCode"],
            0
        );
        let output = resources.handle("terminal/output", params.clone()).unwrap();
        assert_eq!(output["truncated"], true);
        assert!(output["output"].as_str().unwrap().len() <= 6);
        assert_eq!(output["exitStatus"]["exitCode"], 0);
        resources
            .handle("terminal/release", params.clone())
            .unwrap();
        assert!(resources.handle("terminal/output", params).is_err());
    }

    #[test]
    fn terminal_kill_and_connection_shutdown_unblock_waiters() {
        let (_directory, resources) = fixture();
        let resources = Arc::new(resources);
        let created = resources
            .handle(
                "terminal/create",
                json!({"sessionId":"session","command":"/bin/sleep","args":["60"]}),
            )
            .unwrap();
        let params = json!({"sessionId":"session","terminalId":created["terminalId"]});
        resources.handle("terminal/kill", params.clone()).unwrap();
        assert!(resources.handle("terminal/wait_for_exit", params).unwrap()["signal"].is_string());
        let created = resources
            .handle(
                "terminal/create",
                json!({"sessionId":"session","command":"/bin/sleep","args":["60"]}),
            )
            .unwrap();
        let cloned = resources.clone();
        let waiter = thread::spawn(move || {
            cloned.handle(
                "terminal/wait_for_exit",
                json!({"sessionId":"session","terminalId":created["terminalId"]}),
            )
        });
        resources.shutdown();
        assert!(waiter.join().unwrap().is_err());
        assert!(resources.bind(Some("new")).is_err());
    }

    #[test]
    fn terminal_cwd_and_session_changes_do_not_cross_authorities() {
        let (_directory, resources) = fixture();
        assert!(
            resources
                .handle(
                    "terminal/create",
                    json!({"sessionId":"session","command":"/bin/pwd","cwd":"/tmp"})
                )
                .is_err()
        );
        let created = resources
            .handle(
                "terminal/create",
                json!({"sessionId":"session","command":"/bin/pwd"}),
            )
            .unwrap();
        let params = json!({"sessionId":"session","terminalId":created["terminalId"]});
        resources
            .handle("terminal/wait_for_exit", params.clone())
            .unwrap();
        assert_eq!(
            resources.handle("terminal/output", params.clone()).unwrap()["output"]
                .as_str()
                .unwrap()
                .trim(),
            resources.root.to_str().unwrap()
        );
        resources.bind(Some("new")).unwrap();
        assert!(resources.handle("terminal/output", params).is_err());
        assert!(
            resources
                .handle(
                    "terminal/output",
                    json!({"sessionId":"new","terminalId":created["terminalId"]})
                )
                .is_err()
        );
    }
}
