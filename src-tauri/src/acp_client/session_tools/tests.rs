use super::*;
use serde_json::{Value, json};

#[test]
fn empty_report_is_still_unreported_and_never_a_complete_inventory() {
    let report = types::parse(&json!({"tools":[]})).unwrap();
    assert_eq!(report.completeness, "unreported");
    assert_eq!(report.reported_item_count, 0);
    assert!(report.items.is_empty());
    assert!(!report.items_truncated);
    assert!(report.observed_at_ms > 0);
    let value = serde_json::to_value(report).unwrap();
    assert!(value.get("complete").is_none());
    assert!(value.get("source").is_none());
}

#[test]
fn projection_is_bounded_unicode_and_only_exposes_reviewed_fields() {
    let raw = json!({"name":"名".repeat(257),"description":"述".repeat(2049),"permission":"ask_before","parameters":["PRIVATE_SCHEMA_CANARY"],"inputSchema":{"token":"PRIVATE_SCHEMA_CANARY"},"outputSchema":{"secret":"PRIVATE_SCHEMA_CANARY"},"config":"PRIVATE_SCHEMA_CANARY"});
    let report =
        types::parse(&json!({"tools":vec![raw;257],"extra":"PRIVATE_SCHEMA_CANARY"})).unwrap();
    assert_eq!(report.reported_item_count, 257);
    assert_eq!(report.items.len(), 256);
    assert!(report.items_truncated);
    let first = &report.items[0];
    assert_eq!(first.name.chars().count(), 256);
    assert_eq!(first.description.as_ref().unwrap().chars().count(), 2048);
    assert!(first.name_truncated && first.description_truncated);
    let public = serde_json::to_value(report).unwrap();
    assert!(!public.to_string().contains("PRIVATE_SCHEMA_CANARY"));
    assert_eq!(public["items"][0].as_object().unwrap().len(), 5);
}

#[test]
fn invalid_shapes_and_unknown_permissions_do_not_become_empty_reports() {
    for value in [
        json!({}),
        json!({"tools":null}),
        json!({"tools":{}}),
        json!({"tools":[null]}),
        json!({"tools":[{"name":true}]}),
        json!({"tools":[{"name":""}]}),
        json!({"tools":[{"name":"x\u{1b}"}]}),
        json!({"tools":[{"name":"x","permission":"PRIVATE_PERMISSION_CANARY"}]}),
        json!({"tools":[{"name":"x","permission":false}]}),
        json!({"tools":[{"name":"x","description":{}}]}),
    ] {
        let error = types::parse(&value).unwrap_err();
        assert_eq!(error.code, Code::InvalidResponse);
        assert!(!serde_json::to_string(&error).unwrap().contains("PRIVATE_"));
    }
    for permission in [
        Value::Null,
        json!("always_allow"),
        json!("ask_before"),
        json!("never_allow"),
    ] {
        assert!(types::parse(&json!({"tools":[{"name":"x","description":"line1\nline2\tmore","permission":permission}]})).is_ok());
    }
}

#[test]
fn capability_is_a_reviewed_launch_supplement_not_a_name_or_version_gate() {
    let mut row = crate::meta_store::AgentRow {
        id: "registry:goose".into(),
        name: "anything".into(),
        source: "registry".into(),
        command: if cfg!(windows) {
            "C:\\owned\\goose.exe".into()
        } else {
            "/owned/goose".into()
        },
        args: vec!["acp".into()],
        env: vec![],
        version: Some("future".into()),
        handshake: None,
        created_at: 0,
        updated_at: 0,
    };
    assert!(Availability::new(&row).capability().is_some());
    row.version = None;
    assert!(Availability::new(&row).capability().is_some());
    row.source = "custom".into();
    assert!(Availability::new(&row).capability().is_none());
    row.source = "registry".into();
    row.id = "goose".into();
    assert!(Availability::new(&row).capability().is_none());
    row.id = "registry:goose".into();
    row.args.push("--future".into());
    assert!(Availability::new(&row).capability().is_none());
}

#[test]
fn safe_error_contract_and_operation_ids_are_finite() {
    for code in [
        Code::Unavailable,
        Code::Changed,
        Code::Busy,
        Code::Timeout,
        Code::InvalidResponse,
        Code::QueryFailed,
    ] {
        let value = serde_json::to_value(ToolsError::from(code)).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 2);
        assert!(!value.to_string().contains("PRIVATE_CANARY"));
    }
    for id in ["", "value with spaces", "payload:x", &"x".repeat(129)] {
        assert!(!types::valid_operation_id(id));
    }
    assert!(types::valid_operation_id("owned-abc_123"));
}
