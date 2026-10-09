//! `AcpManager`: owns each ACP process by Agent, project and selected service.
//!
//! Each connection is a spawned agent process running `initialize` once, then
//! idling on a command channel for `authenticate`/shutdown and session work
//! (`crate::acp_client::session`). All agent differences come through
//! protocol data; this module holds no agent-specific logic.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    AuthCapabilities, BooleanConfigOptionCapabilities, ClientCapabilities,
    ClientSessionCapabilities, CompactionCapabilities, ElicitationCapabilities,
    ElicitationFormCapabilities, ElicitationUrlCapabilities, Implementation, InitializeRequest,
    Meta, SessionConfigOptionsCapabilities,
};
use agent_client_protocol::{
    AcpAgent, AcpAgentConfig, Agent, Client, ConnectionTo, Dispatch, Handled, UntypedMessage,
};
use serde::Serialize;
use tauri::{AppHandle, Manager as _};
use tokio::sync::{mpsc, oneshot};

use super::handshake::Handshake;
use super::initialization::{self, Failure as InitializeFailure};
pub use super::lifecycle::CloseReason;
use super::lifecycle::{CLOSING, ConnectionLife};
pub(crate) use super::operations::Operation as AuthenticationOperation;
#[path = "account_scope.rs"]
mod account_scope;
use super::process::{ProcessControl, ProcessTransport};
use super::startup_diagnostics::{Diagnostics, Outcome};
use crate::acp_client::pump::{
    self, PendingElicitations, PendingPermissions, SessionMap, SessionOps,
};
use crate::logging;
use crate::meta_store::{AgentRow, MetaStore};
use account_scope::AccountAdmission;
pub(crate) use account_scope::{AccountScope, LaunchIdentity};

/// How long `connect` waits for `initialize` before giving up.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(60);
/// Connections with no wire or command activity for this long are
/// disconnected by the idle reaper.
const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// Idle reaper tick.
const REAPER_TICK: Duration = Duration::from_secs(60);

#[path = "connection_retention.rs"]
pub mod connection_retention;

#[path = "connection_control.rs"]
mod connection_control;

#[cfg(test)]
#[path = "startup_cleanup_tests.rs"]
mod startup_cleanup_tests;

pub enum ManagerCommand {
    Authenticate {
        method_id: String,
        key: Option<super::api_key_auth::ProtocolApiKey>,
        operation: AuthenticationOperation,
        on_unknown: std::sync::Arc<dyn Fn() + Send + Sync>,
        result: oneshot::Sender<Result<(), String>>,
    },
    Logout {
        route: super::account_logout::LogoutRoute,
        account: Arc<Mutex<Option<super::account_status::AccountIdentity>>>,
        effect_sent: Arc<AtomicBool>,
        operation: AuthenticationOperation,
        on_unknown: std::sync::Arc<dyn Fn() + Send + Sync>,
        result: oneshot::Sender<Result<(), String>>,
    },
    OpenSession {
        native_session_id: Option<String>,
        preview_token: Option<String>,
        recorded_config: Option<serde_json::Value>,
        config_store: Box<super::model_guard::ConfigStore>,
        config_options: Vec<(String, serde_json::Value)>,
        mcp: Option<super::transient_mcp::TransientMcpOpen>,
        browser_unavailable: Option<super::transient_mcp::McpUnavailable>,
        events: pump::SessionSink,
        result: oneshot::Sender<Result<super::operations::OpenDelivery, String>>,
    },
    AccountStatus {
        query: super::account_query::AccountQuery,
        result: oneshot::Sender<Result<Option<super::account_status::AccountIdentity>, String>>,
    },
    ListSessions {
        cwd: Option<PathBuf>,
        cursor: Option<String>,
        all_pages: bool,
        result: oneshot::Sender<Result<serde_json::Value, String>>,
    },
    /// `session/delete` for sessions without an open pump (agent-side rows).
    DeleteSession {
        session_id: String,
        result: oneshot::Sender<Result<(), String>>,
    },
}

