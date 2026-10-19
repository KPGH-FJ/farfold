//! One configuration view for current config options and the older model surface.
//! The original Agent envelopes are still forwarded unchanged by the pump.
use agent_client_protocol::schema::v1::SetSessionConfigOptionRequest;
use agent_client_protocol::{Agent, ConnectionTo, Dispatch, UntypedMessage};
use serde_json::{Value, json};

use super::{
    operations::Operation,
    pump::{describe_acp_error, parse_config_value},
};

pub(crate) const LEGACY_MODEL_ID: &str = "__farfold_legacy_model";
const UNCONFIRMED: &str = "Agent 未确认所选模型，请检查后重试";

#[derive(Clone, Default)]
pub(crate) struct SessionConfig {
    options: Option<Value>,
    models: Option<Value>,
    revision: u64,
    options_revision: u64,
    invalid_options_revision: u64,
    model_update: Option<(u64, Option<String>)>,
}

#[derive(Clone)]
pub(crate) struct ConfigRequest {
    id: String,
    value: Value,
    legacy: bool,
    revision: u64,
}

impl SessionConfig {
    pub(crate) fn from_response(response: &Value) -> Self {
        Self {
            options: response.get("configOptions").cloned(),
            models: response.get("models").cloned(),
            ..Self::default()
        }
    }

    fn legacy_option(&self) -> Option<Value> {
        if self.has_invalid_options() {
            return None;
        }
        let options = self.options.as_ref().and_then(Value::as_array);
        if options.is_some_and(|options| {
            options.iter().any(|option| {
                option["category"] == "model"
                    || option["id"] == LEGACY_MODEL_ID
                    || (option.get("category").is_none_or(Value::is_null)
                        && option["id"] == "model")
            })
        }) {
            return None;
        }
        let models = self.models.as_ref()?;
        let entries = models.get("availableModels")?.as_array()?;
        if entries.is_empty() {
            return None;
        }
        let mut ids = std::collections::BTreeSet::new();
        let choices = entries
            .iter()
            .map(|entry| {
                let id = entry.get("modelId")?.as_str().filter(|id| !id.is_empty())?;
                if !ids.insert(id) {
                    return None;
                }
                let name = entry.get("name")?.as_str()?;
                Some(json!({"value":id, "name":name, "description":entry.get("description")}))
            })
            .collect::<Option<Vec<_>>>()?;
        Some(
            json!({"id":LEGACY_MODEL_ID, "name":"模型", "category":"model", "type":"select", "currentValue":models.get("currentModelId"), "options":choices}),
        )
    }

    pub(crate) fn options(&self) -> Option<Value> {
        if self.has_invalid_options() {
            return self.options.clone();
        }
        let legacy = self.legacy_option();
        if self.options.is_none() && legacy.is_none() {
            return None;
        }
        let mut options = self
            .options
            .as_ref()
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if let Some(legacy) = legacy {
            options.push(legacy);
        }
        Some(Value::Array(options))
    }

    pub(crate) fn has_invalid_options(&self) -> bool {
        self.options
            .as_ref()
            .is_some_and(|options| !options.is_array())
    }

    /// Preserve the actual declaration: an old models view is not modern config.
    pub(crate) fn modern_options(&self) -> Option<&Value> {
        self.options.as_ref()
    }

    pub(crate) fn prepare(&self, id: &str, value: &Value) -> Result<ConfigRequest, String> {
        if self.has_invalid_options() {
            return Err(UNCONFIRMED.into());
        }
        let legacy = id == LEGACY_MODEL_ID;
        if legacy {
            let option = self.legacy_option().ok_or(UNCONFIRMED)?;
            if !value.is_string()
                || !option["options"]
                    .as_array()
                    .is_some_and(|choices| choices.iter().any(|choice| choice["value"] == *value))
            {
                return Err(UNCONFIRMED.into());
            }
        } else {
            parse_config_value(value)?;
        }
        Ok(ConfigRequest {
            id: id.to_owned(),
            value: value.clone(),
            legacy,
            revision: self.revision,
        })
    }

