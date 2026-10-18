//! Official source discovery. Roots and provenance remain private RAM facts.
use super::{catalog, types::*};
use crate::acp_client::extension_inventory::output;
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

// Public CLI dispatches this reserved name to its remote global catalog.
// Official core-plugins/src/remote.rs: REMOTE_GLOBAL_MARKETPLACE_NAME.
const REMOTE_GLOBAL: &str = "openai-curated-remote";

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct Marketplace {
    pub name: String,
    pub root: String,
    pub marketplace_source: Option<Value>,
    #[serde(skip)]
    ambiguous: bool,
}
#[derive(Deserialize)]
struct Wire {
    marketplaces: Vec<Marketplace>,
}
impl Marketplace {
    fn kind(&self) -> &'static str {
        match self
            .marketplace_source
            .as_ref()
            .and_then(|v| v.get("sourceType"))
            .and_then(Value::as_str)
        {
            Some("local") => "local",
            Some("git") => "git",
            Some("remote") => "remote",
            _ => "unknown",
        }
    }
    fn reason(&self) -> Option<&'static str> {
        if !catalog::marketplace_name(&self.name) {
            Some("unsafeLabel")
        } else if self.root.len() > 4096
            || !Path::new(&self.root).is_absolute()
            || self.root.chars().any(char::is_control)
        {
            Some("invalidSource")
        } else if self.ambiguous {
            Some("ambiguousSource")
        } else if self.name == REMOTE_GLOBAL {
            Some("unsupportedSource")
        } else {
            None
        }
    }
    pub fn admitted(&self) -> Result<()> {
        self.reason()
            .map_or(Ok(()), |_| Err(Code::TargetUnavailable.into()))
    }
    fn item(&self, id: usize) -> PluginSourceItem {
        let reason = self.reason();
        PluginSourceItem {
            id,
            name: output::safe_name(&self.name),
            kind: self.kind(),
            query: Availability {
                availability: if reason.is_none() {
                    "available"
                } else {
                    "unavailable"
                },
                reason,
            },
        }
    }
}
pub(super) fn parse(bytes: &[u8]) -> Result<Vec<Marketplace>> {
    catalog::validate(bytes)?;
    let mut wire: Wire = serde_json::from_slice(bytes).map_err(|_| Code::InvalidOutput)?;
    if wire.marketplaces.len() > 512 {
        return Err(Code::OutputLimit.into());
    }
    let mut roots = HashSet::new();
    let mut names = HashMap::new();
    for row in &wire.marketplaces {
        if !roots.insert(&row.root)
            || row
                .marketplace_source
                .as_ref()
                .is_some_and(|v| !v.is_object())
        {
            return Err(Code::InvalidOutput.into());
        }
        *names.entry(row.name.clone()).or_insert(0usize) += 1;
    }
    for row in &mut wire.marketplaces {
        row.ambiguous = names[&row.name] > 1;
    }
    Ok(wire.marketplaces)
}
pub(super) fn current(rows: &[Marketplace], original: &Marketplace) -> Result<()> {
    let mut matches = rows.iter().filter(|v| v.name == original.name);
    let current = matches.next().ok_or(Code::TargetChanged)?;
    if matches.next().is_some() || current != original || current.admitted().is_err() {
        return Err(Code::TargetChanged.into());
    }
    Ok(())
}
pub(super) fn public(rows: &[Marketplace]) -> PluginSourceCatalog {
    PluginSourceCatalog {
        observed_at_ms: now_ms(),
        scope: SCOPE,
        source: "officialCli",
        complete: false,
        session_applicability: "unverified",
        items: rows
            .iter()
            .enumerate()
            .map(|(id, row)| row.item(id))
            .collect(),
    }
}
