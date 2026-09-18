//! `AcpManager`: owns one ACP process per `(agent_id, cwd)` pair.
//!
//! Each connection is a spawned agent process running `initialize` once, then
//! idling on a command channel for `authenticate`/shutdown and (in later
//! slices) session operations. All agent differences come through protocol
//! data; this module holds no agent-specific logic.

use std::collections::HashMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    AuthCapabilities, AuthenticateRequest, ClientCapabilities, FileSystemCapabilities,
    Implementation, InitializeRequest, InitializeResponse, LogoutRequest,
};
use agent_client_protocol::{
    AcpAgent, AcpAgentConfig, Agent, Client, ConnectionTo, Handled, LineDirection,
};
use serde::Serialize;
use tauri::{AppHandle, Manager as _};
use tokio::sync::{mpsc, oneshot};

use crate::meta_store::{AgentRow, MetaStore};
use crate::shell_env;

/// How long `connect` waits for `initialize` before giving up.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(60);
/// Per-file cap for the raw protocol tap; rotates once then stops writing.
const TAP_FILE_CAP: u64 = 2 * 1024 * 1024;

#[derive(Debug)]
pub enum ManagerCommand {
    Authenticate {
        method_id: String,
        result: oneshot::Sender<Result<(), String>>,
    },
    Logout {
        result: oneshot::Sender<Result<(), String>>,
    },
    Shutdown,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentConnectionStatus {
    pub agent_id: String,
    pub cwd: String,
    /// `connecting` | `ready` | `closed` | `failed`
    pub state: String,
    pub agent_name: Option<String>,
    pub agent_version: Option<String>,
    pub auth_methods: Vec<String>,
}

#[derive(Hash, Eq, PartialEq, Clone)]
struct ConnectionKey {
    agent_id: String,
    cwd: PathBuf,
}

struct ManagedConnection {
    command_tx: mpsc::UnboundedSender<ManagerCommand>,
    state: Arc<AtomicU8>,
    handshake: Option<InitializeResponse>,
}

const STATE_CONNECTING: u8 = 0;
const STATE_READY: u8 = 1;
const STATE_CLOSED: u8 = 2;
const STATE_FAILED: u8 = 3;

fn state_label(value: u8) -> &'static str {
    match value {
        STATE_READY => "ready",
        STATE_CLOSED => "closed",
        STATE_FAILED => "failed",
        _ => "connecting",
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

/// Shared tokio runtime for ACP tasks. Tauri commands are sync, so the
/// manager keeps its own multi-thread runtime rather than borrowing the
/// async-runtime's worker threads.
fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME
        .get_or_init(|| tokio::runtime::Runtime::new().expect("failed to start ACP tokio runtime"))
}

/// Raw protocol tap: appends every stdin/stdout/stderr line to
/// `acp-<agent>-<ts>.jsonl` under the log dir, rotating once at the cap.
struct DebugTap {
    path: PathBuf,
    file: Option<std::io::BufWriter<std::fs::File>>,
    written: u64,
    rotated: bool,
    stopped: bool,
}

impl DebugTap {
    fn open(log_dir: &Path, agent_id: &str) -> Option<Arc<Mutex<Self>>> {
        std::fs::create_dir_all(log_dir).ok()?;
        let path = log_dir.join(format!("acp-{agent_id}-{}.jsonl", now_millis()));
        let file = std::fs::File::create(&path).ok()?;
        Some(Arc::new(Mutex::new(Self {
            path,
            file: Some(std::io::BufWriter::new(file)),
            written: 0,
            rotated: false,
            stopped: false,
        })))
    }

