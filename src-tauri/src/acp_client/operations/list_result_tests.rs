use super::*;
use std::future::Future;
use std::sync::Mutex;
use std::task::{Context, Poll, Wake, Waker};

struct AtDelivery {
    life: Arc<ConnectionLife>,
    available: Mutex<Vec<bool>>,
}

impl Wake for AtDelivery {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        // oneshot::send calls this before it returns. Inspect that exact
        // delivery boundary, without depending on executor timing or sleeps.
        let next = self.life.operation("list".into());
        self.available.lock().unwrap().push(next.is_ok());
    }
}

async fn terminal_delivery(outcome: Result<u8, String>) {
    let life = ConnectionLife::new();
    life.ready().unwrap();
    let lease = life.operation("list".into()).unwrap();
    let observer = Arc::new(AtDelivery {
        life: life.clone(),
        available: Mutex::new(vec![]),
    });
    let waker = Waker::from(observer.clone());
    let (reply, mut receive) = oneshot::channel();
    assert!(
        std::pin::Pin::new(&mut receive)
            .poll(&mut Context::from_waker(&waker))
            .is_pending()
    );
    let expected = outcome.clone();
    execute_list(
        reply,
        life,
        Operation::new(),
        tokio::time::Instant::now() + Duration::from_secs(1),
        lease,
        async move { outcome },
    )
    .await;
    assert_eq!(receive.await.unwrap(), expected);
    assert_eq!(*observer.available.lock().unwrap(), vec![true]);
}

#[tokio::test]
async fn next_page_is_admitted_at_success_delivery() {
    terminal_delivery(Ok(1)).await;
}

#[tokio::test]
async fn retry_is_admitted_at_remote_failure_delivery() {
    terminal_delivery(Err("fixture remote failure".into())).await;
}

struct PendingQuery(Arc<AtomicBool>);

impl Future for PendingQuery {
    type Output = Result<u8, String>;
    fn poll(self: std::pin::Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Self::Output> {
        Poll::Pending
    }
}

impl Drop for PendingQuery {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

struct NeverStarted(PendingQuery);

impl Future for NeverStarted {
    type Output = Result<u8, String>;
    fn poll(self: std::pin::Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Self::Output> {
        assert!(!self.0.0.load(Ordering::SeqCst));
        panic!("an expired or already abandoned query must not start");
    }
}

#[tokio::test]
async fn pending_list_keeps_lease_until_caller_cancels() {
    let life = ConnectionLife::new();
    life.ready().unwrap();
    let lease = life.operation("list".into()).unwrap();
    let dropped = Arc::new(AtomicBool::new(false));
    let (reply, receive) = oneshot::channel();
    let mut work = Box::pin(execute_list(
        reply,
        life.clone(),
        Operation::new(),
        tokio::time::Instant::now() + Duration::from_secs(1),
        lease,
        PendingQuery(dropped.clone()),
    ));
    assert!(
        work.as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    assert!(life.operation("list".into()).is_err());
    assert!(!dropped.load(Ordering::SeqCst));
    drop(receive);
    assert_eq!(work.await, None);
    assert!(dropped.load(Ordering::SeqCst));
    assert!(life.operation("list".into()).is_ok());
}

#[tokio::test]
async fn expired_or_abandoned_queue_drops_list_future_and_lease() {
    for expired in [false, true] {
        let life = ConnectionLife::new();
        life.ready().unwrap();
        let lease = life.operation("list".into()).unwrap();
        let dropped = Arc::new(AtomicBool::new(false));
        let (reply, receive) = oneshot::channel();
        let _receive = if expired {
            Some(receive)
        } else {
            drop(receive);
            None
        };
        assert_eq!(
            execute_list(
                reply,
                life.clone(),
                Operation::new(),
                tokio::time::Instant::now()
                    + if expired {
                        Duration::ZERO
                    } else {
                        Duration::from_secs(1)
                    },
                lease,
                NeverStarted(PendingQuery(dropped.clone())),
            )
            .await,
            None
        );
        assert!(dropped.load(Ordering::SeqCst));
        assert!(life.operation("list".into()).is_ok());
    }
}

#[tokio::test]
async fn timed_out_readonly_list_drops_query_and_releases_lease() {
    let life = ConnectionLife::new();
    life.ready().unwrap();
    let lease = life.operation("list".into()).unwrap();
    let dropped = Arc::new(AtomicBool::new(false));
    let (reply, receive) = oneshot::channel();
    let operation = Operation::new();
    assert_eq!(
        execute_list(
            reply,
            life.clone(),
            operation.clone(),
            tokio::time::Instant::now() + Duration::from_millis(5),
            lease,
            PendingQuery(dropped.clone()),
        )
        .await,
        None
    );
    assert!(receive.await.unwrap().unwrap_err().contains("尚未确认"));
    assert!(!operation.interested());
    assert!(dropped.load(Ordering::SeqCst));
    assert!(life.operation("list".into()).is_ok());
}
