//! The Windows material section of the ONE recovery manifest. Data, never a
//! native capability: every entry must still match the held carrier on reopen.
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub(crate) const MAX_NODES: usize = crate::file_access::MIXED_TREE_NODE_LIMIT;
const BLOCK: u64 = 65_536;
const MAX_STREAM: u64 = 256 * 1024 * 1024;
const MAX_CARRIER: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum MaterialKind {
    Directory,
    Regular,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MaterialStream {
    pub name: Vec<u16>,
    pub bytes: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MaterialEa {
    pub count: u64,
    pub logical_bytes: u64,
    pub sha256: [u8; 32],
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MaterialSecurity {
    pub aces: u64,
    pub returned_bytes: u64,
    pub sha256: [u8; 32],
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MaterialNode {
    pub kind: MaterialKind,
    pub source_volume: u64,
    pub source_file_id: [u8; 16],
    pub semantic_sha256: [u8; 32],
    pub streams: Vec<MaterialStream>,
    pub ea: MaterialEa,
    pub security: MaterialSecurity,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MaterialContent {
    pub nodes: u32,
    pub bytes: u64,
    pub sha256: [u8; 32],
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WindowsMaterial {
    pub version: u32,
    pub volume: u64,
    pub file_id: [u8; 16],
    pub bytes: u64,
    pub sha256: [u8; 32],
    pub tree_sha256: [u8; 32],
    pub content: MaterialContent,
    pub nodes: Vec<MaterialNode>,
}
impl WindowsMaterial {
    pub(crate) fn validate(&self) -> bool {
        if self.version != 1
            || self.file_id == [0; 16]
            || !(16..=MAX_CARRIER).contains(&self.bytes)
            || self.content.nodes == 0
            || self.content.nodes as usize > self.nodes.len()
            || self.content.bytes > MAX_CARRIER
            || self.nodes.is_empty()
            || self.nodes.len() > MAX_NODES
            || self.nodes[0].kind != MaterialKind::Directory
        {
            return false;
        }
        let mut identities = BTreeSet::new();
        let mut resident = 0usize;
        for node in &self.nodes {
            if node.source_file_id == [0; 16]
                || !identities.insert((node.source_volume, node.source_file_id))
                || node.streams.len() > BLOCK as usize / 24
                || node.ea.logical_bytes > BLOCK
                || node.ea.count > BLOCK / 8
                || !(20..=BLOCK).contains(&node.security.returned_bytes)
                || node.security.aces > node.security.returned_bytes / 8
            {
                return false;
            }
            let mut names = 0usize;
            let mut previous: Option<&[u16]> = None;
            for stream in &node.streams {
                // The producer's BTreeMap order is retained. Native ordinal
                // case/alias checks are repeated by the Windows reader.
                if previous.is_some_and(|p| p >= stream.name.as_slice())
                    || stream.name.contains(&0)
                    || stream.bytes > MAX_STREAM
                {
                    return false;
                }
                previous = Some(&stream.name);
                let Some(next) = names.checked_add(stream.name.len().saturating_mul(2)) else {
                    return false;
                };
                names = next;
                if names > BLOCK as usize {
                    return false;
                }
            }
            let has_default = node.streams.first().is_some_and(|s| s.name.is_empty());
            if has_default != (node.kind == MaterialKind::Regular) {
                return false;
            }
            let Some(next) = resident.checked_add(names + node.streams.len() * 256 + 4096) else {
                return false;
            };
            resident = next;
            if resident > 8 * 1024 * 1024 {
                return false;
            }
        }
        true
    }
}

#[cfg(test)]
#[path = "recovery_material_manifest_tests.rs"]
mod tests;
