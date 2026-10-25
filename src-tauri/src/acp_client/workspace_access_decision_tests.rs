use super::*;

fn request(cwd: &Path) -> Request {
    Request {
        connection_id: "owned-connection".into(),
        session_id: "owned-session".into(),
        cwd: cwd.into(),
        availability: Availability::new(Some(
            super::super::super::account_query::AccountQuery::Vibe,
        )),
        current_owner: Arc::new(|| true),
    }
}
fn scope(cwd: &Path) -> ExpectedScope {
    ExpectedScope {
        cwd: cwd.to_string_lossy().into(),
        repo_root: None,
        repo_scope_verified: false,
        offered_decisions: vec![OfferedDecision::TrustCwd, OfferedDecision::Decline],
    }
}

#[test]
fn workspace_access_decision_scope_is_an_exact_finite_copy_not_a_new_authority() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    let request = request(&cwd);
    let expected = scope(&cwd);
    expected
        .validate(&request, OfferedDecision::TrustCwd)
        .unwrap();
    let missing = parse(
        &json!({"trust_status":"untrusted","details":{"cwd":cwd}}),
        &request,
    )
    .unwrap();
    let empty = parse(
        &json!({"trust_status":"untrusted","details":{"cwd":cwd,"availableDecisions":[]}}),
        &request,
    )
    .unwrap();
    assert!(!expected.matches(&missing));
    assert!(!expected.matches(&empty));
    let mut invalid = expected.clone();
    invalid.offered_decisions.push(OfferedDecision::TrustRepo);
    assert_eq!(
        invalid
            .validate(&request, OfferedDecision::TrustRepo)
            .unwrap_err()
            .code,
        Code::ScopeChanged
    );
    invalid = expected.clone();
    invalid.offered_decisions.push(OfferedDecision::Decline);
    assert_eq!(
        invalid
            .validate(&request, OfferedDecision::Decline)
            .unwrap_err()
            .code,
        Code::ScopeChanged
    );
    invalid = expected.clone();
    invalid.repo_scope_verified = true;
    assert_eq!(
        invalid
            .validate(&request, OfferedDecision::TrustCwd)
            .unwrap_err()
            .code,
        Code::ScopeChanged
    );
    let foreign = tempfile::tempdir().unwrap();
    invalid.repo_root = Some(foreign.path().to_string_lossy().into());
    assert_eq!(
        invalid
            .validate(&request, OfferedDecision::TrustCwd)
            .unwrap_err()
            .code,
        Code::ScopeChanged
    );
}

#[test]
fn workspace_access_decision_public_input_and_error_shapes_are_finite_and_content_free() {
    for value in [
        json!({}),
        json!({"cwd":"/owned","repoScopeVerified":false,"offeredDecisions":["temporary"]}),
        json!({"cwd":"/owned","repoScopeVerified":false,"offeredDecisions":[],"private":"PRIVATE_SENTINEL"}),
    ] {
        assert!(serde_json::from_value::<ExpectedScope>(value).is_err());
    }
    for code in [
        Code::Unavailable,
        Code::Changed,
        Code::Busy,
        Code::NotOffered,
        Code::ScopeChanged,
        Code::Timeout,
        Code::InvalidResponse,
        Code::QueryFailed,
    ] {
        for effect in [Effect::NotDispatched, Effect::Unconfirmed] {
            let json = serde_json::to_value(DecisionError::new(code, effect)).unwrap();
            assert_eq!(json.as_object().unwrap().len(), 3);
            assert!(!json.to_string().contains("PRIVATE_SENTINEL"));
            assert!(matches!(
                json["effect"].as_str(),
                Some("notDispatched" | "unconfirmed")
            ));
        }
    }
}
