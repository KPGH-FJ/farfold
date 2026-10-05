//! Public synthetic declarations only; no Agent, credential or PTY is started.
use super::*;
use crate::acp_client::handshake::Handshake;
use serde_json::{Value, json};

fn fixture_program() -> &'static str {
    if cfg!(windows) {
        r"C:\fixture\agent.exe"
    } else {
        "/fixture/agent"
    }
}

fn row(command: &str, method: Value) -> AgentRow {
    let handshake = Handshake::decode(json!({
        "protocolVersion":1, "agentCapabilities":{}, "authMethods":[method]
    }))
    .unwrap();
    AgentRow {
        id: "auth-transport-fixture".into(),
        name: "Fixture".into(),
        source: "custom".into(),
        command: command.into(),
        args: vec!["--acp".into()],
        env: vec![],
        version: None,
        handshake: Some(handshake.execution_json()),
        created_at: 0,
        updated_at: 0,
    }
}

#[test]
fn changed_terminal_declaration_rejects_the_old_protocol_selection() {
    let old = row(fixture_program(), json!({"id":"login", "name":"Login"}));
    let old_method = runnable_auth_method(&old, "login", &ManagedTerminalProof::default()).unwrap();
    assert!(!auth_uses_terminal(&old_method, None).unwrap());

    let current = row(
        &old.command,
        json!({"id":"login", "name":"Login", "type":"terminal", "args":["--login"]}),
    );
    let current_method =
        runnable_auth_method(&current, "login", &ManagedTerminalProof::default()).unwrap();
    assert_eq!(current_method.id, old_method.id);
    for selected in [None, Some(false)] {
        assert_eq!(
            auth_uses_terminal(&current_method, selected).unwrap_err(),
            "登录方式已变化，请重新选择"
        );
    }
    assert!(auth_uses_terminal(&current_method, Some(true)).unwrap());
    assert_eq!(
        derive_terminal_invocation(&current, &current_method)
            .unwrap()
            .argv,
        vec![fixture_program(), "--acp", "--login"]
    );
}

#[test]
fn verified_legacy_terminal_requires_the_same_explicit_selection() {
    let root = tempfile::tempdir().unwrap();
    let command = root.path().canonicalize().unwrap().join(if cfg!(windows) {
        "chosen.exe"
    } else {
        "chosen"
    });
    std::fs::write(&command, "#!/bin/sh\nexit 0\n").unwrap();
    crate::process_platform::set_executable(&command).unwrap();
    let row = row(
        command.to_str().unwrap(),
        json!({"id":"login", "name":"Login", "_meta":{"terminal-auth":{
            "command":command, "args":["--login"]
        }}}),
    );
    let method = runnable_auth_method(&row, "login", &ManagedTerminalProof::default()).unwrap();
    for selected in [None, Some(false)] {
        assert_eq!(
            auth_uses_terminal(&method, selected).unwrap_err(),
            "登录方式已变化，请重新选择"
        );
    }
    assert!(auth_uses_terminal(&method, Some(true)).unwrap());
    assert_eq!(
        derive_terminal_invocation(&row, &method).unwrap().argv,
        vec![row.command.clone(), "--login".into()]
    );
}

#[test]
fn protocol_and_provider_key_selection_stay_out_of_the_terminal_path() {
    for declaration in [
        json!({"id":"login", "name":"Login"}),
        json!({"id":"login", "name":"Login", "type":"agent"}),
        json!({"id":"login", "name":"API Key", "_meta":{"api-key":{"provider":"openai"}}}),
    ] {
        let row = row(fixture_program(), declaration);
        let method = runnable_auth_method(&row, "login", &ManagedTerminalProof::default()).unwrap();
        for selected in [None, Some(false)] {
            assert!(!auth_uses_terminal(&method, selected).unwrap());
        }
    }
}
