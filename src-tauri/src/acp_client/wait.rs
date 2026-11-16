//! Event-driven command replies. Timeout never claims a request was not sent.
use std::time::Duration;
use tokio::sync::oneshot;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReplyFailure {
    Timeout,
    Closed,
}

pub(crate) async fn reply_typed<T>(
    rx: oneshot::Receiver<T>,
    duration: Duration,
) -> Result<T, ReplyFailure> {
    match tokio::time::timeout(duration, rx).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) => Err(ReplyFailure::Closed),
        Err(_) => Err(ReplyFailure::Timeout),
    }
}

pub(crate) async fn reply<T>(
    rx: oneshot::Receiver<T>,
    duration: Duration,
    label: &str,
) -> Result<T, String> {
    reply_typed(rx, duration)
        .await
        .map_err(|failure| match failure {
            ReplyFailure::Closed => format!("{label} 通道已关闭"),
            ReplyFailure::Timeout => format!("{label}：Agent 无响应（超时）"),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn typed_reply_classifies_only_outer_oneshot_failures() {
        let (tx, rx) = oneshot::channel::<()>();
        assert_eq!(
            reply_typed(rx, Duration::from_millis(1)).await,
            Err(ReplyFailure::Timeout)
        );
        assert!(tx.send(()).is_err());
        let (tx, rx) = oneshot::channel::<()>();
        drop(tx);
        assert_eq!(
            reply_typed(rx, Duration::from_secs(1)).await,
            Err(ReplyFailure::Closed)
        );
        let (tx, rx) = oneshot::channel::<Result<(), &str>>();
        tx.send(Err("unchanged inner result")).unwrap();
        assert_eq!(
            reply_typed(rx, Duration::from_secs(1)).await,
            Ok(Err("unchanged inner result"))
        );
    }

    #[tokio::test]
    async fn replies_yield_and_distinguish_timeout_from_closed() {
        let (tx, rx) = oneshot::channel();
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            tx.send(7).unwrap();
        });
        assert_eq!(reply(rx, Duration::from_secs(1), "test").await.unwrap(), 7);
        let (tx, rx) = oneshot::channel::<()>();
        assert_eq!(
            reply(rx, Duration::from_millis(1), "test")
                .await
                .unwrap_err(),
            "test：Agent 无响应（超时）"
        );
        assert!(tx.send(()).is_err());
        let (tx, rx) = oneshot::channel::<()>();
        drop(tx);
        assert_eq!(
            reply(rx, Duration::from_secs(1), "test").await.unwrap_err(),
            "test 通道已关闭"
        );
    }
}
