//! Owned transient inventory from ACTUAL captured Facts, never wire authority.
use super::*;
use crate::file_access::{
    ea_records, full_security_records, material_ordinary_security_records as ordinary,
};
#[derive(Clone, Copy)]
pub(in super::super) enum SecurityEvidence<'a> {
    Full(&'a full_security_records::Decoded),
    Ordinary(&'a ordinary::Summary),
}
pub(in super::super) struct NativeProof {
    pub(in super::super) identity: Identity,
    pub(in super::super) kind: Kind,
    pub(in super::super) semantic_sha256: [u8; 32],
    pub(in super::super) expected: records::Expected,
    pub(in super::super) ea: ea_records::Observation,
    pub(in super::super) security: Option<full_security_records::Decoded>,
    pub(in super::super) ordinary_security: Option<ordinary::Summary>,
    _memory: ResidentLease,
}
impl NativeProof {
    pub(in super::super) fn descriptor(&self) -> crate::worktrees::MaterialNode {
        use crate::worktrees::{
            MaterialEa, MaterialKind, MaterialNode, MaterialSecurity, MaterialStream,
        };
        MaterialNode {
            kind: match self.kind {
                Kind::Directory => MaterialKind::Directory,
                Kind::Regular => MaterialKind::Regular,
            },
            source_volume: self.identity.device,
            source_file_id: self.identity.inode.to_le_bytes(),
            semantic_sha256: self.semantic_sha256,
            streams: self
                .expected
                .iter()
                .map(|(name, bytes)| MaterialStream {
                    name: name.clone(),
                    bytes: *bytes,
                })
                .collect(),
            ea: MaterialEa {
                count: self.ea.count,
                logical_bytes: self.ea.logical_bytes,
                sha256: self.ea.sha256,
            },
            security: self.security.as_ref().map(|s| MaterialSecurity {
                aces: s.aces,
                returned_bytes: s.returned_bytes,
                sha256: s.sha256,
            }),
            ordinary_security: self.ordinary_security.as_ref().map(|s| {
                crate::worktrees::MaterialOrdinarySecurity {
                    bytes: s.bytes,
                    sha256: s.sha256,
                    dacl_aces: s.dacl_aces,
                    dacl_sha256: s.dacl_sha256,
                    labels: s.labels,
                    label_sha256: s.label_sha256,
                }
            }),
        }
    }
    pub(in super::super) fn from_descriptor(
        value: &crate::worktrees::MaterialNode,
        resident: &Resident,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        let cost = value
            .streams
            .iter()
            .try_fold(4096usize, |n, s| {
                n.checked_add(s.name.len().checked_mul(2)?)?
                    .checked_add(256)
            })
            .ok_or(Error::Limit)?;
        let memory = resident.lease(cost)?;
        // The outer descriptor is structurally validated first; native ordinal
        // comparison is still mandatory before recreating an Expected map.
        for (at, stream) in value.streams.iter().enumerate() {
            check(cancel)?;
            for before in &value.streams[..at] {
                charge(work, (stream.name.len() + before.name.len()) * 2 + 32)?;
                if stream.name.is_empty() || before.name.is_empty() {
                    continue;
                }
                if super::equal(&stream.name, &before.name)? {
                    return Err(Error::Changed);
                }
            }
        }
        Ok(Self {
            semantic_sha256: value.semantic_sha256,
            identity: Identity {
                device: value.source_volume,
                inode: u128::from_le_bytes(value.source_file_id),
            },
            kind: match value.kind {
                crate::worktrees::MaterialKind::Directory => Kind::Directory,
                crate::worktrees::MaterialKind::Regular => Kind::Regular,
            },
            expected: value
                .streams
                .iter()
                .map(|s| (s.name.clone(), s.bytes))
                .collect(),
            ea: ea_records::Observation {
                count: value.ea.count,
                logical_bytes: value.ea.logical_bytes,
                sha256: value.ea.sha256,
            },
            security: value
                .security
                .as_ref()
                .map(|s| full_security_records::Decoded {
                    aces: s.aces,
                    returned_bytes: s.returned_bytes,
                    sha256: s.sha256,
                }),
            ordinary_security: value.ordinary_security.as_ref().map(|s| ordinary::Summary {
                bytes: s.bytes,
                sha256: s.sha256,
                dacl_aces: s.dacl_aces,
                dacl_sha256: s.dacl_sha256,
                labels: s.labels,
                label_sha256: s.label_sha256,
            }),
            _memory: memory,
        })
    }
    pub(super) fn from_facts(
        identity: &Identity,
        kind: Kind,
        semantic_sha256: [u8; 32],
        expected: &records::Expected,
        ea: &ea_records::Observation,
        security: SecurityEvidence<'_>,
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
            semantic_sha256,
            expected: expected.clone(),
            ea: ea.clone(),
            security: match security {
                SecurityEvidence::Full(s) => Some(s.clone()),
                _ => None,
            },
            ordinary_security: match security {
                SecurityEvidence::Ordinary(s) => Some(s.clone()),
                _ => None,
            },
            _memory: memory,
        })
    }
    pub(in super::super) fn matches(&self, node: &tree::Node) -> bool {
        self.kind == node.kind
            && self.identity.device == node.metadata.source_volume
            && self.identity.inode == node.metadata.source_id
            && match (
                &self.security,
                &self.ordinary_security,
                &node.ordinary_security,
            ) {
                (Some(_), None, None) => true,
                (None, Some(s), Some(section)) => s == &section.summary,
                _ => false,
            }
    }
}
