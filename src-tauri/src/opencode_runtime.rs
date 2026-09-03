use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::VecDeque,
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};

use crate::runtime_event_router::RuntimeEventRouter;
use crate::runtime_registry::{
    OPENCODE_RUNTIME, OPENCODE_RUNTIME_VERSION, RuntimeIdentity, opencode_identity,
    verify_managed_installation,
};
const OPENCODE_USERNAME: &str = "farfold";
const START_ATTEMPTS: usize = 3;
const START_TIMEOUT: Duration = Duration::from_secs(15);
const LOG_LIMIT: usize = 200;
const EVENT_LIMIT: usize = 1_000;

#[derive(Debug)]
enum OpenCodeLifecycle {
    Stopped,
    Starting {
        generation: u64,
        project_path: PathBuf,
    },
    Running(RunningOpenCode),
    Stopping {
        generation: u64,
        project_path: PathBuf,
    },
}

#[derive(Debug)]
struct RunningOpenCode {
    child: Child,
    generation: u64,
    project_path: PathBuf,
    endpoint: String,
    password: String,
    logs: SharedLogs,
}

type SharedLogs = Arc<Mutex<VecDeque<String>>>;
pub(crate) type SharedEvents = Arc<Mutex<VecDeque<Value>>>;

#[derive(Clone)]
pub(crate) struct OpenCodeConnection {
    pub(crate) endpoint: String,
    pub(crate) password: String,
    pub(crate) project_path: PathBuf,
    pub(crate) generation: u64,
    pub(crate) generation_clock: Arc<AtomicU64>,
}

pub struct OpenCodeRuntime {
    lifecycle: Mutex<OpenCodeLifecycle>,
    generation: Arc<AtomicU64>,
    events: SharedEvents,
}

impl Default for OpenCodeRuntime {
    fn default() -> Self {
        Self {
            lifecycle: Mutex::new(OpenCodeLifecycle::Stopped),
            generation: Arc::new(AtomicU64::new(0)),
            events: Arc::new(Mutex::new(VecDeque::new())),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OpenCodeRuntimePhase {
    Stopped,
    Starting,
    Running,
    Stopping,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeRuntimeStatus {
    state: OpenCodeRuntimePhase,
    running: bool,
    project_path: Option<PathBuf>,
    endpoint: Option<String>,
    generation: u64,
    version: &'static str,
}

impl OpenCodeRuntimeStatus {
    fn stopped(generation: u64) -> Self {
        Self {
            state: OpenCodeRuntimePhase::Stopped,
            running: false,
            project_path: None,
            endpoint: None,
            generation,
            version: OPENCODE_RUNTIME_VERSION,
        }
    }

    pub(crate) fn phase(&self) -> OpenCodeRuntimePhase {
        self.state
    }

    pub(crate) fn is_running(&self) -> bool {
        self.running
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeConnectionReadiness {
    runtime: RuntimeIdentity,
    phase: OpenCodeRuntimePhase,
    command_channel: &'static str,
    provider: &'static str,
    model: &'static str,
    account: &'static str,
    native_configuration: &'static str,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeStartOptions {
    project_path: String,
}

impl OpenCodeStartOptions {
    pub(crate) fn host_session(project_path: &Path) -> Self {
        Self {
            project_path: project_path.to_string_lossy().into_owned(),
        }
    }
}

fn prepare_directory(path: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(path).map_err(|error| {
        format!(
            "Cannot prepare OpenCode directory {}: {error}",
            path.display()
        )
    })?;
    path.canonicalize().map_err(|error| {
        format!(
            "Cannot resolve OpenCode directory {}: {error}",
            path.display()
        )
    })
}

fn launch_password() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("Cannot create OpenCode Server credential: {error}"))?;
    Ok(STANDARD.encode(bytes))
}

fn reserve_loopback_port() -> Result<(TcpListener, u16), String> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("Cannot reserve an OpenCode loopback port: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Cannot inspect the reserved OpenCode loopback port: {error}"))?
        .port();
    Ok((listener, port))
}

fn append_log(logs: &SharedLogs, line: String) {
    if let Ok(mut logs) = logs.lock() {
        if logs.len() == LOG_LIMIT {
            logs.pop_front();
        }
        logs.push_back(line);
    }
}

pub(crate) fn push_event(events: &SharedEvents, router: Option<&RuntimeEventRouter>, event: Value) {
    if let Ok(mut events) = events.lock() {
        if events.len() == EVENT_LIMIT {
            events.pop_front();
        }
        events.push_back(event.clone());
    }
    if let Some(router) = router {
        let _ = router.route(OPENCODE_RUNTIME, event);
    }
}

fn drain_output<R>(reader: R, stream: &'static str, logs: SharedLogs)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            match line {
                Ok(line) => append_log(&logs, format!("{stream}: {line}")),
                Err(error) => {
                    append_log(&logs, format!("{stream}: [read error: {error}]"));
                    break;
                }
            }
        }
    });
}

