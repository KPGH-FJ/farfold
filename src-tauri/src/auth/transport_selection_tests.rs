//! Public synthetic declarations only; no Agent, credential or PTY is started.
use super::*;
use crate::acp_client::handshake::Handshake;
use serde_json::{Value, json};
use std::os::unix::fs::PermissionsExt;

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
    let old = row("/fixture/agent", json!({"id":"login", "name":"Login"}));
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
        vec!["/fixture/agent", "--acp", "--login"]
    );
}

#[test]
fn verified_legacy_terminal_requires_the_same_explicit_selection() {
    let root = tempfile::tempdir().unwrap();
    let command = root.path().join("chosen");
    std::fs::write(&command, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();
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
        let row = row("/fixture/agent", declaration);
        let method = runnable_auth_method(&row, "login", &ManagedTerminalProof::default()).unwrap();
        for selected in [None, Some(false)] {
            assert!(!auth_uses_terminal(&method, selected).unwrap());
        }
    }
}
