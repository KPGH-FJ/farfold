//! Fixed Codex 0.143.0 server-request contract. Raw requests are preserved;
//! replies are validated against this request, never a generic permission flag.
use crate::host_ids::derived_host_id;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

pub(crate) fn supported(method: &str) -> bool {
    matches!(
        method,
        "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/tool/requestUserInput"
    )
}

pub(crate) fn request_key(id: &Value) -> Result<String, String> {
    if !(id.is_i64() || id.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 128)) {
        return Err("Codex 交互请求身份无效".into());
    }
    Ok(derived_host_id("codex-request", &[&id.to_string()]))
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub id: String,
    pub header: String,
    pub question: String,
    #[serde(default)]
    pub is_other: bool,
    #[serde(default)]
    pub is_secret: bool,
    pub options: Option<Vec<QuestionOption>>,
}
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct QuestionOption {
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexInteraction {
    pub key: String,
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub method: String,
    pub decisions: Vec<Value>,
    pub questions: Vec<Question>,
    pub native_request: Value,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum CodexInteractionReply {
    Decision {
        decision: Value,
    },
    Answers {
        answers: BTreeMap<String, Vec<String>>,
    },
}

impl CodexInteraction {
    pub(crate) fn parse(native_request: Value) -> Result<Self, String> {
        if native_request.to_string().len() > 128 * 1024 {
            return Err("Codex 交互超过显示与回复限制；未自动批准".into());
        }
        let wire_key = request_key(&native_request["id"])?;
        let method = native_request["method"]
            .as_str()
            .filter(|m| supported(m))
            .ok_or("Codex 交互类型尚未支持")?
            .to_owned();
        let p = &native_request["params"];
        let identity = |field: &str| -> Result<String, String> {
            p[field]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 256)
                .map(str::to_owned)
                .ok_or_else(|| "Codex 交互缺少原生线程、轮次或条目身份".into())
        };
        let thread_id = identity("threadId")?;
        let turn_id = identity("turnId")?;
        let item_id = identity("itemId")?;
        // Native request counters restart with the process. Durable Host
        // attention must not collide with a prior turn using the same counter.
        let key = derived_host_id("codex-interaction", &[&thread_id, &turn_id, &wire_key]);
        let mut questions = Vec::new();
        let decisions = if method == "item/tool/requestUserInput" {
            questions = serde_json::from_value(p["questions"].clone())
                .map_err(|_| "Codex 提问格式不符合固定协议")?;
            let mut ids = HashSet::new();
            if questions.is_empty()
                || questions.len() > 16
                || questions.iter().any(|q: &Question| {
                    q.id.is_empty()
                        || q.id.len() > 128
                        || !ids.insert(q.id.clone())
                        || q.question.is_empty()
                        || q.options.as_ref().is_some_and(|options| {
                            options.len() > 32 || options.iter().any(|o| o.label.is_empty())
                        })
                })
            {
                return Err("Codex 提问数量、身份或选项无效".into());
            }
            Vec::new()
        } else if method == "item/fileChange/requestApproval" {
            // Fixed official FileChangeApprovalDecision, not grantRoot inference.
            vec![
                json!("accept"),
                json!("acceptForSession"),
                json!("decline"),
                json!("cancel"),
            ]
        } else if let Some(available) = p.get("availableDecisions").filter(|v| !v.is_null()) {
            let choices = available.as_array().ok_or("Codex 审批选项格式无效")?;
            if choices.is_empty()
                || choices.len() > 32
                || choices.iter().any(|v| !valid_command_decision(v))
            {
                return Err("Codex 返回了尚未支持的审批选项；未自动批准".into());
            }
            choices.clone()
        } else {
            // 0.143.0 README allows the stable enum when availableDecisions is
            // omitted. Persistent rules only reproduce a native proposal.
            let mut choices = vec![
                json!("accept"),
                json!("acceptForSession"),
                json!("decline"),
                json!("cancel"),
            ];
            if let Some(amendment) = p
                .get("proposedExecpolicyAmendment")
                .filter(|v| !v.is_null())
            {
                let choice =
                    json!({"acceptWithExecpolicyAmendment":{"execpolicy_amendment":amendment}});
                if !valid_command_decision(&choice) {
                    return Err("Codex 命令规则建议格式无效".into());
                }
                choices.push(choice);
            }
            if let Some(rules) = p
                .get("proposedNetworkPolicyAmendments")
                .and_then(Value::as_array)
            {
                for rule in rules {
                    let choice =
                        json!({"applyNetworkPolicyAmendment":{"network_policy_amendment":rule}});
                    if !valid_command_decision(&choice) {
                        return Err("Codex 网络规则建议格式无效".into());
                    }
                    choices.push(choice);
                }
            }
            choices
        };
        Ok(Self {
            key,
            thread_id,
            turn_id,
            item_id,
            method,
            decisions,
            questions,
            native_request,
        })
    }

    pub(crate) fn response(&self, reply: CodexInteractionReply) -> Result<Value, String> {
        match reply {
            CodexInteractionReply::Decision { decision } if self.decisions.contains(&decision) => {
                Ok(json!({"decision":decision}))
            }
            CodexInteractionReply::Answers { answers } if !self.questions.is_empty() => {
                if answers.len() != self.questions.len() {
                    return Err("请回答此原生请求中的全部问题".into());
                }
                for question in &self.questions {
                    let values = answers
                        .get(&question.id)
                        .ok_or("回答与原生问题身份不匹配")?;
                    if values.is_empty()
                        || values.len() > 32
                        || values
                            .iter()
                            .any(|v| v.trim().is_empty() || v.len() > 16 * 1024)
                    {
                        return Err("Codex 回答为空或超过限制".into());
                    }
                    if !question.is_other
                        && question.options.as_ref().is_some_and(|opts| {
                            !opts.is_empty()
                                && values.iter().any(|v| !opts.iter().any(|o| &o.label == v))
                        })
                    {
                        return Err("回答不属于此问题的原生选项".into());
                    }
                }
                let answers: BTreeMap<_, _> = answers
                    .into_iter()
                    .map(|(id, values)| (id, json!({"answers":values})))
                    .collect();
                Ok(json!({"answers":answers}))
            }
            _ => Err("回复不属于此 Codex 原生请求的可用选项".into()),
        }
    }
}

fn valid_command_decision(value: &Value) -> bool {
    if let Some(value) = value.as_str() {
        return matches!(value, "accept" | "acceptForSession" | "decline" | "cancel");
    }
    let Some(outer) = value.as_object().filter(|o| o.len() == 1) else {
        return false;
    };
    if let Some(body) = outer
        .get("acceptWithExecpolicyAmendment")
        .and_then(Value::as_object)
        .filter(|o| o.len() == 1)
    {
        return body
            .get("execpolicy_amendment")
            .and_then(Value::as_array)
            .is_some_and(|a| {
                !a.is_empty()
                    && a.len() <= 128
                    && a.iter().all(|v| v.as_str().is_some_and(|s| !s.is_empty()))
            });
    }
    outer
        .get("applyNetworkPolicyAmendment")
        .and_then(Value::as_object)
        .filter(|o| o.len() == 1)
        .and_then(|o| o.get("network_policy_amendment"))
        .and_then(Value::as_object)
        .filter(|o| o.len() == 2)
        .is_some_and(|o| {
            o.get("host")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty())
                && matches!(
                    o.get("action").and_then(Value::as_str),
                    Some("allow" | "deny")
                )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_choices_cannot_be_expanded_or_rewritten() {
        let r = CodexInteraction::parse(
            json!({"id":7,"method":"item/commandExecution/requestApproval","params":{
            "threadId":"t","turnId":"turn","itemId":"i","availableDecisions":["accept","cancel"]}}),
        )
        .unwrap();
        assert!(
            r.response(CodexInteractionReply::Decision {
                decision: json!("decline")
            })
            .is_err()
        );
        assert_eq!(
            r.response(CodexInteractionReply::Decision {
                decision: json!("accept")
            })
            .unwrap(),
            json!({"decision":"accept"})
        );
        assert_ne!(
            request_key(&json!(7)).unwrap(),
            request_key(&json!("7")).unwrap()
        );
    }
    #[test]
    fn questions_require_exact_ids_and_native_choices() {
        let r = CodexInteraction::parse(json!({"id":"q","method":"item/tool/requestUserInput","params":{
            "threadId":"t","turnId":"turn","itemId":"i","questions":[{"id":"direction","header":"Route","question":"Where?","options":[{"label":"North","description":"N"}]}]}})).unwrap();
        for (id, answer) in [("different", "North"), ("direction", "South")] {
            assert!(
                r.response(CodexInteractionReply::Answers {
                    answers: BTreeMap::from([(id.into(), vec![answer.into()])])
                })
                .is_err()
            );
        }
        assert_eq!(
            r.response(CodexInteractionReply::Answers {
                answers: BTreeMap::from([("direction".into(), vec!["North".into()])])
            })
            .unwrap(),
            json!({"answers":{"direction":{"answers":["North"]}}})
        );
    }
}
