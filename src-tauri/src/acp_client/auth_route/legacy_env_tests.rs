//! Controlled declarations only; no official login process or credentials.
use super::*;
use serde_json::json;

fn fixture() -> (tempfile::TempDir, AgentRow, Value) {
    let directory = tempfile::tempdir().unwrap();
    let node = directory
        .path()
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    std::fs::write(&node, "#!/bin/sh\nexit 0\n").unwrap();
    crate::process_platform::set_executable(&node).unwrap();
    let entry = directory.path().join("package with spaces/entry.mjs");
    std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
    std::fs::write(&entry, "// owned fixture\n").unwrap();
    let row = AgentRow {
        id: "custom-declared-terminal".into(),
        name: "Fixture".into(),
        source: "custom".into(),
        command: node.display().to_string(),
        args: vec![entry.display().to_string(), "--acp".into()],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    };
    let method = json!({"id":"login","name":"Login","description":"Not a command",
        "_meta":{"terminal-auth":{"command":row.command,"args":[row.args[0],"login"],
            "label":"Login","env":{"PUBLIC_MODE":"terminal","PRIVATE":"fixture-sensitive-canary"}}}});
    (directory, row, method)
}

fn capture(methods: Value) -> super::super::handshake::Handshake {
    super::super::handshake::Handshake::decode(
        json!({"protocolVersion":1,"agentCapabilities":{},"authMethods":methods}),
    )
    .unwrap()
}

fn invocation(row: &AgentRow, method: &Value) -> TerminalInvocation {
    match route(row, method, &ManagedTerminalProof::default()) {
        Route::Terminal(invocation) => invocation,
        _ => panic!("expected declared terminal route"),
    }
}

#[test]
fn legacy_terminal_environment_survives_capture_without_entering_public_cache() {
    let (_directory, row, method) = fixture();
    let captured = capture(json!([method]));
    let live = captured.execution_json();
    let invocation = invocation(&row, &live["authMethods"][0]);
    assert_eq!(
        invocation.argv,
        vec![row.command, row.args[0].clone(), "login".into()]
    );
    assert_eq!(
        invocation.env,
        vec![
            ("PRIVATE".into(), "fixture-sensitive-canary".into()),
            ("PUBLIC_MODE".into(), "terminal".into())
        ]
    );
    assert!(!captured.protocol_method("login"));
    let public = captured.public_json();
    assert!(!public.to_string().contains("fixture-sensitive-canary"));
    assert!(public["authMethods"][0].get("_meta").is_none());
    assert!(public["authMethods"][0].get("env").is_none());
    assert!(
        !super::super::handshake::cached_json(Some(&public))
            .to_string()
            .contains("fixture-sensitive-canary")
    );
}

#[test]
fn legacy_terminal_environment_preserves_both_locations_when_unambiguous() {
    let (_directory, row, mut method) = fixture();
    method["env"] = json!({"PUBLIC_MODE":"terminal","BASE_ONLY":"base"});
    let captured = capture(json!([method]));
    let invocation = invocation(&row, &captured.execution_json()["authMethods"][0]);
    assert_eq!(
        invocation.env,
        vec![
            ("BASE_ONLY".into(), "base".into()),
            ("PRIVATE".into(), "fixture-sensitive-canary".into()),
            ("PUBLIC_MODE".into(), "terminal".into())
        ]
    );
}

#[test]
fn legacy_terminal_environment_conflict_is_not_guessed_or_filtered() {
    let (_directory, row, mut method) = fixture();
    method["env"] = json!({"PUBLIC_MODE":"different"});
    let captured = capture(json!([method]));
    assert!(matches!(
        route(
            &row,
            &captured.execution_json()["authMethods"][0],
            &ManagedTerminalProof::default()
        ),
        Route::Unavailable(UnavailableReason::InvalidDeclaration)
    ));
    assert!(!captured.protocol_method("login"));
}

