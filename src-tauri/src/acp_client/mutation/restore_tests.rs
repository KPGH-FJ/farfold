use super::*;
use crate::acp_client::lifecycle::ConnectionLife;
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

async fn completed_first_request() -> (
    Arc<ConnectionLife>,
    Mutation,
    oneshot::Receiver<Result<(), String>>,
) {
    let life = ConnectionLife::new();
    life.ready().unwrap();
    let lease = life.operation("open:restore-fixture".into()).unwrap();
    let (reply, receive) = oneshot::channel();
    let mut mutation = Mutation::new(
        Kind::Mode,
        Reply::Unit(reply),
        Operation::new(),
        lease,
        tokio::time::Instant::now() + Duration::from_secs(60),
        async { Ok(serde_json::json!({"first": "confirmed"})) },
    );
    assert_eq!(
        mutation.poll().await,
        Some(Ok(serde_json::json!({"first": "confirmed"}))),
    );
    assert!(mutation.started());
    assert!(life.operation("account_change".into()).is_err());
    // Intentionally retain the reply and lease for a second recovery request.
    (life, mutation, receive)
}

#[tokio::test]
async fn configuration_restore_continuation_expired_before_dispatch_never_polls_next_request() {
    let (life, mutation, receive) = completed_first_request().await;
    let polls = Arc::new(AtomicUsize::new(0));
    let observed = polls.clone();
    let mut mutation = mutation.continue_request(async move {
        observed.fetch_add(1, Ordering::SeqCst);
        Ok(serde_json::json!({"second": "must not run"}))
    });
    mutation.deadline = tokio::time::Instant::now() - Duration::from_millis(1);
    let outcome = mutation.poll().await;
    assert!(matches!(outcome, Some(Err(ref error)) if error.contains("未发送")));
    assert!(
        !mutation.started(),
        "a continuation has its own dispatch state"
    );
    assert_eq!(polls.load(Ordering::SeqCst), 0);
    assert!(life.operation("account_change".into()).is_err());
    drop(mutation);
    assert!(receive.await.is_err());
    assert!(life.operation("account_change".into()).is_ok());
    assert_eq!(polls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn configuration_restore_continuation_closed_caller_never_polls_next_request() {
    let (life, mutation, receive) = completed_first_request().await;
    let polls = Arc::new(AtomicUsize::new(0));
    let observed = polls.clone();
    let mut mutation = mutation.continue_request(async move {
        observed.fetch_add(1, Ordering::SeqCst);
        Ok(serde_json::json!({"second": "must not run"}))
    });
    drop(receive);
    let outcome = mutation.poll().await;
    assert!(matches!(outcome, Some(Err(ref error)) if error.contains("未发送")));
    assert!(
        !mutation.started(),
        "a continuation has its own dispatch state"
    );
    assert_eq!(polls.load(Ordering::SeqCst), 0);
    assert!(life.operation("account_change".into()).is_err());
    drop(mutation);
    assert!(life.operation("account_change".into()).is_ok());
    assert_eq!(polls.load(Ordering::SeqCst), 0);
}
