use super::*;
use crate::meta_store::mcp_pending::{Action, Pending};
use serde_json::{Value, json};

#[test]
fn public_early_admission_proof_is_camel_case_and_never_implicitly_attached() {
    let early = serde_json::to_value(ChangeError::from(Code::Busy).before_dispatch()).unwrap();
    assert_eq!(early["notDispatched"], true);
    assert_eq!(early.as_object().unwrap().len(), 3);
    assert!(early.get("not_dispatched").is_none());
    let unknown = serde_json::to_value(ChangeError::from(Code::Unknown)).unwrap();
    assert!(unknown.get("notDispatched").is_none());
    assert_eq!(unknown.as_object().unwrap().len(), 2);
    let saved = serde_json::to_value(
        ChangeError::from(Code::Changed)
            .before_dispatch()
            .with_saved_conversation(true),
    )
    .unwrap();
    assert_eq!(saved["conversationSaved"], true);
    assert_eq!(saved.as_object().unwrap().len(), 4);
    assert!(saved.get("conversation_saved").is_none());
}

fn descriptor() -> Value {
    inventory::http_descriptor("Owned", "http://127.0.0.1:8910/mcp").unwrap()
}
fn entry(key: &str, value: Value) -> Value {
    json!({"extensionKey":key,"extension":value})
}
fn inventory(entries: Vec<Value>) -> inventory::Inventory {
    inventory::Inventory::parse(json!({"extensions":entries})).unwrap()
}
fn builtin() -> Value {
    entry(
        "original-exact",
        json!({"type":"platform","name":"developer"}),
    )
}