    fn write(&mut self, line: &str, direction: LineDirection) {
        if self.stopped {
            return;
        }
        let direction = match direction {
            LineDirection::Stdin => "out",
            LineDirection::Stdout => "in",
            LineDirection::Stderr => "err",
        };
        let record = serde_json::json!({"ts": now_millis(), "dir": direction, "line": line});
        let mut encoded = record.to_string();
        encoded.push('\n');
        let Some(file) = self.file.as_mut() else {
            self.stopped = true;
            return;
        };
        if file.write_all(encoded.as_bytes()).is_err() {
            self.stopped = true;
            return;
        }
        self.written += encoded.len() as u64;
        if self.written >= TAP_FILE_CAP {
            if self.rotated {
                let _ = file.flush();
                self.stopped = true;
                return;
            }
            self.rotated = true;
            let _ = file.flush();
            drop(self.file.take());
            let rotated_path = self.path.with_extension("jsonl.1");
            let _ = std::fs::rename(&self.path, &rotated_path);
            self.file = std::fs::File::create(&self.path)
                .ok()
                .map(std::io::BufWriter::new);
            self.written = 0;
        }
    }
}

impl Drop for DebugTap {
    fn drop(&mut self) {
        if let Some(file) = self.file.as_mut() {
            let _ = file.flush();
        }
    }
}

/// Manages ACP connections keyed by `(agent_id, cwd)`.
pub struct AcpManager {
    connections: Mutex<HashMap<ConnectionKey, ManagedConnection>>,
    log_dir: PathBuf,
}

impl AcpManager {
    pub fn new(log_dir: PathBuf) -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            log_dir,
        }
    }

    fn lock(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<ConnectionKey, ManagedConnection>>, String> {
        self.connections
            .lock()
            .map_err(|_| "ACP manager lock poisoned".to_string())
    }

    fn status_of(key: &ConnectionKey, connection: &ManagedConnection) -> AgentConnectionStatus {
        let handshake = connection.handshake.as_ref();
        AgentConnectionStatus {
            agent_id: key.agent_id.clone(),
            cwd: key.cwd.to_string_lossy().into_owned(),
            state: state_label(connection.state.load(Ordering::SeqCst)).to_string(),
            agent_name: handshake.and_then(|h| h.agent_info.as_ref().map(|i| i.name.clone())),
            agent_version: handshake.and_then(|h| h.agent_info.as_ref().map(|i| i.version.clone())),
            auth_methods: handshake
                .map(|h| {
                    h.auth_methods
                        .iter()
                        .map(|m| m.id().0.to_string())
                        .collect()
                })
                .unwrap_or_default(),
        }
    }

    /// `status` for every live connection of `agent_id` (all cwds).
    pub fn status(&self, agent_id: &str) -> Result<Vec<AgentConnectionStatus>, String> {
        let connections = self.lock()?;
        Ok(connections
            .iter()
            .filter(|(key, _)| key.agent_id == agent_id)
            .map(|(key, connection)| Self::status_of(key, connection))
            .collect())
    }

    /// Spawn `{command, args}` in `cwd` (login-shell env + row env overrides),
    /// run `initialize`, persist the handshake on the agents row, and keep the
    /// process idling on its command channel.
    pub fn connect(
        &self,
        agent: &AgentRow,
        cwd: &Path,
        store: &MetaStore,
    ) -> Result<AgentConnectionStatus, String> {
        let key = ConnectionKey {
            agent_id: agent.id.clone(),
            cwd: cwd.to_path_buf(),
        };
        {
            let connections = self.lock()?;
            if let Some(existing) = connections.get(&key)
                && existing.state.load(Ordering::SeqCst) == STATE_READY
            {
                return Ok(Self::status_of(&key, existing));
            }
        }

        let (command_tx, mut command_rx) = mpsc::unbounded_channel::<ManagerCommand>();
        let (init_tx, init_rx) = oneshot::channel::<Result<InitializeResponse, String>>();
        let state = Arc::new(AtomicU8::new(STATE_CONNECTING));
        let state_for_task = state.clone();

        let tap = DebugTap::open(&self.log_dir, &agent.id);
        let config = AcpAgentConfig::new(&agent.command)
            .args(agent.args.iter().cloned())
            .envs(shell_env::command_env())
            .envs(crate::auth::resolve_agent_env(&agent.id, &agent.env));
        let acp_agent = AcpAgent::new(config).with_debug(move |line, direction| {
            if let Some(tap) = &tap
                && let Ok(mut tap) = tap.lock()
            {
                tap.write(line, direction);
            }
        });
        let state_for_terminal = state.clone();

        let task = runtime().spawn(async move {
            let result = Client
                .builder()
                .name("farfold")
                .on_receive_dispatch(
                    async |message: agent_client_protocol::Dispatch<
                        agent_client_protocol::UntypedMessage,
                        agent_client_protocol::UntypedMessage,
                    >,
                           _cx| {
                        Ok(Handled::No {
                            message,
                            retry: false,
                        })
                    },
                    agent_client_protocol::on_receive_dispatch!(),
                )
                .connect_with(acp_agent, move |cx: ConnectionTo<Agent>| async move {
                    let init = InitializeRequest::new(ProtocolVersion::V1)
                        .client_info(Implementation::new("farfold", env!("CARGO_PKG_VERSION")))
                        .client_capabilities(
                            ClientCapabilities::new()
                                .fs(FileSystemCapabilities::new()
                                    .read_text_file(true)
                                    .write_text_file(true))
                                .terminal(false)
                                .auth(AuthCapabilities::new().terminal(true)),
                        );
                    let init_response = cx.send_request(init).block_task().await?;
                    state_for_task.store(STATE_READY, Ordering::SeqCst);
                    let _ = init_tx.send(Ok(init_response));

                    while let Some(command) = command_rx.recv().await {
                        match command {
                            ManagerCommand::Authenticate { method_id, result } => {
                                let outcome = cx
                                    .send_request(AuthenticateRequest::new(method_id))
                                    .block_task()
                                    .await
                                    .map(|_| ())
                                    .map_err(|error| error.to_string());
                                let _ = result.send(outcome);
                            }
                            ManagerCommand::Logout { result } => {
                                let outcome = cx
                                    .send_request(LogoutRequest::new())
                                    .block_task()
                                    .await
                                    .map(|_| ())
                                    .map_err(|error| error.to_string());
                                let _ = result.send(outcome);
                            }
                            ManagerCommand::Shutdown => break,
                        }
                    }
                    Ok(())
                })
                .await;
            let terminal = match &result {
                Ok(_) => STATE_CLOSED,
                Err(_) => STATE_FAILED,
            };
            state_for_terminal.store(terminal, Ordering::SeqCst);
            result
        });

        let init_response = match runtime()
            .block_on(async { tokio::time::timeout(INITIALIZE_TIMEOUT, init_rx).await })
        {
            Ok(Ok(Ok(response))) => response,
            Ok(Ok(Err(error))) => {
                task.abort();
                return Err(format!("initialize failed: {error}"));
            }
            Ok(Err(_)) => {
                task.abort();
                return Err("agent process exited during initialize".to_string());
            }
            Err(_) => {
                task.abort();
                return Err("initialize timed out".to_string());
            }
        };

        let handshake_json = serde_json::to_value(&init_response)
            .map_err(|error| format!("cannot serialize handshake: {error}"))?;
        store.set_agent_handshake(&agent.id, &handshake_json)?;

        let connection = ManagedConnection {
            command_tx,
            state,
            handshake: Some(init_response),
        };
        let mut connections = self.lock()?;
        let status = Self::status_of(&key, &connection);
        connections.insert(key, connection);
        Ok(status)
    }

    /// Shut down the `(agent_id, cwd)` connection if present.
    pub fn disconnect(&self, agent_id: &str, cwd: &Path) -> Result<bool, String> {
        let key = ConnectionKey {
            agent_id: agent_id.to_string(),
            cwd: cwd.to_path_buf(),
        };
        let connection = self.lock()?.remove(&key);
        match connection {
            None => Ok(false),
            Some(connection) => {
                let _ = connection.command_tx.send(ManagerCommand::Shutdown);
                Ok(true)
            }
        }
    }

    /// Send a request-shaped command to every ready connection of `agent_id`
    /// and wait for each reply. Errors if the agent has no live connection.
    fn run_on_ready(
        &self,
        agent_id: &str,
        label: &str,
        make_command: impl Fn(oneshot::Sender<Result<(), String>>) -> ManagerCommand,
    ) -> Result<(), String> {
        let senders: Vec<mpsc::UnboundedSender<ManagerCommand>> = {
            let connections = self.lock()?;
            connections
                .iter()
                .filter(|(key, connection)| {
                    key.agent_id == agent_id
                        && connection.state.load(Ordering::SeqCst) == STATE_READY
                })
                .map(|(_, connection)| connection.command_tx.clone())
                .collect()
        };
        if senders.is_empty() {
            return Err(format!("no live connection for {agent_id}"));
        }
        let mut last_error = None;
        for sender in senders {
            let (result_tx, result_rx) = oneshot::channel();
            if sender.send(make_command(result_tx)).is_err() {
                continue;
            }
            match result_rx.blocking_recv() {
                Ok(Ok(())) => {}
                Ok(Err(error)) => last_error = Some(error),
                Err(_) => last_error = Some(format!("{label} channel closed")),
            }
        }
        match last_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// `authenticate` on every live connection of `agent_id`.
    pub fn authenticate(&self, agent_id: &str, method_id: &str) -> Result<(), String> {
        self.run_on_ready(agent_id, "authenticate", |result| {
            ManagerCommand::Authenticate {
                method_id: method_id.to_string(),
                result,
            }
        })
    }

    /// `logout` on every live connection of `agent_id`.
    pub fn logout(&self, agent_id: &str) -> Result<(), String> {
        self.run_on_ready(agent_id, "logout", |result| ManagerCommand::Logout {
            result,
        })
    }

    /// Send shutdown to every connection (app exit path).
    pub fn stop_for_shutdown(&self) {
        if let Ok(mut connections) = self.connections.lock() {
            for (_, connection) in connections.drain() {
                let _ = connection.command_tx.send(ManagerCommand::Shutdown);
            }
        }
    }
}

impl Default for AcpManager {
    fn default() -> Self {
        let log_dir = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Library/Logs/Farfold");
        Self::new(log_dir)
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

fn require_agent_row(app: &AppHandle, agent_id: &str) -> Result<AgentRow, String> {
    let store = app.state::<MetaStore>();
    store
        .get_agent(agent_id)?
        .ok_or_else(|| format!("agent {agent_id} is not registered"))
}

fn validate_cwd(cwd: &str) -> Result<PathBuf, String> {
    if cwd.trim().is_empty() {
        return Err("project directory is empty".to_string());
    }
    let path = PathBuf::from(cwd);
    if !path.is_dir() {
        return Err(format!("project directory does not exist: {cwd}"));
    }
    path.canonicalize()
        .map_err(|error| format!("cannot resolve {cwd}: {error}"))
}

/// Spawn the agent in `cwd`, run `initialize`, persist the handshake, and
/// leave the process connected for session work.
#[tauri::command]
pub async fn agent_connect(
    app: AppHandle,
    agent_id: String,
    cwd: String,
) -> Result<AgentConnectionStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let row = require_agent_row(&app, &agent_id)?;
        let cwd = validate_cwd(&cwd)?;
        let manager = app.state::<AcpManager>();
        let store = app.state::<MetaStore>();
        let status = manager.connect(&row, &cwd, &store)?;
        crate::ui_transport::emit_event(&app, "agent:status", &status);
        Ok(status)
    })
    .await
    .map_err(|error| format!("agent_connect failed: {error}"))?
}

