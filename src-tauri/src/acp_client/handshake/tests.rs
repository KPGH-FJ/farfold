use super::*;

fn read(methods: Value) -> Handshake {
    Handshake::decode(json!({"protocolVersion":1,"agentCapabilities":{},"authMethods":methods}))
        .unwrap()
}

#[test]
fn auth_declaration_real_schema_fallback_documents_the_loss_we_bypass() {
    let typed: InitializeResponse = serde_json::from_value(json!({"protocolVersion":1,
        "agentCapabilities":{},"authMethods":[{"id":"key","name":"Key","type":"env_var",
        "vars":[{"name":"FIXTURE_KEY"}]}]}))
    .unwrap();
    let normalized = serde_json::to_value(typed).unwrap();
    assert!(normalized["authMethods"][0].get("type").is_none());
    assert!(normalized["authMethods"][0].get("vars").is_none());
    let kept =
        read(json!([{"id":"key","name":"Key","type":"env_var","vars":[{"name":"FIXTURE_KEY"}]}]));
    assert_eq!(kept.public_json()["authMethods"][0]["type"], "env_var");
    assert!(!kept.protocol_method("key"));
    assert!(kept.typed.auth_methods.is_empty());
}

#[test]
fn auth_declaration_only_public_names_cross_the_connection_boundary() {
    const SECRET: &str = "fixture-sensitive-canary";
    let h = read(json!([
        {"id":"key","name":"Key","type":"env_var","vars":[{"name":"FIXTURE_KEY","value":SECRET,"default":SECRET,"file":SECRET}],
         "link":format!("https://example.invalid/?token={SECRET}"),"_meta":{"unknown":SECRET}},
        {"id":"future","name":"Future","type":"future-login","payload":SECRET,"_meta":{"token":SECRET}},
        {"id":"terminal","name":"Terminal","type":"terminal","args":["login",SECRET],"env":{"FIXTURE_PRIVATE":SECRET},"_meta":{"token":SECRET}},
        {"id":"legacy","name":"Legacy","_meta":{"terminal-auth":{"command":"/owned/login","args":[SECRET]},"token":SECRET},"env":{"FIXTURE_PRIVATE":SECRET}},
    ]));
    let public = h.public_json();
    assert!(!public.to_string().contains(SECRET));
    assert_eq!(
        public["authMethods"][0]["vars"],
        json!([{"name":"FIXTURE_KEY"}])
    );
    assert!(
        h.execution_json()["authMethods"][2]["env"]
            .to_string()
            .contains(SECRET)
    );
    assert!(
        h.execution_json()["authMethods"][3]["_meta"]["terminal-auth"]["args"]
            .to_string()
            .contains(SECRET)
    );
    assert!(
        !h.execution_json()["authMethods"][1]
            .to_string()
            .contains(SECRET)
    );
    assert!(!cached_json(Some(&public)).to_string().contains(SECRET));
}

#[test]
fn auth_declaration_gateway_goes_to_public_cache_and_live_dispatch_only_as_presence() {
    const SECRET: &str = "gateway-configuration-sensitive-test-canary";
    let h = read(json!([
        {"id":"gateway","name":"Gateway","_meta":{"gateway":{
            "protocol":"google","baseUrl":format!("https://example.invalid/{SECRET}"),
            "headers":{"x-api-key":SECRET}
        }}},
        {"id":"gateway-terminal","name":"Terminal","type":"terminal","args":[SECRET],
         "env":{"FIXTURE_KEY":SECRET},"_meta":{"gateway":null}},
        {"id":"gateway-key","name":"Key","_meta":{
            "gateway":false,"api-key":{"provider":"openai"}
        }},
        {"id":"login","name":"Login"},
        {"id":"ordinary-key","name":"Key","_meta":{"api-key":{"provider":"openai"}}}
    ]));
    for view in [
        h.execution_json(),
        h.public_json(),
        cached_json(Some(&h.public_json())),
    ] {
        assert!(!view.to_string().contains(SECRET));
        for method in view["authMethods"].as_array().unwrap().iter().take(3) {
            assert_eq!(method["_meta"], json!({"gateway":true}));
            assert!(method.get("args").is_none());
            assert!(method.get("env").is_none());
        }
    }
    for id in ["gateway", "gateway-terminal", "gateway-key"] {
        assert!(!h.protocol_method(id));
        assert!(h.protocol_api_key_provider(id).is_none());
    }
    assert!(h.protocol_method("login"));
    assert_eq!(h.protocol_api_key_provider("ordinary-key"), Some("openai"));
}

#[test]
fn auth_declaration_malformed_terminal_containers_never_become_default_invocations() {
    for extra in [
        json!({"args":["login",false]}),
        json!({"args":"login"}),
        json!({"env":{"KEY":false}}),
        json!({"env":[]}),
    ] {
        let mut method = json!({"id":"login","name":"Login","type":"terminal"});
        for (k, v) in extra.as_object().unwrap() {
            method[k] = v.clone();
        }
        let h = read(json!([method]));
        assert_eq!(h.public_json()["authMethods"][0][INVALID], true);
        assert!(!h.protocol_method("login"));
    }
}

