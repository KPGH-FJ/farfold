//! Event-driven command replies. Timeout never claims a request was not sent.
use std::time::Duration;
use tokio::sync::oneshot;

pub(crate) async fn reply<T>(
    rx: oneshot::Receiver<T>,
    duration: Duration,
    label: &str,
) -> Result<T, String> {
    match tokio::time::timeout(duration, rx).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) => Err(format!("{label} 通道已关闭")),
        Err(_) => Err(format!("{label}：Agent 无响应（超时）")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn replies_yield_and_distinguish_timeout_from_closed() {
        let (tx, rx) = oneshot::channel();
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            tx.send(7).unwrap();
        });
        assert_eq!(reply(rx, Duration::from_secs(1), "test").await.unwrap(), 7);
        let (tx, rx) = oneshot::channel::<()>();
        assert!(
            reply(rx, Duration::from_millis(1), "test")
                .await
                .unwrap_err()
                .contains("超时")
        );
        assert!(tx.send(()).is_err());
        let (tx, rx) = oneshot::channel::<()>();
        drop(tx);
        assert!(
            reply(rx, Duration::from_secs(1), "test")
                .await
                .unwrap_err()
                .contains("关闭")
        );
    }
}
