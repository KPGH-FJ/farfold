//! Session layer on [`AcpManager`]: each conversation owns a process and
//! frontend event `Channel`; preparation connections only run auxiliary work;
//! `meta_store` keeps the Farfold-side session index (title, pin, archive).
//!
//! Wire work happens inside the connection task and the per-session pump
//! ([`crate::acp_client::pump`]); methods here only route control messages.
//! The Tauri commands live in [`crate::acp_client::session_commands`].

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use agent_client_protocol::schema::v1::ContentBlock;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::acp_client::handshake::Handshake;
use crate::acp_client::manager::{
    AcpManager, ConnectionKey, ManagedConnection, ManagerCommand, STATE_READY,
};
use crate::acp_client::mutation::DeleteFailure;
use crate::acp_client::pump::{OpenedSession, SessionControl, SessionSink};
use crate::meta_store::{AgentRow, MetaStore};

#[cfg(test)]
#[path = "session/readonly_admission_tests.rs"]
mod readonly;

async fn open_reply<T>(
    receive: oneshot::Receiver<T>,
    duration: std::time::Duration,
) -> Result<T, String> {
    // This covers the whole opening result, including post-new/load setup.
    // A caller deadline or closed receiver does not settle unknown Agent work.
    super::wait::reply_typed(receive, duration)
        .await
        .map_err(|failure| match failure {
            super::wait::ReplyFailure::Timeout => super::operations::OPEN_WAIT_TIMEOUT.to_owned(),
            super::wait::ReplyFailure::Closed => "AGENT_OPEN_CLOSED".to_owned(),
        })
}

