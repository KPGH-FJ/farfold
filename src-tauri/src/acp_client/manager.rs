//! `AcpManager`: owns one ACP process per `(agent_id, cwd)` pair.
//!
//! Each connection is a spawned agent process running `initialize` once, then
//! idling on a command channel for `authenticate`/shutdown and session work
//! (`crate::acp_client::session`). All agent differences come through
//! protocol data; this module holds no agent-specific logic.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    AuthCapabilities, AuthenticateRequest, ClientCapabilities, DeleteSessionRequest,
    ElicitationCapabilities, ElicitationFormCapabilities, Implementation, InitializeRequest,
    InitializeResponse, LogoutRequest, Meta,
};
use agent_client_protocol::{
    AcpAgent, AcpAgentConfig, Agent, Client, ConnectionTo, Dispatch, Handled, UntypedMessage,
};
use serde::Serialize;
use tauri::{AppHandle, Manager as _};
use tokio::sync::{mpsc, oneshot};

use crate::acp_client::pump::{
    self, PendingElicitations, PendingPermissions, SessionMap, SessionOps,
};
use crate::acp_client::tap::DebugTap;
use crate::logging;
use crate::meta_store::{AgentRow, MetaStore};
use crate::shell_env;
use crate::supervisor;

/// How long `connect` waits for `initialize` before giving up.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(60);
/// Connections with no wire or command activity for this long are
/// disconnected by the idle reaper.
const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// Idle reaper tick.
const REAPER_TICK: Duration = Duration::from_secs(60);

fn now_millis_u64() -> u64 {
    crate::acp_client::session_index::now_millis() as u64
}

pub enum ManagerCommand {
    Authenticate {
        method_id: String,
        result: oneshot::Sender<Result<(), String>>,
    },
    Logout {
        result: oneshot::Sender<Result<(), String>>,
    },
    OpenSession {
        native_session_id: Option<String>,
        recorded_config: Option<serde_json::Value>,
        config_options: Vec<(String, serde_json::Value)>,
        events: pump::SessionSink,
        result: oneshot::Sender<Result<pump::OpenedSession, String>>,
    },
    ListSessions {
        cwd: PathBuf,
        result: oneshot::Sender<Result<serde_json::Value, String>>,
    },
    /// `session/delete` for sessions without an open pump (agent-side rows).
    DeleteSession {
        session_id: String,
        result: oneshot::Sender<Result<(), String>>,
    },
    Shutdown,
}

impl std::fmt::Debug for ManagerCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Authenticate { .. } => "Authenticate",
            Self::Logout { .. } => "Logout",
            Self::OpenSession { .. } => "OpenSession",
            Self::ListSessions { .. } => "ListSessions",
            Self::DeleteSession { .. } => "DeleteSession",
            Self::Shutdown => "Shutdown",
        })
    }
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
pub(crate) struct ConnectionKey {
    pub(crate) agent_id: String,
    pub(crate) cwd: PathBuf,
}

#[derive(Clone)]
pub(crate) struct ManagedConnection {
    pub(crate) command_tx: mpsc::UnboundedSender<ManagerCommand>,
    pub(crate) state: Arc<AtomicU8>,
    /// Filled once `initialize` succeeds — a CONNECTING entry inserted before
    /// the task finishes carries an empty cell (connect-race guard).
    pub(crate) handshake: Arc<std::sync::OnceLock<InitializeResponse>>,
    /// Live sessions on this connection (native session id → handle).
    /// Shared with the connection task so process death can notify every
    /// session channel.
    pub(crate) sessions: SessionMap,
    /// Last command or wire activity (epoch millis); the idle reaper
    /// disconnects the connection once this goes quiet for `IDLE_TIMEOUT`.
    pub(crate) last_activity: Arc<AtomicU64>,
    /// Unanswered permission/elicitation requests plus in-flight prompts
    /// across this connection's sessions — the reaper skips connections
    /// that are still waiting on the user or the agent.
    pub(crate) open_requests: Arc<AtomicU64>,
    /// Spawned agent process id (`0` until attributed), for `pids.json`.
    pub(crate) child_pid: Arc<AtomicU32>,
}

