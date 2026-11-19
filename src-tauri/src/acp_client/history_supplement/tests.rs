use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
pub(super) fn records() -> Vec<Value> {
    vec![
        json!({"type":"session_meta","timestamp":"2026-11-13T00:00:00Z","payload":{"id":"owned-session","cwd":"/owned","originator":"fast-agent","source":"cli","base_instructions":{"text":"SECRET_SYSTEM"}}}),
        json!({"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"SECRET_DEVELOPER"}]}}),
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}),
        json!({"type":"turn_context","payload":{"cwd":"/owned","summary":"SECRET_CONTEXT"}}),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Read this public page."}]}}),
        json!({"type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"SECRET_THOUGHT"}]}}),
        json!({"type":"response_item","payload":{"type":"function_call","call_id":"call-1","name":"public_page__observe_page","arguments":"{\"screenshot\":true}"}}),
        json!({"type":"event_msg","payload":{"type":"token_count","info":{}}}),
        json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","status":"success","output":[{"type":"input_text","text":"{\"title\":\"Public page\"}"},{"type":"input_image","image_url":format!("data:image/png;base64,{}",STANDARD.encode(b"controlled-image-bytes"))}]}}),
        json!({"type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"The public page is shown.","annotations":[]}]}}),
        json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1"}}),
    ]
}
pub(super) fn encode(records: &[Value]) -> Vec<u8> {
    let mut out = Vec::new();
    for v in records {
        out.extend(serde_json::to_vec(v).unwrap());
        out.push(b'\n');
    }
    out
}
fn read(records: &[Value]) -> Result<ParsedHistory> {
    parse(&encode(records), "owned-session", "/owned")
}
#[test]
fn actual_export_shape_keeps_pair_media_gaps_and_excludes_private_instructions() {
    let result = read(&records()).unwrap();
    assert_eq!(result.anchors.len(), 2);
    assert_eq!(result.tools.len(), 1);
    let tool = &result.tools[0];
    assert_eq!((tool.call_after_anchor, tool.result_after_anchor), (1, 1));
    assert_eq!(tool.arguments, json!({"screenshot":true}));
    assert_eq!(tool.content.len(), 2);
    let out = serde_json::to_string(&result).unwrap();
    assert!(!out.contains("SECRET_"));
    assert!(out.contains("rawCall"));
    assert!(out.contains("rawResult"));
    assert_eq!(
        serde_json::to_value(&result).unwrap()["tools"][0]["content"][1]["mimeType"],
        "image/png"
    );
}
fn records_with_configuration() -> Vec<Value> {
    let mut r = records();
    r[0]["payload"]["model_provider"] = "codexresponses".into();
    r[0]["payload"]["model_spec"] = "SECRET_PROVIDER_ALIAS".into();
    r[3]["payload"]["model"] = "gpt-5.6-sol".into();
    r[3]["payload"]["model_spec"] = "SECRET_EXPANDED_MODEL_SPEC".into();
    r
}

#[test]
fn historical_configuration_emits_only_provider_and_agreeing_model() {
    let mut r = records_with_configuration();
    r.insert(4, r[3].clone());
    let value = event(read(&r), "open", "connection", "owned-session", "/owned");
    assert_eq!(
        value["historicalConfiguration"],
        json!({"provider":"codexresponses","model":"gpt-5.6-sol"})
    );
    assert_eq!(value["tools"].as_array().unwrap().len(), 1);
    assert!(!value.to_string().contains("SECRET_"));
}

#[test]
fn incomplete_unsafe_or_conflicting_history_configuration_keeps_tools() {
    let r = records_with_configuration();
    for model in [
        Value::Null,
        json!("different-model"),
        json!("gpt-5.6-sol?reasoning=high"),
        json!("/private/model"),
        json!("x".repeat(129)),
    ] {
        let mut records = r.clone();
        let mut context = records[3].clone();
        if model.is_null() {
            context["payload"].as_object_mut().unwrap().remove("model");
        } else {
            context["payload"]["model"] = model;
        }
        records.insert(4, context);
        let result = read(&records).unwrap();
        assert!(result.historical_configuration.is_none());
        assert_eq!(result.tools.len(), 1);
    }
    let mut r = r;
    r[0]["payload"]["model_provider"] = "https://provider.example".into();
    let result = read(&r).unwrap();
    assert!(result.historical_configuration.is_none());
    assert_eq!(result.tools.len(), 1);
}

