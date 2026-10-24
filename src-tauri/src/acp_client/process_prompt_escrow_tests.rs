//! UNEXECUTED private-core controls; OS/stdio integration is a separate layer.
use super::*;
use crate::acp_client::{
    history_admission::{Admission, Cancel, Policy},
    lifecycle::ConnectionLife,
};
use serde_json::json;
use std::{
    future::{Future, poll_fn},
    panic::{AssertUnwindSafe, catch_unwind},
    pin::Pin,
    sync::atomic::Ordering,
    task::Poll,
    time::Duration,
};

fn status(code: u32) -> std::process::ExitStatus {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        std::process::ExitStatus::from_raw((code as i32) << 8)
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(code)
    }
}
fn reaped() -> super::super::ReapedProcess {
    super::super::process_completion(&Some(Ok(status(0))), false).unwrap()
}

fn gate() -> Arc<Admission> {
    Admission::new(Policy {
        active: 1,
        pending: 2,
        bytes: 4096,
    })
    .unwrap()
}
async fn grant(g: &Arc<Admission>, token: &str) -> Permit {
    g.enqueue_prompt(g.fixture_owner("owned-window", token, "agent"), 128)
        .unwrap()
        .acquire()
        .await
        .unwrap()
}
fn life() -> Arc<ConnectionLife> {
    let life = ConnectionLife::new();
    life.ready().unwrap();
    life
}
async fn pending<F: Future + Unpin>(future: &mut F) -> bool {
    poll_fn(|cx| Poll::Ready(Pin::new(&mut *future).poll(cx).is_pending())).await
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(60)
}

#[tokio::test]
async fn known_terminal_releases_once_and_surviving_waiter_starts() {
    let g = gate();
    let life = life();
    let cell = PromptEscrow::for_pool(g.clone());
    let permit = grant(&g, "first").await;
    let observation = cell
        .commit(&permit, life.work().unwrap(), deadline())
        .unwrap();
    drop(permit);
    let mut next = Box::pin(grant(&g, "second"));
    assert!(pending(&mut next).await);
    observation.observe(&Ok(json!({"stopReason":"cancelled","_meta":{"kept":true}})));
    observation.observe(&Ok(json!({"stopReason":"cancelled"})));
    assert_eq!(life.work.load(Ordering::SeqCst), 0);
    assert!(!observation.unresolved());
    drop(next.await);
    assert_eq!(g.counts(), (0, 0, 0));
}

