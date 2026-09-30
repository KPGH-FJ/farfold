use super::*;
use crate::acp_client::lifecycle::ConnectionLife;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll, Wake},
};

struct ReadyProbe {
    life: Arc<ConnectionLife>,
    released: AtomicBool,
}
impl Wake for ReadyProbe {
    fn wake(self: Arc<Self>) {
        self.released.store(
            self.life.operation("account_change".into()).is_ok(),
            Ordering::SeqCst,
        );
    }
}

#[test]
fn close_response_releases_its_operation_before_waking_the_waiting_caller() {
    for success in [true, false] {
        let life = ConnectionLife::new();
        life.ready().unwrap();
        let lease = life.operation("open:fixture".into()).unwrap();
        let (reply, mut receive) = oneshot::channel();
        let probe = Arc::new(ReadyProbe {
            life: life.clone(),
            released: AtomicBool::new(false),
        });
        let waker = std::task::Waker::from(probe.clone());
        let mut context = Context::from_waker(&waker);
        assert!(matches!(
            Pin::new(&mut receive).poll(&mut context),
            Poll::Pending
        ));
        let mutation = Mutation::new(
            Kind::Close,
            Reply::Unit(reply),
            Operation::new(),
            lease,
            tokio::time::Instant::now() + std::time::Duration::from_secs(1),
            async { Ok(serde_json::json!({})) },
        );
        mutation.finish(if success {
            Ok(serde_json::json!({}))
        } else {
            Err("confirmed close rejection".into())
        });
        assert!(
            probe.released.load(Ordering::SeqCst),
            "response woke its caller before releasing the operation (success={success})"
        );
        assert_eq!(receive.try_recv().unwrap().is_ok(), success);
    }
}

#[tokio::test]
async fn unknown_close_response_keeps_its_operation_until_the_actual_response() {
    let life = ConnectionLife::new();
    life.ready().unwrap();
    let lease = life.operation("open:fixture".into()).unwrap();
    let (reply, receive) = oneshot::channel();
    let (answer, response) = oneshot::channel::<()>();
    let mut pending = Some(Mutation::new(
        Kind::Close,
        Reply::Unit(reply),
        Operation::new(),
        lease,
        tokio::time::Instant::now() + std::time::Duration::from_millis(5),
        async {
            response.await.map_err(|_| "fixture ended".to_string())?;
            Ok(serde_json::json!({}))
        },
    ));
    assert!(next(&mut pending).await.is_none());
    assert!(receive.await.unwrap().is_err());
    assert!(life.operation("account_change".into()).is_err());
    answer.send(()).unwrap();
    let outcome = next(&mut pending).await.unwrap();
    pending.take().unwrap().finish(outcome);
    assert!(life.operation("account_change".into()).is_ok());
}
