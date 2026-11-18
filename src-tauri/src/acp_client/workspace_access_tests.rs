use super::super::lifecycle::ConnectionLife;
use super::*;

impl Availability {
    pub(crate) fn enable_for_test(&self) {
        self.0.store(true, Ordering::SeqCst);
        self.1.store(true, Ordering::SeqCst);
    }
    pub(crate) fn disable_decisions_for_test(&self) {
        self.1.store(false, Ordering::SeqCst);
    }
}

fn request(cwd: &Path) -> Request {
    Request {
        connection_id: "connection-owned".into(),
        session_id: "session-owned".into(),
        cwd: cwd.into(),
        availability: Availability::new(Some(super::super::account_query::AccountQuery::Vibe)),
        current_owner: Arc::new(|| true),
    }
}

#[test]
fn workspace_access_projection_keeps_official_status_and_optional_absence_distinct() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    let request = request(&cwd);
    for (label, expected) in [
        ("trusted", TrustStatus::Trusted),
        ("session", TrustStatus::Session),
        ("untrusted", TrustStatus::Untrusted),
    ] {
        let reply = parse(&json!({"trust_status":label}), &request).unwrap();
        assert_eq!(reply.status, expected);
        assert_eq!(reply.details, None);
        assert_eq!(reply.connection_id, "connection-owned");
        assert_eq!(reply.native_session_id, "session-owned");
    }
    let absent = parse(
        &json!({"trust_status":"untrusted","details":{"cwd":cwd}}),
        &request,
    )
    .unwrap();
    assert_eq!(absent.details.unwrap().offered_decisions, None);
    let empty = parse(
        &json!({"trust_status":"untrusted","details":{"cwd":cwd,"available_decisions":[]}}),
        &request,
    )
    .unwrap();
    assert_eq!(empty.details.unwrap().offered_decisions, Some(vec![]));
}

#[test]
fn workspace_access_projection_is_scoped_and_never_returns_extra_sensitive_fields() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().join("owned");
    std::fs::create_dir(&cwd).unwrap();
    let cwd = cwd.canonicalize().unwrap();
    let request = request(&cwd);
    let reply = parse(&json!({"trust_status":"session","private":"PRIVATE_SENTINEL","details":{"cwd":cwd,"repo_root":root.path(),"available_decisions":["trust_cwd","trust_repo","decline"],"settings_path":"PRIVATE_SENTINEL","detected_files":["PRIVATE_SENTINEL"]}}), &request).unwrap();
    let details = reply.details.as_ref().unwrap();
    assert!(details.repo_scope_verified);
    assert_eq!(
        details.repo_root.as_deref(),
        root.path().canonicalize().unwrap().to_str()
    );
    assert_eq!(details.offered_decisions.as_ref().unwrap().len(), 3);
    assert!(
        !serde_json::to_string(&reply)
            .unwrap()
            .contains("PRIVATE_SENTINEL")
    );
}

#[test]
fn workspace_access_official_camel_details_preserve_scope_and_offered_decisions() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().join("owned");
    std::fs::create_dir(&cwd).unwrap();
    let cwd = cwd.canonicalize().unwrap();
    let reply = parse(
        &json!({"trust_status":"untrusted","details":{"cwd":cwd,"repoRoot":root.path(),"availableDecisions":["trust_repo","trust_cwd","decline"],"detectedFiles":["PRIVATE_SENTINEL"],"repoDetectedFiles":["PRIVATE_SENTINEL"],"repoExplicitlyUntrusted":false,"settingsPath":"PRIVATE_SENTINEL"}}),
        &request(&cwd),
    )
    .unwrap();
    let details = reply.details.as_ref().unwrap();
    assert!(details.repo_scope_verified);
    assert_eq!(
        details.repo_root.as_deref(),
        root.path().canonicalize().unwrap().to_str()
    );
    assert_eq!(
        details.offered_decisions,
        Some(vec![
            OfferedDecision::TrustRepo,
            OfferedDecision::TrustCwd,
            OfferedDecision::Decline
        ])
    );
    assert!(
        !serde_json::to_string(&reply)
            .unwrap()
            .contains("PRIVATE_SENTINEL")
    );
}

