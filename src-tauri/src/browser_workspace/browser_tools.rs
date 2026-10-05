//! Fixed operations on an observed page. No selectors, scripts, URLs or file
//! names from the caller become browser authority.
use super::{FixedPageReadScope, native};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tauri::AppHandle;

const CONTROL_UNCONFIRMED: &str = "网页操作结果未确认，请查看页面后重新观察；不要自动重试";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ToolRequest {
    Read,
    Observe {
        screenshot: bool,
    },
    Click {
        observation_id: String,
        node_ref: String,
    },
    Input {
        observation_id: String,
        node_ref: String,
        text: String,
    },
}

impl ToolRequest {
    pub(crate) fn control(&self) -> bool {
        matches!(self, Self::Click { .. } | Self::Input { .. })
    }

    fn target(&self) -> Option<(&str, &str, &'static str)> {
        match self {
            Self::Click {
                observation_id,
                node_ref,
            } => Some((observation_id, node_ref, "click")),
            Self::Input {
                observation_id,
                node_ref,
                ..
            } => Some((observation_id, node_ref, "input")),
            _ => None,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ControlReview {
    pub kind: &'static str,
    pub target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

pub(super) struct Observation {
    id: String,
    at: Instant,
    nodes: Vec<Node>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Node {
    #[serde(rename = "ref")]
    reference: String,
    tag: String,
    role: String,
    label: String,
    actions: Vec<String>,
    bounds: Bounds,
}
#[derive(Deserialize, Serialize)]
struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn bounded(value: &Value, key: &str, max: usize) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| text.chars().count() <= max && !text.contains('\0'))
        .map(str::to_owned)
        .ok_or_else(|| "网页观察结果无效，请重新读取".into())
}

impl FixedPageReadScope {
    pub(crate) fn review_control(&self, request: &ToolRequest) -> Result<ControlReview, String> {
        self.with_valid(|| {
            if matches!(request, ToolRequest::Observe { screenshot: true }) {
                return Ok(ControlReview {
                    kind: "screenshot",
                    target: "当前网页可见区域".into(),
                    text: None,
                });
            }
            let (id, reference, kind) = request.target().ok_or("此请求不需要操作许可")?;
            let observation = self.observation.lock().map_err(|_| "网页观察已失效")?;
            let observation = observation
                .as_ref()
                .filter(|o| o.id == id && o.at.elapsed() < Duration::from_secs(30))
                .ok_or("网页观察已过期，请重新观察后再操作")?;
            let node = observation
                .nodes
                .iter()
                .find(|n| n.reference == reference && n.actions.iter().any(|a| a == kind))
                .ok_or("此位置不可执行请求的操作，请重新观察")?;
            let text = match request {
                ToolRequest::Input { text, .. } => Some(text.clone()),
                _ => None,
            };
            Ok(ControlReview {
                kind,
                target: node.label.clone(),
                text,
            })
        })
    }

    pub(crate) async fn tool(
        &self,
        app: &AppHandle,
        request: ToolRequest,
    ) -> Result<Value, String> {
        match request {
            ToolRequest::Read => self
                .read(app)
                .await
                .and_then(|p| serde_json::to_value(p).map_err(|_| "网页读取未完成".into())),
            ToolRequest::Observe { screenshot } => {
                self.with_valid(|| Ok(()))?;
                // Starting a new observation always invalidates the older refs,
                // including when the new observation fails or is cancelled.
                *self.observation.lock().map_err(|_| "网页观察已失效")? = None;
                // The current public WebKit surface cannot prove that closed
                // shadow roots contain no protected input. A separate consent
                // is not a substitute for that product boundary. Keep pixel
                // capture internal to controlled native verification.
                let raw = native::observe(app, self.clone(), false).await?;
                let raw = if screenshot {
                    let mut value: Value =
                        serde_json::from_str(&raw).map_err(|_| "网页观察未完成")?;
                    value["screenshot"] = json!({"status":"unavailable","reason":"当前页面受保护的输入无法可靠核实，暂不提供截图；可以继续读取文字和位置。"});
                    value.to_string()
                } else {
                    raw
                };
                self.complete_observation(&raw)
            }
            request => {
                self.review_control(&request)?;
                let (id, reference, _) = request.target().expect("control request");
                let action = match &request {
                    ToolRequest::Input { text, .. } => {
                        native::NativeAction::Input { text: text.clone() }
                    }
                    _ => native::NativeAction::Click,
                };
                // Consume before dispatch, even if dispatch or its result fails.
                *self.observation.lock().map_err(|_| "网页观察已失效")? = None;
                let raw = native::act(
                    app,
                    self.clone(),
                    id.to_owned(),
                    reference.to_owned(),
                    action,
                )
                .await
                .map_err(|_| CONTROL_UNCONFIRMED.to_owned())?;
                self.complete_control(id, &raw)
            }
        }
    }

    // Once handed to the native page, withdrawal or a missing receipt does not
    // prove that no effect happened. Preserve this meaning even on gate errors.
    fn complete_control(&self, id: &str, raw: &str) -> Result<Value, String> {
        self.with_valid(|| {
            if raw.len() > 16_384 {
                return Err(CONTROL_UNCONFIRMED.into());
            }
            let value: Value = serde_json::from_str(raw).map_err(|_| CONTROL_UNCONFIRMED)?;
            let outcome = value
                .get("outcome")
                .and_then(Value::as_str)
                .filter(|s| matches!(*s, "dispatched" | "rejected" | "unknown"))
                .ok_or(CONTROL_UNCONFIRMED)?;
            let applied = if outcome == "unknown" {
                Value::Null
            } else {
                Value::Bool(
                    value.get("applied").and_then(Value::as_bool).ok_or(CONTROL_UNCONFIRMED)?,
                )
            };
            Ok(json!({
                "applied":applied,
                "outcome":outcome,
                "pageChanged":value.get("pageChanged").and_then(Value::as_bool).unwrap_or(true),
                "navigationChanged":value.get("navigationChanged").and_then(Value::as_bool).unwrap_or(true),
                "observationId":id,
                "reason":value.get("reason").and_then(Value::as_str).filter(|s| s.chars().count()<=256),
                "next":"重新观察页面后检查结果；事件已交付不代表网站操作成功，结果未知时不要自动重试。"
            }))
        })
        .map_err(|_| CONTROL_UNCONFIRMED.to_owned())
    }

    fn complete_observation(&self, raw: &str) -> Result<Value, String> {
        if raw.len() > 550_000 {
            return Err("网页观察内容过大".into());
        }
        let value: Value = serde_json::from_str(raw).map_err(|_| "网页观察未完成")?;
        if value.get("blocked").and_then(Value::as_bool) != Some(false) {
            self.revoke();
            return Err("页面含受保护的输入，已停止共享".into());
        }
        self.with_valid(|| {
            let url = bounded(&value, "url", 8192)?;
            if !self.matches_url(&url) { return Err("网页已变化，请重新确认".into()); }
            let id = bounded(&value, "observationId", 128)?;
            if id.is_empty() { return Err("网页观察未完成".into()); }
            let nodes: Vec<Node> = serde_json::from_value(value.get("nodes").cloned().ok_or("网页观察未完成")?).map_err(|_| "网页位置不可读取")?;
            if nodes.len() > 256 || nodes.iter().any(|n| n.reference.is_empty() || n.reference.len() > 128 || n.tag.len() > 32 || n.role.len() > 64 || n.label.chars().count() > 160 || n.actions.len() > 2 || n.actions.iter().any(|a| !matches!(a.as_str(), "click" | "input")) || [n.bounds.x,n.bounds.y,n.bounds.width,n.bounds.height].iter().any(|n| !n.is_finite())) {
                return Err("网页位置不可读取".into());
            }
            let mut screenshot = json!({"status":"unavailable","reason":value.pointer("/screenshot/reason").and_then(Value::as_str).filter(|s|s.chars().count()<=256)});
            if value.pointer("/screenshot/status").and_then(Value::as_str) == Some("captured") {
                screenshot = json!({"status":"unavailable","reason":"当前页面受保护的输入无法可靠核实，暂不提供截图。"});
            }
            let result = json!({"url":url,"title":bounded(&value,"title",512)?,"text":bounded(&value,"text",65536)?,"observationId":id,"documentVersion":bounded(&value,"documentVersion",180)?,"nodes":nodes,"truncated":value.get("truncated").and_then(Value::as_bool).unwrap_or(true),"screenshot":screenshot});
            *self.observation.lock().map_err(|_| "网页观察已失效")? = Some(Observation { id, at:Instant::now(), nodes });
            Ok(result)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser_workspace::sharing_scope_fixture;
    fn observed(scope: &FixedPageReadScope) -> String {
        let raw = json!({"blocked":false,"url":"https://www.rust-lang.org/","title":"Example","text":"safe body","observationId":"observation-a","documentVersion":"document-a:1","nodes":[{"ref":"node-a","tag":"button","role":"button","label":"Apply","actions":["click"],"bounds":{"x":1,"y":2,"width":10,"height":20}}],"screenshot":{"status":"unavailable"}}).to_string();
        scope.complete_observation(&raw).unwrap();
        raw
    }
    #[test]
    fn a_withdrawn_control_receipt_never_claims_that_the_action_was_not_applied() {
        let (scope, _) = sharing_scope_fixture("agent:/fixture:control-receipt", "page");
        let raw = json!({"applied":true,"outcome":"dispatched"}).to_string();
        assert_eq!(
            scope.complete_control("control", &raw).unwrap()["applied"],
            true
        );
        scope.revoke();
        assert_eq!(
            scope.complete_control("control", &raw).unwrap_err(),
            CONTROL_UNCONFIRMED
        );
        assert_eq!(
            scope
                .complete_control("control", "invalid receipt")
                .unwrap_err(),
            CONTROL_UNCONFIRMED
        );
    }
    #[test]
    fn actual_native_fixture_satisfies_the_rust_and_mcp_receipt_contract() {
        let (scope, _) = sharing_scope_fixture("agent:/fixture:native", "page");
        let mut value: Value =
            serde_json::from_str(include_str!("fixtures/native-directory-observation.json"))
                .unwrap();
        // Scope ownership is tested separately; keep all real native receipt
        // fields and image bytes, substituting only this unit fixture's URL.
        value["url"] = json!("https://www.rust-lang.org/");
        let accepted = scope.complete_observation(&value.to_string()).unwrap();
        assert_eq!(accepted["screenshot"]["status"], "unavailable");
        assert!(accepted["documentVersion"].is_string());
        assert!(accepted["screenshot"].get("data").is_none());
    }
    #[test]
    fn scope_withdrawal_reaches_one_shot_but_cancel_does_not_revoke_reading() {
        let (scope, _) = sharing_scope_fixture("agent:/fixture:native", "page");
        let one = scope.one_shot().unwrap();
        one.cancel_action();
        assert!(!one.is_valid());
        assert!(scope.is_valid());
        let other = scope.one_shot().unwrap();
        scope.revoke();
        assert!(!other.is_valid());
    }
    #[test]
    fn operation_uses_only_latest_matching_observed_node_and_capability() {
        let (scope, _) = sharing_scope_fixture("agent:/fixture:native", "page");
        observed(&scope);
        let click = ToolRequest::Click {
            observation_id: "observation-a".into(),
            node_ref: "node-a".into(),
        };
        assert_eq!(scope.review_control(&click).unwrap().target, "Apply");
        assert!(
            scope
                .review_control(&ToolRequest::Input {
                    observation_id: "observation-a".into(),
                    node_ref: "node-a".into(),
                    text: "x".into()
                })
                .is_err()
        );
        scope.observation.lock().unwrap().as_mut().unwrap().at =
            Instant::now() - Duration::from_secs(31);
        assert!(scope.review_control(&click).is_err());
    }
    #[test]
    fn malformed_or_sensitive_results_cannot_create_a_node_authority() {
        let (scope, _) = sharing_scope_fixture("agent:/fixture:native", "page");
        let raw = observed(&scope);
        let mut value: Value = serde_json::from_str(&raw).unwrap();
        value["nodes"][0]["actions"] = json!(["evaluate"]);
        assert!(scope.complete_observation(&value.to_string()).is_err());
        value["blocked"] = json!(true);
        assert!(scope.complete_observation(&value.to_string()).is_err());
        assert!(!scope.is_valid());
    }
}
