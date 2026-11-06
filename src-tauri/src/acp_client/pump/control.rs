//! Commands are serialized by their one actual session pump.
use super::*;
use agent_client_protocol::schema::v1::ContentBlock;

/// Commands delivered to the session pump task.
pub(crate) enum SessionControl {
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
        deadline: tokio::time::Instant,
        result: oneshot::Sender<Result<(), String>>,
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
    pub(super) fn reject(self, error: String) {
        match self {
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
            | Self::Delete { result, .. }
            | Self::Detach { result, .. } => {
                let _ = result.send(Err(error));
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
            | Self::Detach { deadline, result }
            | Self::Delete { deadline, result } => (*deadline, result.is_closed()),
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