const STATE_CONNECTING: u8 = 0;
pub(crate) const STATE_READY: u8 = 1;
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

/// Shared runtime for ACP transport tasks; command-side futures await replies
/// without occupying blocking threads.
pub(crate) fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME
        .get_or_init(|| tokio::runtime::Runtime::new().expect("failed to start ACP tokio runtime"))
}

/// Manages ACP connections keyed by `(agent_id, cwd)`.
pub struct AcpManager {
    connections: Arc<Mutex<HashMap<ConnectionKey, ManagedConnection>>>,
    log_dir: PathBuf,
    /// App data dir — home of `pids.json` for process supervision.
    data_dir: PathBuf,
    /// requestId → responder for pending `session/request_permission` calls
    /// across every connection. Entries are removed when answered or when
    /// their session pump exits.
    pub(crate) pending_permissions: PendingPermissions,
    /// requestId → responder for pending `elicitation/create` calls.
    pub(crate) pending_elicitations: PendingElicitations,
}

/// Dropping a connect future must not leave its transport or reservation behind.
struct StartingConnection {
    connections: Arc<Mutex<HashMap<ConnectionKey, ManagedConnection>>>,
    key: ConnectionKey,
    state: Arc<AtomicU8>,
    abort: tokio::task::AbortHandle,
    complete: bool,
}
impl Drop for StartingConnection {
    fn drop(&mut self) {
        if self.complete {
            return;
        }
        self.abort.abort();
        self.state.store(STATE_FAILED, Ordering::SeqCst);
        if let Ok(mut entries) = self.connections.lock()
            && entries
                .get(&self.key)
                .is_some_and(|entry| Arc::ptr_eq(&entry.state, &self.state))
        {
            entries.remove(&self.key);
        }
    }
}

impl AcpManager {
    pub fn new(log_dir: PathBuf, data_dir: PathBuf) -> Self {
        let manager = Self {
            connections: Arc::new(Mutex::new(HashMap::new())),
            log_dir,
            data_dir,
            pending_permissions: PendingPermissions::default(),
            pending_elicitations: PendingElicitations::default(),
        };
        manager.spawn_idle_reaper();
        manager
    }

    /// Every minute, disconnect connections with no activity for
    /// `IDLE_TIMEOUT` (no open session, or every session quiet). Session
    /// state lives agent-side; a later open resumes via `session/load`.
    fn spawn_idle_reaper(&self) {
        let connections = self.connections.clone();
        std::thread::Builder::new()
            .name("acp-idle-reaper".to_string())
            .spawn(move || {
                loop {
                    std::thread::sleep(REAPER_TICK);
                    let now = now_millis_u64();
                    let stale: Vec<ConnectionKey> = match connections.lock() {
                        Ok(map) => map
                            .iter()
                            .filter(|(_, connection)| {
                                connection.open_requests.load(Ordering::Relaxed) == 0
                                    && now.saturating_sub(
                                        connection.last_activity.load(Ordering::Relaxed),
                                    ) > IDLE_TIMEOUT.as_millis() as u64
                            })
                            .map(|(key, _)| key.clone())
                            .collect(),
                        Err(_) => continue,
                    };
                    if let Ok(mut map) = connections.lock() {
                        for key in stale {
                            if let Some(connection) = map.remove(&key) {
                                let _ = connection.command_tx.send(ManagerCommand::Shutdown);
                                logging::info(
                                    "acp_client",
                                    format_args!(
                                        "idle connection recycled: {} on {}",
                                        key.agent_id,
                                        key.cwd.display()
                                    ),
                                );
                            }
                        }
                    }
                }
            })
            .expect("failed to spawn idle reaper");
    }

