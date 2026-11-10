use super::*;

fn legacy() -> SessionConfig {
    SessionConfig::from_response(
        &json!({"models":{"currentModelId":"a","availableModels":[{"modelId":"a","name":"Alpha"},{"modelId":"b","name":"Beta","description":"Choice B"}]}}),
    )
}
fn update(value: Value) -> Dispatch {
    Dispatch::Notification(
        UntypedMessage::new(
            "session/update",
            json!({"sessionId":"fixture","update":value}),
        )
        .unwrap(),
    )
}

fn vibe_options() -> Value {
    json!([
        {"id":"model","name":"Model","category":"model","type":"select","currentValue":"m","options":[{"value":"m","name":"M"}]},
        {"id":"thinking","name":"Thinking","category":"thinking","type":"select","currentValue":"high","options":[{"value":"low","name":"Low"},{"value":"high","name":"High"}],"_meta":{"kept":true}}
    ])
}

#[test]
fn vibe_thinking_reuses_the_same_projection_for_load_updates_and_setter_receipts() {
    let original = vibe_options();
    let response = json!({"configOptions":original});
    let handshake = |name| {
        crate::acp_client::handshake::Handshake::decode(json!({
            "protocolVersion":1,"agentCapabilities":{},"authMethods":[],
            "agentInfo":{"name":name,"version":"different-fixture-version"}
        }))
        .unwrap()
    };
    assert_eq!(
        Dialect::for_connection(None, &handshake("@mistralai/mistral-vibe")),
        Dialect::Standard
    );
    assert_eq!(
        Dialect::for_connection(Some(true), &handshake("unrelated")),
        Dialect::UnverifiedVibe
    );
    assert_eq!(
        Dialect::for_connection(Some(false), &handshake("@mistralai/mistral-vibe")),
        Dialect::UnverifiedVibe
    );
    let dialect = Dialect::for_connection(Some(true), &handshake("@mistralai/mistral-vibe"));
    let mut configuration = SessionConfig::from_connection(&response, dialect);
    let projected = configuration.options().unwrap();
    assert_eq!(response["configOptions"], original);
    assert_eq!(projected[1]["id"], "thinking");
    assert_eq!(projected[1]["category"], "thought_level");
    assert_eq!(projected[1]["_meta"], original[1]["_meta"]);
    assert_eq!(
        SessionConfig::from_response(&response).options().unwrap(),
        original
    );

    let request = configuration.prepare("thinking", &json!("low")).unwrap();
    assert!(
        configuration
            .prepare("thinking", &json!("unoffered"))
            .is_err()
    );
    let mut changed = original.clone();
    changed[1]["currentValue"] = json!("low");
    let notification =
        update(json!({"sessionUpdate":"config_option_update","configOptions":changed}));
    let from_notification = configuration.observe(&notification).unwrap();
    let raw = SessionConfig::configuration_update(&notification).unwrap();
    assert_eq!(raw["configOptions"], changed);
    let from_setter = configuration.complete(&request, changed).unwrap();
    assert_eq!(from_notification, from_setter);
    assert_eq!(from_setter[1]["category"], "thought_level");
    assert_eq!(from_setter[1]["currentValue"], "low");
}

#[test]
fn vibe_thinking_rejects_bad_shapes_and_collisions_without_rebinding_saved_ids() {
    let valid = vibe_options();
    let mut duplicate = valid.clone();
    duplicate.as_array_mut().unwrap().push(valid[1].clone());
    let mut collision = valid.clone();
    collision
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"reasoning_effort","category":"thought_level"}));
    let mut unrelated = valid.clone();
    unrelated[1]["id"] = json!("unrelated");
    let mut boolean = valid.clone();
    boolean[1]["type"] = json!("boolean");
    let mut unoffered = valid.clone();
    unoffered[1]["currentValue"] = json!("unoffered");
    let mut repeated_choice = valid.clone();
    repeated_choice[1]["options"][0]["value"] = json!("high");
    for bad in [
        duplicate,
        collision,
        unrelated,
        boolean,
        unoffered,
        repeated_choice,
    ] {
        let mut config =
            SessionConfig::from_connection(&json!({"configOptions":valid}), Dialect::Vibe);
        let request = config.prepare("thinking", &json!("low")).unwrap();
        assert!(config.complete(&request, bad.clone()).is_err());
        assert!(config.has_invalid_options());
        assert_eq!(Dialect::Standard.options(bad.clone()), bad);
    }

    let accepted = Dialect::Vibe.options(valid.clone());
    let guard = ModelGuard::new(&accepted, None, false);
    let saved = guard.record();
    let unverified = Dialect::UnverifiedVibe.options(valid);
    assert!(unverified.is_null());
    assert_eq!(
        ModelGuard::for_connection(&unverified, Some(&saved), true, Dialect::UnverifiedVibe)
            .check()
            .status,
        "blocked"
    );
    assert_eq!(
        ModelGuard::for_connection(&accepted, Some(&json!({"model":"m"})), true, Dialect::Vibe)
            .check()
            .status,
        "confirmation_required"
    );
}

