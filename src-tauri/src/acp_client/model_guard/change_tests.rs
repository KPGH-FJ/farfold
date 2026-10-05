use super::*;
use crate::{credentials::ServiceIdentity, meta_store::MetaStore};
use sha2::{Digest, Sha256};

fn options(model: &str, effort: Option<&str>) -> Value {
    let mut values = vec![json!({
        "id": "model", "category": "model", "type": "select", "currentValue": model
    })];
    if let Some(effort) = effort {
        values.push(json!({
            "id": "reasoning_effort", "category": "thought_level",
            "type": "select", "currentValue": effort
        }));
    }
    json!(values)
}

fn established() -> ModelGuard {
    let mut guard = ModelGuard::new(&options("a", Some("low")), None, false);
    guard.lock();
    guard
}

fn request(guard: &ModelGuard, id: &str, value: &str) -> Choice {
    guard.choice_request(id, &json!(value)).unwrap().unwrap()
}

#[test]
fn configuration_change_explicit_change_commits_only_after_save_and_restores_the_new_baseline() {
    let original = established();
    let requested = request(&original, "model", "b");
    let returned = options("b", Some("high"));
    let mut candidate = original.confirmed_change(&requested, &returned).unwrap();
    assert!(original.is_established());
    assert!(original.admissible());
    assert_eq!(original.single_model_value(), Some("a"));
    assert_eq!(candidate.single_model_value(), Some("b"));
    assert!(!candidate.admissible());
    assert!(!candidate.confirmable(&candidate.current_value()));
    candidate.confirm_saved();
    assert!(candidate.is_established());
    assert!(candidate.admissible());
    let restored = ModelGuard::new(&returned, Some(&candidate.record()), true);
    assert!(restored.admissible());
    assert_eq!(restored.current, candidate.current);
}

#[test]
fn configuration_change_draft_change_keeps_the_draft_unestablished() {
    let original = ModelGuard::new(&options("a", Some("low")), None, false);
    let requested = request(&original, "model", "b");
    let mut candidate = original
        .confirmed_change(&requested, &options("b", None))
        .unwrap();
    candidate.confirm_saved();
    assert!(!candidate.is_established());
    assert!(candidate.admissible());
    assert_eq!(original.single_model_value(), Some("a"));
}

#[test]
fn configuration_change_model_change_accepts_real_associated_thought_removal_and_addition() {
    let original = established();
    let requested = request(&original, "model", "b");
    let mut candidate = original
        .confirmed_change(&requested, &options("b", None))
        .unwrap();
    candidate.confirm_saved();
    assert_eq!(candidate.current.choices.len(), 1);
    let requested = request(&candidate, "model", "c");
    let returned = json!([
        {"id":"model", "category":"model", "type":"select", "currentValue":"c"},
        {"id":"new-thought", "category":"thought_level", "type":"select", "currentValue":"medium"}
    ]);
    let mut next = candidate.confirmed_change(&requested, &returned).unwrap();
    next.confirm_saved();
    assert!(next.admissible());
    assert!(
        next.current
            .choices
            .iter()
            .any(|choice| { choice.id == "new-thought" && choice.value == "medium" })
    );
}

#[test]
fn configuration_change_thought_change_cannot_relabel_a_model_changed_by_an_early_notification() {
    let mut guard = established();
    let requested = request(&guard, "reasoning_effort", "high");
    guard.observe(&options("b", Some("high")));
    assert!(!guard.admissible());
    assert!(
        guard
            .confirmed_change(&requested, &options("b", Some("high")))
            .is_err()
    );
    let mut candidate = guard
        .confirmed_change(&requested, &options("a", Some("high")))
        .unwrap();
    candidate.confirm_saved();
    assert!(candidate.admissible());
    assert_eq!(candidate.single_model_value(), Some("a"));
}

#[test]
fn configuration_change_matching_reply_after_an_early_notification_still_confirms_the_admitted_change()
 {
    let mut guard = established();
    let requested = request(&guard, "model", "b");
    let returned = options("b", Some("high"));
    guard.observe(&returned);
    assert!(!guard.may_set("model"));
    let mut candidate = guard.confirmed_change(&requested, &returned).unwrap();
    candidate.confirm_saved();
    assert!(candidate.admissible());
}

#[test]
fn configuration_change_invalid_missing_duplicate_or_wrong_target_reply_never_confirms() {
    let guard = established();
    let requested = request(&guard, "model", "b");
    for returned in [
        options("c", Some("low")),
        json!([]),
        json!([{"id":"model", "category":"model", "type":"boolean", "currentValue":"b"}]),
        json!([
            {"id":"model", "category":"model", "type":"select", "currentValue":"b"},
            {"id":"model", "category":"model", "type":"select", "currentValue":"b"}
        ]),
        json!([
            {"id":"model", "category":"model", "type":"select", "currentValue":"b"},
            {"id":"another-model", "category":"model", "type":"select", "currentValue":"extra"}
        ]),
    ] {
        assert!(guard.confirmed_change(&requested, &returned).is_err());
    }
    let mut forged = requested.clone();
    forged.category = "thought_level".into();
    assert!(
        guard
            .confirmed_change(&forged, &options("b", Some("low")))
            .is_err()
    );
    assert!(guard.choice_request("model", &json!(true)).is_err());
    assert!(
        guard
            .choice_request("mode", &json!("other"))
            .unwrap()
            .is_none()
    );
}

