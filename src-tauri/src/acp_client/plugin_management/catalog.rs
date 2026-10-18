//! Bounded official CLI JSON. No source paths, URLs, or unknown values are public.
use super::types::*;
use crate::acp_client::extension_inventory::output;
use serde::de::{MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct Entry {
    pub plugin_id: String,
    pub name: String,
    pub marketplace_name: String,
    pub version: Option<String>,
    pub installed: bool,
    pub enabled: bool,
    pub source: Value,
    pub marketplace_source: Option<Value>,
    pub install_policy: String,
    pub auth_policy: String,
}
#[derive(Deserialize)]
struct Wire {
    installed: Vec<Entry>,
    available: Vec<Entry>,
}

// Value retains only the last occurrence of an object key. Validate the complete
// bounded document before constructing Values used for source identity checks.
struct UniqueKeys;
impl<'de> Deserialize<'de> for UniqueKeys {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct KeysVisitor;
        impl<'de> Visitor<'de> for KeysVisitor {
            type Value = UniqueKeys;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("JSON with unique object keys")
            }
            fn visit_bool<E: serde::de::Error>(
                self,
                _: bool,
            ) -> std::result::Result<UniqueKeys, E> {
                Ok(UniqueKeys)
            }
            fn visit_i64<E: serde::de::Error>(self, _: i64) -> std::result::Result<UniqueKeys, E> {
                Ok(UniqueKeys)
            }
            fn visit_u64<E: serde::de::Error>(self, _: u64) -> std::result::Result<UniqueKeys, E> {
                Ok(UniqueKeys)
            }
            fn visit_f64<E: serde::de::Error>(self, _: f64) -> std::result::Result<UniqueKeys, E> {
                Ok(UniqueKeys)
            }
            fn visit_str<E: serde::de::Error>(self, _: &str) -> std::result::Result<UniqueKeys, E> {
                Ok(UniqueKeys)
            }
            fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<UniqueKeys, E> {
                Ok(UniqueKeys)
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> std::result::Result<UniqueKeys, A::Error> {
                while seq.next_element::<UniqueKeys>()?.is_some() {}
                Ok(UniqueKeys)
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<UniqueKeys, A::Error> {
                let mut keys = HashSet::new();
                while let Some(key) = map.next_key::<String>()? {
                    if !keys.insert(key) {
                        return Err(serde::de::Error::custom("duplicate JSON field"));
                    }
                    map.next_value::<UniqueKeys>()?;
                }
                Ok(UniqueKeys)
            }
        }
        deserializer.deserialize_any(KeysVisitor)
    }
}

fn segment(s: &str, dotted: bool) -> bool {
    !s.is_empty()
        && s.len() <= 256
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_') || dotted && c == b'.')
        && (!dotted || !s.starts_with('.') && !s.ends_with('.') && !s.contains(".."))
}
impl Entry {
    pub fn selector(&self) -> Result<String> {
        if !segment(&self.name, true)
            || !segment(&self.marketplace_name, false)
            || self.plugin_id != format!("{}@{}", self.name, self.marketplace_name)
        {
            return Err(Code::InvalidName.into());
        }
        Ok(self.plugin_id.clone())
    }
    fn source_kind(&self) -> &'static str {
        match self.source.get("source").and_then(Value::as_str) {
            Some("local") => "local",
            Some("git") => "git",
            Some("git-subdir") => "gitSubdir",
            Some("npm") => "npm",
            Some("remote") => "remote",
            _ => "unknown",
        }
    }
    fn configured(&self) -> bool {
        self.marketplace_source.as_ref().is_some_and(|v| {
            v.as_object().is_some_and(|v| {
                v.get("sourceType")
                    .and_then(Value::as_str)
                    .is_some_and(|s| matches!(s, "local" | "git"))
                    && v.get("source").and_then(Value::as_str).is_some_and(|s| {
                        !s.is_empty() && s.len() <= 4096 && !s.chars().any(char::is_control)
                    })
            })
        })
    }
    fn source_known(&self) -> bool {
        let text = |key: &str| {
            self.source
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(|s| {
                    !s.is_empty() && s.len() <= 4096 && !s.chars().any(char::is_control)
                })
        };
        match self.source_kind() {
            "local" => text("path"),
            "git" => text("url"),
            "gitSubdir" => text("url") && text("path"),
            "npm" => text("package"),
            _ => false,
        }
    }
    fn reason(&self, install: bool) -> Option<&'static str> {
        if self.selector().is_err() {
            Some("unsafeLabel")
        } else if !self.source_known() {
            Some("unsupportedSource")
        } else if !self.configured() {
            Some("notConfiguredSource")
        } else if !matches!(
            self.install_policy.as_str(),
            "AVAILABLE" | "INSTALLED_BY_DEFAULT" | "NOT_AVAILABLE"
        ) || !matches!(self.auth_policy.as_str(), "ON_INSTALL" | "ON_USE")
        {
            Some("unknownPolicy")
        } else if install && self.install_policy == "NOT_AVAILABLE" {
            Some("notAvailable")
        } else if install && self.installed {
            Some("alreadyInstalled")
        } else if !install && !self.installed {
            Some("notInstalled")
        } else {
            None
        }
    }
    pub fn admitted(&self, install: bool) -> Result<()> {
        self.reason(install)
            .map_or(Ok(()), |_| Err(Code::TargetUnavailable.into()))
    }
    pub fn item(&self, id: usize) -> PluginItem {
        let availability = |install| {
            let reason = self.reason(install);
            Availability {
                availability: if reason.is_none() {
                    "available"
                } else {
                    "unavailable"
                },
                reason,
            }
        };
        PluginItem {
            id,
            name: output::safe_name(&self.name),
            marketplace_name: output::safe_name(&self.marketplace_name),
            version: self.version.as_deref().and_then(output::safe_name),
            reported_installed: self.installed,
            reported_enabled: self.enabled,
            source: self.source_kind(),
            install_policy: match self.install_policy.as_str() {
                "AVAILABLE" => "available",
                "INSTALLED_BY_DEFAULT" => "installedByDefault",
                "NOT_AVAILABLE" => "notAvailable",
                _ => "unknown",
            },
            auth_policy: match self.auth_policy.as_str() {
                "ON_INSTALL" => "onInstall",
                "ON_USE" => "onUse",
                _ => "unknown",
            },
            install: availability(true),
            remove: availability(false),
        }
    }
    pub fn same_origin(&self, other: &Self) -> bool {
        self.plugin_id == other.plugin_id
            && self.name == other.name
            && self.marketplace_name == other.marketplace_name
            && self.source == other.source
            && self.marketplace_source == other.marketplace_source
            && self.install_policy == other.install_policy
            && self.auth_policy == other.auth_policy
    }
}
pub(super) fn parse(bytes: &[u8]) -> Result<Vec<Entry>> {
    if bytes.len() > output::STDOUT_LIMIT {
        return Err(Code::OutputLimit.into());
    }
    if !output::bounded_depth(bytes) {
        return Err(Code::InvalidOutput.into());
    }
    serde_json::from_slice::<UniqueKeys>(bytes).map_err(|_| Code::InvalidOutput)?;
    let wire: Wire = serde_json::from_slice(bytes).map_err(|_| Code::InvalidOutput)?;
    if wire.installed.len().saturating_add(wire.available.len()) > 512 {
        return Err(Code::OutputLimit.into());
    }
    if wire.installed.iter().any(|v| !v.installed) || wire.available.iter().any(|v| v.installed) {
        return Err(Code::InvalidOutput.into());
    }
    let mut ids = HashSet::new();
    let entries: Vec<_> = wire.installed.into_iter().chain(wire.available).collect();
    for entry in &entries {
        if entry.plugin_id.len() > 513 || !ids.insert(&entry.plugin_id) {
            return Err(Code::InvalidOutput.into());
        }
    }
    Ok(entries)
}
pub(super) fn exact<'a>(entries: &'a [Entry], target: &Entry) -> Result<&'a Entry> {
    entries
        .iter()
        .find(|v| v.plugin_id == target.plugin_id)
        .ok_or_else(|| Code::InventoryIncomplete.into())
}
pub(super) fn public(entries: &[Entry]) -> PluginCatalog {
    PluginCatalog {
        observed_at_ms: now_ms(),
        scope: SCOPE,
        source: "officialCli",
        complete: false,
        session_applicability: "unverified",
        items: entries.iter().enumerate().map(|(i, v)| v.item(i)).collect(),
    }
}
