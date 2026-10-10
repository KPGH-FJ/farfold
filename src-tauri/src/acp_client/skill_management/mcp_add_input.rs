//! New user input remains private RAM; the public review carries only its opaque ID.
use super::types::*;
use crate::acp_client::extension_inventory::mcp_targets::CatalogueSource;
use serde::{Deserialize, Serialize};
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    pub name: String,
    pub executable_path: String,
    pub args: Vec<String>,
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
fn invisible(c: char) -> bool {
    matches!(c as u32, 0x0..=0x1F | 0x7F..=0x9F | 0xAD | 0x34F | 0x600..=0x605 | 0x61C | 0x6DD | 0x70F | 0x890..=0x891 | 0x8E2 | 0x115F..=0x1160 | 0x17B4..=0x17B5 | 0x180B..=0x180F | 0x200B..=0x200F | 0x2028..=0x202E | 0x2060..=0x206F | 0x3164 | 0xD800..=0xDFFF | 0xFE00..=0xFE0F | 0xFEFF | 0xFFA0 | 0xFFF0..=0xFFFB | 0x110BD | 0x110CD | 0x13430..=0x1343F | 0x1BCA0..=0x1BCA3 | 0x1D173..=0x1D17A | 0xE0000..=0xE0FFF)
}

impl Input {
    pub fn validate(&self) -> Result<()> {
        if self.name.is_empty()
            || self.name.len() > 256
            || self.name.contains("..")
            || self.name == "codex_apps"
            || !self
                .name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        {
            return Err(Code::InvalidName.into());
        }
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
            name: self.input.name.clone(),
            transport: "stdio",
        }
    }
}