#[test]
fn auth_declaration_duplicate_identity_and_invalid_variable_names_never_run() {
    let h =
        read(json!([{"id":"same","name":"First"},{"id":"same","name":"Second","type":"agent"}]));
    assert!(!h.protocol_method("same"));
    assert!(
        h.public_json()["authMethods"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m[INVALID] == true)
    );
    let h = read(json!([{"id":"same","name":"First"},{"id":"same","name":false}]));
    assert!(!h.protocol_method("same"));
    for vars in [
        json!([]),
        json!([{"name":"BAD-NAME"}]),
        json!([{"name":"SAME"},{"name":"SAME"}]),
        json!(true),
    ] {
        let h = read(json!([{"id":"key","name":"Key","type":"env_var","vars":vars}]));
        assert!(h.public_json()["authMethods"][0].get("vars").is_none());
        assert_eq!(h.public_json()["authMethods"][0][INVALID], true);
    }
}

#[test]
fn auth_declaration_default_explicit_and_typed_terminal_remain_distinct() {
    let h = read(json!([
        {"id":"default","name":"Default"},
        {"id":"agent","name":"Agent","type":"agent"},
        {"id":"terminal","name":"Terminal","type":"terminal","args":["login"],"env":{"PUBLIC":"yes"},"_meta":{"terminal-auth":false}},
    ]));
    assert!(h.protocol_method("default"));
    assert!(h.protocol_method("agent"));
    assert!(!h.protocol_method("terminal"));
    let m = &h.execution_json()["authMethods"];
    assert!(m[0].get("type").is_none());
    assert_eq!(m[1]["type"], "agent");
    assert_eq!(m[2]["args"], json!(["login"]));
    assert_eq!(m[2]["env"], json!({"PUBLIC":"yes"}));
    assert!(m[2].get("_meta").is_none());
}

#[test]
fn auth_declaration_limits_reject_the_collection_without_truncating_to_callable_methods() {
    assert!(
        Handshake::decode(
            json!({"protocolVersion":1,"agentCapabilities":{},"authMethods":"wrong"})
        )
        .is_err()
    );
    assert!(Handshake::decode(json!({"protocolVersion":1,"agentCapabilities":{},"authMethods":vec![json!({"id":"login","name":"Login"});65]})).is_err());
    let h = read(
        json!([{"id":"bad\u{0000}id","name":"Bad"},{"id":"missing-name"},{"id":"null-type","name":"Null","type":null}]),
    );
    assert_eq!(h.auth_ids(), ["null-type"]);
    assert!(!h.protocol_method("null-type"));
}

#[test]
fn auth_declaration_old_cache_is_not_proof_of_a_default_agent() {
    let old = json!({"authMethods":[{"id":"key","name":"Key","_meta":{"token":"not-public"}}]});
    let cached = cached_json(Some(&old));
    assert_eq!(cached["authMethods"][0]["type"], "unsupported");
    assert!(!cached.to_string().contains("not-public"));
}

#[test]
fn provider_only_api_key_declaration_preserves_provider_without_secret_material() {
    const SECRET: &str = "provider-key-declaration-canary";
    let h = read(json!([{"id":"api-key","name":"API Key","_meta":{"api-key":{
        "provider":"openai","apiKey":SECRET
    }}}]));
    let method = &h.execution_json()["authMethods"][0];
    assert_ne!(method.get(INVALID), Some(&Value::Bool(true)));
    assert_eq!(method["_meta"]["api-key"], json!({"provider":"openai"}));
    assert!(!h.execution_json().to_string().contains(SECRET));
    assert!(!h.public_json().to_string().contains(SECRET));
    assert!(
        !cached_json(Some(&h.public_json()))
            .to_string()
            .contains(SECRET)
    );
}

#[test]
fn provider_only_api_key_declarations_validate_shape_and_preserve_env_only_route() {
    for key in [
        json!(false),
        json!([]),
        json!({}),
        json!({"provider":false}),
        json!({"provider":""}),
        json!({"provider":" openai"}),
        json!({"provider":"openai\n"}),
        json!({"provider":"openai","env":"OFFICIAL_KEY"}),
        json!({"env":null}),
    ] {
        let h = read(json!([{"id":"key","name":"Key","_meta":{"api-key":key}}]));
        assert_eq!(h.public_json()["authMethods"][0][INVALID], true);
        assert!(h.protocol_api_key_provider("key").is_none());
        assert!(!h.protocol_method("key"));
    }
    let h = read(json!([
        {"id":"env","name":"Key","_meta":{"api-key":{"env":"OFFICIAL_KEY"}}},
        {"id":"future","name":"Key","_meta":{"api-key":{"provider":"future-provider"}}},
        {"id":"key","name":"Key","_meta":{"api-key":{"provider":"openai"}}}
    ]));
    assert_eq!(
        h.execution_json()["authMethods"][0]["_meta"]["api-key"],
        json!({"env":"OFFICIAL_KEY"})
    );
    assert_eq!(
        h.execution_json()["authMethods"][1]["_meta"]["api-key"]["provider"],
        "future-provider"
    );
    assert!(h.protocol_api_key_provider("env").is_none());
    assert!(h.protocol_api_key_provider("future").is_none());
    assert_eq!(h.protocol_api_key_provider("key"), Some("openai"));
    for id in ["env", "future", "key"] {
        assert!(!h.protocol_method(id));
    }
}

#[test]
fn duplicate_provider_key_identity_never_grants_protocol_key_authority() {
    let h = read(json!([
        {"id":"key","name":"Key","_meta":{"api-key":{"provider":"openai"}}},
        {"id":"key","name":"Duplicate"}
    ]));
    assert!(h.protocol_api_key_provider("key").is_none());
}
