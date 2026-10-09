//! Connection-local service delivery through declared official ACP methods.
//! Nothing from provider responses is published, logged or persisted. In
//! particular, a peer returning secret headers/metadata cannot expose them.
use std::collections::HashMap;

use agent_client_protocol::{
    Agent, ConnectionTo, UntypedMessage,
    schema::v1::{ListProvidersRequest, LlmProtocol, SetProviderRequest},
};
use serde_json::Value;

use super::handshake::Handshake;
use crate::credentials::ServiceSnapshot;

// No Debug, Serialize or Clone. The secret has one owner until the official
// providers/set request is serialized directly onto this connection.
pub(crate) struct ServiceDelivery {
    base_url: String,
    secret: String,
}

impl ServiceDelivery {
    pub(crate) fn anthropic(service: &ServiceSnapshot) -> Result<Self, String> {
        let base = crate::api_endpoint::base_url(&service.endpoint, "messages")?;
        // Farfold Messages addresses are the base preceding /messages;
        // Claude Code appends /v1/messages to its provider root. Do not silently
        // redirect custom non-v1 paths to a different endpoint.
        let root = base
            .strip_suffix("/v1")
            .ok_or("此 Agent 的 Messages 地址需要以 /v1 结尾，请检查 API 配置")?;
        Ok(Self {
            base_url: root.into(),
            secret: service.secret.clone(),
        })
    }

    pub(crate) async fn apply(
        self,
        cx: &ConnectionTo<Agent>,
        handshake: &Handshake,
    ) -> Result<(), ()> {
        if handshake.typed.agent_capabilities.providers.is_none() {
            return Err(());
        }
        let before = list(cx).await?;
        let provider = unique_anthropic_provider(&before)?;
        let provider_id = provider["providerId"].as_str().ok_or(())?.to_owned();
        let request =
            SetProviderRequest::new(provider_id.clone(), LlmProtocol::Anthropic, &self.base_url)
                .headers(HashMap::from([("x-api-key".into(), self.secret)]));
        let request = UntypedMessage::new("providers/set", &request).map_err(|_| ())?;
        // Remote messages/data can echo credentials. Only a content-free
        // success/error leaves this function, never the SDK error itself.
        let response = cx
            .send_request(request)
            .block_task()
            .await
            .map_err(|_| ())?;
        if !response.is_object() {
            return Err(());
        }
        let after = list(cx).await?;
        let actual = unique_anthropic_provider(&after)?;
        if actual["providerId"] != provider_id
            || actual["current"]["apiType"] != "anthropic"
            || actual["current"]["baseUrl"] != self.base_url
        {
            return Err(());
        }
        Ok(())
    }
}

async fn list(cx: &ConnectionTo<Agent>) -> Result<Value, ()> {
    let request =
        UntypedMessage::new("providers/list", ListProvidersRequest::new()).map_err(|_| ())?;
    cx.send_request(request).block_task().await.map_err(|_| ())
}

fn unique_anthropic_provider(response: &Value) -> Result<&Value, ()> {
    let providers = response
        .get("providers")
        .and_then(Value::as_array)
        .ok_or(())?;
    if providers.len() > 64 {
        return Err(());
    }
    // An ambiguous or malformed sibling can disguise another destination.
    // Validate IDs and declarations before selecting the sole supported slot.
    let mut ids = std::collections::HashSet::new();
    let mut selected = None;
    for provider in providers {
        let id = provider
            .get("providerId")
            .and_then(Value::as_str)
            .ok_or(())?;
        if id.is_empty() || id.len() > 256 || id.chars().any(char::is_control) || !ids.insert(id) {
            return Err(());
        }
        let supported = provider
            .get("supported")
            .and_then(Value::as_array)
            .ok_or(())?;
        if supported.len() > 64 || supported.iter().any(|value| !value.is_string()) {
            return Err(());
        }
        if !provider.get("required").is_some_and(Value::is_boolean) {
            return Err(());
        }
        if supported.iter().any(|value| value == "anthropic")
            && selected.replace(provider).is_some()
        {
            return Err(());
        }
    }
    selected.ok_or(())
}

#[cfg(test)]
#[path = "service_delivery_tests.rs"]
mod tests;
