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

/// tokio `block_on` panics inside spawn_blocking threads, so command-side
/// waits poll `try_recv` on a short sleep loop instead. Every wait has a
/// deadline — a hung agent must not hang the command handler forever.
pub(crate) fn recv_timeout<T>(
    rx: &mut oneshot::Receiver<T>,
    dur: std::time::Duration,
    label: &str,
) -> Result<T, String> {
    let deadline = std::time::Instant::now() + dur;
    loop {
        match rx.try_recv() {
            Ok(value) => return Ok(value),
            Err(oneshot::error::TryRecvError::Closed) => {
                return Err(format!("{label} 通道已关闭"));
            }
            Err(oneshot::error::TryRecvError::Empty) => {
                if std::time::Instant::now() >= deadline {
                    return Err(format!("{label}：Agent 无响应（超时）"));
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
    }
}

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
                .and_then(|connection| connection.handshake.get())
                .is_some_and(|handshake| handshake.agent_capabilities.load_session);
            if !supports_load {
                return Err("该 Agent 不支持恢复历史".to_string());
            }
        }

        let (result_tx, mut result_rx) = oneshot::channel();
        command_tx
            .send(ManagerCommand::OpenSession {
                native_session_id,
                config_options,
                events,
                result: result_tx,
            })
            .map_err(|_| "connection is closed".to_string())?;
        recv_timeout(
            &mut result_rx,
            std::time::Duration::from_secs(120),
            "session open",
        )?
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
        let (result_tx, mut result_rx) = oneshot::channel();
        control
            .send(SessionControl::Prompt {
                blocks,
                result: result_tx,
            })
            .map_err(|_| "session is closed".to_string())?;
        recv_timeout(
            &mut result_rx,
            std::time::Duration::from_secs(60),
            "session prompt",
        )?
    }

    /// `session/cancel` for a running turn.
    pub(crate) fn session_cancel(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
    ) -> Result<(), String> {
        let control = self.session_control_tx(agent_id, cwd, session_id)?;
        let (result_tx, mut result_rx) = oneshot::channel();
        control
            .send(SessionControl::Cancel { result: result_tx })
            .map_err(|_| "session is closed".to_string())?;
        recv_timeout(
            &mut result_rx,
            std::time::Duration::from_secs(10),
            "session cancel",
        )?
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
        let (result_tx, mut result_rx) = oneshot::channel();
        control
            .send(SessionControl::SetConfig {
                config_id: config_id.to_string(),
                value,
                result: result_tx,
            })
            .map_err(|_| "session is closed".to_string())?;
        recv_timeout(
            &mut result_rx,
            std::time::Duration::from_secs(30),
            "session config",
        )?
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
            let supported = connection.handshake.get().is_some_and(|handshake| {
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
        let (result_tx, mut result_rx) = oneshot::channel();
        command_tx
            .send(ManagerCommand::ListSessions {
                cwd: cwd.to_path_buf(),
                result: result_tx,
            })
            .map_err(|_| "connection is closed".to_string())?;
        let listed = recv_timeout(
            &mut result_rx,
            std::time::Duration::from_secs(30),
            "session list",
        )??;
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
        let remote_close = connection.handshake.get().is_some_and(|handshake| {
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
            let (result_tx, mut result_rx) = oneshot::channel();
            control
                .send(SessionControl::Close { result: result_tx })
                .map_err(|_| "session is closed".to_string())?;
            remote_error = recv_timeout(
                &mut result_rx,
                std::time::Duration::from_secs(15),
                "session close",
            )
            .err();
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

    /// `session/delete` agent-side. Returns `Ok(false)` when the agent does
    /// not advertise `sessionCapabilities.delete` or the session/connection
    /// is gone — callers tombstone in either case. `Ok(true)` = remote
    /// delete confirmed.
    pub(crate) fn delete_session(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
    ) -> Result<bool, String> {
        let connection = match self.live_connection(agent_id, cwd) {
            Ok(connection) => connection,
            Err(_) => return Ok(false),
        };
        let supports_delete = connection.handshake.get().is_some_and(|handshake| {
            handshake
                .agent_capabilities
                .session_capabilities
                .delete
                .is_some()
        });
        if !supports_delete {
            return Ok(false);
        }
        let control = {
            let sessions = connection
                .sessions
                .lock()
                .map_err(|_| "session map lock poisoned")?;
            sessions.get(session_id).map(|entry| entry.control.clone())
        };
        let (result_tx, mut result_rx) = oneshot::channel();
        match control {
            // Open session: delete through its pump (which then exits).
            Some(control) => control
                .send(SessionControl::Delete { result: result_tx })
                .map_err(|_| "session is closed".to_string())?,
            // Agent-side session never opened here: connection-level delete.
            None => connection
                .command_tx
                .send(ManagerCommand::DeleteSession {
                    session_id: session_id.to_string(),
                    result: result_tx,
                })
                .map_err(|_| "connection is closed".to_string())?,
        }
        recv_timeout(
            &mut result_rx,
            std::time::Duration::from_secs(30),
            "session delete",
        )??;
        connection
            .sessions
            .lock()
            .map_err(|_| "session map lock poisoned")?
            .remove(session_id);
        Ok(true)
    }

    /// Artifacts (fileDiff/terminal) produced for a session by the
    /// client-capability handlers. Memory-only — empty after reconnect.
    pub(crate) fn session_artifacts(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
    ) -> Result<Vec<Value>, String> {
        let connection = self.live_connection(agent_id, cwd)?;
        Ok(connection
            .artifacts
            .lock()
            .map_err(|_| "artifact map lock poisoned")?
            .get(session_id)
            .cloned()
            .unwrap_or_default())
    }

    /// Answer a pending `elicitation/create` (form mode).
    /// `action`: `accept` (with `content` values), `decline`, or `cancel`.
    pub(crate) fn elicitation_respond(
        &self,
        request_id: &str,
        action: &str,
        content: Option<Value>,
    ) -> Result<(), String> {
        let responder = self
            .pending_elicitations
            .lock()
            .map_err(|_| "elicitation map lock poisoned")?
            .remove(request_id)
            .ok_or_else(|| {
                "elicitation request not found (already answered or session ended)".to_string()
            })?;
        let outcome = match action {
            "accept" => serde_json::json!({
                "action": "accept",
                "content": content.unwrap_or_else(|| serde_json::json!({})),
            }),
            "decline" => serde_json::json!({"action": "decline"}),
            "cancel" => serde_json::json!({"action": "cancel"}),
            other => return Err(format!("unknown elicitation action {other}")),
        };
        responder
            .respond(outcome)
            .map_err(|error| error.to_string())
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
    /// Canonicalized cwd the session was opened under — the frontend must
    /// build its session key from this, not the raw input path.
    pub cwd: String,
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