#[test]
fn configuration_change_legacy_or_spontaneous_drift_cannot_authorize_a_new_model_baseline() {
    let legacy = ModelGuard::new(
        &options("a", Some("low")),
        Some(&json!({"model":"a"})),
        true,
    );
    assert_eq!(legacy.check().status, "confirmation_required");
    assert!(legacy.choice_request("model", &json!("b")).is_err());
    let mut drift = established();
    drift.observe(&options("b", Some("low")));
    assert!(drift.choice_request("model", &json!("c")).is_err());
    drift.record_failed();
    assert!(!drift.confirmable(&drift.current_value()));
    drift.record_failed_change();
    assert_eq!(drift.check().status, "blocked");
    assert!(!drift.confirmable(&drift.current_value()));
}

#[test]
fn configuration_change_failed_change_save_retries_only_its_exact_confirmed_snapshot() {
    let original = established();
    let requested = request(&original, "model", "b");
    let returned = options("b", Some("high"));
    let mut candidate = original.confirmed_change(&requested, &returned).unwrap();
    candidate.record_failed_change();
    let displayed = candidate.current_value();
    assert_eq!(candidate.check().status, "record_failed");
    assert!(candidate.confirmable(&displayed));
    assert!(!candidate.confirmable(&original.current_value()));
    assert!(!candidate.may_set("model"));
    candidate.observe(&options("c", Some("high")));
    assert!(!candidate.confirmable(&candidate.current_value()));
    assert!(!candidate.confirmable(&displayed));
    candidate.observe(&returned);
    assert!(candidate.confirmable(&displayed));
    candidate.confirm_saved();
    assert!(candidate.admissible());
    candidate.observe(&options("c", Some("high")));
    candidate.record_failed();
    assert!(!candidate.confirmable(&candidate.current_value()));
}

#[test]
fn configuration_change_unknown_change_survives_notifications_and_cannot_be_saved_as_confirmed() {
    let mut guard = established();
    let saved = guard.record();
    let requested = request(&guard, "model", "b");
    guard.change_unknown();
    for returned in [options("b", Some("low")), options("a", Some("low"))] {
        guard.observe(&returned);
        assert_eq!(guard.check().status, "blocked");
        assert!(
            guard
                .check()
                .issues
                .iter()
                .any(|issue| issue.reason == "unknown")
        );
        assert!(!guard.may_set("model"));
        assert!(!guard.confirmable(&guard.current_value()));
        assert!(guard.confirmed_change(&requested, &returned).is_err());
    }
    let restored = ModelGuard::new(&options("a", Some("low")), Some(&saved), true);
    assert!(restored.admissible());
}

fn configured_store(prefix: &str) -> (tempfile::TempDir, ConfigStore) {
    let directory = tempfile::tempdir().unwrap();
    let store = MetaStore::open(&directory.path().join("fixture.sqlite3")).unwrap();
    let endpoint = "https://example.test/v1";
    let api_type = "responses";
    store
        .set_setting(
            "credentials.v1",
            &json!([{
                "id":"fixture-service", "label":"Fixture", "provider":"Fixture",
                "endpoint":endpoint, "apiType":api_type, "models":["a", "b"],
                "secretRef":"fixture-reference-never-read", "retired":[], "grants":[],
                "deleting":false
            }]),
        )
        .unwrap();
    let fingerprint = Sha256::digest(serde_json::to_vec(&(endpoint, api_type)).unwrap())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let context = ConfigStore {
        store,
        agent_id: "fixture-agent".into(),
        cwd: "/fixture".into(),
        service_record: Some(
            super::super::service_connection::ServiceRecord::Configured {
                identity: ServiceIdentity {
                    id: "fixture-service".into(),
                    fingerprint,
                    model: "a".into(),
                },
            },
        ),
        expected_model: Some(format!("{prefix}a")),
        verified_permission_option: false,
    };
    (directory, context)
}

fn model_choice(value: &str) -> Choice {
    Choice {
        id: "model".into(),
        category: "model".into(),
        kind: "select".into(),
        value: value.into(),
    }
}

#[tokio::test]
async fn configuration_change_configured_model_change_keeps_source_and_checks_membership_without_a_key()
 {
    for prefix in ["", "farfold_fixture/"] {
        let (_directory, original) = configured_store(prefix);
        let requested = model_choice(&format!("{prefix}b"));
        let candidate = original.for_choice(Some(&requested)).await.unwrap();
        assert_eq!(
            original.expected_model.as_deref(),
            Some(format!("{prefix}a").as_str())
        );
        assert_eq!(
            candidate.expected_model.as_deref(),
            Some(requested.value.as_str())
        );
        let (
            Some(super::super::service_connection::ServiceRecord::Configured { identity: before }),
            Some(super::super::service_connection::ServiceRecord::Configured { identity: after }),
        ) = (&original.service_record, &candidate.service_record)
        else {
            panic!("configured source must remain configured");
        };
        assert_eq!(before.id, after.id);
        assert_eq!(before.fingerprint, after.fingerprint);
        assert_eq!(before.model, "a");
        assert_eq!(after.model, "b");
        assert!(
            original
                .for_choice(Some(&model_choice(&format!("{prefix}missing"))))
                .await
                .is_err()
        );
        assert!(
            original
                .for_choice(Some(&model_choice("different-provider/b")))
                .await
                .is_err()
        );
        assert!(
            original
                .for_choice(Some(&model_choice(prefix)))
                .await
                .is_err()
        );
        let thought = Choice {
            id: "reasoning_effort".into(),
            category: "thought_level".into(),
            value: "high".into(),
            ..requested
        };
        let unchanged = original.for_choice(Some(&thought)).await.unwrap();
        assert_eq!(unchanged.expected_model, original.expected_model);
        assert!(unchanged.service_record == original.service_record);
    }
}
