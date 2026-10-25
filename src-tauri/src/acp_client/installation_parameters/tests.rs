use super::*;

fn declaration() -> (RegistryAgent, AgentLaunch) {
    let entry: RegistryAgent = serde_json::from_value(serde_json::json!({
        "id":"fast-agent", "name":"fast-agent", "version":"0.10.1",
        "distribution":{"uvx":{"package":"fast-agent-acp==0.10.1", "args":["-x"], "env":{}}}
    }))
    .unwrap();
    let launch = crate::agent_catalog::registry_launch(&entry).unwrap();
    (entry, launch)
}

fn input(entry: &RegistryAgent, launch: &AgentLaunch, model: &str) -> InstallationInput {
    let options = options(entry, launch, None).unwrap();
    InstallationInput {
        declaration_id: options.declaration_id,
        registry_version: options.registry_version,
        launch: options.launch,
        values: BTreeMap::from([("model".into(), model.into())]),
    }
}

#[test]
fn confirmed_model_is_a_single_literal_candidate_argument() {
    let (entry, launch) = declaration();
    let input = input(&entry, &launch, "$system.default");
    assert_eq!(
        compile_args(&entry, &launch, None, Some(&input)).unwrap(),
        vec!["-x", "--model", "$system.default"]
    );
    assert_eq!(
        launch,
        crate::agent_catalog::registry_launch(&entry).unwrap()
    );
}

#[test]
fn stale_review_cannot_prepare_a_different_registry_release() {
    let (entry, launch) = declaration();
    let input = input(&entry, &launch, "fixture-model");
    let mut changed = entry.clone();
    changed.version = "0.10.2".into();
    assert!(compile_args(&changed, &launch, None, Some(&input)).is_err());
}

#[test]
fn model_parameters_and_secret_shapes_are_not_persistable_values() {
    let (entry, launch) = declaration();
    for model in [
        "fixture?api_key=secret",
        "https://user:secret@example.invalid/model",
        "sk-secret",
        "SK-secret",
        "Sk_private",
        "sK-secret",
        "fixture\0model",
    ] {
        let input = input(&entry, &launch, model);
        assert!(
            compile_args(&entry, &launch, None, Some(&input)).is_err(),
            "accepted invalid public field"
        );
    }
}

#[test]
fn optional_model_keeps_the_existing_settings_route() {
    let (entry, launch) = declaration();
    assert!(!options(&entry, &launch, None).unwrap().fields[0].required);
    assert_eq!(
        compile_args(&entry, &launch, None, None).unwrap(),
        vec!["-x"]
    );
}

#[test]
fn directory_model_is_read_only_and_does_not_fill_or_replace_saved_values() {
    let (mut entry, launch) = declaration();
    entry.distribution.uvx.as_mut().unwrap()["env"] =
        serde_json::json!({"FAST_AGENT_MODEL":"codexplan"});
    let declared = options(&entry, &launch, None).unwrap();
    assert_eq!(
        declared.fields[0].catalog_default_value.as_deref(),
        Some("codexplan")
    );
    assert!(declared.current_values.is_none());
    assert_eq!(
        compile_args(&entry, &launch, None, None).unwrap(),
        vec!["-x"]
    );
    let original = row(&["-x", "--model", "$system.default"]);
    let saved = options(&entry, &launch, Some(&original)).unwrap();
    assert_eq!(saved.current_values.unwrap()["model"], "$system.default");
    assert_eq!(
        compile_args(&entry, &launch, Some(&original), None).unwrap(),
        original.args
    );
    let explicit = input(&entry, &launch, "provider.explicit-model");
    assert_eq!(
        compile_args(&entry, &launch, None, Some(&explicit)).unwrap(),
        vec!["-x", "--model", "provider.explicit-model"]
    );
    assert_eq!(
        entry.distribution.uvx.as_ref().unwrap()["env"]["FAST_AGENT_MODEL"],
        "codexplan"
    );
}

