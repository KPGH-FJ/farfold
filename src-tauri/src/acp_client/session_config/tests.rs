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
