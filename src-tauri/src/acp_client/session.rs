//! Session layer on [`AcpManager`]: one `(agent_id, cwd)` connection hosts
//! many sessions; every session owns a frontend event `Channel`;
//! `meta_store` keeps the Farfold-side session index (title, pin, archive).
//!
//! Wire work happens inside the connection task and the per-session pump
//! ([`crate::acp_client::pump`]); methods here only route control messages.
//! The Tauri commands live in [`crate::acp_client::session_commands`].

use std::path::Path;
use std::sync::atomic::Ordering;

use agent_client_protocol::schema::v1::ContentBlock;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::acp_client::manager::{
    AcpManager, ConnectionKey, ManagedConnection, ManagerCommand, STATE_READY,
};
use crate::acp_client::pump::{OpenedSession, SessionControl, SessionSink};
use crate::meta_store::{AgentRow, MetaStore};

impl AcpManager {
    /// Ready-state `(agent_id, cwd)` connection, or an error.
    pub(crate) fn live_connection(
        &self,
        agent_id: &str,
        cwd: &Path,
    ) -> Result<ManagedConnection, String> {
        let key = ConnectionKey {
            agent_id: agent_id.to_string(),
            cwd: cwd.to_path_buf(),
        };
        let connections = self.lock()?;
        let connection = connections
            .get(&key)
            .ok_or_else(|| format!("no live connection for {agent_id} on {}", cwd.display()))?;
        if connection.state.load(Ordering::SeqCst) != STATE_READY {
            return Err(format!("connection for {agent_id} is not ready"));
        }
        Ok(connection.clone())
    }

    fn session_control_tx(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
    ) -> Result<mpsc::UnboundedSender<SessionControl>, String> {
        let connection = self.live_connection(agent_id, cwd)?;
        let sessions = connection
            .sessions
            .lock()
            .map_err(|_| "session map lock poisoned")?;
        sessions
            .get(session_id)
            .map(|entry| entry.control.clone())
            .ok_or_else(|| format!("session {session_id} is not open"))
    }

    /// Open a session on the `(agent_id, cwd)` connection, connecting first
    /// when needed. `native_session_id` empty → `session/new`; set →
    /// `session/load` (requires the `loadSession` capability).
    pub(crate) fn open_session(
        &self,
        agent: &AgentRow,
        cwd: &Path,
        native_session_id: Option<String>,
        config_options: Vec<(String, Value)>,
        events: SessionSink,
        store: &MetaStore,
    ) -> Result<OpenedSession, String> {
        let key = ConnectionKey {
            agent_id: agent.id.clone(),
            cwd: cwd.to_path_buf(),
        };
        let command_tx = {
            let connections = self.lock()?;
            connections
                .get(&key)
                .filter(|connection| connection.state.load(Ordering::SeqCst) == STATE_READY)
                .map(|connection| connection.command_tx.clone())
        };
        let command_tx = match command_tx {
            Some(sender) => sender,
            None => {
                self.connect(agent, cwd, store)?;
                let connections = self.lock()?;
                connections
                    .get(&key)
                    .map(|connection| connection.command_tx.clone())
                    .ok_or_else(|| "connection task did not register".to_string())?
            }
        };

        if native_session_id.is_some() {
            let connections = self.lock()?;
            let supports_load = connections
                .get(&key)
                .and_then(|connection| connection.handshake.as_ref())
                .is_some_and(|handshake| handshake.agent_capabilities.load_session);
            if !supports_load {
                return Err("该 Agent 不支持恢复历史".to_string());
            }
        }

        let (result_tx, result_rx) = oneshot::channel();
        command_tx
            .send(ManagerCommand::OpenSession {
                native_session_id,
                config_options,
                events,
                result: result_tx,
            })
            .map_err(|_| "connection is closed".to_string())?;
        result_rx
            .blocking_recv()
            .map_err(|_| "session open channel closed".to_string())?
    }

    /// Send a prompt; resolves once the request is sent. Turn completion
    /// arrives on the session channel as `{kind:"turnEnd"}`.
    pub(crate) fn session_prompt(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        blocks: Vec<ContentBlock>,
    ) -> Result<(), String> {
        let control = self.session_control_tx(agent_id, cwd, session_id)?;
        let (result_tx, result_rx) = oneshot::channel();
        control
            .send(SessionControl::Prompt {
                blocks,
                result: result_tx,
            })
            .map_err(|_| "session is closed".to_string())?;
        result_rx
            .blocking_recv()
            .map_err(|_| "session prompt channel closed".to_string())?
    }

