use super::super::history_admission::Admission;
use super::*;
use serde_json::json;

fn setup() -> (Arc<Admission>, Arc<Registry>, Arc<Observation>) {
    let admission = Admission::production();
    let registry = Arc::new(Registry::default());
    let owner = admission.fixture_owner("main", "open", "agent");
    let observation = registry.create(owner, "open".into()).unwrap();
    (admission, registry, observation)
}
fn serialize(observation: &Arc<Observation>, event: Value) -> (Value, usize) {
    let InvokeResponseBody::Json(body) = DeliveryEvent {
        event,
        observation: observation.clone(),
    }
    .body()
    .unwrap() else {
        panic!("JSON delivery");
    };
    (serde_json::from_str(&body).unwrap(), body.len())
}
fn receipt(value: &Value, outcome: &str) -> Receipt {
    let stamp = &value["farfoldDelivery"];
    serde_json::from_value(json!({
        "observerId": stamp["observerId"], "sampleId": stamp["sampleId"],
        "sequence": stamp["sequence"], "outcome": outcome,
    }))
    .unwrap()
}

#[test]
fn single_pending_sample_counts_exact_serialized_bytes_without_retaining_body() {
    let (_gate, registry, observation) = setup();
    let original = json!({"update":{"sessionUpdate":"unknown","text":"汉字🙂"}, "farfoldDelivery":{"sampleId":"forged"}});
    let (first, first_len) = serialize(&observation, original.clone());
    assert_eq!(first["event"], original);
    assert_eq!(first["farfoldDelivery"]["sampleId"], "1");
    let mut bytes = first_len;
    for _ in 0..100 {
        let (next, size) = serialize(&observation, json!({"unknown":true}));
        assert!(next["farfoldDelivery"].get("sampleId").is_none());
        bytes += size;
    }
    let snapshot = registry.snapshot();
    assert_eq!(snapshot.totals.events, 101);
    assert_eq!(snapshot.totals.serialized_bytes, bytes as u64);
    assert_eq!(snapshot.totals.samples, 1);
    assert_eq!(snapshot.pending_samples, 1);
    assert!(
        registry
            .acknowledge(&observation.owner, receipt(&first, "consumed"))
            .unwrap()
    );
    assert!(
        !registry
            .acknowledge(&observation.owner, receipt(&first, "consumed"))
            .unwrap()
    );
    let (next, _) = serialize(&observation, json!(null));
    assert_eq!(next["farfoldDelivery"]["sampleId"], "2");
    assert_eq!(next["farfoldDelivery"]["sequence"], "102");
}

#[test]
fn receipt_requires_exact_window_authority_agent_token_and_sample() {
    let (gate, registry, observation) = setup();
    let (event, _) = serialize(&observation, json!("body"));
    for owner in [
        gate.fixture_owner("other", "open", "agent"),
        gate.fixture_owner("main", "different", "agent"),
        gate.fixture_owner("main", "open", "other"),
    ] {
        assert!(
            !registry
                .acknowledge(&owner, receipt(&event, "consumed"))
                .unwrap()
        );
    }
    let mut wrong = receipt(&event, "consumed");
    wrong.sequence = "2".into();
    assert!(!registry.acknowledge(&observation.owner, wrong).unwrap());
    gate.close_window("main").unwrap();
    let new_owner = gate.fixture_owner("main", "open", "agent");
    assert_ne!(new_owner, observation.owner);
    assert!(
        !registry
            .acknowledge(&new_owner, receipt(&event, "consumed"))
            .unwrap()
    );
    registry.retire_invalid(&gate);
    let snapshot = registry.snapshot();
    assert_eq!(snapshot.live_owners, 0);
    assert_eq!(snapshot.pending_samples, 0);
    assert_eq!(snapshot.totals.unacknowledged_retired_samples, 1);
    assert!(
        !registry
            .acknowledge(&observation.owner, receipt(&event, "consumed"))
            .unwrap()
    );
    drop(observation);
    assert_eq!(registry.snapshot().totals.unacknowledged_retired_samples, 1);
}

