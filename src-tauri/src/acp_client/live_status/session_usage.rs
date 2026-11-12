//! Reviewed conversation usage is metadata, never transcript or work evidence.
use serde_json::{Value, json};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
fn count(value: &Value) -> bool {
    value.as_u64().is_some_and(|n| n <= MAX_SAFE_INTEGER)
}
fn known_fields(value: &Value, allowed: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|o| o.keys().all(|key| allowed.contains(&key.as_str())))
}

pub(super) fn present(mut value: Value, connection: &str, allowed: bool) -> Value {
    let update = &value["params"]["update"];
    let fields = [
        "used",
        "contextLimit",
        "accumulatedInputTokens",
        "accumulatedOutputTokens",
    ];
    if !allowed
        || !known_fields(&value["params"], &["sessionId", "update"])
        || !known_fields(
            update,
            &[
                "sessionUpdate",
                "used",
                "contextLimit",
                "accumulatedInputTokens",
                "accumulatedOutputTokens",
                "accumulatedCost",
            ],
        )
        || fields.iter().any(|key| !count(&update[key]))
        || update.get("accumulatedCost").is_some_and(|cost| {
            !cost.is_null() && !cost.as_f64().is_some_and(|v| v.is_finite() && v >= 0.0)
        })
    {
        return value;
    }
    let usage = json!({"used":update["used"],"contextLimit":update["contextLimit"],
        "accumulatedInputTokens":update["accumulatedInputTokens"],"accumulatedOutputTokens":update["accumulatedOutputTokens"],
        "accumulatedCost":update.get("accumulatedCost").cloned().unwrap_or(Value::Null)});
    value
        .as_object_mut()
        .expect("owned notification wrapper")
        .insert(
            "presentation".into(),
            json!({"kind":"sessionUsage","connectionId":connection,"usage":usage}),
        );
    value
}

/// Standard ACP usage emitted alongside the reviewed custom report. Unknown
/// fields keep their original fail-closed empty-history classification.
pub(crate) fn standard(update: &Value) -> bool {
    known_fields(update, &["sessionUpdate", "used", "size", "cost"])
        && count(&update["used"])
        && count(&update["size"])
        && update.get("cost").is_none_or(|cost| {
            cost.is_null()
                || (known_fields(cost, &["amount", "currency"])
                    && cost["amount"]
                        .as_f64()
                        .is_some_and(|v| v.is_finite() && v >= 0.0)
                    && cost["currency"]
                        .as_str()
                        .is_some_and(|s| s.len() == 3 && s.bytes().all(|b| b.is_ascii_uppercase())))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> Value {
        json!({"kind":"notification","method":"_goose/unstable/session/update","params":{
            "sessionId":"owned","update":{"sessionUpdate":"usage_update","used":0,"contextLimit":1000000,
            "accumulatedInputTokens":0,"accumulatedOutputTokens":0}}})
    }
    #[test]
    fn session_usage_hint_keeps_original_envelope_and_distinguishes_zero_from_unknown() {
        let original = sample();
        let mut projected = present(original.clone(), "connection-owned", true);
        let hint = projected
            .as_object_mut()
            .unwrap()
            .remove("presentation")
            .unwrap();
        assert_eq!(projected, original);
        assert_eq!(
            hint,
            json!({"kind":"sessionUsage","connectionId":"connection-owned","usage":{
            "used":0,"contextLimit":1000000,"accumulatedInputTokens":0,"accumulatedOutputTokens":0,"accumulatedCost":null}})
        );
        assert_eq!(
            present(original.clone(), "connection-owned", false),
            original
        );
    }
    #[test]
    fn session_usage_invalid_or_unknown_fields_keep_raw_without_metadata_authority() {
        for value in [
            Value::Null,
            json!(-1),
            json!(0.5),
            json!("0"),
            json!(true),
            json!(9_007_199_254_740_992_u64),
        ] {
            let mut raw = sample();
            raw["params"]["update"]["used"] = value;
            assert_eq!(present(raw.clone(), "c", true), raw);
        }
        for (key, value) in [
            ("content", json!("opaque original")),
            ("accumulatedCost", json!(-0.1)),
        ] {
            let mut raw = sample();
            raw["params"]["update"][key] = value;
            assert_eq!(present(raw.clone(), "c", true), raw);
        }
        let mut raw = sample();
        raw["params"]["extra"] = json!("opaque original");
        assert_eq!(present(raw.clone(), "c", true), raw);
    }
    #[test]
    fn session_usage_standard_metadata_requires_known_valid_counts_and_cost() {
        assert!(standard(
            &json!({"sessionUpdate":"usage_update","used":0,"size":1000000})
        ));
        for raw in [
            json!({"used":0}),
            json!({"used":0,"size":100,"unknown":true}),
            json!({"used":0,"size":100,"cost":{"amount":-1,"currency":"USD"}}),
        ] {
            assert!(!standard(&raw));
        }
    }
}
