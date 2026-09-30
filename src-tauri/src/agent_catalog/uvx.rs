//! Typed validation of a retained registry tool declaration. This accepts the
//! exact named-package forms currently published by the directory; arbitrary
//! requirements, URLs and shell fragments stay unexecuted and discoverable.
use std::collections::BTreeMap;

use serde::Deserialize;

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(default)]
pub(crate) struct RegistryUvx {
    pub package: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    #[serde(flatten)]
    pub other: BTreeMap<String, serde_json::Value>,
}

impl RegistryUvx {
    pub(crate) fn decode(value: &serde_json::Value) -> Option<Self> {
        let declaration: Self = serde_json::from_value(value.clone()).ok()?;
        UvxPackage::parse(&declaration.package).ok()?;
        if declaration.env.contains_key("HOME")
            || declaration.env.keys().any(|key| {
                key.is_empty()
                    || !key.bytes().enumerate().all(|(index, byte)| {
                        byte == b'_'
                            || byte.is_ascii_alphabetic()
                            || (index > 0 && byte.is_ascii_digit())
                    })
            })
            || declaration.args.iter().any(|arg| arg.contains('\0'))
            || declaration.env.values().any(|value| value.contains('\0'))
        {
            return None;
        }
        Some(declaration)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct UvxPackage {
    pub name: String,
    pub version: String,
    pub requirement: String,
    pub script: String,
}

/// PEP 503 name normalization, also the default command used by these tools.
pub(crate) fn normalized_name(name: &str) -> String {
    let mut result = String::new();
    for byte in name.bytes() {
        if b"-_.".contains(&byte) {
            if !result.ends_with('-') {
                result.push('-');
            }
        } else {
            result.push(byte.to_ascii_lowercase() as char);
        }
    }
    result
}

impl UvxPackage {
    pub(crate) fn parse(package: &str) -> Result<Self, String> {
        let unsupported = || "此安装声明的包格式尚不能使用，请查看官方说明".to_string();
        let (name, version) = package
            .split_once("==")
            .or_else(|| package.split_once('@'))
            .ok_or_else(unsupported)?;
        if name.is_empty()
            || name.len() > 200
            || !name.as_bytes()[0].is_ascii_alphanumeric()
            || !name.as_bytes()[name.len() - 1].is_ascii_alphanumeric()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
            || version.is_empty()
            || version.len() > 128
            || !version.as_bytes()[0].is_ascii_digit()
            || !version
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b".!+_-".contains(&byte))
        {
            return Err(unsupported());
        }
        let normalized = normalized_name(name);
        Ok(Self {
            requirement: format!("{name}=={version}"),
            name: normalized.clone(),
            script: normalized,
            version: version.into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_exact_tool_syntax_becomes_an_install_requirement() {
        let minion = UvxPackage::parse("minion-code@0.1.44").unwrap();
        assert_eq!(minion.requirement, "minion-code==0.1.44");
        assert_eq!(minion.script, "minion-code");
        let fast = UvxPackage::parse("fast-agent-acp==0.10.1").unwrap();
        assert_eq!(fast.requirement, "fast-agent-acp==0.10.1");
        assert_eq!(fast.script, "fast-agent-acp");
        assert_eq!(normalized_name("Example__Tool.Name"), "example-tool-name");
    }

    #[test]
    fn arbitrary_requirements_never_become_executable_install_options() {
        for declaration in [
            "",
            "--index-url",
            "name",
            "name@latest",
            "name>=1",
            "../name==1",
            "name @ https://example.test/name.whl",
            "name==1 --system",
            "name==",
            "name==1\0",
            "name==1;touch /tmp/file",
            "name==1.*",
            "name===1",
            "name[extra]==1",
        ] {
            assert!(UvxPackage::parse(declaration).is_err(), "{declaration:?}");
        }
    }

    #[test]
    fn unknown_fields_are_retained_and_private_home_is_rejected() {
        let declaration = serde_json::json!({"package":"example==1.0", "args":["acp"],
            "env":{"MODEL":"default"}, "unknown":{"capability":true}});
        let parsed = RegistryUvx::decode(&declaration).unwrap();
        assert_eq!(parsed.other["unknown"], declaration["unknown"]);
        assert_eq!(parsed.env["MODEL"], "default");
        for declaration in [
            serde_json::json!({"package":"example==1.0", "env":{"HOME":"/private"}}),
            serde_json::json!({"package":"example==1.0", "env":{"INVALID=ENV":"value"}}),
            serde_json::json!({"package":"example==1.0", "args":"acp"}),
        ] {
            assert!(RegistryUvx::decode(&declaration).is_none());
        }
    }
}