fn health_probe(port: u16, password: &str) -> Result<(), String> {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(250))
        .map_err(|error| format!("OpenCode health connection failed: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_millis(750)))
        .map_err(|error| format!("Cannot set OpenCode health timeout: {error}"))?;
    let credential = STANDARD.encode(format!("{OPENCODE_USERNAME}:{password}"));
    let request = format!(
        "GET /global/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Basic {credential}\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Cannot write OpenCode health request: {error}"))?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| format!("Cannot read OpenCode health response: {error}"))?;
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "OpenCode health response was not valid HTTP".to_string())?;
    let status = headers.lines().next().unwrap_or_default();
    if !status.contains(" 200 ") {
        return Err(format!("OpenCode health returned {status}"));
    }
    let payload: Value = serde_json::from_str(body)
        .map_err(|error| format!("OpenCode health returned invalid JSON: {error}"))?;
    if payload.get("healthy").and_then(Value::as_bool) != Some(true) {
        return Err("OpenCode health did not report healthy=true".to_string());
    }
    let version = payload
        .get("version")
        .and_then(Value::as_str)
        .ok_or_else(|| "OpenCode health did not report a version".to_string())?;
    if version != OPENCODE_RUNTIME_VERSION {
        return Err(format!(
            "OpenCode health version mismatch: expected {OPENCODE_RUNTIME_VERSION}, found {version}"
        ));
    }
    Ok(())
}

fn recent_logs(logs: &SharedLogs) -> String {
    logs.lock()
        .map(|logs| logs.iter().cloned().collect::<Vec<_>>().join("\n"))
        .unwrap_or_else(|_| "OpenCode diagnostics unavailable".to_string())
}

fn terminate_child(child: &mut Child) -> Result<(), String> {
    match child
        .try_wait()
        .map_err(|error| format!("Cannot inspect OpenCode process: {error}"))?
    {
        Some(_) => Ok(()),
        None => {
            child
                .kill()
                .map_err(|error| format!("Cannot stop OpenCode: {error}"))?;
            child
                .wait()
                .map(|_| ())
                .map_err(|error| format!("Cannot reap OpenCode process: {error}"))
        }
    }
}

