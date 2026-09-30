//! Reviewed public startup values, compiled into the existing candidate argv.
//! No execution, credential lookup, private HOME or independent parameter store.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    agent_catalog::{AgentLaunch, RegistryAgent},
    meta_store::AgentRow,
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallationField {
    pub id: String,
    pub label: String,
    pub argument: String,
    pub value_kind: &'static str,
    pub required: bool,
    pub source_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub catalog_default_value: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallationOptions {
    pub declaration_id: String,
    pub registry_version: String,
    pub launch: AgentLaunch,
    pub fields: Vec<InstallationField>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_values: Option<BTreeMap<String, String>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallationInput {
    pub declaration_id: String,
    pub registry_version: String,
    #[serde(deserialize_with = "reviewed_launch")]
    pub launch: AgentLaunch,
    #[serde(deserialize_with = "unique_values")]
    pub values: BTreeMap<String, String>,
}

fn reviewed_launch<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<AgentLaunch, D::Error> {
    #[derive(Deserialize)]
    #[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
    enum ReviewedLaunch {
        Binary { binary: String, args: Vec<String> },
        Npx { package: String, args: Vec<String> },
        Uvx { package: String, args: Vec<String> },
    }
    Ok(match ReviewedLaunch::deserialize(deserializer)? {
        ReviewedLaunch::Binary { binary, args } => AgentLaunch::Binary { binary, args },
        ReviewedLaunch::Npx { package, args } => AgentLaunch::Npx { package, args },
        ReviewedLaunch::Uvx { package, args } => AgentLaunch::Uvx { package, args },
    })
}

fn unique_values<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<BTreeMap<String, String>, D::Error> {
    struct Values;
    impl<'de> serde::de::Visitor<'de> for Values {
        type Value = BTreeMap<String, String>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("public startup fields")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(
            self,
            mut map: M,
        ) -> Result<Self::Value, M::Error> {
            let mut values = BTreeMap::new();
            while let Some((key, value)) = map.next_entry::<String, String>()? {
                if values.len() >= 8 || values.insert(key, value).is_some() {
                    return Err(serde::de::Error::custom("启动参数输入格式无效"));
                }
            }
            Ok(values)
        }
    }
    deserializer.deserialize_map(Values)
}

/// A documented public subset, not an attempt to validate Agent model availability.
/// Full CLI query/URL syntax stays outside this field rather than being truncated.
pub(crate) fn public_model(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 256
        || value.trim() != value
        || value.get(..3).is_some_and(|prefix| {
            prefix.eq_ignore_ascii_case("sk-") || prefix.eq_ignore_ascii_case("sk_")
        })
        || value.contains("://")
    {
        return false;
    }
    let identifier = |value: &str| {
        value
            .as_bytes()
            .first()
            .is_some_and(|byte| byte.is_ascii_alphabetic() || *byte == b'_')
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
    };
    if let Some(reference) = value.strip_prefix('$') {
        return reference
            .split_once('.')
            .is_some_and(|(namespace, key)| identifier(namespace) && identifier(key));
    }
    value
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.:/+-".contains(&byte))
}

fn base_args(launch: &AgentLaunch) -> &[String] {
    match launch {
        AgentLaunch::Binary { args, .. }
        | AgentLaunch::Npx { args, .. }
        | AgentLaunch::Uvx { args, .. } => args,
    }
}

/// The public directory snapshot is review identity, not executable admission.
/// Registered user environment and credential references never enter this hash.
fn reviewed_directory(
    entry: &RegistryAgent,
    launch: &AgentLaunch,
    declaration: &super::recipes::InstallationParameterDeclaration,
) -> Option<(String, Option<String>)> {
    let uvx = crate::agent_catalog::RegistryUvx::decode(entry.distribution.uvx.as_ref()?)?;
    let bytes = serde_json::to_vec(&(&entry.id, &entry.version, launch, &uvx.env)).ok()?;
    let digest = Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let id = format!("{}:{digest}", declaration.id);
    let default = uvx
        .env
        .get(declaration.model_env)
        .filter(|value| public_model(value))
        .cloned();
    Some((id, default))
}

fn current_values(
    declaration: &super::recipes::InstallationParameterDeclaration,
    row: &AgentRow,
) -> Result<BTreeMap<String, String>, String> {
    let unsupported = || {
        "原程序包含尚不能完整保留的启动参数；原程序保持不变，请保留原方式或等待此安装方式支持"
            .to_string()
    };
    if row
        .args
        .iter()
        .map(String::as_str)
        .eq(declaration.launch_args.iter().copied())
    {
        return Ok(BTreeMap::new());
    }
    if super::recipes::previous_installation_parameter_declaration(row)
        .is_none_or(|previous| previous.id != declaration.id)
    {
        return Err(unsupported());
    }
    let base_count = declaration.launch_args.len();
    if row.args.len() != base_count + 2
        || !row.args[..base_count]
            .iter()
            .map(String::as_str)
            .eq(declaration.launch_args.iter().copied())
        || row.args[base_count] != declaration.argument
        || !public_model(&row.args[base_count + 1])
    {
        return Err(unsupported());
    }
    Ok(BTreeMap::from([(
        declaration.field_id.into(),
        row.args[base_count + 1].clone(),
    )]))
}

pub(crate) fn options(
    entry: &RegistryAgent,
    launch: &AgentLaunch,
    row: Option<&AgentRow>,
) -> Option<InstallationOptions> {
    let declaration = super::recipes::installation_parameter_declaration(entry, launch)?;
    let (declaration_id, catalog_default_value) = reviewed_directory(entry, launch, declaration)?;
    Some(InstallationOptions {
        declaration_id,
        registry_version: entry.version.clone(),
        launch: launch.clone(),
        fields: vec![InstallationField {
            id: declaration.field_id.into(),
            label: declaration.label.into(),
            argument: declaration.argument.into(),
            value_kind: "model",
            required: false,
            source_url: declaration.source_url.into(),
            catalog_default_value,
        }],
        current_values: row
            .and_then(|row| current_values(declaration, row).ok())
            .filter(|values| !values.is_empty()),
    })
}

pub(crate) fn compile_args(
    entry: &RegistryAgent,
    launch: &AgentLaunch,
    previous: Option<&AgentRow>,
    input: Option<&InstallationInput>,
) -> Result<Vec<String>, String> {
    let declaration = super::recipes::installation_parameter_declaration(entry, launch);
    let Some(declaration) = declaration else {
        if input.is_some() {
            return Err("启动参数声明已变化，请重新查看官方说明后准备；原设置保持不变".into());
        }
        if let Some(previous) = previous
            && let Some(old) = super::recipes::previous_installation_parameter_declaration(previous)
            && !previous
                .args
                .iter()
                .map(String::as_str)
                .eq(old.launch_args.iter().copied())
        {
            return Err(
                "新安装方式尚不能完整保留原启动参数；请继续使用原程序，待此方式支持后再更新".into(),
            );
        }
        return Ok(base_args(launch).to_vec());
    };
    if let Some(input) = input {
        let expected_id = reviewed_directory(entry, launch, declaration)
            .map(|(id, _)| id)
            .ok_or("无法核对目录启动设置，请重新查看后准备；原设置保持不变")?;
        if input.declaration_id != expected_id
            || input.registry_version != entry.version
            || input.launch != *launch
        {
            return Err("启动参数或目录发行已变化，请重新查看后准备；原设置保持不变".into());
        }
        if input
            .values
            .keys()
            .any(|field| field != declaration.field_id)
        {
            return Err("此启动参数尚未提供可使用的官方声明".into());
        }
        if input.values.values().any(|value| !public_model(value)) {
            return Err("启动模型仅支持 1–256 字符的公开名称或 $namespace.key 模型代号；请勿填写密钥、地址或查询参数".into());
        }
    }
    // A bare old API call may retain a corresponding saved literal. An explicit
    // reviewed empty values map means the user chose official existing settings.
    let saved = previous
        .map(|row| current_values(declaration, row))
        .transpose()?
        .unwrap_or_default();
    let values = input.map_or(&saved, |input| &input.values);
    let mut args = base_args(launch).to_vec();
    if let Some(value) = values.get(declaration.field_id) {
        args.extend([declaration.argument.into(), value.clone()]);
    }
    Ok(args)
}

#[cfg(test)]
mod tests;
