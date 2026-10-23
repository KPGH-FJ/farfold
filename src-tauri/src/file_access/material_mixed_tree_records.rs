//! Operation-scoped mixed actual typed bytes. Not a public profile/Manifest2.
//! New magic only; old FFDTREE1 grammar/rejection tests remain untouched.
use super::{
    ea_records::WorkBudget,
    material_carrier_fragment as regular,
    material_carrier_records::{
        BLOCK, Error, Resident, ResidentLease, Result, charge, check, io_error,
    },
    material_directory_facet as facet, material_ordinary_security_records as ordinary,
};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    sync::atomic::AtomicBool,
};
// Finite format bound, independent of the unchanged shared resident/work
// budgets. A particular tree must still fit all live owners and native data.
pub(super) const MAX_NODES: usize = super::MIXED_TREE_NODE_LIMIT;
const MAGIC: &[u8; 8] = b"FFMTREE1";
const END: &[u8; 8] = b"FFMTEND1";
const PREFIX: usize = 49;
pub(super) const ROOT: u32 = u32::MAX;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Directory = 1,
    Regular = 2,
}
// The kind and parent of the one record, never an on-disk/ABI struct.
pub(super) struct Entry {
    pub kind: Kind,
    pub parent: u32,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Metadata {
    pub raw_leaf: Vec<u16>,
    pub source_volume: u64,
    pub source_id: u128,
    pub created: i64,
    pub accessed: i64,
    pub modified: i64,
    pub attributes: u32,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct OrdinarySection {
    pub start: u64,
    pub summary: ordinary::Summary,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Node {
    pub kind: Kind,
    pub parent: u32,
    pub metadata: Metadata,
    pub typed_start: u64,
    pub typed_bytes: u64,
    pub native_start: u64,
    pub native_bytes: u64,
    pub native_sha256: [u8; 32],
    pub record_sha256: [u8; 32],
    pub ordinary_security: Option<OrdinarySection>,
}
pub(super) struct Verified {
    pub nodes: Vec<Node>,
    pub bytes: u64,
    pub sha256: [u8; 32],
    _memory: ResidentLease,
}
pub(super) struct Writer<'a, W: Write> {
    output: &'a mut W,
    hash: Sha256,
    count: u32,
    full: bool,
    written: u32,
    buffer: Vec<u8>,
    _memory: ResidentLease,
}
fn bytes<W: Write>(
    out: &mut W,
    b: &[u8],
    work: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<()> {
    check(cancel)?;
    charge(work, b.len())?;
    out.write_all(b).map_err(|e| io_error("treeWrite", e))
}
pub(super) struct Stored<'a> {
    pub bytes: u64,
    pub sha256: [u8; 32],
    pub security: Option<&'a [u8]>,
}
impl<'a, W: Write> Writer<'a, W> {
    #[cfg(test)]
    pub fn begin(
        output: &'a mut W,
        count: usize,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
        resident: &Resident,
    ) -> Result<Self> {
        Self::begin_profile(output, count, true, work, cancel, resident)
    }
    pub fn begin_profile(
        output: &'a mut W,
        count: usize,
        full: bool,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
        resident: &Resident,
    ) -> Result<Self> {
        if count == 0 || count > MAX_NODES {
            return Err(Error::Limit);
        }
        let memory = resident.lease(2 * BLOCK)?;
        let mut head = [0u8; 16];
        head[..8].copy_from_slice(MAGIC);
        head[8..12].copy_from_slice(&(count as u32).to_le_bytes());
        head[12] = if full { 1 } else { 2 }; // explicit security coverage
        bytes(output, &head, work, cancel)?;
        let mut hash = Sha256::new();
        hash.update(head);
        Ok(Self {
            output,
            hash,
            count: count as u32,
            full,
            written: 0,
            buffer: vec![0; BLOCK],
            _memory: memory,
        })
    }
    fn put(&mut self, b: &[u8], work: &mut WorkBudget, cancel: &AtomicBool) -> Result<()> {
        bytes(self.output, b, work, cancel)?;
        self.hash.update(b);
        Ok(())
    }
    pub fn append<R: Read>(
        &mut self,
        entry: Entry,
        source: &mut R,
        stored_bytes: u64,
        record_sha256: [u8; 32],
        work: &mut WorkBudget,
        cancel: &AtomicBool,
    ) -> Result<()> {
        self.append_record(
            entry,
            source,
            Stored {
                bytes: stored_bytes,
                sha256: record_sha256,
                security: None,
            },
            work,
            cancel,
        )
    }
    pub fn append_ordinary<R: Read>(
        &mut self,
        entry: Entry,
        source: &mut R,
        stored: Stored<'_>,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
    ) -> Result<()> {
        if self.full || stored.security.is_none() {
            return Err(Error::Invalid);
        }
        self.append_record(entry, source, stored, work, cancel)
    }
    fn append_record<R: Read>(
        &mut self,
        entry: Entry,
        source: &mut R,
        stored: Stored<'_>,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
    ) -> Result<()> {
        if self.full != stored.security.is_none() {
            return Err(Error::Invalid);
        }
        let Stored {
            bytes: stored_bytes,
            sha256: record_sha256,
            security,
        } = stored;
        let Entry { kind, parent } = entry;
        if self.written >= self.count
            || (self.written == 0 && parent != ROOT)
            || (self.written != 0 && parent >= self.written)
        {
            return Err(Error::Invalid);
        }
        let mut head = [0u8; PREFIX];
        head[0] = kind as u8;
        head[1..5].copy_from_slice(&self.written.to_le_bytes());
        head[5..9].copy_from_slice(&parent.to_le_bytes());
        head[9..17].copy_from_slice(&stored_bytes.to_le_bytes());
        head[17..].copy_from_slice(&record_sha256);
        self.put(&head, work, cancel)?;
        let mut left = stored_bytes;
        while left != 0 {
            check(cancel)?;
            let capacity = left.min(BLOCK as u64).min(work.remaining()) as usize;
            if capacity == 0 {
                return Err(Error::Limit);
            }
            let n = source
                .read(&mut self.buffer[..capacity])
                .map_err(|e| io_error("treeTypedRead", e))?;
            if n == 0 || n > capacity {
                return Err(Error::Invalid);
            }
            charge(work, n)?;
            bytes(self.output, &self.buffer[..n], work, cancel)?;
            self.hash.update(&self.buffer[..n]);
            left -= n as u64;
        }
        let mut extra = [0u8; 1];
        check(cancel)?;
        charge(work, 1)?;
        if source
            .read(&mut extra)
            .map_err(|e| io_error("treeTypedEof", e))?
            != 0
        {
            return Err(Error::Changed);
        }
        if let Some(raw) = security {
            ordinary::decode(raw, work, cancel)?;
            self.put(&(raw.len() as u32).to_le_bytes(), work, cancel)?;
            self.put(raw, work, cancel)?;
        }
        self.written += 1;
        Ok(())
    }
    pub fn finish(self, work: &mut WorkBudget, cancel: &AtomicBool) -> Result<[u8; 32]> {
        if self.written != self.count {
            return Err(Error::Invalid);
        }
        let digest: [u8; 32] = self.hash.finalize().into();
        bytes(self.output, END, work, cancel)?;
        bytes(self.output, &digest, work, cancel)?;
        Ok(digest)
    }
}
struct Input<'a, R> {
    source: &'a mut R,
    hash: Sha256,
    position: u64,
    hashing: bool,
}
impl<R: Read> Read for Input<'_, R> {
    fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
        let n = self.source.read(b)?;
        if n > b.len() {
            return Err(std::io::ErrorKind::InvalidData.into());
        }
        self.position = self
            .position
            .checked_add(n as u64)
            .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::InvalidData))?;
        if self.hashing {
            self.hash.update(&b[..n]);
        }
        Ok(n)
    }
}
fn exact<R: Read>(
    input: &mut R,
    b: &mut [u8],
    work: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<()> {
    check(cancel)?;
    charge(work, b.len())?;
    input.read_exact(b).map_err(|e| io_error("treeRead", e))
}
pub(super) fn verify_exact<R: Read>(
    source: &mut R,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    resident: &Resident,
    mut equal: impl FnMut(&[u16], &[u16]) -> Result<bool>,
) -> Result<Verified> {
    check(cancel)?;
    let mut input = Input {
        source,
        hash: Sha256::new(),
        position: 0,
        hashing: true,
    };
    let mut head = [0u8; 16];
    exact(&mut input, &mut head, work, cancel)?;
    if &head[..8] != MAGIC || !matches!(head[12], 1 | 2) || head[13..] != [0; 3] {
        return Err(Error::Invalid);
    }
    let full = head[12] == 1;
    let count = u32::from_le_bytes(head[8..12].try_into().expect("fixed")) as usize;
    if count == 0 || count > MAX_NODES {
        return Err(Error::Limit);
    }
    let memory = resident.lease(count.checked_mul(2048).ok_or(Error::Limit)?)?;
    let mut nodes: Vec<Node> = Vec::with_capacity(count);
    for ordinal in 0..count {
        check(cancel)?;
        let mut fixed = [0u8; PREFIX];
        exact(&mut input, &mut fixed, work, cancel)?;
        let kind = match fixed[0] {
            1 => Kind::Directory,
            2 => Kind::Regular,
            _ => return Err(Error::Unsupported),
        };
        if ordinal == 0 && kind != Kind::Directory {
            return Err(Error::Unsupported);
        }

        if u32::from_le_bytes(fixed[1..5].try_into().expect("fixed")) != ordinal as u32 {
            return Err(Error::Invalid);
        }
        let parent = u32::from_le_bytes(fixed[5..9].try_into().expect("fixed"));
        if (ordinal == 0 && parent != ROOT) || (ordinal != 0 && parent >= ordinal as u32) {
            return Err(Error::Invalid);
        }
        let stored = u64::from_le_bytes(fixed[9..17].try_into().expect("fixed"));
        let record: [u8; 32] = fixed[17..].try_into().expect("fixed");
        let typed_start = input.position;
        let mut limited = (&mut input).take(stored);
        let (metadata, native_bytes, native_sha256, record_sha256, stored_bytes, offset) =
            match kind {
                Kind::Directory => {
                    let node = facet::verify_exact(&mut limited, work, cancel, resident)?;
                    if node.metadata.security_full != full {
                        return Err(Error::Unsupported);
                    }
                    let m = node.metadata;
                    (
                        Metadata {
                            raw_leaf: m.raw_leaf,
                            source_volume: m.source_volume,
                            source_id: m.source_id,
                            created: m.created,
                            accessed: m.accessed,
                            modified: m.modified,
                            attributes: m.attributes,
                        },
                        node.native.bytes,
                        node.native.sha256,
                        node.record_sha256,
                        node.stored_bytes,
                        103u64,
                    )
                }
                Kind::Regular => {
                    let node = regular::verify_exact(&mut limited, work, cancel, resident)?;
                    let m = node.metadata;
                    if m.attributes & 0x10 != 0 || m.attributes & !0x20a7 != 0 {
                        return Err(Error::Unsupported);
                    }
                    (
                        Metadata {
                            raw_leaf: m.raw_leaf,
                            source_volume: m.source_volume,
                            source_id: m.source_id,
                            created: m.created,
                            accessed: m.accessed,
                            modified: m.modified,
                            attributes: m.attributes,
                        },
                        node.native.bytes,
                        node.native.sha256,
                        node.record_sha256,
                        node.stored_bytes,
                        102u64,
                    )
                }
            };
        if limited.limit() != 0 || stored_bytes != stored || record_sha256 != record {
            return Err(Error::Changed);
        }
        let ordinary_security = if full {
            None
        } else {
            let mut length = [0u8; 4];
            exact(&mut input, &mut length, work, cancel)?;
            let length = u32::from_le_bytes(length) as usize;
            if !(56..=ordinary::MAX_BYTES).contains(&length) {
                return Err(Error::Limit);
            }
            let _scratch = resident.lease(length)?;
            let start = input.position;
            let mut raw = vec![0; length];
            exact(&mut input, &mut raw, work, cancel)?;
            Some(OrdinarySection {
                start,
                summary: ordinary::decode(&raw, work, cancel)?.summary,
            })
        };
        if ordinal != 0
            && (nodes[parent as usize].kind != Kind::Directory
                || nodes[0].metadata.source_volume != metadata.source_volume)
        {
            return Err(Error::Unsupported);
        }
        for old in &nodes {
            check(cancel)?;
            // Pairwise identity and Windows ordinal-name comparisons share
            // the same work allowance as the actual bytes being verified.
            charge(work, 2 * (size_of::<u64>() + size_of::<u128>()))?;
            if old.metadata.source_volume == metadata.source_volume
                && old.metadata.source_id == metadata.source_id
            {
                return Err(Error::Changed);
            }
            if old.parent == parent {
                let units = old
                    .metadata
                    .raw_leaf
                    .len()
                    .checked_add(metadata.raw_leaf.len())
                    .and_then(|n| n.checked_mul(size_of::<u16>()))
                    .ok_or(Error::Limit)?;
                charge(work, units)?;
                if equal(&old.metadata.raw_leaf, &metadata.raw_leaf)? {
                    return Err(Error::Changed);
                }
            }
        }
        let native_start = typed_start
            .checked_add(offset)
            .and_then(|v| v.checked_add(metadata.raw_leaf.len() as u64 * 2))
            .ok_or(Error::Limit)?;
        nodes.push(Node {
            kind,
            parent,
            metadata,
            typed_start,
            typed_bytes: stored,
            native_start,
            native_bytes,
            native_sha256,
            record_sha256: record,
            ordinary_security,
        });
    }
    let hash: [u8; 32] = input.hash.clone().finalize().into();
    input.hashing = false;
    let mut end = [0u8; 40];
    exact(&mut input, &mut end, work, cancel)?;
    if &end[..8] != END || end[8..] != hash {
        return Err(Error::Changed);
    }
    let mut extra = [0u8; 1];
    check(cancel)?;
    charge(work, 1)?;
    if input
        .read(&mut extra)
        .map_err(|e| io_error("treeFinalEof", e))?
        != 0
    {
        return Err(Error::Changed);
    }
    Ok(Verified {
        nodes,
        bytes: input.position,
        sha256: hash,
        _memory: memory,
    })
}
#[cfg(test)]
#[path = "material_mixed_tree_records_tests.rs"]
mod tests;
