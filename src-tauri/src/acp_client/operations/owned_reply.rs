//! The two fork-owned waits share one actual result/end boundary.
use super::ConnectionLife;
use std::future::Future;

pub(crate) async fn until_owner_ended<T>(
    life: &ConnectionLife,
    reply: impl Future<Output = T>,
) -> Option<T> {
    tokio::select! {
        biased;
        value=reply=>Some(value),
        _=life.terminated()=>None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::task::Poll;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn owned_reply_stop_before_reap_keeps_late_fork_id_and_load_envelope() {
        for raw in [
            json!({"sessionId":"known-child","_meta":{"exact":"fork"}}),
            json!({"configOptions":[],"_meta":{"exact":"load"}}),
        ] {
            let life = ConnectionLife::new();
            life.ready().unwrap();
            let (send, receive) = oneshot::channel::<Value>();
            let wait = until_owner_ended(&life, async { receive.await.unwrap() });
            tokio::pin!(wait);
            assert!(
                std::future::poll_fn(|cx| Poll::Ready(wait.as_mut().poll(cx).is_pending())).await
            );
            assert!(life.close(true, None).unwrap());
            assert!(!life.finished());
            assert!(
                std::future::poll_fn(|cx| Poll::Ready(wait.as_mut().poll(cx).is_pending())).await,
                "stop intent cannot discard an owned native reply while its process is still live"
            );
            send.send(raw.clone()).unwrap();
            assert_eq!(wait.await, Some(raw));
        }
    }

    #[tokio::test]
    async fn owned_reply_ready_result_wins_the_same_poll_as_actual_reap() {
        let life = ConnectionLife::new();
        life.ready().unwrap();
        let (send, receive) = oneshot::channel();
        let wait = until_owner_ended(&life, async { receive.await.unwrap() });
        tokio::pin!(wait);
        assert!(std::future::poll_fn(|cx| Poll::Ready(wait.as_mut().poll(cx).is_pending())).await);
        life.close(true, None).unwrap();
        send.send("known child reply").unwrap();
        life.finish(Ok(()));
        assert_eq!(wait.await, Some("known child reply"));
    }

    #[tokio::test]
    async fn owned_reply_actual_reap_ends_a_reply_that_never_arrived() {
        let life = ConnectionLife::new();
        life.ready().unwrap();
        let wait = until_owner_ended(&life, std::future::pending::<Value>());
        tokio::pin!(wait);
        assert!(std::future::poll_fn(|cx| Poll::Ready(wait.as_mut().poll(cx).is_pending())).await);
        life.close(true, None).unwrap();
        life.finish(Ok(()));
        assert_eq!(wait.await, None);
    }
}
