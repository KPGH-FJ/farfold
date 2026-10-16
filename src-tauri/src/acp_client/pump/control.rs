//! Commands are serialized by their one actual session pump.
use super::*;
use agent_client_protocol::schema::v1::ContentBlock;

/// Commands delivered to the session pump task.
pub(crate) enum SessionControl {
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
        deadline: tokio::time::Instant,
        result: oneshot::Sender<Result<(), String>>,
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
            Self::Prompt { result, .. }
            | Self::Cancel { result, .. }
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
            Self::ForkClose { result } => return result.is_closed(),
            Self::Fork {
                deadline, result, ..
            } => (*deadline, result.is_closed()),
            Self::Prompt {
                deadline, result, ..
            }
            | Self::Cancel { deadline, result }
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
            Self::Archive {
                deadline, result, ..
            } => (*deadline, result.is_closed()),
            Self::Shutdown => return false,
        };
        closed || tokio::time::Instant::now() >= deadline
    }
}
