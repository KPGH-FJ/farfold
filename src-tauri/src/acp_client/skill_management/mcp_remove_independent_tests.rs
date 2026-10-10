//! Independent removal authority/publication challenges using only owned peers.
use super::{domain::Domain, mcp_remove_tests::Fixture, requests, types::*};
use crate::acp_client::extension_inventory::{self as inventory, InventorySnapshot};
use serde_json::{Value, json};
use std::sync::Arc;

fn snapshot(job: &requests::Job) -> Value {
    serde_json::to_value(job.snapshot()).unwrap()
}

#[test]
fn mcp_remove_independent_incomplete_original_cannot_borrow_a_fresh_complete_list() {
    let f = Fixture::new(false, false);
    let original = inventory::requests::shared()
        .get(&f.agent, &f.inventory)
        .unwrap();
    assert!(original.mcp_targets.lock().unwrap().is_some());
    original.changed.send_modify(|value| {
        let op = value.as_mut().unwrap();
        assert!(op.settled);
        assert_eq!(op.state, inventory::State::Ready);
        let Some(InventorySnapshot::Mcp(public)) = op.snapshot.as_mut() else {
            panic!("expected the actual fixture's MCP snapshot");
        };
        public.complete = false;
    });
    let id = requests::uuid().unwrap();
    assert_eq!(
        f.registry
            .begin_remove_inspect(&f.agent, &id, &f.inventory, 0)
            .err()
            .unwrap()
            .code,
        Code::InventoryIncomplete
    );
    assert_eq!(
        f.registry
            .get_domain(&f.agent, &id, Domain::McpRemove)
            .err()
            .unwrap()
            .code,
        Code::UnknownRequest
    );
    // Its private map is deliberately still present and the peer could return a
    // complete list; neither is allowed to cure incomplete original authority.
    assert!(original.mcp_targets.lock().unwrap().is_some());
    assert_eq!(f.state()["methods"], json!([]));
    assert_eq!(f.state()["gets"], 0);
    assert_eq!(f.state()["lists"], 0);
    assert_eq!(f.state()["writes"], 0);
}

#[test]
fn mcp_remove_independent_four_domain_tombstones_and_real_review_stay_separate() {
    let f = Fixture::new(false, true);
    let other_domains = [Domain::Skill, Domain::McpEnabled, Domain::McpAdd];
    for domain in other_domains {
        let id = requests::uuid().unwrap();
        assert!(
            f.registry
                .cancel_domain(&f.agent, &id, domain)
                .unwrap()
                .operation
                .is_none()
        );
        assert_eq!(
            f.registry
                .cancel_domain(&f.agent, &id, Domain::McpRemove)
                .err()
                .unwrap()
                .code,
            Code::RequestConflict
        );
        assert_eq!(
            f.registry
                .begin_remove_inspect(&f.agent, &id, &f.inventory, 0)
                .err()
                .unwrap()
                .code,
            Code::RequestConflict
        );
        assert!(
            f.registry
                .cancel_domain(&f.agent, &id, domain)
                .unwrap()
                .operation
                .is_none()
        );
    }
    let id = requests::uuid().unwrap();
    assert!(
        f.registry
            .cancel_domain(&f.agent, &id, Domain::McpRemove)
            .unwrap()
            .operation
            .is_none()
    );
    for domain in other_domains {
        assert_eq!(
            f.registry
                .cancel_domain(&f.agent, &id, domain)
                .err()
                .unwrap()
                .code,
            Code::RequestConflict
        );
    }
    assert_eq!(
        f.registry
            .begin_remove_inspect(&f.agent, &id, &f.inventory, 0)
            .err()
            .unwrap()
            .code,
        Code::Cancelled
    );
    assert_eq!(f.state()["writes"], 0);

    let (inspect, review) = f.inspect();
    let inspect_before = snapshot(&inspect);
    for domain in other_domains {
        assert_eq!(
            f.registry
                .get_domain(&f.agent, &inspect.snapshot().request_id, domain)
                .err()
                .unwrap()
                .code,
            Code::UnknownRequest
        );
        assert_eq!(
            f.registry
                .cancel_domain(&f.agent, &inspect.snapshot().request_id, domain)
                .err()
                .unwrap()
                .code,
            Code::RequestConflict
        );
        assert_eq!(
            f.registry
                .begin_confirm_domain(
                    &f.agent,
                    &requests::uuid().unwrap(),
                    &review.review_id,
                    domain
                )
                .err()
                .unwrap()
                .code,
            Code::TargetUnavailable
        );
        assert_eq!(snapshot(&inspect), inspect_before);
        assert!(inspect.operation.interested());
    }
    let confirm = f.confirm(&review);
    f.run(&confirm, "normal");
    assert_eq!(confirm.snapshot().outcome, Some(Outcome::Verified));
    let confirm_before = snapshot(&confirm);
    for domain in other_domains {
        assert_eq!(
            f.registry
                .begin_recheck_domain(
                    &f.agent,
                    &requests::uuid().unwrap(),
                    &confirm.snapshot().request_id,
                    domain
                )
                .err()
                .unwrap()
                .code,
            Code::Busy
        );
        assert_eq!(
            f.registry
                .cancel_domain(&f.agent, &confirm.snapshot().request_id, domain)
                .err()
                .unwrap()
                .code,
            Code::RequestConflict
        );
        assert_eq!(snapshot(&confirm), confirm_before);
    }
    let (same, fresh) = f
        .registry
        .begin_confirm_domain(
            &f.agent,
            &confirm.snapshot().request_id,
            &review.review_id,
            Domain::McpRemove,
        )
        .unwrap();
    assert!(!fresh);
    assert!(Arc::ptr_eq(&same, &confirm));
    assert_eq!(f.state()["writes"], 1);
}