    /// `session/cancel` for a running turn.
    pub(crate) fn session_cancel(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
    ) -> Result<(), String> {
        let control = self.session_control_tx(agent_id, cwd, session_id)?;
        let (result_tx, result_rx) = oneshot::channel();
        control
            .send(SessionControl::Cancel { result: result_tx })
            .map_err(|_| "session is closed".to_string())?;
        result_rx
            .blocking_recv()
            .map_err(|_| "session cancel channel closed".to_string())?
    }

    /// `session/set_config_option`; returns the session's full configOptions.
    pub(crate) fn session_set_config(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        config_id: &str,
        value: Value,
    ) -> Result<Value, String> {
        let control = self.session_control_tx(agent_id, cwd, session_id)?;
        let (result_tx, result_rx) = oneshot::channel();
        control
            .send(SessionControl::SetConfig {
                config_id: config_id.to_string(),
                value,
                result: result_tx,
            })
            .map_err(|_| "session is closed".to_string())?;
        result_rx
            .blocking_recv()
            .map_err(|_| "session config channel closed".to_string())?
    }

    /// Agent-side `session/list` (raw `SessionInfo` objects). Empty when the
    /// connection is missing/not ready or the agent lacks the capability.
    pub(crate) fn agent_session_list(
        &self,
        agent_id: &str,
        cwd: &Path,
    ) -> Result<Vec<Value>, String> {
        let (command_tx, supported) = {
            let key = ConnectionKey {
                agent_id: agent_id.to_string(),
                cwd: cwd.to_path_buf(),
            };
            let connections = self.lock()?;
            let Some(connection) = connections.get(&key) else {
                return Ok(Vec::new());
            };
            if connection.state.load(Ordering::SeqCst) != STATE_READY {
                return Ok(Vec::new());
            }
            let supported = connection.handshake.as_ref().is_some_and(|handshake| {
                handshake
                    .agent_capabilities
                    .session_capabilities
                    .list
                    .is_some()
            });
            (connection.command_tx.clone(), supported)
        };
        if !supported {
            return Ok(Vec::new());
        }
        let (result_tx, result_rx) = oneshot::channel();
        command_tx
            .send(ManagerCommand::ListSessions {
                cwd: cwd.to_path_buf(),
                result: result_tx,
            })
            .map_err(|_| "connection is closed".to_string())?;
        let listed = result_rx
            .blocking_recv()
            .map_err(|_| "session list channel closed".to_string())??;
        Ok(listed.as_array().cloned().unwrap_or_default())
    }

    /// `session/close` when supported, then unregister the session locally.
    pub(crate) fn close_session(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
    ) -> Result<(), String> {
        let connection = self.live_connection(agent_id, cwd)?;
        let remote_close = connection.handshake.as_ref().is_some_and(|handshake| {
            handshake
                .agent_capabilities
                .session_capabilities
                .close
                .is_some()
        });
        let control = {
            let sessions = connection
                .sessions
                .lock()
                .map_err(|_| "session map lock poisoned")?;
            sessions
                .get(session_id)
                .map(|entry| entry.control.clone())
                .ok_or_else(|| format!("session {session_id} is not open"))?
        };
        // Unregister locally regardless of the remote outcome: a session the
        // UI cannot reach is worse than a ghost entry agent-side.
        let mut remote_error = None;
        if remote_close {
            let (result_tx, result_rx) = oneshot::channel();
            control
                .send(SessionControl::Close { result: result_tx })
                .map_err(|_| "session is closed".to_string())?;
            remote_error = match result_rx.blocking_recv() {
                Ok(Ok(())) => None,
                Ok(Err(error)) => Some(error),
                Err(_) => Some("session close channel closed".to_string()),
            };
        } else {
            let _ = control.send(SessionControl::Shutdown);
        }
        connection
            .sessions
            .lock()
            .map_err(|_| "session map lock poisoned")?
            .remove(session_id);
        match remote_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// Answer a pending `session/request_permission`.
    pub(crate) fn permission_respond(
        &self,
        request_id: &str,
        option_id: &str,
    ) -> Result<(), String> {
        let responder = self
            .pending_permissions
            .lock()
            .map_err(|_| "permission map lock poisoned")?
            .remove(request_id)
            .ok_or_else(|| {
                "permission request not found (already answered or session ended)".to_string()
            })?;
        responder
            .respond(serde_json::json!({
                "outcome": {"outcome": "selected", "optionId": option_id}
            }))
            .map_err(|error| error.to_string())
    }
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOpenResult {
    pub native_session_id: String,
    pub config_options: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modes: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
    pub resumed: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListEntry {
    /// meta_store row id when Farfold tracks this session.
    pub id: Option<String>,
    pub native_session_id: String,
    pub title: Option<String>,
    /// Epoch millis; `None` when neither side knows.
    pub updated_at: Option<i64>,
    /// `agent` when the agent's `session/list` reported it, else `farfold`.
    pub source: String,
    pub pinned: bool,
    pub archived: bool,
}
