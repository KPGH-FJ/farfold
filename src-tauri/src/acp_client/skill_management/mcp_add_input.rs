//! New user input remains private RAM; the public review carries only its opaque ID.
use super::types::*;
use crate::acp_client::extension_inventory::mcp_targets::CatalogueSource;
use serde::{Deserialize, Serialize};
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StdioInput {
    pub name: String,
    pub executable_path: String,
    pub args: Vec<String>,
}
// Untagged only at the outer legacy boundary: each branch rejects extra fields.
// No Debug implementation: the HTTP address and stdio arguments are private.
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum Input {
    Stdio(StdioInput),
    Http(HttpInput),
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HttpInput {
    pub transport: HttpTransport,
    pub name: String,
    pub url: String,
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
pub enum HttpTransport {
    #[serde(rename = "streamableHttp")]
    StreamableHttp,
}
impl From<StdioInput> for Input {
    fn from(value: StdioInput) -> Self {
        Self::Stdio(value)
    }
}
impl Input {
    pub fn name(&self) -> &str {
        match self {
            Self::Stdio(v) => &v.name,
            Self::Http(v) => &v.name,
        }
    }
    pub fn transport(&self) -> &'static str {
        match self {
            Self::Stdio(_) => "stdio",
            Self::Http(_) => "streamableHttp",
        }
    }
    pub fn mutation(&self) -> &'static str {
        match self {
            Self::Stdio(_) => "addDisabledStdioMcp",
            Self::Http(_) => "addDisabledHttpMcp",
        }
    }
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Stdio(v) => v.validate(),
            Self::Http(v) => {
                validate_name(&v.name)?;
                super::mcp_http_url::validate(&v.url)?;
                if serde_json::to_vec(self)
                    .map_err(|_| Code::InvalidUrl)?
                    .len()
                    > 32768
                {
                    return Err(Code::InvalidUrl.into());
                }
                Ok(())
            }
        }
    }
    pub fn entry(&self) -> serde_json::Value {
        match self {
            Self::Stdio(v) => {
                serde_json::json!({"command":v.executable_path,"args":v.args,"enabled":false})
            }
            Self::Http(v) => serde_json::json!({"url":v.url,"enabled":false}),
        }
    }
    pub fn matches_transport(&self, t: &serde_json::Value) -> bool {
        use serde_json::Value;
        let Some(fields) = t.as_object() else {
            return false;
        };
        let empty_object = |k: &str| {
            t.get(k)
                .is_none_or(|v| v.is_null() || v.as_object().is_some_and(|v| v.is_empty()))
        };
        match self {
            Self::Stdio(v) => {
                fields.keys().all(|k| {
                    ["type", "command", "args", "env", "env_vars", "cwd"].contains(&k.as_str())
                }) && t["type"] == "stdio"
                    && t["command"] == v.executable_path
                    && t["args"] == serde_json::json!(v.args)
                    && empty_object("env")
                    && t.get("env_vars")
                        .is_none_or(|v| v.is_null() || v.as_array().is_some_and(|v| v.is_empty()))
                    && t.get("cwd").is_none_or(Value::is_null)
            }
            Self::Http(v) => {
                fields.keys().all(|k| {
                    [
                        "type",
                        "url",
                        "bearer_token_env_var",
                        "http_headers",
                        "env_http_headers",
                        "http_headers_helper",
                    ]
                    .contains(&k.as_str())
                }) && t["type"] == "streamable_http"
                    && t["url"] == v.url
                    && t.get("bearer_token_env_var").is_none_or(Value::is_null)
                    && t.get("http_headers_helper").is_none_or(Value::is_null)
                    && empty_object("http_headers")
                    && empty_object("env_http_headers")
            }
        }
    }
}
fn validate_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 256
        || name.contains("..")
        || name == "codex_apps"
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    {
        return Err(Code::InvalidName.into());
    }
    Ok(())
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PublicTarget {
    pub kind: &'static str,
    pub inventory_request_id: String,
    pub input_id: String,
    pub name: String,
    pub transport: &'static str,
}
#[derive(Clone)]
pub(super) struct Source {
    pub catalogue: CatalogueSource,
    pub input_id: String,
    pub input: Input,
}
// Fixed input-control set shared with the frontend. It is not a general
// invisible-glyph or credential detector; no runtime Unicode version dependency.
pub(super) fn invisible(c: char) -> bool {
    matches!(c as u32, 0x0..=0x1F | 0x7F..=0x9F | 0xAD | 0x34F | 0x600..=0x605 | 0x61C | 0x6DD | 0x70F | 0x890..=0x891 | 0x8E2 | 0x115F..=0x1160 | 0x17B4..=0x17B5 | 0x180B..=0x180F | 0x200B..=0x200F | 0x2028..=0x202E | 0x2060..=0x206F | 0x3164 | 0xD800..=0xDFFF | 0xFE00..=0xFE0F | 0xFEFF | 0xFFA0 | 0xFFF0..=0xFFFB | 0x110BD | 0x110CD | 0x13430..=0x1343F | 0x1BCA0..=0x1BCA3 | 0x1D173..=0x1D17A | 0xE0000..=0xE0FFF)
}

impl StdioInput {
    pub fn validate(&self) -> Result<()> {
        validate_name(&self.name)?;
        let path = &self.executable_path;
        if path.len() > 4096
            || !path.starts_with('/')
            || path.chars().any(invisible)
            || path[1..]
                .split('/')
                .any(|s| s.is_empty() || s == "." || s == "..")
        {
            return Err(Code::InvalidExecutablePath.into());
        }
        if self.args.len() > 64
            || self
                .args
                .iter()
                .any(|s| s.len() > 1024 || s.chars().any(invisible))
            || self.args.iter().map(String::len).sum::<usize>() > 16384
            || serde_json::to_vec(self)
                .map_err(|_| Code::InvalidArguments)?
                .len()
                > 32768
        {
            return Err(Code::InvalidArguments.into());
        }
        Ok(())
    }
}
impl Source {
    pub fn public(&self) -> PublicTarget {
        PublicTarget {
            kind: "mcpAddition",
            inventory_request_id: self.catalogue.inventory_id.clone(),
            input_id: self.input_id.clone(),
            name: self.input.name().into(),
            transport: self.input.transport(),
        }
    }
}
