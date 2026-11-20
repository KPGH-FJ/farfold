//! Connection-scoped Copilot CLI BYOK through its documented provider environment.
//! Source: https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server
//! Installed 1.0.112 and its official 1.0.114 update were exercised against
//! loopback peers for all listed formats with synthetic credentials and no login.
use std::{collections::HashMap, ffi::OsString, path::Path};

use crate::{
    credentials::ServiceSnapshot,
    meta_store::{AgentRow, MetaStore},
};

use super::{LaunchConfig, ServiceCapability, ServiceEndpointRule};
use crate::acp_client::{auth_route, handshake::Handshake};

pub(in crate::acp_client) const UNAVAILABLE: &str =
    "当前 GitHub Copilot 程序的 API 配置尚不可用，可继续使用已有设置";
pub(in crate::acp_client) const AGENT_ID: &str = "registry:github-copilot-cli";
const MESSAGES_ENDPOINT: ServiceEndpointRule = ServiceEndpointRule {
    api_type: "messages",
    required_path_suffix: "/v1",
    allowed_exact_endpoints: &["https://api.anthropic.com"],
};

pub(in crate::acp_client) fn registered(agent: &AgentRow) -> bool {
    agent.source == "registry" && agent.id == AGENT_ID
}

fn supported_runtime(name: Option<&str>, version: Option<&str>) -> bool {
    name == Some("Copilot") && matches!(version, Some("1.0.112" | "1.0.114"))
}

fn eligible(agent: &AgentRow) -> bool {
    let reported = agent
        .handshake
        .as_ref()
        .and_then(|value| value.get("agentInfo"));
    cfg!(all(target_os = "macos", target_arch = "aarch64"))
        && registered(agent)
        && agent.version.as_deref() == Some("1.0.112")
        && supported_runtime(
            reported
                .and_then(|info| info.get("name"))
                .and_then(|value| value.as_str()),
            reported
                .and_then(|info| info.get("version"))
                .and_then(|value| value.as_str()),
        )
}

pub(in crate::acp_client) fn verified(agent: &AgentRow, store: &MetaStore, data: &Path) -> bool {
    eligible(agent) && auth_route::verified_copilot_package(agent, store, data)
}

pub(in crate::acp_client) fn unavailable() -> ServiceCapability {
    ServiceCapability {
        api_types: vec![],
        validated_api_types: vec![],
        selection_scope: "connection",
        unavailable_reason: Some(UNAVAILABLE),
        endpoint_rules: vec![],
    }
}

pub(super) fn capability(agent: &AgentRow) -> ServiceCapability {
    if !eligible(agent) {
        return unavailable();
    }
    ServiceCapability {
        api_types: vec!["chat-completions", "responses", "messages"],
        validated_api_types: vec!["chat-completions"],
        selection_scope: "connection",
        unavailable_reason: None,
        endpoint_rules: vec![MESSAGES_ENDPOINT],
    }
}

pub(in crate::acp_client) fn verify_runtime(handshake: &Handshake) -> Result<(), String> {
    let info = handshake.typed.agent_info.as_ref();
    if supported_runtime(
        info.map(|value| value.name.as_str()),
        info.map(|value| value.version.as_str()),
    ) {
        Ok(())
    } else {
        Err(UNAVAILABLE.into())
    }
}

pub(in crate::acp_client) fn require_explicit_model(model: &str) -> Result<(), String> {
    if model.trim().eq_ignore_ascii_case("auto") {
        return Err("请为 GitHub Copilot 的此项 API 选择一个具体模型".into());
    }
    Ok(())
}

