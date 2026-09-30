//! Compile a user-selected service through official Agent startup surfaces.
//!
//! This module owns the Agent-specific translation. It does not change Agent
//! files, perform authentication, send prompts, or establish a connection.
use std::collections::HashMap;

use serde::Serialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::{credentials::ServiceSnapshot, meta_store::AgentRow};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServiceCapability {
    /// Configuration routes exercised for release, not a claim about arbitrary models.
    pub api_types: Vec<&'static str>,
    /// Routes exercised with the current registered Agent and a controlled service.
    pub validated_api_types: Vec<&'static str>,
    pub selection_scope: &'static str,
    pub unavailable_reason: Option<&'static str>,
}

fn catalog_id(agent: &AgentRow) -> Option<&str> {
    if !matches!(agent.source.as_str(), "registry" | "discovered") {
        return None;
    }
    crate::agent_catalog::def_for(&agent.id).map(|_| agent.id.as_str())
}

pub(crate) fn verified_permission_option(agent: &AgentRow) -> bool {
    catalog_id(agent) == Some("codex")
}

pub(crate) fn capability(agent: &AgentRow) -> ServiceCapability {
    let (api_types, validated_api_types, unavailable_reason) = match catalog_id(agent) {
        Some("opencode") => (
            vec!["chat-completions", "responses"],
            vec!["chat-completions", "responses"],
            None,
        ),
        Some("codex") => (vec!["responses"], vec!["responses"], None),
        Some("pi") => (
            vec![],
            vec![],
            Some("此处尚不能为该 Agent 配置新的 API 服务，可继续使用它已有的设置"),
        ),
        _ => (
            vec![],
            vec![],
            Some("此接入尚未提供 API 配置方式，可继续使用已有设置"),
        ),
    };
    ServiceCapability {
        api_types,
        validated_api_types,
        selection_scope: "connection",
        unavailable_reason,
    }
}

/// Includes secret-bearing env values. Deliberately not Debug or Serialize.
pub(crate) struct LaunchConfig {
    pub env_overrides: Vec<(String, String)>,
    /// The concrete Agent model identifier expected after session/new or load.
    pub model_id: String,
}

/// Validate the actual selection, not just a model's presence in a menu.
pub(crate) fn validate_model(expected_wire_model: &str, options: &Value) -> Result<(), String> {
    validate_selected_model(expected_wire_model, options)
}

fn validate_selected_model(expected: &str, options: &Value) -> Result<(), String> {
    let mut models = options.as_array().into_iter().flatten().filter(|option| {
        option.get("category").and_then(Value::as_str) == Some("model")
            || (option.get("category").is_none()
                && option.get("id").and_then(Value::as_str) == Some("model"))
    });
    let actual = models
        .next()
        .and_then(|option| option.get("currentValue"))
        .and_then(Value::as_str);
    if actual != Some(expected) || models.next().is_some() {
        return Err("Agent 未确认使用所选 API 的模型，请检查配置后重试".into());
    }
    Ok(())
}

/// Return only additions/replacements to the inherited process environment.
/// Existing inline configuration is preserved except for the explicit model
/// selection and an independent Farfold-owned provider entry.
pub(crate) fn compile(
    agent: &AgentRow,
    service: &ServiceSnapshot,
    inherited: &HashMap<String, String>,
) -> Result<LaunchConfig, String> {
    let supported = capability(agent);
    if !supported.api_types.contains(&service.api_type.as_str()) {
        return Err(supported
            .unavailable_reason
            .unwrap_or("这个 Agent 不支持所选 API 接口，请选择兼容的配置")
            .into());
    }
    if service.identity.model.trim().is_empty()
        || !service.models.contains(&service.identity.model)
        || service.secret.is_empty()
    {
        return Err("API 配置已改变，请重新选择服务和模型".into());
    }
    // A URL/API identity change gives a different provider and env name. Never
    // reuse a user provider ID or derive identity from a display name.
    let mut digest = Sha256::new();
    digest.update(service.identity.id.as_bytes());
    digest.update([0]);
    digest.update(service.identity.fingerprint.as_bytes());
    let suffix = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let provider_id = format!("farfold_{suffix}");
    let env_name = format!("FARFOLD_SERVICE_KEY_{}", suffix.to_uppercase());
    if inherited
        .get(&env_name)
        .is_some_and(|existing| existing != &service.secret)
    {
        return Err("所选 API 的密钥与已有环境设置冲突，请检查后重试".into());
    }

    let (inline_name, mut config, model_id) = match catalog_id(agent) {
        Some("opencode") => {
            let mut config = inline_config(inherited, "OPENCODE_CONFIG_CONTENT")?;
            let npm = match service.api_type.as_str() {
                "responses" => "@ai-sdk/openai",
                _ => "@ai-sdk/openai-compatible",
            };
            let models: Map<String, Value> = service
                .models
                .iter()
                .map(|id| (id.clone(), json!({"name": id})))
                .collect();
            let provider = json!({
                "name": "Farfold API",
                "npm": npm,
                "options": {
                    "baseURL": service.endpoint,
                    "apiKey": format!("{{env:{env_name}}}")
                },
                "models": models
            });
            insert_provider(&mut config, "provider", &provider_id, provider)?;
            let model = format!("{provider_id}/{}", service.identity.model);
            ("OPENCODE_CONFIG_CONTENT", config, model)
        }
        Some("codex") => {
            let mut config = inline_config(inherited, "CODEX_CONFIG")?;
            let provider = json!({
                "name": "Farfold API",
                "base_url": service.endpoint,
                "wire_api": "responses",
                "env_key": env_name,
                "requires_openai_auth": false
            });
            insert_provider(&mut config, "model_providers", &provider_id, provider)?;
            config.insert("model_provider".into(), json!(provider_id));
            ("CODEX_CONFIG", config, service.identity.model.clone())
        }
        _ => unreachable!("capability checked above"),
    };
    config.insert("model".into(), json!(model_id));
    let encoded = serde_json::to_string(&config).map_err(|_| "无法准备 API 配置")?;
    let mut env_overrides = vec![
        (inline_name.into(), encoded),
        (env_name, service.secret.clone()),
    ];
    if catalog_id(agent) == Some("codex") {
        env_overrides.push(("MODEL_PROVIDER".into(), provider_id));
    }
    Ok(LaunchConfig {
        env_overrides,
        model_id,
    })
}

