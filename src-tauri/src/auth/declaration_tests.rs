//! Real SDK normalization followed by the application classification.
use super::*;
use crate::acp_client::handshake::Handshake;
use serde_json::{Value, json};

fn from_wire(method: Value) -> AgentRow {
    let typed = Handshake::decode(json!({
        "protocolVersion":1, "agentCapabilities":{}, "authMethods":[method]
    }))
    .unwrap();
    AgentRow {
        id: "declaration-fixture".into(),
        name: "Fixture".into(),
        source: "custom".into(),
        command: "/fixture/agent".into(),
        args: vec!["--acp".into()],
        env: vec![],
        version: None,
        handshake: Some(typed.execution_json()),
        created_at: 0,
        updated_at: 0,
    }
}

#[test]
fn auth_declaration_environment_survives_sdk_and_cannot_become_authenticate() {
    let row = from_wire(
        json!({"id":"public-key","name":"Public Key","type":"env_var",
        "vars":[{"name":"FIXTURE_KEY"},{"name":"FIXTURE_REGION"}]}),
    );
    let info = auth_methods_for(&row);
    assert_eq!(info.methods[0].kind, "environment");
    assert!(info.methods[0].unavailable_reason.is_some());
    let value = serde_json::to_value(&info).unwrap();
    assert_eq!(
        value["methods"][0]["envNames"],
        json!(["FIXTURE_KEY", "FIXTURE_REGION"])
    );
}

#[test]
fn auth_declaration_unknown_type_is_not_the_default_agent_method() {
    let row = from_wire(json!({"id":"future","name":"Future","type":"future-login"}));
    let info = auth_methods_for(&row);
    assert_eq!(info.methods[0].kind, "unsupported");
    assert!(info.methods[0].unavailable_reason.is_some());
}

#[test]
fn auth_declaration_malformed_terminal_must_not_run_filtered_arguments() {
    let row = from_wire(json!({"id":"terminal","name":"Terminal","type":"terminal",
        "args":["login",false],"env":{"FIXTURE_PUBLIC":"yes"}}));
    let info = auth_methods_for(&row);
    assert!(info.methods[0].unavailable_reason.is_some());
    assert!(info.methods[0].terminal_command.is_none());
}