#[test]
fn invalid_vibe_thinking_in_load_prefix_remains_unknown_after_a_valid_update() {
    let valid = vibe_options();
    let mut invalid = valid.clone();
    invalid[1]["currentValue"] = json!(null);
    let mut deferred = Deferred::default();
    for options in [invalid, valid.clone()] {
        deferred.observe(
            &update(json!({"sessionUpdate":"config_option_update","configOptions":options})),
            Dialect::Vibe,
        );
    }
    let mut configuration =
        SessionConfig::from_connection(&json!({"configOptions":valid}), Dialect::Vibe);
    let (_, unknown) = deferred.apply(&mut configuration);
    assert!(unknown);
    assert_eq!(
        configuration.options().unwrap()[1]["category"],
        "thought_level"
    );
    let options = configuration.options().unwrap();
    let mut guard = ModelGuard::for_connection(&options, None, false, Dialect::Vibe);
    if unknown {
        guard.change_unknown();
    }
    assert!(guard.blocks_vibe_restore());
    assert!(!guard.admissible());
}

#[test]
fn standard_saved_thinking_id_keeps_its_role_when_category_is_omitted() {
    let mut canonical = vibe_options();
    canonical[1]["category"] = json!("thought_level");
    let saved = ModelGuard::new(&canonical, None, false).record();
    canonical[1].as_object_mut().unwrap().remove("category");
    let restored = ModelGuard::new(&canonical, Some(&saved), true);
    assert_eq!(restored.check().status, "ready");
    assert_eq!(restored.current_value()["choices"][1]["value"], "high");
}

#[test]
fn configuration_origin_does_not_confuse_old_model_projection_with_a_modern_declaration() {
    let mut configuration = legacy();
    assert!(configuration.modern_options().is_none());
    assert_eq!(
        projection(configuration.options().unwrap(), false)["modern"],
        false
    );
    configuration.observe(&update(
        json!({"sessionUpdate":"config_option_update","configOptions":[]}),
    ));
    assert_eq!(configuration.modern_options(), Some(&json!([])));
    assert_eq!(
        projection(configuration.options().unwrap(), true)["modern"],
        true
    );
    for value in [Value::Null, json!({"invalid":"shape"})] {
        let configuration = SessionConfig::from_response(&json!({"configOptions":value}));
        assert!(configuration.modern_options().is_some());
        assert!(configuration.has_invalid_options());
    }
}

#[test]
fn legacy_models_become_one_generic_option_without_changing_ids_or_labels() {
    let configuration = legacy();
    let options = configuration.options().unwrap();
    assert_eq!(options.as_array().unwrap().len(), 1);
    assert_eq!(options[0]["id"], LEGACY_MODEL_ID);
    assert_eq!(options[0]["currentValue"], "a");
    assert_eq!(options[0]["options"][1]["value"], "b");
    assert_eq!(options[0]["options"][1]["name"], "Beta");
    assert_eq!(options[0]["options"][1]["description"], "Choice B");
    assert!(
        configuration
            .prepare(LEGACY_MODEL_ID, &json!("not-offered"))
            .is_err()
    );
}

#[test]
fn actual_modern_model_declaration_takes_precedence_without_fallback() {
    let mut configuration = legacy();
    configuration.options = Some(
        json!([{"id":"real-model","name":"Model","category":"model","type":"select","currentValue":"a","options":[{"value":"a","name":"A"}]}]),
    );
    assert_eq!(
        configuration.options().unwrap().as_array().unwrap().len(),
        1
    );
    assert!(configuration.prepare(LEGACY_MODEL_ID, &json!("b")).is_err());
    let request = configuration.prepare("real-model", &json!("a")).unwrap();
    assert!(!request.legacy);
    assert!(configuration.complete(&request, json!({})).is_err());
}

#[test]
fn legacy_ack_does_not_require_an_optional_notification_but_conflicts_block() {
    let mut configuration = legacy();
    let request = configuration.prepare(LEGACY_MODEL_ID, &json!("b")).unwrap();
    let options = configuration.complete(&request, json!({})).unwrap();
    assert_eq!(options[0]["currentValue"], "b");
    for value in [json!("a"), Value::Null, json!(false)] {
        let mut configuration = legacy();
        let request = configuration.prepare(LEGACY_MODEL_ID, &json!("b")).unwrap();
        configuration.observe(&update(
            json!({"sessionUpdate":"current_model_update","currentModelId":value}),
        ));
        assert!(configuration.complete(&request, json!({})).is_err());
    }
}

