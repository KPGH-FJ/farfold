//! Owned executable fixtures only; no official Agent, account or credential access.
use super::*;
use std::os::unix::{fs::PermissionsExt, fs::symlink};

fn executable(path: &std::path::Path) {
    std::fs::write(path, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}
fn row(
    command: &std::path::Path,
    args: Vec<String>,
    target: &str,
    target_args: serde_json::Value,
) -> AgentRow {
    AgentRow {
        id: "target-fixture".into(),
        name: "Fixture".into(),
        source: "custom".into(),
        command: command.display().to_string(),
        args,
        env: vec![],
        version: None,
        handshake: Some(
            serde_json::json!({"authMethods":[{"id":"login","name":"Login",
            "_meta":{"terminal-auth":{"command":target,"args":target_args}}}]}),
        ),
        created_at: 1,
        updated_at: 1,
    }
}
fn assert_unavailable(row: &AgentRow) {
    let info = auth_methods_for(row);
    assert_eq!(info.methods.len(), 1);
    assert_eq!(info.methods[0].kind, "agent");
    assert!(info.methods[0].terminal_command.is_none());
    assert!(serde_json::to_value(&info.methods[0]).unwrap()["unavailableReason"].is_string());
    assert!(derive_terminal_invocation(row, &parse_auth_methods(row)[0]).is_err());
}
#[test]
fn unknown_legacy_program_is_unavailable_without_changing_the_protocol_method() {
    let dir = tempfile::tempdir().unwrap();
    let selected = dir.path().join("chosen");
    let other = dir.path().join("other");
    executable(&selected);
    executable(&other);
    let row = row(
        &selected,
        vec!["acp".into()],
        other.to_str().unwrap(),
        serde_json::json!(["login"]),
    );
    let before = row.clone();
    assert_unavailable(&row);
    assert_eq!(row, before);
}
#[test]
fn malformed_legacy_arguments_are_not_silently_filtered_into_a_command() {
    let dir = tempfile::tempdir().unwrap();
    let selected = dir.path().join("chosen");
    executable(&selected);
    for args in [
        serde_json::json!(["login", 7]),
        serde_json::json!("login"),
        serde_json::json!(["bad\u{0000}arg"]),
    ] {
        assert_unavailable(&row(
            &selected,
            vec!["acp".into()],
            selected.to_str().unwrap(),
            args,
        ));
    }
}
#[test]
fn verified_same_program_alias_executes_the_selected_absolute_path_with_full_legacy_args() {
    let dir = tempfile::tempdir().unwrap();
    let selected = dir.path().join("chosen");
    let alias = dir.path().join("alias");
    executable(&selected);
    symlink(&selected, &alias).unwrap();
    let row = row(
        &selected,
        vec!["acp".into()],
        alias.to_str().unwrap(),
        serde_json::json!(["auth", "login"]),
    );
    assert_eq!(
        auth_methods_for(&row).methods[0].terminal_command,
        Some(vec![
            selected.display().to_string(),
            "auth".into(),
            "login".into()
        ])
    );
}
#[test]
fn the_same_node_executable_does_not_authorize_a_different_script() {
    let dir = tempfile::tempdir().unwrap();
    let node = dir.path().join("node");
    executable(&node);
    let selected = dir.path().join("chosen.js");
    let other = dir.path().join("other.js");
    std::fs::write(&selected, "").unwrap();
    std::fs::write(&other, "").unwrap();
    assert_unavailable(&row(
        &node,
        vec![selected.display().to_string(), "--acp".into()],
        node.to_str().unwrap(),
        serde_json::json!([other.display().to_string(), "login"]),
    ));
}
#[test]
fn a_script_alias_uses_the_selected_node_and_entry_instead_of_direct_execution() {
    let dir = tempfile::tempdir().unwrap();
    let node = dir.path().join("node");
    executable(&node);
    let selected = dir.path().join("chosen.js");
    let alias = dir.path().join("chosen");
    executable(&selected);
    symlink(&selected, &alias).unwrap();
    let row = row(
        &node,
        vec![selected.display().to_string(), "--acp".into()],
        alias.to_str().unwrap(),
        serde_json::json!(["login"]),
    );
    assert_eq!(
        auth_methods_for(&row).methods[0].terminal_command,
        Some(vec![
            node.display().to_string(),
            selected.display().to_string(),
            "login".into()
        ])
    );
}

#[test]
fn an_invalid_typed_terminal_keeps_its_kind_and_cannot_be_automatically_run() {
    let dir = tempfile::tempdir().unwrap();
    let selected = dir.path().join("selected");
    executable(&selected);
    let mut row = row(
        &selected,
        vec!["acp".into()],
        selected.to_str().unwrap(),
        serde_json::json!([]),
    );
    row.handshake = Some(
        serde_json::json!({"authMethods":[{"id":"login","name":"Login","type":"terminal","args":["bad\u{0000}arg"],
        "_meta":{"terminal-auth":{"command":selected,"args":["safe-looking"]}}}]}),
    );
    let info = auth_methods_for(&row);
    assert_eq!(info.methods[0].kind, "terminal");
    assert!(info.methods[0].terminal_command.is_none());
    assert!(info.methods[0].unavailable_reason.is_some());
}