#[test]
fn add_recovers_only_one_exact_descriptor_and_the_entire_previous_keyed_set() {
    let before = inventory(vec![builtin()]);
    let pending = Pending {
        operation_id: "operation".into(),
        action: Action::Add,
        before_digest: before.digest(),
        expected_digest: None,
        target_digest: inventory::descriptor_digest(&descriptor()),
    };
    let after = inventory(vec![
        builtin(),
        entry("official-assigned-key", descriptor()),
    ]);
    assert!(after.matches_pending(&pending).unwrap());
    assert!(!before.matches_pending(&pending).unwrap());
    assert!(
        !inventory(vec![
            builtin(),
            entry("first", descriptor()),
            entry("second", descriptor())
        ])
        .matches_pending(&pending)
        .unwrap()
    );
    assert!(
        !inventory(vec![
            entry(
                "renamed-original",
                json!({"type":"platform","name":"developer"})
            ),
            entry("owned", descriptor())
        ])
        .matches_pending(&pending)
        .unwrap()
    );
    let mut changed = descriptor();
    changed["server"]["url"] = json!("https://elsewhere.invalid");
    assert!(
        !inventory(vec![builtin(), entry("owned", changed)])
            .matches_pending(&pending)
            .unwrap()
    );
}
#[test]
fn full_inventory_rejects_duplicate_keys_incomplete_shapes_and_unknown_transports() {
    for malformed in [
        json!({"extensions":[builtin(),builtin()]}),
        json!({"extensions":[null]}),
        json!({"extensions":[],"nextCursor":"more"}),
        json!({"extensions":[{"extensionKey":"a","extension":{"type":"future"}}]}),
        json!({"extensions":[entry("a",json!({"type":"mcp","server":{"type":"http","name":"x","url":"https://x.invalid"}}))]}),
        json!({"extensions":[entry("a",json!({"type":"mcp","server":{"type":"sse","name":"x","url":"https://x.invalid"}}))]}),
        json!({"extensions":[entry("a",json!({"type":"mcp","server":{"type":"future","name":"x","url":"https://x.invalid","headers":[]}}))]}),
    ] {
        assert!(inventory::Inventory::parse(malformed).is_err());
    }
}
#[test]
fn official_sse_is_preserved_in_full_digest_but_never_managed_as_http() {
    let value = json!({"type":"mcp","server":{"type":"sse","name":"Sse","url":"https://example.invalid/events","headers":[]}});
    let before = inventory(vec![builtin(), entry("sse-exact", value.clone())]);
    assert!(before.reviewed().unwrap().is_empty());
    let mut changed = value.clone();
    changed["server"]["url"] = json!("https://example.invalid/changed");
    assert_ne!(
        before.digest(),
        inventory(vec![builtin(), entry("sse-exact", changed)]).digest()
    );
    let after = inventory(vec![
        builtin(),
        entry("sse-exact", value),
        entry("new-http", descriptor()),
    ]);
    assert!(after.added(&before, &descriptor()).is_ok());
    assert_eq!(after.reviewed().unwrap().len(), 1);
}
#[test]
fn unknown_descriptor_fields_are_not_erased_by_optional_default_normalization() {
    let plain = inventory(vec![builtin()]);
    let extra = inventory(vec![entry(
        "original-exact",
        json!({"type":"platform","name":"developer","futureSecuritySetting":null}),
    )]);
    assert_ne!(plain.digest(), extra.digest());
}
#[test]
fn digest_is_independent_of_wire_object_field_order_at_every_depth() {
    let left: Value = serde_json::from_str(r#"{"extensions":[{"extensionKey":"key","extension":{"type":"mcp","server":{"type":"http","name":"Owned","url":"http://127.0.0.1:8910/mcp","headers":[]},"future":{"a":1,"b":2}}}]}"#).unwrap();
    let right: Value = serde_json::from_str(r#"{"extensions":[{"extension":{"future":{"b":2,"a":1},"server":{"headers":[],"url":"http://127.0.0.1:8910/mcp","name":"Owned","type":"http"},"type":"mcp"},"extensionKey":"key"}]}"#).unwrap();
    assert_eq!(
        inventory::Inventory::parse(left).unwrap().digest(),
        inventory::Inventory::parse(right).unwrap().digest()
    );
}
#[test]
fn removal_requires_exact_key_descriptor_and_complete_expected_set() {
    let before = inventory(vec![builtin(), entry("official-key", descriptor())]);
    let after = before.without("official-key", &descriptor()).unwrap();
    assert!(before.without("Owned", &descriptor()).is_err());
    let pending = Pending {
        operation_id: "op".into(),
        action: Action::Remove,
        before_digest: before.digest(),
        expected_digest: Some(after.digest()),
        target_digest: inventory::descriptor_digest(&descriptor()),
    };
    assert!(after.matches_pending(&pending).unwrap());
    assert!(!inventory(vec![]).matches_pending(&pending).unwrap());
    assert!(!before.matches_pending(&pending).unwrap());
}
#[test]
fn all_name_normalization_collisions_block_add_without_deriving_remove_target() {
    let before = inventory(vec![entry(
        "unrelated-key",
        json!({"type":"platform","name":"O W N E D"}),
    )]);
    assert!(before.conflict("Owned"));
    assert!(!before.conflict("Distinct"));
}
#[test]
fn tool_reports_are_strict_and_never_treat_filtered_malformed_entries_as_empty() {
    assert!(inventory::tools(&json!({"tools":[]})).unwrap().is_empty());
    for value in [
        json!({"tools":[null]}),
        json!({"tools":[{"name":"same"},{"name":"same"}]}),
        json!({"tools":[],"nextCursor":"later"}),
        json!({"tools":[{"name":true}]}),
    ] {
        assert!(inventory::tools(&value).is_err());
    }
}
#[test]
fn http_input_uses_no_credentials_or_implicit_launch_configuration() {
    for url in [
        "file:///tmp/a",
        "http://user:secret@example.invalid",
        "http://example.invalid/#secret",
        " http://example.invalid",
        "http://example.invalid/\nprivate",
        "http://example.invalid/\tprivate",
        "http://example.invalid\\private",
        "http:////example.invalid",
        "http://example.invalid:/mcp",
        "http://example.invalid/%broken",
    ] {
        assert!(inventory::http_descriptor("Owned", url).is_err());
    }
    assert!(inventory::http_descriptor("bad/name", "https://example.invalid").is_err());
    assert_eq!(descriptor()["server"]["headers"], json!([]));
}