    /// Only the selected wire method determines its receipt contract. A failed
    /// modern setter is never retried as an older setter.
    pub(crate) fn complete(
        &mut self,
        request: &ConfigRequest,
        reply: Value,
    ) -> Result<Value, String> {
        // An absent initial declaration is allowed. A notification declaring a
        // missing/null/non-array full list is not an empty list, even if another
        // notification arrives before the setter acknowledgement.
        if self.has_invalid_options() || self.invalid_options_revision > request.revision {
            return Err(UNCONFIRMED.into());
        }
        if request.legacy {
            // The official older SetSessionModelResponse is an object with only
            // optional _meta (SDK 0.14.1). Its {} acknowledgement is meaningful;
            // a modern setter missing configOptions has a different contract.
            if !reply.is_object() || self.legacy_option().is_none() {
                return Err(UNCONFIRMED.into());
            }
            if self.options_revision <= request.revision
                && self
                    .options
                    .as_ref()
                    .and_then(Value::as_array)
                    .is_some_and(|options| {
                        options.iter().any(|option| {
                            option["category"] == "thought_level"
                                || (option.get("category").is_none_or(Value::is_null)
                                    && matches!(
                                        option["id"].as_str(),
                                        Some("thought_level" | "reasoning_effort")
                                    ))
                        })
                    })
            {
                return Err("Agent 未返回切换模型后的思考选择，请重新检查此对话".into());
            }
            if self.model_update.as_ref().is_some_and(|(revision, model)| {
                *revision > request.revision && model.as_deref() != request.value.as_str()
            }) {
                return Err(UNCONFIRMED.into());
            }
            self.models.as_mut().ok_or(UNCONFIRMED)?["currentModelId"] = request.value.clone();
        } else {
            if !reply.is_array() {
                return Err(UNCONFIRMED.into());
            }
            self.options = Some(reply);
        }
        self.options().ok_or_else(|| UNCONFIRMED.into())
    }

    /// These updates must be interpreted after the initial load response.
    /// It is an ordering barrier, not permission to discard any other message.
    pub(crate) fn waits_for_load_response(dispatch: &Dispatch) -> bool {
        Self::configuration_update(dispatch).is_some()
    }

    fn configuration_update(dispatch: &Dispatch) -> Option<&Value> {
        let Dispatch::Notification(message) = dispatch else {
            return None;
        };
        if message.method() != "session/update" {
            return None;
        }
        let update = message.params().get("update")?;
        matches!(
            update.get("sessionUpdate").and_then(Value::as_str),
            Some("config_option_update" | "current_model_update")
        )
        .then_some(update)
    }

    pub(crate) fn observe(&mut self, dispatch: &Dispatch) -> Option<Value> {
        let update = Self::configuration_update(dispatch)?;
        match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("config_option_update") => {
                self.options = Some(update.get("configOptions").cloned().unwrap_or(Value::Null));
                if self.has_invalid_options() {
                    self.invalid_options_revision = self.revision + 1;
                } else {
                    self.options_revision = self.revision + 1;
                }
            }
            // A known implementation extension; never an acknowledgement or a
            // license to change a recorded model by itself.
            Some("current_model_update") if self.legacy_option().is_some() => {
                let model = update
                    .get("currentModelId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                self.model_update = Some((self.revision + 1, model.clone()));
                self.models.as_mut()?["currentModelId"] =
                    model.map(Value::String).unwrap_or(Value::Null);
            }
            _ => return None,
        }
        self.revision += 1;
        self.options()
    }
}

impl ConfigRequest {
    pub(crate) fn send(
        &self,
        cx: &ConnectionTo<Agent>,
        session_id: &str,
        operation: &Operation,
    ) -> impl std::future::Future<Output = Result<Value, String>> + Send + 'static {
        let (request, cx, session_id, operation) = (
            self.clone(),
            cx.clone(),
            session_id.to_owned(),
            operation.clone(),
        );
        async move {
            if request.legacy {
                let message = UntypedMessage::new(
                    "session/set_model",
                    json!({"sessionId":session_id, "modelId":request.value}),
                )
                .map_err(describe_acp_error)?;
                operation
                    .request(&cx, cx.send_request_to(Agent, message))
                    .await
                    .map_err(describe_acp_error)
            } else {
                let message = SetSessionConfigOptionRequest::new(
                    session_id,
                    request.id,
                    parse_config_value(&request.value)?,
                );
                let reply = operation
                    .request(&cx, cx.send_request_to(Agent, message))
                    .await
                    .map_err(describe_acp_error)?;
                serde_json::to_value(reply.config_options).map_err(|_| UNCONFIRMED.into())
            }
        }
    }
}

pub(crate) fn projection(options: Value, modern: bool) -> Value {
    json!({"kind":"configOptions", "options":options, "modern":modern})
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod transport_tests;