impl std::fmt::Debug for ManagerCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Authenticate { .. } => "Authenticate",
            Self::Logout { .. } => "Logout",
            Self::OpenSession { .. } => "OpenSession",
            Self::ListSessions { .. } => "ListSessions",
            Self::AccountStatus { .. } => "AccountStatus",
            Self::DeleteSession { .. } => "DeleteSession",
        })
    }
}

#[path = "connection_identity.rs"]
mod connection_identity;
pub use connection_identity::{AgentConnectionStatus, ConnectionPurpose};
pub(crate) use connection_identity::{
    ConnectionKey, ManagedConnection, SessionIdentityCheck, next_connection_id,
};

pub(crate) const STATE_READY: u8 = 1;
const STATE_CLOSED: u8 = 2;
const STATE_FAILED: u8 = 3;

fn state_label(value: u8) -> &'static str {
    match value {
        STATE_READY => "ready",
        STATE_CLOSED => "closed",
        STATE_FAILED => "failed",
        CLOSING => "closing",
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

/// Owns preparation connections and one independent process per conversation.
pub struct AcpManager {
    pub(crate) shutting_down: AtomicBool,
    pub(crate) opening_sessions: super::lifecycle::OpenReservations,
    connections: Arc<Mutex<HashMap<ConnectionKey, ManagedConnection>>>,
    account_admission: AccountAdmission,
    log_dir: PathBuf,
    /// App data dir — home of `pids.json` for process supervision.
    data_dir: PathBuf,
    /// requestId → responder for pending `session/request_permission` calls
    /// across every connection. Entries are removed when answered or when
    /// their session pump exits.
    pub(crate) pending_permissions: PendingPermissions,
    /// requestId → responder for pending `elicitation/create` calls.
    pub(crate) pending_elicitations: PendingElicitations,
    status_sink: Option<Arc<dyn Fn(AgentConnectionStatus) + Send + Sync>>,
}

/// Dropping a connect future must not leave its transport or reservation behind.
struct StartingConnection {
    life: Arc<ConnectionLife>,
    complete: bool,
}
impl Drop for StartingConnection {
    fn drop(&mut self) {
        if self.complete {
            return;
        }
        let _ = self.life.close_for(true, None, CloseReason::StartupFailed);
    }
}

impl AcpManager {
    pub fn new(log_dir: PathBuf, data_dir: PathBuf) -> Self {
        let manager = Self {
            shutting_down: AtomicBool::new(false),
            opening_sessions: super::lifecycle::OpenReservations::default(),
            connections: Arc::new(Mutex::new(HashMap::new())),
            account_admission: AccountAdmission::default(),
            log_dir,
            data_dir,
            pending_permissions: PendingPermissions::default(),
            pending_elicitations: PendingElicitations::default(),
            status_sink: None,
        };
        manager.spawn_idle_reaper();
        manager
    }

    /// The sink queues UI events synchronously; it must not call back into this
    /// manager. Publishing under the map lock orders an old close before a new
    /// connection can claim the same key, without a second identity ledger.
    pub fn with_status_sink(
        mut self,
        sink: Arc<dyn Fn(AgentConnectionStatus) + Send + Sync>,
    ) -> Self {
        self.status_sink = Some(sink);
        self
    }

    /// Every minute, disconnect connections with no activity for
    /// `IDLE_TIMEOUT`, only when no view, conversation or work retains them.
    /// `loadSession` alone is not a guarantee of lossless recovery.
    fn spawn_idle_reaper(&self) {
        let connections = Arc::downgrade(&self.connections);
        std::thread::Builder::new()
            .name("acp-idle-reaper".to_string())
            .spawn(move || {
                loop {
                    std::thread::sleep(REAPER_TICK);
                    let Some(connections) = connections.upgrade() else {
                        break;
                    };
                    if let Ok(map) = connections.lock() {
                        for connection in map.values() {
                            let _ = connection.life.close(false, Some(IDLE_TIMEOUT));
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

    pub(crate) fn status_of(
        key: &ConnectionKey,
        connection: &ManagedConnection,
    ) -> AgentConnectionStatus {
        let handshake = connection.handshake.get();
        AgentConnectionStatus {
            connection_id: connection.connection_id.clone(),
            purpose: if key.conversation_id.is_some() {
                ConnectionPurpose::Conversation
            } else {
                ConnectionPurpose::Preparation
            },
            agent_id: key.agent_id.clone(),
            service_context: key.service.clone(),
            cwd: key.cwd.to_string_lossy().into_owned(),
            state: state_label(connection.state.load(Ordering::SeqCst)).to_string(),
            agent_name: handshake.and_then(|h| h.typed.agent_info.as_ref().map(|i| i.name.clone())),
            agent_version: handshake
                .and_then(|h| h.typed.agent_info.as_ref().map(|i| i.version.clone())),
            auth_methods: handshake.map(|h| h.auth_ids()).unwrap_or_default(),
            account: handshake
                .filter(|h| {
                    super::account_status::accepts(&h.public_json(), "_auth/status_update")
                        || super::account_query::AccountQuery::declared(
                            &h.public_json(),
                            connection.account_query,
                        )
                        .is_some()
                })
                .and_then(|_| connection.account.lock().ok().and_then(|a| a.clone())),
            close_reason: connection.life.close_reason(),
        }
    }

    /// `status` for every live connection of `agent_id` (all cwds).
    pub fn status(&self, agent_id: &str) -> Result<Vec<AgentConnectionStatus>, String> {
        let connections = self.lock()?;
        Ok(connections
            .iter()
            .filter(|(key, _)| key.agent_id == agent_id && !key.candidate)
            .map(|(key, connection)| Self::status_of(key, connection))
            .collect())
    }

    pub(crate) fn publish_status(&self, status: AgentConnectionStatus) {
        if let Some(sink) = &self.status_sink {
            sink(status);
        }
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
        self.connect_selected(agent, cwd, store, None, None, false)
            .await
            .map(|(status, _)| status)
    }

    /// The caller holds configuration_guard. A candidate shares the exact
    /// transport/lifecycle but cannot replace the registered target or handshake.
    #[cfg(test)]
    pub(crate) async fn probe_launch(
        &self,
        candidate: &AgentRow,
        store: &MetaStore,
        cancel: impl std::future::Future<Output = ()> + Send,
    ) -> Result<(), String> {
        self.probe_launch_diagnosed(
            candidate,
            store,
            cancel,
            self.startup_diagnostics(&candidate.id),
        )
        .await
    }

    pub(crate) fn startup_diagnostics(&self, id: &str) -> Arc<Diagnostics> {
        Diagnostics::open(&self.log_dir, id)
    }

    pub(crate) async fn probe_launch_diagnosed(
        &self,
        candidate: &AgentRow,
        store: &MetaStore,
        cancel: impl std::future::Future<Output = ()> + Send,
        diagnostics: Arc<Diagnostics>,
    ) -> Result<(), String> {
        let cwd = &self.data_dir;
        let key = ConnectionKey {
            agent_id: candidate.id.clone(),
            cwd: cwd.clone(),
            candidate: true,
            conversation_id: None,
            service: None,
        };
        let previous = self.lock()?.get(&key).cloned();
        if let Some(previous) = previous {
            previous.life.closed().await?;
        }
        let result = tokio::select! {
            biased;
            _ = cancel => { diagnostics.outcome(Outcome::Cancelled); Err("检查已取消，原设置保持不变".into()) },
            result = self.connect_launch_diagnosed(candidate, cwd, store, true, None, None, Some(diagnostics.clone())) => result.map(|_| ()),
        };
        let connection = self.lock()?.get(&key).cloned();
        if let Some(connection) = connection {
            connection
                .life
                .close_for(true, None, CloseReason::Configuration)?;
            if let Err(error) = connection.life.closed().await {
                // A confirmed unexpected exit must not overwrite the startup
                // result (or cancellation). Unknown termination and incomplete
                // cleanup still keep their existing safety error and owner.
                let finished = matches!(
                    connection.state.load(Ordering::SeqCst),
                    STATE_CLOSED | STATE_FAILED
                ) && !self.lock()?.contains_key(&key);
                if result.is_ok() || !finished {
                    return Err(error);
                }
            }
        } else if result.is_ok() {
            return Err("检查连接已意外结束，原设置保持不变".into());
        }
        if !diagnostics.candidate_files_releasable() {
            return Err("无法确认连接进程已结束".into());
        }
        if result.is_ok() {
            diagnostics.outcome(Outcome::Success);
        }
        result
    }

    pub(crate) fn candidate_pending(&self, agent_id: &str) -> Result<bool, String> {
        Ok(self.lock()?.iter().any(|(key, connection)| {
            key.agent_id == agent_id
                && key.candidate
                && !matches!(
                    connection.state.load(Ordering::SeqCst),
                    STATE_CLOSED | STATE_FAILED
                )
        }))
    }

    pub(crate) async fn connect_launch(
        &self,
        agent: &AgentRow,
        cwd: &Path,
        store: &MetaStore,
        candidate: bool,
        prepared: Option<super::service_connection::PreparedService>,
    ) -> Result<AgentConnectionStatus, String> {
        self.connect_launch_diagnosed(agent, cwd, store, candidate, prepared, None, None)
            .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn connect_launch_diagnosed(
        &self,
        agent: &AgentRow,
        cwd: &Path,
        store: &MetaStore,
        candidate: bool,
        prepared: Option<super::service_connection::PreparedService>,
        conversation_id: Option<String>,
        diagnostics: Option<Arc<Diagnostics>>,
    ) -> Result<AgentConnectionStatus, String> {
        let admission = crate::managed_update::activity()?;
        let launch_identity = LaunchIdentity::from_launch(&agent.command, &agent.args);
        let service = prepared.as_ref().map(|p| p.context.clone());
        let key = ConnectionKey {
            agent_id: agent.id.clone(),
            cwd: cwd.to_path_buf(),
            candidate,
            conversation_id,
            service: service.as_ref().map(|s| s.revision.clone()),
        };
        if let Some(connection) = self.lock()?.get(&key).cloned()
            && connection.state.load(Ordering::SeqCst) == STATE_READY
        {
            return Ok(Self::status_of(&key, &connection));
        }
        let previous = self.lock()?.get(&key).cloned();
        if let Some(previous) = previous {
            previous.life.closed().await?;
        }
        let mut environment_agent = agent.clone();
        super::preparation::apply_dependency_env(&mut environment_agent);
        let dependency_environment: Vec<_> = super::preparation::dependencies(&agent.id)
            .iter()
            .filter_map(|declaration| {
                environment_agent
                    .env
                    .iter()
                    .find(|(name, _)| name == declaration.program_env)
                    .cloned()
            })
            .collect();
        let (mut environment, service_delivery) = match prepared {
            Some(prepared) => (prepared.environment, prepared.delivery),
            None => {
                let environment = store
                    .run(move |store| {
                        crate::credentials::environment_for_launch(store, &environment_agent)
                    })
                    .await?;
                (environment, None)
            }
        };
        for (name, value) in dependency_environment {
            environment.entry(name).or_insert(value);
        }
        // This is deliberately last: prepared service and explicit row values
        // must not overwrite the selected program's process-local delivery.
        super::dependency_environment::apply(agent, cwd, &mut environment)?;
        // Reusing a READY entry above is not a new startup. Candidate callers
        // keep their observer through directory cleanup; ordinary connections
        // open one only after a new launch has actually been admitted.
        let diagnostics = diagnostics.unwrap_or_else(|| self.startup_diagnostics(&agent.id));
        let (command_tx, mut command_rx) =
            mpsc::unbounded_channel::<super::operations::QueuedCommand>();
        let (init_tx, init_rx) = oneshot::channel::<Result<Handshake, InitializeFailure>>();
        let life = ConnectionLife::new();
        life.retain_startup(admission)?;
        let state = life.state.clone();
        let browser_launch = super::browser_capability::reviewed_launch(agent);
        let process = ProcessControl::new(diagnostics.clone()).review_mcp_launch(matches!(
            browser_launch,
            Some(super::browser_capability::LaunchKind::Node)
        ));
        let sessions: SessionMap = SessionMap::default();
        let sessions_for_task = sessions.clone();
        let sessions_for_cleanup = sessions.clone();
        let pending_permissions = self.pending_permissions.clone();
        let child_pid = process.pid.clone();
        let connection_id = next_connection_id();
        let inquiries = super::elicitation::ConnectionElicitations::new(
            self.pending_elicitations.clone(),
            life.clone(),
            connection_id.clone(),
        );
        let ops = SessionOps {
            opening: None,
            connection_id: connection_id.clone(),
            verify_identity: self.session_identity_check(&key, &life),
            elicitations: self.pending_elicitations.clone(),
            inquiries: inquiries.clone(),
            life: life.clone(),
        };
        let cwd_for_task = cwd.to_path_buf();
        let agent_label = format!("{} on {}", agent.id, cwd.display());
        let agent_label_for_task = agent_label.clone();
        let handshake = Arc::new(std::sync::OnceLock::<Handshake>::new());
        let account = Arc::new(Mutex::new(None));
        let account_query = super::account_launch::reviewed(agent);

        // Reserve the key before spawning: a concurrent connect() waits on
        // this CONNECTING entry instead of starting a duplicate process.
        // The process owner releases this key only after confirmed termination.
        {
            let mut connections = self.lock()?;
            if self.shutting_down.load(Ordering::SeqCst) {
                return Err("应用正在退出，请稍后重试".into());
            }
            self.account_admission
                .check(&agent.id, launch_identity.as_ref())?;
            connections.insert(
                key.clone(),
                ManagedConnection {
                    launch_identity,
                    connection_id,
                    account: account.clone(),
                    account_query,
                    command_tx: command_tx.clone(),
                    state: state.clone(),
                    handshake: handshake.clone(),
                    sessions: sessions.clone(),
                    child_pid: child_pid.clone(),
                    browser_launch,
                    mcp_spawn_facts: process.mcp_spawn_facts.clone(),
                    life: life.clone(),
                    service: service.clone(),
                },
            );
        }

        let config = AcpAgentConfig::new(&agent.command)
            .args(agent.args.iter().cloned())
            .envs(environment);
        let transport = ProcessTransport {
            agent: AcpAgent::new(config),
            control: process.clone(),
            life: life.clone(),
            data_dir: self.data_dir.clone(),
            agent_id: agent.id.clone(),
            cwd: cwd.to_string_lossy().into_owned(),
            diagnostics: diagnostics.clone(),
        };
        let life_for_task = life.clone();
        let startup_process = process.clone();
        let connections_for_cleanup = self.connections.clone();
        let key_for_cleanup = key.clone();
        let state_for_cleanup = state.clone();
        let pending_for_cleanup = self.pending_permissions.clone();
        let forms_for_cleanup = self.pending_elicitations.clone();
        let task_diagnostics = diagnostics.clone();
        let decode_diagnostics = diagnostics.clone();
        let status_sink = self.status_sink.clone();
        let observer = super::account_observer::AccountObserver::new(
            account,
            handshake.clone(),
            self.connections.clone(),
            key.clone(),
            self.status_sink.clone(),
        );
        let receive_observer = observer.clone();
        let published_observer = observer.clone();
        runtime().spawn(async move {
            let result = Client
                .builder()
                .name("farfold")
                .on_receive_dispatch(
                    async move |dispatch: Dispatch<UntypedMessage, UntypedMessage>, _cx| {
                        if receive_observer.observe(&dispatch) {
                            return Ok(Handled::Yes);
                        }
                        let dispatch = match inquiries.dispatch(dispatch)? {
                            Handled::Yes => return Ok(Handled::Yes),
                            Handled::No { message, .. } => message,
                        };
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
                .connect_with(transport, move |cx: ConnectionTo<Agent>| async move {
                    let init = InitializeRequest::new(ProtocolVersion::V1)
                        .client_info(Implementation::new("farfold", env!("CARGO_PKG_VERSION")))
                        .client_capabilities(
                            ClientCapabilities::new()
                                .session(
                                    ClientSessionCapabilities::new().compaction(CompactionCapabilities::new()).config_options(
                                        SessionConfigOptionsCapabilities::new()
                                            .boolean(BooleanConfigOptionCapabilities::new()),
                                    ),
                                )
                                .elicitation(
                                    ElicitationCapabilities::new()
                                        .form(ElicitationFormCapabilities::new()).url(ElicitationUrlCapabilities::new()),
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
                    let init = UntypedMessage::new("initialize", &init)?;
                    let init_response = match cx.send_request(init)
                        .map(move |value| {
                            let decoded = Handshake::decode(value);
                            if decoded.is_ok() { decode_diagnostics.accepted(); }
                            decoded
                        }).block_task().await {
                        Ok(response) => response,
                        Err(error) => {
                            let _ = init_tx.send(Err(InitializeFailure::from_request(&error)));
                            return Err(error);
                        }
                    };
                    // A configured service owns this fresh process. Do not
                    // publish ready or admit session work until the official
                    // route has been declared, applied and read back. Failure
                    // cannot fall through to the Agent's saved account.
                    if let Some(delivery) = service_delivery
                        && delivery.apply(&cx, &init_response).await.is_err()
                    {
                        let _ = init_tx.send(Err(InitializeFailure::Failed));
                        return Err(agent_client_protocol::Error::internal_error());
                    }
                    let query = (!candidate).then(|| super::account_query::AccountQuery::declared(&init_response.public_json(), account_query)).flatten();
                    let _ = init_tx.send(Ok(init_response));
                    // Compatibility completes before this bounded read. Run it
                    // before queued commands so an old startup result cannot
                    // overwrite a later authenticate/refresh on this process.
                    if let Some(query) = query { observer.query(&cx, query).await; }
                    let cwd = cwd_for_task;

                    let mut stop = ops.life.stop_receiver();
                    loop {
                        let command = tokio::select! {
                            biased;
                            _ = stop.changed() => break,
                            _ = cx.incoming_closed() => break,
                            command = command_rx.recv() => match command { Some(command) => command, None => break },
                        };
                        let (cx, cwd, sessions, pending, ops) = (cx.clone(), cwd.clone(),
                            sessions_for_task.clone(), pending_permissions.clone(), ops.clone());
                        cx.clone().spawn(async move {
                            super::operations::run(command, cx, cwd, sessions, pending, ops).await;
                            Ok(())
                        })?;
                    }

                    Ok(())
                })
                .await;
            let previous_state = life_for_task.state.load(Ordering::SeqCst);
            let requested = previous_state == CLOSING;
            let fallback_reason = if previous_state == super::lifecycle::CONNECTING {
                CloseReason::StartupFailed
            } else {
                CloseReason::Unexpected
            };
            let _ = life_for_task.close_for(true, None, fallback_reason);
            let reason = life_for_task.close_reason().unwrap_or(CloseReason::Unexpected);
            process.stop();
            let process_result = process.closed().await;
            let outcome = process_result.and_then(|_| if requested { Ok(()) } else {
                result.as_ref().map(|_| ()).map_err(|_| "Agent 连接已结束".to_string())
            });
            pump::clear_connection_interactions(&pending_for_cleanup, &forms_for_cleanup, &life_for_task);
            pump::notify_connection_lost(&sessions_for_cleanup, reason);
            // Completion includes removing this exact instance. A waiter must
            // not return from disconnect while status still exposes the owner.
            let outcome = match connections_for_cleanup.lock() {
                Ok(mut map) => {
                    if map.get(&key_for_cleanup).is_some_and(|entry| Arc::ptr_eq(&entry.state, &state_for_cleanup)) {
                        if !key_for_cleanup.candidate && let Some(sink) = &status_sink {
                            let mut status = Self::status_of(&key_for_cleanup, map.get(&key_for_cleanup).unwrap());
                            status.state = if outcome.is_ok() { "closed" } else { "failed" }.into();
                            sink(status);
                        }
                        map.remove(&key_for_cleanup);
                        task_diagnostics.removed();
                    }
                    outcome
                }
                Err(_) => Err("进程已结束，但无法完成连接清理，请重新打开应用".into()),
            };
            life_for_task.finish(outcome);
            logging::info(
                "acp_client",
                format_args!("connection closed: {agent_label_for_task} ({reason:?})"),
            );
            result
        });

        let mut starting = StartingConnection {
            life: life.clone(),
            complete: false,
        };

        let init_response = match initialization::receive(init_rx, INITIALIZE_TIMEOUT).await {
            Ok(response) => response,
            Err(mut failure) => {
                if failure == InitializeFailure::Ended && startup_process.start_failed() {
                    failure = InitializeFailure::StartFailed;
                }
                diagnostics.outcome(match failure {
                    InitializeFailure::Failed => Outcome::Failed,
                    InitializeFailure::Timeout => Outcome::Timeout,
                    InitializeFailure::Ended => Outcome::Ended,
                    InitializeFailure::StartFailed => Outcome::StartFailed,
                });
                let _ = life.close_for(true, None, CloseReason::StartupFailed);
                logging::error(
                    "acp_client",
                    format_args!("connect failed: {agent_label}: {}", failure.code()),
                );
                return Err(failure.code().into());
            }
        };

        let handshake_json = init_response.public_json();
        if !candidate && service.is_none() {
            let handshake_agent = agent.clone();
            store
                .run(move |s| s.set_agent_handshake(&handshake_agent, &handshake_json))
                .await?;
        }

        // The entry was reserved before spawn — fill the handshake cell and
        // report status from the live map entry.
        if handshake.set(init_response).is_err() {
            return Err("handshake cell already filled (duplicate connect)".to_string());
        }
        published_observer.handshake_published();
        let connections = self.lock()?;
        let connection = connections
            .get(&key)
            .ok_or_else(|| "connection entry missing after initialize".to_string())?;
        connection.life.ready()?;
        let status = Self::status_of(&key, connection);
        if !candidate && let Some(sink) = &self.status_sink {
            sink(status.clone());
        }
        let pid = connection.child_pid.load(Ordering::SeqCst);
        logging::info(
            "acp_client",
            format_args!("connected: {agent_label} (pid {pid})"),
        );
        starting.complete = true;
        if !candidate {
            diagnostics.outcome(Outcome::Success);
        }
        Ok(status)
    }

    /// Route the user action to its original directory. The caller owns the
    /// account scope until this final response, including after a wait timeout.
    pub(crate) async fn authenticate(
        &self,
        agent_id: &str,
        cwd: &Path,
        method_id: &str,
        operation: AuthenticationOperation,
        on_unknown: std::sync::Arc<dyn Fn() + Send + Sync>,
    ) -> Result<(), String> {
        self.authenticate_with_key(agent_id, cwd, method_id, None, operation, on_unknown)
            .await
    }

    pub(crate) async fn logout(
        &self,
        agent_id: &str,
        cwd: &Path,
        scope: &AccountScope,
        operation: AuthenticationOperation,
        on_unknown: std::sync::Arc<dyn Fn() + Send + Sync>,
    ) -> Result<(), String> {
        let selected = self.live_connection(agent_id, cwd)?;
        if !scope.protects(&selected) {
            return Err("账号操作保护已变化，请重新操作".into());
        }
        let route = super::account_logout::LogoutRoute::for_connection(&selected)
            .ok_or("此目录的 Agent 未提供退出登录，请使用账号设置")?;
        let (result, reply) = oneshot::channel();
        let effect_sent = Arc::new(AtomicBool::new(false));
        selected.send(ManagerCommand::Logout {
            route,
            account: selected.account.clone(),
            effect_sent: effect_sent.clone(),
            operation,
            on_unknown,
            result,
        })?;
        let outcome = match reply.await {
            Ok(Err(error)) if error == "AUTH_CONNECTION_CLOSED" => {
                selected.life.terminated().await;
                Err("账号连接已结束，请重新检查账号状态".into())
            }
            Ok(outcome) => outcome,
            Err(_) => {
                selected.life.terminated().await;
                Err("账号连接已结束，请重新检查账号状态".into())
            }
        };
        if effect_sent.load(Ordering::SeqCst) {
            // An error after dispatch may follow a partial credential change,
            // including an acknowledged sign-out with an unconfirmed status
            // query. Never release old process-local copies on such an outcome.
            scope
                .retire_account_copies(outcome.as_ref().ok().map(|_| &selected))
                .await?;
        }
        if let Ok(connections) = self.lock()
            && let Some((key, connection)) = connections
                .iter()
                .find(|(_, c)| c.connection_id == selected.connection_id)
        {
            self.publish_status(Self::status_of(key, connection));
        }
        outcome
    }

    /// App exit uses the same exact owners as disconnect, with one total budget.
    /// Never release keys or trust a persisted PID list as proof of Child reap.
    pub fn stop_for_shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        let lives: Vec<_> = match self.connections.lock() {
            Ok(connections) => connections
                .values()
                .map(|entry| entry.life.clone())
                .collect(),
            Err(_) => {
                logging::warn("acp_client", "shutdown: connection state unavailable");
                return;
            }
        };
        for life in &lives {
            let _ = life.close_for(true, None, CloseReason::Shutdown);
        }
        let (completed, receive) = std::sync::mpsc::channel();
        runtime().spawn(async move {
            let result = tokio::time::timeout(Duration::from_secs(5), async {
                let mut failure = None;
                for life in lives {
                    if let Err(error) = life.closed().await {
                        failure = Some(error);
                    }
                }
                failure.map_or(Ok::<(), String>(()), Err)
            })
            .await;
            let _ = completed.send(result);
        });
        match receive.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(Ok(()))) => {
                logging::info("acp_client", "shutdown: owned processes confirmed stopped")
            }
            _ => logging::warn(
                "acp_client",
                "shutdown: process termination not confirmed; ownership records retained",
            ),
        }
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
    Ok(status)
}

/// With an ID, disconnect only that exact process. Without one, retain the
/// user-facing whole-Agent action across all directories and service sources.
#[tauri::command]
pub async fn agent_disconnect(
    app: AppHandle,
    agent_id: String,
    connection_id: Option<String>,
) -> Result<bool, String> {
    app.state::<AcpManager>()
        .disconnect_selected(&agent_id, None, connection_id.as_deref())
        .await
}

/// Live preparation and conversation connections for one Agent.
#[tauri::command]
pub fn agent_status(
    app: AppHandle,
    agent_id: String,
) -> Result<Vec<AgentConnectionStatus>, String> {
    app.state::<AcpManager>().status(&agent_id)
}

#[cfg(test)]
mod authentication_tests;

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
            command: crate::agent_discovery::find_binary(
                "opencode",
                &crate::agent_discovery::candidate_dirs(),
            )
            .expect("This manual test requires an installed OpenCode executable")
            .to_string_lossy()
            .into_owned(),
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
        store.insert_agent(&row).unwrap();

        let opened = manager
            .open_session(&row, cwd, None, vec![], events.clone(), &store)
            .await
            .expect("session/new");

        // Resume happens on a fresh connection (restart shape): drop the
        // connection, then open by native id → session/load on a new
        // agent process.
        manager
            .disconnect("opencode", cwd)
            .await
            .expect("disconnect");
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
        store.insert_agent(&row).unwrap();

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
                    "Use your file read and edit tools to replace old content in \
                     e2e_probe.txt with exactly \"hello\". Do not use shell or terminal \
                     tools. Do not modify other files. Then reply with just: done",
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
        assert_eq!(
            std::fs::read_to_string(work.join("e2e_probe.txt"))
                .unwrap()
                .trim(),
            "hello"
        );
        {
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
                        content.iter().any(|c| {
                            c.get("type").and_then(serde_json::Value::as_str) == Some("diff")
                        })
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
        }

        // Resume on a fresh connection: session/load must replay updates.
        manager
            .disconnect("opencode", &work)
            .await
            .expect("disconnect");
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