fn inline_config(
    inherited: &HashMap<String, String>,
    name: &str,
) -> Result<Map<String, Value>, String> {
    let Some(raw) = inherited.get(name).filter(|raw| !raw.trim().is_empty()) else {
        return Ok(Map::new());
    };
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| "无法读取已有临时设置，原设置未更改，请检查后重试".into())
}

fn insert_provider(
    config: &mut Map<String, Value>,
    field: &str,
    id: &str,
    provider: Value,
) -> Result<(), String> {
    let providers = config
        .entry(field)
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("已有服务设置格式无法合并，原设置未更改")?;
    if let Some(existing) = providers.get(id)
        && existing != &provider
    {
        return Err("所选 API 与已有服务设置冲突，原设置未更改".into());
    }
    providers.insert(id.into(), provider);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::ServiceIdentity;

    fn agent(id: &str) -> AgentRow {
        AgentRow {
            id: id.into(),
            name: "A user label".into(),
            source: "registry".into(),
            command: "fixture".into(),
            args: vec![],
            env: vec![],
            version: None,
            handshake: None,
            created_at: 0,
            updated_at: 0,
        }
    }
    fn service(api: &str) -> ServiceSnapshot {
        ServiceSnapshot {
            identity: ServiceIdentity {
                id: "service-1".into(),
                fingerprint: "source-a".into(),
                model: "custom-model".into(),
            },
            endpoint: "https://example.test/v1".into(),
            api_type: api.into(),
            models: vec!["custom-model".into(), "second-model".into()],
            secret: "fixture-secret-do-not-log".into(),
            connection_revision: "revision-1".into(),
        }
    }

    #[test]
    fn codex_retains_user_settings_but_selects_independent_provider_and_env_key() {
        let inherited = HashMap::from([(
            "CODEX_CONFIG".into(),
            json!({
                "model": "old", "model_reasoning_effort": "high", "other": {"keep": true},
                "model_providers": {"user": {"name": "Keep me"}}
            })
            .to_string(),
        )]);
        let original = inherited.clone();
        let launch = compile(&agent("codex"), &service("responses"), &inherited).unwrap();
        let env: HashMap<_, _> = launch.env_overrides.into_iter().collect();
        let config: Value = serde_json::from_str(&env["CODEX_CONFIG"]).unwrap();
        assert_eq!(config["model"], "custom-model");
        assert_eq!(config["model_reasoning_effort"], "high");
        assert_eq!(config["model_providers"]["user"]["name"], "Keep me");
        assert_eq!(config["other"]["keep"], true);
        let provider = &config["model_providers"][&env["MODEL_PROVIDER"]];
        assert_eq!(provider["base_url"], "https://example.test/v1");
        assert_eq!(
            env[provider["env_key"].as_str().unwrap()],
            "fixture-secret-do-not-log"
        );
        assert!(!env["CODEX_CONFIG"].contains("fixture-secret-do-not-log"));
        assert_eq!(inherited, original);
        // A valid short token may also occur in ordinary configuration text;
        // only the dedicated environment entry receives the chosen secret.
        let mut short_key = service("responses");
        short_key.secret = "x".into();
        assert!(compile(&agent("codex"), &short_key, &inherited).is_ok());
    }

    #[test]
    fn opencode_preserves_inline_settings_and_source_change_changes_provider() {
        let inherited = HashMap::from([(
            "OPENCODE_CONFIG_CONTENT".into(),
            json!({
                "permission": {"edit": "ask"}, "provider": {"user": {"name": "Keep"}}
            })
            .to_string(),
        )]);
        let original = service("chat-completions");
        let first = compile(&agent("opencode"), &original, &inherited).unwrap();
        let env: HashMap<_, _> = first.env_overrides.into_iter().collect();
        let config: Value = serde_json::from_str(&env["OPENCODE_CONFIG_CONTENT"]).unwrap();
        assert_eq!(config["permission"]["edit"], "ask");
        assert_eq!(config["provider"]["user"]["name"], "Keep");
        assert_eq!(config["model"], first.model_id);
        let id = first.model_id.split('/').next().unwrap();
        assert!(config["provider"][id]["models"]["second-model"].is_object());
        assert!(
            config["provider"][id]["options"]["apiKey"]
                .as_str()
                .unwrap()
                .starts_with("{env:FARFOLD_SERVICE_KEY_")
        );
        assert!(!env["OPENCODE_CONFIG_CONTENT"].contains(&original.secret));
        let mut changed = service("chat-completions");
        changed.identity.fingerprint = "source-b".into();
        changed.endpoint = "https://another.test/v1".into();
        let second = compile(&agent("opencode"), &changed, &inherited).unwrap();
        assert_ne!(first.model_id, second.model_id);
    }

    #[test]
    fn one_responses_record_is_compiled_for_both_supported_agents() {
        let selected = service("responses");
        let open = compile(&agent("opencode"), &selected, &HashMap::new()).unwrap();
        let env: HashMap<_, _> = open.env_overrides.into_iter().collect();
        let config: Value = serde_json::from_str(&env["OPENCODE_CONFIG_CONTENT"]).unwrap();
        let id = open.model_id.split('/').next().unwrap();
        assert_eq!(config["provider"][id]["npm"], "@ai-sdk/openai");
        assert_eq!(
            config["provider"][id]["options"]["baseURL"],
            selected.endpoint
        );
        assert!(config["provider"][id]["models"][&selected.identity.model].is_object());
        let codex = compile(&agent("codex"), &selected, &HashMap::new()).unwrap();
        assert_eq!(codex.model_id, selected.identity.model);
    }

    #[test]
    fn no_guessing_custom_agent_and_no_silent_loss_of_existing_config() {
        let mut custom = agent("codex");
        custom.source = "custom".into();
        assert!(compile(&custom, &service("responses"), &HashMap::new()).is_err());
        assert!(compile(&agent("pi"), &service("responses"), &HashMap::new()).is_err());
        assert!(
            compile(
                &agent("codex"),
                &service("chat-completions"),
                &HashMap::new()
            )
            .is_err()
        );
        for raw in ["not valid", "[]", "{\"model_providers\":null}"] {
            let env = HashMap::from([("CODEX_CONFIG".into(), raw.into())]);
            assert!(compile(&agent("codex"), &service("responses"), &env).is_err());
        }
    }

    #[test]
    fn conflicting_independent_provider_never_overwrites_user_entry() {
        let selected = service("responses");
        let first = compile(&agent("codex"), &selected, &HashMap::new()).unwrap();
        let mut inherited: HashMap<_, _> = first.env_overrides.into_iter().collect();
        let provider_id = inherited["MODEL_PROVIDER"].clone();
        let mut config: Value = serde_json::from_str(&inherited["CODEX_CONFIG"]).unwrap();
        config["model_providers"][&provider_id]["base_url"] = json!("https://user.test/v1");
        inherited.insert("CODEX_CONFIG".into(), config.to_string());
        let original = inherited.clone();
        assert!(compile(&agent("codex"), &selected, &inherited).is_err());
        assert_eq!(inherited, original);
    }

    #[test]
    fn current_selection_must_match_even_if_expected_model_is_in_menu() {
        let options = json!([{"id":"model", "category":"model", "currentValue":"other",
            "options":[{"value":"custom-model"}]}]);
        assert!(validate_model("custom-model", &options).is_err());
        assert!(
            validate_model(
                "custom-model",
                &json!([
                    {"id":"model", "category":"model", "currentValue":"custom-model"}
                ])
            )
            .is_ok()
        );
        assert!(
            validate_model(
                "custom-model",
                &json!([
                    {"id":"model", "category":"model", "currentValue":"custom-model"},
                    {"id":"second", "category":"model", "currentValue":"custom-model"}
                ])
            )
            .is_err()
        );
    }
}
