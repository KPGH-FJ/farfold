use super::*;
#[cfg(unix)]
use std::os::unix::fs::symlink;

fn route(row: &AgentRow, method: &Value, managed_kilo: bool) -> Route {
    super::route(
        row,
        method,
        &ManagedTerminalProof {
            kilo: managed_kilo,
            copilot: None,
        },
    )
}

fn executable(path: &Path) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, "#!/bin/sh\nexit 0\n").unwrap();
    crate::process_platform::set_executable(path).unwrap();
}
fn row(command: &Path) -> AgentRow {
    AgentRow {
        id: "fixture".into(),
        name: "Fixture".into(),
        source: "custom".into(),
        command: command.display().to_string(),
        args: vec!["acp".into()],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 1,
        updated_at: 1,
    }
}
fn legacy(command: &str, args: Value) -> Value {
    serde_json::json!({"id":"login","name":"Login","_meta":{"terminal-auth":{"command":command,"args":args}}})
}
fn argv(route: Route) -> Vec<String> {
    let Route::Terminal(invocation) = route else {
        panic!("expected a verified terminal route");
    };
    invocation.argv
}
#[test]
fn typed_terminal_is_authoritative_even_with_malformed_legacy_and_api_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let row = row(&dir.path().join(if cfg!(windows) {
        "selected.exe"
    } else {
        "selected"
    }));
    let method = serde_json::json!({"id":"login","name":"Login","type":"terminal","args":["--standard"],
        "env":{"PUBLIC_MODE":"standard"},"_meta":{"terminal-auth":true,"api-key":{"env":"OTHER"}}});
    let Route::Terminal(invocation) = route(&row, &method, false) else {
        panic!("typed terminal lost priority");
    };
    assert_eq!(
        invocation.argv,
        vec![row.command, "acp".into(), "--standard".into()]
    );
    assert_eq!(
        invocation.env,
        vec![("PUBLIC_MODE".into(), "standard".into())]
    );
    assert!(!protocol_method(&method));
}
#[test]
fn plain_agent_and_default_methods_keep_protocol_authentication() {
    let row = row(Path::new("/fixture"));
    for method in [
        serde_json::json!({"id":"login","name":"Login"}),
        serde_json::json!({"id":"login","name":"Login","type":"agent","description":"Run another login command"}),
    ] {
        assert!(matches!(route(&row, &method, false), Route::Agent));
        assert!(protocol_method(&method));
    }
}
#[test]
fn malformed_terminal_declarations_never_fall_through_to_protocol_or_pty() {
    let dir = tempfile::tempdir().unwrap();
    let command = dir.path().join(if cfg!(windows) {
        "selected.exe"
    } else {
        "selected"
    });
    executable(&command);
    let row = row(&command);
    for metadata in [
        serde_json::json!(true),
        serde_json::json!([]),
        serde_json::json!(null),
        serde_json::json!({"command":command,"args":["login",false]}),
        serde_json::json!({"command":command,"args":"login"}),
        serde_json::json!({"command":7}),
        serde_json::json!({"command":command,"label":false}),
    ] {
        let method =
            serde_json::json!({"id":"login","name":"Login","_meta":{"terminal-auth":metadata}});
        assert!(matches!(route(&row, &method, false), Route::Unavailable(_)));
        assert!(!protocol_method(&method));
    }
}
#[test]
fn relative_and_missing_targets_are_not_resolved_to_another_program() {
    let dir = tempfile::tempdir().unwrap();
    let command = dir.path().join(if cfg!(windows) {
        "selected.exe"
    } else {
        "selected"
    });
    executable(&command);
    let row = row(&command);
    for target in [
        "./selected",
        "../selected",
        "/missing-fixture/login",
        "farfold-unknown-auth-fixture",
    ] {
        assert!(matches!(
            route(&row, &legacy(target, serde_json::json!(["login"])), false),
            Route::Unavailable(_)
        ));
    }
}
#[test]
fn legacy_environment_is_checked_before_a_terminal_route_is_available() {
    let dir = tempfile::tempdir().unwrap();
    let command = dir.path().join(if cfg!(windows) {
        "selected.exe"
    } else {
        "selected"
    });
    executable(&command);
    let row = row(&command);
    for env in [
        serde_json::json!({"BAD-NAME":"value"}),
        serde_json::json!({"PUBLIC":false}),
        serde_json::json!([]),
    ] {
        let mut method = legacy(command.to_str().unwrap(), serde_json::json!(["login"]));
        method["env"] = env;
        assert!(matches!(route(&row, &method, false), Route::Unavailable(_)));
    }
}
#[test]
fn a_node_script_identity_is_required_even_when_the_node_path_is_identical() {
    let dir = tempfile::tempdir().unwrap();
    let node = dir
        .path()
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    executable(&node);
    let script = dir.path().join("entry.js");
    let other = dir.path().join("other.js");
    executable(&script);
    executable(&other);
    let mut row = row(&node);
    row.args = vec![script.display().to_string(), "--acp".into()];
    assert!(matches!(
        route(
            &row,
            &legacy(node.to_str().unwrap(), serde_json::json!([other, "login"])),
            false
        ),
        Route::Unavailable(_)
    ));
    assert!(matches!(
        route(
            &row,
            &legacy(node.to_str().unwrap(), serde_json::json!(["-e", "code"])),
            false
        ),
        Route::Unavailable(_)
    ));
    assert_eq!(
        argv(route(
            &row,
            &legacy(
                node.to_str().unwrap(),
                serde_json::json!([script, "auth", "login"])
            ),
            false
        )),
        vec![
            row.command.clone(),
            row.args[0].clone(),
            "auth".into(),
            "login".into()
        ]
    );
    #[cfg(unix)]
    {
        let alias = dir.path().join("entry");
        symlink(&script, &alias).unwrap();
        assert_eq!(
            argv(route(
                &row,
                &legacy(alias.to_str().unwrap(), serde_json::json!(["login"])),
                false
            )),
            vec![row.command.clone(), row.args[0].clone(), "login".into()]
        );
    }
}
#[test]
fn shared_python_requires_the_same_absolute_script() {
    let dir = tempfile::tempdir().unwrap();
    let python = dir.path().join(if cfg!(windows) {
        "python3.13.exe"
    } else {
        "python3.13"
    });
    let selected = dir.path().join("selected.py");
    let other = dir.path().join("other.py");
    executable(&python);
    executable(&selected);
    executable(&other);
    let mut row = row(&python);
    row.args = vec![selected.display().to_string(), "--acp".into()];
    assert!(matches!(
        route(
            &row,
            &legacy(
                python.to_str().unwrap(),
                serde_json::json!([other, "login"])
            ),
            false
        ),
        Route::Unavailable(_)
    ));
    assert_eq!(
        argv(route(
            &row,
            &legacy(
                python.to_str().unwrap(),
                serde_json::json!([selected, "login"])
            ),
            false
        )),
        vec![row.command.clone(), row.args[0].clone(), "login".into()]
    );
}
#[test]
fn shell_code_and_interpreter_options_require_explicit_configuration() {
    let dir = tempfile::tempdir().unwrap();
    for name in [
        "sh", "bash", "zsh", "node", "bun", "deno", "ruby", "perl", "python",
    ] {
        let command = dir.path().join(if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.into()
        });
        executable(&command);
        let mut row = row(&command);
        for args in [
            vec!["-c".into(), "code".into()],
            vec!["-e".into(), "code".into()],
            vec!["--flag".into(), "/script".into()],
            vec!["relative-script".into()],
        ] {
            row.args = args;
            assert!(
                matches!(
                    route(
                        &row,
                        &legacy(
                            command.to_str().unwrap(),
                            serde_json::json!(["-c", "different code"])
                        ),
                        false
                    ),
                    Route::Unavailable(_)
                ),
                "{name}"
            );
        }
    }
}
fn amp(dir: &Path) -> (AgentRow, Value, PathBuf) {
    let component = dir.join(if cfg!(windows) {
        "amp-acp.exe"
    } else {
        "amp-acp"
    });
    let program = dir.join(if cfg!(windows) {
        "managed/amp.exe"
    } else {
        "managed/amp"
    });
    executable(&component);
    executable(&program);
    let mut row = row(&component);
    row.id = "registry:amp-acp".into();
    row.source = "registry".into();
    row.args.clear();
    row.env = vec![("AMP_CLI_PATH".into(), program.display().to_string())];
    let mut method = legacy("amp", serde_json::json!([]));
    method["id"] = serde_json::json!("setup");
    (row, method, program)
}
#[test]
fn amp_uses_its_verified_selected_companion_instead_of_a_path_namesake() {
    let dir = tempfile::tempdir().unwrap();
    let (row, method, selected) = amp(dir.path());
    assert_eq!(
        argv(route(&row, &method, false)),
        vec![selected.display().to_string()]
    );
    let other = dir.path().join(if cfg!(windows) {
        "other/amp.exe"
    } else {
        "other/amp"
    });
    executable(&other);
    assert!(matches!(
        route(
            &row,
            &legacy(other.to_str().unwrap(), serde_json::json!([])),
            false
        ),
        Route::Unavailable(_)
    ));
    let mut changed = row.clone();
    changed.env[0].1 = dir.path().join("missing/amp").display().to_string();
    assert!(matches!(
        route(&changed, &method, false),
        Route::Unavailable(_)
    ));
    changed = row.clone();
    changed.source = "custom".into();
    assert!(matches!(
        route(&changed, &method, false),
        Route::Unavailable(_)
    ));
    assert_eq!(row.env[0].1, selected.display().to_string());
}

