use super::*;
use std::future::Future;
use std::sync::Mutex;
use std::task::{Context, Wake, Waker};

struct AtDelivery {
    life: Arc<ConnectionLife>,
    available: Mutex<Vec<bool>>,
}

impl Wake for AtDelivery {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        // Observe inside the real reply send, before its caller can continue.
        let next = self.life.operation("authentication".into());
        self.available.lock().unwrap().push(next.is_ok());
    }
}

#[tokio::test]
async fn authentication_delivery_releases_reservation_before_confirmed_reply() {
    for outcome in [Ok(()), Err("controlled authentication failure".into())] {
        let life = ConnectionLife::new();
        life.ready().unwrap();
        let lease = life.operation("authentication".into()).unwrap();
        let observer = Arc::new(AtDelivery {
            life: life.clone(),
            available: Mutex::new(vec![]),
        });
        let (reply, mut receive) = oneshot::channel();
        assert!(
            std::pin::Pin::new(&mut receive)
                .poll(&mut Context::from_waker(&Waker::from(observer.clone())))
                .is_pending()
        );
        let expected = outcome.clone();
        authentication_result(
            reply,
            life,
            tokio::time::Instant::now() + Duration::from_secs(1),
            Arc::new(|| {}),
            lease,
            async move { outcome },
        )
        .await;
        assert_eq!(receive.await.unwrap(), expected);
        assert_eq!(*observer.available.lock().unwrap(), vec![true]);
    }
}

#[tokio::test]
async fn authentication_expired_delivery_releases_without_starting() {
    let life = ConnectionLife::new();
    life.ready().unwrap();
    let lease = life.operation("authentication".into()).unwrap();
    let observer = Arc::new(AtDelivery {
        life: life.clone(),
        available: Mutex::new(vec![]),
    });
    let (reply, mut receive) = oneshot::channel();
    assert!(
        std::pin::Pin::new(&mut receive)
            .poll(&mut Context::from_waker(&Waker::from(observer.clone())))
            .is_pending()
    );
    authentication_result(
        reply,
        life,
        tokio::time::Instant::now(),
        Arc::new(|| {}),
        lease,
        async { panic!("an expired authentication must never reach the peer") },
    )
    .await;
    assert_eq!(
        receive.await.unwrap().unwrap_err(),
        "账号操作未开始，请重试"
    );
    assert_eq!(*observer.available.lock().unwrap(), vec![true]);
}

#[tokio::test]
async fn authentication_closing_retains_ownership_until_process_completion() {
    use crate::acp_client::lifecycle::OpenReservations;
    let life = ConnectionLife::new();
    life.ready().unwrap();
    let openings = OpenReservations::default();
    let cwd = std::path::Path::new("/controlled-fixture");
    let lease = life
        .operation("authentication".into())
        .unwrap()
        .with_opening(Some(openings.reserve("fixture", cwd, "account").unwrap()));
    let (reply, receive) = oneshot::channel();
    let (started, starting) = oneshot::channel();
    let task_life = life.clone();
    let task = tokio::spawn(async move {
        authentication_result(
            reply,
            task_life,
            tokio::time::Instant::now() + Duration::from_secs(1),
            Arc::new(|| {}),
            lease,
            async move {
                let _ = started.send(());
                std::future::pending().await
            },
        )
        .await;
    });
    starting.await.unwrap();
    life.close(true, None).unwrap();
    assert_eq!(
        receive.await.unwrap().unwrap_err(),
        "AUTH_CONNECTION_CLOSED"
    );
    assert!(openings.reserve("fixture", cwd, "account").is_err());
    life.finish(Ok(()));
    assert!(openings.reserve("fixture", cwd, "account").is_ok());
    task.await.unwrap();
}