fn spawn_candidate(
    binary: &Path,
    project_path: &Path,
    app_data: &Path,
    generation: u64,
) -> Result<RunningOpenCode, String> {
    let project_path = project_path
        .canonicalize()
        .map_err(|error| format!("Cannot resolve OpenCode Project: {error}"))?;
    let password = launch_password()?;
    let config_dir = prepare_directory(&app_data.join("config"))?;
    let data_dir = prepare_directory(&app_data.join("data"))?;
    let cache_dir = prepare_directory(&app_data.join("cache"))?;
    let state_dir = prepare_directory(&app_data.join("state"))?;
    let (port_reservation, port) = reserve_loopback_port()?;
    let endpoint = format!("http://127.0.0.1:{port}");
    let mut command = Command::new(binary);
    command
        .args([
            "serve",
            "--pure",
            "--hostname",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--print-logs",
            "--log-level",
            "INFO",
        ])
        .current_dir(&project_path)
        .env("OPENCODE_SERVER_USERNAME", OPENCODE_USERNAME)
        .env("OPENCODE_SERVER_PASSWORD", &password)
        .env("OPENCODE_CONFIG_DIR", config_dir)
        .env("XDG_DATA_HOME", data_dir)
        .env("XDG_CACHE_HOME", cache_dir)
        .env("XDG_STATE_HOME", state_dir)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // OpenCode 1.15.13 treats --port 0 as its fixed default instead of reporting an OS-selected
    // ephemeral port. Keep our selected port reserved until the last possible moment, then let the
    // child bind it immediately. This minimizes the unavoidable handoff window without probing a
    // port and leaving it unreserved during launch preparation.
    drop(port_reservation);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot start OpenCode Server: {error}"))?;
    let logs = Arc::new(Mutex::new(VecDeque::new()));
    if let Some(stdout) = child.stdout.take() {
        drain_output(stdout, "stdout", logs.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        drain_output(stderr, "stderr", logs.clone());
    }

    let expected_line = format!("opencode server listening on {endpoint}");
    let deadline = Instant::now() + START_TIMEOUT;
    let mut observed_stdout = false;
    while Instant::now() < deadline {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Cannot inspect OpenCode startup: {error}"))?
        {
            return Err(format!(
                "OpenCode Server exited during startup with {status}. {}",
                recent_logs(&logs)
            ));
        }
        if !observed_stdout {
            observed_stdout = recent_logs(&logs).contains(&expected_line);
        }
        if observed_stdout && health_probe(port, &password).is_ok() {
            return Ok(RunningOpenCode {
                child,
                generation,
                project_path,
                endpoint,
                password,
                logs,
            });
        }
        thread::sleep(Duration::from_millis(100));
    }
    let diagnostics = recent_logs(&logs);
    let _ = terminate_child(&mut child);
    Err(format!(
        "OpenCode Server did not become ready within 15 seconds. {diagnostics}"
    ))
}

fn status(runtime: &OpenCodeRuntime) -> Result<OpenCodeRuntimeStatus, String> {
    let mut lifecycle = runtime
        .lifecycle
        .lock()
        .map_err(|_| "OpenCode runtime state is unavailable".to_string())?;
    if let OpenCodeLifecycle::Running(running) = &mut *lifecycle
        && running
            .child
            .try_wait()
            .map_err(|error| format!("Cannot inspect OpenCode process: {error}"))?
            .is_some()
    {
        *lifecycle = OpenCodeLifecycle::Stopped;
        runtime.generation.fetch_add(1, Ordering::SeqCst);
    }
    Ok(match &*lifecycle {
        OpenCodeLifecycle::Stopped => {
            OpenCodeRuntimeStatus::stopped(runtime.generation.load(Ordering::SeqCst))
        }
        OpenCodeLifecycle::Starting {
            generation,
            project_path,
        } => OpenCodeRuntimeStatus {
            state: OpenCodeRuntimePhase::Starting,
            running: false,
            project_path: Some(project_path.clone()),
            endpoint: None,
            generation: *generation,
            version: OPENCODE_RUNTIME_VERSION,
        },
        OpenCodeLifecycle::Running(running) => OpenCodeRuntimeStatus {
            state: OpenCodeRuntimePhase::Running,
            running: true,
            project_path: Some(running.project_path.clone()),
            endpoint: Some(running.endpoint.clone()),
            generation: running.generation,
            version: OPENCODE_RUNTIME_VERSION,
        },
        OpenCodeLifecycle::Stopping {
            generation,
            project_path,
        } => OpenCodeRuntimeStatus {
            state: OpenCodeRuntimePhase::Stopping,
            running: false,
            project_path: Some(project_path.clone()),
            endpoint: None,
            generation: *generation,
            version: OPENCODE_RUNTIME_VERSION,
        },
    })
}

pub(crate) fn is_running(runtime: &OpenCodeRuntime) -> Result<bool, String> {
    status(runtime).map(|status| status.running)
}

pub(crate) fn is_stopped(runtime: &OpenCodeRuntime) -> Result<bool, String> {
    status(runtime).map(|status| status.phase() == OpenCodeRuntimePhase::Stopped)
}

pub(crate) fn with_stopped<T>(
    runtime: &OpenCodeRuntime,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _ = status(runtime)?;
    let lifecycle = runtime
        .lifecycle
        .lock()
        .map_err(|_| "OpenCode runtime state is unavailable".to_string())?;
    if !matches!(*lifecycle, OpenCodeLifecycle::Stopped) {
        return Err("OpenCode must be fully stopped for this Host operation".to_string());
    }
    operation()
}

pub(crate) fn current_generation(runtime: &OpenCodeRuntime) -> u64 {
    runtime.generation.load(Ordering::SeqCst)
}

pub fn opencode_runtime_start(
    app: AppHandle,
    runtime: &OpenCodeRuntime,
    options: OpenCodeStartOptions,
) -> Result<OpenCodeRuntimeStatus, String> {
    let project_path = PathBuf::from(options.project_path);
    if !project_path.is_dir() {
        return Err(format!(
            "OpenCode Project is not a directory: {}",
            project_path.display()
        ));
    }
    let project_path = project_path
        .canonicalize()
        .map_err(|error| format!("Cannot resolve OpenCode Project: {error}"))?;
    let generation = {
        let mut lifecycle = runtime
            .lifecycle
            .lock()
            .map_err(|_| "OpenCode runtime state is unavailable".to_string())?;
        if matches!(&*lifecycle, OpenCodeLifecycle::Running(_)) {
            drop(lifecycle);
            return status(runtime);
        }
        if !matches!(&*lifecycle, OpenCodeLifecycle::Stopped) {
            return Err("OpenCode Runtime is already changing state".to_string());
        }
        let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *lifecycle = OpenCodeLifecycle::Starting {
            generation,
            project_path: project_path.clone(),
        };
        generation
    };
    if let Ok(mut events) = runtime.events.lock() {
        events.clear();
    }

    let prepared = (|| -> Result<RunningOpenCode, String> {
        let binary = verify_managed_installation(&app, OPENCODE_RUNTIME)?.binary_path;
        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("Cannot resolve Farfold data directory: {error}"))?
            .join("opencode");
        let mut failures = Vec::new();
        for _ in 0..START_ATTEMPTS {
            if runtime.generation.load(Ordering::SeqCst) != generation {
                return Err("OpenCode start was cancelled".to_string());
            }
            match spawn_candidate(&binary, &project_path, &app_data, generation) {
                Ok(running) => return Ok(running),
                Err(error) => failures.push(error),
            }
        }
        Err(format!(
            "OpenCode Server failed after {START_ATTEMPTS} attempts. {}",
            failures.join(" | ")
        ))
    })();

    let running = match prepared {
        Ok(running) => running,
        Err(error) => {
            if let Ok(mut lifecycle) = runtime.lifecycle.lock()
                && matches!(
                    &*lifecycle,
                    OpenCodeLifecycle::Starting {
                        generation: current,
                        ..
                    } if *current == generation
                )
            {
                *lifecycle = OpenCodeLifecycle::Stopped;
            }
            return Err(error);
        }
    };
    let mut lifecycle = runtime
        .lifecycle
        .lock()
        .map_err(|_| "OpenCode runtime state is unavailable".to_string())?;
    if !matches!(
        &*lifecycle,
        OpenCodeLifecycle::Starting {
            generation: current,
            ..
        } if *current == generation
    ) {
        let mut running = running;
        terminate_child(&mut running.child)?;
        return Err("OpenCode start was cancelled".to_string());
    }
    *lifecycle = OpenCodeLifecycle::Running(running);
    drop(lifecycle);
    let connection = connection(runtime)?;
    let router = app
        .try_state::<RuntimeEventRouter>()
        .map(|router| router.inner().clone());
    crate::opencode_protocol::start_event_stream(connection, runtime.events.clone(), router);
    status(runtime)
}