fn autohand(dir: &Path) -> (AgentRow, Value, PathBuf) {
    let node = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    executable(&node);
    let mut row = super::super::recipes::tests::official_row(
        dir,
        "registry:autohand",
        "@autohandai/autohand-acp",
        "0.2.1",
    );
    row.command = node.display().to_string();
    let cli = dir.join(if cfg!(windows) {
        "selected CLI/launch-program.exe"
    } else {
        "selected CLI/launch-program"
    });
    executable(&cli);
    row.env = vec![("AUTOHAND_CMD".into(), cli.display().to_string())];
    let mut method = legacy("autohand", serde_json::json!(["login"]));
    method["id"] = serde_json::json!("autohand-login");
    (row, method, cli)
}

#[test]
fn autohand_login_uses_selected_cli_and_preserves_declared_environment() {
    let dir = tempfile::tempdir().unwrap();
    let (row, mut method, cli) = autohand(dir.path());
    method["_meta"]["terminal-auth"]["env"] = serde_json::json!({"PUBLIC_MODE":"login-fixture"});
    let Route::Terminal(invocation) = route(&row, &method, false) else {
        panic!("the official login must use the selected companion CLI");
    };
    assert_eq!(
        invocation.argv,
        vec![
            cli.canonicalize().unwrap().display().to_string(),
            "login".into()
        ]
    );
    assert_eq!(
        invocation.env,
        vec![("PUBLIC_MODE".into(), "login-fixture".into())]
    );
    assert!(!invocation.setup);
    assert_eq!(row.env[0].1, cli.display().to_string());
}

