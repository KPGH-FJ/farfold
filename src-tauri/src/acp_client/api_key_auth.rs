//! A single user-selected key exists only until its authenticate request.
use std::{path::Path, sync::Arc};

use agent_client_protocol::schema::v1::AuthenticateRequest;
use serde_json::json;
use tokio::sync::oneshot;

use super::manager::{AcpManager, AuthenticationOperation, ManagerCommand};

// No Debug, Serialize or Clone: this must never become public metadata, a
// configuration object, diagnostics, or a reusable connection credential.
pub(crate) struct ProtocolApiKey {
    provider: String,
    secret: String,
}

impl ProtocolApiKey {
    pub(crate) fn new(provider: String, key: String) -> Result<Self, String> {
        if provider != "openai" {
            return Err(
                super::auth_route::UnavailableReason::ApiKeyProviderUnsupported
                    .message()
                    .into(),
            );
        }
        if key.trim().is_empty() || key.len() > 16384 || key.chars().any(char::is_control) {
            return Err("密钥内容无效，请重新输入".into());
        }
        Ok(Self {
            provider,
            secret: key,
        })
    }

    pub(crate) fn provider(&self) -> &str {
        &self.provider
    }

    /// The existing official AuthenticateRequest is the only serialized copy.
    /// This provider's installed official implementation consumes this field.
    pub(crate) fn into_request(self, method_id: String) -> AuthenticateRequest {
        let mut meta = serde_json::Map::new();
        meta.insert("api-key".into(), json!({"apiKey":self.secret}));
        AuthenticateRequest::new(method_id).meta(meta)
    }
}

impl AcpManager {
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn authenticate_with_key(
        &self,
        agent_id: &str,
        cwd: &Path,
        method_id: &str,
        key: Option<ProtocolApiKey>,
        operation: AuthenticationOperation,
        on_unknown: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<(), String> {
        let selected = self.live_connection(agent_id, cwd)?;
        let declared = selected
            .handshake
            .get()
            .is_some_and(|handshake| match &key {
                Some(key) => handshake.protocol_api_key_provider(method_id) == Some(key.provider()),
                None => handshake.protocol_method(method_id),
            });
        if !declared {
            return Err("此目录的登录方式已变化，请重新检查后再登录".into());
        }
        let (result, reply) = oneshot::channel();
        selected.send(ManagerCommand::Authenticate {
            method_id: method_id.to_string(),
            key,
            operation,
            on_unknown,
            result,
        })?;
        match reply.await {
            Ok(Err(error)) if error == "AUTH_CONNECTION_CLOSED" => {
                selected.life.terminated().await;
                Err("登录连接已结束，请重新检查账号状态".into())
            }
            Ok(outcome) => outcome,
            Err(_) => {
                selected.life.terminated().await;
                Err("登录连接已结束，请重新检查账号状态".into())
            }
        }
    }
}

#[cfg(test)]
mod tests;
