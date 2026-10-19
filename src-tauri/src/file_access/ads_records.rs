//! Portable, complete-or-refuse DATA stream observation.
//! Partial metadata only; no mutation or recovery authority.
use super::ea_records::{QUERY_BYTES, WorkBudget};
use sha2::{Digest, Sha256};
use std::{
    cmp::Ordering,
    collections::BTreeMap,
    sync::atomic::{AtomicBool, Ordering as AtomicOrdering},
};

const INVENTORY_HEADER: usize = 24;
const BACKUP_HEADER: usize = 20;
// A name must also fit its one admitted <=64KiB native inventory response.
const MAX_NAME_BYTES: usize = QUERY_BYTES - INVENTORY_HEADER;
const MAX_NAME_UNITS: usize = MAX_NAME_BYTES / 2;
const MAX_DATA_BYTES: u64 = 256 * 1024 * 1024;
// Conservative admission profile, not a claim that larger metadata is invalid.
const MAX_OPAQUE_BYTES: u64 = QUERY_BYTES as u64;
const OVERFLOW: i32 = 0x80000005_u32 as i32;
const TOO_SMALL: i32 = 0xC0000023_u32 as i32;
const DEFAULT_SPELLING: [u16; 7] = [58, 58, 36, 68, 65, 84, 65];
const DATA_SUFFIX: [u16; 6] = [58, 36, 68, 65, 84, 65];

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Failure {
    Cancelled,
    Limit,
    InvalidRecord,
    Unsupported,
    Changed,
    Status(i32),
    Compare,
    #[cfg(windows)]
    Io {
        phase: &'static str,
        code: Option<i32>,
    },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Observation {
    pub count: u64,
    pub logical_bytes: u64,
    pub sha256: [u8; 32],
    pub default_present: bool,
    pub default_size: u64,
    pub default_sha256: [u8; 32],
}
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Key {
    Default,
    Named(Vec<u16>),
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Stream {
    raw_name: Vec<u16>,
    size: u64,
    allocation: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Inventory {
    entries: BTreeMap<Key, Stream>,
    directory: bool,
}
fn cancelled(cancel: &AtomicBool) -> Result<(), Failure> {
    if cancel.load(AtomicOrdering::SeqCst) {
        Err(Failure::Cancelled)
    } else {
        Ok(())
    }
}
fn charge(budget: &mut WorkBudget, bytes: usize) -> Result<(), Failure> {
    // WorkBudget::charge has exactly one failure class: Limit.
    budget.charge(bytes).map_err(|_| Failure::Limit)
}
fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().expect("checked fixed header"))
}
fn u64_at(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().expect("checked fixed header"))
}
fn raw_name(bytes: &[u8]) -> Result<Vec<u16>, Failure> {
    if !bytes.len().is_multiple_of(2) || bytes.len() > MAX_NAME_BYTES {
        return Err(Failure::InvalidRecord);
    }
    Ok(bytes
        .chunks_exact(2)
        .map(|part| u16::from_le_bytes([part[0], part[1]]))
        .collect())
}
fn key(name: &[u16]) -> Result<Key, Failure> {
    if name.len() > MAX_NAME_UNITS || name.contains(&0) {
        return Err(Failure::InvalidRecord);
    }
    if name.is_empty() || name == DEFAULT_SPELLING {
        return Ok(Key::Default);
    }
    if name.len() <= DATA_SUFFIX.len() + 1
        || name.first() != Some(&58)
        || !name.ends_with(&DATA_SUFFIX)
    {
        return Err(Failure::Unsupported);
    }
    let middle = &name[1..name.len() - DATA_SUFFIX.len()];
    if middle.is_empty() || middle.contains(&58) {
        return Err(Failure::Unsupported);
    }
    // :$DATA:$DATA is a named stream. Never strip suffixes into a default alias.
    // Unpaired UTF-16 is retained verbatim; there is no String/lossy conversion.
    Ok(Key::Named(name.to_vec()))
}
impl Inventory {
    /// `allocated` is the exact offered native buffer; Information is its used
    /// span. `ordinal` MUST be native CompareStringOrdinal(ignoreCase=true) in
    /// the Windows adapter. An exact comparator in host tests proves no native
    /// Windows folding. The seam must fail on a native comparison error.
    pub(crate) fn decode(
        status: i32,
        information: usize,
        allocated: &[u8],
        budget: &mut WorkBudget,
        cancel: &AtomicBool,
        mut ordinal: impl FnMut(&[u16], &[u16]) -> Result<Ordering, Failure>,
    ) -> Result<Self, Failure> {
        if allocated.len() < INVENTORY_HEADER
            || allocated.len() > QUERY_BYTES
            || information > allocated.len()
        {
            return Err(Failure::InvalidRecord);
        }
        charge(budget, information)?;
        cancelled(cancel)?;
        if matches!(status, OVERFLOW | TOO_SMALL) {
            return Err(Failure::Limit);
        }
        if status != 0 {
            return Err(Failure::Status(status));
        }
        // Info0 is not an empty-file/directory capability. That native shape
        // is unresolved and is deliberately refused by this proposal.
        if information == 0 {
            return Err(Failure::Unsupported);
        }
        let bytes = &allocated[..information];
        let mut entries = BTreeMap::new();
        let mut aliases: Vec<Vec<u16>> = Vec::new();
        let mut at = 0usize;
        loop {
            cancelled(cancel)?;
            let start = at
                .checked_add(INVENTORY_HEADER)
                .ok_or(Failure::InvalidRecord)?;
            let head = bytes.get(at..start).ok_or(Failure::InvalidRecord)?;
            let next = u32_at(head, 0) as usize;
            let length = u32_at(head, 4) as usize;
            if !length.is_multiple_of(2) || length > MAX_NAME_BYTES {
                return Err(Failure::InvalidRecord);
            }
            let end = start.checked_add(length).ok_or(Failure::InvalidRecord)?;
            let name = raw_name(bytes.get(start..end).ok_or(Failure::InvalidRecord)?)?;
            let stream_key = key(&name)?;
            let size = u64_at(head, 8);
            let allocation = u64_at(head, 16);
            // Both source fields are signed LARGE_INTEGER values.
            if size > i64::MAX as u64 || allocation > i64::MAX as u64 {
                return Err(Failure::InvalidRecord);
            }
            if entries.contains_key(&stream_key) {
                return Err(Failure::Changed);
            }
            // Binary insertion bounds native comparator calls to O(n log n).
            // Raw code-unit exact uniqueness and semantic default alias checks
            // above do not substitute for this native alias rejection.
            let (mut low, mut high) = (0, aliases.len());
            while low < high {
                cancelled(cancel)?;
                let mid = low + (high - low) / 2;
                match ordinal(&name, &aliases[mid])? {
                    Ordering::Less => high = mid,
                    Ordering::Greater => low = mid + 1,
                    Ordering::Equal => return Err(Failure::Changed),
                }
            }
            aliases.insert(low, name.clone());
            entries.insert(
                stream_key,
                Stream {
                    raw_name: name,
                    size,
                    allocation,
                },
            );
            let aligned_end = end.checked_add(7).ok_or(Failure::InvalidRecord)? & !7;
            if next == 0 {
                if bytes.len() != end && bytes.len() != aligned_end {
                    return Err(Failure::InvalidRecord);
                }
                break;
            }
            let next_at = at.checked_add(next).ok_or(Failure::InvalidRecord)?;
            if !next.is_multiple_of(8) || next_at != aligned_end || next_at >= bytes.len() {
                return Err(Failure::InvalidRecord);
            }
            // Padding contents are opaque, including nonzero bytes. Only the
            // minimal aligned gap is admitted; arbitrary skipped tails refuse.
            at = next_at;
        }
        Ok(Self {
            entries,
            directory: false,
        })
    }
    pub(crate) fn default_size(&self) -> Option<u64> {
        self.entries.get(&Key::Default).map(|stream| stream.size)
    }
    pub(crate) fn has_default(&self) -> bool {
        self.entries.contains_key(&Key::Default)
    }
    /// Caller must first confirm Directory kind from the same held object.
    /// Named-only inventories need this explicit classification; the portable
    /// decoder never infers a directory from a missing default DATA stream.
    pub(crate) fn for_directory(mut self) -> Result<Self, Failure> {
        if self.has_default() {
            return Err(Failure::Unsupported);
        }
        self.directory = true;
        Ok(self)
    }
    /// Candidate directory-only branch, not proof from Information0 alone.
    /// Caller must already hold Directory metadata on the same handle, then
    /// obtain actual successful BackupRead EOF, this branch again, and equal
    /// before/after kind/full128/stamp/base metadata before returning a node.
    /// Ordinary-file decode never calls this constructor automatically.
    pub(crate) fn empty_directory(
        status: i32,
        information: usize,
        allocated: &[u8],
        budget: &mut WorkBudget,
        cancel: &AtomicBool,
    ) -> Result<Self, Failure> {
        if allocated.len() < INVENTORY_HEADER
            || allocated.len() > QUERY_BYTES
            || information > allocated.len()
        {
            return Err(Failure::InvalidRecord);
        }
        charge(budget, information)?;
        cancelled(cancel)?;
        if matches!(status, OVERFLOW | TOO_SMALL) {
            return Err(Failure::Limit);
        }
        if status != 0 {
            return Err(Failure::Status(status));
        }
        if information != 0 {
            return Err(Failure::InvalidRecord);
        }
        Ok(Self {
            entries: BTreeMap::new(),
            directory: true,
        })
    }
}

