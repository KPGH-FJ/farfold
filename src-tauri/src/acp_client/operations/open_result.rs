//! Transfer the existing opening ownership to its one result receiver.
use super::{Operation, execute};
use crate::acp_client::{
    lifecycle::{ConnectionLife, OperationLease},
    pump::{OpenedSession, SessionControl, SessionMap},
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
        let outcome = self.outcome.take().expect("one opening result receiver");
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
                let _ = entry.control.send(SessionControl::Shutdown);
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
    drop(execute(reply, life, operation, deadline, true, settled).await);
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
