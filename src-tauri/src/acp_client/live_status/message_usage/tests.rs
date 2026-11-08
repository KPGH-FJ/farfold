use super::*;

fn wrapper(update: Value) -> Value {
    json!({"kind":"notification","method":"_goose/unstable/session/update","params":{
        "sessionId":"owned","update":update,"_meta":{"future":{"keep":[1,null,true]}}
    }})
}

#[test]
fn message_usage_preserves_all_raw_fields_and_reports_only_the_reviewed_nullable_fields() {
    let raw = wrapper(
        json!({"sessionUpdate":"message_usage","messageId":"message-exact", "usage":{
        "inputTokens":12,"outputTokens":3,"totalTokens":99,"cacheReadTokens":0,"cacheWriteTokens":null,
        "cost":0.0123,"costSource":"provider_reported","elapsedMs":1500,"timeToFirstTokenMs":0,
        "isCompaction":true,"future":{"private":"RAW_ONLY_CANARY"}
    },"unknown":[7,6,5]}),
    );
    let mut projected = present(raw.clone(), "connection-owned", true);
    let hint = projected
        .as_object_mut()
        .unwrap()
        .remove("presentation")
        .unwrap();
    assert_eq!(projected, raw);
    assert_eq!(
        hint,
        json!({"kind":"messageUsage","connectionId":"connection-owned","usage":{
            "messageId":"message-exact","inputTokens":12,"outputTokens":3,"totalTokens":99,
            "cacheReadTokens":0,"cacheWriteTokens":null,"cost":0.0123,"costSource":"provider_reported",
            "elapsedMs":1500,"timeToFirstTokenMs":0,"isCompaction":true
        }})
    );
    assert!(!hint.to_string().contains("RAW_ONLY_CANARY"));
    assert!(hint["usage"].get("currency").is_none());
    assert!(hint.get("compactionActivity").is_none());
}

#[test]
fn message_usage_missing_fields_remain_unreported_and_zero_is_not_missing() {
    let empty = serde_json::to_value(report(&json!({"usage":{}})).unwrap()).unwrap();
    assert_eq!(empty.as_object().unwrap().len(), 11);
    assert!(empty.as_object().unwrap().values().all(Value::is_null));
    let partial = serde_json::to_value(
        report(&json!({"messageId":null,"usage":{
            "inputTokens":0,"cost":0,"costSource":"estimated","isCompaction":false,
            "elapsedMs":null,"future":"retained raw"
        }}))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(partial["inputTokens"], 0);
    assert_eq!(partial["cost"], 0.0);
    assert_eq!(partial["isCompaction"], false);
    assert!(partial["outputTokens"].is_null());
    assert!(partial["messageId"].is_null());
}

#[test]
fn message_usage_invalid_known_values_are_null_and_never_erase_the_raw_report() {
    let cases = [
        json!({"usage":null}),
        json!({"usage":[]}),
        json!({"usage":{"inputTokens":-1}}),
        json!({"usage":{"outputTokens":"3"}}),
        json!({"usage":{"totalTokens":9_007_199_254_740_992_u64}}),
        json!({"usage":{"cacheReadTokens":true}}),
        json!({"usage":{"cacheWriteTokens":1.5}}),
        json!({"usage":{"cost":-0.1}}),
        json!({"usage":{"cost":"0"}}),
        json!({"usage":{"costSource":"future"}}),
        json!({"usage":{"isCompaction":1}}),
        json!({"usage":{"elapsedMs":-1}}),
        json!({"usage":{"timeToFirstTokenMs":false}}),
        json!({"messageId":"","usage":{}}),
        json!({"messageId":true,"usage":{}}),
        json!({"messageId":"bad\nidentity","usage":{}}),
        json!({"messageId":"字".repeat(1025),"usage":{}}),
    ];
    for update in cases {
        let raw = wrapper(update);
        let projected = present(raw.clone(), "connection-owned", true);
        assert_eq!(projected["params"], raw["params"]);
        assert_eq!(
            projected["presentation"],
            json!({"kind":"messageUsage","connectionId":"connection-owned","usage":null})
        );
    }
    let boundary = json!({"messageId":"字".repeat(1024),"usage":{"inputTokens":MAX_SAFE_INTEGER}});
    assert!(report(&boundary).is_ok());
}

#[test]
fn message_usage_an_unowned_known_report_is_null_without_parsing_or_reassociation() {
    let raw = wrapper(json!({"sessionUpdate":"message_usage","usage":{"inputTokens":3}}));
    let projected = present(raw.clone(), "connection-owned", false);
    assert_eq!(projected["params"], raw["params"]);
    assert_eq!(
        projected["presentation"],
        json!({"kind":"messageUsage","connectionId":"connection-owned","usage":null})
    );
    assert!(projected.get("messageId").is_none());
}
