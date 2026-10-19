//! Directory-only internal stream composition; neither full TreeFacet nor Manifest2.
//! Every record contains actual typed bytes. Regular/alias tags are NOT accepted.
use super::{
    ea_records::WorkBudget,
    material_carrier_records::{
        BLOCK, Error, Resident, ResidentLease, Result, charge, check, io_error,
    },
    material_directory_facet as facet,
};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    sync::atomic::AtomicBool,
};
pub(super) const MAX_NODES: usize = 64;
const MAGIC: &[u8; 8] = b"FFDTREE1";
const END: &[u8; 8] = b"FFDTEND1";
const PREFIX: usize = 49;
pub(super) const ROOT: u32 = u32::MAX;
pub(super) struct Node {
    pub parent: u32,
    pub metadata: facet::Metadata,
    pub typed_start: u64,
    pub typed_bytes: u64,
    pub native_start: u64,
    pub native_bytes: u64,
    pub native_sha256: [u8; 32],
    pub record_sha256: [u8; 32],
}
pub(super) struct Verified {
    pub nodes: Vec<Node>,
    pub bytes: u64,
    pub sha256: [u8; 32],
    pub full: bool,
    _memory: ResidentLease,
}
pub(super) struct Writer<'a, W: Write> {
    output: &'a mut W,
    hash: Sha256,
    count: u32,
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
impl<'a, W: Write> Writer<'a, W> {
    pub fn begin(
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
        head[12] = u8::from(full);
        bytes(output, &head, work, cancel)?;
        let mut hash = Sha256::new();
        hash.update(head);
        Ok(Self {
            output,
            hash,
            count: count as u32,
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
        parent: u32,
        source: &mut R,
        stored_bytes: u64,
        record_sha256: [u8; 32],
        work: &mut WorkBudget,
        cancel: &AtomicBool,
    ) -> Result<()> {
        if self.written >= self.count
            || (self.written == 0 && parent != ROOT)
            || (self.written != 0 && parent >= self.written)
        {
            return Err(Error::Invalid);
        }
        let mut head = [0u8; PREFIX];
        head[0] = 1;
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
    if &head[..8] != MAGIC || head[12] > 1 || head[13..] != [0; 3] {
        return Err(Error::Invalid);
    }
    let count = u32::from_le_bytes(head[8..12].try_into().expect("fixed")) as usize;
    if count == 0 || count > MAX_NODES {
        return Err(Error::Limit);
    }
    let full = head[12] == 1;
    let memory = resident.lease(count.checked_mul(2048).ok_or(Error::Limit)?)?;
    let mut nodes: Vec<Node> = Vec::with_capacity(count);
    for ordinal in 0..count {
        check(cancel)?;
        let mut fixed = [0u8; PREFIX];
        exact(&mut input, &mut fixed, work, cancel)?;
        if fixed[0] != 1 {
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
        let node = facet::verify_exact(&mut limited, work, cancel, resident)?;
        if limited.limit() != 0
            || node.stored_bytes != stored
            || node.record_sha256 != record
            || node.metadata.security_full != full
        {
            return Err(Error::Changed);
        }
        for old in &nodes {
            if old.metadata.source_volume == node.metadata.source_volume
                && old.metadata.source_id == node.metadata.source_id
            {
                return Err(Error::Changed);
            }
            if old.parent == parent && equal(&old.metadata.raw_leaf, &node.metadata.raw_leaf)? {
                return Err(Error::Changed);
            }
        }
        let native_start = typed_start
            .checked_add(103)
            .and_then(|v| v.checked_add(node.metadata.raw_leaf.len() as u64 * 2))
            .ok_or(Error::Limit)?;
        nodes.push(Node {
            parent,
            metadata: node.metadata,
            typed_start,
            typed_bytes: stored,
            native_start,
            native_bytes: node.native.bytes,
            native_sha256: node.native.sha256,
            record_sha256: record,
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
        full,
        _memory: memory,
    })
}
#[cfg(test)]
#[path = "material_directory_tree_records_tests.rs"]
mod tests;
