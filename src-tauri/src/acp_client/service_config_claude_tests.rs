use super::*;

pub(super) fn agent() -> AgentRow {
    AgentRow {
        id: "registry:claude-acp".into(),
        name: "Fixture".into(),
        source: "registry".into(),
        command: "fixture-only".into(),
        args: vec![],
        env: vec![],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    }
}

pub(super) fn service() -> ServiceSnapshot {
    ServiceSnapshot {
        identity: crate::credentials::ServiceIdentity {
            id: "claude-fixture-service".into(),
            fingerprint: "fixture-source-a".into(),
            model: "claude-fixture-model".into(),
        },
        endpoint: "https://selected.test/prefix/v1".into(),
        api_type: "messages".into(),
        models: vec!["claude-fixture-model".into(), "claude-other-model".into()],
        secret: "selected-credential-canary".into(),
        connection_revision: "fixture-revision-a".into(),
    }
}

#[test]
fn claude_offers_only_the_controlled_service_validated_messages_route() {
    let capability = capability(&agent());
    assert_eq!(capability.api_types, ["messages"]);
    assert_eq!(capability.validated_api_types, ["messages"]);
    assert_eq!(capability.selection_scope, "connection");
}

#[test]
fn claude_selected_secret_and_endpoint_never_enter_launch_environment() {
    let selected = service();
    let inherited = HashMap::from([
        ("ANTHROPIC_BASE_URL".into(), "https://existing.test".into()),
        ("ANTHROPIC_API_KEY".into(), "existing-key-canary".into()),
        ("ANTHROPIC_MODEL".into(), "old-model".into()),
        ("HOME".into(), "/unchanged-home".into()),
    ]);
    let before = inherited.clone();
    let launch = compile(&agent(), &selected, &inherited).unwrap();
    let environment: HashMap<_, _> = launch.env_overrides.into_iter().collect();
    assert_eq!(launch.model_id, selected.identity.model);
    assert_eq!(environment["ANTHROPIC_MODEL"], selected.identity.model);
    assert_eq!(
        environment["ANTHROPIC_CUSTOM_MODEL_OPTION"],
        selected.identity.model
    );
    assert_eq!(environment.len(), 2);
    for value in environment.values() {
        assert!(!value.contains(&selected.secret));
        assert!(!value.contains(&selected.endpoint));
    }
    assert_eq!(inherited, before);
}

#[test]
fn claude_compiler_rejects_other_formats_unreviewed_sources_and_bad_model() {
    for api in ["chat-completions", "responses"] {
        let mut selected = service();
        selected.api_type = api.into();
        assert!(compile(&agent(), &selected, &HashMap::new()).is_err());
    }
    for source in ["custom", "discovered"] {
        let mut row = agent();
        row.source = source.into();
        assert!(capability(&row).api_types.is_empty());
        assert!(compile(&row, &service(), &HashMap::new()).is_err());
    }
    let mut selected = service();
    selected.identity.model = "unselected".into();
    assert!(compile(&agent(), &selected, &HashMap::new()).is_err());
}
