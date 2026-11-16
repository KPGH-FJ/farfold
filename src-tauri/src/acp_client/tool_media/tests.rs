use super::*;
use serde_json::json;

// Shape of the owned official Mistral 2.25.8 effect captured 2026-11-13.
// Public synthetic bytes replace the captured image; this is not a codec test.
fn sample(kind: &str) -> Value {
    json!({"sessionId":"owned", "futureRoot":{"retained":true}, "update":{
        "sessionUpdate":kind, "toolCallId":"effect-owned", "status":"completed",
        "_meta":{"tool_name":"mcp_owned.observe_page", "effect_kind":"tool"},
        "content":[{"type":"content","content":{"type":"text","text":"Official result"}}],
        "rawOutput":{"type":"success", "_meta":{"approval":{
            "approvalSource":"user","approvalType":"ask","decision":"execute"}},
            "content":[{"type":"text","text":"Public page details"},
                {"type":"image","mimeType":"image/png","data":"QUJD"}],
            "structured_content":{"screenshot":{"status":"captured","mimeType":"image/png"}}}
    }})
}

#[test]
fn official_completed_mcp_media_has_a_hint_in_live_and_replay_without_changing_raw() {
    for kind in ["tool_call_update", "tool_call"] {
        let raw = sample(kind);
        let before = raw.clone();
        let hint = event(&raw, "connection", "owned", true);
        assert_eq!(raw, before);
        assert_eq!(
            hint,
            Some(json!({"kind":"toolMedia","connectionId":"connection",
            "sessionId":"owned","toolCallId":"effect-owned",
            "content":[{"type":"image","mimeType":"image/png","data":"QUJD"}]}))
        );
    }
}

#[test]
fn unowned_unrecognized_or_stringified_output_is_never_promoted() {
    let raw = sample("tool_call_update");
    assert!(event(&raw, "c", "owned", false).is_none());
    assert!(event(&raw, "c", "foreign", true).is_none());
    for (path, replacement) in [
        ("/update/sessionUpdate", json!("agent_message_chunk")),
        ("/update/toolCallId", json!("")),
        ("/update/status", json!("in_progress")),
        ("/update/_meta/effect_kind", json!("shell")),
        (
            "/update/rawOutput",
            json!(raw["update"]["rawOutput"].to_string()),
        ),
        ("/update/rawOutput/type", json!("failure")),
        ("/update/rawOutput/content", json!("[{\"type\":\"image\"}]")),
        ("/update/rawOutput/content/1/mimeType", json!("text/html")),
        ("/update/rawOutput/content/1/data", json!("not base64!")),
    ] {
        let mut value = raw.clone();
        *value.pointer_mut(path).unwrap() = replacement;
        assert!(event(&value, "c", "owned", true).is_none(), "{path}");
    }
}

#[test]
fn reviewed_launch_is_source_and_shape_scoped_without_version_or_env_gate() {
    let row = crate::meta_store::AgentRow {
        id: "registry:mistral-vibe".into(),
        name: "Any display name".into(),
        source: "registry".into(),
        command: "/owned/vibe-acp".into(),
        args: vec![],
        env: vec![("PUBLIC_TEST".into(), "unchanged".into())],
        version: None,
        handshake: None,
        created_at: 0,
        updated_at: 0,
    };
    assert!(enabled(&row));
    let mut changed = row.clone();
    changed.version = Some("future-official-release".into());
    assert!(enabled(&changed));
    for (field, value) in [
        ("source", "custom"),
        ("id", "custom:mistral"),
        ("command", "vibe-acp"),
        ("command", "/owned/other"),
    ] {
        let mut changed = row.clone();
        match field {
            "source" => changed.source = value.into(),
            "id" => changed.id = value.into(),
            _ => changed.command = value.into(),
        }
        assert!(!enabled(&changed));
    }
    let mut changed = row;
    changed.args.push("other-entry".into());
    assert!(!enabled(&changed));
}

#[test]
fn media_is_bounded_and_unknown_variants_do_not_gain_a_supplement() {
    let original = sample("tool_call_update");
    for blocks in [
        json!([null]),
        json!([{"type":"future","data":"QUJD"}]),
        json!([{"type":"image","mimeType":"image/png","data":"QR=="}]),
        json!([{"type":"text","text":false},{"type":"image","mimeType":"image/png","data":"QUJD"}]),
        Value::Array(vec![
            json!({"type":"image","mimeType":"image/png","data":"QUJD"});
            17
        ]),
        json!([{"type":"image","mimeType":"image/png","data":"A".repeat(4 * MAX_IMAGE_BYTES.div_ceil(3) + 4)}]),
    ] {
        let mut value = original.clone();
        value["update"]["rawOutput"]["content"] = blocks;
        assert!(event(&value, "c", "owned", true).is_none());
    }
    let mut existing = original;
    existing["presentation"] = json!({"kind":"future","retain":true});
    assert_eq!(
        event(&existing, "c", "owned", true).unwrap()["content"][0]["data"],
        "QUJD"
    );
    assert_eq!(existing["presentation"]["kind"], "future");
}
