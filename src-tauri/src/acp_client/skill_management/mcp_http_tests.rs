//! Fixed synthetic addresses only; shared frontend cases exercise real admission.
use super::*;
use mcp_add_input::Input;
use mcp_add_tests::Fixture;
use serde_json::{Value, json};

pub(super) const URL: &str = "HTTPS://Endpoint.test:000443/mcp?token=HTTP_URL_CANARY&x=one&x=two&empty=&plus=a+b&slash=%2f&hash=%23";
pub(super) fn input(url: &str) -> Input {
    serde_json::from_value(json!({"transport":"streamableHttp","name":"sample.new","url":url}))
        .unwrap()
}
pub(super) fn inspect(f: &Fixture) -> (Arc<Job>, Review) {
    let job = f.job_with(input(URL));
    f.run(&job, "normal");
    let review = job.snapshot().review.unwrap();
    (job, review)
}

#[test]
fn mcp_http_shared_58_literals_and_four_generated_url_cases() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../../src/runtime/fixtures/mcp-http-url-cases.json"
    ))
    .unwrap();
    let rows = cases["cases"].as_array().unwrap();
    assert_eq!(rows.len(), 58);
    for case in rows {
        let original = case["url"].as_str().unwrap();
        let value = input(original);
        assert_eq!(
            value.validate().is_ok(),
            case["accepted"].as_bool().unwrap(),
            "case {}",
            case["id"]
        );
        if case["accepted"] == true {
            assert_eq!(value.entry()["url"], original);
            assert_eq!(serde_json::to_value(value).unwrap()["url"], original);
        }
    }
    assert_eq!(cases["generatedCases"].as_array().unwrap().len(), 4);
    let prefix = "https://endpoint.test/";
    let boundary = format!("{prefix}{}", "a".repeat(4096 - prefix.len()));
    assert!(input(&boundary).validate().is_ok());
    assert_eq!(
        input(&(boundary + "a")).validate().err().unwrap().code,
        Code::InvalidUrl
    );
    assert!(serde_json::from_str::<Input>(r#"{"transport":"streamableHttp","name":"sample.new","url":"https://endpoint.test/\ud800"}"#).is_err());
    let port = format!("https://endpoint.test:{}443/mcp", "0".repeat(4000));
    assert!(input(&port).validate().is_ok());
}

#[test]
fn mcp_http_input_union_is_strict_and_stdio_bytes_are_unchanged() {
    let stdio = mcp_add_tests::input();
    let old = serde_json::to_string(&stdio).unwrap();
    let union: Input = serde_json::from_str(&old).unwrap();
    assert_eq!(serde_json::to_string(&union).unwrap(), old);
    assert_eq!(union.transport(), "stdio");
    assert_eq!(union.mutation(), "addDisabledStdioMcp");
    for invalid in [
        json!({"name":"sample.new","url":URL}),
        json!({"name":"sample.new","url":URL,"transport":"http"}),
        json!({"name":"sample.new","url":URL,"transport":"streamableHttp","args":[]}),
        json!({"name":"sample.new","url":URL,"transport":"streamableHttp","headers":{}}),
        json!({"name":"sample.new","url":URL,"transport":"streamableHttp","executablePath":"/x"}),
        json!({"name":"sample.new","executablePath":"/x","args":[],"transport":"stdio"}),
    ] {
        assert!(serde_json::from_value::<Input>(invalid).is_err());
    }
}

#[test]
fn mcp_http_invalid_url_fixed_error_and_repeat_conflicts_precede_fresh_validation() {
    let f = Fixture::new(json!([]));
    let id = requests::uuid().unwrap();
    let input_id = requests::uuid().unwrap();
    let error = f
        .registry
        .begin_add_inspect(
            &f.agent,
            &id,
            &f.inventory,
            &input_id,
            input("https:///HTTP_URL_CANARY"),
        )
        .err()
        .unwrap();
    assert_eq!(error.code, Code::InvalidUrl);
    assert_eq!(
        serde_json::to_value(error).unwrap(),
        json!({"code":"invalidUrl"})
    );
    assert_eq!(f.state()["methods"], json!([]));
    let (job, fresh) = f
        .registry
        .begin_add_inspect(&f.agent, &id, &f.inventory, &input_id, input(URL))
        .unwrap();
    assert!(fresh);
    let (same, fresh) = f
        .registry
        .begin_add_inspect(&f.agent, &id, &f.inventory, &input_id, input(URL))
        .unwrap();
    assert!(!fresh && Arc::ptr_eq(&job, &same));
    for changed in [
        input("https:///invalid"),
        input(&(URL.to_owned() + "&new=1")),
        mcp_add_tests::input().into(),
    ] {
        assert_eq!(
            f.registry
                .begin_add_inspect(&f.agent, &id, &f.inventory, &input_id, changed)
                .err()
                .unwrap()
                .code,
            Code::RequestConflict
        );
    }
    f.registry
        .cancel_domain(&f.agent, &id, domain::Domain::McpAdd)
        .unwrap();
    f.run(&job, "normal");
    assert_eq!(f.state()["writes"], 0);
    println!(
        "MCP_HTTP_INPUT_WIRE={}",
        json!({"invalidUrl":error,"inspectCancelled":job.snapshot()})
    );
}

#[test]
fn mcp_http_real_exchange_saves_exact_query_once_and_never_publishes_url() {
    let f = Fixture::new(json!([]));
    let (inspection, review) = inspect(&f);
    assert_eq!(review.mutation, "addDisabledHttpMcp");
    let inspect_value = serde_json::to_value(inspection.snapshot()).unwrap();
    assert_eq!(inspect_value["target"]["transport"], "streamableHttp");
    assert_eq!(f.state()["writes"], 0);
    let job = f.confirm(&review);
    f.run(&job, "normal");
    let op = job.snapshot();
    assert_eq!(op.outcome, Some(Outcome::Verified));
    assert_eq!(f.state()["writes"], 1);
    assert_eq!(
        f.state()["writeParams"]["value"],
        json!({"url":URL,"enabled":false})
    );
    assert_eq!(
        f.state()["writeParams"]["keyPath"],
        "mcp_servers.\"sample.new\""
    );
    assert_eq!(
        f.state()["config"]["layers"][0]["config"]["private"]["env"],
        "PRIVATE_CANARY"
    );
    let scopes = f.state()["readScopes"].as_array().unwrap().clone();
    assert!(scopes.iter().any(Value::is_null));
    assert!(
        scopes
            .iter()
            .any(|v| v.as_str() == Some(inspection.source.cwd()))
    );
    let row = f.store.get_agent(&f.agent).unwrap().unwrap();
    let caps = inventory::launch::capabilities(&row).unwrap();
    assert_eq!(caps.mcp_http_addition.availability, "unavailable");
    let wire = json!({"inspection":inspection.snapshot(),"verified":op,"inventory":inventory::requests::shared().get(&f.agent,&f.inventory).unwrap().snapshot(),"unavailableCapabilities":caps});
    for sensitive in [URL, "HTTP_URL_CANARY", "Endpoint.test", "PRIVATE_CANARY"] {
        assert!(!wire.to_string().contains(sensitive));
    }
    println!("MCP_HTTP_READY_WIRE={wire}");
}

#[test]
fn mcp_http_exact_get_identity_refuses_all_auth_helpers_and_query_drift() {
    let raw = json!({"layers":[{"name":{"type":"user","file":super::tests::fixture_path("/synthetic/config.toml")},"version":"v1","config":{"unrelated":[{"keep":true}]}}]});
    let before = plan::Config::parse(raw.clone()).unwrap();
    let p = mcp_add_plan::Plan::new(before.clone(), before, input(URL)).unwrap();
    let mut after = raw;
    after["layers"][0]["config"] = p.intended.clone();
    let after = plan::Config::parse(after).unwrap();
    let report = json!({"name":"sample.new","enabled":false,"transport":{"type":"streamable_http","url":URL}});
    assert!(p.observation(&after, &after, Some(&report)).unwrap().1);
    let mut defaults = report.clone();
    defaults["transport"]["http_headers"] = json!({});
    defaults["transport"]["env_http_headers"] = Value::Null;
    defaults["transport"]["bearer_token_env_var"] = Value::Null;
    defaults["transport"]["http_headers_helper"] = Value::Null;
    assert!(p.observation(&after, &after, Some(&defaults)).unwrap().1);
    for (field, value) in [
        ("url", json!(URL.replace("000443", "443"))),
        ("url", json!(URL.replace("x=one&x=two", "x=two&x=one"))),
        ("url", json!(URL.replace("%2f", "%2F"))),
        ("type", json!("stdio")),
        ("bearer_token_env_var", json!("TOKEN")),
        ("http_headers_helper", json!("<redacted>")),
        ("http_headers", json!({"Authorization":"PRIVATE"})),
        (
            "env_http_headers",
            json!({"Authorization":"PRIVATE_ENV_NAME"}),
        ),
        ("http_headers", json!([])),
        ("future", Value::Null),
        ("command", json!("/synthetic/unused")),
    ] {
        let mut drift = report.clone();
        drift["transport"][field] = value;
        let (observed, matching) = p.observation(&after, &after, Some(&drift)).unwrap();
        assert!(!matching, "{field}");
        assert_eq!(observed.mcp, Some("different"));
        assert_eq!(observed.reported_enabled, Some(false));
    }
}

#[test]
fn mcp_http_real_mismatch_does_not_mistake_disabled_for_identity_or_scope_match() {
    for mode in [
        "postget-url-drift",
        "postget-header-drift",
        "postget-helper-drift",
        "directory-drift",
        "changed-other",
    ] {
        let f = Fixture::new(json!([]));
        let (_, review) = inspect(&f);
        let job = f.confirm(&review);
        f.run(&job, mode);
        assert_eq!(job.snapshot().outcome, Some(Outcome::Mismatch), "{mode}");
        assert_eq!(
            job.snapshot()
                .observation
                .as_ref()
                .unwrap()
                .reported_enabled,
            Some(false)
        );
        assert_eq!(f.state()["writes"], 1);
        if mode == "postget-url-drift" {
            println!(
                "MCP_HTTP_MISMATCH_WIRE={}",
                json!({"mismatchSameDisabled":job.snapshot()})
            );
        }
    }
}

#[test]
fn mcp_http_unknown_and_rejected_keep_ack_during_readonly_observation() {
    for mode in ["lost-ack", "postwrite-error", "postget-fail", "refused"] {
        let f = Fixture::new(json!([]));
        let (inspection, review) = inspect(&f);
        let job = f.confirm(&review);
        f.run(&job, mode);
        let original = job.snapshot();
        let rejected = mode == "refused";
        assert_eq!(
            original.outcome,
            Some(if rejected {
                Outcome::Rejected
            } else {
                Outcome::Unknown
            })
        );
        assert!(original.write_dispatched);
        if rejected {
            // External synthetic state changes after the refusal; the recheck
            // may observe it but never rewrites or upgrades the rejected ACK.
            let mut state = f.state();
            state["config"]["layers"][0]["config"]["mcp_servers"] =
                json!({"sample.new":input(URL).entry()});
            state["config"]["layers"][0]["version"] = json!("external2");
            f.save(&state);
        }
        let check = f.recheck(&job);
        f.run(&check, "normal");
        assert_eq!(check.snapshot().outcome, Some(Outcome::Observed), "{mode}");
        assert_eq!(check.snapshot().write_ack, original.write_ack);
        assert_eq!(
            serde_json::to_value(job.snapshot()).unwrap(),
            serde_json::to_value(&original).unwrap()
        );
        assert_eq!(f.state()["writes"], if rejected { 0 } else { 1 });
        if mode == "lost-ack" || rejected {
            println!(
                "MCP_HTTP_RECOVERY_WIRE={}",
                json!({"mode":mode,"inventory":inventory::requests::shared().get(&f.agent,&f.inventory).unwrap().snapshot(),"inspection":inspection.snapshot(),"original":original,"recheck":check.snapshot()})
            );
        }
    }
}

#[test]
fn mcp_http_name_collision_before_write_and_changed_review_preserve_state() {
    for mode in ["fresh-collision", "disabled-layer", "review-changed"] {
        let f = Fixture::new(json!([]));
        let job = if mode == "review-changed" {
            let (_, review) = inspect(&f);
            let job = f.confirm(&review);
            let mut state = f.state();
            state["config"]["layers"][0]["config"]["future"] = json!("changed");
            f.save(&state);
            job
        } else {
            f.job_with(input(URL))
        };
        f.run(&job, mode);
        let op = job.snapshot();
        assert_eq!(
            op.code,
            Some(if mode == "review-changed" {
                Code::ConfigurationChanged
            } else {
                Code::NameConflict
            })
        );
        assert!(!op.write_dispatched);
        assert_eq!(op.outcome, Some(Outcome::NotDispatched));
        assert_eq!(f.state()["writes"], 0);
        if mode == "fresh-collision" {
            println!(
                "MCP_HTTP_REFUSAL_WIRE={}",
                json!({"inspectNameConflict":op})
            );
        }
    }
}