pub(super) fn compile(
    service: &ServiceSnapshot,
    inherited: &HashMap<String, String>,
) -> Result<LaunchConfig, String> {
    if has_launch_conflict(inherited, std::env::vars_os()) {
        return Err("所选 API 与已有 GitHub Copilot 环境设置冲突，请检查后重试".into());
    }
    let mut endpoint = crate::credentials::validate_endpoint(&service.endpoint)?;
    let (provider_type, wire_api) = match service.api_type.as_str() {
        "chat-completions" => ("openai", "completions"),
        "responses" => ("openai", "responses"),
        "messages" => {
            let request_base = crate::api_endpoint::base_url(&endpoint, "messages")?;
            // Copilot appends /v1/messages itself. Keep the request path of
            // this saved service exact, including repeated prefix segments.
            endpoint = request_base
                .strip_suffix(MESSAGES_ENDPOINT.required_path_suffix)
                .ok_or("GitHub Copilot 需要以 /v1 结尾的 Messages 基础地址")?
                .to_owned();
            ("anthropic", "completions")
        }
        _ => return Err("这个 Agent 不支持所选 API 接口，请选择兼容的配置".into()),
    };
    let model = service.identity.model.clone();
    require_explicit_model(&model)?;
    Ok(LaunchConfig {
        // Explicitly choose the tested legacy environment route for this
        // process. A /dev/null provider list is empty and needs no config file.
        env_overrides: vec![
            ("COPILOT_PROVIDERS_CONFIG".into(), "/dev/null".into()),
            ("COPILOT_PROVIDER_BASE_URL".into(), endpoint),
            ("COPILOT_PROVIDER_TYPE".into(), provider_type.into()),
            ("COPILOT_PROVIDER_WIRE_API".into(), wire_api.into()),
            ("COPILOT_PROVIDER_API_KEY".into(), service.secret.clone()),
            ("COPILOT_MODEL".into(), model.clone()),
        ],
        delivery: None,
        model_id: model,
    })
}

fn conflicts(name: &str, disables_tls: bool) -> bool {
    name.starts_with("COPILOT_PROVIDER_")
        || matches!(
            name,
            "COPILOT_PROVIDERS_CONFIG" | "NODE_OPTIONS" | "NODE_PATH" | "DYLD_INSERT_LIBRARIES"
        )
        || (name == "NODE_TLS_REJECT_UNAUTHORIZED" && disables_tls)
}

