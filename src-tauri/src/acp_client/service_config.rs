//! Compile a user-selected service through official Agent startup surfaces.
//!
//! This module owns the Agent-specific translation. It does not change Agent
//! files, perform authentication, send prompts, or establish a connection.
use std::collections::HashMap;

use serde::Serialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::{credentials::ServiceSnapshot, meta_store::AgentRow};

#[cfg(test)]
#[path = "service_config_claude_tests.rs"]
mod claude_tests;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServiceCapability {
    /// Implemented official delivery routes, subject to live capability checks.
    pub api_types: Vec<&'static str>,
    /// Routes exercised with the current registered Agent and a controlled service.
    pub validated_api_types: Vec<&'static str>,
    pub selection_scope: &'static str,
    pub unavailable_reason: Option<&'static str>,
}

fn catalog_id(agent: &AgentRow) -> Option<&str> {
    if agent.source == "registry" && agent.id == "registry:claude-acp" {
        return Some("claude-acp");
    }
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
            vec!["chat-completions", "responses", "messages"],
            vec!["chat-completions", "responses", "messages"],
            None,
        ),
        Some("codex") => (vec!["responses"], vec!["responses"], None),
        // The adapter puts provider headers in SDK settings, and the SDK
        // serializes those settings in the Claude process arguments. Keep
        // configured credentials out until an official private route is verified.
        Some("claude-acp") => (
            vec![],
            vec![],
            Some("Claude 的 API 配置暂时不可用，所保存的服务仍可在设置中管理"),
        ),
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
    pub delivery: Option<super::service_delivery::ServiceDelivery>,
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
    compile_with_names(
        agent,
        service,
        inherited,
        crate::shell_env::EnvNames::current(),
    )
}
fn compile_with_names(
    agent: &AgentRow,
    service: &ServiceSnapshot,
    inherited: &HashMap<String, String>,
    names: crate::shell_env::EnvNames,
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
    if catalog_id(agent) == Some("claude-acp") {
        return Ok(LaunchConfig {
            // This transport stays disabled by the capability check above.
            // Routing and the key are deliberately absent: Claude settings
            // can overwrite process env. The negotiated provider request
            // below owns the route. A model mismatch still blocks new/load.
            env_overrides: vec![
                ("ANTHROPIC_MODEL".into(), service.identity.model.clone()),
                (
                    "ANTHROPIC_CUSTOM_MODEL_OPTION".into(),
                    service.identity.model.clone(),
                ),
            ],
            delivery: Some(super::service_delivery::ServiceDelivery::anthropic(
                service,
            )?),
            model_id: service.identity.model.clone(),
        });
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
    if names
        .get(inherited, &env_name)?
        .is_some_and(|existing| existing != &service.secret)
    {
        return Err("所选 API 的密钥与已有环境设置冲突，请检查后重试".into());
    }

    let (inline_name, mut config, model_id) = match catalog_id(agent) {
        Some("opencode") => {
            let mut config = inline_config(inherited, "OPENCODE_CONFIG_CONTENT", names)?;
            let provider = opencode_provider(service, &env_name)?;
            insert_provider(&mut config, "provider", &provider_id, provider)?;
            let model = format!("{provider_id}/{}", service.identity.model);
            ("OPENCODE_CONFIG_CONTENT", config, model)
        }
        Some("codex") if service.api_type == "responses" => {
            let mut config = inline_config(inherited, "CODEX_CONFIG", names)?;
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
        _ => return Err("此接入尚未提供 API 配置方式，可继续使用已有设置".into()),
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
        delivery: None,
        model_id,
    })
}

fn opencode_provider(service: &ServiceSnapshot, env_name: &str) -> Result<Value, String> {
    let npm = match service.api_type.as_str() {
        "chat-completions" => "@ai-sdk/openai-compatible",
        "responses" => "@ai-sdk/openai",
        "messages" => "@ai-sdk/anthropic",
        _ => return Err("请选择接口格式".into()),
    };
    let base = crate::api_endpoint::base_url(&service.endpoint, &service.api_type)?;
    let models: Map<String, Value> = service
        .models
        .iter()
        .map(|id| {
            (
                id.clone(),
                json!({"name": id, "id": id, "provider": {"npm": npm, "api": base}}),
            )
        })
        .collect();
    Ok(json!({
        "name": "Farfold API",
        "npm": npm,
        "options": {
            "baseURL": base,
            "apiKey": format!("{{env:{env_name}}}")
        },
        "models": models
    }))
}

fn inline_config(
    inherited: &HashMap<String, String>,
    name: &str,
    names: crate::shell_env::EnvNames,
) -> Result<Map<String, Value>, String> {
    let Some(raw) = names
        .get(inherited, name)?
        .filter(|raw| !raw.trim().is_empty())
    else {
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
    fn windows_services_preserve_case_variant_settings_and_reject_conflicting_keys() {
        let names = crate::shell_env::EnvNames::Windows;
        for (id, inline_name) in [
            ("codex", "CODEX_CONFIG"),
            ("opencode", "OPENCODE_CONFIG_CONTENT"),
        ] {
            let selected = service("responses");
            let inherited = HashMap::from([(
                inline_name.to_ascii_lowercase(),
                json!({"model_reasoning_effort":"high", "other":{"keep":true}}).to_string(),
            )]);
            let launch = compile_with_names(&agent(id), &selected, &inherited, names).unwrap();
            let key_name = launch
                .env_overrides
                .iter()
                .find(|(name, _)| name.starts_with("FARFOLD_SERVICE_KEY_"))
                .unwrap()
                .0
                .clone();
            let mut merged = inherited.clone();
            names.extend(&mut merged, launch.env_overrides);
            assert!(!merged.contains_key(&inline_name.to_ascii_lowercase()));
            let settings: Value = serde_json::from_str(&merged[inline_name]).unwrap();
            assert_eq!(settings["model_reasoning_effort"], "high");
            assert_eq!(settings["other"]["keep"], true);
            assert_eq!(merged[&key_name], selected.secret);
            let mut conflict = inherited;
            conflict.insert(
                key_name.to_ascii_lowercase(),
                "synthetic-other-account".into(),
            );
            assert!(compile_with_names(&agent(id), &selected, &conflict, names).is_err());
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
    fn opencode_sets_api_model_and_model_level_route_explicitly() {
        for (api, npm) in [
            ("chat-completions", "@ai-sdk/openai-compatible"),
            ("responses", "@ai-sdk/openai"),
        ] {
            let selected = service(api);
            let launch = compile(&agent("opencode"), &selected, &HashMap::new()).unwrap();
            let env: HashMap<_, _> = launch.env_overrides.into_iter().collect();
            let config: Value = serde_json::from_str(&env["OPENCODE_CONFIG_CONTENT"]).unwrap();
            let provider_id = launch.model_id.split('/').next().unwrap();
            for id in &selected.models {
                let model = &config["provider"][provider_id]["models"][id];
                assert_eq!(model["id"], *id);
                assert_eq!(model["provider"]["npm"], npm);
                assert_eq!(model["provider"]["api"], selected.endpoint);
            }
        }
    }

    #[test]
    fn messages_translation_preserves_identity_and_only_opencode_is_admitted() {
        let capability = capability(&agent("opencode"));
        assert!(capability.api_types.contains(&"messages"));
        assert!(capability.validated_api_types.contains(&"messages"));
        for id in ["codex", "pi", "claude", "unknown"] {
            let row = agent(id);
            assert!(!super::capability(&row).api_types.contains(&"messages"));
            assert!(
                !super::capability(&row)
                    .validated_api_types
                    .contains(&"messages")
            );
            assert!(compile(&row, &service("messages"), &HashMap::new()).is_err());
        }
        let mut custom = agent("opencode");
        custom.source = "custom".into();
        assert!(compile(&custom, &service("messages"), &HashMap::new()).is_err());
        let mut discovered = agent("opencode");
        discovered.source = "discovered".into();
        assert!(compile(&discovered, &service("messages"), &HashMap::new()).is_ok());

        for endpoint in [
            "https://api.anthropic.com",
            "https://api.anthropic.com/v1",
            "https://custom.test",
            "https://custom.test/prefix/v1/",
        ] {
            let mut selected = service("messages");
            selected.endpoint = endpoint.into();
            let identity = selected.identity.clone();
            let revision = selected.connection_revision.clone();
            let launch = compile(&agent("opencode"), &selected, &HashMap::new()).unwrap();
            let env: HashMap<_, _> = launch.env_overrides.into_iter().collect();
            let config: Value = serde_json::from_str(&env["OPENCODE_CONFIG_CONTENT"]).unwrap();
            let provider_id = launch.model_id.split('/').next().unwrap();
            let provider = &config["provider"][provider_id];
            let base = crate::api_endpoint::base_url(endpoint, "messages").unwrap();
            assert_eq!(provider["npm"], "@ai-sdk/anthropic");
            assert_eq!(provider["options"]["baseURL"], base);
            let secret_ref = provider["options"]["apiKey"].as_str().unwrap();
            let secret_name = secret_ref
                .strip_prefix("{env:")
                .unwrap()
                .strip_suffix('}')
                .unwrap();
            assert_eq!(env[secret_name], selected.secret);
            assert_eq!(env.len(), 2);
            assert!(!env["OPENCODE_CONFIG_CONTENT"].contains(&selected.secret));
            assert!(provider["options"].get("headers").is_none());
            assert!(provider["options"].get("authToken").is_none());
            for id in &selected.models {
                let model = &provider["models"][id];
                assert_eq!(model["id"], *id);
                assert_eq!(model["provider"]["npm"], "@ai-sdk/anthropic");
                assert_eq!(model["provider"]["api"], base);
                assert!(model.get("limit").is_none());
            }
            assert_eq!(selected.identity, identity);
            assert_eq!(selected.endpoint, endpoint);
            assert_eq!(selected.connection_revision, revision);
        }
    }

    #[test]
    fn opencode_same_id_conflicts_do_not_replace_route_model_or_authentication() {
        let selected = service("messages");
        let first = compile(&agent("opencode"), &selected, &HashMap::new()).unwrap();
        let env: HashMap<_, _> = first.env_overrides.into_iter().collect();
        let original: Value = serde_json::from_str(&env["OPENCODE_CONFIG_CONTENT"]).unwrap();
        let provider_id = first.model_id.split('/').next().unwrap();
        for (pointer, value) in [
            ("/options/baseURL", json!("https://other.test/v1")),
            ("/options/authToken", json!("different-fixture-token")),
            (
                "/options/headers",
                json!({"X-Api-Key":"different-fixture-key"}),
            ),
            ("/models/custom-model/id", json!("other-api-model")),
            ("/models/custom-model/provider/npm", json!("@ai-sdk/openai")),
            (
                "/models/custom-model/provider/api",
                json!("https://other.test/v1"),
            ),
            (
                "/models/custom-model/headers",
                json!({"Authorization":"Bearer fixture"}),
            ),
        ] {
            let mut config = original.clone();
            let provider = config["provider"][provider_id].as_object_mut().unwrap();
            // Insert absent authentication fields as well as replacing existing scalars.
            match pointer {
                "/options/authToken" | "/options/headers" => {
                    provider
                        .get_mut("options")
                        .unwrap()
                        .as_object_mut()
                        .unwrap()
                        .insert(pointer.rsplit('/').next().unwrap().into(), value);
                }
                "/models/custom-model/headers" => {
                    provider.get_mut("models").unwrap()["custom-model"]
                        .as_object_mut()
                        .unwrap()
                        .insert("headers".into(), value);
                }
                _ => {
                    *config["provider"][provider_id]
                        .pointer_mut(pointer)
                        .unwrap() = value
                }
            }
            let inherited = HashMap::from([("OPENCODE_CONFIG_CONTENT".into(), config.to_string())]);
            let before = inherited.clone();
            assert_eq!(
                compile(&agent("opencode"), &selected, &inherited)
                    .err()
                    .unwrap(),
                "所选 API 与已有服务设置冲突，原设置未更改"
            );
            assert_eq!(inherited, before);
        }
    }

    #[test]
    fn opencode_retains_provider_restrictions_and_accepts_only_identical_owned_entry() {
        let selected = service("messages");
        let first = compile(&agent("opencode"), &selected, &HashMap::new()).unwrap();
        let env: HashMap<_, _> = first.env_overrides.into_iter().collect();
        let mut config: Value = serde_json::from_str(&env["OPENCODE_CONFIG_CONTENT"]).unwrap();
        let provider_id = first.model_id.split('/').next().unwrap();
        config["enabled_providers"] = json!(["only-user-provider"]);
        config["disabled_providers"] = json!([provider_id]);
        config["permission"] = json!({"edit":"deny"});
        config["provider"]["user"] =
            json!({"name":"Keep", "options":{"headers":{"custom":"keep"}}});
        let inherited = HashMap::from([("OPENCODE_CONFIG_CONTENT".into(), config.to_string())]);
        let before = inherited.clone();
        let second = compile(&agent("opencode"), &selected, &inherited).unwrap();
        let env: HashMap<_, _> = second.env_overrides.into_iter().collect();
        let after: Value = serde_json::from_str(&env["OPENCODE_CONFIG_CONTENT"]).unwrap();
        assert_eq!(after, config);
        assert_eq!(inherited, before);
        assert_eq!(second.model_id, first.model_id);
        // Keeping these restrictions is not evidence that the selected model is available.
        assert!(validate_model(&second.model_id, &json!([])).is_err());
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