pub(crate) fn connection(runtime: &OpenCodeRuntime) -> Result<OpenCodeConnection, String> {
    let mut lifecycle = runtime
        .lifecycle
        .lock()
        .map_err(|_| "OpenCode runtime state is unavailable".to_string())?;
    let OpenCodeLifecycle::Running(running) = &mut *lifecycle else {
        return Err("OpenCode Runtime is not running".to_string());
    };
    if running
        .child
        .try_wait()
        .map_err(|error| format!("Cannot inspect OpenCode process: {error}"))?
        .is_some()
    {
        *lifecycle = OpenCodeLifecycle::Stopped;
        runtime.generation.fetch_add(1, Ordering::SeqCst);
        return Err("OpenCode Runtime exited unexpectedly".to_string());
    }
    Ok(OpenCodeConnection {
        endpoint: running.endpoint.clone(),
        password: running.password.clone(),
        project_path: running.project_path.clone(),
        generation: running.generation,
        generation_clock: runtime.generation.clone(),
    })
}

pub fn opencode_runtime_status(runtime: &OpenCodeRuntime) -> Result<OpenCodeRuntimeStatus, String> {
    status(runtime)
}

#[tauri::command]
pub fn opencode_runtime_readiness(
    runtime: State<'_, OpenCodeRuntime>,
) -> Result<OpenCodeConnectionReadiness, String> {
    let current = status(&runtime)?;
    let (provider, model, account) = if current.is_running() {
        match crate::opencode_protocol::provider_readiness(connection(&runtime)?) {
            Ok(readiness) => (readiness.provider, readiness.model, readiness.account),
            Err(_) => ("not_ready", "not_ready", "unknown"),
        }
    } else {
        ("unknown", "unknown", "unknown")
    };
    Ok(OpenCodeConnectionReadiness {
        runtime: opencode_identity(),
        phase: current.phase(),
        command_channel: if current.is_running() {
            "ready"
        } else {
            "not_ready"
        },
        provider,
        model,
        account,
        native_configuration: "runtime_owned",
    })
}

