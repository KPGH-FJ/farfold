use super::super::{delivery_observation, history_admission::Admission};
use super::*;
use serde_json::{Value, json};
type Fixture = (
    Arc<Admission>,
    Arc<Registry>,
    Sender,
    Arc<Mutex<Vec<Value>>>,
);
fn fixture() -> Fixture {
    let gate = Admission::production();
    let observations = Arc::new(delivery_observation::Registry::default());
    let registry = observations.1.clone();
    let owner = gate.fixture_owner("main", "open", "agent");
    let observation = observations.create(owner.clone(), "open".into()).unwrap();
    let wakes = Arc::new(Mutex::new(Vec::new()));
    let received = wakes.clone();
    let sender = registry
        .create_with_budget(
            owner,
            "open".into(),
            Channel::new(move |body| {
                let InvokeResponseBody::Json(body) = body else {
                    panic!("json wake")
                };
                received
                    .lock()
                    .unwrap()
                    .push(serde_json::from_str(&body).unwrap());
                Ok(())
            }),
            observation,
            transient_pressure::Budget::new(100, 5),
        )
        .unwrap();
    (gate, registry, sender, wakes)
}
fn receipt(sequence: u64, outcome: &str) -> Receipt {
    serde_json::from_value(json!({"sequence": sequence.to_string(), "outcome":outcome})).unwrap()
}
#[test]
fn channel_carries_one_small_wake_and_each_original_body_requires_exact_receipt() {
    let (_gate, _registry, sender, wakes) = fixture();
    let original =
        json!({"unknown":{"text":"汉字🙂".repeat(200_000)}, "farfoldDeliveryWake":{"forged":true}})
            .to_string();
    sender.send(original.clone()).unwrap();
    sender.send("null".into()).unwrap();
    let wake = wakes.lock().unwrap();
    assert_eq!(wake.len(), 1);
    assert!(wake[0].to_string().len() < 180);
    assert!(!wake[0].to_string().contains("汉字"));
    drop(wake);
    let queue = &sender.0.queue;
    let (sequence, body) = queue.pull().unwrap().0.unwrap();
    assert_eq!(body, original);
    assert!(queue.pull().is_err());
    assert!(!queue.acknowledge(receipt(sequence + 1, "consumed")));
    assert_eq!(queue.state.lock().unwrap().entries.len(), 2);
    assert!(queue.acknowledge(receipt(sequence, "transferred_replay")));
    assert!(!queue.acknowledge(receipt(sequence, "consumed")));
    assert_eq!(queue.pull().unwrap().0.unwrap().1, "null");
}
#[test]
fn actual_owner_authority_and_retirement_release_pending_and_inflight_credit() {
    let (gate, registry, sender, _) = fixture();
    sender.send("{\"payload\":1}".into()).unwrap();
    let queue = &sender.0.queue;
    queue.pull().unwrap();
    for owner in [
        gate.fixture_owner("other", "open", "agent"),
        gate.fixture_owner("main", "old", "agent"),
        gate.fixture_owner("main", "open", "other"),
    ] {
        assert!(registry.owned(&owner, &queue.id).is_none());
    }
    gate.close_window("main").unwrap();
    let replacement = gate.fixture_owner("main", "open", "agent");
    assert!(registry.owned(&replacement, &queue.id).is_none());
    registry.retire_invalid(&gate);
    assert!(queue.state.lock().unwrap().entries.is_empty());
    assert!(queue.pull().is_err());
    assert!(sender.send("null".into()).is_err());
    assert!(registry.0.lock().unwrap().is_empty());
}
#[test]
fn producer_drop_preserves_already_queued_terminal_event_until_receipt() {
    let (_gate, registry, sender, _) = fixture();
    sender.send("{\"kind\":\"connectionLost\"}".into()).unwrap();
    let owner = sender.0.queue.owner.clone();
    let id = sender.0.queue.id.clone();
    drop(sender);
    let queue = registry.owned(&owner, &id).unwrap();
    let (sequence, body) = queue.pull().unwrap().0.unwrap();
    assert_eq!(body, "{\"kind\":\"connectionLost\"}");
    assert!(queue.acknowledge(receipt(sequence, "consumed")));
    assert!(queue.pull().unwrap().0.is_none());
    queue.retire();
    assert!(registry.owned(&owner, &id).is_none());
}
#[test]
fn empty_pull_rearms_one_wake_and_old_receipts_cannot_release_next_payload() {
    let (_gate, _registry, sender, wakes) = fixture();
    sender.send("1".into()).unwrap();
    let queue = &sender.0.queue;
    assert_eq!(queue.pull().unwrap().0.unwrap().0, 1);
    assert!(queue.acknowledge(receipt(1, "transferred_control")));
    assert!(queue.pull().unwrap().0.is_none());
    sender.send("2".into()).unwrap();
    assert_eq!(wakes.lock().unwrap().len(), 2);
    assert!(!queue.acknowledge(receipt(1, "consumed")));
    assert_eq!(queue.pull().unwrap().0.unwrap().1, "2");
    queue.retire();
}

#[test]
fn logical_retirement_keeps_only_inflight_debt_until_exact_late_receipt() {
    let (_gate, registry, sender, _) = fixture();
    let queue = &sender.0.queue;
    sender.send("12345".into()).unwrap();
    sender.send("67890".into()).unwrap();
    assert_eq!(queue.budget.retained(), (10, 2));
    queue.pull().unwrap();
    assert_eq!(queue.budget.retained(), (15, 3));
    queue.retire();
    assert_eq!(queue.budget.retained(), (5, 1));
    assert_eq!(registry.snapshot().retired_inflight, 1);
    assert!(!queue.acknowledge(receipt(2, "discarded")));
    assert_eq!(queue.budget.retained(), (5, 1));
    assert!(queue.acknowledge(receipt(1, "discarded")));
    assert_eq!(queue.budget.retained(), (0, 0));
    assert!(registry.0.lock().unwrap().is_empty());
    assert_eq!(registry.snapshot().totals.discarded, 1);
    assert_eq!(registry.snapshot().totals.consumed, 0);
}

#[test]
fn actual_window_destruction_releases_unknown_delivery_without_false_consumption() {
    let (gate, registry, sender, _) = fixture();
    let queue = &sender.0.queue;
    sender.send("12345".into()).unwrap();
    queue.pull().unwrap();
    queue.retire();
    assert_eq!(queue.budget.retained(), (5, 1));
    gate.close_window("main").unwrap();
    registry.retire_invalid(&gate);
    assert_eq!(queue.budget.retained(), (0, 0));
    let totals = registry.snapshot().totals;
    assert_eq!(totals.window_destroyed_inflight, 1);
    assert_eq!(totals.consumed, 0);
    assert!(!queue.acknowledge(receipt(1, "consumed")));
}
