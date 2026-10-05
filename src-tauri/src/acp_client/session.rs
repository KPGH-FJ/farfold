//! Session layer on [`AcpManager`]: each conversation owns a process and
//! frontend event `Channel`; preparation connections only run auxiliary work;
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
    #[cfg(test)]
    pub(crate) async fn archive_session(
        &self,
        store: &MetaStore,
        row_id: String,
        archived: bool,
    ) -> Result<crate::meta_store::SessionRow, String> {
        self.archive_session_checked(store, row_id, archived, None)
            .await
    }

    pub(crate) async fn archive_session_checked(
        &self,
        store: &MetaStore,
        row_id: String,
        archived: bool,
        expected_cwd: Option<String>,
    ) -> Result<crate::meta_store::SessionRow, String> {
        let admission = crate::managed_update::activity()?;
        if !archived {
            return store
                .run(move |store| {
                    let _admission = admission;
                    store.archive_session_row(&row_id, false)
                })
                .await;
        }
        let lookup = row_id.clone();
        let row = store
            .run(move |store| store.get_session(&lookup))
            .await?
            .ok_or("未找到此对话")?;
        let directory_error = "暂时无法核对资料文件夹，请确认它可访问后再归档。";
        if !Path::new(&row.cwd).is_absolute() || row.cwd.contains('\0') {
            return Err(directory_error.into());
        }
        // Filesystem access stays off transport/UI workers. Failure is not
        // evidence that the stored spelling is already the canonical target.
        let canonical = super::manager::validate_cwd_async(&row.cwd)
            .await
            .map_err(|_| directory_error)?;
        let canonical_cwd = canonical.to_str().ok_or(directory_error)?.to_owned();
        // The UI may have checked local-only input before flushing it. Its
        // observed directory can veto admission, but can never choose a route.
        if expected_cwd.is_some_and(|expected| expected != canonical_cwd) {
            return Err(directory_error.into());
        }
        let mut directories = vec![Path::new(&row.cwd)];
        if canonical != Path::new(&row.cwd) {
            directories.push(&canonical);
        }
        // Reuse the existing restore reservation across service connections.
        // If a live pump exists, move both reservations with the command so a
        // caller timeout cannot release it before the metadata write finishes.
        let mut reservations = Vec::new();
        let mut owner: Option<ManagedConnection> = None;
        if let Some(native) = &row.native_session_id {
            for cwd in &directories {
                reservations.push(self.opening_sessions.reserve(&row.agent_id, cwd, native)?);
            }
            for cwd in directories {
                if let Some(found) = self.session_owner(&row.agent_id, cwd, native)? {
                    if owner
                        .as_ref()
                        .is_some_and(|old| !std::sync::Arc::ptr_eq(&old.life, &found.life))
                    {
                        return Err("对话连接来源不明确，请先断开后重试".into());
                    }
                    owner = Some(found);
                }
            }
        }
        if let (Some(native), Some(owner)) = (&row.native_session_id, owner) {
            let control = owner
                .sessions
                .lock()
                .map_err(|_| "无法读取对话状态")?
                .get(native)
                .ok_or("对话状态已变化，请重试")?
                .control
                .clone();
            let (result, receive) = oneshot::channel();
            control
                .send(SessionControl::Archive {
                    row: Box::new(row),
                    canonical_cwd,
                    reservations,
                    admission,
                    deadline: tokio::time::Instant::now() + std::time::Duration::from_secs(10),
                    result,
                })
                .map_err(|_| "对话状态已变化，请重试")?;
            return super::wait::reply(receive, std::time::Duration::from_secs(10), "归档")
                .await
                .map_err(|_| "归档结果尚未确认，请刷新列表后重试")?;
        }
        // No local route exists: this checks only saved Farfold-owned input,
        // not activity in an external process for which ACP has no idle query.
        store
            .run(move |store| {
                let (_reservations, _admission) = (reservations, admission);
                store.archive_session_row_in_directory(&row, &canonical_cwd)
            })
            .await
    }

    /// Ready preparation connection; never select an active conversation.
    pub(crate) fn live_connection(
        &self,
        agent_id: &str,
        cwd: &Path,
    ) -> Result<ManagedConnection, String> {
        let key = ConnectionKey {
            agent_id: agent_id.to_string(),
            cwd: cwd.to_path_buf(),
            candidate: false,
            conversation_id: None,
            service: None,
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
        let connection = self.session_connection(agent_id, cwd, session_id)?;
        let sessions = connection
            .sessions
            .lock()
            .map_err(|_| "session map lock poisoned")?;
        let entry = sessions
            .get(session_id)
            .ok_or_else(|| format!("session {session_id} is not open"))?;
        if entry.preview_token.is_some() {
            return Err("此对话正在预览，加入后再继续".into());
        }
        Ok(entry.control.clone())
    }

    /// Open a session on the `(agent_id, cwd)` connection, connecting first
    /// when needed. `native_session_id` empty → `session/new`; set →
    /// `session/load` (requires the `loadSession` capability).
    #[cfg(test)]
    pub(crate) async fn open_session(
        &self,
        agent: &AgentRow,
        cwd: &Path,
        native_session_id: Option<String>,
        config_options: Vec<(String, Value)>,
        events: SessionSink,
        store: &MetaStore,
    ) -> Result<OpenedSession, String> {
        self.open_session_selected(
            agent,
            cwd,
            native_session_id,
            config_options,
            events,
            store,
            None,
        )
        .await
    }

    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn open_session_selected(
        &self,
        agent: &AgentRow,
        cwd: &Path,
        native_session_id: Option<String>,
        config_options: Vec<(String, Value)>,
        events: SessionSink,
        store: &MetaStore,
        selection: Option<crate::credentials::ServiceSelection>,
    ) -> Result<OpenedSession, String> {
        self.open_session_owned(
            agent,
            cwd,
            native_session_id,
            config_options,
            events,
            store,
            selection,
            None,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn open_session_selected_with_mcp(
        &self,
        agent: &AgentRow,
        cwd: &Path,
        native_session_id: Option<String>,
        config_options: Vec<(String, Value)>,
        events: SessionSink,
        store: &MetaStore,
        selection: Option<crate::credentials::ServiceSelection>,
        mcp: Option<super::transient_mcp::TransientMcpOpen>,
        browser_unavailable: Option<super::transient_mcp::McpUnavailable>,
    ) -> Result<OpenedSession, String> {
        self.open_session_owned_with_mcp(
            agent,
            cwd,
            native_session_id,
            config_options,
            events,
            store,
            selection,
            None,
            mcp,
            browser_unavailable,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn open_session_owned(
        &self,
        agent: &AgentRow,
        cwd: &Path,
        native_session_id: Option<String>,
        config_options: Vec<(String, Value)>,
        events: SessionSink,
        store: &MetaStore,
        selection: Option<crate::credentials::ServiceSelection>,
        preview_token: Option<String>,
    ) -> Result<OpenedSession, String> {
        self.open_session_owned_with_mcp(
            agent,
            cwd,
            native_session_id,
            config_options,
            events,
            store,
            selection,
            preview_token,
            None,
            Some(super::transient_mcp::McpUnavailable::NotEnabledForConversation),
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn open_session_owned_with_mcp(
        &self,
        agent: &AgentRow,
        cwd: &Path,
        native_session_id: Option<String>,
        config_options: Vec<(String, Value)>,
        events: SessionSink,
        store: &MetaStore,
        selection: Option<crate::credentials::ServiceSelection>,
        preview_token: Option<String>,
        mcp: Option<super::transient_mcp::TransientMcpOpen>,
        browser_unavailable: Option<super::transient_mcp::McpUnavailable>,
    ) -> Result<OpenedSession, String> {
        use super::service_connection::{ServiceRecord, recorded_service, selection_for_open};
        let opening = Some(self.opening_sessions.reserve_open(
            &agent.id,
            cwd,
            native_session_id.as_deref(),
        )?);
        if let Some(id) = &native_session_id
            && let Some(owner) = self.session_owner(&agent.id, cwd, id)?
        {
            let sessions = owner.sessions.lock().map_err(|_| "无法读取对话状态")?;
            if preview_token.is_some()
                || sessions
                    .get(id)
                    .is_some_and(|entry| entry.preview_token.is_some())
            {
                return Err("此对话已打开，请返回正在查看的对话".into());
            }
        }
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
        let recorded = recorded_service(recorded_config.as_ref())?;
        let (selection, expected) =
            selection_for_open(native_session_id.is_some(), recorded.as_ref(), selection)?;
        let (_, command_tx) = self
            .connect_selected(agent, cwd, store, selection, expected, true)
            .await?;
        if let Some(id) = &native_session_id {
            if !command_tx
                .handshake
                .get()
                .is_some_and(|h| h.typed.agent_capabilities.load_session)
            {
                return Err("该 Agent 不支持恢复历史".into());
            }
            if let Some(previous) = self.session_owner(&agent.id, cwd, id)?
                && !std::sync::Arc::ptr_eq(&previous.state, &command_tx.state)
            {
                if previous.state.load(Ordering::SeqCst) == STATE_READY {
                    self.close_session(&agent.id, cwd, id).await?;
                } else {
                    previous.life.closed().await?;
                }
            }
        }
        // The current AgentRow/environment cannot endorse a reused process.
        // Only the exact connected process's immutable spawn facts may admit an
        // offer. Dropping a rejected offer revokes it before request serialization.
        let rejection = super::transient_mcp::launch_rejection(
            command_tx.browser_launch,
            command_tx.mcp_spawn_facts.get().copied(),
        );
        let (mcp, browser_unavailable) = if mcp.is_some() {
            match rejection {
                Some(reason) => {
                    drop(mcp);
                    (None, Some(reason))
                }
                None => (mcp, None),
            }
        } else {
            (
                None,
                browser_unavailable.or(rejection).or(Some(
                    super::transient_mcp::McpUnavailable::NotEnabledForConversation,
                )),
            )
        };
        let service_record = if native_session_id.is_some() {
            recorded
        } else {
            Some(
                command_tx
                    .service
                    .as_ref()
                    .map_or(ServiceRecord::Existing, |service| {
                        ServiceRecord::Configured {
                            identity: service.identity.clone(),
                        }
                    }),
            )
        };
        let (result_tx, result_rx) = oneshot::channel();
        command_tx.send_reserved(
            ManagerCommand::OpenSession {
                native_session_id,
                preview_token,
                recorded_config,
                config_store: Box::new(super::model_guard::ConfigStore {
                    store: store.clone(),
                    agent_id: agent.id.clone(),
                    cwd: cwd.to_string_lossy().into_owned(),
                    service_record,
                    expected_model: command_tx.service.as_ref().map(|s| s.model_id.clone()),
                    verified_permission_option: super::service_config::verified_permission_option(
                        agent,
                    ),
                }),
                config_options,
                mcp,
                browser_unavailable,
                events,
                result: result_tx,
            },
            opening,
        )?;
        super::wait::reply(
            result_rx,
            std::time::Duration::from_secs(120),
            "session open",
        )
        .await??
        .accept()
    }

    pub(crate) fn browser_tool_unavailable(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
    ) -> Option<super::transient_mcp::McpUnavailable> {
        let connection = self.session_connection(agent_id, cwd, session_id).ok()?;
        let sessions = connection.sessions.lock().ok()?;
        sessions.get(session_id)?.browser_unavailable
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
                deadline: tokio::time::Instant::now() + std::time::Duration::from_secs(60),
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
                deadline: tokio::time::Instant::now() + std::time::Duration::from_secs(30),
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
            .send(SessionControl::Cancel {
                result: result_tx,
                deadline: tokio::time::Instant::now() + std::time::Duration::from_secs(10),
            })
            .map_err(|_| "session is closed".to_string())?;
        super::wait::reply(
            result_rx,
            std::time::Duration::from_secs(10),
            "session cancel",
        )
        .await?
    }

    /// `session/set_config_option`; returns full options and the confirmed local
    /// configuration check together, after any selected-choice record is saved.
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
                deadline: tokio::time::Instant::now() + std::time::Duration::from_secs(30),
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

    pub(crate) async fn confirm_config(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        displayed: Value,
    ) -> Result<Value, String> {
        let control = self.session_control_tx(agent_id, cwd, session_id)?;
        let (result, receive) = oneshot::channel();
        control
            .send(SessionControl::ConfirmConfig {
                displayed,
                result,
                deadline: tokio::time::Instant::now() + std::time::Duration::from_secs(30),
            })
            .map_err(|_| "会话已断开，请重新连接".to_string())?;
        super::wait::reply(
            receive,
            std::time::Duration::from_secs(30),
            "confirm config",
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
                candidate: false,
                conversation_id: None,
                service: None,
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
                    .typed
                    .agent_capabilities
                    .session_capabilities
                    .list
                    .is_some()
            });
            (connection.clone(), supported)
        };
        if !supported {
            return Ok(Vec::new());
        }
        let (result_tx, result_rx) = oneshot::channel();
        command_tx.send(ManagerCommand::ListSessions {
            cwd: Some(cwd.to_path_buf()),
            cursor: None,
            all_pages: true,
            result: result_tx,
        })?;
        let listed = super::wait::reply(
            result_rx,
            std::time::Duration::from_secs(30),
            "session list",
        )
        .await??;
        Ok(listed.as_array().cloned().unwrap_or_default())
    }

    /// One explicit Agent history query. Unlike background index merging,
    /// failures and unsupported capability are never represented as an empty list.
    pub(crate) async fn discover_session_page(
        &self,
        agent_id: &str,
        connection_cwd: &Path,
        cwd: Option<&Path>,
        cursor: Option<String>,
    ) -> Result<Option<(Value, bool)>, String> {
        let connection = self.live_connection(agent_id, connection_cwd)?;
        let handshake = connection.handshake.get().ok_or("Agent 尚未连接，请重试")?;
        if handshake
            .typed
            .agent_capabilities
            .session_capabilities
            .list
            .is_none()
        {
            return Ok(None);
        }
        let can_load = handshake.typed.agent_capabilities.load_session;
        let (send, receive) = oneshot::channel();
        connection.send(ManagerCommand::ListSessions {
            cwd: cwd.map(Path::to_path_buf),
            cursor,
            all_pages: false,
            result: send,
        })?;
        let response = super::wait::reply(
            receive,
            std::time::Duration::from_secs(30),
            "session discovery",
        )
        .await??;
        Ok(Some((response, can_load)))
    }

    /// `session/close` when supported, then unregister the session locally.
    pub(crate) async fn close_session(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
    ) -> Result<(), String> {
        self.close_session_owned(agent_id, cwd, session_id, None)
            .await
    }

    pub(crate) async fn close_session_for_auth(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
    ) -> Result<(), String> {
        self.close_session_with_policy(agent_id, cwd, session_id, None, true, false)
            .await
    }

    /// A configuration recheck only releases this idle local route. The
    /// following load keeps the Agent's saved conversation and its identity.
    pub(crate) async fn detach_session_for_config_check(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        allow_already_detached: bool,
    ) -> Result<(), String> {
        let _opening = self.opening_sessions.reserve(agent_id, cwd, session_id)?;
        let Some(connection) = self.session_owner(agent_id, cwd, session_id)? else {
            return if allow_already_detached {
                self.confirmed_session_absence(agent_id, cwd, session_id)
            } else {
                Err("对话已断开，请重新连接后重试".into())
            };
        };
        if !connection
            .handshake
            .get()
            .is_some_and(|handshake| handshake.typed.agent_capabilities.load_session)
        {
            return Err("此 Agent 不支持重新读取已有对话，原内容仍保留".into());
        }
        self.close_session_with_policy(agent_id, cwd, session_id, None, false, true)
            .await
    }

    pub(crate) async fn close_session_owned(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        preview_token: Option<&str>,
    ) -> Result<(), String> {
        self.close_session_with_policy(agent_id, cwd, session_id, preview_token, false, false)
            .await
    }

    async fn close_session_with_policy(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        preview_token: Option<&str>,
        allow_absent: bool,
        local_only: bool,
    ) -> Result<(), String> {
        let _opening = preview_token
            .map(|_| self.opening_sessions.reserve(agent_id, cwd, session_id))
            .transpose()?;
        // Preview cleanup can be retried after the Agent exited or a late
        // close response removed the route. Only confirmed absence is success;
        // closing owners, lookup failures and a different token remain errors.
        let Some(connection) = self.session_owner(agent_id, cwd, session_id)? else {
            return if allow_absent {
                self.confirmed_session_absence(agent_id, cwd, session_id)
            } else if preview_token.is_some() {
                Ok(())
            } else {
                Err("会话已断开，请重新连接".into())
            };
        };
        let remote_close = !local_only
            && connection.handshake.get().is_some_and(|handshake| {
                handshake
                    .typed
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
            let Some(entry) = sessions.get(session_id) else {
                drop(sessions);
                return if allow_absent {
                    self.confirmed_session_absence(agent_id, cwd, session_id)
                } else if preview_token.is_some() {
                    Ok(())
                } else {
                    Err("此对话已经关闭".into())
                };
            };
            if entry.preview_token.as_deref() != preview_token {
                return Err("此预览已结束，请重新打开".into());
            }
            if connection.state.load(Ordering::SeqCst) != STATE_READY {
                return Err("会话已断开，请重新连接".into());
            }
            entry.control.clone()
        };
        if remote_close {
            let (result_tx, result_rx) = oneshot::channel();
            control
                .send(SessionControl::Close {
                    // The confirmed-absence retry belongs to automatic read
                    // cleanup; an explicit user close keeps its own semantics.
                    require_idle_interactions: allow_absent,
                    result: result_tx,
                    deadline: tokio::time::Instant::now() + std::time::Duration::from_secs(15),
                })
                .map_err(|_| "会话已断开，请重新连接".to_string())?;
            // The pump keeps the route reserved through an unknown outcome and
            // unregisters only after the Agent confirms the close.
            super::wait::reply(
                result_rx,
                std::time::Duration::from_secs(15),
                "session close",
            )
            .await?
        } else {
            let (result, receive) = oneshot::channel();
            control
                .send(SessionControl::Detach {
                    result,
                    deadline: tokio::time::Instant::now() + std::time::Duration::from_secs(15),
                })
                .map_err(|_| "会话已断开，请重新连接".to_string())?;
            super::wait::reply(receive, std::time::Duration::from_secs(15), "session close").await?
        }
    }

    /// An absent route alone cannot prove that a connecting or closing owner
    /// has finished. This optional retry policy never swallows lookup errors.
    fn confirmed_session_absence(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
    ) -> Result<(), String> {
        use super::lifecycle::{CLOSED, FAILED, READY};
        let owners: Vec<_> = self
            .lock()?
            .iter()
            .filter(|(key, _)| key.agent_id == agent_id && key.cwd == cwd && !key.candidate)
            .map(|(_, owner)| owner.clone())
            .collect();
        for owner in owners {
            if !matches!(owner.state.load(Ordering::SeqCst), READY | CLOSED | FAILED)
                || owner
                    .sessions
                    .lock()
                    .map_err(|_| "无法读取对话状态")?
                    .contains_key(session_id)
            {
                return Err("对话关闭结果尚未确认，请等待或重试".into());
            }
        }
        Ok(())
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
        let connection = match self.session_owner(agent_id, cwd, session_id)? {
            Some(owner) if owner.state.load(Ordering::SeqCst) == STATE_READY => owner,
            Some(_) => return Err("对话连接尚未结束，请等待后重试".into()),
            None => match self.live_connection(agent_id, cwd) {
                Ok(connection) => connection,
                Err(_) => return Ok(false),
            },
        };
        let supports_delete = connection.handshake.get().is_some_and(|handshake| {
            handshake
                .typed
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
                .send(SessionControl::Delete {
                    result: result_tx,
                    deadline: tokio::time::Instant::now() + std::time::Duration::from_secs(30),
                })
                .map_err(|_| "session is closed".to_string())?,
            // Agent-side session never opened here: connection-level delete.
            None => connection.send(ManagerCommand::DeleteSession {
                session_id: session_id.to_string(),
                result: result_tx,
            })?,
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

    /// Validate before consuming the single-use SDK responder. Failed delivery
    /// stays owned and uncertain until the interaction or connection terminates.
    pub(crate) fn elicitation_respond(
        &self,
        request_id: &str,
        session_id: &str,
        action: &str,
        content: Option<Value>,
    ) -> Result<InteractionReply, String> {
        if !["accept", "decline", "cancel"].contains(&action)
            || (action == "accept" && content.as_ref().is_some_and(|v| !v.is_object()))
        {
            return Ok(InteractionReply::new(
                "retryable",
                Some("请检查填写内容后重试"),
            ));
        }
        let mut map = self
            .pending_elicitations
            .lock()
            .map_err(|_| "无法读取待处理事项")?;
        let Some(entry) = map.get_mut(request_id) else {
            return Ok(InteractionReply::new("expired", None));
        };
        if entry.cancelled.is_cancelled() {
            map.remove(request_id);
            return Ok(InteractionReply::new("expired", None));
        }
        if entry.session_id != session_id {
            return Ok(InteractionReply::new("expired", None));
        }
        let Some(responder) = entry.responder.take() else {
            return Ok(InteractionReply::new(
                "uncertain",
                Some("答复结果尚未确认，请等待"),
            ));
        };
        let mut outcome = serde_json::json!({"action":action});
        if action == "accept" {
            outcome["content"] = content.unwrap_or_else(|| serde_json::json!({}));
        }
        match responder.respond(outcome) {
            Ok(()) => {
                map.remove(request_id);
                Ok(InteractionReply::new("submitted", None))
            }
            Err(_) => Ok(InteractionReply::new(
                "uncertain",
                Some("答复结果尚未确认，请等待"),
            )),
        }
    }

    pub(crate) fn permission_respond(
        &self,
        request_id: &str,
        option_id: &str,
        session_id: &str,
    ) -> Result<InteractionReply, String> {
        let mut pending = self
            .pending_permissions
            .lock()
            .map_err(|_| "无法读取待处理事项")?;
        let Some(request) = pending.get_mut(request_id) else {
            return Ok(InteractionReply::new("expired", None));
        };
        if request.cancelled.is_cancelled() {
            pending.remove(request_id);
            return Ok(InteractionReply::new("expired", None));
        }
        if request.session_id != session_id {
            return Ok(InteractionReply::new("expired", None));
        }
        if !request.options.iter().any(|id| id == option_id) {
            return Ok(InteractionReply::new(
                "retryable",
                Some("审批选项无效，请重新选择"),
            ));
        }
        let Some(responder) = request.responder.take() else {
            return Ok(InteractionReply::new(
                "uncertain",
                Some("答复结果尚未确认，请等待"),
            ));
        };
        match responder
            .respond(serde_json::json!({"outcome":{"outcome":"selected","optionId":option_id}}))
        {
            Ok(()) => {
                pending.remove(request_id);
                Ok(InteractionReply::new("submitted", None))
            }
            Err(_) => Ok(InteractionReply::new(
                "uncertain",
                Some("答复结果尚未确认，请等待"),
            )),
        }
    }
}

#[cfg(test)]
#[path = "session/close_tests.rs"]
mod close_tests;

#[cfg(test)]
#[path = "session/recheck_tests.rs"]
mod recheck_tests;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct InteractionReply {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<&'static str>,
}
impl InteractionReply {
    fn new(status: &'static str, message: Option<&'static str>) -> Self {
        Self { status, message }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOpenResult {
    pub connection_id: String,
    pub native_session_id: String,
    /// Canonicalized cwd the session was opened under — the frontend must
    /// build its session key from this, not the raw input path.
    pub cwd: String,
    pub config_options: Value,
    pub config_check: super::model_guard::ConfigCheck,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_config_id: Option<String>,
    pub permission_state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modes: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
    pub resumed: bool,
    pub warnings: Vec<String>,
    pub service: Option<crate::credentials::ServiceIdentity>,
    pub service_context: Option<String>,
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
