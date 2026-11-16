use super::{Reason, Result};
use crate::{file_access, meta_store::AgentRow};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::PathBuf};

/// Immutable facts of the connection's selected launch. Secrets are not copied
/// into this structure. The digest only detects later registration changes.
#[derive(Clone)]
pub(crate) struct Source {
    pub(super) command: PathBuf,
    fingerprint: [u8; 32],
    entry_stamp: file_access::Stamp,
}
fn fingerprint(row: &AgentRow) -> [u8; 32] {
    let env: BTreeMap<_, _> = row.env.iter().map(|(k, v)| (k, v)).collect();
    let mut bytes = serde_json::to_vec(&(&row.id, &row.source, &row.command, &row.args, env))
        .unwrap_or_default();
    let digest = Sha256::digest(&bytes).into();
    bytes.fill(0);
    digest
}
impl Source {
    pub(crate) fn capture(row: &AgentRow) -> Option<Self> {
        let d = &super::super::recipes::FAST_HISTORY_EXPORT;
        let command = PathBuf::from(&row.command);
        if !cfg!(target_os = "macos")
            || row.source != "registry"
            || row.id != d.registry_id
            || row.args != ["-x"]
            || !command.is_absolute()
            || command.file_name()? != d.acp_entry
        {
            return None;
        }
        let file = super::launch::regular(&command).ok()?;
        Some(Self {
            command,
            fingerprint: fingerprint(row),
            entry_stamp: file_access::stamp(&file).ok()?,
        })
    }
    pub(super) fn current(&self, row: &AgentRow) -> Result<()> {
        if fingerprint(row) != self.fingerprint
            || file_access::stamp(&super::launch::regular(&self.command)?)
                .map_err(|_| Reason::Changed)?
                != self.entry_stamp
        {
            return Err(Reason::Changed);
        }
        Ok(())
    }
}
