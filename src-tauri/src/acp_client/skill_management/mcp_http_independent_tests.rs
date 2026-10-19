//! Independent exact-identity and non-success public-data boundaries.
//! Only the existing owned synthetic peer and temporary metadata are used.
use super::*;
use mcp_add_tests::Fixture;
use serde_json::{Value, json};

#[test]
fn mcp_http_independent_auth_defaults_are_typed_not_merely_empty_or_false() {
    let raw = json!({"layers":[{"name":{"type":"user","file":super::tests::fixture_path("/synthetic/http.toml")},"version":"v1","config":{"unrelated":{"keep":true}}}]});
    let before = plan::Config::parse(raw.clone()).unwrap();
    let plan = mcp_add_plan::Plan::new(
        before.clone(),
        before,
        mcp_http_tests::input(mcp_http_tests::URL),
    )
    .unwrap();
    let mut written = raw;
    written["layers"][0]["config"] = plan.intended.clone();
    let after = plan::Config::parse(written).unwrap();
    let report = json!({"name":"sample.new","enabled":false,"transport":{"type":"streamable_http","url":mcp_http_tests::URL}});
    assert!(plan.observation(&after, &after, Some(&report)).unwrap().1);

    for field in ["bearer_token_env_var", "http_headers_helper"] {
        for wrong_default in [json!(""), json!(false), json!(0), json!({}), json!([])] {
            let mut observed = report.clone();
            observed["transport"][field] = wrong_default;
            let (observation, matching) =
                plan.observation(&after, &after, Some(&observed)).unwrap();
            assert!(!matching, "{field} must be absent or null");
            assert_eq!(observation.mcp, Some("different"));
            assert_eq!(observation.reported_enabled, Some(false));
        }
    }
    for field in ["http_headers", "env_http_headers"] {
        for wrong_default in [json!(""), json!(false), json!(0), json!([])] {
            let mut observed = report.clone();
            observed["transport"][field] = wrong_default;
            assert!(
                !plan.observation(&after, &after, Some(&observed)).unwrap().1,
                "{field} must be absent, null or an empty object"
            );
        }
        for allowed_default in [Value::Null, json!({})] {
            let mut observed = report.clone();
            observed["transport"][field] = allowed_default;
            assert!(plan.observation(&after, &after, Some(&observed)).unwrap().1);
        }
    }
}

#[test]
fn mcp_http_independent_unknown_cancel_recheck_never_publishes_private_url() {
    let f = Fixture::new(json!([]));
    let (inspection, review) = mcp_http_tests::inspect(&f);
    let confirmation = f.confirm(&review);
    f.run(&confirmation, "lost-ack");
    let original = confirmation.snapshot();
    assert!(original.settled && original.write_dispatched);
    assert_eq!(original.outcome, Some(Outcome::Unknown));
    assert_eq!(original.write_ack, Ack::Unknown);
    assert_eq!(f.state()["writes"], 1);

    let cancellation = f
        .registry
        .cancel_domain(&f.agent, &original.request_id, domain::Domain::McpAdd)
        .unwrap();
    let observation = f.recheck(&confirmation);
    f.run(&observation, "normal");
    let observed = observation.snapshot();
    assert_eq!(observed.outcome, Some(Outcome::Observed));
    assert_eq!(observed.write_ack, Ack::Unknown);
    assert!(observed.write_dispatched);
    assert_eq!(f.state()["writes"], 1);
    assert_eq!(
        serde_json::to_value(confirmation.snapshot()).unwrap(),
        serde_json::to_value(&original).unwrap()
    );

    let public = serde_json::to_string(&json!({
        "inspection": inspection.snapshot(), "review": review,
        "unknown": original, "cancellation": cancellation, "observed": observed
    }))
    .unwrap();
    for private in [
        mcp_http_tests::URL,
        "Endpoint.test",
        "HTTP_URL_CANARY",
        "PRIVATE_CANARY",
        "x=one&x=two",
    ] {
        assert!(!public.contains(private));
    }
    assert_eq!(
        f.state()["writeParams"]["value"]["url"],
        mcp_http_tests::URL
    );
}