#[test]
fn workspace_access_official_camel_optional_fields_keep_unknown_and_empty_distinct() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().canonicalize().unwrap();
    for details in [
        json!({"cwd":cwd}),
        json!({"cwd":cwd,"repoRoot":null,"availableDecisions":null}),
    ] {
        let reply = parse(
            &json!({"trust_status":"untrusted","details":details}),
            &request(&cwd),
        )
        .unwrap();
        let details = reply.details.unwrap();
        assert_eq!(details.repo_root, None);
        assert!(!details.repo_scope_verified);
        assert_eq!(details.offered_decisions, None);
    }
    let reply = parse(
        &json!({"trust_status":"untrusted","details":{"cwd":cwd,"availableDecisions":[]}}),
        &request(&cwd),
    )
    .unwrap();
    assert_eq!(reply.details.unwrap().offered_decisions, Some(vec![]));
}

#[test]
fn workspace_access_controlled_snake_aliases_require_equal_values_when_both_present() {
    let root = tempfile::tempdir().unwrap();
    let foreign = tempfile::tempdir().unwrap();
    let cwd = root.path().canonicalize().unwrap();
    let same = json!({"trust_status":"untrusted","details":{"cwd":cwd,"repoRoot":cwd,"repo_root":cwd,"availableDecisions":["decline"],"available_decisions":["decline"]}});
    let reply = parse(&same, &request(&cwd)).unwrap();
    assert_eq!(
        reply.details.unwrap().offered_decisions,
        Some(vec![OfferedDecision::Decline])
    );
    for details in [
        json!({"cwd":cwd,"repoRoot":foreign.path(),"repo_root":cwd}),
        json!({"cwd":cwd,"repoRoot":null,"repo_root":cwd}),
        json!({"cwd":cwd,"availableDecisions":["trust_cwd"],"available_decisions":["decline"]}),
        json!({"cwd":cwd,"availableDecisions":null,"available_decisions":[]}),
    ] {
        assert_eq!(
            parse(
                &json!({"trust_status":"trusted","details":details}),
                &request(&cwd)
            )
            .unwrap_err()
            .code,
            ErrorKind::InvalidResponse
        );
    }
}

#[test]
fn workspace_access_official_camel_malformed_or_foreign_details_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let foreign = tempfile::tempdir().unwrap();
    let cwd = root.path().canonicalize().unwrap();
    for details in [
        json!({"cwd":cwd,"repoRoot":true}),
        json!({"cwd":cwd,"repoRoot":"relative"}),
        json!({"cwd":cwd,"repoRoot":foreign.path()}),
        json!({"cwd":cwd,"availableDecisions":true}),
        json!({"cwd":cwd,"availableDecisions":["future-secret"]}),
        json!({"cwd":cwd,"availableDecisions":["decline","decline"]}),
        json!({"cwd":cwd,"availableDecisions":["trust_cwd","trust_repo","decline","decline"]}),
    ] {
        assert_eq!(
            parse(
                &json!({"trust_status":"trusted","details":details}),
                &request(&cwd)
            )
            .unwrap_err()
            .code,
            ErrorKind::InvalidResponse
        );
    }
}