/// Drop every live connection the agent holds (all cwds).
#[tauri::command]
pub fn agent_disconnect(app: AppHandle, agent_id: String) -> Result<bool, String> {
    let manager = app.state::<AcpManager>();
    let statuses = manager.status(&agent_id)?;
    let mut disconnected = false;
    for status in statuses {
        if manager.disconnect(&agent_id, Path::new(&status.cwd))? {
            disconnected = true;
            crate::ui_transport::emit_event(
                &app,
                "agent:status",
                serde_json::json!({
                    "agentId": agent_id,
                    "cwd": status.cwd,
                    "state": "closed",
                }),
            );
        }
    }
    Ok(disconnected)
}

/// Live connection state for one agent (one entry per cwd).
#[tauri::command]
pub fn agent_status(
    app: AppHandle,
    agent_id: String,
) -> Result<Vec<AgentConnectionStatus>, String> {
    app.state::<AcpManager>().status(&agent_id)
}

/// Run `authenticate` for `method_id` on the agent's live connections.
#[tauri::command]
pub async fn agent_authenticate(
    app: AppHandle,
    agent_id: String,
    method_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AcpManager>()
            .authenticate(&agent_id, &method_id)
    })
    .await
    .map_err(|error| format!("agent_authenticate failed: {error}"))?
}