fn has_launch_conflict(
    explicit: &HashMap<String, String>,
    parent: impl Iterator<Item = (OsString, OsString)>,
) -> bool {
    explicit
        .iter()
        .any(|(name, value)| conflicts(name, value == "0"))
        // Command inherits parent entries that the login-shell snapshot and
        // Agent overrides did not supply.
        || parent
            .filter_map(|(name, value)| Some((name.into_string().ok()?, value)))
            .any(|(name, value)| !explicit.contains_key(&name) && conflicts(&name, value == "0"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::ServiceIdentity;
    use serde_json::json;

    fn row(runtime: &str) -> AgentRow {
        AgentRow {
            id: "registry:github-copilot-cli".into(),
            source: "registry".into(),
            name: "Fixture".into(),
            command: "/fixture/bin/node".into(),
            args: vec!["/fixture/npm-loader.js".into(), "--acp".into()],
            env: vec![],
            version: Some("1.0.112".into()),
            handshake: Some(json!({"agentInfo":{"name":"Copilot","version":runtime}})),
            created_at: 0,
            updated_at: 0,
        }
    }

    fn snapshot() -> ServiceSnapshot {
        ServiceSnapshot {
            identity: ServiceIdentity {
                id: "service".into(),
                fingerprint: "fixture".into(),
                model: "fixture-model".into(),
            },
            endpoint: "https://fixture.test/prefix/v1".into(),
            api_type: "chat-completions".into(),
            models: vec!["fixture-model".into()],
            secret: "synthetic-key".into(),
            connection_revision: "revision".into(),
        }
    }

    #[test]
    fn checks_parent_variables_omitted_by_the_login_shell() {
        let fixtures = [
            ("NODE_OPTIONS", "sentinel"),
            ("COPILOT_PROVIDER_API_KEY_COMMAND", "sentinel"),
            ("NODE_TLS_REJECT_UNAUTHORIZED", "0"),
        ];
        for (name, value) in fixtures {
            let explicit = HashMap::from([("PATH".to_owned(), "/usr/bin".to_owned())]);
            assert!(has_launch_conflict(
                &explicit,
                [(name.into(), value.into())].into_iter()
            ));
        }
        let explicit = HashMap::from([("NODE_TLS_REJECT_UNAUTHORIZED".to_owned(), "1".to_owned())]);
        assert!(!has_launch_conflict(
            &explicit,
            [("NODE_TLS_REJECT_UNAUTHORIZED".into(), "0".into())].into_iter()
        ));
    }

    #[test]
    fn offers_only_the_reviewed_platform_program_and_reported_runtime() {
        for version in ["1.0.112", "1.0.114"] {
            let agent = row(version);
            let capability = super::super::capability(&agent);
            if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
                assert_eq!(
                    capability.api_types,
                    ["chat-completions", "responses", "messages"]
                );
                assert_eq!(capability.validated_api_types, ["chat-completions"]);
                assert_eq!(
                    serde_json::to_value(&capability).unwrap()["endpointRules"],
                    json!([{
                        "apiType":"messages",
                        "requiredPathSuffix":"/v1",
                        "allowedExactEndpoints":["https://api.anthropic.com"]
                    }])
                );
            } else {
                assert!(capability.api_types.is_empty());
                assert!(capability.validated_api_types.is_empty());
            }
        }
        let mut agent = row("1.0.115");
        assert!(super::super::capability(&agent).api_types.is_empty());
        agent.handshake = None;
        assert!(super::super::capability(&agent).api_types.is_empty());
        agent = row("1.0.114");
        agent.source = "custom".into();
        assert!(super::super::capability(&agent).api_types.is_empty());
    }

    #[test]
    fn actual_runtime_needs_the_matching_identity_before_ready() {
        for (name, version, is_reviewed) in [
            ("Copilot", "1.0.112", true),
            ("Copilot", "1.0.114", true),
            ("Copilot", "1.0.115", false),
            ("Other", "1.0.114", false),
        ] {
            let handshake = Handshake::decode(json!({
                "protocolVersion":1,
                "agentInfo":{"name":name,"version":version}
            }))
            .unwrap();
            assert_eq!(verify_runtime(&handshake).is_ok(), is_reviewed);
        }
    }

    #[test]
    fn delivers_the_selected_https_api_only_to_the_connection_environment() {
        let selected = snapshot();
        let inherited = HashMap::from([
            ("COPILOT_MODEL".into(), "original-model".into()),
            ("COPILOT_HOME".into(), "/original/profile".into()),
            ("COPILOT_OFFLINE".into(), "false".into()),
        ]);
        let config = compile(&selected, &inherited).unwrap();
        assert_eq!(config.model_id, selected.identity.model);
        assert!(config.delivery.is_none());
        let additions: HashMap<_, _> = config.env_overrides.into_iter().collect();
        assert_eq!(additions["COPILOT_MODEL"], selected.identity.model);
        assert_eq!(additions["COPILOT_PROVIDER_BASE_URL"], selected.endpoint);
        assert_eq!(additions["COPILOT_PROVIDER_API_KEY"], selected.secret);
        assert_eq!(additions["COPILOT_PROVIDER_TYPE"], "openai");
        assert_eq!(additions["COPILOT_PROVIDER_WIRE_API"], "completions");
        assert_eq!(additions["COPILOT_PROVIDERS_CONFIG"], "/dev/null");
        assert_eq!(additions.len(), 6);
        assert_eq!(inherited["COPILOT_MODEL"], "original-model");
    }

    #[test]
    fn rejects_existing_router_sources_and_insecure_delivery() {
        let selected = snapshot();
        for key in [
            "COPILOT_PROVIDERS_CONFIG",
            "COPILOT_PROVIDER_API_KEY_COMMAND",
            "COPILOT_PROVIDER_GHES_HOST",
            "COPILOT_PROVIDER_BEARER_TOKEN",
            "COPILOT_PROVIDER_HEADERS",
            "COPILOT_PROVIDER_WIRE_MODEL",
            "COPILOT_PROVIDER_WIRE_API",
            "NODE_OPTIONS",
            "NODE_PATH",
            "DYLD_INSERT_LIBRARIES",
            "NODE_TLS_REJECT_UNAUTHORIZED",
        ] {
            let inherited = HashMap::from([(key.into(), "0".into())]);
            let error = compile(&selected, &inherited).err().unwrap();
            assert!(!error.contains(&selected.secret));
            assert!(error.contains("冲突"));
        }
        let mut insecure = selected;
        for endpoint in [
            "http://localhost:10002/v1",
            "https://user:secret@example.test",
        ] {
            insecure.endpoint = endpoint.into();
            assert!(compile(&insecure, &HashMap::new()).is_err());
        }
    }

    #[test]
    fn a_reserved_auto_choice_cannot_stand_in_for_the_api_model() {
        let mut selected = snapshot();
        selected.identity.model = "Auto".into();
        selected.models = vec![selected.identity.model.clone()];
        assert!(compile(&selected, &HashMap::new()).is_err());
        assert!(require_explicit_model("org/auto").is_ok());
    }

    #[test]
    fn responses_use_the_validated_base_without_messages_path_changes() {
        let mut selected = snapshot();
        selected.api_type = "responses".into();
        for endpoint in [
            "https://fixture.test/prefix",
            "https://fixture.test/prefix/v1",
        ] {
            selected.endpoint = endpoint.into();
            let config = compile(&selected, &HashMap::new()).unwrap();
            let additions: HashMap<_, _> = config.env_overrides.into_iter().collect();
            assert_eq!(additions["COPILOT_PROVIDER_BASE_URL"], endpoint);
            assert_eq!(additions["COPILOT_PROVIDER_TYPE"], "openai");
            assert_eq!(additions["COPILOT_PROVIDER_WIRE_API"], "responses");
        }
    }

    #[test]
    fn messages_keep_the_same_request_path_as_a_direct_api_test() {
        let mut selected = snapshot();
        selected.api_type = "messages".into();
        for (saved, launch) in [
            ("https://api.anthropic.com", "https://api.anthropic.com"),
            (
                "https://API.antHropic.com:443/",
                "https://api.anthropic.com",
            ),
            (
                "https://fixture.test/prefix/v1/",
                "https://fixture.test/prefix",
            ),
            (
                "https://fixture.test:9443/prefix/v1",
                "https://fixture.test:9443/prefix",
            ),
            ("https://fixture.test/v1/v1", "https://fixture.test/v1"),
        ] {
            selected.endpoint = saved.into();
            let config = compile(&selected, &HashMap::new()).unwrap();
            let additions: HashMap<_, _> = config.env_overrides.into_iter().collect();
            assert_eq!(additions["COPILOT_PROVIDER_BASE_URL"], launch);
            assert_eq!(additions["COPILOT_PROVIDER_TYPE"], "anthropic");
            assert_eq!(additions["COPILOT_PROVIDER_WIRE_API"], "completions");
            let base = crate::credentials::validate_endpoint(saved).unwrap();
            let base = crate::api_endpoint::base_url(&base, "messages").unwrap();
            assert_eq!(format!("{launch}/v1/messages"), format!("{base}/messages"));
        }
    }

    #[test]
    fn messages_reject_bases_that_would_change_the_request_path() {
        let mut selected = snapshot();
        selected.api_type = "messages".into();
        for endpoint in [
            "https://api.anthropic.com:9443",
            "https://api.anthropic.com/prefix",
            "https://fixture.test.v1",
            "https://fixture.test/prefix/v1/other",
            "https://fixture.test/prefix/v10",
            "https://fixture.test/prefix/v%31",
        ] {
            selected.endpoint = endpoint.into();
            assert!(compile(&selected, &HashMap::new()).is_err(), "{endpoint}");
        }
    }
}