#[test]
fn directory_env_change_requires_review_even_with_empty_values() {
    let (entry, launch) = declaration();
    let mut reviewed = input(&entry, &launch, "fixture-model");
    reviewed.values.clear();
    let mut changed = entry.clone();
    changed.distribution.uvx.as_mut().unwrap()["env"] =
        serde_json::json!({"FAST_AGENT_MODEL":"codexplan"});
    assert!(compile_args(&changed, &launch, None, Some(&reviewed)).is_err());
    let options = options(&changed, &launch, None).unwrap();
    assert_ne!(options.declaration_id, reviewed.declaration_id);
    let fresh = InstallationInput {
        declaration_id: options.declaration_id,
        registry_version: options.registry_version,
        launch: options.launch,
        values: BTreeMap::new(),
    };
    assert_eq!(
        compile_args(&changed, &launch, None, Some(&fresh)).unwrap(),
        vec!["-x"]
    );
}

#[test]
fn review_id_is_deterministic_and_excludes_registered_user_environment() {
    let (mut entry, launch) = declaration();
    entry.distribution.uvx.as_mut().unwrap()["env"] =
        serde_json::json!({"Z_PUBLIC":"last","FAST_AGENT_MODEL":"codexplan"});
    let original = row(&["-x", "--model", "fixture-model"]);
    let mut other = original.clone();
    other.env = vec![("LOCAL_SETTING".into(), "different".into())];
    let baseline = options(&entry, &launch, Some(&original)).unwrap();
    assert_eq!(
        baseline.declaration_id,
        options(&entry, &launch, Some(&other))
            .unwrap()
            .declaration_id
    );
    entry.distribution.uvx.as_mut().unwrap()["env"] =
        serde_json::from_str(r#"{"FAST_AGENT_MODEL":"codexplan","Z_PUBLIC":"last"}"#).unwrap();
    assert_eq!(
        baseline.declaration_id,
        options(&entry, &launch, None).unwrap().declaration_id
    );
    entry.distribution.uvx.as_mut().unwrap()["env"]["Z_PUBLIC"] = serde_json::json!("changed");
    assert_ne!(
        baseline.declaration_id,
        options(&entry, &launch, None).unwrap().declaration_id
    );
}

#[test]
fn unsupported_directory_value_is_preserved_without_being_a_displayed_model() {
    let (mut entry, launch) = declaration();
    for value in [
        "fixture?reasoning=high",
        "SK-secret",
        "Sk_private",
        "sK-secret",
    ] {
        entry.distribution.uvx.as_mut().unwrap()["env"] =
            serde_json::json!({"FAST_AGENT_MODEL":value});
        let options = options(&entry, &launch, None).unwrap();
        assert!(options.fields[0].catalog_default_value.is_none());
        assert!(options.current_values.is_none());
        assert_eq!(
            compile_args(&entry, &launch, None, None).unwrap(),
            vec!["-x"]
        );
        assert_eq!(
            entry.distribution.uvx.as_ref().unwrap()["env"]["FAST_AGENT_MODEL"],
            value
        );
    }
}

fn row(args: &[&str]) -> AgentRow {
    let command = std::env::temp_dir()
        .join("farfold-installation-parameters-fixture")
        .join(if cfg!(windows) { "Scripts" } else { "bin" })
        .join(if cfg!(windows) {
            "fast-agent-acp.exe"
        } else {
            "fast-agent-acp"
        });
    assert!(command.is_absolute());
    AgentRow {
        id: "registry:fast-agent".into(),
        name: "fast-agent".into(),
        source: "registry".into(),
        command: command.to_str().unwrap().into(),
        args: args.iter().map(|value| (*value).into()).collect(),
        env: vec![("KEPT_USER_VALUE".into(), "not-a-credential".into())],
        version: Some("0.10.1".into()),
        handshake: None,
        created_at: 1,
        updated_at: 1,
    }
}

#[test]
fn optional_empty_review_means_official_existing_settings() {
    let (entry, launch) = declaration();
    let mut input = input(&entry, &launch, "fixture-model");
    input.values.clear();
    assert_eq!(
        compile_args(&entry, &launch, None, Some(&input)).unwrap(),
        vec!["-x"]
    );
}

#[test]
fn corresponding_saved_literal_is_displayed_and_retained_without_rewriting() {
    let (entry, launch) = declaration();
    let original = row(&["-x", "--model", "$system.default"]);
    let before = original.clone();
    assert_eq!(
        options(&entry, &launch, Some(&original))
            .unwrap()
            .current_values
            .unwrap()["model"],
        "$system.default"
    );
    assert_eq!(
        compile_args(&entry, &launch, Some(&original), None).unwrap(),
        original.args
    );
    let input = input(&entry, &launch, "openai.fixture-model");
    assert_eq!(
        compile_args(&entry, &launch, Some(&original), Some(&input)).unwrap(),
        vec!["-x", "--model", "openai.fixture-model"]
    );
    assert_eq!(original, before);
}

#[test]
fn explicit_existing_settings_can_omit_only_a_recognized_old_override() {
    let (entry, launch) = declaration();
    let original = row(&["-x", "--model", "fixture-model"]);
    let mut input = input(&entry, &launch, "fixture-model");
    input.values.clear();
    assert_eq!(
        compile_args(&entry, &launch, Some(&original), Some(&input)).unwrap(),
        vec!["-x"]
    );
    assert_eq!(original.args, vec!["-x", "--model", "fixture-model"]);
}

#[test]
fn unknown_saved_arguments_are_never_hidden_or_silently_deleted() {
    let (entry, launch) = declaration();
    let mut input = input(&entry, &launch, "fixture-model");
    input.values.clear();
    for args in [
        vec!["-x", "--model", "fixture?reasoning=high"],
        vec!["-x", "--model", "fixture-model", "--home", "/previous"],
        vec!["-x", "--model", "one", "--model", "two"],
        vec!["-x", "--models", "fixture-model"],
        vec!["-x", "--model"],
    ] {
        let original = row(&args);
        assert!(
            options(&entry, &launch, Some(&original))
                .unwrap()
                .current_values
                .is_none()
        );
        assert!(compile_args(&entry, &launch, Some(&original), None).is_err());
        assert!(compile_args(&entry, &launch, Some(&original), Some(&input)).is_err());
    }
}

#[test]
fn unrelated_or_changed_registration_does_not_supply_old_values() {
    let (entry, launch) = declaration();
    let original = row(&["-x", "--model", "fixture-model"]);
    let mut custom = original.clone();
    custom.source = "custom".into();
    let mut version = original.clone();
    version.version = Some("0.10.2".into());
    let mut command = original.clone();
    command.command = "/custom/bin/other".into();
    let mut id = original;
    id.id = "custom-other".into();
    for changed in [custom, version, command, id] {
        assert!(
            options(&entry, &launch, Some(&changed))
                .unwrap()
                .current_values
                .is_none()
        );
        assert!(compile_args(&entry, &launch, Some(&changed), None).is_err());
    }
}

#[test]
fn source_scope_changes_disable_only_the_supplement_without_forcing_a_model() {
    let (entry, launch) = declaration();
    let input = input(&entry, &launch, "fixture-model");
    let mut variants = Vec::new();
    let mut changed = entry.clone();
    changed.version = "0.10.2".into();
    variants.push(changed);
    let mut changed = entry.clone();
    changed.id = "other-agent".into();
    variants.push(changed);
    let mut changed = entry.clone();
    changed.distribution.uvx.as_mut().unwrap()["args"] = serde_json::json!(["-x", "--extra"]);
    variants.push(changed);
    let mut changed = entry.clone();
    changed.distribution.uvx.as_mut().unwrap()["package"] =
        serde_json::json!("other-package==0.10.1");
    variants.push(changed);
    let mut changed = entry;
    changed.distribution.uvx.as_mut().unwrap()["unknown"] = serde_json::json!(true);
    variants.push(changed);
    for changed in variants {
        let launch = crate::agent_catalog::registry_launch(&changed).unwrap();
        assert!(options(&changed, &launch, None).is_none());
        assert!(compile_args(&changed, &launch, None, Some(&input)).is_err());
        assert_eq!(
            compile_args(&changed, &launch, None, None).unwrap(),
            base_args(&launch)
        );
    }
}

#[test]
fn changed_release_cannot_automatically_migrate_or_delete_a_saved_override() {
    let (mut entry, _) = declaration();
    entry.version = "0.10.2".into();
    entry.distribution.uvx.as_mut().unwrap()["package"] =
        serde_json::json!("fast-agent-acp==0.10.2");
    let launch = crate::agent_catalog::registry_launch(&entry).unwrap();
    assert!(
        compile_args(
            &entry,
            &launch,
            Some(&row(&["-x", "--model", "fixture-model"])),
            None
        )
        .is_err()
    );
    assert_eq!(
        compile_args(&entry, &launch, Some(&row(&["-x"])), None).unwrap(),
        vec!["-x"]
    );
}

#[test]
fn reviewed_package_base_args_and_identity_are_checked_even_for_empty_values() {
    let (entry, launch) = declaration();
    let mut input = input(&entry, &launch, "fixture-model");
    input.values.clear();
    for index in 0..3 {
        let mut changed = input.clone();
        match index {
            0 => changed.declaration_id = "another".into(),
            1 => changed.registry_version = "0.10.2".into(),
            _ => {
                changed.launch = AgentLaunch::Uvx {
                    package: "fast-agent-acp==0.10.1".into(),
                    args: vec!["-x".into(), "--model".into(), "hidden".into()],
                }
            }
        }
        assert!(compile_args(&entry, &launch, None, Some(&changed)).is_err());
    }
}

#[test]
fn public_name_and_reference_grammar_is_exact_and_bounded() {
    for model in [
        "sonnet",
        "openai.fixture-model",
        "openrouter/owner/model+suffix",
        "bedrock:region:model",
        "$system.default",
        "$_env._key-name",
    ] {
        assert!(public_model(model), "rejected a supported public name");
    }
    assert!(public_model(&"a".repeat(256)));
    for model in [
        "",
        " model",
        "model ",
        "two names",
        "--home",
        "$system.default.extra",
        "$9ns.key",
        "$system.9key",
        "foo@host",
        "foo#value",
        "foo=value",
        "sk_public_key",
        "SK-secret",
        "Sk_private",
        "sK-secret",
        "Bearer value",
        "模型",
        "foo\nbar",
    ] {
        assert!(!public_model(model), "accepted an unsupported field");
    }
    assert!(!public_model(&"a".repeat(257)));
}

#[test]
fn ipc_rejects_extra_fields_duplicate_ids_and_unreviewed_flags() {
    let baseline = r#"{"declarationId":"fast-agent-startup-model-0.10.1","registryVersion":"0.10.1","launch":{"kind":"uvx","package":"fast-agent-acp==0.10.1","args":["-x"]},"values":{"model":"fixture"}}"#;
    assert!(serde_json::from_str::<InstallationInput>(baseline).is_ok());
    for invalid in [
        baseline.replace("\"values\":", "\"command\":\"unexpected\",\"values\":"),
        baseline.replace("\"args\":[\"-x\"]", "\"args\":[\"-x\"],\"env\":{}"),
        baseline.replace(
            "\"model\":\"fixture\"",
            "\"model\":\"one\",\"model\":\"two\"",
        ),
        baseline.replace("\"model\":\"fixture\"", "\"model\":true"),
    ] {
        assert!(serde_json::from_str::<InstallationInput>(&invalid).is_err());
    }
    let (entry, launch) = declaration();
    let mut input = input(&entry, &launch, "fixture-model");
    input.values.insert("--home".into(), "/other".into());
    assert!(compile_args(&entry, &launch, None, Some(&input)).is_err());
}
