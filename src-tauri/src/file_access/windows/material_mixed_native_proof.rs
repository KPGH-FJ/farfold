//! Owned transient inventory from ACTUAL captured Facts, never wire authority.
use super::*;
use crate::file_access::{ea_records, full_security_records};
pub(in super::super) struct NativeProof {
    pub(in super::super) identity: Identity,
    pub(in super::super) kind: Kind,
    pub(in super::super) expected: records::Expected,
    pub(in super::super) ea: ea_records::Observation,
    pub(in super::super) security: full_security_records::Decoded,
    _memory: ResidentLease,
}
impl NativeProof {
    pub(super) fn from_facts(
        identity: &Identity,
        kind: Kind,
        expected: &records::Expected,
        ea: &ea_records::Observation,
        security: &full_security_records::Decoded,
        resident: &Resident,
    ) -> Result<Self> {
        // Existing native inventory admits <=64KiB of names. Reserve before
        // copying any key/tree node; conservative logical cost, not allocator/RSS.
        let bytes = expected
            .keys()
            .try_fold(4096usize, |n, key| {
                n.checked_add(key.len().checked_mul(2)?)?.checked_add(256)
            })
            .ok_or(Error::Limit)?;
        let memory = resident.lease(bytes)?;
        Ok(Self {
            identity: identity.clone(),
            kind,
            expected: expected.clone(),
            ea: ea.clone(),
            security: security.clone(),
            _memory: memory,
        })
    }
    pub(in super::super) fn matches(&self, node: &tree::Node) -> bool {
        self.kind == node.kind
            && self.identity.device == node.metadata.source_volume
            && self.identity.inode == node.metadata.source_id
    }
}
