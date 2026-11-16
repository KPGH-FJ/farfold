use super::{ProcessEndedReceipt, SessionMap};
use crate::acp_client::lifecycle::CloseReason;
use serde_json::json;
use std::{future::Future, time::Duration};

/// A disconnected transport and OS-confirmed process exit have separate
/// owners. Allow normal cleanup to retain its event order, but end UI delivery
/// promptly if an owned command takes longer to reap.
pub(crate) async fn wait_for_connection_end<T>(
    sessions: &SessionMap,
    reason: CloseReason,
    cleanup: impl Future<Output = T>,
) -> (T, bool) {
    wait_with_transport_notice(cleanup, Duration::from_secs(1), || {
        if let Ok(map) = sessions.lock() {
            for entry in map.values() {
                (entry.events)(json!({"kind":"connectionLost", "closeReason":reason}));
            }
        }
    })
    .await
}

async fn wait_with_transport_notice<T>(
    cleanup: impl Future<Output = T>,
    grace: Duration,
    transport_lost: impl FnOnce(),
) -> (T, bool) {
    let mut cleanup = std::pin::pin!(cleanup);
    tokio::select! {
        biased;
        result = &mut cleanup => (result, false),
        () = tokio::time::sleep(grace) => {
            transport_lost();
            (cleanup.await, true)
        }
    }
}

pub(crate) fn notify_connection_end(
    sessions: &SessionMap,
    reason: CloseReason,
    processes_ended: bool,
    transport_reported: bool,
) {
    if let Ok(mut map) = sessions.lock() {
        for (session_id, entry) in map.drain() {
            if processes_ended {
                (entry.events)(
                    json!({"kind":"toolActivity", "toolCallIds":[], "reason":"process_ended"}),
                );
                (entry.events)(
                    json!({"kind":"compactionActivity", "connectionId":entry.connection_id,
                    "sessionId":session_id, "compactionIds":[], "uncertain":false, "reason":"process_ended"}),
                );
            }
            if !transport_reported {
                (entry.events)(json!({"kind":"connectionLost", "closeReason":reason}));
            }
            // Only the actual process owner can send this independent
            // receipt. The transport notification has no such authority.
            if processes_ended && let Some(sink) = &entry.process_ended_sink {
                sink(ProcessEndedReceipt {
                    connection_id: entry.connection_id.clone(),
                    close_reason: reason,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::wait_with_transport_notice;
    use std::time::Duration;

    #[tokio::test]
    async fn slow_process_reap_notifies_transport_loss_without_settling_ownership() {
        let (reaped, cleanup) = tokio::sync::oneshot::channel();
        let (lost, mut observed) = tokio::sync::oneshot::channel();
        let wait = tokio::spawn(wait_with_transport_notice(
            cleanup,
            Duration::ZERO,
            move || lost.send(()).unwrap(),
        ));
        (&mut observed).await.unwrap();
        assert!(!wait.is_finished());
        reaped.send("owned process reaped").unwrap();
        assert_eq!(wait.await.unwrap(), (Ok("owned process reaped"), true));
    }

    #[tokio::test]
    async fn completed_cleanup_retains_normal_event_order() {
        let result = wait_with_transport_notice(std::future::ready(7), Duration::ZERO, || {
            panic!("finished cleanup reports loss in normal order")
        })
        .await;
        assert_eq!(result, (7, false));
    }
}