#[test]
fn legacy_terminal_environment_malformed_values_never_run_or_fall_through() {
    let (_directory, row, method) = fixture();
    for environment in [
        json!(null),
        json!([]),
        json!({"BAD-NAME":"value"}),
        json!({"PUBLIC":false}),
        json!({"PUBLIC":"nul\u{0000}value"}),
        json!({"PUBLIC":"x".repeat(16385)}),
        json!({"X".repeat(257):"value"}),
    ] {
        let mut changed = method.clone();
        changed["_meta"]["terminal-auth"]["env"] = environment;
        assert!(matches!(
            route(&row, &changed, &ManagedTerminalProof::default()),
            Route::Unavailable(UnavailableReason::InvalidDeclaration)
        ));
        let captured = capture(json!([changed]));
        assert_eq!(
            captured.public_json()["authMethods"][0]["_farfoldInvalid"],
            true
        );
        assert!(!captured.protocol_method("login"));
    }
}

#[test]
fn legacy_terminal_environment_does_not_relax_program_or_script_identity() {
    let (directory, row, method) = fixture();
    let other = directory.path().join("other.mjs");
    std::fs::write(&other, "// different fixture\n").unwrap();
    let mut changed = method.clone();
    changed["_meta"]["terminal-auth"]["args"][0] = json!(other);
    let captured = capture(json!([changed]));
    assert!(matches!(
        route(
            &row,
            &captured.execution_json()["authMethods"][0],
            &ManagedTerminalProof::default()
        ),
        Route::Unavailable(UnavailableReason::ScriptMismatch)
    ));
    let mut changed = method;
    let other_program = directory.path().join(if cfg!(windows) {
        "other-program.exe"
    } else {
        "other-program"
    });
    std::fs::write(&other_program, "#!/bin/sh\nexit 0\n").unwrap();
    crate::process_platform::set_executable(&other_program).unwrap();
    changed["_meta"]["terminal-auth"]["command"] = json!(other_program);
    let captured = capture(json!([changed]));
    assert!(matches!(
        route(
            &row,
            &captured.execution_json()["authMethods"][0],
            &ManagedTerminalProof::default()
        ),
        Route::Unavailable(UnavailableReason::ProgramMismatch)
    ));
}

#[test]
fn typed_terminal_environment_remains_authoritative_over_legacy_metadata() {
    let (_directory, row, mut method) = fixture();
    method["type"] = json!("terminal");
    method["args"] = json!(["--typed-login"]);
    method["env"] = json!({"PUBLIC_MODE":"typed"});
    method["_meta"]["terminal-auth"]["env"] = json!({"PUBLIC_MODE":false});
    let captured = capture(json!([method]));
    let invocation = invocation(&row, &captured.execution_json()["authMethods"][0]);
    let mut expected = vec![row.command];
    expected.extend(row.args);
    expected.push("--typed-login".into());
    assert_eq!(invocation.argv, expected);
    assert_eq!(invocation.env, vec![("PUBLIC_MODE".into(), "typed".into())]);
}

#[test]
fn duplicate_legacy_terminal_identity_remains_invalid_with_valid_environment() {
    let (_directory, row, method) = fixture();
    let captured = capture(json!([method, {"id":"login","name":"Other"}]));
    assert!(matches!(
        route(
            &row,
            &captured.execution_json()["authMethods"][0],
            &ManagedTerminalProof::default()
        ),
        Route::Unavailable(UnavailableReason::InvalidDeclaration)
    ));
    assert!(!captured.protocol_method("login"));
}

#[test]
fn legacy_terminal_environment_combined_limit_preserves_all_or_rejects_all() {
    let (_directory, row, mut method) = fixture();
    let environment = |count| {
        Value::Object(
            (0..count)
                .map(|index| (format!("NAME_{index}"), json!("value")))
                .collect(),
        )
    };
    method["_meta"]["terminal-auth"]["env"] = environment(63);
    method["env"] = json!({"ADDED":"base"});
    let captured = capture(json!([method.clone()]));
    assert_eq!(
        invocation(&row, &captured.execution_json()["authMethods"][0])
            .env
            .len(),
        64
    );
    method["_meta"]["terminal-auth"]["env"] = environment(64);
    let captured = capture(json!([method.clone()]));
    assert!(matches!(
        route(
            &row,
            &captured.execution_json()["authMethods"][0],
            &ManagedTerminalProof::default()
        ),
        Route::Unavailable(UnavailableReason::InvalidDeclaration)
    ));
    method["env"] = json!({"NAME_0":"value"});
    let captured = capture(json!([method]));
    assert_eq!(
        invocation(&row, &captured.execution_json()["authMethods"][0])
            .env
            .len(),
        64
    );
}
