//! Complete-or-refuse EA response, no names/values leave this bounded decoder.
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicBool, Ordering},
};

pub(super) const QUERY_BYTES: usize = 65_536;
pub(super) const NO_EAS: i32 = 0xC0000052_u32 as i32;
const BUFFER_OVERFLOW: i32 = 0x80000005_u32 as i32;
const BUFFER_TOO_SMALL: i32 = 0xC0000023_u32 as i32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Failure {
    Cancelled,
    Limit,
    InvalidRecord,
    Unsupported,
    #[cfg(windows)]
    Changed,
    #[cfg(windows)]
    Busy,
    #[cfg(windows)]
    Poisoned,
    Status(i32),
    #[cfg(windows)]
    Io {
        phase: &'static str,
        code: Option<i32>,
    },
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Observation {
    pub count: u64,
    pub logical_bytes: u64,
    pub sha256: [u8; 32],
}
// Internal completed-returned EA bytes, independent of MaterialSummary.bytes.
// The first and verification response of every object charge the SAME budget.
pub(crate) struct WorkBudget {
    limit: u64,
    used: u64,
}
impl WorkBudget {
    pub(crate) fn new(limit: u64) -> Self {
        Self { limit, used: 0 }
    }
    pub(crate) fn capacity(&self) -> Result<usize, Failure> {
        let n = (self.limit - self.used).min(QUERY_BYTES as u64) as usize;
        if n == 0 { Err(Failure::Limit) } else { Ok(n) }
    }
    fn charge(&mut self, used: usize) -> Result<(), Failure> {
        let next = self.used.checked_add(used as u64).ok_or(Failure::Limit)?;
        if next > self.limit {
            return Err(Failure::Limit);
        }
        self.used = next;
        Ok(())
    }
}
pub(super) fn cancelled(cancel: &AtomicBool) -> Result<(), Failure> {
    if cancel.load(Ordering::SeqCst) {
        Err(Failure::Cancelled)
    } else {
        Ok(())
    }
}
struct Record<'a> {
    name: &'a [u8],
    flags: u8,
    value: &'a [u8],
}
fn field(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_le_bytes());
    hash.update(bytes);
}
fn digest(
    records: BTreeMap<Vec<u8>, Record<'_>>,
    logical_bytes: u64,
    cancel: &AtomicBool,
) -> Result<Observation, Failure> {
    let count = records.len() as u64;
    let mut hash = Sha256::new();
    field(&mut hash, b"farfold-held-file-ea-observation-v1");
    field(&mut hash, &count.to_le_bytes());
    for record in records.values() {
        cancelled(cancel)?;
        field(&mut hash, record.name);
        field(&mut hash, &[record.flags]);
        field(&mut hash, record.value);
    }
    Ok(Observation {
        count,
        logical_bytes,
        sha256: hash.finalize().into(),
    })
}
fn name_ok(name: &[u8]) -> bool {
    !name.is_empty()
        && name.len() < 255
        && name
            .iter()
            .all(|b| b.is_ascii() && *b >= 0x20 && !b"\\/:*?\"<>|,+=[];".contains(b))
}
fn records(bytes: &[u8], cancel: &AtomicBool) -> Result<Observation, Failure> {
    let mut at = 0usize;
    let mut values = BTreeMap::new();
    let mut logical = 0u64;
    loop {
        cancelled(cancel)?;
        let head_end = at.checked_add(8).ok_or(Failure::InvalidRecord)?;
        let head = bytes.get(at..head_end).ok_or(Failure::InvalidRecord)?;
        let next = u32::from_le_bytes(head[..4].try_into().expect("fixed header")) as usize;
        let flags = head[4];
        let n = head[5] as usize;
        let v = u16::from_le_bytes([head[6], head[7]]) as usize;
        if !matches!(flags, 0 | 0x80) {
            return Err(Failure::Unsupported);
        }
        let nul = head_end.checked_add(n).ok_or(Failure::InvalidRecord)?;
        let value_start = nul.checked_add(1).ok_or(Failure::InvalidRecord)?;
        let end = value_start.checked_add(v).ok_or(Failure::InvalidRecord)?;
        let name = bytes.get(head_end..nul).ok_or(Failure::InvalidRecord)?;
        let value = bytes.get(value_start..end).ok_or(Failure::InvalidRecord)?;
        if !name_ok(name) || bytes.get(nul) != Some(&0) {
            return Err(Failure::InvalidRecord);
        }
        // EA names are case-insensitive ASCII. Ambiguity is never last-wins.
        let folded = name.iter().map(u8::to_ascii_uppercase).collect();
        if values
            .insert(folded, Record { name, flags, value })
            .is_some()
        {
            return Err(Failure::InvalidRecord);
        }
        logical = logical
            .checked_add((end - at) as u64)
            .ok_or(Failure::Limit)?;
        let aligned_end = end.checked_add(3).ok_or(Failure::InvalidRecord)? & !3;
        if next == 0 {
            // Conservative admitted span: exact record end or its minimal
            // four-byte alignment tail, never arbitrary unlinked records.
            // Padding CONTENT remains ignored, including nonzero bytes.
            if bytes.len() != end && bytes.len() != aligned_end {
                return Err(Failure::InvalidRecord);
            }
            break;
        }
        let next_at = at.checked_add(next).ok_or(Failure::InvalidRecord)?;
        if !next.is_multiple_of(4) || next_at != aligned_end || next_at >= bytes.len() {
            return Err(Failure::InvalidRecord);
        }
        // This admitted grammar permits only the minimal alignment gap.
        // Do not inspect or require zero for those padding bytes.
        at = next_at;
    }
    digest(values, logical, cancel)
}
// `allocated` is exactly the Length offered to the synchronous native call.
// Information alone defines the completed readable span, not allocation size.
// The API's returned non-PENDING status is authoritative, NOT IOStatus.Status.
pub(super) fn complete(
    status: i32,
    information: usize,
    allocated: &[u8],
    budget: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<Observation, Failure> {
    if allocated.is_empty() || allocated.len() > QUERY_BYTES || information > allocated.len() {
        return Err(Failure::InvalidRecord);
    }
    budget.charge(information)?;
    cancelled(cancel)?;
    if status == NO_EAS {
        if information != 0 {
            return Err(Failure::InvalidRecord);
        }
        return digest(BTreeMap::new(), 0, cancel);
    }
    if matches!(status, BUFFER_OVERFLOW | BUFFER_TOO_SMALL) {
        return Err(Failure::Limit);
    }
    if status != 0 {
        return Err(Failure::Status(status));
    }
    if information == 0 {
        return Err(Failure::InvalidRecord);
    }
    records(&allocated[..information], cancel)
}

#[cfg(test)]
#[path = "ea_records_tests.rs"]
mod tests;
