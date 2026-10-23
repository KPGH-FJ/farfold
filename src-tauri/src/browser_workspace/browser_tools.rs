//! Fixed operations on an observed page. No selectors, scripts, URLs or file
//! names from the caller become browser authority.
use super::{FixedPageReadScope, native};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tauri::AppHandle;

const CONTROL_UNCONFIRMED: &str = "网页操作结果未确认，请查看页面后重新观察；不要自动重试";

fn append_control_diagnostics(source: &Value, result: &mut Value) {
    for (field, allowed) in [
        (
            "guardClass",
            &[
                "deadline",
                "observation_missing",
                "observation_id",
                "navigation",
                "url",
                "version",
                "expired",
            ][..],
        ),
        (
            "observationInvalidatedBy",
            &[
                "mutation",
                "input",
                "change",
                "scroll",
                "resize",
                "shadow_root",
            ][..],
        ),
    ] {
        if let Some(class) = allowed
            .iter()
            .copied()
            .find(|class| source.get(field).and_then(Value::as_str) == Some(*class))
        {
            result[field] = json!(class);
        }
    }
    if let Some(age) = source
        .get("observationAgeMs")
        .and_then(Value::as_u64)
        .filter(|age| *age <= 300_000)
    {
        result["observationAgeMs"] = json!(age);
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ToolFailure {
    // Created only by checks before the native action entry point. The reason
    // comes from fixed local checks, never a page, node label or input value.
    ControlNotApplied(String),
    // Entering the native action path does not prove dispatch or its absence.
    Unconfirmed,
}

impl From<String> for ToolFailure {
    fn from(_: String) -> Self {
        Self::Unconfirmed
    }
}

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
    pub(crate) fn preflight_control(
        &self,
        request: &ToolRequest,
    ) -> Result<ControlReview, ToolFailure> {
        self.review_control(request)
            .map_err(ToolFailure::ControlNotApplied)
    }

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
    ) -> Result<Value, ToolFailure> {
        match request {
            ToolRequest::Read => self
                .read(app)
                .await
                .and_then(|p| serde_json::to_value(p).map_err(|_| "网页读取未完成".into()))
                .map_err(ToolFailure::from),
            ToolRequest::Observe { screenshot } => {
                self.with_valid(|| Ok(()))?;
                // Starting a new observation always invalidates the older refs,
                // including when the new observation fails or is cancelled.
                *self
                    .observation
                    .lock()
                    .map_err(|_| ToolFailure::Unconfirmed)? = None;
                let raw = native::observe(app, self.clone(), screenshot).await?;
                self.complete_observation_for_request(&raw, screenshot)
                    .map_err(ToolFailure::from)
            }
            request => {
                self.preflight_control(&request)?;
                let (id, reference, kind) = request.target().expect("control request");
                let action = match &request {
                    ToolRequest::Input { text, .. } => {
                        native::NativeAction::Input { text: text.clone() }
                    }
                    _ => native::NativeAction::Click,
                };
                // Consume before dispatch, even if dispatch or its result fails.
                *self
                    .observation
                    .lock()
                    .map_err(|_| ToolFailure::ControlNotApplied("网页观察已失效".into()))? = None;
                let raw = native::act(
                    app,
                    self.clone(),
                    id.to_owned(),
                    reference.to_owned(),
                    action,
                )
                .await
                .map_err(|_| ToolFailure::Unconfirmed)?;
                self.complete_control(id, kind, &raw)
                    .map_err(ToolFailure::from)
            }
        }
    }

    // Once handed to the native page, withdrawal or a missing receipt does not
    // prove that no effect happened. Preserve this meaning even on gate errors.
    fn complete_control(&self, id: &str, kind: &str, raw: &str) -> Result<Value, String> {
        if raw.len() > 16_384 {
            return Err(CONTROL_UNCONFIRMED.into());
        }
        let value: Value = serde_json::from_str(raw).map_err(|_| CONTROL_UNCONFIRMED)?;
        if value.get("sharingInvalidated").and_then(Value::as_bool) == Some(true) {
            self.revoke();
            return Err(CONTROL_UNCONFIRMED.into());
        }
        self.with_valid(|| {
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
            let mut result = json!({
                "applied":applied,
                "outcome":outcome,
                "pageChanged":value.get("pageChanged").and_then(Value::as_bool).unwrap_or(true),
                "navigationChanged":value.get("navigationChanged").and_then(Value::as_bool).unwrap_or(true),
                "observationId":id,
                "reason":value.get("reason").and_then(Value::as_str).filter(|s| s.chars().count()<=256),
                "next":"重新观察页面后检查结果；事件已交付不代表网站操作成功，结果未知时不要自动重试。"
            });
            if kind == "input" {
                // This enum compares only the just-approved input at the reply
                // instant. It is not proof of submission or a website result.
                let verification = if outcome == "dispatched"
                    && applied == true
                    && result["navigationChanged"] == false
                {
                    match value.get("verification").and_then(Value::as_str) {
                        Some("matched") => "matched",
                        Some("mismatched") => "mismatched",
                        _ => "unverified",
                    }
                } else {
                    "unverified"
                };
                result["verification"] = json!(verification);
            }
            append_control_diagnostics(&value, &mut result);
            Ok(result)
        })
        .map_err(|_| CONTROL_UNCONFIRMED.to_owned())
    }

    #[cfg(test)]
    fn complete_observation(&self, raw: &str) -> Result<Value, String> {
        self.complete_observation_for_request(raw, false)
    }

    fn complete_observation_for_request(
        &self,
        raw: &str,
        screenshot_requested: bool,
    ) -> Result<Value, String> {
        self.with_valid(|| Ok(()))?;
        if raw.len() > 550_000 {
            return Err("网页观察内容过大".into());
        }
        let value: Value = serde_json::from_str(raw).map_err(|_| "网页观察未完成")?;
        if value.get("blocked").and_then(Value::as_bool) != Some(false) {
            self.revoke();
            return Err("页面含受保护的输入，已停止共享".into());
        }
        let screenshot = super::screenshot::checked(&value["screenshot"], screenshot_requested);
        self.with_valid(|| {
            let url = bounded(&value, "url", 8192)?;
            if !self.matches_url(&url) { return Err("网页已变化，请重新确认".into()); }
            let id = bounded(&value, "observationId", 128)?;
            if id.is_empty() { return Err("网页观察未完成".into()); }
            let nodes: Vec<Node> = serde_json::from_value(value.get("nodes").cloned().ok_or("网页观察未完成")?).map_err(|_| "网页位置不可读取")?;
            if nodes.len() > 256 || nodes.iter().any(|n| n.reference.is_empty() || n.reference.len() > 128 || n.tag.len() > 32 || n.role.len() > 64 || n.label.chars().count() > 160 || n.actions.len() > 2 || n.actions.iter().any(|a| !matches!(a.as_str(), "click" | "input")) || [n.bounds.x,n.bounds.y,n.bounds.width,n.bounds.height].iter().any(|n| !n.is_finite())) {
                return Err("网页位置不可读取".into());
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
            scope.complete_control("control", "click", &raw).unwrap()["applied"],
            true
        );
        scope.revoke();
        assert_eq!(
            scope
                .complete_control("control", "click", &raw)
                .unwrap_err(),
            CONTROL_UNCONFIRMED
        );
        assert_eq!(
            scope
                .complete_control("control", "click", "invalid receipt")
                .unwrap_err(),
            CONTROL_UNCONFIRMED
        );
    }
    #[test]
    fn control_diagnostics_pass_only_fixed_classes_and_bounded_integer_age() {
        let (scope, _) = sharing_scope_fixture("agent:/fixture:control-diagnostics", "page");
        let raw = json!({"applied":false,"outcome":"rejected","reason":"页面或操作目标已变化，请重新观察","guardClass":"observation_missing","observationAgeMs":1234,"observationInvalidatedBy":"resize"}).to_string();
        let reply = scope.complete_control("control", "click", &raw).unwrap();
        assert_eq!(reply["applied"], false);
        assert_eq!(reply["outcome"], "rejected");
        assert_eq!(reply["guardClass"], "observation_missing");
        assert_eq!(reply["observationAgeMs"], 1234);
        assert_eq!(reply["observationInvalidatedBy"], "resize");
    }
    #[test]
    fn control_diagnostics_reject_unknown_strings_objects_and_invalid_ages() {
        let (scope, _) = sharing_scope_fixture("agent:/fixture:control-diagnostics", "page");
        for age in [
            json!(-1),
            json!(300001),
            json!(1.5),
            json!("1234"),
            json!({"private":"payload"}),
        ] {
            let raw = json!({"applied":false,"outcome":"rejected","guardClass":"expired PRIVATE_PAYLOAD","observationAgeMs":age,"observationInvalidatedBy":{"private":"payload"},"unknown":{"private":"payload"}}).to_string();
            let reply = scope.complete_control("control", "click", &raw).unwrap();
            for key in [
                "guardClass",
                "observationAgeMs",
                "observationInvalidatedBy",
                "unknown",
            ] {
                assert!(reply.get(key).is_none(), "untrusted {key} was forwarded");
            }
            assert!(!reply.to_string().contains("PRIVATE_PAYLOAD"));
        }
        let raw = json!({"applied":false,"outcome":"rejected","guardClass":{"private":"payload"},"observationInvalidatedBy":"resize PRIVATE_PAYLOAD"}).to_string();
        let reply = scope.complete_control("control", "click", &raw).unwrap();
        assert!(reply.get("guardClass").is_none());
        assert!(reply.get("observationInvalidatedBy").is_none());
    }
    #[test]
    fn valid_control_diagnostics_never_turn_unknown_into_not_applied() {
        let (scope, _) = sharing_scope_fixture("agent:/fixture:control-diagnostics", "page");
        let raw = json!({"applied":false,"outcome":"unknown","guardClass":"expired","observationAgeMs":300000,"observationInvalidatedBy":"mutation"}).to_string();
        let reply = scope.complete_control("control", "click", &raw).unwrap();
        assert_eq!(reply["applied"], Value::Null);
        assert_eq!(reply["outcome"], "unknown");
        assert_eq!(reply["guardClass"], "expired");
        assert_eq!(reply["observationAgeMs"], 300000);
    }
    #[test]
    fn input_verification_exports_only_a_fixed_comparison_not_field_contents() {
        let (scope, _) = sharing_scope_fixture("agent:/fixture:input-verification", "page");
        for verification in ["matched", "mismatched", "unverified"] {
            let raw = json!({"applied":true,"outcome":"dispatched","navigationChanged":false,"verification":verification,"actualValue":"PRIVATE_CURRENT_FIELD","oldValue":"PRIVATE_OLD_FIELD","inputText":"PRIVATE_APPROVED_TEXT"}).to_string();
            let reply = scope.complete_control("control", "input", &raw).unwrap();
            assert_eq!(reply["verification"], verification);
            assert_eq!(reply["outcome"], "dispatched");
            assert_eq!(reply["applied"], true);
            assert!(!reply.to_string().contains("PRIVATE_"));
        }
    }
    #[test]
    fn unconfirmed_input_never_trusts_a_native_matched_claim() {
        let (scope, _) = sharing_scope_fixture("agent:/fixture:input-verification", "page");
        for raw in [
            json!({"applied":true,"outcome":"dispatched","navigationChanged":true,"verification":"matched"}),
            json!({"applied":false,"outcome":"dispatched","navigationChanged":false,"verification":"matched"}),
            json!({"applied":false,"outcome":"rejected","navigationChanged":false,"verification":"matched"}),
            json!({"applied":true,"outcome":"unknown","navigationChanged":false,"verification":"matched"}),
            json!({"applied":true,"outcome":"dispatched","navigationChanged":false}),
            json!({"applied":true,"outcome":"dispatched","navigationChanged":false,"verification":"matched PRIVATE_FIELD"}),
            json!({"applied":true,"outcome":"dispatched","navigationChanged":false,"verification":{"private":"PRIVATE_FIELD"}}),
        ] {
            let reply = scope
                .complete_control("control", "input", &raw.to_string())
                .unwrap();
            assert_eq!(reply["verification"], "unverified");
            if raw["outcome"] == "unknown" {
                assert_eq!(reply["applied"], Value::Null);
                assert_eq!(reply["outcome"], "unknown");
            }
            assert!(!reply.to_string().contains("PRIVATE_"));
        }
    }
    #[test]
    fn click_and_withdrawn_input_never_forward_a_verification_or_value() {
        let (scope, _) = sharing_scope_fixture("agent:/fixture:input-verification", "page");
        let raw = json!({"applied":true,"outcome":"dispatched","navigationChanged":false,"verification":"matched","actualValue":"PRIVATE_FIELD"}).to_string();
        let click = scope.complete_control("control", "click", &raw).unwrap();
        assert!(click.get("verification").is_none());
        assert!(!click.to_string().contains("PRIVATE_"));
        let one = scope.one_shot().unwrap();
        one.cancel_action();
        assert_eq!(
            one.complete_control("control", "input", &raw).unwrap_err(),
            CONTROL_UNCONFIRMED
        );
        scope.revoke();
        assert_eq!(
            scope
                .complete_control("control", "input", &raw)
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
    fn native_png_requires_an_explicit_request_and_a_still_live_page_grant() {
        let (scope, _) = sharing_scope_fixture("agent:/fixture:screenshot", "page");
        let mut value: Value =
            serde_json::from_str(include_str!("fixtures/native-directory-observation.json"))
                .unwrap();
        value["url"] = json!("https://www.rust-lang.org/");
        let raw = value.to_string();
        let image = scope.complete_observation_for_request(&raw, true).unwrap();
        assert_eq!(image["screenshot"]["status"], "captured");
        assert_eq!(image["screenshot"]["data"], value["screenshot"]["data"]);
        assert!(
            scope.complete_observation_for_request(&raw, false).unwrap()["screenshot"]
                .get("data")
                .is_none()
        );
        scope.revoke();
        assert!(scope.complete_observation_for_request(&raw, true).is_err());
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
    fn preflight_failures_are_typed_before_the_action_entry_point() {
        for failure in ["expired", "wrong-node", "wrong-observation", "withdrawn"] {
            let (scope, _) = sharing_scope_fixture("agent:/fixture:preflight", "page");
            observed(&scope);
            let mut click = ToolRequest::Click {
                observation_id: "observation-a".into(),
                node_ref: "node-a".into(),
            };
            match failure {
                "expired" => {
                    scope.observation.lock().unwrap().as_mut().unwrap().at =
                        Instant::now() - Duration::from_secs(31);
                }
                "wrong-node" => {
                    if let ToolRequest::Click { node_ref, .. } = &mut click {
                        *node_ref = "other-node".into();
                    }
                }
                "wrong-observation" => {
                    if let ToolRequest::Click { observation_id, .. } = &mut click {
                        *observation_id = "other-observation".into();
                    }
                }
                "withdrawn" => scope.revoke(),
                _ => unreachable!(),
            }
            let error = scope
                .preflight_control(&click)
                .err()
                .expect("preflight fails");
            assert!(matches!(error, ToolFailure::ControlNotApplied(_)));
            assert!(
                scope.observation.lock().unwrap().is_some(),
                "a failed preflight does not consume an observation or reach dispatch"
            );
        }
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

    #[test]
    fn invalidated_control_retires_the_original_grant_and_all_captured_requests() {
        for (outcome, applied) in [("rejected", false), ("dispatched", true)] {
            let (scope, _) = sharing_scope_fixture("agent:/fixture:retirement", "page");
            let public_observation = observed(&scope);
            let queued = scope.request_scope();
            let approved = scope.one_shot().unwrap();
            let receipt = json!({"outcome":outcome,"applied":applied,"verification":"unverified","sharingInvalidated":true}).to_string();
            assert_eq!(
                approved
                    .complete_control("control", "input", &receipt)
                    .unwrap_err(),
                CONTROL_UNCONFIRMED
            );
            assert!(!scope.is_valid());
            assert!(!queued.is_valid());
            assert!(!approved.is_valid());
            assert!(scope.complete_observation(&public_observation).is_err());
            assert!(queued.with_valid(|| Ok(())).is_err());

            let (independent, _) = sharing_scope_fixture("agent:/fixture:other", "other");
            observed(&independent);
            assert!(independent.is_valid());
        }
    }

    #[test]
    fn ordinary_control_results_do_not_retire_the_read_grant() {
        for signal in [Value::Null, json!(false), json!("true")] {
            let (scope, _) = sharing_scope_fixture("agent:/fixture:ordinary", "page");
            observed(&scope);
            let receipt = json!({"outcome":"rejected","applied":false,"sharingInvalidated":signal})
                .to_string();
            assert_eq!(
                scope
                    .complete_control("control", "input", &receipt)
                    .unwrap()["outcome"],
                "rejected"
            );
            assert!(scope.is_valid());
        }
    }
}
