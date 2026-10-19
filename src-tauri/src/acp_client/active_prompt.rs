//! App-owned active prompt admission. No Agent actor waits on this queue.
use super::{
    history_admission::{Admission, Cancel, Failure, Owner, Permit, Policy, Waiting},
    manager::AcpManager,
    prompt_wait::RequestGuard,
};
use agent_client_protocol::schema::v1::ContentBlock;
use serde_json::Value;
use std::{
    path::Path,
    sync::{Arc, Mutex},
};
use tokio::time::Instant;

pub(super) type PublicSnapshot = Arc<Mutex<Value>>;
pub(super) type ProgressSink = Arc<dyn Fn(Progress) -> Result<(), String> + Send + Sync>;
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Waiting,
    Preparing,
    Offered,
}
#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub receipt_id: u64,
    pub phase: Phase,
}
pub(super) struct Request {
    pub owner: Owner,
    pub connection_id: String,
    pub expected_current: Value,
    pub progress: ProgressSink,
    pub deadline: Instant,
}
pub(crate) struct Granted {
    pub(super) permit: Permit,
    pub(super) owner: Owner,
    pub(super) connection_id: String,
    pub(super) session_id: String,
    pub(super) expected_current: Value,
    pub(super) progress: ProgressSink,
    pub(super) deadline: Instant,
    pub(super) receipt_id: u64,
}
pub(crate) struct CancelRequest {
    pub(super) owner: Owner,
    pub(super) receipt_id: u64,
    pub(super) result: tokio::sync::oneshot::Sender<Result<bool, String>>,
}
pub(crate) enum DispatchResult {
    Rejected(String),
    // SDK offer/registration may fail after the request entered its queue.
    Offered(Result<(), String>),
}
pub(super) struct Input<'a> {
    pub agent: &'a str,
    pub cwd: &'a Path,
    pub session: &'a str,
    pub blocks: Vec<ContentBlock>,
    pub request: Request,
    pub store: &'a crate::meta_store::MetaStore,
}
pub(super) fn production() -> Arc<Admission> {
    // Initial engineering choice, not a measured optimum or RSS cap.
    Admission::new(Policy {
        active: 2,
        pending: 8,
        bytes: 64 * 1024 * 1024,
    })
    .expect("valid active prompt policy")
}
pub(super) fn failure(error: Failure) -> String {
    format!(
        "FAILED: {}",
        match error {
            Failure::Full => "PROMPT_QUEUE_FULL",
            Failure::Payload => "PROMPT_QUEUE_PAYLOAD",
            Failure::Cancelled => "PROMPT_QUEUE_CANCELLED",
            Failure::Closed | Failure::Invalid | Failure::Unavailable => "PROMPT_QUEUE_UNAVAILABLE",
        }
    )
}

/// Read-only copy of the ONE current public report. It only rejects early;
/// the pump's real ModelGuard remains the authority after grant/save/drain.
pub(super) fn observed_sink(
    sink: super::pump::SessionSink,
    snapshot: PublicSnapshot,
) -> super::pump::SessionSink {
    Arc::new(move |event| {
        if event.get("kind").and_then(Value::as_str) == Some("configCheck")
            && event.get("sessionId").is_none()
            && event.get("update").is_none()
            && let Some(current) = event.get("check").and_then(|v| v.get("current"))
            && let Ok(mut value) = snapshot.lock()
        {
            *value = current.clone();
        }
        sink(event); // original event/order/unknown fields, outside snapshot lock
    })
}