#[tokio::test]
async fn error_unknown_eof_and_dropped_callback_keep_capacity_until_exact_reap() {
    let g = gate();
    let life = life();
    let cell = PromptEscrow::for_pool(g.clone());
    let permit = grant(&g, "first").await;
    let observation = cell
        .commit(&permit, life.work().unwrap(), deadline())
        .unwrap();
    drop(permit);
    let mut next = Box::pin(grant(&g, "second"));
    observation.observe(&Err("owned EOF/callback error marker".into()));
    observation.observe(&Ok(json!({"stopReason":"future_reason"})));
    observation.observe(&Ok(json!({"kind":"turnEnd","error":"owned marker"})));
    assert!(observation.unresolved());
    drop(observation);
    assert!(pending(&mut next).await);
    assert_eq!(life.work.load(Ordering::SeqCst), 1);
    cell.process_reaped(reaped()); // Private seam only; not an actual OS proof here.
    drop(next.await);
    assert_eq!(g.counts(), (0, 0, 0));
    assert_eq!(life.work.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn completion_task_abort_does_not_release_the_committed_permit() {
    let g = gate();
    let life = life();
    let cell = PromptEscrow::for_pool(g.clone());
    let permit = grant(&g, "first").await;
    let observation = cell
        .commit(&permit, life.work().unwrap(), deadline())
        .unwrap();
    let observer = tokio::spawn(async move {
        let _held = observation;
        std::future::pending::<()>().await;
    });
    drop(permit);
    observer.abort();
    assert!(observer.await.unwrap_err().is_cancelled());
    let mut next = Box::pin(grant(&g, "second"));
    assert!(pending(&mut next).await);
    assert_eq!(life.work.load(Ordering::SeqCst), 1);
    cell.process_reaped(reaped());
    drop(next.await);
    assert_eq!(g.counts(), (0, 0, 0));
}

#[tokio::test]
async fn pump_unwind_leaves_process_escrow_in_charge() {
    let g = gate();
    let life = life();
    let cell = PromptEscrow::for_pool(g.clone());
    let permit = grant(&g, "first").await;
    let observation = cell
        .commit(&permit, life.work().unwrap(), deadline())
        .unwrap();
    assert!(
        catch_unwind(AssertUnwindSafe(move || {
            let _local = (permit, observation);
            panic!("owned pump unwind marker");
        }))
        .is_err()
    );
    let mut next = Box::pin(grant(&g, "second"));
    assert!(pending(&mut next).await);
    cell.process_reaped(reaped());
    drop(next.await);
    assert_eq!(g.counts(), (0, 0, 0));
}

#[tokio::test]
async fn lost_actual_owner_is_quarantined_not_falsely_reaped_or_cyclic() {
    let g = gate();
    let life = life();
    let weak_life = Arc::downgrade(&life);
    let cell = PromptEscrow::for_pool(g.clone());
    let permit = grant(&g, "first").await;
    let observation = cell
        .commit(&permit, life.work().unwrap(), deadline())
        .unwrap();
    drop(permit);
    drop(cell); // No reaped call: simulate final owner destruction.
    assert!(observation.unresolved());
    assert_eq!(life.work.load(Ordering::SeqCst), 1); // Existing scalar retention.
    let mut next = Box::pin(grant(&g, "second"));
    assert!(pending(&mut next).await);
    assert_eq!(g.counts(), (1, 1, 256)); // Logical charge, not heap/RSS.
    drop(life);
    assert!(weak_life.upgrade().is_none()); // No Life -> WorkLease cycle.
    drop(next);
    drop(observation);
    assert_eq!(g.counts(), (1, 0, 128)); // Only app/pool teardown can end this unknown.
}

#[tokio::test]
async fn granted_cancel_window_close_deadline_and_reaped_process_cannot_offer() {
    let g = gate();
    let owner = g.fixture_owner("owned-window", "cancel", "agent");
    let waiting = g.enqueue_prompt(owner.clone(), 128).unwrap();
    let id = waiting.id();
    let permit = waiting.acquire().await.unwrap();
    let life = life();
    assert_eq!(
        g.cancel(id, &g.fixture_owner("other-window", "cancel", "agent")),
        Ok(Cancel::NotFound)
    );
    assert_eq!(g.cancel(id, &owner), Ok(Cancel::CancelledWaiting));
    let cell = PromptEscrow::for_pool(g.clone());
    assert!(matches!(
        cell.commit(&permit, life.work().unwrap(), deadline()),
        Err(Failure::Cancelled)
    ));
    drop(permit);
    let permit = grant(&g, "close").await;
    g.close_window("owned-window").unwrap();
    assert!(matches!(
        cell.commit(&permit, life.work().unwrap(), deadline()),
        Err(Failure::Cancelled | Failure::Closed)
    ));
    drop(permit);
    let permit = grant(&g, "expired").await;
    assert!(matches!(
        cell.commit(&permit, life.work().unwrap(), Instant::now()),
        Err(Failure::Timeout)
    ));
    cell.process_reaped(reaped());
    assert!(matches!(
        cell.commit(&permit, life.work().unwrap(), deadline()),
        Err(Failure::Closed)
    ));
    drop(permit);
    assert_eq!(g.counts(), (0, 0, 0));
}

#[tokio::test]
async fn old_cold_granted_owner_still_uses_last_clone_drop_and_is_not_prompt_commit() {
    let g = gate();
    let owner = g.fixture_owner("owned-window", "cold", "agent");
    let waiting = g.enqueue(owner.clone(), 128).unwrap();
    let id = waiting.id();
    let permit = waiting.acquire().await.unwrap();
    assert_eq!(g.cancel(id, &owner), Ok(Cancel::AlreadyStarting));
    assert!(matches!(
        permit.commit_prompt(deadline()),
        Err(Failure::Invalid)
    ));
    let clone = permit.clone();
    drop(permit);
    assert_eq!(g.counts(), (1, 0, 128));
    drop(clone);
    assert_eq!(g.counts(), (0, 0, 0));
}

#[tokio::test]
async fn send_wait_timeout_at_atomic_commit_is_distinct_but_prior_cancel_wins() {
    let g = gate();
    let life = life();
    let cell = PromptEscrow::for_pool(g.clone());
    let permit = grant(&g, "expired-origin").await;
    let error = cell
        .commit(&permit, life.work().unwrap(), Instant::now())
        .err()
        .unwrap();
    assert_eq!(format!("{error:?}"), "Timeout");
    assert_eq!(life.work.load(Ordering::SeqCst), 0);
    drop(permit);
    let owner = g.fixture_owner("owned-window", "cancel-first", "agent");
    let waiting = g.enqueue_prompt(owner.clone(), 128).unwrap();
    let id = waiting.id();
    let permit = waiting.acquire().await.unwrap();
    assert_eq!(g.cancel(id, &owner), Ok(Cancel::CancelledWaiting));
    let error = cell
        .commit(&permit, life.work().unwrap(), Instant::now())
        .err()
        .unwrap();
    assert_eq!(format!("{error:?}"), "Cancelled");
    drop(permit);
    assert_eq!(g.counts(), (0, 0, 0));
}

#[tokio::test]
async fn reused_public_token_cannot_let_old_receipt_cancel_a_new_request() {
    let g = gate();
    let life = life();
    let cell = PromptEscrow::for_pool(g.clone());
    let owner = g.fixture_owner("owned-window", "same-public-token", "agent");
    let waiting = g.enqueue_prompt(owner.clone(), 128).unwrap();
    let old_id = waiting.receipt_id();
    let first = waiting.acquire().await.unwrap();
    let old = cell
        .commit(&first, life.work().unwrap(), deadline())
        .unwrap();
    assert_eq!(old.receipt_id(), old_id);
    old.observe(&Ok(json!({"stopReason":"end_turn"})));
    drop(first);
    let next = g.enqueue_prompt(owner.clone(), 128).unwrap();
    let new_id = next.receipt_id();
    let next = next.acquire().await.unwrap();
    assert_ne!(old_id, new_id);
    assert_eq!(g.cancel(old_id, &owner), Ok(Cancel::NotFound));
    let active = cell
        .commit(&next, life.work().unwrap(), deadline())
        .unwrap();
    assert_eq!(active.receipt_id(), new_id);
    old.observe(&Ok(json!({"stopReason":"cancelled"})));
    assert!(active.unresolved());
    assert_eq!(g.cancel(new_id, &owner), Ok(Cancel::AlreadyStarting));
    active.observe(&Ok(json!({"stopReason":"cancelled"})));
    drop(next);
    assert_eq!(g.counts(), (0, 0, 0));
}

#[tokio::test]
async fn status_error_and_inactive_group_cannot_publish_done_or_release_work() {
    let g = gate();
    let life = life();
    let dir = tempfile::tempdir().unwrap();
    let control = super::super::ProcessControl::new(
        crate::acp_client::startup_diagnostics::Diagnostics::open(dir.path(), "owned-status"),
    )
    .with_prompt_admission(g.clone());
    // Private test-only state setup: no OS process is claimed by this control.
    control.started.store(true, Ordering::SeqCst);
    let mut closed = Box::pin(control.closed());
    let cell = control.prompt_escrow();
    let permit = grant(&g, "first").await;
    cell.commit(&permit, life.work().unwrap(), deadline())
        .unwrap();
    drop(permit);
    for (exit, group_active) in [
        (
            Some(Err(std::io::Error::other("owned status error"))),
            false,
        ),
        (None, false),
        (Some(Ok(status(0))), true),
    ] {
        if let Some(proof) = super::super::process_completion(&exit, group_active) {
            control.complete_process(proof, Ok(()));
        }
        assert!(control.done.borrow().is_none());
        assert!(pending(&mut closed).await);
        assert_eq!(g.counts(), (1, 0, 128));
        assert_eq!(life.work.load(Ordering::SeqCst), 1);
        assert!(crate::managed_update::quiet_exit().is_err());
        assert!(life.close(false, None).is_err());
    }
    // Acquired nonzero status is a reaping fact; an Err outcome is not status Err.
    let proof = super::super::process_completion(&Some(Ok(status(17))), false).unwrap();
    control.complete_process(proof, Err("owned unexpected exit".into()));
    assert!(matches!(&*control.done.borrow(), Some(Err(_))));
    assert!(closed.await.is_err());
    assert_eq!(g.counts(), (0, 0, 0));
    assert_eq!(life.work.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn a_process_cannot_mix_pool_local_receipt_ids() {
    let first = gate();
    let second = gate();
    let life = life();
    let cell = PromptEscrow::for_pool(first.clone());
    let wrong = grant(&second, "same-local-id").await;
    assert!(matches!(
        cell.commit(&wrong, life.work().unwrap(), deadline()),
        Err(Failure::Invalid)
    ));
    assert_eq!(first.counts(), (0, 0, 0));
    drop(wrong);
    assert_eq!(second.counts(), (0, 0, 0));
}
