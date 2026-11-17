//! Counts and fixed flags for observed configuration frames. Identifiers are
//! used only to pair an outstanding request with the response on this wire.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::VecDeque, sync::Mutex};

const MAX_PENDING: usize = 16;
const MAX_OPTIONS: u16 = 64;
const MAX_CHOICES: u16 = 4096;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Source {
    NewResponse,
    SetConfigResponse,
    Update,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Shape {
    source: Source,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_wire_sequence: Option<u64>,
    option_count: u16,
    model_choice_count: u16,
    reasoning_choice_count: u16,
    reasoning_offers_off: bool,
    reasoning_offers_medium: bool,
    reasoning_offers_high: bool,
}

struct Pending {
    id: Value,
    source: Option<Source>,
    sequence: u64,
}

#[derive(Default)]
pub(in crate::acp_client) struct ConfigurationObservation(Mutex<VecDeque<Pending>>);

fn request_id(message: &Value) -> Option<&Value> {
    let id = message.get("id")?;
    (id.as_i64().is_some()
        || id.as_u64().is_some()
        || id
            .as_str()
            .is_some_and(|id| !id.is_empty() && id.len() <= 256))
    .then_some(id)
}

impl ConfigurationObservation {
    fn request(&self, message: &Value, sequence: u64, source: Source) {
        let Some(id) = request_id(message) else {
            return;
        };
        let Ok(mut pending) = self.0.lock() else {
            return;
        };
        if let Some(previous) = pending.iter_mut().find(|item| &item.id == id) {
            previous.source = None;
            return;
        }
        if pending.len() == MAX_PENDING {
            pending.pop_front();
        }
        pending.push_back(Pending {
            id: id.clone(),
            source: Some(source),
            sequence,
        });
    }

    fn response(&self, message: &Value) -> Option<Pending> {
        let id = request_id(message)?;
        let mut pending = self.0.lock().ok()?;
        let index = pending.iter().position(|item| &item.id == id)?;
        pending.remove(index)
    }
}

fn visit_choices(option: &Value, mut visit: impl FnMut(&str) -> Option<()>) -> Option<()> {
    let choices = option.get("options")?.as_array()?;
    let mut remaining = usize::from(MAX_CHOICES).checked_sub(choices.len())?;
    for entry in choices {
        if let Some(group) = entry.get("options") {
            let group = group.as_array()?;
            remaining = remaining.checked_sub(group.len())?;
            for choice in group {
                visit(choice.get("value")?.as_str()?)?;
            }
        } else {
            visit(entry.get("value")?.as_str()?)?;
        }
    }
    Some(())
}

fn summarize(options: &Value, source: Source, request_wire_sequence: Option<u64>) -> Option<Value> {
    let options = options.as_array()?;
    let option_count = u16::try_from(options.len()).ok()?;
    if option_count > MAX_OPTIONS {
        return None;
    }
    let mut shape = Shape {
        source,
        request_wire_sequence,
        option_count,
        model_choice_count: 0,
        reasoning_choice_count: 0,
        reasoning_offers_off: false,
        reasoning_offers_medium: false,
        reasoning_offers_high: false,
    };
    for option in options.iter().filter(|option| option["type"] == "select") {
        match option["category"].as_str() {
            Some("model") => visit_choices(option, |_| {
                shape.model_choice_count += 1;
                (shape.model_choice_count <= MAX_CHOICES).then_some(())
            })?,
            Some("thought_level") => visit_choices(option, |value| {
                shape.reasoning_choice_count += 1;
                shape.reasoning_offers_off |= value == "off";
                shape.reasoning_offers_medium |= value == "medium";
                shape.reasoning_offers_high |= value == "high";
                (shape.reasoning_choice_count <= MAX_CHOICES).then_some(())
            })?,
            _ => {}
        }
    }
    serde_json::to_value(shape).ok()
}

pub(super) fn observe(
    message: &Value,
    direction: &str,
    event: &str,
    tracked: Option<(&ConfigurationObservation, u64)>,
) -> Option<Value> {
    if message["jsonrpc"] != "2.0" {
        return None;
    }
    match (direction, event) {
        ("out", "session/new" | "session/set_config_option")
            if message.get("error").is_none() && message.get("result").is_none() =>
        {
            let (observation, sequence) = tracked?;
            let source = if event == "session/new" {
                Source::NewResponse
            } else {
                Source::SetConfigResponse
            };
            observation.request(message, sequence, source);
            None
        }
        ("in", "response") if message.get("method").is_none() => {
            let (observation, sequence) = tracked?;
            let pending = observation.response(message)?;
            if message.get("error").is_some() || pending.sequence >= sequence {
                return None;
            }
            summarize(
                message.pointer("/result/configOptions")?,
                pending.source?,
                Some(pending.sequence),
            )
        }
        ("in", "session/update")
            if message.get("error").is_none() && message.get("id").is_none() =>
        {
            let update = message.pointer("/params/update")?;
            if update["sessionUpdate"] != "config_option_update" {
                return None;
            }
            summarize(update.get("configOptions")?, Source::Update, None)
        }
        _ => None,
    }
}

pub(super) fn safe_shape(value: &Value, record: &Value, event: &str) -> Option<Value> {
    let shape = Shape::deserialize(value).ok()?;
    let source_matches = match (shape.source, shape.request_wire_sequence) {
        (Source::NewResponse | Source::SetConfigResponse, Some(request)) => {
            event == "response" && request > 0 && request < record.get("wireSequence")?.as_u64()?
        }
        (Source::Update, None) => event == "session/update",
        _ => false,
    };
    let offered = u16::from(shape.reasoning_offers_off)
        + u16::from(shape.reasoning_offers_medium)
        + u16::from(shape.reasoning_offers_high);
    if !source_matches
        || shape.option_count > MAX_OPTIONS
        || shape.model_choice_count > MAX_CHOICES
        || shape.reasoning_choice_count > MAX_CHOICES
        || offered > shape.reasoning_choice_count
        || (shape.option_count == 0
            && (shape.model_choice_count > 0 || shape.reasoning_choice_count > 0))
    {
        return None;
    }
    serde_json::to_value(shape).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::RawJsonRpcMessage;
    use serde_json::json;

    fn frame(
        observation: &ConfigurationObservation,
        direction: &str,
        sequence: u64,
        message: Value,
    ) -> Value {
        let wire = serde_json::from_value::<RawJsonRpcMessage>(message).unwrap();
        let mut record = super::super::diagnostic_record_observed(
            &serde_json::to_string(&wire).unwrap(),
            direction,
            None,
            Some((observation, sequence)),
        );
        record["wireSequence"] = sequence.into();
        super::super::safe_record(&record).unwrap()
    }

    fn request(id: Value, method: &str) -> Value {
        json!({"jsonrpc":"2.0","id":id,"method":method,"params":{
            "sessionId":"session-canary","value":"model-canary","env":{"KEY":"secret-canary"}
        }})
    }

    fn response(id: Value) -> Value {
        json!({"jsonrpc":"2.0","id":id,"result":{
            "sessionId":"session-canary","_meta":{"headers":"secret-canary"},"configOptions":[
                {"type":"select","category":"thought_level","options":[{"value":"off"}]}
            ]
        }})
    }

    #[test]
    fn matches_exact_outstanding_new_and_setter_ids_without_logging_them() {
        let observation = ConfigurationObservation::default();
        let new = json!(42);
        let set = json!("request-canary");
        frame(&observation, "out", 1, request(new.clone(), "session/new"));
        frame(
            &observation,
            "out",
            2,
            request(set.clone(), "session/set_config_option"),
        );
        frame(&observation, "out", 3, request(json!(43), "session/load"));
        for (sequence, id) in [(4, json!("42")), (5, json!(43))] {
            assert!(
                frame(&observation, "in", sequence, response(id))
                    .get("configurationShape")
                    .is_none()
            );
        }
        for (sequence, id, source, request_sequence) in [
            (6, set.clone(), "set_config_response", 2),
            (7, new, "new_response", 1),
        ] {
            let saved = frame(&observation, "in", sequence, response(id));
            assert_eq!(
                saved["configurationShape"],
                json!({
                    "source":source,"requestWireSequence":request_sequence,"optionCount":1,
                    "modelChoiceCount":0,"reasoningChoiceCount":1,"reasoningOffersOff":true,
                    "reasoningOffersMedium":false,"reasoningOffersHigh":false
                })
            );
            assert!(!saved.to_string().contains("canary"));
        }
        assert!(
            frame(&observation, "in", 8, response(set))
                .get("configurationShape")
                .is_none()
        );
    }

    #[test]
    fn bounds_outstanding_ids_and_discards_repeated_or_failed_responses() {
        let observation = ConfigurationObservation::default();
        for index in 1..=u64::try_from(MAX_PENDING + 1).unwrap() {
            frame(
                &observation,
                "out",
                index,
                request(json!(index), "session/new"),
            );
        }
        assert_eq!(observation.0.lock().unwrap().len(), MAX_PENDING);
        assert!(
            frame(&observation, "in", 30, response(json!(1)))
                .get("configurationShape")
                .is_none()
        );
        frame(&observation, "out", 31, request(json!(2), "session/new"));
        assert!(
            frame(&observation, "in", 32, response(json!(2)))
                .get("configurationShape")
                .is_none()
        );
        let failed =
            json!({"jsonrpc":"2.0","id":3,"error":{"code":-32000,"message":"secret-canary"}});
        assert!(
            frame(&observation, "in", 33, failed)
                .get("configurationShape")
                .is_none()
        );
        assert!(
            frame(&observation, "in", 34, response(json!(3)))
                .get("configurationShape")
                .is_none()
        );
    }

    #[test]
    fn omits_over_budget_shapes_and_rejects_untrusted_stored_fields() {
        let choices = vec![json!({"value":"private-canary"}); usize::from(MAX_CHOICES) + 1];
        assert!(
            summarize(
                &json!([{"type":"select","category":"model","options":choices}]),
                Source::Update,
                None
            )
            .is_none()
        );
        let options = vec![json!({"type":"boolean"}); usize::from(MAX_OPTIONS) + 1];
        assert!(summarize(&json!(options), Source::Update, None).is_none());

        let mut record = json!({"version":1,"ts":1,"dir":"in","event":"response","bytes":2,
        "error":"none","wireSequence":10,"configurationShape":{
            "source":"set_config_response","requestWireSequence":5,"optionCount":1,
            "modelChoiceCount":1,"reasoningChoiceCount":0,"reasoningOffersOff":false,
            "reasoningOffersMedium":false,"reasoningOffersHigh":false
        }});
        assert_eq!(super::super::safe_record(&record), Some(record.clone()));
        for (field, value) in [
            ("modelId", json!("model-canary")),
            ("requestWireSequence", json!(10)),
            ("optionCount", json!(MAX_OPTIONS + 1)),
            ("modelChoiceCount", json!(MAX_CHOICES + 1)),
            ("reasoningOffersMedium", json!(true)),
            ("source", json!("secret-canary")),
        ] {
            let mut mutated = record.clone();
            mutated["configurationShape"][field] = value;
            assert!(
                super::super::safe_record(&mutated)
                    .unwrap()
                    .get("configurationShape")
                    .is_none()
            );
        }
        record["dir"] = "out".into();
        assert!(
            super::super::safe_record(&record)
                .unwrap()
                .get("configurationShape")
                .is_none()
        );
    }
}