#[test]
fn mcp_remove_independent_pending_facts_publish_only_at_terminal_finish() {
    let f = Fixture::new(true, false);
    let inspect = f.job();
    f.run_unfinished(&inspect, "normal").unwrap();
    let running = inspect.snapshot();
    assert!(!running.settled);
    assert!(running.review.is_none());
    assert!(running.observation.is_none());
    assert!(running.outcome.is_none());
    inspect.finish(None);
    let review = inspect.snapshot().review.unwrap();
    assert_eq!(review.requested_enabled, None);
    let confirm = f.confirm(&review);
    f.run_unfinished(&confirm, "normal").unwrap();
    let running = confirm.snapshot();
    assert!(!running.settled);
    assert!(running.write_dispatched);
    assert_eq!(running.write_ack, Ack::Ok);
    assert!(running.review.is_none());
    assert!(running.observation.is_none());
    assert!(running.outcome.is_none());
    confirm.finish(None);
    let ready = confirm.snapshot();
    assert!(ready.settled);
    assert_eq!(ready.state, State::Ready);
    assert_eq!(ready.outcome, Some(Outcome::Verified));
    let observation = ready.observation.unwrap();
    assert_eq!(observation.configuration, "matching");
    assert_eq!(observation.mcp, Some("absent"));
    assert_eq!(observation.configured_enabled, Some(None));
    assert_eq!(observation.reported_enabled, None);
    assert_eq!(observation.parent_outcome, Some(Some("empty")));
    assert_eq!(f.state()["writes"], 1);
}

#[test]
fn mcp_remove_independent_failed_finish_discards_pending_verified_observation() {
    let f = Fixture::new(false, false);
    let (_, review) = f.inspect();
    let confirm = f.confirm(&review);
    f.run_unfinished(&confirm, "normal").unwrap();
    f.registry
        .cancel_domain(&f.agent, &confirm.snapshot().request_id, Domain::McpRemove)
        .unwrap();
    // A method-level publication boundary, not a claim about a hung OS worker:
    // after readback, an explicit error must not publish pending Verified facts.
    confirm.finish(Some(Code::Cancelled.into()));
    let failed = confirm.snapshot();
    assert!(failed.settled);
    assert_eq!(failed.state, State::Failed);
    assert_eq!(failed.outcome, Some(Outcome::Unknown));
    assert!(failed.write_dispatched);
    assert_eq!(failed.write_ack, Ack::Ok);
    assert!(failed.observation.is_none());
    assert!(failed.review.is_none());
    let before = snapshot(&confirm);
    confirm.finish(None);
    assert_eq!(snapshot(&confirm), before);
    assert_eq!(f.state()["writes"], 1);
}

#[test]
fn mcp_remove_independent_unknown_and_rejected_rechecks_never_rewrite_original() {
    for (mode, old_outcome, ack, observed, writes) in [
        (
            "lost-ack",
            Outcome::Unknown,
            Ack::Unknown,
            Outcome::Observed,
            1,
        ),
        (
            "refused",
            Outcome::Rejected,
            Ack::Rejected,
            Outcome::Mismatch,
            0,
        ),
    ] {
        let f = Fixture::new(false, true);
        let (_, review) = f.inspect();
        let confirm = f.confirm(&review);
        f.run(&confirm, mode);
        let old = confirm.snapshot();
        assert!(old.settled);
        assert!(old.write_dispatched);
        assert_eq!(old.write_ack, ack);
        assert_eq!(old.outcome, Some(old_outcome));
        let before = snapshot(&confirm);
        let check = f.recheck(&confirm);
        f.run(&check, "normal");
        let current = check.snapshot();
        assert_eq!(current.action, Action::Recheck);
        assert_eq!(current.state, State::Ready);
        assert_eq!(current.outcome, Some(observed));
        assert_eq!(current.write_dispatched, old.write_dispatched);
        assert_eq!(current.write_ack, old.write_ack);
        assert_ne!(current.request_id, old.request_id);
        assert_eq!(snapshot(&confirm), before);
        assert_eq!(f.state()["writes"], writes);
        let failed_check = f.recheck(&confirm);
        f.run(&failed_check, "postlist-fail");
        let failed = failed_check.snapshot();
        assert!(failed.settled);
        assert_eq!(failed.outcome, Some(Outcome::Unknown));
        assert_eq!(failed.write_ack, old.write_ack);
        assert!(failed.observation.is_none());
        assert_eq!(snapshot(&confirm), before);
        assert_eq!(f.state()["writes"], writes);
    }
}