#[test]
fn legacy_receipt_preserves_concurrent_reasoning_declarations() {
    let mut configuration = legacy();
    let request = configuration.prepare(LEGACY_MODEL_ID, &json!("b")).unwrap();
    configuration.observe(&update(json!({"sessionUpdate":"config_option_update","configOptions":[{"id":"effort","category":"thought_level","type":"select","currentValue":"high","options":[{"value":"high","name":"High"}]}]})));
    configuration.observe(&update(
        json!({"sessionUpdate":"current_model_update","currentModelId":"b"}),
    ));
    let options = configuration
        .complete(&request, json!({"_meta":{"opaque":true}}))
        .unwrap();
    assert_eq!(options[0]["currentValue"], "high");
    assert_eq!(options[1]["currentValue"], "b");
    assert_eq!(projection(options, true)["kind"], "configOptions");
}

#[test]
fn old_model_ack_never_invents_reasoning_choices_when_no_new_declaration_arrives() {
    let mut configuration = legacy();
    configuration.options = Some(
        json!([{"id":"effort","category":"thought_level","type":"select","currentValue":"low","options":[{"value":"low","name":"Low"}]}]),
    );
    let request = configuration.prepare(LEGACY_MODEL_ID, &json!("b")).unwrap();
    assert!(configuration.complete(&request, json!({})).is_err());
}

#[test]
fn unrelated_model_configuration_does_not_hide_the_declared_old_model_picker() {
    let mut configuration = legacy();
    configuration.options = Some(
        json!([{"id":"model_config","name":"Model config","category":"model_config","type":"select","currentValue":"x","options":[{"value":"x","name":"X"}]}]),
    );
    assert_eq!(
        configuration.options().unwrap().as_array().unwrap().len(),
        2
    );
    assert!(
        configuration
            .prepare(LEGACY_MODEL_ID, &json!("b"))
            .unwrap()
            .legacy
    );
}

#[test]
fn malformed_and_duplicate_model_lists_are_not_invented_choices() {
    for models in [
        json!({}),
        json!({"currentModelId":"a","availableModels":[]}),
        json!({"currentModelId":"a","availableModels":[{"modelId":"a","name":"A"},{"modelId":"a","name":"Other"}]}),
    ] {
        let configuration = SessionConfig::from_response(&json!({"models":models}));
        assert!(configuration.options().is_none());
        assert!(configuration.prepare(LEGACY_MODEL_ID, &json!("b")).is_err());
    }
}

#[test]
fn malformed_configuration_notifications_never_confirm_a_legacy_model_change() {
    for options in [None, Some(Value::Null), Some(json!({}))] {
        let mut configuration = legacy();
        configuration.options = Some(
            json!([{"id":"effort","category":"thought_level","type":"select","currentValue":"low","options":[{"value":"low","name":"Low"}]}]),
        );
        let request = configuration.prepare(LEGACY_MODEL_ID, &json!("b")).unwrap();
        let mut notification = json!({"sessionUpdate":"config_option_update"});
        if let Some(options) = &options {
            notification["configOptions"] = options.clone();
        }
        assert_eq!(
            configuration.observe(&update(notification)),
            Some(options.unwrap_or(Value::Null))
        );
        assert!(configuration.complete(&request, json!({})).is_err());
        assert!(configuration.prepare(LEGACY_MODEL_ID, &json!("b")).is_err());
        configuration.observe(&update(
            json!({"sessionUpdate":"config_option_update","configOptions":[]}),
        ));
        assert!(
            configuration.complete(&request, json!({})).is_err(),
            "a later notification cannot repair a malformed receipt interval"
        );
    }
}

#[test]
fn valid_empty_configuration_notification_can_remove_reasoning_options() {
    let mut configuration = legacy();
    configuration.options = Some(
        json!([{"id":"effort","category":"thought_level","type":"select","currentValue":"low","options":[{"value":"low","name":"Low"}]}]),
    );
    let request = configuration.prepare(LEGACY_MODEL_ID, &json!("b")).unwrap();
    configuration.observe(&update(
        json!({"sessionUpdate":"config_option_update","configOptions":[]}),
    ));
    let options = configuration.complete(&request, json!({})).unwrap();
    assert_eq!(options.as_array().unwrap().len(), 1);
    assert_eq!(options[0]["id"], LEGACY_MODEL_ID);
    assert_eq!(options[0]["currentValue"], "b");
}
