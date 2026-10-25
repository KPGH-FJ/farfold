//! Direct native admission with owned protocol/metadata fixtures, never a real Agent.
use super::*;
use std::sync::atomic::Ordering;

fn work(f: &Fixture) -> u64 {
    f.manager
        .session_connection(&f.row.id, &f.cwd, SESSION)
        .unwrap()
        .life
        .work
        .load(Ordering::SeqCst)
}

async fn reject_unknown_change(id: &str, value: &str) {
    let mut f = Fixture::open().await;
    std::fs::write(f.cwd.join("prompt-error"), "").unwrap();
    f.manager
        .session_prompt(&f.row.id, &f.cwd, SESSION, blocks())
        .await
        .unwrap();
    let ending = f.next("turnEnd").await;
    assert!(ending["error"].is_string());
    assert!(ending.get("stopReason").is_none());
    assert_eq!(work(&f), 1, "a non-finite error does not end external work");
    let result = f
        .manager
        .session_set_config(&f.row.id, &f.cwd, SESSION, id, json!(value))
        .await;
    println!(
        "{}",
        json!({"case":id,"rejected":result.is_err(),"setCalls":f.state()["counts"]["session/set_config_option"],"workAfter":work(&f)})
    );
    assert!(
        result.is_err(),
        "unknown prompt must block a direct native setter"
    );
    assert_eq!(
        work(&f),
        1,
        "a rejected setter must not release another request"
    );
    f.assert_record("m1", "low");
    f.assert_calls(1, 0, 0, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn unknown_prompt_config_error_blocks_model_without_releasing_work() {
    reject_unknown_change("model", "m2").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn unknown_prompt_config_error_blocks_thought_without_releasing_work() {
    reject_unknown_change("reasoning_effort", "high").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn unknown_prompt_config_known_terminal_keeps_explicit_changes_available() {
    let mut f = Fixture::open().await;
    f.admit().await;
    assert_eq!(work(&f), 0);
    f.manager
        .session_set_config(&f.row.id, &f.cwd, SESSION, "model", json!("m2"))
        .await
        .unwrap();
    f.assert_record("m2", "high");
    f.assert_calls(1, 0, 1, 1);
    assert_eq!(work(&f), 0);
}

async fn unknown_ending(f: &mut Fixture) {
    std::fs::write(f.cwd.join("prompt-error"), "").unwrap();
    f.manager
        .session_prompt(&f.row.id, &f.cwd, SESSION, blocks())
        .await
        .unwrap();
    let ending = f.next("turnEnd").await;
    assert!(ending["error"].is_string());
    assert_eq!(work(f), 1);
    f.drain();
}

#[tokio::test(flavor = "multi_thread")]
async fn unknown_prompt_config_legacy_mode_does_not_dispatch_with_unresolved_work() {
    let mut f = Fixture::open_variant(true).await;
    unknown_ending(&mut f).await;
    let result = f
        .manager
        .session_set_mode(&f.row.id, &f.cwd, SESSION, "second")
        .await;
    let count = f.state()["counts"]["session/set_mode"]
        .as_u64()
        .unwrap_or(0);
    println!(
        "{}",
        json!({"case":"legacy-mode","rejected":result.is_err(),"modeCalls":count,"workAfter":work(&f)})
    );
    assert!(result.is_err());
    assert_eq!(count, 0, "an unresolved request blocks mode dispatch");
    assert_eq!(work(&f), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn unknown_prompt_config_none_cannot_save_new_thought_while_request_is_unresolved() {
    let mut f = Fixture::open().await;
    unknown_ending(&mut f).await;
    let mut options = f.state()["options"].clone();
    options.as_array_mut().unwrap().push(json!({"id":"extra-thought","category":"thought_level","name":"Extra","type":"select","currentValue":"low","options":[{"value":"low","name":"Low"}]}));
    let _ = f.publish_update(json!({"sessionId":SESSION,"options":options,"values":{}}));
    let check = f.check("confirmation_required").await;
    let result = f
        .manager
        .confirm_config(&f.row.id, &f.cwd, SESSION, check["current"].clone())
        .await;
    println!(
        "{}",
        json!({"case":"manual-confirm","rejected":result.is_err(),"workAfter":work(&f)})
    );
    assert!(
        result.is_err(),
        "manual confirmation must not save through unresolved work"
    );
    f.assert_record("m1", "low");
    f.assert_calls(1, 0, 0, 1);
    assert_eq!(work(&f), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn unknown_prompt_config_known_legacy_mode_and_ready_none_keep_old_semantics() {
    let mut f = Fixture::open_variant(true).await;
    f.manager
        .session_prompt(&f.row.id, &f.cwd, SESSION, blocks())
        .await
        .unwrap();
    f.next("turnEnd").await;
    f.manager
        .session_set_mode(&f.row.id, &f.cwd, SESSION, "second")
        .await
        .unwrap();
    assert_eq!(f.state()["counts"]["session/set_mode"], 1);
    assert_eq!(work(&f), 0);
    let mut modern = Fixture::open().await;
    let ready = modern.check("ready").await;
    assert!(
        modern
            .manager
            .confirm_config(
                &modern.row.id,
                &modern.cwd,
                SESSION,
                ready["current"].clone()
            )
            .await
            .is_err()
    );
    modern.assert_calls(1, 0, 0, 0);
}