#[test]
fn autohand_login_does_not_accept_another_command_or_arguments() {
    let dir = tempfile::tempdir().unwrap();
    let (row, method, cli) = autohand(dir.path());
    for index in 0..5 {
        let mut changed = method.clone();
        match index {
            0 => changed["_meta"]["terminal-auth"]["command"] = serde_json::json!(cli),
            1 => {
                changed["_meta"]["terminal-auth"]["args"] = serde_json::json!(["login", "--extra"])
            }
            2 => changed["_meta"]["terminal-auth"]["args"] = serde_json::json!(["logout"]),
            3 => changed["id"] = serde_json::json!("unknown-login"),
            _ => {
                // A same-program declaration is generally valid, but it is not
                // the exact official companion login reviewed for this release.
                changed["_meta"]["terminal-auth"]["command"] = serde_json::json!(row.command);
                changed["_meta"]["terminal-auth"]["args"] =
                    serde_json::json!([row.args[0], "login"]);
            }
        }
        assert!(
            matches!(route(&row, &changed, false), Route::Unavailable(_)),
            "case {index}"
        );
    }
}

#[test]
fn autohand_login_requires_the_verified_registered_component() {
    let dir = tempfile::tempdir().unwrap();
    let (row, method, _) = autohand(dir.path());
    for index in 0..4 {
        let mut changed = row.clone();
        match index {
            0 => changed.source = "custom".into(),
            1 => changed.version = Some("0.2.2".into()),
            2 => changed.args.push("--unverified".into()),
            _ => changed.id = "custom-autohand".into(),
        }
        assert!(
            matches!(route(&changed, &method, false), Route::Unavailable(_)),
            "case {index}"
        );
    }
}

