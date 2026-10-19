use super::*;
use crate::acp_client::lifecycle::{ConnectionLife, OpenIdentity};

fn gate() -> Arc<Admission> {
    Admission::new(Policy {
        active: 1,
        pending: 4,
        bytes: 100,
    })
    .unwrap()
}
fn owner(g: &Admission, window: &str, token: &str) -> Owner {
    g.fixture_owner(window, token, "controlled")
}

#[tokio::test]
async fn renderer_ack_cannot_release_unknown_native_or_its_exact_operation_lease() {
    let g = gate();
    let first = owner(&g, "window", "first");
    let permit = g
        .enqueue(first.clone(), 10)
        .unwrap()
        .acquire()
        .await
        .unwrap();
    let receipt = g.arm_renderer(&first).unwrap();
    let life = ConnectionLife::new();
    life.ready().unwrap();
    drop(OpenIdentity::new(life.clone(), None).with_history(Some(permit)));
    let next = g.enqueue(owner(&g, "other", "next"), 20).unwrap();
    g.acknowledge_renderer(&first, receipt.receipt_id).unwrap();
    assert_eq!(g.counts(), (1, 1, 30));
    life.close(true, None).unwrap();
    assert_eq!(g.counts(), (1, 1, 30));
    life.finish(Ok(()));
    drop(next.acquire().await.unwrap());
    assert_eq!(g.counts(), (0, 0, 0));
}

#[tokio::test]
async fn native_end_before_index_retirement_does_not_grant_and_duplicate_ack_cannot_free_next() {
    let g = gate();
    let first = owner(&g, "window", "first");
    let permit = g
        .enqueue(first.clone(), 10)
        .unwrap()
        .acquire()
        .await
        .unwrap();
    let receipt = g.arm_renderer(&first).unwrap();
    let second = owner(&g, "window", "second");
    let next = g.enqueue(second.clone(), 20).unwrap();
    drop(permit);
    assert_eq!(g.counts(), (1, 1, 30));
    let foreign = owner(&g, "window", "foreign");
    assert!(matches!(
        g.acknowledge_renderer(&foreign, receipt.receipt_id),
        Err(Failure::Invalid)
    ));
    assert_eq!(g.counts(), (1, 1, 30));
    g.acknowledge_renderer(&first, receipt.receipt_id).unwrap();
    let next = next.acquire().await.unwrap();
    let second_receipt = g.arm_renderer(&second).unwrap();
    assert_ne!(second_receipt.receipt_id, receipt.receipt_id);
    g.acknowledge_renderer(&first, receipt.receipt_id).unwrap();
    assert!(matches!(
        g.acknowledge_renderer(&first, second_receipt.receipt_id),
        Err(Failure::Invalid)
    ));
    assert_eq!(g.counts(), (1, 0, 20));
    drop(next);
    g.acknowledge_renderer(&second, second_receipt.receipt_id)
        .unwrap();
    assert_eq!(g.counts(), (0, 0, 0));
}

#[tokio::test]
async fn destroyed_window_retires_only_its_renderer_and_never_unknown_native() {
    let g = gate();
    let first = owner(&g, "window", "first");
    let permit = g
        .enqueue(first.clone(), 10)
        .unwrap()
        .acquire()
        .await
        .unwrap();
    let receipt = g.arm_renderer(&first).unwrap();
    let next = g.enqueue(owner(&g, "other", "next"), 20).unwrap();
    g.close_window("window").unwrap();
    assert_eq!(g.counts(), (1, 1, 30));
    let replaced = owner(&g, "window", "first");
    assert!(matches!(
        g.acknowledge_renderer(&first, receipt.receipt_id),
        Err(Failure::Closed)
    ));
    assert!(matches!(
        g.acknowledge_renderer(&replaced, receipt.receipt_id),
        Err(Failure::Invalid)
    ));
    assert_eq!(g.counts(), (1, 1, 30));
    drop(permit);
    drop(next.acquire().await.unwrap());
    assert_eq!(g.counts(), (0, 0, 0));
}

#[tokio::test]
async fn failed_private_phase_cannot_claim_renderer_retirement_even_after_native_drop() {
    let g = gate();
    let first = owner(&g, "window", "first");
    let permit = g
        .enqueue(first.clone(), 10)
        .unwrap()
        .acquire()
        .await
        .unwrap();
    let original = g.arm_renderer(&first).unwrap();
    let next = g.enqueue(owner(&g, "other", "next"), 20).unwrap();
    assert_eq!(
        g.existing_renderer(&first).unwrap().unwrap().receipt_id,
        original.receipt_id
    );
    assert_eq!(g.counts(), (1, 1, 30));
    drop(permit);
    assert_eq!(g.counts(), (1, 1, 30));
    g.close_window("window").unwrap();
    drop(next.acquire().await.unwrap());
    assert_eq!(g.counts(), (0, 0, 0));
}

#[tokio::test]
async fn actual_window_destruction_after_native_end_releases_without_an_ack() {
    let g = gate();
    let first = owner(&g, "window", "first");
    let permit = g
        .enqueue(first.clone(), 10)
        .unwrap()
        .acquire()
        .await
        .unwrap();
    g.arm_renderer(&first).unwrap();
    let next = g.enqueue(owner(&g, "other", "next"), 20).unwrap();
    drop(permit);
    assert_eq!(g.counts(), (1, 1, 30));
    g.close_window("window").unwrap();
    drop(next.acquire().await.unwrap());
    assert_eq!(g.counts(), (0, 0, 0));
}

