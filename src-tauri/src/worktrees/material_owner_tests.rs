//! Tests the actual production Slot, not a second lifecycle implementation.
use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
struct Owned(Arc<AtomicUsize>);
impl Drop for Owned {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}
#[test]
fn ordinary_results_release_the_reservation_for_the_next_consumer() {
    let slot = Slot::<Owned>::default();
    assert_eq!(slot.run(|_| Ok(7)).unwrap(), 7);
    assert!(!slot.occupied());
    assert_eq!(
        slot.run::<()>(|_| Err(error("cancelled")))
            .unwrap_err()
            .code,
        "cancelled"
    );
    assert!(!slot.occupied());
    assert_eq!(slot.run(|_| Ok(8)).unwrap(), 8);
}
#[test]
fn failed_cleanup_owns_one_payload_and_refuses_every_later_consumer() {
    let dropped = Arc::new(AtomicUsize::new(0));
    let calls = AtomicUsize::new(0);
    {
        let slot = Slot::default();
        assert_eq!(
            slot.run::<()>(|retired| {
                *retired = Some(Owned(dropped.clone()));
                Err(error("cancelled"))
            })
            .unwrap_err()
            .code,
            "cleanupUnknown"
        );
        assert!(slot.occupied());
        assert_eq!(
            slot.run(|_| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .unwrap_err()
            .code,
            "cleanupUnknown"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(dropped.load(Ordering::SeqCst), 0);
    }
    // Intentional finite process-lifetime retention, NOT a cleanup success.
    // The fake payload has no OS/native resources; no actual process exit is
    // simulated and this assertion is not Windows memory reclamation evidence.
    assert_eq!(dropped.load(Ordering::SeqCst), 0);
}
#[test]
fn panic_after_failed_cleanup_keeps_the_same_owner_before_returning_unknown() {
    let dropped = Arc::new(AtomicUsize::new(0));
    let slot = Slot::default();
    assert_eq!(
        slot.run::<()>(|retired| {
            *retired = Some(Owned(dropped.clone()));
            panic!("controlled consumer unwind");
        })
        .unwrap_err()
        .code,
        "cleanupUnknown"
    );
    assert!(slot.occupied());
    assert_eq!(dropped.load(Ordering::SeqCst), 0);
}
#[test]
fn a_reserved_slot_rejects_reentry_before_a_second_context_can_be_created() {
    let slot = Slot::<Owned>::default();
    let calls = AtomicUsize::new(0);
    slot.run(|_| {
        assert!(slot.occupied());
        assert_eq!(slot.available().unwrap_err().code, "busy");
        assert_eq!(
            slot.run(|_| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .unwrap_err()
            .code,
            "busy"
        );
        Ok(())
    })
    .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(!slot.occupied());
}
#[test]
fn a_concurrent_consumer_is_refused_while_original_owner_completes() {
    let slot = Slot::<Owned>::default();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    std::thread::scope(|scope| {
        let owner = &slot;
        let worker = scope.spawn(move || {
            owner.run(|_| {
                entered_tx.send(()).unwrap();
                release_rx
                    .recv_timeout(std::time::Duration::from_secs(2))
                    .unwrap();
                Ok(())
            })
        });
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        let result = slot.run(|_| Ok(()));
        release_tx.send(()).unwrap();
        worker.join().unwrap().unwrap();
        assert_eq!(result.unwrap_err().code, "busy");
    });
    assert!(!slot.occupied());
}