    pub(crate) fn lock(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<ConnectionKey, ManagedConnection>>, String> {
        self.connections
            .lock()
            .map_err(|_| "ACP manager lock poisoned".to_string())
    }

    fn status_of(key: &ConnectionKey, connection: &ManagedConnection) -> AgentConnectionStatus {
        let handshake = connection.handshake.get();
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
    pub async fn connect(
        &self,
        agent: &AgentRow,
        cwd: &Path,
        store: &MetaStore,
    ) -> Result<AgentConnectionStatus, String> {
        let key = ConnectionKey {
            agent_id: agent.id.clone(),
            cwd: cwd.to_path_buf(),
        };
        if let Some(connection) = self.lock()?.get(&key).cloned()
            && connection.state.load(Ordering::SeqCst) == STATE_READY
        {
            return Ok(Self::status_of(&key, &connection));
        }
        let environment_agent = agent.clone();
        let environment = tauri::async_runtime::spawn_blocking(move || {
            let mut env = shell_env::command_env();
            env.extend(crate::auth::resolve_agent_env(
                &environment_agent.id,
                &environment_agent.env,
            ));
            env
        })
        .await
        .map_err(|_| "无法准备连接环境".to_string())?;
        // One asynchronous reservation also protects process attribution.
        // Recheck after acquiring it: concurrent callers reuse a fully ready entry.
        let _spawn_guard = tokio::time::timeout(
            INITIALIZE_TIMEOUT + Duration::from_secs(15),
            supervisor::spawn_attribution_guard(),
        )
        .await
        .map_err(|_| "连接等待超时，请重试".to_string())?;
        if let Some(connection) = self.lock()?.get(&key).cloned()
            && connection.state.load(Ordering::SeqCst) == STATE_READY
        {
            return Ok(Self::status_of(&key, &connection));
        }

        let (command_tx, mut command_rx) = mpsc::unbounded_channel::<ManagerCommand>();
        let (init_tx, init_rx) = oneshot::channel::<Result<InitializeResponse, String>>();
        let state = Arc::new(AtomicU8::new(STATE_CONNECTING));
        let sessions: SessionMap = SessionMap::default();
        let sessions_for_task = sessions.clone();
        let sessions_for_cleanup = sessions.clone();
        let pending_permissions = self.pending_permissions.clone();
        let last_activity = Arc::new(AtomicU64::new(now_millis_u64()));
        let open_requests = Arc::new(AtomicU64::new(0));
        let child_pid = Arc::new(AtomicU32::new(0));
        let ops = SessionOps {
            elicitations: self.pending_elicitations.clone(),
            activity: last_activity.clone(),
            open_requests: open_requests.clone(),
        };
        let cwd_for_task = cwd.to_path_buf();
        let activity_for_task = last_activity.clone();
        let child_pid_for_task = child_pid.clone();
        let data_dir_for_task = self.data_dir.clone();
        let agent_label = format!("{} on {}", agent.id, cwd.display());
        let agent_label_for_task = agent_label.clone();
        let handshake = Arc::new(std::sync::OnceLock::<InitializeResponse>::new());

        // Reserve the key before spawning: a concurrent connect() waits on
        // this CONNECTING entry instead of starting a duplicate process.
        // Removed on every failure path below.
        {
            let mut connections = self.lock()?;
            connections.insert(
                key.clone(),
                ManagedConnection {
                    command_tx: command_tx.clone(),
                    state: state.clone(),
                    handshake: handshake.clone(),
                    sessions: sessions.clone(),
                    last_activity: last_activity.clone(),
                    open_requests: open_requests.clone(),
                    child_pid: child_pid.clone(),
                },
            );
        }

        let tap = DebugTap::open(&self.log_dir, &agent.id);
        let config = AcpAgentConfig::new(&agent.command)
            .args(agent.args.iter().cloned())
            .envs(environment);
        let acp_agent = AcpAgent::new(config).with_debug(move |line, direction| {
            if let Some(tap) = &tap
                && let Ok(mut tap) = tap.lock()
            {
                tap.write(line, direction);
            }
        });
        let state_for_terminal = state.clone();

        // Serialize spawn→pid attribution: the child appears between the
        // before/after `pgrep -P` snapshots taken under this lock.
        let children_before: HashSet<u32> =
            tauri::async_runtime::spawn_blocking(|| supervisor::child_pids(std::process::id()))
                .await
                .map_err(|_| "无法检查连接进程".to_string())?
                .into_iter()
                .collect();

        let task = runtime().spawn(async move {
            let result = Client
                .builder()
                .name("farfold")
                .on_receive_dispatch(
                    async |dispatch: Dispatch<UntypedMessage, UntypedMessage>, _cx| {
                        // Session-scoped traffic can arrive before the
                        // per-session dynamic handler is registered (right
                        // after session/new resolves, or as session/load
                        // replay ahead of the response). Ask the dispatcher
                        // to retry it against later dynamic handlers instead
                        // of dropping it.
                        let retry = dispatch
                            .message()
                            .and_then(|message| message.params().get("sessionId"))
                            .is_some();
                        Ok(Handled::No {
                            message: dispatch,
                            retry,
                        })
                    },
                    agent_client_protocol::on_receive_dispatch!(),
                )
                .connect_with(acp_agent, move |cx: ConnectionTo<Agent>| async move {
                    let init = InitializeRequest::new(ProtocolVersion::V1)
                        .client_info(Implementation::new("farfold", env!("CARGO_PKG_VERSION")))
                        .client_capabilities(
                            ClientCapabilities::new()
                                .elicitation(
                                    ElicitationCapabilities::new()
                                        .form(ElicitationFormCapabilities::new()),
                                )
                                .auth(AuthCapabilities::new().terminal(true))
                                // Pre-standard signal some agents still gate
                                // on: `_meta["terminal-auth"]: true` means
                                // auth methods may carry
                                // `_meta["terminal-auth"]` invocations.
                                .meta({
                                    let mut meta = Meta::new();
                                    meta.insert("terminal-auth".to_string(), true.into());
                                    meta.insert(
                                        "jetbrains".to_string(),
                                        serde_json::json!({
                                            "air": super::failures::capability()
                                        }),
                                    );
                                    meta
                                }),
                        );
                    let init_response = cx.send_request(init).block_task().await?;
                    let _ = init_tx.send(Ok(init_response));
                    let cwd = cwd_for_task;

                    while let Some(command) = command_rx.recv().await {
                        activity_for_task.store(now_millis_u64(), Ordering::Relaxed);
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
                            ManagerCommand::OpenSession {
                                native_session_id,
                                recorded_config,
                                config_options,
                                events,
                                result,
                            } => {
                                let outcome = pump::open_session_on_connection(
                                    &cx,
                                    &cwd,
                                    native_session_id,
                                    recorded_config,
                                    config_options,
                                    events,
                                    &sessions_for_task,
                                    &pending_permissions,
                                    ops.clone(),
                                )
                                .await;
                                let _ = result.send(outcome);
                            }
                            ManagerCommand::ListSessions { cwd, result } => {
                                let outcome = pump::list_sessions_on_connection(&cx, &cwd).await;
                                let _ = result.send(outcome);
                            }
                            ManagerCommand::DeleteSession { session_id, result } => {
                                let outcome = cx
                                    .send_request_to(Agent, DeleteSessionRequest::new(session_id))
                                    .block_task()
                                    .await
                                    .map(|_| ())
                                    .map_err(pump::describe_acp_error);
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
            // Process death or disconnect: every session on this connection
            // learns the link is gone so the UI can mark it 结果未知.
            pump::notify_connection_lost(&sessions_for_cleanup);
            supervisor::unregister_pid(
                &data_dir_for_task,
                child_pid_for_task.load(Ordering::SeqCst),
            );
            logging::info(
                "acp_client",
                format_args!("connection closed: {agent_label_for_task}"),
            );
            result
        });

        let mut starting = StartingConnection {
            connections: self.connections.clone(),
            key: key.clone(),
            state: state.clone(),
            abort: task.abort_handle(),
            complete: false,
        };

        let init_response = match tokio::time::timeout(INITIALIZE_TIMEOUT, init_rx).await {
            Ok(Ok(Ok(response))) => response,
            Ok(Ok(Err(error))) => {
                task.abort();
                let _ = self.lock()?.remove(&key);
                logging::error(
                    "acp_client",
                    format_args!("connect failed: {agent_label}: {error}"),
                );
                return Err(format!("initialize failed: {error}"));
            }
            Ok(Err(_)) => {
                task.abort();
                let _ = self.lock()?.remove(&key);
                logging::error(
                    "acp_client",
                    format_args!("connect failed: {agent_label}: exited during initialize"),
                );
                return Err("agent process exited during initialize".to_string());
            }
            Err(_) => {
                task.abort();
                let _ = self.lock()?.remove(&key);
                logging::error(
                    "acp_client",
                    format_args!("connect failed: {agent_label}: initialize timed out"),
                );
                return Err("initialize timed out".to_string());
            }
        };

        // Attribute the freshly spawned child to this connection and
        // register it for supervisor cleanup (orphan reap / exit kill).
        let data_dir = self.data_dir.clone();
        let agent_id = agent.id.clone();
        let agent_command = agent.command.clone();
        let cwd_label = cwd.to_string_lossy().into_owned();
        let pid_cell = child_pid.clone();
        tauri::async_runtime::spawn_blocking(move || {
            for pid in supervisor::child_pids(std::process::id()) {
                if !children_before.contains(&pid) {
                    supervisor::register_pid(&data_dir, &agent_id, &cwd_label, &agent_command, pid);
                    pid_cell.store(pid, Ordering::SeqCst);
                }
            }
        })
        .await
        .map_err(|_| "无法记录连接进程".to_string())?;

        let handshake_json = match serde_json::to_value(&init_response) {
            Ok(json) => json,
            Err(error) => {
                let _ = self.lock()?.remove(&key);
                return Err(format!("cannot serialize handshake: {error}"));
            }
        };
        let agent_id = agent.id.clone();
        if let Err(error) = store
            .run(move |s| s.set_agent_handshake(&agent_id, &handshake_json))
            .await
        {
            let _ = self.lock()?.remove(&key);
            return Err(error);
        }

        // The entry was reserved before spawn — fill the handshake cell and
        // report status from the live map entry.
        if handshake.set(init_response).is_err() {
            let _ = self.lock()?.remove(&key);
            return Err("handshake cell already filled (duplicate connect)".to_string());
        }
        let connections = self.lock()?;
        let connection = connections
            .get(&key)
            .ok_or_else(|| "connection entry missing after initialize".to_string())?;
        connection
            .state
            .compare_exchange(
                STATE_CONNECTING,
                STATE_READY,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .map_err(|_| "连接已结束，请重试".to_string())?;
        let status = Self::status_of(&key, connection);
        let pid = connection.child_pid.load(Ordering::SeqCst);
        logging::info(
            "acp_client",
            format_args!("connected: {agent_label} (pid {pid})"),
        );
        starting.complete = true;
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
                logging::info(
                    "acp_client",
                    format_args!("disconnect requested: {agent_id} on {}", cwd.display()),
                );
                Ok(true)
            }
        }
    }

    /// Send a request-shaped command to every ready connection of `agent_id`
    /// and wait for each reply. Errors if the agent has no live connection.
    async fn run_on_ready(
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
            match super::wait::reply(result_rx, Duration::from_secs(60), label).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => last_error = Some(error),
                Err(error) => last_error = Some(error),
            }
        }
        match last_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// `authenticate` on every live connection of `agent_id`.
    pub async fn authenticate(&self, agent_id: &str, method_id: &str) -> Result<(), String> {
        self.run_on_ready(agent_id, "authenticate", |result| {
            ManagerCommand::Authenticate {
                method_id: method_id.to_string(),
                result,
            }
        })
        .await
    }

    /// `logout` on every live connection of `agent_id`.
    pub async fn logout(&self, agent_id: &str) -> Result<(), String> {
        self.run_on_ready(agent_id, "logout", |result| ManagerCommand::Logout {
            result,
        })
        .await
    }

    /// Send shutdown to every connection, then kill every still-registered
    /// agent process (app exit path). The managed PtyManager used by login
    /// flows is stopped separately by the caller.
    pub fn stop_for_shutdown(&self) {
        if let Ok(mut connections) = self.connections.lock() {
            for (_, connection) in connections.drain() {
                let _ = connection.command_tx.send(ManagerCommand::Shutdown);
            }
        }
        supervisor::kill_all(&self.data_dir);
        logging::info("acp_client", "shutdown: all connections stopped");
    }
}

impl Default for AcpManager {
    fn default() -> Self {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        Self::new(
            home.join("Library/Logs/Farfold"),
            home.join("Library/Application Support/ai.farfold.desktop"),
        )
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

pub(crate) async fn require_agent_row(app: &AppHandle, agent_id: &str) -> Result<AgentRow, String> {
    let agent_id = agent_id.to_string();
    app.state::<MetaStore>()
        .run(move |store| {
            store
                .get_agent(&agent_id)?
                .ok_or_else(|| "找不到此 Agent".to_string())
        })
        .await
}

pub(crate) async fn validate_cwd_async(cwd: &str) -> Result<PathBuf, String> {
    let cwd = cwd.to_string();
    tauri::async_runtime::spawn_blocking(move || validate_cwd(&cwd))
        .await
        .map_err(|_| "无法读取项目目录".to_string())?
}

pub(crate) fn validate_cwd(cwd: &str) -> Result<PathBuf, String> {
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
    let row = require_agent_row(&app, &agent_id).await?;
    let cwd = validate_cwd_async(&cwd).await?;
    let manager = app.state::<AcpManager>();
    let store = app.state::<MetaStore>();
    let status = manager.connect(&row, &cwd, &store).await?;
    crate::ui_transport::emit_event(&app, "agent:status", &status);
    Ok(status)
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
    app.state::<AcpManager>()
        .authenticate(&agent_id, &method_id)
        .await
}

// ---------------------------------------------------------------------------
// Real-agent end-to-end checks — `#[ignore]`d; run manually on a machine
// with the agent installed: `cargo test e2e_ -- --ignored`.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod e2e_tests {
    use super::*;
    use crate::acp_client::pump::SessionSink;

    fn opencode_row() -> AgentRow {
        AgentRow {
            id: "opencode".to_string(),
            name: "OpenCode".to_string(),
            source: "test".to_string(),
            command: "/Users/tw/.opencode/bin/opencode".to_string(),
            args: vec!["acp".to_string()],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    /// The app's own resume path end-to-end: connect → session/new →
    /// session/load on the same native id, with pid registration +
    /// supervised shutdown around it.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires a real agent binary; run manually"]
    async fn e2e_connect_new_and_resume_session() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = MetaStore::open(&dir.path().join("farfold.sqlite3")).expect("store");
        let data_dir = dir.path().join("data");
        std::fs::create_dir_all(&data_dir).expect("data dir");
        let manager = AcpManager::new(dir.path().join("logs"), data_dir.clone());
        let cwd = Path::new("/private/tmp");
        let events: SessionSink = Arc::new(|_| {});
        let row = opencode_row();

        let opened = manager
            .open_session(&row, cwd, None, vec![], events.clone(), &store)
            .await
            .expect("session/new");

        // Resume happens on a fresh connection (restart shape): drop the
        // connection, then open by native id → session/load on a new
        // agent process.
        manager.disconnect("opencode", cwd).expect("disconnect");
        std::thread::sleep(std::time::Duration::from_millis(500));
        let resumed = manager
            .open_session(
                &row,
                cwd,
                Some(opened.session_id.clone()),
                vec![],
                events,
                &store,
            )
            .await
            .expect("session/load");
        assert_eq!(resumed.session_id, opened.session_id);

        // The spawned agent was registered in pids.json.
        let pids = std::fs::read_to_string(data_dir.join("pids.json")).expect("pids.json");
        assert!(pids.contains("\"pid\""), "{pids}");
        manager.stop_for_shutdown();
    }

    /// Fidelity check: a real prompt that writes a file must surface
    /// `tool_call` updates with `diff` content (the artifact pane's source
    /// now that client fs/terminal capabilities are off), permissions are
    /// auto-answered like the UI would, and `session/load` must replay
    /// transcript updates on a fresh connection.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "requires a real agent binary; run manually"]
    async fn e2e_prompt_tool_diff_and_replay() {
        use agent_client_protocol::schema::v1::{ContentBlock, TextContent};

        let dir = tempfile::tempdir().expect("tempdir");
        let work = dir.path().join("work");
        std::fs::create_dir_all(&work).expect("workdir");
        // Edit an existing file: `write` (create) carries no oldString so
        // agents emit no diff for it; `edit` does — that is what the
        // artifact pane renders.
        std::fs::write(work.join("e2e_probe.txt"), "old content").unwrap();
        let store = MetaStore::open(&dir.path().join("farfold.sqlite3")).expect("store");
        let manager = AcpManager::new(dir.path().join("logs"), dir.path().join("data"));
        let seen = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let seen_for_sink = seen.clone();
        let events: SessionSink = Arc::new(move |value| seen_for_sink.lock().unwrap().push(value));
        let row = opencode_row();

        let opened = manager
            .open_session(&row, &work, None, vec![], events.clone(), &store)
            .await
            .expect("session/new");
        manager
            .session_prompt(
                "opencode",
                &work,
                &opened.session_id,
                vec![ContentBlock::Text(TextContent::new(
                    "Change the contents of e2e_probe.txt to exactly \
                     \"hello\". Then reply with just: done",
                ))],
            )
            .await
            .expect("prompt sent");

        // Wait for turnEnd while auto-answering permission requests the
        // way the approval UI would (first allow* option).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(180);
        let mut answered: std::collections::HashSet<String> = Default::default();
        let mut turn_ended = false;
        while std::time::Instant::now() < deadline && !turn_ended {
            let pending: Vec<(String, String)> = seen
                .lock()
                .unwrap()
                .iter()
                .filter_map(|e| {
                    if e.get("kind")?.as_str()? != "permissionRequest" {
                        return None;
                    }
                    let request_id = e.get("requestId")?.as_str()?.to_string();
                    let option = e
                        .get("options")?
                        .as_array()?
                        .iter()
                        .find(|o| {
                            o.get("kind")
                                .and_then(serde_json::Value::as_str)
                                .is_some_and(|k| k.starts_with("allow"))
                        })?
                        .get("optionId")?
                        .as_str()?
                        .to_string();
                    Some((request_id, option))
                })
                .collect();
            for (request_id, option_id) in pending {
                if answered.insert(request_id.clone()) {
                    let _ = manager.permission_respond(&request_id, &option_id, &opened.session_id);
                }
            }
            turn_ended = seen
                .lock()
                .unwrap()
                .iter()
                .any(|e| e.get("kind").and_then(serde_json::Value::as_str) == Some("turnEnd"));
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        assert!(turn_ended, "no turnEnd within 180s");
        assert!(
            work.join("e2e_probe.txt").exists(),
            "agent did not create the probe file"
        );
        let updates = seen.lock().unwrap();
        // The artifact pane renders file writes from `type:"diff"` content
        // or, for agents that don't emit diff blocks, from an `edit`-kind
        // call whose rawInput carries filePath + new content.
        let saw_write_evidence = updates.iter().any(|e| {
            let u = match e.get("update") {
                Some(u) => u,
                None => return false,
            };
            let diff_content = u
                .get("content")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|content| {
                    content
                        .iter()
                        .any(|c| c.get("type").and_then(serde_json::Value::as_str) == Some("diff"))
                });
            let edit_input = u.get("kind").and_then(serde_json::Value::as_str) == Some("edit")
                && u.pointer("/rawInput/filePath").is_some()
                && (u.pointer("/rawInput/content").is_some()
                    || u.pointer("/rawInput/newString").is_some());
            diff_content || edit_input
        });
        if !saw_write_evidence {
            eprintln!(
                "event stream: {}",
                serde_json::to_string_pretty(&*updates).unwrap_or_default()
            );
        }
        assert!(
            saw_write_evidence,
            "no diff content or edit rawInput in event stream"
        );
        drop(updates);

        // Resume on a fresh connection: session/load must replay updates.
        manager.disconnect("opencode", &work).expect("disconnect");
        std::thread::sleep(std::time::Duration::from_millis(500));
        seen.lock().unwrap().clear();
        let resumed = manager
            .open_session(
                &row,
                &work,
                Some(opened.session_id.clone()),
                vec![],
                events,
                &store,
            )
            .await
            .expect("session/load");
        assert_eq!(resumed.session_id, opened.session_id);
        let replayed = seen.lock().unwrap().iter().any(|e| {
            matches!(
                e.pointer("/update/sessionUpdate")
                    .and_then(serde_json::Value::as_str),
                Some("user_message_chunk" | "agent_message_chunk" | "tool_call")
            )
        });
        assert!(replayed, "session/load replayed no transcript updates");
        manager.stop_for_shutdown();
    }
}
