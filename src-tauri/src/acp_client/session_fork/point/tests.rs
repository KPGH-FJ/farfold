use super::*;

fn body(id: &str, time: i64) -> Value {
    json!({"id":id,"created":time,"role":"assistant","content":[{"type":"text","text":id}],"metadata":{"agentVisible":true,"userVisible":true}})
}
fn session(id: &str, messages: Vec<Value>) -> Value {
    json!({"id":id,"working_dir":"/owned","message_count":messages.len(),"conversation":messages,
        "extension_data":{},
        "provider_name":"selected","model_config":{"model_name":"unchanged"},"goose_mode":"approve","recipe":null,"user_recipe_values":null})
}

#[test]
fn changed_tool_context_is_not_a_complete_historical_fork() {
    let original = sample();
    let prepared = prepare(&original).unwrap();
    let mut child = session(
        "child",
        original["conversation"].as_array().unwrap()[..3].to_vec(),
    );
    child["extension_data"] = json!({"enabled_extensions":["different-owned-fixture"]});
    assert!(
        prepared
            .verify(
                wire(&original),
                wire(&child),
                "parent",
                "child",
                Path::new("/owned")
            )
            .is_err()
    );
}
fn wire(value: &Value) -> Value {
    json!({"data":serde_json::to_string(value).unwrap()})
}
fn sample() -> Value {
    session(
        "parent",
        vec![
            body("a", 1),
            body("hidden", 1),
            body("b", 2),
            body("later", 3),
        ],
    )
}
fn selected() -> HistoryPoint {
    HistoryPoint {
        message_id: "b".into(),
    }
}
fn prepare(value: &Value) -> Result<Prepared, &'static str> {
    Prepared::select(wire(value), "parent", Path::new("/owned"), &selected())
}

#[test]
fn official_export_selects_exact_complete_prefix_including_hidden_messages() {
    let mut original = sample();
    original["conversation"][1]["metadata"]["userVisible"] = json!(false);
    let prepared = prepare(&original).unwrap();
    assert_eq!(prepared.cutoff, 3);
    let child = session(
        "child",
        original["conversation"].as_array().unwrap()[..3].to_vec(),
    );
    assert!(
        prepared
            .verify(
                wire(&original),
                wire(&child),
                "parent",
                "child",
                Path::new("/owned")
            )
            .is_ok()
    );
}

#[test]
fn ignored_cutoff_hidden_content_rewrite_or_changed_original_never_confirm() {
    let original = sample();
    let prepared = prepare(&original).unwrap();
    let expected = session(
        "child",
        original["conversation"].as_array().unwrap()[..3].to_vec(),
    );
    let mut cases = vec![session(
        "child",
        original["conversation"].as_array().unwrap().clone(),
    )];
    let mut hidden = expected.clone();
    hidden["conversation"][1]["content"] = json!([]);
    cases.push(hidden);
    let mut model = expected.clone();
    model["model_config"]["model_name"] = json!("other");
    cases.push(model);
    for child in cases {
        assert!(
            prepared
                .verify(
                    wire(&original),
                    wire(&child),
                    "parent",
                    "child",
                    Path::new("/owned")
                )
                .is_err()
        );
    }
    let mut parent = original.clone();
    parent["conversation"][3]["content"] = json!([]);
    assert!(
        prepared
            .verify(
                wire(&parent),
                wire(&expected),
                "parent",
                "child",
                Path::new("/owned")
            )
            .is_err()
    );
}

#[test]
fn timestamp_collision_missing_terminal_or_duplicate_point_is_not_a_fork() {
    let original = sample();
    for id in ["a", "later", "missing"] {
        assert!(
            Prepared::select(
                wire(&original),
                "parent",
                Path::new("/owned"),
                &HistoryPoint {
                    message_id: id.into()
                }
            )
            .is_err()
        );
    }
    let mut duplicate = original.clone();
    duplicate["conversation"][0]["id"] = json!("b");
    assert!(prepare(&duplicate).is_err());
    let mut backwards = original.clone();
    backwards["conversation"][3]["created"] = json!(0);
    assert!(prepare(&backwards).is_err());
}

#[test]
fn export_identity_completeness_and_structure_are_mandatory() {
    for key in ["id", "working_dir", "message_count", "conversation"] {
        let mut value = sample();
        value.as_object_mut().unwrap().remove(key);
        assert!(prepare(&value).is_err());
    }
    let mut value = sample();
    value["message_count"] = json!(3);
    assert!(prepare(&value).is_err());
    let mut value = sample();
    value["conversation"][1] = Value::Null;
    assert!(prepare(&value).is_err());
    let mut envelope = wire(&sample());
    envelope["nextCursor"] = json!("more");
    assert!(Prepared::select(envelope, "parent", Path::new("/owned"), &selected()).is_err());
    for key in ["agentVisible", "userVisible"] {
        let mut value = sample();
        value["conversation"][0]["metadata"]
            .as_object_mut()
            .unwrap()
            .remove(key);
        assert!(prepare(&value).is_err());
    }
}

#[test]
fn inactive_context_in_prefix_cannot_be_reconstructed_even_when_a_summary_was_copied() {
    let mut original = sample();
    original["conversation"][0]["metadata"]["agentVisible"] = json!(false);
    assert!(matches!(
        prepare(&original),
        Err("point_context_unavailable")
    ));
    // A later summary is not used to infer that every earlier node is restored.
    original["conversation"][1]["content"] = json!([{"type":"text","text":"summary"}]);
    assert!(matches!(
        prepare(&original),
        Err("point_context_unavailable")
    ));
}

#[test]
fn message_hint_preserves_original_and_requires_exact_reviewed_metadata_owner() {
    let original = json!({"sessionId":"parent","update":{"sessionUpdate":"agent_message_chunk","messageId":"b","content":{"type":"text","text":"original"},"_meta":{"goose":{"created":2,"messageId":"b"},"future":"preserved"}}});
    let projected = present(original.clone(), "connection", "parent", true);
    assert_eq!(projected["update"], original["update"]);
    assert_eq!(
        projected["presentation"],
        json!({"kind":"historyForkPoint","connectionId":"connection","messageId":"b"})
    );
    for (id, allowed) in [("other", true), ("parent", false)] {
        assert_eq!(
            present(original.clone(), "connection", id, allowed),
            original
        );
    }
    for key in ["messageId", "created"] {
        let mut value = original.clone();
        value["update"]["_meta"]["goose"]
            .as_object_mut()
            .unwrap()
            .remove(key);
        assert_eq!(present(value.clone(), "connection", "parent", true), value);
    }
    let mut conflict = original.clone();
    conflict["update"]["messageId"] = json!("other");
    assert_eq!(
        present(conflict.clone(), "connection", "parent", true),
        conflict
    );
}

#[test]
fn history_point_dto_rejects_injected_local_locator_or_unbounded_id() {
    assert!(
        serde_json::from_value::<HistoryPoint>(json!({"messageId":"b","itemId":"local"})).is_err()
    );
    for id in ["".to_string(), "\n".into(), "x".repeat(1025)] {
        assert!(!HistoryPoint { message_id: id }.valid());
    }
}
