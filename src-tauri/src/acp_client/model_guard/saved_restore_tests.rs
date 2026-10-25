//! Owned protocol fixtures only; no installed Agent or user configuration.
use super::*;
use crate::acp_client::model_guard::ModelGuard;

fn saved(model: &str, thought: &str) -> Value {
    json!({"model":model,"reasoning_effort":thought})
}

fn assert_no_index(f: &Fixture) {
    let count: i64 = f
        .sql()
        .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        count, 0,
        "zero prompts must not publish an empty conversation"
    );
}

async fn confirm(f: &Fixture, displayed: Value, selection: Value) -> Result<Value, String> {
    f.manager
        .confirm_config_selection(&f.row.id, &f.cwd, SESSION, displayed, Some(selection))
        .await
}

async fn inject(f: &Fixture, session: &str, values: Value) {
    let update = if values.is_array() {
        json!({"sessionId":session,"options":values,"values":{}})
    } else {
        json!({"sessionId":session,"values":values})
    };
    let path = f.publish_update(update);
    tokio::time::timeout(Duration::from_secs(5), async {
        while path.exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("owned notification was not emitted");
}

fn control(f: &Fixture) -> mpsc::UnboundedSender<SessionControl> {
    f.manager
        .session_connection(&f.row.id, &f.cwd, SESSION)
        .unwrap()
        .sessions
        .lock()
        .unwrap()
        .get(SESSION)
        .unwrap()
        .control
        .clone()
}

#[test]
fn saved_restore_protection_lock_does_not_claim_a_saved_session() {
    let options = json!([{"id":"model","category":"model","type":"select","currentValue":"m1"}]);
    let mut guard = ModelGuard::new(&options, None, false);
    guard.lock();
    assert!(
        !guard.is_established(),
        "protecting a choice is not an index write"
    );
    guard.confirm_saved();
    assert!(!guard.is_established());
}

#[tokio::test(flavor = "multi_thread")]
async fn saved_restore_equal_values_with_zero_setters_confirm_without_an_index() {
    let mut f = Fixture::open().await;
    let displayed = f.check("ready").await["current"].clone();
    let result = confirm(&f, displayed.clone(), saved("m1", "low"))
        .await
        .unwrap();
    assert_eq!(result["status"], "ready");
    assert_eq!(result["current"], displayed);
    assert_no_index(&f);
    f.assert_calls(1, 0, 0, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn saved_restore_model_first_then_thought_and_explicit_changes_do_not_index() {
    let mut f = Fixture::open().await;
    f.drain();
    f.manager
        .session_set_config(&f.row.id, &f.cwd, SESSION, "model", json!("m2"))
        .await
        .unwrap();
    f.manager
        .session_set_config(&f.row.id, &f.cwd, SESSION, "reasoning_effort", json!("low"))
        .await
        .unwrap();
    let displayed = ModelGuard::new(&f.state()["options"], None, false).current_value();
    confirm(&f, displayed, saved("m2", "low")).await.unwrap();
    assert_no_index(&f);
    f.manager
        .session_set_config(&f.row.id, &f.cwd, SESSION, "model", json!("m1"))
        .await
        .unwrap();
    f.manager
        .session_set_config(
            &f.row.id,
            &f.cwd,
            SESSION,
            "reasoning_effort",
            json!("high"),
        )
        .await
        .unwrap();
    assert_no_index(&f);
    f.assert_calls(1, 0, 4, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn saved_restore_absent_intent_keeps_unconfirmed_default_manual_semantics() {
    let mut f = Fixture::open().await;
    let displayed = f.check("ready").await["current"].clone();
    assert!(
        f.manager
            .confirm_config(&f.row.id, &f.cwd, SESSION, displayed.clone())
            .await
            .is_err()
    );
    for invalid in [
        json!({}),
        json!({"provider":"m1"}),
        json!({"model":"m2"}),
        json!({"model":"m1","reasoning_effort":"high"}),
    ] {
        assert!(confirm(&f, displayed.clone(), invalid).await.is_err());
    }
    assert_no_index(&f);
    f.assert_calls(1, 0, 0, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn saved_restore_later_notification_blocks_first_prompt_and_partial_reconfirmation() {
    let mut f = Fixture::open().await;
    let displayed = f.check("ready").await["current"].clone();
    confirm(&f, displayed, saved("m1", "low")).await.unwrap();
    f.drain();
    inject(&f, SESSION, json!({"model":"m2"})).await;
    let blocked = f.check("blocked").await;
    assert_choices(&blocked["current"], "m2", "low");
    assert!(
        confirm(
            &f,
            blocked["current"].clone(),
            json!({"reasoning_effort":"low"})
        )
        .await
        .is_err()
    );
    assert!(
        f.manager
            .session_prompt(&f.row.id, &f.cwd, SESSION, blocks())
            .await
            .unwrap_err()
            .contains("CONFIG_BLOCKED")
    );
    assert_no_index(&f);
    f.assert_calls(1, 0, 0, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn saved_restore_explicit_thought_only_protects_inherited_model_without_indexing() {
    let mut f = Fixture::open().await;
    let displayed = f.check("ready").await["current"].clone();
    confirm(&f, displayed, json!({"reasoning_effort":"low"}))
        .await
        .unwrap();
    assert_no_index(&f);
    f.drain();
    inject(&f, "foreign-session", json!({"model":"m2"})).await;
    let displayed = ModelGuard::new(&f.state()["options"], None, false).current_value();
    confirm(&f, displayed, json!({"reasoning_effort":"low"}))
        .await
        .unwrap();
    f.drain();
    inject(&f, SESSION, json!({"reasoning_effort":"high"})).await;
    f.check("blocked").await;
    assert_no_index(&f);
    f.assert_calls(1, 0, 0, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn saved_restore_closed_and_expired_controls_do_not_establish_protection() {
    for expired in [false, true] {
        let mut f = Fixture::open().await;
        let displayed = f.check("ready").await["current"].clone();
        let control = control(&f);
        let (result, receive) = tokio::sync::oneshot::channel();
        if !expired {
            drop(receive);
        }
        control
            .send(SessionControl::ConfirmConfig {
                displayed: displayed.clone(),
                restore_selection: Some(saved("m1", "low")),
                result,
                deadline: if expired {
                    tokio::time::Instant::now()
                } else {
                    tokio::time::Instant::now() + Duration::from_secs(5)
                },
            })
            .unwrap();
        // FIFO control receipt is a fence after the abandoned confirmation.
        assert!(
            f.manager
                .confirm_config(&f.row.id, &f.cwd, SESSION, displayed)
                .await
                .is_err()
        );
        f.drain();
        inject(&f, SESSION, json!({"model":"m2"})).await;
        let ready = f.check("ready").await;
        assert_choices(&ready["current"], "m2", "low");
        assert_no_index(&f);
        f.assert_calls(1, 0, 0, 0);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn saved_restore_interest_lost_or_deadline_during_delivery_cannot_succeed() {
    use std::sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    };
    for close in [true, false] {
        let mut f = Fixture::open().await;
        let displayed = f.check("ready").await["current"].clone();
        let (result, receive) = tokio::sync::oneshot::channel();
        let receive = Arc::new(Mutex::new(Some(receive)));
        let receiver = receive.clone();
        let observed = Arc::new(AtomicBool::new(false));
        let observation = observed.clone();
        *f.event_hook.lock().unwrap() = Some(Box::new(move |event| {
            if event["kind"] == "configCheck" && !observation.swap(true, Ordering::SeqCst) {
                if close {
                    receiver.lock().unwrap().take();
                } else {
                    std::thread::sleep(Duration::from_millis(700));
                }
            }
        }));
        control(&f)
            .send(SessionControl::ConfirmConfig {
                displayed: displayed.clone(),
                restore_selection: Some(saved("m1", "low")),
                result,
                deadline: tokio::time::Instant::now() + Duration::from_millis(500),
            })
            .unwrap();
        if !close {
            let receive = receive.lock().unwrap().take().unwrap();
            assert!(receive.await.unwrap().is_err());
        }
        assert!(
            f.manager
                .confirm_config(&f.row.id, &f.cwd, SESSION, displayed)
                .await
                .is_err()
        );
        assert!(observed.load(Ordering::SeqCst));
        *f.event_hook.lock().unwrap() = None;
        f.drain();
        inject(&f, SESSION, json!({"model":"m2"})).await;
        let ready = f.check("ready").await;
        assert_choices(&ready["current"], "m2", "low");
        assert_no_index(&f);
        f.assert_calls(1, 0, 0, 0);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn saved_restore_first_prompt_save_failure_never_offers_or_creates_index() {
    let mut f = Fixture::open().await;
    let displayed = f.check("ready").await["current"].clone();
    confirm(&f, displayed, saved("m1", "low")).await.unwrap();
    f.sql().execute_batch("CREATE TRIGGER refuse_first BEFORE INSERT ON sessions BEGIN SELECT RAISE(FAIL, 'fixture'); END;").unwrap();
    assert!(
        f.manager
            .session_prompt(&f.row.id, &f.cwd, SESSION, blocks())
            .await
            .unwrap_err()
            .contains("CONFIG_RECORD_FAILED")
    );
    let failed = f.check("record_failed").await;
    assert!(
        confirm(&f, failed["current"].clone(), saved("m1", "low"))
            .await
            .is_err()
    );
    assert_no_index(&f);
    f.assert_calls(1, 0, 0, 0);
}

#[test]
fn saved_restore_unknown_missing_invalid_and_inherited_values_are_not_fabricated() {
    let options = json!([
        {"id":"actual-model","category":"model","type":"select","currentValue":"m1","options":[{"value":"m1"},{"value":"m2"}]},
        {"id":"new-thought","category":"thought_level","type":"select","currentValue":"low","options":[{"value":"low"},{"value":"high"}]}
    ]);
    let mut guard = ModelGuard::new(&options, None, false);
    let explicit = json!({"actual-model":"m1"});
    let confirmed = guard
        .confirm_restored_selection(&guard.current_value(), &explicit, &options)
        .unwrap();
    assert!(!confirmed.is_established());
    assert!(confirmed.admissible());
    for invalid in [
        json!({}),
        json!({"provider":"m1"}),
        json!({"actual-model":true}),
        json!({"actual-model":"m2"}),
        json!({"new-thought":"high"}),
    ] {
        assert!(
            guard
                .confirm_restored_selection(&guard.current_value(), &invalid, &options)
                .is_err()
        );
    }
    guard.change_unknown();
    assert!(
        guard
            .confirm_restored_selection(&guard.current_value(), &explicit, &options)
            .is_err()
    );
    let mut missing = ModelGuard::new(&options, None, false);
    missing.observe(&json!([options[0].clone()]));
    assert!(
        missing
            .confirm_restored_selection(
                &missing.current_value(),
                &json!({"actual-model":"m1","new-thought":"low"}),
                &json!([options[0].clone()])
            )
            .is_err()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn saved_restore_already_saved_session_can_confirm_an_explicit_choice_without_resaving() {
    let mut f = Fixture::open().await;
    f.admit().await;
    f.manager
        .session_set_config(&f.row.id, &f.cwd, SESSION, "model", json!("m2"))
        .await
        .unwrap();
    let displayed = ModelGuard::new(&f.state()["options"], None, false).current_value();
    f.sql().execute_batch("CREATE TRIGGER refuse_redundant BEFORE UPDATE ON sessions BEGIN SELECT RAISE(FAIL, 'fixture'); END;").unwrap();
    let check = confirm(&f, displayed, saved("m2", "high")).await.unwrap();
    assert_eq!(check["status"], "ready");
    f.assert_record("m2", "high");
    f.sql()
        .execute_batch("DROP TRIGGER refuse_redundant")
        .unwrap();
    f.manager
        .session_set_config(&f.row.id, &f.cwd, SESSION, "reasoning_effort", json!("low"))
        .await
        .unwrap();
    f.assert_record("m2", "low");
    f.assert_calls(1, 0, 2, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn saved_restore_unknown_setter_and_late_ack_cannot_be_reconfirmed() {
    let mut f = Fixture::open().await;
    let displayed = f.check("ready").await["current"].clone();
    confirm(&f, displayed, saved("m1", "low")).await.unwrap();
    f.drain();
    std::fs::write(f.cwd.join("hold-set"), "").unwrap();
    let (result, receive) = tokio::sync::oneshot::channel();
    control(&f)
        .send(SessionControl::SetConfig {
            config_id: "model".into(),
            value: json!("m2"),
            result,
            deadline: tokio::time::Instant::now() + Duration::from_millis(100),
        })
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(5), receive)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    let unknown = f.unknown_without_ready().await;
    assert!(
        unknown["issues"]
            .as_array()
            .unwrap()
            .iter()
            .any(|issue| issue["reason"] == "unknown")
    );
    std::fs::write(f.cwd.join("release-set"), "").unwrap();
    assert!(
        confirm(&f, unknown["current"].clone(), saved("m2", "high"))
            .await
            .is_err()
    );
    assert!(
        f.manager
            .session_prompt(&f.row.id, &f.cwd, SESSION, blocks())
            .await
            .unwrap_err()
            .contains("CONFIG_BLOCKED")
    );
    assert_no_index(&f);
    f.assert_calls(1, 0, 1, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn saved_restore_choice_list_need_not_contain_the_unchanged_saved_value() {
    let mut f = Fixture::open().await;
    f.drain();
    let mut options = f.state()["options"].clone();
    options[0]["options"] = json!([{"value":"m2","name":"Other model"}]);
    inject(&f, SESSION, options).await;
    let displayed = f.check("ready").await["current"].clone();
    let check = confirm(&f, displayed, saved("m1", "low")).await.unwrap();
    assert_eq!(check["status"], "ready");
    assert_choices(&check["current"], "m1", "low");
    assert_no_index(&f);
    f.assert_calls(1, 0, 0, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn saved_restore_choice_list_need_not_contain_the_inherited_thought_value() {
    let mut f = Fixture::open().await;
    f.drain();
    let mut options = f.state()["options"].clone();
    options[1]["options"] = json!([{"value":"high","name":"Other thought"}]);
    inject(&f, SESSION, options).await;
    let displayed = f.check("ready").await["current"].clone();
    let check = confirm(&f, displayed, json!({"model":"m1"})).await.unwrap();
    assert_eq!(check["status"], "ready");
    assert_choices(&check["current"], "m1", "low");
    assert_no_index(&f);
    f.assert_calls(1, 0, 0, 0);
}

#[test]
fn saved_restore_choice_shape_preserves_labels_and_rejects_non_arrays() {
    let options = json!([{
        "id":"model","name":"Model","category":"model","type":"select","currentValue":"kept",
        "options":[{"value":"other","name":"Other"}]
    }]);
    let selection = json!({"model":"kept"});
    for choices in [
        json!([]),
        json!([{"value":"other"}]),
        json!([{"options":[{"value":"other"}]}]),
        json!([{"group":"g","name":"Group","options":[{"value":"other","name":"Other"}]}]),
    ] {
        let mut valid = options.clone();
        valid[0]["options"] = choices;
        let guard = ModelGuard::new(&valid, None, false);
        assert!(
            guard
                .confirm_restored_selection(&guard.current_value(), &selection, &valid)
                .is_ok()
        );
    }
    for choices in [Value::Null, json!("bad"), json!({"value":"other"})] {
        let mut invalid = options.clone();
        invalid[0]["options"] = choices;
        let guard = ModelGuard::new(&invalid, None, false);
        assert!(
            guard
                .confirm_restored_selection(&guard.current_value(), &selection, &invalid)
                .is_err()
        );
    }
    let mut invalid = options.clone();
    invalid[0]["currentValue"] = json!(true);
    let guard = ModelGuard::new(&invalid, None, false);
    assert!(
        guard
            .confirm_restored_selection(&guard.current_value(), &selection, &invalid)
            .is_err()
    );
    let duplicated = json!([options[0].clone(), options[0].clone()]);
    let guard = ModelGuard::new(&duplicated, None, false);
    assert!(
        guard
            .confirm_restored_selection(&guard.current_value(), &selection, &duplicated)
            .is_err()
    );
    let guard = ModelGuard::new(&options, None, false);
    assert!(
        guard
            .confirm_restored_selection(&guard.current_value(), &json!({"model":"wrong"}), &options)
            .is_err()
    );
}
