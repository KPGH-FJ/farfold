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
fn claude_does_not_offer_an_unverified_private_delivery_route() {
    let capability = capability(&agent());
    assert!(capability.api_types.is_empty());
    assert!(capability.validated_api_types.is_empty());
    assert_eq!(capability.selection_scope, "connection");
    assert!(capability.unavailable_reason.is_some());
}

#[test]
fn claude_rejects_saved_messages_before_producing_any_launch_config() {
    let selected = service();
    let inherited = HashMap::from([
        ("ANTHROPIC_BASE_URL".into(), "https://existing.test".into()),
        ("ANTHROPIC_API_KEY".into(), "existing-key-canary".into()),
        ("ANTHROPIC_MODEL".into(), "old-model".into()),
        ("HOME".into(), "/unchanged-home".into()),
    ]);
    let before = inherited.clone();
    let mut row = agent();
    row.version = Some("0.107.0".into());
    let Err(error) = compile(&row, &selected, &inherited) else {
        panic!("a managed credential must not reach this adapter transport");
    };
    assert_eq!(Some(error.as_str()), capability(&row).unavailable_reason);
    assert!(!error.contains(&selected.secret));
    assert!(!error.contains(&selected.endpoint));
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