impl AcpManager {
    pub(super) fn prompt_snapshot(
        &self,
        agent: &str,
        cwd: &Path,
        session: &str,
    ) -> Result<(String, Value, crate::meta_store::MetaStore), String> {
        let connection = self
            .session_connection(agent, cwd, session)
            .map_err(|_| "FAILED: SESSION_UNAVAILABLE")?;
        let (snapshot, store) = {
            let sessions = connection
                .sessions
                .lock()
                .map_err(|_| "FAILED: SESSION_UNAVAILABLE")?;
            let entry = sessions.get(session).ok_or("FAILED: SESSION_UNAVAILABLE")?;
            if entry.preview_token.is_some() {
                return Err("FAILED: 此对话正在预览，加入后再继续".into());
            }
            (entry.prompt_snapshot.clone(), entry.prompt_store.clone())
        };
        let current = snapshot
            .lock()
            .map_err(|_| "FAILED: CONFIG_BLOCKED")?
            .clone();
        Ok((connection.connection_id, current, store))
    }

    pub(super) async fn admit_prompt(&self, input: Input<'_>) -> Result<(), String> {
        let Input {
            agent,
            cwd,
            session,
            blocks,
            request,
            store,
        } = input;
        let (connection, public_current, _) = self.prompt_snapshot(agent, cwd, session)?;
        // A valid Agent with no configOptions has {choices: []}; not null and
        // not a made-up model. The actual public empty snapshot is admissible.
        if connection != request.connection_id {
            return Err("FAILED: SESSION_UNAVAILABLE".into());
        }
        if !request.expected_current.is_object() || request.expected_current != public_current {
            return Err("FAILED: CONFIG_BLOCKED".into());
        }
        drop(public_current); // Do not retain a second snapshot while waiting.
        if Instant::now() >= request.deadline {
            return Err(failure(Failure::Cancelled));
        }
        let cost = super::prompt_charge::whole_request(
            &request.owner,
            &blocks,
            &request.expected_current,
            [
                cwd.to_str().ok_or("FAILED: SESSION_UNAVAILABLE")?,
                session,
                &connection,
            ],
            std::mem::size_of::<(Request, Granted, RequestGuard, Waiting, Permit)>()
                + super::process::PromptEscrow::coordination_bytes(),
            self.prompt_admission.policy().bytes,
        )
        .map_err(failure)?;
        let waiting = self
            .prompt_admission
            .enqueue_prompt(request.owner.clone(), cost)
            .map_err(failure)?;
        let receipt_id = waiting.receipt_id();
        let guard = RequestGuard::new(self.prompt_admission.clone(), request.owner, receipt_id);
        let phase = if waiting.queued() {
            Phase::Waiting
        } else {
            Phase::Preparing
        };
        (request.progress)(Progress { receipt_id, phase })
            .map_err(|_| failure(Failure::Unavailable))?;
        let permit = tokio::time::timeout_at(request.deadline, waiting.acquire())
            .await
            .map_err(|_| failure(Failure::Cancelled))?
            .map_err(failure)?;
        (request.progress)(Progress {
            receipt_id,
            phase: Phase::Preparing,
        })
        .map_err(|_| failure(Failure::Unavailable))?;
        let granted = Granted {
            permit,
            owner: guard.owner().clone(),
            connection_id: connection,
            session_id: session.to_owned(),
            expected_current: request.expected_current,
            progress: request.progress,
            deadline: request.deadline,
            receipt_id,
        };
        // This entire wait is OUTSIDE the existing canonical-cwd work gate.
        // The same absolute deadline covers queue + cwd gate + pump checks.
        let outcome = match tokio::time::timeout_at(
            request.deadline,
            crate::work_policy::admit(store, agent, cwd, || {
                self.send_granted_prompt(agent, cwd, session, blocks, granted)
            }),
        )
        .await
        {
            Ok(outcome) => outcome,
            Err(_) => Err("session prompt deadline elapsed".to_string()),
        };
        match outcome {
            Ok(()) => Ok(()),
            Err(error) if error.starts_with("FAILED:") || error == "WORK_DISABLED" => Err(error),
            Err(error) => match guard.cancel() {
                Ok(Cancel::CancelledWaiting) => Err(failure(Failure::Cancelled)),
                // Lost receipt / terminal won / poison: never invent unsent.
                _ => Err(error),
            },
        }
    }
}
