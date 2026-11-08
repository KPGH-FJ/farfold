use super::*;

fn wrapper(update: Value) -> Value {
    json!({"kind":"notification","method":METHOD,"params":{"sessionId":"owned","update":update,"_meta":{"future":[1,null,{"exact":true}]}}})
}

#[test]
fn live_status_adds_only_presentation_and_preserves_the_full_original_envelope() {
    for kind in ["notice", "progress"] {
        let raw = wrapper(
            json!({"sessionUpdate":"status_message","status":{"type":kind,"message":"line 1\nline 2\r\t👩‍💻","future":"retained"},"unknown":{"nested":true}}),
        );
        let projected = present(raw.clone(), "owned", true, || true);
        assert_eq!(projected["method"], raw["method"]);
        assert_eq!(projected["params"], raw["params"]);
        let mut restored = projected.clone();
        restored.as_object_mut().unwrap().remove("presentation");
        assert_eq!(restored, raw);
        assert_eq!(
            projected["presentation"],
            json!({"kind":"liveStatus","status":{"type":kind,"message":"line 1\nline 2\r\t👩‍💻","truncated":false}})
        );
    }
}

#[test]
fn live_status_projection_has_a_unicode_budget_and_never_interprets_text() {
    let text = format!("<b>Compaction complete</b> {}", "字".repeat(2048));
    let raw = wrapper(
        json!({"sessionUpdate":"status_message","status":{"type":"progress","message":text}}),
    );
    let projected = present(raw.clone(), "owned", true, || true);
    assert_eq!(projected["params"], raw["params"]);
    assert_eq!(
        projected["presentation"]["status"]["message"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        2048
    );
    assert_eq!(projected["presentation"]["status"]["type"], "progress");
    assert_eq!(projected["presentation"]["status"]["truncated"], true);
    assert!(projected.get("compactionActivity").is_none());
    assert!(projected.get("sessionUpdate").is_none());
}

#[test]
fn live_status_known_malformed_shape_is_null_without_discarding_its_raw_fields() {
    for status in [
        Value::Null,
        json!([]),
        json!({}),
        json!({"type":"notice","message":null}),
        json!({"type":"notice","message":false}),
        json!({"type":"future","message":"keep"}),
        json!({"type":"notice","message":""}),
        json!({"type":"notice","message":" \n\t"}),
        json!({"type":"notice","message":"x\0"}),
        json!({"type":"notice","message":"x\u{1b}"}),
        json!({"type":"notice","message":"x\u{0085}"}),
    ] {
        let raw = wrapper(
            json!({"sessionUpdate":"status_message","status":status,"unrecognized":[3,2,1]}),
        );
        let projected = present(raw.clone(), "owned", true, || true);
        assert_eq!(projected["params"], raw["params"]);
        assert_eq!(
            projected["presentation"],
            json!({"kind":"liveStatus","status":null})
        );
    }
}

#[test]
fn live_status_unrecognized_variant_method_foreign_session_gets_no_hint_and_old_owner_is_null() {
    let raw = wrapper(
        json!({"sessionUpdate":"status_message","status":{"type":"notice","message":"text"}}),
    );
    assert_eq!(present(raw.clone(), "foreign", true, || true), raw);
    assert_eq!(
        present(raw.clone(), "owned", true, || false)["presentation"],
        json!({"kind":"liveStatus","status":null})
    );
    assert_eq!(present(raw.clone(), "owned", false, || true), raw);
    for update in [
        json!({"sessionUpdate":"message_usage","usage":{"isCompaction":true}}),
        json!({"sessionUpdate":"future","status":{"type":"notice","message":"text"}}),
        json!({"sessionUpdate":null}),
    ] {
        let value = wrapper(update);
        assert_eq!(present(value.clone(), "owned", true, || true), value);
    }
    let mut other = raw.clone();
    other["method"] = json!("session/update");
    assert_eq!(present(other.clone(), "owned", true, || true), other);
}

#[test]
fn live_status_initialize_opt_in_changes_only_the_reviewed_goose_route() {
    let original = Meta::from_iter([
        ("terminal-auth".into(), json!(true)),
        ("jetbrains".into(), json!({"air":{"failure":true}})),
    ]);
    let mut disabled = original.clone();
    initialize_meta(&mut disabled, false);
    assert_eq!(disabled, original);
    let mut enabled = original.clone();
    initialize_meta(&mut enabled, true);
    assert_eq!(
        enabled.remove("goose"),
        Some(json!({"customNotifications":true}))
    );
    assert_eq!(enabled, original);
}