#[test]
fn drop_and_early_failure_remove_registration_without_tombstones() {
    let (gate, registry, observation) = setup();
    drop(observation);
    assert_eq!(registry.snapshot().live_owners, 0);
    for _ in 0..200 {
        let owner = gate.fixture_owner("main", "open", "agent");
        let observation = registry.create(owner, "open".into()).unwrap();
        serialize(&observation, json!(null));
        drop(observation);
    }
    assert!(registry.0.lock().unwrap().owners.is_empty());
    let snapshot = registry.snapshot();
    assert_eq!(snapshot.totals.events, 200);
    assert_eq!(snapshot.totals.unacknowledged_retired_samples, 200);
}

#[test]
fn discarded_and_failed_consumption_are_not_success_and_send_failure_remains_unacknowledged() {
    let (_gate, registry, observation) = setup();
    for outcome in ["discarded", "error"] {
        let (event, _) = serialize(&observation, json!(null));
        assert!(
            registry
                .acknowledge(&observation.owner, receipt(&event, outcome))
                .unwrap()
        );
    }
    let channel = DeliveryChannel::Observed(
        Channel::new(|_| Err(std::io::Error::other("fixture delivery failed").into())),
        observation.clone(),
    );
    assert!(channel.send(json!(null)).is_err());
    let snapshot = registry.snapshot();
    assert_eq!(snapshot.totals.consumed_samples, 0);
    assert_eq!(snapshot.totals.discarded_samples, 1);
    assert_eq!(snapshot.totals.consumer_error_samples, 1);
    assert_eq!(snapshot.totals.send_failures, 1);
    assert_eq!(snapshot.pending_samples, 1);
    drop(channel);
    drop(observation);
    assert_eq!(registry.snapshot().totals.unacknowledged_retired_samples, 1);
}

#[test]
fn real_channel_senders_can_deliver_serialization_stamps_out_of_order_without_changing_bodies() {
    let (_gate, registry, observation) = setup();
    let first_entered = Arc::new(std::sync::Barrier::new(2));
    let resume_first = Arc::new(std::sync::Barrier::new(2));
    let received = Arc::new(Mutex::new(Vec::<Value>::new()));
    let entered = first_entered.clone();
    let resume = resume_first.clone();
    let values = received.clone();
    let channel = DeliveryChannel::Observed(
        Channel::new(move |body| {
            let InvokeResponseBody::Json(body) = body else {
                panic!("JSON delivery");
            };
            let event: Value = serde_json::from_str(&body).unwrap();
            if event["event"]["unknown"] == 1 {
                // The real Channel has serialized the first body, but its callback
                // has not enqueued it. Another sender can finish enqueue first.
                entered.wait();
                resume.wait();
            }
            values.lock().unwrap().push(event);
            Ok(())
        }),
        observation.clone(),
    );
    let first = channel.clone();
    let sender = std::thread::spawn(move || first.send(json!({"unknown":1})).unwrap());
    first_entered.wait();
    channel.send(json!({"unknown":2})).unwrap();
    resume_first.wait();
    sender.join().unwrap();
    let values = received.lock().unwrap();
    assert_eq!(values[0]["event"], json!({"unknown":2}));
    assert_eq!(values[1]["event"], json!({"unknown":1}));
    assert_eq!(values[0]["farfoldDelivery"]["sequence"], "2");
    assert_eq!(values[1]["farfoldDelivery"]["sequence"], "1");
    assert!(values[0]["farfoldDelivery"].get("sampleId").is_none());
    assert!(
        registry
            .acknowledge(&observation.owner, receipt(&values[1], "consumed"))
            .unwrap()
    );
    assert_eq!(registry.snapshot().totals.events, 2);
}
