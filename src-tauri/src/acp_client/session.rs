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
    pub(crate) async fn open_session(
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
                self.connect(agent, cwd, store).await?;
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

        let (result_tx, result_rx) = oneshot::channel();
        let recorded_config = if let Some(id) = &native_session_id {
            let row_id =
                super::session_index::session_row_id(&agent.id, &cwd.to_string_lossy(), id);
            store
                .run(move |store| {
                    Ok(store
                        .get_session(&row_id)?
                        .and_then(|row| row.config_options))
                })
                .await?
        } else {
            None
        };
        command_tx
            .send(ManagerCommand::OpenSession {
                native_session_id,
                recorded_config,
                config_options,
                events,
                result: result_tx,
            })
            .map_err(|_| "connection is closed".to_string())?;
        super::wait::reply(
            result_rx,
            std::time::Duration::from_secs(120),
            "session open",
        )
        .await?
    }

    /// Send a prompt; resolves once the request is sent. Turn completion
    /// arrives on the session channel as `{kind:"turnEnd"}`.
    /// Send `session/prompt`. Errors prefixed `FAILED:` mean the request
    /// provably never reached the wire (no connection, dead pump, dispatch
    /// error); bare `Err` means the answer timed out or the channel closed
    /// mid-flight — genuinely unknown whether the agent saw it.
    pub(crate) async fn session_prompt(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        blocks: Vec<ContentBlock>,
    ) -> Result<(), String> {
        let control = self
            .session_control_tx(agent_id, cwd, session_id)
            .map_err(|error| format!("FAILED: {error}"))?;
        let (result_tx, result_rx) = oneshot::channel();
        control
            .send(SessionControl::Prompt {
                blocks,
                result: result_tx,
            })
            .map_err(|_| "FAILED: session is closed".to_string())?;
        super::wait::reply(
            result_rx,
            std::time::Duration::from_secs(60),
            "session prompt",
        )
        .await?
        .map_err(|error| format!("FAILED: {error}"))
    }

    /// `session/set_mode` for agents exposing `modes` outside
    /// `configOptions`.
    pub(crate) async fn session_set_mode(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        mode_id: &str,
    ) -> Result<(), String> {
        let control = self.session_control_tx(agent_id, cwd, session_id)?;
        let (result_tx, result_rx) = oneshot::channel();
        control
            .send(SessionControl::SetMode {
                mode_id: mode_id.to_string(),
                result: result_tx,
            })
            .map_err(|_| "session is closed".to_string())?;
        super::wait::reply(
            result_rx,
            std::time::Duration::from_secs(30),
            "session set_mode",
        )
        .await?
    }

    /// `session/cancel` for a running turn.
    pub(crate) async fn session_cancel(
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
        super::wait::reply(
            result_rx,
            std::time::Duration::from_secs(10),
            "session cancel",
        )
        .await?
    }

    /// `session/set_config_option`; returns the session's full configOptions.
    pub(crate) async fn session_set_config(
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
        super::wait::reply(
            result_rx,
            std::time::Duration::from_secs(30),
            "session config",
        )
        .await?
    }

    /// Agent-side `session/list` (raw `SessionInfo` objects). Empty when the
    /// connection is missing/not ready or the agent lacks the capability.
    pub(crate) async fn agent_session_list(
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
        let (result_tx, result_rx) = oneshot::channel();
        command_tx
            .send(ManagerCommand::ListSessions {
                cwd: cwd.to_path_buf(),
                result: result_tx,
            })
            .map_err(|_| "connection is closed".to_string())?;
        let listed = super::wait::reply(
            result_rx,
            std::time::Duration::from_secs(30),
            "session list",
        )
        .await??;
        Ok(listed.as_array().cloned().unwrap_or_default())
    }

    /// `session/close` when supported, then unregister the session locally.
    pub(crate) async fn close_session(
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
            let (result_tx, result_rx) = oneshot::channel();
            control
                .send(SessionControl::Close { result: result_tx })
                .map_err(|_| "session is closed".to_string())?;
            remote_error = super::wait::reply(
                result_rx,
                std::time::Duration::from_secs(15),
                "session close",
            )
            .await
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
    pub(crate) async fn delete_session(
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
        let (result_tx, result_rx) = oneshot::channel();
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
        super::wait::reply(
            result_rx,
            std::time::Duration::from_secs(30),
            "session delete",
        )
        .await??;
        connection
            .sessions
            .lock()
            .map_err(|_| "session map lock poisoned")?
            .remove(session_id);
        Ok(true)
    }

    /// Answer a pending `elicitation/create` (form mode).
    /// `action`: `accept` (with `content` values), `decline`, or `cancel`.
    pub(crate) fn elicitation_respond(
        &self,
        request_id: &str,
        action: &str,
        content: Option<Value>,
    ) -> Result<(), String> {
        let entry = self
            .pending_elicitations
            .lock()
            .map_err(|_| "elicitation map lock poisoned")?
            .remove(request_id)
            .ok_or_else(|| {
                "elicitation request not found (already answered or session ended)".to_string()
            })?;
        entry.open_requests.fetch_sub(1, Ordering::Relaxed);
        let outcome = match action {
            "accept" => serde_json::json!({
                "action": "accept",
                "content": content.unwrap_or_else(|| serde_json::json!({})),
            }),
            "decline" => serde_json::json!({"action": "decline"}),
            "cancel" => serde_json::json!({"action": "cancel"}),
            other => return Err(format!("unknown elicitation action {other}")),
        };
        entry
            .responder
            .respond(outcome)
            .map_err(|error| error.to_string())
    }

    /// Answer a pending `session/request_permission`.
    pub(crate) fn permission_respond(
        &self,
        request_id: &str,
        option_id: &str,
        session_id: &str,
    ) -> Result<(), String> {
        let mut pending = self
            .pending_permissions
            .lock()
            .map_err(|_| "无法处理审批")?;
        let request = pending.get(request_id).ok_or("审批已结束")?;
        if request.session_id != session_id || !request.options.iter().any(|id| id == option_id) {
            return Err("审批选项无效".into());
        }
        let request = pending.remove(request_id).ok_or("审批已结束")?;
        request.open_requests.fetch_sub(1, Ordering::Relaxed);
        request
            .responder
            .respond(serde_json::json!({"outcome":{"outcome":"selected","optionId":option_id}}))
            .map_err(|_| "无法提交审批，请重试".into())
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
