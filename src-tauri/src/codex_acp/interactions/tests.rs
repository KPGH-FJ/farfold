use super::*;
use crate::codex_acp::{
    threads::tests::scope,
    turns::{Payload, tests::Fixture},
};
use std::{collections::BTreeMap, thread, time::Instant};
fn open(f: &Fixture) -> Interaction {
    let until = Instant::now() + Duration::from_secs(2);
    loop {
        for event in f.runtime.poll_turn_events(&scope(1)).unwrap() {
            if matches!(event.payload, Payload::InteractionOpen { .. }) {
                return Interaction::from_event(scope(1), &event).unwrap();
            }
        }
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(5));
    }
}
fn decision(value: Value) -> CodexInteractionReply {
    CodexInteractionReply::Decision { decision: value }
}
fn replies(f: &Fixture) -> usize {
    let path = f
        .temp
        .path()
        .join("home/codex/synthetic-response-count.json");
    fs::read(path)
        .ok()
        .map(|b| {
            serde_json::from_slice::<Value>(&b).unwrap()["count"]
                .as_u64()
                .unwrap() as usize
        })
        .unwrap_or_default()
}
#[test]
fn command_file_and_plan_question_keep_native_choices_and_wait_for_resolution() {
    for mode in [
        "interaction_command",
        "interaction_file",
        "interaction_question",
    ] {
        let f = Fixture::new(mode);
        f.interactions.attach_host_store(f.store.clone()).unwrap();
        f.start();
        let interaction = open(&f);
        assert_eq!(f.count(), 1);
        assert_eq!(f.interactions.snapshots().unwrap().len(), 1);
        let rendered = serde_json::to_string(&f.interactions.snapshots().unwrap()).unwrap();
        assert!(
            !rendered.contains("PRIVATE-INTERACTION") && !rendered.contains("PRIVATE-SETTINGS")
        );
        let reply = if mode == "interaction_question" {
            assert_eq!(interaction.native_mode, "plan");
            CodexInteractionReply::Answers {
                answers: BTreeMap::from([
                    (
                        "question_one".into(),
                        vec!["A".into(), "custom user choice".into()],
                    ),
                    ("question_secret".into(), vec!["EPHEMERAL-ANSWER".into()]),
                ]),
            }
        } else if mode == "interaction_file" {
            assert_eq!(
                interaction.file_changes.as_ref().unwrap()[0].diff,
                "+synthetic proposed content"
            );
            decision(json!("acceptForSession"))
        } else {
            assert_eq!(
                interaction.request.native_request["params"]["approvalId"],
                "native-callback-id"
            );
            decision(
                json!({"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["printf","synthetic"]}}),
            )
        };
        let mut foreign = interaction.clone();
        foreign.context.thread.native_session_id = "foreign-tree".into();
        assert!(
            f.runtime
                .reply_interaction(
                    &f.store,
                    &f.interactions,
                    &foreign,
                    decision(json!("accept"))
                )
                .is_err()
        );
        f.runtime
            .reply_interaction(&f.store, &f.interactions, &interaction, reply)
            .unwrap();
        assert!(
            serde_json::to_string(&f.interactions.snapshots().unwrap())
                .unwrap()
                .contains("responding")
        );
        assert!(
            f.runtime
                .reply_interaction(
                    &f.store,
                    &f.interactions,
                    &interaction,
                    decision(json!("accept"))
                )
                .is_err()
        );
        f.settle();
        assert!(f.interactions.snapshots().unwrap().is_empty());
        assert_eq!(replies(&f), 1);
        let events = serde_json::to_string(&f.router.snapshot(None, Some(512)).unwrap()).unwrap();
        assert!(!events.contains("EPHEMERAL-ANSWER"));
        assert!(
            !String::from_utf8_lossy(&fs::read(f.temp.path().join("host.sqlite3")).unwrap())
                .contains("EPHEMERAL-ANSWER")
        );
    }
}
#[test]
fn stop_with_pending_question_or_approval_never_sends_an_invented_answer() {
    for mode in [
        "interaction_command",
        "interaction_question",
        "interaction_file",
    ] {
        let f = Fixture::new(mode);
        f.start();
        let interaction = open(&f);
        let (context, native) = f.runtime.turn_context(&scope(1)).unwrap();
        f.runtime
            .interrupt_turn(&f.store, &scope(1), &context, &native)
            .unwrap();
        assert_eq!(f.count(), 1);
        assert!(
            f.runtime
                .reply_interaction(
                    &f.store,
                    &f.interactions,
                    &interaction,
                    decision(json!("accept"))
                )
                .is_err()
        );
        let events = f.settle();
        assert!(events.iter().any(|e|matches!(e.payload,Payload::InteractionEnd{ref resolution,..} if resolution=="stop_requested")));
        assert!(
            matches!(events.last().unwrap().payload,Payload::Terminal{ref status} if status=="interrupted")
        );
        assert_eq!(replies(&f), 0);
        assert!(f.interactions.snapshots().unwrap().is_empty());
    }
}
#[test]
fn native_withdrawal_and_question_expiry_reject_late_replies_without_answering() {
    for mode in ["interaction_withdraw", "interaction_expire"] {
        let f = Fixture::new(mode);
        f.start();
        let interaction = open(&f);
        let until = Instant::now() + Duration::from_secs(2);
        while !f.interactions.snapshots().unwrap().is_empty() {
            f.runtime.poll_turn_events(&scope(1)).unwrap();
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(5));
        }
        assert!(
            f.runtime
                .reply_interaction(
                    &f.store,
                    &f.interactions,
                    &interaction,
                    decision(json!("accept"))
                )
                .is_err()
        );
        f.settle();
        assert_eq!(replies(&f), 0);
    }
}
#[test]
fn default_question_is_blocked_and_disconnect_never_claims_native_answer() {
    let f = Fixture::new("interaction_question_default");
    assert!(
        f.runtime
            .start_turn(
                &f.store,
                &scope(1),
                &f.id,
                &f.coordinator,
                &f.router,
                "synthetic"
            )
            .is_err()
    );
    assert!(f.interactions.snapshots().unwrap().is_empty());
    assert_eq!(replies(&f), 0);
    let f = Fixture::new("interaction_disconnect");
    f.start();
    let interaction = open(&f);
    let until = Instant::now() + Duration::from_secs(2);
    while f.runtime.poll_turn_events(&scope(1)).is_ok() {
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(f.count(), 1);
    assert!(f.interactions.snapshots().unwrap().is_empty());
    assert!(
        f.runtime
            .reply_interaction(
                &f.store,
                &f.interactions,
                &interaction,
                decision(json!("accept"))
            )
            .is_err()
    );
    assert_eq!(replies(&f), 0);
}
#[test]
fn steer_while_waiting_keeps_original_turn_and_native_request_pending() {
    let f = Fixture::new("interaction_question");
    f.start();
    let interaction = open(&f);
    let (context, native) = f.runtime.turn_context(&scope(1)).unwrap();
    assert!(
        f.runtime
            .steer_turn(
                &f.store,
                &scope(1),
                &context,
                "wrong-turn",
                "steer-1",
                "wrong"
            )
            .is_err()
    );
    f.runtime
        .steer_turn(
            &f.store,
            &scope(1),
            &context,
            &native,
            "steer-1",
            "user correction",
        )
        .unwrap();
    assert_eq!(f.count(), 1);
    assert_eq!(replies(&f), 0);
    assert_eq!(f.interactions.snapshots().unwrap().len(), 1);
    assert!(
        f.runtime
            .steer_turn(
                &f.store,
                &scope(1),
                &context,
                &native,
                "steer-1",
                "duplicate"
            )
            .is_err()
    );
    f.runtime
        .steer_turn(
            &f.store,
            &scope(1),
            &context,
            &native,
            "steer-2",
            "another user correction",
        )
        .unwrap();
    assert_eq!(f.runtime.turn_context(&scope(1)).unwrap().1, native);
    f.runtime
        .interrupt_turn(&f.store, &scope(1), &context, &native)
        .unwrap();
    f.settle();
    assert_eq!(replies(&f), 0);
    assert_eq!(interaction.native_turn_id, native);
}
#[test]
fn delayed_steer_does_not_block_stop_or_mutate_a_later_turn() {
    let f = Fixture::new("steer_delay");
    f.start();
    let (context, native) = f.runtime.turn_context(&scope(1)).unwrap();
    thread::scope(|s| {
        let job = s.spawn(|| {
            f.runtime.steer_turn(
                &f.store,
                &scope(1),
                &context,
                &native,
                "steer-delayed",
                "user correction",
            )
        });
        let until = Instant::now() + Duration::from_secs(2);
        while !f
            .temp
            .path()
            .join("home/codex/synthetic-steer-count.json")
            .exists()
        {
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(5));
        }
        f.runtime
            .interrupt_turn(&f.store, &scope(1), &context, &native)
            .unwrap();
        assert!(
            f.runtime
                .steer_turn(
                    &f.store,
                    &scope(1),
                    &context,
                    &native,
                    "after-stop",
                    "blocked"
                )
                .is_err()
        );
        f.settle();
        assert!(job.join().unwrap().is_err());
    });
    assert_eq!(f.count(), 0);
    f.start();
    let (next, next_id) = f.runtime.turn_context(&scope(1)).unwrap();
    assert_ne!(next_id, native);
    assert!(
        f.runtime
            .steer_turn(
                &f.store,
                &scope(1),
                &context,
                &native,
                "old-context",
                "blocked"
            )
            .is_err()
    );
    f.runtime
        .interrupt_turn(&f.store, &scope(1), &next, &next_id)
        .unwrap();
    f.settle();
}
#[test]
fn rejected_steer_stays_unknown_but_explicit_stop_of_original_turn_remains_available() {
    let f = Fixture::new("steer_reject");
    f.start();
    let (context, native) = f.runtime.turn_context(&scope(1)).unwrap();
    assert!(
        f.runtime
            .steer_turn(
                &f.store,
                &scope(1),
                &context,
                &native,
                "rejected",
                "user correction"
            )
            .is_err()
    );
    assert_eq!(f.count(), 1);
    assert!(
        f.runtime
            .steer_turn(&f.store, &scope(1), &context, &native, "retry", "blocked")
            .is_err()
    );
    f.runtime
        .interrupt_turn(&f.store, &scope(1), &context, &native)
        .unwrap();
    f.settle();
}
#[test]
fn native_cancel_choice_is_explicit_and_sent_does_not_close_an_unresolved_request() {
    let f = Fixture::new("interaction_no_resolve");
    f.start();
    let interaction = open(&f);
    f.runtime
        .reply_interaction(
            &f.store,
            &f.interactions,
            &interaction,
            decision(json!("cancel")),
        )
        .unwrap();
    thread::sleep(Duration::from_millis(30));
    f.runtime.poll_turn_events(&scope(1)).unwrap();
    assert_eq!(f.interactions.snapshots().unwrap().len(), 1);
    assert_eq!(f.count(), 1);
    assert_eq!(replies(&f), 1);
    let (context, native) = f.runtime.turn_context(&scope(1)).unwrap();
    f.runtime
        .interrupt_turn(&f.store, &scope(1), &context, &native)
        .unwrap();
    f.settle();
}

#[test]
fn steer_timeout_keeps_unknown_reservation_without_retry() {
    let f = Fixture::new("steer_timeout");
    f.start();
    let (context, native) = f.runtime.turn_context(&scope(1)).unwrap();
    assert!(
        f.runtime
            .steer_turn(
                &f.store,
                &scope(1),
                &context,
                &native,
                "timed-out",
                "synthetic"
            )
            .is_err()
    );
    assert_eq!(f.count(), 1);
    assert!(
        f.runtime
            .steer_turn(&f.store, &scope(1), &context, &native, "retry", "blocked")
            .is_err()
    );
    let audit: Value = serde_json::from_slice(
        &fs::read(f.temp.path().join("home/codex/synthetic-steer-count.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(audit["count"], 1);
}

#[test]
fn pending_interaction_blocks_configuration_and_old_generation_reply_cannot_return() {
    use crate::codex_acp::threads::tests::{attach, shared_profile};
    let f = Fixture::new("interaction_command");
    f.start();
    let interaction = open(&f);
    assert!(
        f.runtime
            .configure(&scope(1), configure::CommandInput::Browser)
            .is_err()
    );
    assert!(
        f.runtime
            .read_turn_history(&f.store, &scope(1), &f.id)
            .is_err()
    );
    f.runtime.stop(&scope(1)).unwrap();
    assert!(f.interactions.snapshots().unwrap().is_empty());
    assert_eq!(f.count(), 1);
    let root = f.temp.path().canonicalize().unwrap();
    let workspace = attach(&f.runtime, &root, "interaction_command", 2);
    shared_profile(&f.store, &workspace, &root.join("home"), false);
    f.runtime
        .open_registered_thread(&f.store, &scope(2), &f.id)
        .unwrap();
    f.router
        .activate_connection(scope(2).binding().unwrap(), 2)
        .unwrap();
    assert!(
        f.runtime
            .reply_interaction(
                &f.store,
                &f.interactions,
                &interaction,
                decision(json!("accept"))
            )
            .is_err()
    );
    assert_eq!(replies(&f), 0);
    assert_eq!(f.count(), 1);
}
