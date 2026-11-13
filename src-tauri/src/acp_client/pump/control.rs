//! Commands are serialized by their one actual session pump.
use super::*;
use agent_client_protocol::schema::v1::ContentBlock;

/// Commands delivered to the session pump task.
pub(crate) enum SessionControl {
    ToolsChange {
        request: Box<super::super::session_tool_changes::Request>,
        deadline: tokio::time::Instant,
        result: oneshot::Sender<Result<(), super::super::session_tool_changes::ChangeError>>,
    },
    ToolsRead {
        request: Box<super::super::session_tools::Request>,
        deadline: tokio::time::Instant,
        result: oneshot::Sender<Result<(), super::super::session_tools::ToolsError>>,
    },
    IdentityRead {
        request: Box<super::super::identity_read::Request>,
        scope: super::super::manager::AccountScope,
        deadline: tokio::time::Instant,
        result: oneshot::Sender<super::super::identity_read::Reply>,
    },
    WorkspaceAccessDecision {
        request: Box<super::super::workspace_access::Request>,
        deadline: tokio::time::Instant,
        result: oneshot::Sender<
            Result<
                super::super::workspace_access::decision::Admission,
                super::super::workspace_access::decision::DecisionError,
            >,
        >,
    },
    WorkspaceAccessDecisionCommit {
        request: Box<super::super::workspace_access::decision::Commit>,
        deadline: tokio::time::Instant,
        result: oneshot::Sender<
            Result<
                super::super::workspace_access::decision::Sent,
                super::super::workspace_access::decision::DecisionError,
            >,
        >,
    },
    WorkspaceAccessStatus {
        request: Box<super::super::workspace_access::Request>,
        deadline: tokio::time::Instant,
        result: oneshot::Sender<
            Result<
                super::super::workspace_access::WorkspaceAccessStatus,
                super::super::workspace_access::AccessError,
            >,
        >,
    },
    Fork {
        request: Box<super::super::session_fork::ForkRequest>,
        deadline: tokio::time::Instant,
        result: oneshot::Sender<
            Result<
                Arc<super::super::session_fork::SourceFork>,
                super::super::session_fork::AdmissionFailure,
            >,
        >,
    },
    Prompt {
        blocks: Vec<ContentBlock>,
        grant: Box<super::super::active_prompt::Granted>,
        result: oneshot::Sender<super::super::active_prompt::DispatchResult>,
    },
    CancelPrompt {
        request: super::super::active_prompt::CancelRequest,
        deadline: tokio::time::Instant,
    },
    Cancel {
        deadline: tokio::time::Instant,
        result: oneshot::Sender<Result<(), String>>,
    },
    StopTask {
        connection_id: String,
        task_id: String,
        deadline: tokio::time::Instant,
        result: oneshot::Sender<Result<Value, String>>,
    },
    SetConfig {
        config_id: String,
        value: Value,
        deadline: tokio::time::Instant,
        result: oneshot::Sender<Result<Value, String>>,
    },
    ConfirmConfig {
        displayed: Value,
        connection_id: Option<String>,
        restore_selection: Option<Value>,
        deadline: tokio::time::Instant,
        result: oneshot::Sender<Result<Value, String>>,
    },
    /// `session/set_mode` — agents that expose `modes` outside
    /// `configOptions` (the synthetic `mode` option in the UI calls this).
    SetMode {
        mode_id: String,
        deadline: tokio::time::Instant,
        result: oneshot::Sender<Result<(), String>>,
    },
    Close {
        /// Automatic read cleanup must preserve newly arrived interactions.
        require_idle_interactions: bool,
        deadline: tokio::time::Instant,
        result: oneshot::Sender<Result<(), String>>,
    },
    CheckUnapprovedStoppedClose {
        deadline: tokio::time::Instant,
        result: oneshot::Sender<Result<Option<StoppedToolCloseReceipt>, String>>,
    },
    CloseUnapprovedStopped {
        tool_call_id: String,
        proof_id: String,
        deadline: tokio::time::Instant,
        result: oneshot::Sender<Result<StoppedToolCloseReceipt, String>>,
    },
    /// Internal handoff owner retains this one close until its actual reply.
    ForkClose {
        result: oneshot::Sender<Result<(), String>>,
    },
    /// `session/delete` — removes the session agent-side, then ends the pump.
    Delete {
        opening: Option<super::super::lifecycle::OpenReservation>,
        deadline: tokio::time::Instant,
        result: oneshot::Sender<Result<(), super::super::mutation::DeleteFailure>>,
    },
    /// Detach a live local route only after this pump confirms it is idle.
    Detach {
        deadline: tokio::time::Instant,
        result: oneshot::Sender<Result<(), String>>,
    },
    /// Metadata mutation serialized with this session's prompt/config admission.
    Archive {
        row: Box<crate::meta_store::SessionRow>,
        canonical_cwd: String,
        reservations: Vec<super::super::lifecycle::OpenReservation>,
        admission: crate::managed_update::ActivityPermit,
        deadline: tokio::time::Instant,
        result: oneshot::Sender<Result<crate::meta_store::SessionRow, String>>,
    },
    /// Local teardown without a protocol call (connection already dead).
    Shutdown,
}

