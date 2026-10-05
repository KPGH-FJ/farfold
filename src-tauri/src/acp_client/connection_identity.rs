//! Runtime-only process identities. They never enter the conversation index.
use super::*;
use std::sync::atomic::AtomicU64;

static NEXT_CONNECTION: AtomicU64 = AtomicU64::new(1);

pub(crate) type SessionIdentityCheck = Arc<
    dyn Fn(&str, bool) -> Result<Option<crate::acp_client::lifecycle::OpenReservation>, String>
        + Send
        + Sync,
>;

impl AcpManager {
    pub(crate) fn session_identity_check(
        &self,
        key: &ConnectionKey,
        life: &Arc<ConnectionLife>,
    ) -> SessionIdentityCheck {
        let connections = Arc::downgrade(&self.connections);
        let (agent_id, cwd, life) = (key.agent_id.clone(), key.cwd.clone(), life.clone());
        let openings = self.opening_sessions.clone();
        Arc::new(move |session_id, resumed| {
            if session_id.is_empty() {
                return Err("Agent 未返回有效的对话标识，请检查接入后重试".into());
            }
            // Loads already carry this reservation from admission. A new ID
            // must claim it before inspecting existing routes or saving metadata.
            let reservation = if resumed {
                None
            } else {
                let (opening, exclusive) = openings.claim(&agent_id, &cwd, Some(session_id))?;
                if !exclusive {
                    life.retain_opening(opening);
                    return Err("此对话上次打开尚未结束，请等待结果后重试".into());
                }
                Some(opening)
            };
            let connections = connections.upgrade().ok_or("连接已结束，请重试")?;
            let map = connections.lock().map_err(|_| "无法读取对话状态")?;
            for (key, connection) in map.iter() {
                if key.agent_id == agent_id
                    && key.cwd == cwd
                    && !key.candidate
                    && !Arc::ptr_eq(&life.state, &connection.state)
                    && connection
                        .sessions
                        .lock()
                        .map_err(|_| "无法读取对话状态")?
                        .contains_key(session_id)
                {
                    if let Some(reservation) = reservation {
                        life.retain_opening(reservation);
                    }
                    return Err("Agent 返回的对话标识已被使用，请先断开新连接后检查接入".into());
                }
            }
            Ok(reservation)
        })
    }
}

pub(crate) fn next_connection_id() -> String {
    format!(
        "connection-{}",
        NEXT_CONNECTION.fetch_add(1, Ordering::Relaxed)
    )
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionPurpose {
    Preparation,
    Conversation,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentConnectionStatus {
    pub connection_id: String,
    pub purpose: ConnectionPurpose,
    pub agent_id: String,
    pub cwd: String,
    /// `connecting` | `ready` | `closed` | `failed`
    pub state: String,
    pub agent_name: Option<String>,
    pub agent_version: Option<String>,
    pub auth_methods: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<crate::acp_client::account_status::AccountIdentity>,
    pub service_context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub close_reason: Option<CloseReason>,
}

#[derive(Hash, Eq, PartialEq, Clone)]
pub(crate) struct ConnectionKey {
    /// None is a reusable preparation connection; Some owns one conversation.
    pub(crate) conversation_id: Option<String>,
    pub(crate) agent_id: String,
    pub(crate) cwd: PathBuf,
    pub(crate) candidate: bool,
    pub(crate) service: Option<String>,
}

#[derive(Clone)]
pub(crate) struct ManagedConnection {
    pub(crate) connection_id: String,
    pub(crate) account: Arc<Mutex<Option<crate::acp_client::account_status::AccountIdentity>>>,
    pub(crate) command_tx: mpsc::UnboundedSender<crate::acp_client::operations::QueuedCommand>,
    pub(crate) state: Arc<AtomicU8>,
    /// Filled once `initialize` succeeds — a CONNECTING entry inserted before
    /// the task finishes carries an empty cell (connect-race guard).
    pub(crate) handshake: Arc<std::sync::OnceLock<Handshake>>,
    /// Live sessions on this connection (native session id → handle).
    /// Shared with the connection task so process death can notify every
    /// session channel.
    pub(crate) sessions: SessionMap,
    /// Spawned agent process id (`0` until attributed), for `pids.json`.
    pub(crate) child_pid: Arc<AtomicU32>,
    pub(crate) browser_launch: Option<crate::acp_client::browser_capability::LaunchKind>,
    pub(crate) mcp_spawn_facts: Arc<OnceLock<crate::acp_client::process::McpSpawnFacts>>,
    pub(crate) life: Arc<ConnectionLife>,
    pub(crate) service: Option<crate::acp_client::service_connection::ServiceContext>,
}
