//! Independent domain/collision/argv challenges; only owned synthetic peers/state.
use super::{
    domain::Domain,
    mcp_add_input, mcp_add_plan,
    mcp_add_tests::{Fixture, input},
    plan::Config,
    requests,
    types::*,
};
use crate::acp_client::extension_inventory::{mcp_targets, output};
use serde_json::json;

#[test]
fn mcp_add_independent_wrong_domain_tombstone_cannot_be_retyped() {
    let f = Fixture::new(json!([]));
    for domain in [Domain::Skill, Domain::McpEnabled] {
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
                .cancel_domain(&f.agent, &id, Domain::McpAdd)
                .err()
                .unwrap()
                .code,
            Code::RequestConflict
        );
        assert_eq!(
            f.registry
                .begin_add_inspect(
                    &f.agent,
                    &id,
                    &f.inventory,
                    &requests::uuid().unwrap(),
                    input(),
                )
                .err()
                .unwrap()
                .code,
            Code::RequestConflict
        );
        // The original domain's tombstone remains; it is not overwritten by
        // wrong-endpoint status/cancel/admission attempts.
        assert!(
            f.registry
                .cancel_domain(&f.agent, &id, domain)
                .unwrap()
                .operation
                .is_none()
        );
    }
    let id = requests::uuid().unwrap();
    f.registry
        .cancel_domain(&f.agent, &id, Domain::McpAdd)
        .unwrap();
    for domain in [Domain::Skill, Domain::McpEnabled] {
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
            .begin_add_inspect(
                &f.agent,
                &id,
                &f.inventory,
                &requests::uuid().unwrap(),
                input(),
            )
            .err()
            .unwrap()
            .code,
        Code::Cancelled
    );
    assert_eq!(f.state()["writes"], 0);
}

#[test]
fn mcp_add_independent_raw_names_survive_hidden_and_unmanageable_projection() {
    let rows = json!([
        {"name":"https://hidden.invalid/label","enabled":false,
         "transport":{"type":"future"},"auth_status":"unsupported"},
        {"name":"sample.new","enabled":false,
         "transport":{"type":"future"},"auth_status":"unsupported"}
    ]);
    let bytes = serde_json::to_vec(&rows).unwrap();
    let (public, targets) = output::parse_private(&bytes).unwrap();
    assert!(public.complete);
    assert!(public.items[0].name.is_none());
    assert_eq!(public.items[1].name.as_deref(), Some("sample.new"));
    assert!(targets.is_empty());
    let names = output::names(&bytes).unwrap();
    assert_eq!(names.len(), 2);
    assert!(names.contains("https://hidden.invalid/label"));
    assert!(names.contains("sample.new"));
    let f = Fixture::new(rows);
    let source = mcp_targets::catalogue(&f.agent, &f.inventory).unwrap();
    assert!(source.set.entries.is_empty());
    assert_eq!(source.set.names, names);
    let job = f.job();
    f.run(&job, "normal");
    let operation = job.snapshot();
    assert_eq!(operation.code, Some(Code::NameConflict));
    assert_eq!(operation.outcome, Some(Outcome::NotDispatched));
    assert!(!operation.write_dispatched);
    assert_eq!(f.state()["methods"], json!([]));
    assert_eq!(f.state()["writes"], 0);
}

#[test]
fn mcp_add_independent_same_disabled_requires_exact_argv_and_transport() {
    let raw = json!({"layers":[{"name":{"type":"user","file":"/synthetic/config.toml"},"version":"v1","config":{"unrelated":{"keep":true}}}]});
    let before = Config::parse(raw.clone()).unwrap();
    let intended_input = mcp_add_input::Input {
        args: vec!["".into(), " ".into(), "two words".into(), "'$HOME'".into()],
        ..input()
    };
    let p = mcp_add_plan::Plan::new(before.clone(), before, intended_input.clone()).unwrap();
    let mut after = raw;
    after["layers"][0]["config"] = p.intended.clone();
    let after = Config::parse(after).unwrap();
    let valid = json!({"name":intended_input.name,"enabled":false,"transport":{"type":"stdio","command":intended_input.executable_path,"args":intended_input.args}});
    assert!(p.observation(&after, &after, Some(&valid)).unwrap().1);
    let mut future = valid.clone();
    future["transport"]["type"] = json!("future");
    let mut dropped_empty = valid.clone();
    dropped_empty["transport"]["args"] = json!([" ", "two words", "'$HOME'"]);
    let mut split = valid;
    split["transport"]["args"] = json!(["", " ", "two", "words", "'$HOME'"]);
    for report in [future, dropped_empty, split] {
        let parsed =
            mcp_add_plan::parse_report(&serde_json::to_vec(&report).unwrap(), &intended_input.name)
                .unwrap();
        let (observation, matching) = p.observation(&after, &after, Some(&parsed)).unwrap();
        assert!(!matching);
        assert_eq!(observation.configuration, "matching");
        assert_eq!(observation.mcp, Some("different"));
        assert_eq!(observation.reported_enabled, Some(false));
    }
}

#[test]
fn mcp_add_independent_input_id_and_bytes_are_both_part_of_request_identity() {
    let f = Fixture::new(json!([]));
    let id = requests::uuid().unwrap();
    let input_id = requests::uuid().unwrap();
    let (job, fresh) = f
        .registry
        .begin_add_inspect(&f.agent, &id, &f.inventory, &input_id, input())
        .unwrap();
    assert!(fresh);
    assert_eq!(
        f.registry
            .begin_add_inspect(
                &f.agent,
                &id,
                &f.inventory,
                &requests::uuid().unwrap(),
                input(),
            )
            .err()
            .unwrap()
            .code,
        Code::RequestConflict
    );
    let mut changed = input();
    changed.args[0] = " ".into();
    assert_eq!(
        f.registry
            .begin_add_inspect(&f.agent, &id, &f.inventory, &input_id, changed)
            .err()
            .unwrap()
            .code,
        Code::RequestConflict
    );
    let (same, fresh) = f
        .registry
        .begin_add_inspect(&f.agent, &id, &f.inventory, &input_id, input())
        .unwrap();
    assert!(!fresh);
    assert!(std::sync::Arc::ptr_eq(&same, &job));
    assert!(job.operation.interested());
    f.registry
        .cancel_domain(&f.agent, &id, Domain::McpAdd)
        .unwrap();
    f.run(&job, "normal");
    assert_eq!(job.snapshot().state, State::Cancelled);
    assert_eq!(f.state()["writes"], 0);
}