impl SessionControl {
    pub(super) async fn pending_tools_error(
        &self,
        store: &super::super::model_guard::ConfigStore,
        native: &str,
    ) -> Option<String> {
        if matches!(
            self,
            Self::Prompt { .. }
                | Self::SetConfig { .. }
                | Self::ConfirmConfig { .. }
                | Self::SetMode { .. }
                | Self::Fork { .. }
                | Self::Delete { .. }
                | Self::Archive { .. }
                | Self::WorkspaceAccessDecision { .. }
                | Self::WorkspaceAccessDecisionCommit { .. }
        ) {
            super::super::session_tool_recovery::require_ready(store, native)
                .await
                .err()
        } else {
            None
        }
    }
    pub(super) fn reject_abandoned(self) {
        match self {
            Self::Delete { result, .. } => {
                let _ = result.send(Err(super::super::mutation::DeleteFailure::NotDispatched));
            }
            Self::ToolsChange { result, .. } => {
                let _ = result.send(Err(super::super::session_tool_changes::Code::Timeout.into()));
            }
            _ => {}
        }
    }
    pub(super) fn reject_restore(
        self,
        error: String,
        code: super::super::restore_confirmation::Code,
    ) {
        let restore = matches!(
            &self,
            Self::ConfirmConfig {
                restore_selection: Some(_),
                ..
            }
        );
        self.reject(code.for_restore(restore, error));
    }
    pub(super) fn reject(self, error: String) {
        match self {
            Self::ToolsChange { result, .. } => {
                let _ = result.send(Err(super::super::session_tool_changes::Code::Changed.into()));
            }
            Self::ToolsRead { result, .. } => {
                let _ = result.send(Err(super::super::session_tools::Code::Changed.into()));
            }
            Self::IdentityRead { result, .. } => {
                let _ = result.send(Err(super::super::identity_read::Code::Changed.into()));
            }
            Self::WorkspaceAccessDecision { result, .. } => {
                let _ = result.send(Err(
                    super::super::workspace_access::decision::DecisionError::rejected(
                        super::super::workspace_access::decision::Code::Changed,
                    ),
                ));
            }
            Self::WorkspaceAccessDecisionCommit { result, .. } => {
                let _ = result.send(Err(
                    super::super::workspace_access::decision::DecisionError::rejected(
                        super::super::workspace_access::decision::Code::Changed,
                    ),
                ));
            }
            Self::WorkspaceAccessStatus { result, .. } => {
                let _ = result.send(Err(
                    super::super::workspace_access::ErrorKind::Changed.into()
                ));
            }
            Self::Prompt { result, .. } => {
                let _ = result.send(super::super::active_prompt::DispatchResult::Rejected(error));
            }
            Self::CancelPrompt { request, .. } => {
                let _ = request.result.send(Err(error));
            }
            Self::Cancel { result, .. }
            | Self::SetMode { result, .. }
            | Self::Close { result, .. }
            | Self::ForkClose { result }
            | Self::Detach { result, .. } => {
                let _ = result.send(Err(error));
            }
            Self::Delete { result, .. } => {
                let _ = result.send(Err(super::super::mutation::DeleteFailure::NotDispatched));
            }
            Self::StopTask { result, .. }
            | Self::SetConfig { result, .. }
            | Self::ConfirmConfig { result, .. } => {
                let _ = result.send(Err(error));
            }
            Self::CheckUnapprovedStoppedClose { result, .. } => {
                let _ = result.send(Err(error));
            }
            Self::CloseUnapprovedStopped { result, .. } => {
                let _ = result.send(Err(error));
            }
            Self::Archive { result, .. } => {
                let _ = result.send(Err(error));
            }
            Self::Fork { result, .. } => {
                let _ = result.send(Err(error.into()));
            }
            Self::Shutdown => {}
        }
    }
    pub(super) fn abandoned(&self) -> bool {
        let (deadline, closed) = match self {
            Self::ToolsChange {
                deadline, result, ..
            } => (*deadline, result.is_closed()),
            Self::ToolsRead {
                deadline, result, ..
            } => (*deadline, result.is_closed()),
            Self::IdentityRead {
                deadline, result, ..
            } => (*deadline, result.is_closed()),
            Self::WorkspaceAccessDecision {
                deadline, result, ..
            } => (*deadline, result.is_closed()),
            Self::WorkspaceAccessDecisionCommit {
                deadline, result, ..
            } => (*deadline, result.is_closed()),
            Self::WorkspaceAccessStatus {
                deadline, result, ..
            } => (*deadline, result.is_closed()),
            Self::ForkClose { result } => return result.is_closed(),
            Self::Fork {
                deadline, result, ..
            } => (*deadline, result.is_closed()),
            Self::Prompt { grant, result, .. } => (grant.deadline, result.is_closed()),
            Self::CancelPrompt { request, deadline } => (*deadline, request.result.is_closed()),
            Self::Cancel { deadline, result }
            | Self::SetMode {
                deadline, result, ..
            }
            | Self::Close {
                deadline, result, ..
            }
            | Self::Detach { deadline, result } => (*deadline, result.is_closed()),
            Self::Delete {
                deadline, result, ..
            } => (*deadline, result.is_closed()),
            Self::StopTask {
                deadline, result, ..
            }
            | Self::SetConfig {
                deadline, result, ..
            }
            | Self::ConfirmConfig {
                deadline, result, ..
            } => (*deadline, result.is_closed()),
            Self::CheckUnapprovedStoppedClose { deadline, result } => {
                (*deadline, result.is_closed())
            }
            Self::CloseUnapprovedStopped {
                deadline, result, ..
            } => (*deadline, result.is_closed()),
            Self::Archive {
                deadline, result, ..
            } => (*deadline, result.is_closed()),
            Self::Shutdown => return false,
        };
        closed || tokio::time::Instant::now() >= deadline
    }
}