pub(crate) fn stop_process(runtime: &OpenCodeRuntime) -> Result<(), String> {
    let target = {
        let mut lifecycle = runtime
            .lifecycle
            .lock()
            .map_err(|_| "OpenCode runtime state is unavailable".to_string())?;
        match std::mem::replace(&mut *lifecycle, OpenCodeLifecycle::Stopped) {
            OpenCodeLifecycle::Running(running) => {
                let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
                *lifecycle = OpenCodeLifecycle::Stopping {
                    generation,
                    project_path: running.project_path.clone(),
                };
                Some(running)
            }
            OpenCodeLifecycle::Starting { .. } => {
                runtime.generation.fetch_add(1, Ordering::SeqCst);
                *lifecycle = OpenCodeLifecycle::Stopped;
                None
            }
            current @ OpenCodeLifecycle::Stopping { .. } => {
                *lifecycle = current;
                None
            }
            OpenCodeLifecycle::Stopped => None,
        }
    };
    if let Some(mut running) = target {
        let result = terminate_child(&mut running.child);
        if let Ok(mut lifecycle) = runtime.lifecycle.lock() {
            *lifecycle = OpenCodeLifecycle::Stopped;
        }
        result?;
    }
    Ok(())
}

pub fn opencode_runtime_stop(runtime: &OpenCodeRuntime) -> Result<OpenCodeRuntimeStatus, String> {
    stop_process(runtime)?;
    status(runtime)
}