struct Header {
    id: u32,
    size: u64,
    name_bytes: usize,
}
impl Header {
    fn decode(bytes: &[u8; BACKUP_HEADER]) -> Result<Self, Failure> {
        let id = u32_at(bytes, 0);
        let attributes = u32_at(bytes, 4);
        let size = u64_at(bytes, 8);
        let name_bytes = u32_at(bytes, 16) as usize;
        if !name_bytes.is_multiple_of(2) || name_bytes > MAX_NAME_BYTES {
            return Err(Failure::InvalidRecord);
        }
        // BACKUP_DATA=1, EA_DATA=2, ALTERNATE_DATA=4, LINK=5, OBJECT_ID=7.
        // Security=3, property=6, reparse=8, sparse=9, TxF=10 and unknown
        // records/attributes are outside this observation profile.
        if attributes != 0 || !matches!(id, 1 | 2 | 4 | 5 | 7) {
            return Err(Failure::Unsupported);
        }
        if id == 4 {
            if name_bytes == 0 || size > MAX_DATA_BYTES {
                return Err(if name_bytes == 0 {
                    Failure::InvalidRecord
                } else {
                    Failure::Limit
                });
            }
        } else if name_bytes != 0 {
            return Err(Failure::Unsupported);
        } else {
            let limit = if id == 1 {
                MAX_DATA_BYTES
            } else {
                MAX_OPAQUE_BYTES
            };
            if size > limit {
                return Err(Failure::Limit);
            }
        }
        Ok(Self {
            id,
            size,
            name_bytes,
        })
    }
}
enum Phase {
    Boundary,
    Header {
        bytes: [u8; BACKUP_HEADER],
        used: usize,
    },
    Name {
        header: Header,
        units: Vec<u16>,
        low: Option<u8>,
        used: usize,
    },
    Body {
        key: Option<Key>,
        left: u64,
        hash: Option<Sha256>,
    },
}
pub(crate) struct Streams<'a> {
    inventory: &'a Inventory,
    budget: &'a mut WorkBudget,
    cancel: &'a AtomicBool,
    minimum_read_offer: usize,
    offered: Option<usize>,
    phase: Phase,
    seen: BTreeMap<Key, [u8; 32]>,
    poisoned: bool,
    complete: bool,
}
impl<'a> Streams<'a> {
    /// The native owner supplies size_of::<WIN32_STREAM_ID>() + 1 as minimum.
    /// This wire reducer never uses struct size/padding to decode records.
    pub(crate) fn new(
        inventory: &'a Inventory,
        budget: &'a mut WorkBudget,
        cancel: &'a AtomicBool,
        minimum_read_offer: usize,
    ) -> Result<Self, Failure> {
        cancelled(cancel)?;
        if minimum_read_offer <= BACKUP_HEADER || minimum_read_offer > QUERY_BYTES {
            return Err(Failure::InvalidRecord);
        }
        if !inventory.has_default() && !inventory.directory {
            return Err(Failure::Unsupported);
        }
        let mut minimum = minimum_read_offer as u64;
        for (stream_key, stream) in &inventory.entries {
            cancelled(cancel)?;
            if stream.size > MAX_DATA_BYTES {
                return Err(Failure::Limit);
            }
            let name_bytes = match stream_key {
                Key::Default => 0,
                Key::Named(name) => (name.len() * 2) as u64,
            };
            minimum = minimum
                .checked_add(BACKUP_HEADER as u64)
                .and_then(|n| n.checked_add(name_bytes))
                .and_then(|n| n.checked_add(stream.size))
                .ok_or(Failure::Limit)?;
        }
        // This projection is never charged as completed work. The exclusive
        // budget borrow prevents EA/verification from spending it mid-read.
        // Reserve offer headroom for actual EOF; no zero-length read shortcut.
        if minimum > budget.remaining() {
            return Err(Failure::Limit);
        }
        Ok(Self {
            inventory,
            budget,
            cancel,
            minimum_read_offer,
            offered: None,
            phase: Phase::Boundary,
            seen: BTreeMap::new(),
            poisoned: false,
            complete: false,
        })
    }
    /// Arm exactly one native read. Driver must offer exactly this capacity
    /// from its <=64KiB buffer, and call push only after actual native success.
    pub(crate) fn offer(&mut self) -> Result<usize, Failure> {
        let result = self.offer_inner();
        if result.is_err() {
            self.poisoned = true;
        }
        result
    }
    fn offer_inner(&mut self) -> Result<usize, Failure> {
        if self.poisoned || self.complete || self.offered.is_some() {
            return Err(Failure::InvalidRecord);
        }
        cancelled(self.cancel)?;
        let capacity = self.budget.remaining().min(QUERY_BYTES as u64) as usize;
        if capacity < self.minimum_read_offer {
            return Err(Failure::Limit);
        }
        self.offered = Some(capacity);
        Ok(capacity)
    }
    /// One actual successful BackupRead completion. `returned` is exactly
    /// lpNumberOfBytesRead, not offered capacity. Empty means ONLY successful
    /// native zero, never access denial/cancel/abort or inferred body end.
    /// There is intentionally no public finish() capable of inventing EOF.
    pub(crate) fn push(&mut self, returned: &[u8]) -> Result<Option<Observation>, Failure> {
        let result = self.push_inner(returned);
        if result.is_err() {
            self.poisoned = true;
        }
        result
    }
    fn push_inner(&mut self, returned: &[u8]) -> Result<Option<Observation>, Failure> {
        if self.poisoned || self.complete {
            return Err(Failure::InvalidRecord);
        }
        let offered = self.offered.take().ok_or(Failure::InvalidRecord)?;
        if returned.len() > offered {
            return Err(Failure::InvalidRecord);
        }
        // Successful completed bytes remain charged even on cancellation or
        // subsequent grammar/pairing refusal. Opaque skipped data charges too.
        charge(self.budget, returned.len())?;
        cancelled(self.cancel)?;
        if returned.is_empty() {
            if !matches!(self.phase, Phase::Boundary) {
                return Err(Failure::InvalidRecord);
            }
            let result = self.observation()?;
            self.complete = true;
            return Ok(Some(result));
        }
        self.consume(returned)?;
        Ok(None)
    }
    fn body(&mut self, header: Header, name: Vec<u16>) -> Result<Phase, Failure> {
        let stream_key = match header.id {
            1 => Some(Key::Default),
            4 => {
                let parsed = key(&name)?;
                if parsed == Key::Default {
                    return Err(Failure::Unsupported);
                }
                Some(parsed)
            }
            _ => None, // EA/link/object-ID: explicitly excluded opaque metadata.
        };
        if let Some(stream_key) = &stream_key {
            let expected = self
                .inventory
                .entries
                .get(stream_key)
                .ok_or(Failure::Changed)?;
            if expected.size != header.size || self.seen.contains_key(stream_key) {
                return Err(Failure::Changed);
            }
            // Default BACKUP_DATA has no wire name; named DATA uses the exact
            // raw inventory spelling. No case folding or suffix guessing here.
            if header.id == 4 && name != expected.raw_name {
                return Err(Failure::Changed);
            }
        }
        let hash = stream_key.as_ref().map(|_| Sha256::new());
        if header.size == 0 {
            self.finish_body(stream_key, hash)?;
            Ok(Phase::Boundary)
        } else {
            Ok(Phase::Body {
                key: stream_key,
                left: header.size,
                hash,
            })
        }
    }
    fn finish_body(&mut self, key: Option<Key>, hash: Option<Sha256>) -> Result<(), Failure> {
        if let Some(key) = key {
            let value: [u8; 32] = hash.ok_or(Failure::InvalidRecord)?.finalize().into();
            if self.seen.insert(key, value).is_some() {
                return Err(Failure::Changed);
            }
        }
        Ok(())
    }
    fn consume(&mut self, mut bytes: &[u8]) -> Result<(), Failure> {
        while !bytes.is_empty() {
            cancelled(self.cancel)?;
            let phase = std::mem::replace(&mut self.phase, Phase::Boundary);
            self.phase = match phase {
                Phase::Boundary => Phase::Header {
                    bytes: [0; BACKUP_HEADER],
                    used: 0,
                },
                Phase::Header {
                    bytes: mut head,
                    mut used,
                } => {
                    let count = (BACKUP_HEADER - used).min(bytes.len());
                    head[used..used + count].copy_from_slice(&bytes[..count]);
                    used += count;
                    bytes = &bytes[count..];
                    if used < BACKUP_HEADER {
                        Phase::Header { bytes: head, used }
                    } else {
                        let header = Header::decode(&head)?;
                        if header.name_bytes == 0 {
                            self.body(header, Vec::new())?
                        } else {
                            let capacity = header.name_bytes / 2;
                            Phase::Name {
                                header,
                                units: Vec::with_capacity(capacity),
                                low: None,
                                used: 0,
                            }
                        }
                    }
                }
                Phase::Name {
                    header,
                    mut units,
                    mut low,
                    mut used,
                } => {
                    let count = (header.name_bytes - used).min(bytes.len());
                    for byte in &bytes[..count] {
                        if let Some(first) = low.take() {
                            units.push(u16::from_le_bytes([first, *byte]));
                        } else {
                            low = Some(*byte);
                        }
                    }
                    used += count;
                    bytes = &bytes[count..];
                    if used == header.name_bytes {
                        if low.is_some() {
                            return Err(Failure::InvalidRecord);
                        }
                        self.body(header, units)?
                    } else {
                        Phase::Name {
                            header,
                            units,
                            low,
                            used,
                        }
                    }
                }
                Phase::Body {
                    key,
                    mut left,
                    mut hash,
                } => {
                    let count = left.min(bytes.len() as u64) as usize;
                    if let Some(hash) = &mut hash {
                        hash.update(&bytes[..count]);
                    }
                    bytes = &bytes[count..];
                    left -= count as u64;
                    if left == 0 {
                        self.finish_body(key, hash)?;
                        Phase::Boundary
                    } else {
                        Phase::Body { key, left, hash }
                    }
                }
            };
        }
        Ok(())
    }
    fn observation(&self) -> Result<Observation, Failure> {
        // Size-zero omissions are not silently synthesized. Native emitted vs
        // omitted behavior remains an unverified positive control requirement.
        if self.seen.len() != self.inventory.entries.len() {
            return Err(Failure::Changed);
        }
        let (default_present, default_size, default_sha256) =
            if let Some(default) = self.inventory.entries.get(&Key::Default) {
                (
                    true,
                    default.size,
                    *self.seen.get(&Key::Default).ok_or(Failure::Changed)?,
                )
            } else if self.inventory.directory {
                // Explicit absent marker, never the SHA of a fabricated empty
                // default file. Consumer must inspect default_present first.
                (false, 0, [0; 32])
            } else {
                return Err(Failure::Unsupported);
            };
        let mut logical_bytes = 0u64;
        let mut hash = Sha256::new();
        field(&mut hash, b"farfold-held-file-data-stream-observation-v1");
        field(
            &mut hash,
            &(self.inventory.entries.len() as u64).to_le_bytes(),
        );
        for (stream_key, stream) in &self.inventory.entries {
            cancelled(self.cancel)?;
            logical_bytes = logical_bytes
                .checked_add(stream.size)
                .ok_or(Failure::Limit)?;
            hash.update(((stream.raw_name.len() * 2) as u64).to_le_bytes());
            for unit in &stream.raw_name {
                hash.update(unit.to_le_bytes());
            }
            let id: u32 = if *stream_key == Key::Default { 1 } else { 4 };
            field(&mut hash, &id.to_le_bytes());
            field(&mut hash, &stream.size.to_le_bytes());
            field(&mut hash, &stream.allocation.to_le_bytes());
            field(
                &mut hash,
                self.seen.get(stream_key).ok_or(Failure::Changed)?,
            );
        }
        Ok(Observation {
            count: self.inventory.entries.len() as u64,
            logical_bytes,
            sha256: hash.finalize().into(),
            default_present,
            default_size,
            default_sha256,
        })
    }
}
fn field(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_le_bytes());
    hash.update(bytes);
}

#[cfg(test)]
#[path = "ads_records_tests.rs"]
mod tests;
