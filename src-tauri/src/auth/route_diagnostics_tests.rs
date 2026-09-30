//! Owned file fixtures only. No Agent, account, credential or user data access.
use super::*;
use serde_json::json;
use std::{os::unix::fs::PermissionsExt, path::Path};

const INVALID: &str = "此登录方式提供的信息不完整或格式不正确，请在更多登录方式中明确配置";
const PATH_UNAVAILABLE: &str = "无法确认此登录方式的程序路径，请检查程序或在更多登录方式中明确配置";
const LAUNCH_UNSUPPORTED: &str = "此登录方式的启动参数尚不能自动确认，请在更多登录方式中明确配置";
const PROGRAM_MISMATCH: &str = "此登录方式的程序与当前程序不一致，请在更多登录方式中明确配置";
const SCRIPT_MISMATCH: &str = "此登录方式的脚本与当前程序不一致，请在更多登录方式中明确配置";
const CANARY: &str = "fixture-auth-route-sensitive-canary";

fn executable(path: &Path) {
    std::fs::write(path, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}
fn row(command: &Path, args: Vec<String>, method: serde_json::Value) -> AgentRow {
    AgentRow {
        id: "route-diagnostics-fixture".into(),
        name: "Fixture".into(),
        source: "custom".into(),
        command: command.display().to_string(),
        args,
        env: vec![],
        version: None,
        handshake: Some(json!({"authMethods":[method]})),
        created_at: 1,
        updated_at: 1,
    }
}
fn legacy(command: &Path, args: serde_json::Value) -> serde_json::Value {
    json!({"id":"login","name":"Login","env":{"FIXTURE":CANARY},
        "_meta":{"terminal-auth":{"command":command,"args":args},"extra":CANARY}})
}
fn denied(row: &AgentRow, expected: &str) {
    let original = row.clone();
    let info = auth_methods_for(row);
    assert_eq!(info.methods.len(), 1);
    assert_eq!(
        info.methods[0].unavailable_reason.as_deref(),
        Some(expected)
    );
    assert!(info.methods[0].terminal_command.is_none());
    assert!(info.methods[0].env_name.is_none());
    assert!(!serde_json::to_string(&info).unwrap().contains(CANARY));
    let parsed = &parse_auth_methods(row)[0];
    assert!(parsed.invocation.is_none());
    assert!(!parsed.is_api_key);
    assert_eq!(
        derive_terminal_invocation(row, parsed).unwrap_err(),
        expected
    );
    assert!(!crate::acp_client::auth_route::protocol_method(
        &row.handshake.as_ref().unwrap()["authMethods"][0]
    ));
    assert_eq!(row, &original);
}

#[test]
fn auth_route_diagnostics_invalid_markers_and_malformed_values_have_fixed_reason() {
    let dir = tempfile::tempdir().unwrap();
    let selected = dir.path().join("selected");
    executable(&selected);
    for method in [
        json!({"id":"login","name":"Login","_farfoldInvalid":true,"secret":CANARY}),
        legacy(&selected, json!(["login", false])),
        json!({"id":"login","name":"Login","type":"terminal","args":[CANARY,false]}),
        json!({"id":"login","name":"Login","_meta":{"terminal-auth":{"command":selected,"label":false}}}),
    ] {
        denied(&row(&selected, vec!["acp".into()], method), INVALID);
    }
}

#[test]
fn auth_route_diagnostics_unresolved_paths_are_distinct_from_another_program() {
    let dir = tempfile::tempdir().unwrap();
    let selected = dir.path().join("selected");
    executable(&selected);
    let missing = dir.path().join(CANARY);
    denied(
        &row(
            &selected,
            vec!["acp".into()],
            legacy(&missing, json!([CANARY])),
        ),
        PATH_UNAVAILABLE,
    );
    let other = dir.path().join("other");
    executable(&other);
    denied(
        &row(
            &selected,
            vec!["acp".into()],
            legacy(&other, json!([CANARY])),
        ),
        PROGRAM_MISMATCH,
    );
}

#[test]
fn auth_route_diagnostics_script_mismatch_does_not_authorize_the_same_interpreter() {
    let dir = tempfile::tempdir().unwrap();
    let python = dir.path().join("python3.13");
    let selected = dir.path().join("selected.py");
    let other = dir.path().join("other.py");
    for path in [&python, &selected, &other] {
        executable(path);
    }
    denied(
        &row(
            &python,
            vec![selected.display().to_string(), "--acp".into()],
            legacy(&python, json!([other, CANARY])),
        ),
        SCRIPT_MISMATCH,
    );
}

#[test]
fn auth_route_diagnostics_interpreter_flags_and_missing_scripts_remain_unavailable() {
    let dir = tempfile::tempdir().unwrap();
    let node = dir.path().join("node");
    executable(&node);
    denied(
        &row(
            &node,
            vec!["-e".into(), CANARY.into()],
            legacy(&node, json!(["-e", CANARY])),
        ),
        LAUNCH_UNSUPPORTED,
    );
    let missing = dir.path().join(CANARY);
    denied(
        &row(
            &node,
            vec![missing.display().to_string(), "--acp".into()],
            legacy(&node, json!([missing, "login"])),
        ),
        PATH_UNAVAILABLE,
    );
}

#[test]
fn auth_route_diagnostics_malformed_environment_is_not_partially_delivered() {
    let dir = tempfile::tempdir().unwrap();
    let selected = dir.path().join("selected");
    executable(&selected);
    let mut method = legacy(&selected, json!(["login", CANARY]));
    method["env"] = json!({"BAD-NAME":CANARY});
    denied(&row(&selected, vec!["acp".into()], method), INVALID);
}

#[test]
fn auth_route_diagnostics_standard_terminal_still_appends_exact_declared_arguments() {
    let dir = tempfile::tempdir().unwrap();
    let selected = dir.path().join("selected");
    let row = row(
        &selected,
        vec!["acp".into()],
        json!({"id":"login","name":"Login","type":"terminal","args":["acp","login"],"env":{"PUBLIC":"value"},"_meta":{"terminal-auth":false}}),
    );
    let method = &parse_auth_methods(&row)[0];
    assert!(method.unavailable_reason.is_none());
    let invocation = derive_terminal_invocation(&row, method).unwrap();
    assert_eq!(
        invocation.argv,
        vec![row.command, "acp".into(), "acp".into(), "login".into()]
    );
    assert_eq!(invocation.env, [("PUBLIC".into(), "value".into())]);
}