#[test]
fn configuration_can_accompany_a_complete_plain_history_without_tools() {
    let mut r = records_with_configuration();
    r.remove(8);
    r.remove(6);
    let h = read(&r).unwrap();
    assert!(h.tools.is_empty());
    assert_eq!(h.historical_configuration.unwrap().model, "gpt-5.6-sol");

    r.remove(7);
    assert!(read(&r).unwrap().historical_configuration.is_none());
}

#[test]
fn call_and_result_gaps_remain_distinct_and_parallel_pairs_preserve_call_order() {
    let mut r = records();
    let mut call = r[6].clone();
    call["payload"]["call_id"] = "call-2".into();
    r.insert(7, call);
    let message = r[10].clone();
    r.insert(8, message);
    let mut result = r[10].clone();
    result["payload"]["call_id"] = "call-2".into();
    r.insert(10, result);
    let h = read(&r).unwrap();
    assert_eq!(h.tools.len(), 2);
    assert_eq!(h.tools[0].tool_call_id, "call-1");
    assert_eq!(h.tools[1].tool_call_id, "call-2");
    assert_eq!(
        (h.tools[0].call_after_anchor, h.tools[0].result_after_anchor),
        (1, 2)
    );
}
#[test]
fn duplicate_keys_even_in_nested_arguments_never_use_last_value() {
    let mut r = records();
    r[6]["payload"]["arguments"] = "{\"screenshot\":false,\"screenshot\":true}".into();
    assert_eq!(read(&r).unwrap_err(), Reason::Invalid);
    let bytes = encode(&records());
    let raw = String::from_utf8(bytes).unwrap().replacen(
        "\"role\":\"user\"",
        "\"role\":\"developer\",\"role\":\"user\"",
        1,
    );
    assert_eq!(
        parse(raw.as_bytes(), "owned-session", "/owned").unwrap_err(),
        Reason::Invalid
    );
}
#[test]
fn boolean_fields_are_not_coerced_from_numbers_strings_or_null() {
    for value in [json!(1), json!(1.0), json!("true"), Value::Null] {
        let mut r = records();
        r[9]["payload"]["end_turn"] = value;
        assert!(read(&r).is_err());
    }
    let mut r = records();
    r[9]["payload"]["end_turn"] = true.into();
    assert!(read(&r).is_ok());
}
#[test]
fn exact_session_and_cwd_include_context_not_only_header() {
    let b = encode(&records());
    assert_eq!(
        parse(&b, "different", "/owned").unwrap_err(),
        Reason::Changed
    );
    assert_eq!(
        parse(&b, "owned-session", "/other").unwrap_err(),
        Reason::Changed
    );
    let mut r = records();
    r[3]["payload"]["cwd"] = "/other".into();
    assert_eq!(read(&r).unwrap_err(), Reason::Changed);
}
#[test]
fn truncation_extra_documents_missing_pair_and_reordered_pair_fail() {
    let b = encode(&records());
    assert!(parse(&b[..b.len() - 1], "owned-session", "/owned").is_err());
    let mut r = records();
    r.remove(8);
    assert!(read(&r).is_err());
    let mut r = records();
    r.swap(6, 8);
    assert!(read(&r).is_err());
    let mut r = records();
    r.push(r[0].clone());
    assert!(read(&r).is_err());
    let mut b = b;
    b.extend_from_slice(b"{}{}\n");
    assert!(parse(&b, "owned-session", "/owned").is_err());
}
#[test]
fn duplicate_call_result_or_explicit_message_identity_fail() {
    for index in [6, 8] {
        let mut r = records();
        r.insert(index, r[index].clone());
        assert!(read(&r).is_err());
    }
    let mut r = records();
    r[4]["payload"]["id"] = "duplicate".into();
    r[9]["payload"]["id"] = "duplicate".into();
    assert!(read(&r).is_err());
}
#[test]
fn unsafe_media_and_unknown_content_or_role_never_become_attachments() {
    for uri in [
        "https://example.test/image.png",
        "file:///private/secret",
        "data:text/html;base64,PHNjcmlwdD4=",
        "data:image/png;base64,YQ",
        "data:image/png;base64,YR==",
    ] {
        let mut r = records();
        r[8]["payload"]["output"][1]["image_url"] = uri.into();
        assert!(read(&r).is_err());
    }
    let mut r = records();
    r[8]["payload"]["output"][1]["type"] = "resource".into();
    assert!(read(&r).is_err());
    let mut r = records();
    r[9]["payload"]["role"] = "future-role".into();
    assert!(read(&r).is_err());
}
#[test]
fn input_record_anchor_tool_and_serialized_output_budgets_are_enforced() {
    assert_eq!(
        parse(&vec![b' '; INPUT_LIMIT + 1], "owned-session", "/owned").unwrap_err(),
        Reason::Limit
    );
    let mut r = records();
    for _ in 0..RECORD_LIMIT {
        r.push(json!({"type":"event_msg","payload":{"type":"token_count"}}));
    }
    assert_eq!(read(&r).unwrap_err(), Reason::Limit);
    let mut r = records();
    for _ in 0..ANCHOR_LIMIT {
        r.push(r[9].clone());
    }
    assert_eq!(read(&r).unwrap_err(), Reason::Limit);
    let mut r = records();
    for i in 0..TOOL_LIMIT {
        let mut c = r[6].clone();
        c["payload"]["call_id"] = format!("extra-{i}").into();
        r.push(c);
    }
    assert_eq!(read(&r).unwrap_err(), Reason::Limit);
    let mut r = records();
    r[8]["payload"]["output"] = json!("x".repeat(OUTPUT_LIMIT / 2 + 100));
    assert_eq!(read(&r).unwrap_err(), Reason::Limit);
}
#[test]
fn numeric_tool_arguments_remain_numeric_not_boolean_claims() {
    let mut r = records();
    r[6]["payload"]["arguments"] = "{\"screenshot\":1}".into();
    let h = read(&r).unwrap();
    assert_eq!(h.tools[0].arguments["screenshot"], json!(1));
    assert_ne!(h.tools[0].arguments["screenshot"], json!(true));
}
#[test]
fn host_supplement_events_cannot_be_spoofed_by_agent_notifications() {
    for kind in ["historyToolSupplement", "historyToolSupplementStatus"] {
        let raw = json!({"kind":kind,"sessionId":"owned","anchors":[],"tools":[]});
        let guarded = crate::acp_client::tool_media::guard_notification(raw.clone());
        assert_eq!(guarded["kind"], "notification");
        assert_eq!(guarded["params"], raw);
        let raw = json!({"kind":kind,"sessionId":"owned","update":{"sessionUpdate":"tool_call","toolCallId":"real-tool"}});
        assert_eq!(
            crate::acp_client::tool_media::guard_notification(raw.clone()),
            raw
        );
    }
}
#[test]
fn envelope_has_exact_owner_and_failures_never_echo_child_text() {
    let value = event(
        Err(Reason::Invalid),
        "open",
        "connection",
        "session",
        "/cwd",
    );
    assert_eq!(
        value,
        json!({"kind":"historyToolSupplementStatus","openToken":"open","connectionId":"connection","sessionId":"session","cwd":"/cwd","reason":"invalid"})
    );
    let value = event(read(&records()), "open", "connection", "session", "/cwd");
    assert_eq!(value.as_object().unwrap().len(), 7);
}
#[test]
fn selected_official_role_requires_unique_declared_current_mode() {
    assert_eq!(
        runner::role(&json!({"modes":{"currentModeId":"agent","availableModes":[{"id":"agent"}]}}))
            .unwrap(),
        "agent"
    );
    for value in [
        json!({}),
        json!({"modes":{"currentModeId":"other","availableModes":[{"id":"agent"}]}}),
        json!({"modes":{"currentModeId":"agent","availableModes":[{"id":"agent"},{"id":"agent"}]}}),
        json!({"modes":{"currentModeId":"../../x","availableModes":[{"id":"../../x"}]}}),
    ] {
        assert!(runner::role(&value).is_err());
    }
}

#[test]
fn duplicate_response_item_id_across_call_and_result_is_rejected() {
    let mut records = records();
    records[6]["payload"]["id"] = "same-item".into();
    records[8]["payload"]["id"] = "same-item".into();
    assert_eq!(read(&records).unwrap_err(), Reason::Invalid);
}

#[test]
fn exact_twelve_record_official_shape_keeps_redundant_user_and_token_events_out_of_anchors() {
    let r = records();
    let actual_shape = vec![
        r[0].clone(),
        r[1].clone(),
        r[2].clone(),
        json!({"type":"event_msg","payload":{"type":"user_message","message":"Read this public page.","local_images":[],"text_elements":[]}}),
        r[3].clone(),
        r[4].clone(),
        r[6].clone(),
        r[7].clone(),
        r[8].clone(),
        r[9].clone(),
        r[7].clone(),
        r[10].clone(),
    ];
    assert_eq!(actual_shape.len(), 12);
    let parsed = read(&actual_shape).unwrap();
    assert_eq!(parsed.anchors.len(), 2);
    assert_eq!(parsed.tools.len(), 1);
}
