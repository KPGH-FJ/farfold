//! Bounded full-returned self-relative descriptor bytes, not a restore carrier.
//! Parsing never proves which native mask/rights produced those bytes.
use super::ea_records::{Failure, WorkBudget, cancelled};
use sha2::{Digest, Sha256};
use std::sync::atomic::AtomicBool;

pub(super) const QUERY_BYTES: usize = 65_536;
const HEADER: usize = 20;
const SELF_RELATIVE: u16 = 0x8000;
const DACL_PRESENT: u16 = 4;
const SACL_PRESENT: u16 = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Decoded {
    pub aces: u64,
    pub returned_bytes: u64,
    pub sha256: [u8; 32],
}
fn u16_at(bytes: &[u8], at: usize) -> Result<u16, Failure> {
    Ok(u16::from_le_bytes(
        bytes
            .get(at..at + 2)
            .ok_or(Failure::InvalidRecord)?
            .try_into()
            .expect("fixed field"),
    ))
}
fn offset(bytes: &[u8], at: usize) -> Result<usize, Failure> {
    let raw = bytes.get(at..at + 4).ok_or(Failure::InvalidRecord)?;
    let value = u32::from_le_bytes(raw.try_into().expect("fixed offset")) as usize;
    if value != 0 && (value < HEADER || !value.is_multiple_of(4) || value >= bytes.len()) {
        return Err(Failure::InvalidRecord);
    }
    Ok(value)
}
fn sid_end(bytes: &[u8], at: usize) -> Result<usize, Failure> {
    let head = bytes.get(at..at + 8).ok_or(Failure::InvalidRecord)?;
    if head[0] != 1 || head[1] > 15 {
        return Err(Failure::Unsupported);
    }
    let end = at + 8 + usize::from(head[1]) * 4;
    bytes.get(at..end).ok_or(Failure::InvalidRecord)?;
    Ok(end)
}
fn ace(entry: &[u8], system: bool) -> Result<(), Failure> {
    // Whitelist only layouts with bounded embedded SID position. Reserved
    // compound/alarm and unknown future layouts refuse the entire full facet.
    let object = match (system, entry[0]) {
        (false, 0 | 1 | 9 | 10) | (true, 2 | 13 | 17..=21) => false,
        (false, 5 | 6 | 11 | 12) | (true, 7 | 15) => true,
        _ => return Err(Failure::Unsupported),
    };
    let sid_at = if object {
        let flags = entry.get(8..12).ok_or(Failure::InvalidRecord)?;
        let flags = u32::from_le_bytes(flags.try_into().expect("fixed flags"));
        if flags & !3 != 0 {
            return Err(Failure::Unsupported);
        }
        12 + if flags & 1 != 0 { 16 } else { 0 } + if flags & 2 != 0 { 16 } else { 0 }
    } else {
        8
    };
    sid_end(entry, sid_at)?;
    // All bytes (including opaque callback/resource/filter tails, ACE flags,
    // padding and ACL free storage) enter the raw descriptor digest below.
    // This bounds memory; it does not evaluate conditional access semantics.
    Ok(())
}
fn acl_end(
    bytes: &[u8],
    at: usize,
    system: bool,
    cancel: &AtomicBool,
) -> Result<(usize, u64), Failure> {
    let head = bytes.get(at..at + 8).ok_or(Failure::InvalidRecord)?;
    if !matches!(head[0], 2 | 4) {
        return Err(Failure::Unsupported);
    }
    let length = usize::from(u16_at(bytes, at + 2)?);
    if length < 8 || !length.is_multiple_of(4) {
        return Err(Failure::InvalidRecord);
    }
    let acl = bytes.get(at..at + length).ok_or(Failure::InvalidRecord)?;
    let count = u16_at(bytes, at + 4)?;
    let mut pos = 8usize;
    for _ in 0..count {
        cancelled(cancel)?;
        let head = acl.get(pos..pos + 4).ok_or(Failure::InvalidRecord)?;
        let size = usize::from(u16::from_le_bytes([head[2], head[3]]));
        if size < 4 || !size.is_multiple_of(4) {
            return Err(Failure::InvalidRecord);
        }
        ace(
            acl.get(pos..pos + size).ok_or(Failure::InvalidRecord)?,
            system,
        )?;
        pos += size;
    }
    Ok((at + length, u64::from(count)))
}
fn records(bytes: &[u8], cancel: &AtomicBool) -> Result<Decoded, Failure> {
    if bytes.len() < HEADER || bytes.len() > QUERY_BYTES || bytes[0] != 1 {
        return Err(Failure::InvalidRecord);
    }
    let control = u16_at(bytes, 2)?;
    if control & SELF_RELATIVE == 0 {
        return Err(Failure::Unsupported);
    }
    let mut ranges = Vec::with_capacity(4);
    for at in [offset(bytes, 4)?, offset(bytes, 8)?] {
        if at != 0 {
            ranges.push((at, sid_end(bytes, at)?, true));
        }
    }
    let mut aces = 0;
    for (at, present, system) in [
        (offset(bytes, 12)?, SACL_PRESENT, true),
        (offset(bytes, 16)?, DACL_PRESENT, false),
    ] {
        if at != 0 {
            if control & present == 0 {
                return Err(Failure::InvalidRecord);
            }
            let (end, count) = acl_end(bytes, at, system, cancel)?;
            ranges.push((at, end, false));
            aces += count;
        }
    }
    let mut end = HEADER;
    for (i, &(start, finish, is_sid)) in ranges.iter().enumerate() {
        end = end.max(finish);
        for &(other_start, other_finish, other_sid) in &ranges[..i] {
            if start < other_finish
                && other_start < finish
                && !(is_sid && other_sid && start == other_start && finish == other_finish)
            {
                return Err(Failure::InvalidRecord);
            }
        }
    }
    if bytes.len() != end && bytes.len() != ((end + 3) & !3) {
        return Err(Failure::InvalidRecord);
    }
    cancelled(cancel)?;
    let mut hash = Sha256::new();
    hash.update(b"farfold-held-full-security-descriptor-bytes-v1");
    hash.update((bytes.len() as u64).to_le_bytes());
    hash.update(bytes);
    Ok(Decoded {
        aces,
        returned_bytes: bytes.len() as u64,
        sha256: hash.finalize().into(),
    })
}
pub(super) fn complete(
    returned: &[u8],
    budget: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<Decoded, Failure> {
    budget.charge(returned.len())?;
    cancelled(cancel)?;
    records(returned, cancel)
}
#[cfg(test)]
#[path = "full_security_records_tests.rs"]
mod tests;
