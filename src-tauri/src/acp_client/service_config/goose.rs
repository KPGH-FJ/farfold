//! The verified official Goose OpenAI route can talk only to its Farfold relay.
use std::{collections::HashMap, path::Path};

use serde_json::Value;

use super::{ServiceCapability, goose_relay::Relay};
use crate::{
    acp_client::handshake::Handshake,
    installations::Installation,
    managed_paths::{Layout, recorded_root},
    meta_store::{AgentRow, MetaStore},
};

pub(in crate::acp_client) const AGENT_ID: &str = "registry:goose";
pub(in crate::acp_client) const PROVIDER_OPTION: &str = "provider";
pub(in crate::acp_client) const UNAVAILABLE: &str =
    "当前 Goose 程序未确认可使用已存 API，可继续沿用已有设置";
pub(in crate::acp_client) const PROVIDER_CHANGED: &str =
    "Goose 未确认使用所选 API 的提供方，请检查设置后重试";
const VERSION: &str = "1.59.1";

pub(in crate::acp_client) fn registered(row: &AgentRow) -> bool {
    row.source == "registry" && row.id == AGENT_ID
}

fn supported(name: Option<&str>, version: Option<&str>) -> bool {
    name == Some("goose") && version == Some(VERSION)
}

fn eligible(row: &AgentRow) -> bool {
    let info = row
        .handshake
        .as_ref()
        .and_then(|value| value.get("agentInfo"));
    cfg!(all(target_os = "macos", target_arch = "aarch64"))
        && registered(row)
        && row.version.as_deref() == Some(VERSION)
        && row.args == ["acp"]
        && supported(
            info.and_then(|value| value["name"].as_str()),
            info.and_then(|value| value["version"].as_str()),
        )
}

pub(in crate::acp_client) fn verified(row: &AgentRow, store: &MetaStore, data: &Path) -> bool {
    fn exact_installation(row: &AgentRow, store: &MetaStore, data: &Path) -> Option<()> {
        let entries: Vec<Installation> =
            serde_json::from_value(store.get_setting("installations.v1").ok()??).ok()?;
        let mut exact = entries.iter().filter(|entry| {
            entry.agent_id == row.id && entry.command == row.command && entry.args == row.args
        });
        let entry = exact.next()?;
        if exact.next().is_some()
            || entry.source != "managed"
            || entry.program_only
            || entry.version != row.version
        {
            return None;
        }
        let root = Path::new(entry.managed_root.as_deref()?);
        let root = recorded_root(data, &row.id, root, Layout::Agent, false)?;
        let command = root.join("goose");
        (command == Path::new(&row.command)
            && command.canonicalize().ok().as_ref() == Some(&command)
            && command.is_file())
        .then_some(())
    }
    eligible(row) && exact_installation(row, store, data).is_some()
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

pub(super) fn capability(row: &AgentRow) -> ServiceCapability {
    if !eligible(row) {
        return unavailable();
    }
    ServiceCapability {
        api_types: vec!["chat-completions"],
        validated_api_types: vec![],
        selection_scope: "connection",
        unavailable_reason: None,
        endpoint_rules: vec![],
    }
}

pub(in crate::acp_client) fn verify_runtime(handshake: &Handshake) -> Result<(), String> {
    let info = handshake.typed.agent_info.as_ref();
    supported(
        info.map(|value| value.name.as_str()),
        info.map(|value| value.version.as_str()),
    )
    .then_some(())
    .ok_or_else(|| UNAVAILABLE.into())
}

pub(in crate::acp_client) fn validate_provider(options: Option<&Value>) -> Result<(), String> {
    let entries = options.and_then(Value::as_array).ok_or(PROVIDER_CHANGED)?;
    let mut providers = entries
        .iter()
        .filter(|option| option["id"] == PROVIDER_OPTION);
    match providers.next() {
        Some(option)
            if providers.next().is_none()
                && option["type"] == "select"
                && option["currentValue"] == "openai" =>
        {
            Ok(())
        }
        _ => Err(PROVIDER_CHANGED.into()),
    }
}

pub(in crate::acp_client) fn prepare_environment(
    environment: &mut HashMap<String, String>,
    relay: &Relay,
    model: &str,
) {
    // The peer receives only a scoped relay token. The selected upstream key
    // is owned by the relay, and the official env route cannot reuse old auth.
    let inherited_no_proxy = ["NO_PROXY", "no_proxy"].into_iter().find_map(|key| {
        environment
            .get(key)
            .cloned()
            .or_else(|| std::env::var(key).ok())
    });
    let no_proxy = match inherited_no_proxy
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        Some(value) => format!("{value},127.0.0.1"),
        None => "127.0.0.1".into(),
    };
    environment.extend([
        ("GOOSE_PROVIDER".into(), "openai".into()),
        ("GOOSE_MODEL".into(), model.into()),
        ("OPENAI_HOST".into(), relay.base_url().into()),
        ("OPENAI_BASE_PATH".into(), "chat/completions".into()),
        ("OPENAI_API_KEY".into(), relay.token().into()),
        ("OPENAI_CUSTOM_HEADERS".into(), String::new()),
        ("OPENAI_ORGANIZATION".into(), String::new()),
        ("OPENAI_PROJECT".into(), String::new()),
        ("NO_PROXY".into(), no_proxy.clone()),
        ("no_proxy".into(), no_proxy),
    ]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_matching_model_does_not_substitute_for_the_exact_provider() {
        for actual in [
            Value::Null,
            json!([]),
            json!([
                {"id":"model", "category":"model", "currentValue":"fixture"},
                {"id":"provider", "type":"select", "currentValue":"openrouter"}
            ]),
            json!([
                {"id":"provider", "type":"select", "currentValue":"openai"},
                {"id":"provider", "type":"select", "currentValue":"openai"}
            ]),
        ] {
            assert!(validate_provider(Some(&actual)).is_err());
        }
        assert!(
            validate_provider(Some(&json!([
                {"id":"provider", "type":"select", "currentValue":"openai"}
            ])))
            .is_ok()
        );
    }
}