#[tauri::command]
pub fn opencode_runtime_diagnostics(
    runtime: State<'_, OpenCodeRuntime>,
) -> Result<Vec<String>, String> {
    let lifecycle = runtime
        .lifecycle
        .lock()
        .map_err(|_| "OpenCode runtime state is unavailable".to_string())?;
    let OpenCodeLifecycle::Running(running) = &*lifecycle else {
        return Ok(Vec::new());
    };
    running
        .logs
        .lock()
        .map(|logs| logs.iter().cloned().collect())
        .map_err(|_| "OpenCode diagnostics are unavailable".to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        LOG_LIMIT, OPENCODE_RUNTIME_VERSION, OpenCodeConnection, OpenCodeLifecycle,
        OpenCodeRuntime, append_log, health_probe, launch_password, reserve_loopback_port,
        spawn_candidate, stop_process, terminate_child, with_stopped,
    };
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use std::{
        collections::VecDeque,
        fs,
        io::{Read, Write},
        net::{Ipv4Addr, TcpListener, TcpStream},
        path::PathBuf,
        sync::{
            Arc, Mutex,
            atomic::{AtomicU64, Ordering},
        },
        thread,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn stopped_guard_excludes_lifecycle_transitions() {
        let runtime = OpenCodeRuntime::default();
        assert_eq!(with_stopped(&runtime, || Ok(7)).unwrap(), 7);
        *runtime.lifecycle.lock().unwrap() = OpenCodeLifecycle::Starting {
            generation: 1,
            project_path: PathBuf::from("/project"),
        };
        assert!(with_stopped(&runtime, || Ok(())).is_err());
    }

    #[test]
    fn launch_password_has_256_bits_of_random_input() {
        let first = launch_password().unwrap();
        let second = launch_password().unwrap();
        assert_eq!(STANDARD.decode(&first).unwrap().len(), 32);
        assert_ne!(first, second);
    }

    #[test]
    fn selected_port_is_nonzero_and_reserved_until_handoff() {
        let (reservation, port) = reserve_loopback_port().unwrap();
        assert_ne!(port, 0);
        assert_eq!(reservation.local_addr().unwrap().ip(), Ipv4Addr::LOCALHOST);
        assert_eq!(reservation.local_addr().unwrap().port(), port);
        assert_eq!(
            TcpListener::bind((Ipv4Addr::LOCALHOST, port))
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::AddrInUse
        );
    }

    #[test]
    fn health_probe_requires_authenticated_pinned_version() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let read = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..read]);
            let credential = STANDARD.encode("farfold:probe-password");
            assert!(request.contains(&format!("Authorization: Basic {credential}")));
            let body = format!("{{\"healthy\":true,\"version\":\"{OPENCODE_RUNTIME_VERSION}\"}}");
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });
        health_probe(port, "probe-password").unwrap();
        server.join().unwrap();
    }

    #[test]
    fn diagnostics_are_bounded() {
        let logs = Arc::new(Mutex::new(VecDeque::new()));
        for index in 0..(LOG_LIMIT + 5) {
            append_log(&logs, index.to_string());
        }
        let logs = logs.lock().unwrap();
        assert_eq!(logs.len(), LOG_LIMIT);
        assert_eq!(logs.front().map(String::as_str), Some("5"));
    }

    #[test]
    fn stopping_during_start_invalidates_the_pending_generation() {
        let runtime = OpenCodeRuntime::default();
        runtime.generation.store(7, Ordering::SeqCst);
        *runtime.lifecycle.lock().unwrap() = OpenCodeLifecycle::Starting {
            generation: 7,
            project_path: PathBuf::from("/tmp/project"),
        };

        stop_process(&runtime).unwrap();

        assert!(matches!(
            *runtime.lifecycle.lock().unwrap(),
            OpenCodeLifecycle::Stopped
        ));
        assert_eq!(runtime.generation.load(Ordering::SeqCst), 8);
    }

    #[test]
    fn real_server_lifecycle_when_explicit_binary_is_provided() {
        let Some(binary) = std::env::var_os("FARFOLD_OPENCODE_TEST_BINARY") else {
            return;
        };
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "farfold-opencode-lifecycle-{}-{unique}",
            std::process::id()
        ));
        let project = root.join("project");
        let app_data = root.join("app-data");
        fs::create_dir_all(&project).unwrap();

        let mut running = spawn_candidate(&PathBuf::from(binary), &project, &app_data, 7).unwrap();
        let address = running.endpoint.trim_start_matches("http://").to_string();
        assert!(TcpStream::connect(&address).is_ok());

        let generation_clock = Arc::new(AtomicU64::new(7));
        let connection = OpenCodeConnection {
            endpoint: running.endpoint.clone(),
            password: running.password.clone(),
            project_path: running.project_path.clone(),
            generation: 7,
            generation_clock: generation_clock.clone(),
        };
        let readiness = crate::opencode_protocol::provider_readiness(connection.clone()).unwrap();
        assert_eq!(readiness.provider, "ready");
        assert_eq!(readiness.model, "ready");

        let events = Arc::new(Mutex::new(VecDeque::new()));
        crate::opencode_protocol::start_event_stream(connection.clone(), events.clone(), None);
        let session = crate::opencode_protocol::create_session(
            &connection,
            Some("Farfold lifecycle test".to_string()),
        )
        .unwrap();
        let session_id = session["id"].as_str().unwrap();
        let sessions = crate::opencode_protocol::list_sessions(&connection).unwrap();
        assert!(
            sessions.iter().any(|session| session["id"] == session_id),
            "created session {session}; listed sessions {sessions:?}"
        );
        crate::opencode_protocol::prompt_text(
            &connection,
            session_id,
            "opencode",
            "big-pickle",
            "Return exactly D3-ADAPTER-OK and nothing else.",
            None,
        )
        .unwrap();
        let response_deadline = std::time::Instant::now() + Duration::from_secs(45);
        let mut completed = false;
        let mut provider_failure = false;
        let mut latest_messages = Vec::new();
        while std::time::Instant::now() < response_deadline {
            latest_messages =
                crate::opencode_protocol::session_messages(&connection, session_id, Some(20))
                    .unwrap();
            completed = latest_messages.iter().any(|message| {
                message["info"]["role"] == "assistant"
                    && message["info"]["finish"] == "stop"
                    && message["parts"].as_array().is_some_and(|parts| {
                        parts.iter().any(|part| part["text"] == "D3-ADAPTER-OK")
                    })
            });
            provider_failure = events.lock().unwrap().iter().any(|event| {
                event["payload"]["payload"]["type"] == "session.status"
                    && event["payload"]["payload"]["properties"]["status"]["type"] == "retry"
            });
            if completed || provider_failure {
                break;
            }
            thread::sleep(Duration::from_millis(250));
        }
        assert!(
            completed || provider_failure,
            "OpenCode prompt produced neither completion nor visible Provider failure. messages={latest_messages:?} logs={}",
            super::recent_logs(&running.logs),
        );
        if provider_failure {
            assert!(crate::opencode_protocol::abort_session(&connection, session_id).unwrap());
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline
            && !events.lock().unwrap().iter().any(|event| {
                event["payload"]["payload"]["type"] == "server.connected"
                    || event["payload"]["payload"]["type"] == "session.created"
                    || event["payload"]["payload"]["type"] == "message.part.delta"
            })
        {
            thread::sleep(Duration::from_millis(50));
        }
        assert!(events.lock().unwrap().iter().any(|event| {
            event["payload"]["payload"]["type"] == "server.connected"
                || event["payload"]["payload"]["type"] == "session.created"
                || event["payload"]["payload"]["type"] == "message.part.delta"
        }));

        generation_clock.store(8, Ordering::SeqCst);
        terminate_child(&mut running.child).unwrap();
        thread::sleep(Duration::from_millis(100));
        assert!(TcpStream::connect(&address).is_err());

        fs::remove_dir_all(root).unwrap();
    }
}