#[tokio::test]
async fn preoffer_guard_notification_is_not_an_ack_and_cannot_release_the_native_owner() {
    use crate::acp_client::history_admission_commands::{
        HistoryAdmissionState, HistoryPreparation,
    };
    let g = gate();
    let first = owner(&g, "window", "first");
    let permit = g
        .enqueue(first.clone(), 10)
        .unwrap()
        .acquire()
        .await
        .unwrap();
    let original = g.arm_renderer(&first).unwrap();
    let called = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = called.clone();
    let guard = HistoryPreparation::new(Arc::new(move |phase| {
        assert_eq!(phase, HistoryAdmissionState::NotStarted);
        observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Err(()) // failed IPC cannot retire the renderer
    }));
    drop(guard);
    assert_eq!(called.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(g.counts(), (1, 0, 10));
    drop(permit);
    assert_eq!(g.counts(), (1, 0, 10));
    g.acknowledge_renderer(&first, original.receipt_id).unwrap();
    assert_eq!(g.counts(), (0, 0, 0));
}

#[test]
fn disarmed_preoffer_guard_never_reports_not_started_and_callback_panic_does_not_escape_retirement()
{
    use crate::acp_client::history_admission_commands::HistoryPreparation;
    let called = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = called.clone();
    let mut guard = HistoryPreparation::new(Arc::new(move |_| {
        observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }));
    guard.ready();
    drop(guard);
    assert_eq!(called.load(std::sync::atomic::Ordering::SeqCst), 0);
    let retired = std::panic::catch_unwind(|| {
        drop(HistoryPreparation::new(Arc::new(|_| {
            panic!("controlled notification panic")
        })));
    });
    assert!(retired.is_ok());
}

#[tokio::test]
async fn queued_preoffer_cancellation_never_arms_renderer_or_clears_another_native_owner() {
    use crate::acp_client::history_admission_commands::HistoryPreparation;
    let g = gate();
    let active = g
        .enqueue(owner(&g, "window", "active"), 10)
        .unwrap()
        .acquire()
        .await
        .unwrap();
    let queued_owner = owner(&g, "window", "queued");
    let waiting = g.enqueue(queued_owner.clone(), 20).unwrap();
    let id = waiting.id();
    assert_eq!(g.cancel(id, &queued_owner), Ok(Cancel::CancelledWaiting));
    assert!(matches!(waiting.acquire().await, Err(Failure::Cancelled)));
    let admission = g.clone();
    let empty = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observed = empty.clone();
    drop(HistoryPreparation::new(Arc::new(move |_| {
        observed.store(
            matches!(admission.existing_renderer(&queued_owner), Ok(None)),
            std::sync::atomic::Ordering::SeqCst,
        );
        Ok(())
    })));
    assert!(empty.load(std::sync::atomic::Ordering::SeqCst));
    assert_eq!(g.counts(), (1, 0, 10));
    drop(active);
    assert_eq!(g.counts(), (0, 0, 0));
}

#[tokio::test]
async fn stale_id_with_reused_token_cannot_release_a_new_entry() {
    let g = gate();
    let same = owner(&g, "window", "same-token");
    let first = g
        .enqueue(same.clone(), 10)
        .unwrap()
        .acquire()
        .await
        .unwrap();
    let old = g.arm_renderer(&same).unwrap().receipt_id;
    drop(first);
    g.acknowledge_renderer(&same, old).unwrap();
    let next = g
        .enqueue(same.clone(), 20)
        .unwrap()
        .acquire()
        .await
        .unwrap();
    let current = g.arm_renderer(&same).unwrap().receipt_id;
    assert_ne!(old, current);
    let stale = g.acknowledge_renderer(&same, old).unwrap();
    assert_eq!(
        serde_json::to_value(stale).unwrap(),
        serde_json::json!({
            "receiptId":old,"openToken":"same-token","outcome":"notRetained",
        })
    );
    assert_eq!(g.counts(), (1, 0, 20));
    drop(next);
    assert_eq!(g.counts(), (1, 0, 20));
    g.acknowledge_renderer(&same, current).unwrap();
    assert_eq!(g.counts(), (0, 0, 0));
}

#[tokio::test]
async fn production_two_pipeline_policy_waits_for_both_facts_without_changing_fifo_or_payload_policy()
 {
    let g = Admission::production();
    let a = owner(&g, "window", "a");
    let b = owner(&g, "window", "b");
    let first = g.enqueue(a.clone(), 1).unwrap().acquire().await.unwrap();
    let second = g.enqueue(b.clone(), 1).unwrap().acquire().await.unwrap();
    let first_id = g.arm_renderer(&a).unwrap().receipt_id;
    let second_id = g.arm_renderer(&b).unwrap().receipt_id;
    let next = g.enqueue(owner(&g, "other", "c"), 1).unwrap();
    assert_eq!(g.counts(), (2, 1, 3));
    drop(first);
    assert_eq!(g.counts(), (2, 1, 3));
    g.acknowledge_renderer(&a, first_id).unwrap();
    let third = next.acquire().await.unwrap();
    g.acknowledge_renderer(&b, second_id).unwrap();
    assert_eq!(g.counts(), (2, 0, 2));
    drop(second);
    drop(third); // an unarmed controlled caller retains original semantics
    assert_eq!(g.counts(), (0, 0, 0));
}