#[cfg(test)]
mod open_reply_tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    #[derive(Debug)]
    struct Receipt(Arc<AtomicUsize>);
    impl Drop for Receipt {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn open_reply_timeout_is_fixed_and_late_receipt_returns_to_sender() {
        let (send, receive) = oneshot::channel::<Result<Receipt, String>>();
        let failure = open_reply(receive, Duration::from_millis(1))
            .await
            .unwrap_err();
        assert_eq!(failure, "AGENT_OPEN_TIMEOUT");
        let drops = Arc::new(AtomicUsize::new(0));
        let receipt = send.send(Ok(Receipt(drops.clone()))).unwrap_err().unwrap();
        assert!(Arc::ptr_eq(&receipt.0, &drops));
        assert_eq!(drops.load(Ordering::SeqCst), 0);
        drop(receipt);
        assert_eq!(drops.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn open_reply_closed_is_fixed_without_a_remote_error() {
        let (send, receive) = oneshot::channel::<()>();
        drop(send);
        assert_eq!(
            open_reply(receive, Duration::from_secs(1)).await,
            Err("AGENT_OPEN_CLOSED".to_owned())
        );
    }

    #[tokio::test]
    async fn open_reply_keeps_delayed_success_and_inner_manager_errors() {
        for outcome in [Ok(7), Err("controlled Manager/SDK failure".to_owned())] {
            let (send, receive) = oneshot::channel();
            let expected = outcome.clone();
            let sending = tokio::spawn(async move {
                tokio::task::yield_now().await;
                send.send(outcome).unwrap();
            });
            assert_eq!(
                open_reply(receive, Duration::from_secs(1)).await.unwrap(),
                expected
            );
            sending.await.unwrap();
        }
    }
}

fn session_control(
    connection: &ManagedConnection,
    session_id: &str,
) -> Result<mpsc::UnboundedSender<SessionControl>, String> {
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

fn embedded_context_admission(
    handshake: Option<&Handshake>,
    blocks: &[ContentBlock],
) -> Result<(), &'static str> {
    if !blocks
        .iter()
        .any(|block| matches!(block, ContentBlock::Resource(_)))
    {
        return Ok(());
    }
    let handshake = handshake.ok_or("FAILED:PROMPT_EMBEDDED_CONTEXT_UNKNOWN")?;
    if !handshake
        .typed
        .agent_capabilities
        .prompt_capabilities
        .embedded_context
    {
        return Err("FAILED:PROMPT_EMBEDDED_CONTEXT_UNSUPPORTED");
    }
    Ok(())
}

fn audio_admission(
    handshake: Option<&Handshake>,
    blocks: &[ContentBlock],
) -> Result<(), &'static str> {
    if !blocks
        .iter()
        .any(|block| matches!(block, ContentBlock::Audio(_)))
    {
        return Ok(());
    }
    let handshake = handshake.ok_or("FAILED:PROMPT_AUDIO_UNKNOWN")?;
    if !handshake.typed.agent_capabilities.prompt_capabilities.audio {
        return Err("FAILED:PROMPT_AUDIO_UNSUPPORTED");
    }
    let mut total = 0u64;
    for block in blocks {
        if let ContentBlock::Audio(audio) = block {
            let size = crate::file_delivery::prompt_audio_bytes(&audio.data, &audio.mime_type)
                .map_err(|error| match error.code {
                    "limit" => "FAILED:PROMPT_AUDIO_LIMIT",
                    "durationLimit" => "FAILED:PROMPT_AUDIO_DURATION_LIMIT",
                    "unsupported" => "FAILED:PROMPT_AUDIO_FORMAT_UNSUPPORTED",
                    _ => "FAILED:PROMPT_AUDIO_INVALID",
                })?;
            total += size;
            if total > crate::file_delivery::MAX_AUDIO_BYTES {
                return Err("FAILED:PROMPT_AUDIO_LIMIT");
            }
        }
    }
    Ok(())
}

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

    /// A READY same-directory declaration for read-only display while no
    /// preparation connection exists. The preparation connection wins when
    /// present; otherwise a conversation connection may be borrowed.
    /// Candidates and service-scoped connections never qualify, and the
    /// borrowed handshake must not be used for execution.
    pub(crate) fn borrowable_handshake(
        &self,
        agent_id: &str,
        cwd: &Path,
    ) -> Option<Arc<std::sync::OnceLock<Handshake>>> {
        let connections = self.lock().ok()?;
        let mut conversation = None;
        for (key, connection) in connections.iter() {
            if key.agent_id != agent_id
                || key.cwd != cwd
                || key.candidate
                || key.service.is_some()
                || connection.state.load(Ordering::SeqCst) != STATE_READY
                || connection.handshake.get().is_none()
            {
                continue;
            }
            if key.conversation_id.is_none() {
                return Some(connection.handshake.clone());
            }
            if conversation.is_none() {
                conversation = Some(connection.handshake.clone());
            }
        }
        conversation
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
        session_control(&connection, session_id)
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
        self.open_session_owned_for_purpose(
            agent,
            cwd,
            native_session_id,
            config_options,
            events,
            store,
            selection,
            None,
            super::open_purpose::OpenPurpose::Conversation,
            None,
            None,
        )
        .await
    }

    #[cfg(test)]
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
        let history = if let Some(native) = &native_session_id {
            Some(
                self.admit_cold_history_for_test(
                    agent,
                    cwd,
                    native,
                    &config_options,
                    store,
                    selection.as_ref(),
                )
                .await?,
            )
        } else {
            None
        };
        self.open_session_admitted_with_mcp(
            agent,
            cwd,
            native_session_id,
            config_options,
            events,
            store,
            selection,
            mcp,
            browser_unavailable,
            history,
            None,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) async fn open_session_admitted_with_mcp(
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
        history: Option<super::history_admission::Permit>,
        opening_token: Option<String>,
    ) -> Result<OpenedSession, String> {
        if native_session_id.is_some() && history.is_none() {
            return Err("无法确认读取许可，本次尚未开始".into());
        }
        self.open_session_owned_with_mcp(
            agent,
            cwd,
            native_session_id,
            config_options,
            events,
            store,
            selection,
            None,
            super::open_purpose::OpenPurpose::Conversation,
            mcp,
            browser_unavailable,
            None,
            history,
            opening_token,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) async fn open_session_owned_for_purpose(
        &self,
        agent: &AgentRow,
        cwd: &Path,
        native_session_id: Option<String>,
        config_options: Vec<(String, Value)>,
        events: SessionSink,
        store: &MetaStore,
        selection: Option<crate::credentials::ServiceSelection>,
        preview_token: Option<String>,
        purpose: super::open_purpose::OpenPurpose,
        history: Option<super::history_admission::Permit>,
        opening_token: Option<String>,
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
            purpose,
            None,
            Some(super::transient_mcp::McpUnavailable::NotEnabledForConversation),
            None,
            history,
            opening_token,
        )
        .await
    }

    /// Transfer the already held fork identity; do not release/reacquire it.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn open_session_reserved(
        &self,
        agent: &AgentRow,
        cwd: &Path,
        native_session_id: String,
        events: SessionSink,
        store: &MetaStore,
        reservation: super::lifecycle::OpenReservation,
        history: Option<super::history_admission::Permit>,
        opening_token: Option<String>,
    ) -> Result<OpenedSession, String> {
        self.open_session_owned_with_mcp(
            agent,
            cwd,
            Some(native_session_id),
            vec![],
            events,
            store,
            None,
            None,
            super::open_purpose::OpenPurpose::Conversation,
            None,
            Some(super::transient_mcp::McpUnavailable::NotEnabledForConversation),
            Some(reservation),
            history,
            opening_token,
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
        purpose: super::open_purpose::OpenPurpose,
        mcp: Option<super::transient_mcp::TransientMcpOpen>,
        browser_unavailable: Option<super::transient_mcp::McpUnavailable>,
        reserved: Option<super::lifecycle::OpenReservation>,
        history: Option<super::history_admission::Permit>,
        opening_token: Option<String>,
    ) -> Result<OpenedSession, String> {
        use super::service_connection::{ServiceRecord, recorded_service, selection_for_open};
        purpose.validate(
            native_session_id.as_deref(),
            preview_token.as_deref(),
            config_options.is_empty(),
            mcp.is_some(),
        )?;
        let fork_owned = reserved.is_some();
        let opening = Some(match reserved {
            Some(reservation) => reservation,
            None => {
                self.opening_sessions
                    .reserve_open(&agent.id, cwd, native_session_id.as_deref())?
            }
        });
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
                    store.require_mcp_ready(&row_id)?;
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
            .connect_selected_owned(
                agent,
                cwd,
                store,
                selection,
                expected,
                true,
                history.clone(),
            )
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
        let rejection = super::browser_capability::rejection(agent, &command_tx, mcp.as_ref());
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
        let _history_delivery = history.clone();
        command_tx.send_reserved_with_history(
            ManagerCommand::OpenSession {
                fork_owned,
                purpose,
                native_session_id,
                preview_token,
                opening_token,
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
            history,
        )?;
        if fork_owned {
            return result_rx
                .await
                .map_err(|_| "新对话读取结果尚未确认".to_string())??
                .accept();
        }
        open_reply(result_rx, std::time::Duration::from_secs(120))
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
    /// provably never reached the SDK offer (no connection, dead pump or
    /// pre-offer rejection); bare `Err` means registration failed, timed out, or closed
    /// mid-flight — genuinely unknown whether the agent saw it.
    pub(super) async fn send_granted_prompt(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        blocks: Vec<ContentBlock>,
        grant: super::active_prompt::Granted,
    ) -> Result<(), super::active_prompt::DispatchFailure> {
        // Declarations and the sending entry belong to this one actual owner;
        // cached cards and preparation connections cannot authorize this prompt.
        let connection = self
            .session_connection(agent_id, cwd, session_id)
            .map_err(|_| "FAILED: SESSION_UNAVAILABLE".to_string())?;
        if connection.connection_id != grant.connection_id || session_id != grant.session_id {
            return Err("FAILED: SESSION_UNAVAILABLE".to_string().into());
        }
        let control =
            session_control(&connection, session_id).map_err(|error| format!("FAILED: {error}"))?;
        embedded_context_admission(connection.handshake.get(), &blocks)?;
        audio_admission(connection.handshake.get(), &blocks)?;
        let deadline = grant.deadline;
        let (result_tx, result_rx) = oneshot::channel();
        control
            .send(SessionControl::Prompt {
                blocks,
                grant: Box::new(grant),
                result: result_tx,
            })
            .map_err(|_| "FAILED: session is closed".to_string())?;
        match tokio::time::timeout_at(deadline, result_rx).await {
            Ok(Ok(super::active_prompt::DispatchResult::Rejected(error))) => {
                Err(format!("FAILED: {error}").into())
            }
            Ok(Ok(super::active_prompt::DispatchResult::Offered(result))) => {
                result.map_err(super::active_prompt::DispatchFailure::Error)
            }
            Ok(Err(_)) => Err(super::active_prompt::DispatchFailure::Error(
                "session prompt channel closed".into(),
            )),
            Err(_) => Err(super::active_prompt::DispatchFailure::Deadline),
        }
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

    /// Exact task control stays on its original live connection.
    pub(crate) async fn session_stop_task(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        connection_id: &str,
        task_id: &str,
    ) -> Result<Value, String> {
        let connection = self.session_connection(agent_id, cwd, session_id)?;
        if connection.connection_id != connection_id {
            return Err("对话状态已变化，无法停止此任务".into());
        }
        let control = self.session_control_tx(agent_id, cwd, session_id)?;
        let (result, receive) = oneshot::channel();
        control
            .send(SessionControl::StopTask {
                connection_id: connection_id.into(),
                task_id: task_id.into(),
                result,
                deadline: tokio::time::Instant::now() + std::time::Duration::from_secs(10),
            })
            .map_err(|_| "对话连接已结束".to_string())?;
        super::wait::reply(receive, std::time::Duration::from_secs(11), "停止任务").await?
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

    #[cfg(test)]
    pub(crate) async fn confirm_config(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        displayed: Value,
    ) -> Result<Value, String> {
        self.confirm_config_selection(agent_id, cwd, session_id, displayed, None, None)
            .await
    }

    pub(crate) async fn confirm_config_selection(
        &self,
        agent_id: &str,
        cwd: &Path,
        session_id: &str,
        displayed: Value,
        connection_id: Option<String>,
        restore_selection: Option<Value>,
    ) -> Result<Value, String> {
        let restore = restore_selection.is_some();
        let control = self
            .session_control_tx(agent_id, cwd, session_id)
            .map_err(|error| {
                super::restore_confirmation::Code::RouteUnavailable.for_restore(restore, error)
            })?;
        let (result, receive) = oneshot::channel();
        control
            .send(SessionControl::ConfirmConfig {
                displayed,
                connection_id,
                restore_selection,
                result,
                deadline: tokio::time::Instant::now() + std::time::Duration::from_secs(30),
            })
            .map_err(|_| {
                super::restore_confirmation::Code::ControlSend
                    .for_restore(restore, "会话已断开，请重新连接".into())
            })?;
        super::restore_confirmation::reply(receive, std::time::Duration::from_secs(30), restore)
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
    ) -> Result<(Option<Value>, bool), String> {
        let connection = self.live_connection(agent_id, connection_cwd)?;
        let handshake = connection.handshake.get().ok_or("Agent 尚未连接，请重试")?;
        let can_load = handshake.typed.agent_capabilities.load_session;
        if handshake
            .typed
            .agent_capabilities
            .session_capabilities
            .list
            .is_none()
        {
            return Ok((None, can_load));
        }
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
        Ok((Some(response), can_load))
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
        let (control, browser) = {
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
            (entry.control.clone(), entry.browser_requests.owner())
        };
        if !local_only && let Some(browser) = browser {
            browser.clone().prepare_close().await?;
            let current = self
                .session_owner(agent_id, cwd, session_id)?
                .ok_or("当前对话已变化")?;
            if current.connection_id != connection.connection_id
                || !Arc::ptr_eq(&current.state, &connection.state)
                || current.state.load(Ordering::SeqCst) != STATE_READY
                || !current
                    .sessions
                    .lock()
                    .map_err(|_| "无法读取对话状态")?
                    .get(session_id)
                    .is_some_and(|e| {
                        e.preview_token.as_deref() == preview_token
                            && e.control.same_channel(&control)
                            && e.browser_requests
                                .owner()
                                .is_none_or(|current| Arc::ptr_eq(&current, &browser))
                    })
            {
                return Err("当前对话已变化".into());
            }
        }
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
    ) -> Result<bool, DeleteFailure> {
        let (connection, has_owner) = match self
            .session_owner(agent_id, cwd, session_id)
            .map_err(|_| DeleteFailure::NotDispatched)?
        {
            Some(owner) if owner.state.load(Ordering::SeqCst) == STATE_READY => (owner, true),
            Some(_) => return Err(DeleteFailure::NotDispatched),
            None => match self.live_connection(agent_id, cwd) {
                Ok(connection) => (connection, false),
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
                .map_err(|_| DeleteFailure::NotDispatched)?;
            sessions.get(session_id).map(|entry| entry.control.clone())
        };
        let wait = std::time::Duration::from_secs(30);
        match control {
            // Open session: delete through its pump (which then exits).
            Some(control) => {
                let (result, receive) = oneshot::channel();
                control
                    .send(SessionControl::Delete {
                        result,
                        deadline: tokio::time::Instant::now() + wait,
                    })
                    .map_err(|_| DeleteFailure::NotDispatched)?;
                super::wait::reply(receive, wait, "session delete")
                    .await
                    .map_err(DeleteFailure::Unconfirmed)??;
            }
            // Do not fall through to a connection-level delete after losing the pump.
            None if has_owner => return Err(DeleteFailure::NotDispatched),
            // Agent-side session never opened here: connection-level delete.
            None => {
                let (result, receive) = oneshot::channel();
                connection
                    .send(ManagerCommand::DeleteSession {
                        session_id: session_id.to_string(),
                        result,
                    })
                    .map_err(|_| DeleteFailure::NotDispatched)?;
                super::wait::reply(receive, wait, "session delete")
                    .await
                    .and_then(|outcome| outcome)
                    .map_err(DeleteFailure::Unconfirmed)?;
            }
        }
        connection
            .sessions
            .lock()
            .map_err(|_| DeleteFailure::Unconfirmed("session map lock poisoned".into()))?
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
        super::elicitation::respond(
            &self.pending_elicitations,
            request_id,
            Some(session_id),
            None,
            action,
            content,
        )
    }

    #[cfg(test)]
    pub(crate) fn permission_respond(
        &self,
        request_id: &str,
        option_id: &str,
        session_id: &str,
    ) -> Result<InteractionReply, String> {
        self.permission_respond_owned(request_id, Some(option_id), Some(session_id), None)
    }

    pub(crate) fn permission_respond_owned(
        &self,
        request_id: &str,
        option_id: Option<&str>,
        session_id: Option<&str>,
        owner: Option<&Value>,
    ) -> Result<InteractionReply, String> {
        let mut pending = self
            .pending_permissions
            .lock()
            .map_err(|_| "无法读取待处理事项")?;
        let Some(request) = pending.get_mut(request_id) else {
            return Ok(InteractionReply::new("expired", None));
        };
        // Opening replies retain the actual connection/session/request owner.
        // Existing established callers still prove their native session ID.
        if session_id.is_some_and(|id| id != request.session_id)
            || match owner {
                Some(owner) => owner != &request.owner,
                None => session_id != Some(request.session_id.as_str()),
            }
        {
            return Ok(InteractionReply::new("expired", None));
        }
        if request.cancelled.is_cancelled() {
            pending.remove(request_id);
            return Ok(InteractionReply::new("expired", None));
        }
        if option_id.is_some_and(|option| {
            request
                .options
                .iter()
                .filter(|id| id.as_str() == option)
                .count()
                != 1
        }) {
            return Ok(InteractionReply::new(
                "retryable",
                Some("审批选项的标识重复或无效，请重新选择"),
            ));
        }
        let Some(responder) = request.responder.take() else {
            return Ok(InteractionReply::new(
                "uncertain",
                Some("答复结果尚未确认，请等待"),
            ));
        };
        let outcome = match option_id {
            Some(option) => serde_json::json!({"outcome":{"outcome":"selected","optionId":option}}),
            None => serde_json::json!({"outcome":{"outcome":"cancelled"}}),
        };
        match responder.respond(outcome) {
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

#[cfg(test)]
#[path = "session/prompt_context_tests.rs"]
mod prompt_context_tests;

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
    pub(super) fn new(status: &'static str, message: Option<&'static str>) -> Self {
        Self { status, message }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOpenResult {
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub history_empty_confirmed: bool,
    pub identity_read: Option<super::identity_read::Capability>,
    pub session_tool_inventory: Option<super::session_tools::Capability>,
    pub workspace_access: Option<super::workspace_access::Capability>,
    pub session_operations: super::session_fork::SessionOperations,
    pub connection_id: String,
    pub native_session_id: String,
    /// Canonicalized cwd the session was opened under — the frontend must
    /// build its session key from this, not the raw input path.
    pub cwd: String,
    pub config_options: Value,
    pub config_options_modern: bool,
    pub config_check: super::model_guard::ConfigCheck,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_config_id: Option<String>,
    pub permission_state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_effect: Option<super::permission_effect::PermissionEffect>,
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

mod stopped_tool_close;

#[cfg(test)]
mod stopped_tool_close_tests;
