use super::*;

fn body(id: &str, time: i64) -> Value {
    json!({"id":id,"created":time,"role":"assistant","content":[{"type":"text","text":id}],"metadata":{"agentVisible":true,"userVisible":id!="hidden"}})
}
fn session(id: &str, messages: Vec<Value>) -> Value {
    let visible = messages
        .iter()
        .filter(|message| message["metadata"]["userVisible"] == true)
        .count();
    json!({"id":id,"working_dir":"/owned","message_count":visible,"conversation":messages,
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
fn official_visible_count_accepts_twenty_one_total_sixteen_visible_and_three_total_two_visible() {
    let mut messages = vec![body("a", 1), body("hidden", 1), body("b", 2)];
    messages[0]["role"] = json!("user");
    messages[1]["role"] = json!("user");
    messages[1]["metadata"]["turnContext"] = json!(true);
    for index in 3..21 {
        let mut message = body(&format!("later-{index}"), index + 1);
        if [4, 8, 12, 16].contains(&index) {
            message["metadata"]["userVisible"] = json!(false);
        }
        messages.push(message);
    }
    let original = session("parent", messages.clone());
    let child = session("child", messages[..3].to_vec());
    assert_eq!(original["conversation"].as_array().unwrap().len(), 21);
    assert_eq!(original["message_count"], 16);
    assert_eq!(child["conversation"].as_array().unwrap().len(), 3);
    assert_eq!(child["message_count"], 2);
    let prepared = prepare(&original)
        .expect("official count covers visible records, not the entire exported context");
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
    let mut dropped_hidden = child.clone();
    dropped_hidden["conversation"]
        .as_array_mut()
        .unwrap()
        .remove(1);
    assert_eq!(
        dropped_hidden["message_count"], 2,
        "dropping hidden context does not change the visible count"
    );
    assert!(
        prepared
            .verify(
                wire(&original),
                wire(&dropped_hidden),
                "parent",
                "child",
                Path::new("/owned")
            )
            .is_err()
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
    for count in [json!(4), json!(2), json!(-1), json!("3"), Value::Null] {
        let mut value = sample();
        value["message_count"] = count;
        assert!(prepare(&value).is_err());
    }
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

fn extensions_sample() -> Value {
    let mut value = sample();
    value["extension_data"] = json!({
        "enabled_extensions.v0": {"extensions": [
            {"type":"platform","name":"developer","available_tools":["first","second"]},
            {"type":"stdio","name":"owned","cmd":"fixture","args":["--one","--two"],"envs":{"env":{"MODE":"ordinary"}}},
            {"type":"platform","name":"developer","available_tools":["first","second"]}
        ], "other_state":[1,2]},
        "other_extension.v0": {"items":[1,2]}
    });
    value
}
fn extensions_child(original: &Value) -> Value {
    let mut child = session(
        "child",
        original["conversation"].as_array().unwrap()[..3].to_vec(),
    );
    child["extension_data"] = original["extension_data"].clone();
    child
}
fn rotate_extensions(value: &mut Value) {
    value["extension_data"]["enabled_extensions.v0"]["extensions"]
        .as_array_mut()
        .unwrap()
        .rotate_left(1);
}

#[test]
fn official_enabled_extensions_outer_reorder_preserves_complete_parent_and_child() {
    let original = extensions_sample();
    let prepared = prepare(&original).unwrap();
    let child = extensions_child(&original);
    for reorder_parent in [false, true] {
        for reorder_child in [false, true] {
            let mut parent = original.clone();
            let mut child = child.clone();
            if reorder_parent {
                rotate_extensions(&mut parent);
            }
            if reorder_child {
                rotate_extensions(&mut child);
            }
            assert_eq!(
                prepared.verify(
                    wire(&parent),
                    wire(&child),
                    "parent",
                    "child",
                    Path::new("/owned")
                ),
                Ok(()),
                "official unordered outer extension collection: parent={reorder_parent}, child={reorder_child}"
            );
        }
    }
}

#[test]
fn enabled_extension_comparison_keeps_fields_multiplicity_nested_order_and_other_state() {
    let original = extensions_sample();
    let prepared = prepare(&original).unwrap();
    let child = extensions_child(&original);
    let mut cases = vec![];
    let mut lost = original.clone();
    lost["extension_data"]["enabled_extensions.v0"]["extensions"]
        .as_array_mut()
        .unwrap()
        .remove(0);
    cases.push(lost);
    let mut changed = original.clone();
    changed["extension_data"]["enabled_extensions.v0"]["extensions"][1]["envs"]["env"]["MODE"] =
        json!("changed");
    cases.push(changed);
    let mut multiplicity = original.clone();
    multiplicity["extension_data"]["enabled_extensions.v0"]["extensions"][2] =
        original["extension_data"]["enabled_extensions.v0"]["extensions"][1].clone();
    cases.push(multiplicity);
    for pointer in [
        "/enabled_extensions.v0/extensions/0/available_tools",
        "/enabled_extensions.v0/extensions/1/args",
        "/enabled_extensions.v0/other_state",
        "/other_extension.v0/items",
    ] {
        let mut nested = original.clone();
        nested["extension_data"]
            .pointer_mut(pointer)
            .unwrap()
            .as_array_mut()
            .unwrap()
            .reverse();
        cases.push(nested);
    }
    for case in cases {
        assert_eq!(
            prepared.verify(
                wire(&case),
                wire(&child),
                "parent",
                "child",
                Path::new("/owned")
            ),
            Err("point_mismatch")
        );
        let mut changed_child = child.clone();
        changed_child["extension_data"] = case["extension_data"].clone();
        assert_eq!(
            prepared.verify(
                wire(&original),
                wire(&changed_child),
                "parent",
                "child",
                Path::new("/owned")
            ),
            Err("point_mismatch")
        );
    }
    let mut parent = original.clone();
    rotate_extensions(&mut parent);
    parent["unrelated_export_field"] = json!([2, 1]);
    assert_eq!(
        prepared.verify(
            wire(&parent),
            wire(&child),
            "parent",
            "child",
            Path::new("/owned")
        ),
        Err("point_mismatch")
    );
    let mut message_order = child.clone();
    message_order["conversation"]
        .as_array_mut()
        .unwrap()
        .swap(0, 1);
    assert_eq!(
        prepared.verify(
            wire(&original),
            wire(&message_order),
            "parent",
            "child",
            Path::new("/owned")
        ),
        Err("point_mismatch")
    );
}