#[test]
fn autohand_login_keeps_a_broken_explicit_cli_instead_of_a_path_namesake() {
    let dir = tempfile::tempdir().unwrap();
    let (mut row, method, _) = autohand(dir.path());
    let namesake = dir.path().join(if cfg!(windows) {
        "path/autohand.exe"
    } else {
        "path/autohand"
    });
    executable(&namesake);
    row.env.push((
        "PATH".into(),
        namesake.parent().unwrap().display().to_string(),
    ));
    let declaration = &super::super::recipes::verified_for(&row)[0];
    let mut unselected = row.clone();
    unselected.env.retain(|(name, _)| name != "AUTOHAND_CMD");
    assert_eq!(
        super::super::preparation::resolve_dependency(declaration, Some(&unselected)),
        Some(namesake)
    );
    row.env[0].1 = dir.path().join("missing CLI").display().to_string();
    assert!(matches!(
        route(&row, &method, false),
        Route::Unavailable(UnavailableReason::PathUnavailable)
    ));
}
#[cfg(unix)]
fn kilo(data: &Path) -> (AgentRow, MetaStore, Value) {
    kilo_with_layout(data, false)
}
#[cfg(unix)]
fn kilo_with_layout(data: &Path, encoded: bool) -> (AgentRow, MetaStore, Value) {
    let command = data.join(if encoded {
        "agent-installations/agent-registry%3Akilo/install-fixture/kilo"
    } else {
        "agents/registry:kilo/install-fixture/kilo"
    });
    executable(&command);
    let mut row = row(&command);
    row.id = "registry:kilo".into();
    row.source = "registry".into();
    row.version = Some("7.8.1".into());
    let store = MetaStore::open(&data.join("meta.sqlite3")).unwrap();
    crate::installations::commit_candidate(&store, &row, None, command.parent()).unwrap();
    let mut method = legacy("opencode", serde_json::json!(["auth", "login"]));
    method["id"] = serde_json::json!("kilo-login");
    (row, store, method)
}
#[test]
#[cfg(unix)]
fn the_kilo_supplement_requires_the_selected_managed_zip_and_exact_bad_declaration() {
    let dir = tempfile::tempdir().unwrap();
    let (row, store, method) = kilo(dir.path());
    assert!(managed_kilo(&row, &store, dir.path()));
    assert_eq!(
        argv(route(&row, &method, true)),
        vec![row.command.clone(), "auth".into(), "login".into()]
    );
    for index in 0..4 {
        let mut changed = row.clone();
        match index {
            0 => changed.version = Some("7.8.2".into()),
            1 => changed.source = "custom".into(),
            2 => changed.args.push("--extra".into()),
            _ => changed.id = "custom-kilo".into(),
        }
        assert!(!managed_kilo(&changed, &store, dir.path()));
    }
    for index in 0..3 {
        let mut changed = method.clone();
        match index {
            0 => changed["id"] = serde_json::json!("other"),
            1 => {
                changed["_meta"]["terminal-auth"]["args"] =
                    serde_json::json!(["auth", "login", "--extra"])
            }
            _ => changed["_meta"]["terminal-auth"]["command"] = serde_json::json!("other"),
        }
        assert!(matches!(route(&row, &changed, true), Route::Unavailable(_)));
    }
    assert!(matches!(route(&row, &method, false), Route::Unavailable(_)));
}
#[test]
#[cfg(unix)]
fn explicit_agent_type_does_not_extend_the_fixed_kilo_supplement() {
    let dir = tempfile::tempdir().unwrap();
    let (row, _, mut method) = kilo(dir.path());
    method["type"] = serde_json::json!("agent");
    assert!(!super::super::recipes::kilo_legacy_login(
        &row,
        &method,
        "opencode",
        &["auth".into(), "login".into()]
    ));
}
#[test]
fn typed_agent_roundtrip_normalizes_explicit_and_default_type() {
    let implicit = serde_json::json!({"id":"login","name":"Login","_meta":{"terminal-auth":{"command":"opencode","args":["auth","login"]}}});
    let mut explicit = implicit.clone();
    explicit["type"] = serde_json::json!("agent");
    let normalize =
        |value| serde_json::to_value(serde_json::from_value::<AuthMethod>(value).unwrap()).unwrap();
    let implicit = normalize(implicit);
    let explicit = normalize(explicit);
    assert_eq!(implicit, explicit);
    assert!(explicit.get("type").is_none());
    assert_eq!(
        explicit
            .pointer("/_meta/terminal-auth/command")
            .and_then(Value::as_str),
        Some("opencode")
    );
}
#[test]
#[cfg(unix)]
fn missing_external_or_replaced_kilo_receipts_cannot_grant_the_supplement() {
    let dir = tempfile::tempdir().unwrap();
    let (row, store, _) = kilo(dir.path());
    let receipt = store.get_setting("installations.v1").unwrap().unwrap();
    for index in 0..3 {
        let mut changed = receipt.clone();
        match index {
            0 => changed = serde_json::json!([]),
            1 => changed[0]["source"] = serde_json::json!("external"),
            _ => changed[0]["command"] = serde_json::json!("/outside/kilo"),
        }
        store.set_setting("installations.v1", &changed).unwrap();
        assert!(!managed_kilo(&row, &store, dir.path()));
    }
    store.set_setting("installations.v1", &receipt).unwrap();
    let root = Path::new(&row.command).parent().unwrap();
    let moved = root.with_extension("moved");
    std::fs::rename(root, &moved).unwrap();
    symlink(&moved, root).unwrap();
    assert!(!managed_kilo(&row, &store, dir.path()));
}
#[test]
#[cfg(unix)]
fn a_replaced_agent_parent_cannot_grant_the_kilo_supplement() {
    let dir = tempfile::tempdir().unwrap();
    let (row, store, _) = kilo(dir.path());
    let parent = dir.path().join("agents/registry:kilo");
    let outside = dir.path().join("outside");
    std::fs::rename(&parent, &outside).unwrap();
    symlink(&outside, &parent).unwrap();
    let mut receipt = store.get_setting("installations.v1").unwrap().unwrap();
    receipt[0]["managedRoot"] = serde_json::json!(outside.join("install-fixture"));
    store.set_setting("installations.v1", &receipt).unwrap();
    assert!(!managed_kilo(&row, &store, dir.path()));
}
#[test]
fn verified_qwen_setup_retains_valid_declared_environment() {
    let dir = tempfile::tempdir().unwrap();
    let node = dir
        .path()
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    executable(&node);
    let package = dir.path().join("node_modules/@qwen-code/qwen-code");
    let entry = package.join("cli-entry.js");
    executable(&entry);
    std::fs::write(
        package.join("package.json"),
        r#"{"name":"@qwen-code/qwen-code","bin":{"qwen":"cli-entry.js"}}"#,
    )
    .unwrap();
    let mut row = row(&node);
    row.id = "registry:qwen-code".into();
    row.source = "registry".into();
    row.args = vec![entry.display().to_string(), "--acp".into()];
    let mut method = serde_json::json!({"id":"openai","_meta":{"type":"terminal","args":["--auth-type=openai"]},"env":{"PUBLIC_MODE":"fixture"}});
    let Route::Terminal(invocation) = route(&row, &method, false) else {
        panic!("verified Qwen setup is unavailable");
    };
    assert!(invocation.setup);
    assert_eq!(
        invocation.env,
        vec![("PUBLIC_MODE".into(), "fixture".into())]
    );
    method["env"] = serde_json::json!({"PUBLIC_MODE":false});
    assert!(matches!(route(&row, &method, false), Route::Unavailable(_)));
}
#[test]
fn unknown_qwen_style_terminal_signals_are_not_protocol_authentication() {
    let row = row(Path::new("/fixture"));
    let method = serde_json::json!({"id":"login","name":"Login","_meta":{"type":"terminal","args":["--login"]}});
    assert!(matches!(route(&row, &method, false), Route::Unavailable(_)));
    assert!(!protocol_method(&method));
}

#[test]
#[cfg(unix)]
fn encoded_kilo_root_keeps_the_receipt_scoped_supplement() {
    let dir = tempfile::tempdir().unwrap();
    let (row, store, method) = kilo_with_layout(dir.path(), true);
    assert!(managed_kilo(&row, &store, dir.path()));
    assert_eq!(
        argv(route(&row, &method, true)),
        vec![row.command.clone(), "auth".into(), "login".into()]
    );
    let mut receipt = store.get_setting("installations.v1").unwrap().unwrap();
    receipt[0]["programOnly"] = serde_json::json!(true);
    store.set_setting("installations.v1", &receipt).unwrap();
    assert!(!managed_kilo(&row, &store, dir.path()));
}
