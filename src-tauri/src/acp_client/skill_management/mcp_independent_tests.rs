//! Independent list/get shape challenge against the production private decoder.
use crate::acp_client::extension_inventory::{Code, mcp_targets, output};
use serde_json::json;

#[test]
fn official_list_omits_tool_filters_but_first_get_may_report_them() {
    // Official mcp_cmd.rs list omits these two fields; get includes them.
    let list_row = json!({
        "name": "bounded.fixture",
        "enabled": true,
        "disabled_reason": null,
        "transport": {
            "type": "stdio", "command": "/usr/bin/true", "args": [],
            "env": {"PRIVATE_CANARY": "preserve-only-in-private-memory"},
            "env_vars": [], "cwd": null
        },
        "startup_timeout_sec": null,
        "tool_timeout_sec": null,
        "auth_status": "unsupported"
    });
    let (public, targets) =
        output::parse_private(&serde_json::to_vec(&json!([list_row.clone()])).unwrap()).unwrap();
    assert_eq!(targets.len(), 1);
    assert!(
        !serde_json::to_string(&public)
            .unwrap()
            .contains("preserve-only-in-private-memory")
    );
    let mut get_row = list_row;
    get_row.as_object_mut().unwrap().remove("auth_status");
    get_row["enabled_tools"] = json!(["read_file"]);
    get_row["disabled_tools"] = json!(["write_file"]);

    let first = mcp_targets::report(&serde_json::to_vec(&get_row).unwrap(), &targets[0]);
    assert!(
        first.is_ok(),
        "first get must accept fields the official list never reports: {:?}",
        first.err().map(|error| error.code)
    );

    // Once a complete get has been observed, later filter drift is material.
    let observed = mcp_targets::target(&get_row, targets[0].id).unwrap();
    get_row["enabled_tools"] = json!(["read_file", "write_file"]);
    assert_eq!(
        mcp_targets::report(&serde_json::to_vec(&get_row).unwrap(), &observed)
            .err()
            .map(|error| error.code),
        Some(Code::TargetChanged)
    );
}

#[test]
fn mcp_endpoints_cannot_consume_or_retire_an_existing_skill_review() {
    use crate::acp_client::extension_inventory::Kind;
    let fixture = super::tests::Fixture::new();
    let (inspection, review) = fixture.inspect();
    let original = inspection.snapshot();
    let registry = &fixture.registry;
    assert_eq!(
        registry
            .get_kind(&fixture.agent, &original.request_id, Kind::Mcp)
            .err()
            .map(|error| error.code),
        Some(Code::UnknownRequest)
    );
    assert_eq!(
        registry
            .cancel_kind(&fixture.agent, &original.request_id, Kind::Mcp)
            .err()
            .map(|error| error.code),
        Some(Code::RequestConflict)
    );
    assert_eq!(
        registry
            .begin_inspect_kind(
                &fixture.agent,
                &original.request_id,
                &fixture.inventory,
                0,
                true,
                Kind::Mcp,
            )
            .err()
            .map(|error| error.code),
        Some(Code::RequestConflict)
    );
    let confirmation_id = super::requests::uuid().unwrap();
    assert_eq!(
        registry
            .begin_confirm_kind(
                &fixture.agent,
                &confirmation_id,
                &review.review_id,
                Kind::Mcp,
            )
            .err()
            .map(|error| error.code),
        Some(Code::TargetUnavailable)
    );
    assert!(inspection.operation.interested());
    assert_eq!(
        serde_json::to_value(inspection.snapshot()).unwrap(),
        serde_json::to_value(original).unwrap()
    );
    let (correct, fresh) = registry
        .begin_confirm(&fixture.agent, &confirmation_id, &review.review_id)
        .unwrap();
    assert!(fresh);
    assert!(!correct.snapshot().write_dispatched);
    // This test admits a confirmation but never dispatches an actual write.
    correct.finish(Some(Code::Cancelled.into()));
}