pub(super) struct LocalDetach {
    reply: oneshot::Sender<Result<(), String>>,
    lease: super::super::lifecycle::OperationLease,
}

impl LocalDetach {
    pub(super) fn start(
        ctx: &DispatchContext<'_>,
        busy: bool,
        reply: oneshot::Sender<Result<(), String>>,
    ) -> Option<Self> {
        if busy || restore_config::busy(ctx) {
            let _ = reply.send(Err(
                "请先完成此对话的任务及待处理事项，再关闭或重新连接".into()
            ));
            return None;
        }
        // Use the same exact session exclusion as remote close. A tool report
        // can still own this lease after its caller stops waiting.
        match ctx.ops.life.operation(format!("open:{}", ctx.session_id)) {
            Ok(lease) => Some(Self { reply, lease }),
            Err(error) => {
                let _ = reply.send(Err(error));
                None
            }
        }
    }

    pub(super) fn finish(self, sessions: &SessionMap, session_id: &str) {
        let Self { reply, lease } = self;
        let outcome = sessions
            .lock()
            .map(|mut entries| {
                entries.remove(session_id);
            })
            .map_err(|_| "无法完成对话关闭，请重试".to_string());
        drop(lease);
        let _ = reply.send(outcome);
    }
}

#[cfg(test)]
mod restore_confirmation_tests {
    use super::*;
    use crate::acp_client::restore_confirmation::Code;

    #[tokio::test]
    async fn common_rejection_only_classifies_saved_selection_confirmation() {
        for code in [Code::ReadOnly, Code::Opening, Code::ForkPending] {
            for restore in [false, true] {
                let (result, receive) = oneshot::channel();
                let command = SessionControl::ConfirmConfig {
                    displayed: serde_json::json!({"private":"PRIVATE_DISPLAYED_CANARY"}),
                    connection_id: Some("PRIVATE_CONNECTION_CANARY".into()),
                    restore_selection: restore
                        .then(|| serde_json::json!({"private":"PRIVATE_SELECTED_CANARY"})),
                    deadline: tokio::time::Instant::now() + std::time::Duration::from_secs(1),
                    result,
                };
                command.reject_restore("PRIVATE_ORIGINAL_ERROR_CANARY".into(), code);
                assert_eq!(
                    receive.await.unwrap(),
                    Err::<Value, _>(if restore {
                        code.into()
                    } else {
                        "PRIVATE_ORIGINAL_ERROR_CANARY".into()
                    })
                );
            }
        }
        let (result, receive) = oneshot::channel();
        SessionControl::SetConfig {
            config_id: "PRIVATE_CONFIG_CANARY".into(),
            value: Value::Null,
            deadline: tokio::time::Instant::now(),
            result,
        }
        .reject_restore("unchanged unrelated command".into(), Code::Opening);
        assert_eq!(
            receive.await.unwrap(),
            Err::<Value, _>("unchanged unrelated command".into())
        );
    }
}