#[test]
fn workspace_access_malformed_unknown_and_foreign_scope_never_become_trusted() {
    let dir = tempfile::tempdir().unwrap();
    let foreign = tempfile::tempdir().unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    let request = request(&cwd);
    for value in [
        json!({}),
        json!({"trust_status":"future"}),
        json!({"trust_status":true}),
        json!({"trust_status":"trusted","details":[]}),
        json!({"trust_status":"trusted","details":{"cwd":foreign.path()}}),
        json!({"trust_status":"trusted","details":{"cwd":cwd,"repo_root":foreign.path()}}),
        json!({"trust_status":"trusted","details":{"cwd":"relative"}}),
        json!({"trust_status":"trusted","details":{"cwd":cwd,"available_decisions":["future-secret"]}}),
        json!({"trust_status":"trusted","details":{"cwd":cwd,"available_decisions":["decline","decline"]}}),
        json!({"trust_status":"trusted","details":{"cwd":cwd,"available_decisions":true}}),
        json!({"trust_status":"trusted","extra":"x".repeat(65537)}),
    ] {
        assert_eq!(
            parse(&value, &request).unwrap_err().code,
            ErrorKind::InvalidResponse
        );
    }
}

#[test]
fn workspace_access_supplement_is_not_an_initialize_declaration_or_name_inference() {
    for route in [
        None,
        Some(super::super::account_query::AccountQuery::CodeBuddy),
        Some(super::super::account_query::AccountQuery::Kimchi),
    ] {
        assert!(Availability::new(route).capability().is_none());
    }
    let capability = request(Path::new("/owned"))
        .availability
        .capability()
        .unwrap();
    assert_eq!(
        serde_json::to_value(capability).unwrap(),
        json!({"statusQuery":true,"decisionManagement":true,"provenance":"reviewed-official-supplement"})
    );
}

#[tokio::test]
async fn workspace_access_unstarted_expired_or_closed_interest_never_polls_request() {
    for closed in [false, true] {
        let life = ConnectionLife::new();
        life.ready().unwrap();
        let polled = Arc::new(AtomicBool::new(false));
        let marker = polled.clone();
        let (reply, receive) = oneshot::channel();
        let mut pending = Some(Pending::start(
            async move {
                marker.store(true, Ordering::SeqCst);
                Err::<(), _>(ErrorKind::QueryFailed.into())
            },
            reply,
            tokio::time::Instant::now()
                + if closed {
                    Duration::from_secs(1)
                } else {
                    Duration::ZERO
                },
            life.operation("open:owned".into()).unwrap(),
        ));
        if closed {
            drop(receive);
            next(&mut pending).await;
        } else {
            next(&mut pending).await;
            assert_eq!(receive.await.unwrap().unwrap_err().code, ErrorKind::Timeout);
        }
        assert!(!polled.load(Ordering::SeqCst));
    }
}

#[tokio::test]
async fn workspace_access_timeout_retains_only_read_lease_until_actual_late_reply() {
    let life = ConnectionLife::new();
    life.ready().unwrap();
    let (release, receive) = oneshot::channel();
    let (reply, mut delivered) = oneshot::channel();
    let mut pending = Some(Pending::start(
        async move {
            receive.await.unwrap();
            Err::<(), _>(ErrorKind::QueryFailed.into())
        },
        reply,
        tokio::time::Instant::now() + Duration::from_millis(20),
        life.operation("open:owned".into()).unwrap(),
    ));
    tokio::select! {
        value = &mut delivered => assert_eq!(value.unwrap().unwrap_err().code, ErrorKind::Timeout),
        () = next(&mut pending) => panic!("read completed before the late reply"),
    }
    assert!(life.operation("open:owned".into()).is_err());
    // Reading creates no model-work unknown or new global prompt prohibition.
    let work = life.work().unwrap();
    drop(work);
    release.send(()).unwrap();
    next(&mut pending).await;
    assert!(life.operation("open:owned".into()).is_ok());
}

#[test]
fn workspace_access_error_serialization_uses_only_fixed_safe_fields() {
    for code in [
        ErrorKind::Unavailable,
        ErrorKind::Changed,
        ErrorKind::Busy,
        ErrorKind::Timeout,
        ErrorKind::InvalidResponse,
        ErrorKind::QueryFailed,
    ] {
        let v = serde_json::to_value(AccessError::from(code)).unwrap();
        assert_eq!(v.as_object().unwrap().len(), 2);
        assert!(!v.to_string().contains("PRIVATE_SENTINEL"));
    }
}
