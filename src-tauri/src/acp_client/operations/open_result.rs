//! Transfer the existing opening ownership to its one result receiver.
use super::{OPEN_WAIT_TIMEOUT, Operation, execute_with_timeout_receipt};
use crate::acp_client::{
    lifecycle::{ConnectionLife, OperationLease},
    pump::{OpenedSession, SessionMap},
};
use std::sync::Arc;
use tokio::sync::oneshot;

pub(crate) struct OpenDelivery {
    outcome: Option<Result<OpenedSession, String>>,
    lease: Option<OperationLease>,
    sessions: SessionMap,
    operation: Operation,
}

impl OpenDelivery {
    /// The public manager result is usable only after both reservations end.
    pub(crate) fn accept(mut self) -> Result<OpenedSession, String> {
        let mut outcome = self.outcome.take().expect("one opening result receiver");
        if let Ok(opened) = &mut outcome {
            opened.identity.delivered();
        }
        drop(self.lease.take());
        outcome
    }
}

impl Drop for OpenDelivery {
    fn drop(&mut self) {
        // A sent-but-unconsumed result is also abandoned. Clean its route while
        // the original lease still excludes a retry; never notify under this lock.
        if let Some(Ok(opened)) = self.outcome.take() {
            self.operation.abandon();
            let entry = self
                .sessions
                .lock()
                .ok()
                .and_then(|mut entries| entries.remove(&opened.session_id));
            if let Some(entry) = entry {
                entry.abandon();
            }
        }
        // OperationLease retains its existing CLOSING transfer until process reap.
        drop(self.lease.take());
    }
}

pub(super) async fn execute_open(
    reply: oneshot::Sender<Result<OpenDelivery, String>>,
    life: Arc<ConnectionLife>,
    operation: Operation,
    deadline: tokio::time::Instant,
    lease: OperationLease,
    sessions: SessionMap,
    future: impl std::future::Future<Output = Result<OpenedSession, String>>,
) {
    let owner = operation.clone();
    let settled = async move {
        let outcome = future.await;
        Ok(OpenDelivery {
            outcome: Some(outcome),
            lease: Some(lease),
            sessions,
            operation: owner,
        })
    };
    // Unknown and dropped callers keep the same effectful wait. A late success,
    // failed send, or unconsumed delivery all use the same orphan cleanup above.
    drop(
        execute_with_timeout_receipt(
            reply,
            life,
            operation,
            deadline,
            true,
            OPEN_WAIT_TIMEOUT,
            settled,
        )
        .await,
    );
}

/// A fork coordinator already owns delivery independently of its IPC caller.
/// Keep this exact load and its inquiries until its real result or connection end.
pub(super) async fn execute_owned_open(
    reply: oneshot::Sender<Result<OpenDelivery, String>>,
    life: Arc<ConnectionLife>,
    operation: Operation,
    lease: OperationLease,
    sessions: SessionMap,
    future: impl std::future::Future<Output = Result<OpenedSession, String>>,
) {
    let outcome = super::until_owner_ended(&life, future)
        .await
        .unwrap_or_else(|| Err("新对话读取结果尚未确认".into()));
    let _ = reply.send(Ok(OpenDelivery {
        outcome: Some(outcome),
        lease: Some(lease),
        sessions,
        operation,
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp_client::lifecycle::OpenReservations;
    use std::path::Path;

    #[test]
    fn open_delivery_closing_retains_reservation_until_process_completion() {
        let life = ConnectionLife::new();
        life.ready().unwrap();
        let openings = OpenReservations::default();
        let cwd = Path::new("/controlled-fixture");
        let lease = life
            .operation("open:history".into())
            .unwrap()
            .with_opening(Some(openings.reserve("fixture", cwd, "history").unwrap()));
        let delivery = OpenDelivery {
            outcome: Some(Err("controlled terminal failure".into())),
            lease: Some(lease),
            sessions: SessionMap::default(),
            operation: Operation::new(),
        };
        life.close(true, None).unwrap();
        drop(delivery);
        assert!(openings.reserve("fixture", cwd, "history").is_err());
        life.finish(Ok(()));
        assert!(openings.reserve("fixture", cwd, "history").is_ok());
    }
}
