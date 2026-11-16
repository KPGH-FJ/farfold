use super::super::stream::ChannelPolicy;
use super::*;

#[test]
fn another_helper_cannot_release_the_original_request() {
    let gate = Arc::new(Gate::default());
    let a = ChannelLease {
        id: 1,
        gate: gate.clone(),
        live: Arc::new(|| true),
    };
    let b = ChannelLease {
        id: 2,
        gate: gate.clone(),
        live: Arc::new(|| true),
    };
    assert!(a.admit());
    assert!(!b.admit());
    b.observe(&Wire::default());
    assert!(!b.admit());
    a.observe(&Wire::default());
    assert!(b.admit());
}
#[test]
fn unknown_survives_helper_reconstruction_and_stop_settlement() {
    let gate = Arc::new(Gate::default());
    let a = ChannelLease {
        id: 1,
        gate: gate.clone(),
        live: Arc::new(|| true),
    };
    assert!(a.admit());
    a.finished(false);
    let replacement = ChannelLease {
        id: 2,
        gate: gate.clone(),
        live: Arc::new(|| true),
    };
    assert!(!replacement.admit());
    let epoch = gate.retire();
    assert!(!gate.settle(epoch));
    assert!(gate.unknown());
    assert!(!replacement.available());
}
#[test]
fn idle_discovery_retirement_allows_a_fresh_helper() {
    let gate = Arc::new(Gate::default());
    ChannelLease {
        id: 1,
        gate: gate.clone(),
        live: Arc::new(|| true),
    }
    .finished(true);
    assert!(
        ChannelLease {
            id: 2,
            gate,
            live: Arc::new(|| true)
        }
        .admit()
    );
}
#[test]
fn an_old_stop_cannot_release_a_new_retirement() {
    let gate = Gate::default();
    let old = gate.retire();
    let current = gate.retire();
    assert!(gate.settle(old));
    assert!(!gate.available());
    assert!(gate.settle(current));
    assert!(gate.available());
    gate.close();
    assert!(gate.settle(current));
    assert!(!gate.available());
}
