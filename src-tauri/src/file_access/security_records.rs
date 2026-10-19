//! Bounded self-relative owner/group/DACL observation; not full file security.
use super::ea_records::{Failure, WorkBudget, cancelled};
use sha2::{Digest, Sha256};
use std::sync::atomic::AtomicBool;

pub(super) const QUERY_BYTES: usize = 65_536;
const HEADER: usize = 20;
const SELF_RELATIVE: u16 = 0x8000;
const DACL_PRESENT: u16 = 0x0004;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Observation {
    pub aces: u64,
    pub logical_bytes: u64,
    pub sha256: [u8; 32],
}

fn u16_at(bytes: &[u8], at: usize) -> Result<u16, Failure> {
    let value = bytes.get(at..at + 2).ok_or(Failure::InvalidRecord)?;
    Ok(u16::from_le_bytes(value.try_into().expect("fixed field")))
}
fn offset(bytes: &[u8], at: usize) -> Result<usize, Failure> {
    let value = bytes.get(at..at + 4).ok_or(Failure::InvalidRecord)?;
    let value = u32::from_le_bytes(value.try_into().expect("fixed field")) as usize;
    if value != 0 && (value < HEADER || !value.is_multiple_of(4) || value >= bytes.len()) {
        return Err(Failure::InvalidRecord);
    }
    Ok(value)
}
fn field(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_le_bytes());
    hash.update(bytes);
}
fn sid(bytes: &[u8], at: usize) -> Result<&[u8], Failure> {
    if at == 0 {
        return Ok(&[]);
    }
    let header = bytes.get(at..at + 8).ok_or(Failure::InvalidRecord)?;
    if header[0] != 1 || header[1] > 15 {
        return Err(Failure::Unsupported);
    }
    let length = 8 + usize::from(header[1]) * 4;
    bytes.get(at..at + length).ok_or(Failure::InvalidRecord)
}
fn admit_ranges(ranges: &[(usize, usize, bool)]) -> Result<usize, Failure> {
    let mut end = HEADER;
    for (i, &(start, finish, is_sid)) in ranges.iter().enumerate() {
        if start == 0 {
            continue;
        }
        end = end.max(finish);
        for &(other_start, other_finish, other_sid) in &ranges[..i] {
            if other_start != 0 && start < other_finish && other_start < finish
                // Owner and group may share the exact same SID storage.
                && !(is_sid && other_sid && start == other_start && finish == other_finish)
            {
                return Err(Failure::InvalidRecord);
            }
        }
    }
    Ok(end)
}

// Bound known DACL layouts without interpreting whether access is granted.
// Non-callback AceSize tail is ignored; callback application data stays opaque.
// Unknown types refuse rather than guessing which bytes would be padding.
fn ace_body(entry: &[u8]) -> Result<&[u8], Failure> {
    let (object, callback) = match entry[0] {
        0 | 1 => (false, false),
        5 | 6 => (true, false),
        9 | 10 => (false, true),
        11 | 12 => (true, true),
        _ => return Err(Failure::Unsupported),
    };
    let mut sid_at = 8usize; // header + ACCESS_MASK
    if object {
        let flags = entry.get(8..12).ok_or(Failure::InvalidRecord)?;
        let flags = u32::from_le_bytes(flags.try_into().expect("fixed flags"));
        if flags & !3 != 0 {
            return Err(Failure::Unsupported);
        }
        sid_at = 12 + if flags & 1 != 0 { 16 } else { 0 } + if flags & 2 != 0 { 16 } else { 0 };
    }
    let identity = sid(entry, sid_at)?;
    let end = sid_at + identity.len();
    if callback {
        entry.get(4..).ok_or(Failure::InvalidRecord)
    } else {
        entry.get(4..end).ok_or(Failure::InvalidRecord)
    }
}

// Offsets, ACE alignment tails and free ACL storage are not permission data.
fn records(bytes: &[u8], cancel: &AtomicBool) -> Result<Observation, Failure> {
    if bytes.len() < HEADER || bytes.len() > QUERY_BYTES || bytes[0] != 1 {
        return Err(Failure::InvalidRecord);
    }
    let control = u16_at(bytes, 2)?;
    if control & SELF_RELATIVE == 0 {
        return Err(Failure::Unsupported);
    }
    let owner_at = offset(bytes, 4)?;
    let group_at = offset(bytes, 8)?;
    let sacl_at = offset(bytes, 12)?;
    let dacl_at = offset(bytes, 16)?;
    // The native request excludes SACL. Never interpret no returned SACL as an
    // empty SACL, and never silently include an unexpected privileged payload.
    if sacl_at != 0 || (control & DACL_PRESENT == 0 && dacl_at != 0) {
        return Err(Failure::Unsupported);
    }
    let owner = sid(bytes, owner_at)?;
    let group = sid(bytes, group_at)?;
    let mut ranges = vec![
        (owner_at, owner_at + owner.len(), true),
        (group_at, group_at + group.len(), true),
    ];
    let mut hash = Sha256::new();
    field(&mut hash, b"farfold-held-owner-group-dacl-observation-v1");
    field(&mut hash, &control.to_le_bytes());
    // Resource-manager control is meaningful only when SE_RM_CONTROL_VALID.
    field(
        &mut hash,
        &[if control & 0x4000 != 0 { bytes[1] } else { 0 }],
    );
    field(&mut hash, owner);
    field(&mut hash, group);
    let mut logical = HEADER + owner.len() + group.len();
    let mut aces = 0u64;
    // Absent DACL, present NULL DACL and present empty ACL stay distinct.
    field(
        &mut hash,
        &[
            u8::from(control & DACL_PRESENT != 0),
            u8::from(dacl_at != 0),
        ],
    );
    if dacl_at != 0 {
        let head = bytes
            .get(dacl_at..dacl_at + 8)
            .ok_or(Failure::InvalidRecord)?;
        if !matches!(head[0], 2 | 4) {
            return Err(Failure::Unsupported);
        }
        let length = usize::from(u16_at(bytes, dacl_at + 2)?);
        let count = usize::from(u16_at(bytes, dacl_at + 4)?);
        if length < 8 || !length.is_multiple_of(4) {
            return Err(Failure::InvalidRecord);
        }
        let acl = bytes
            .get(dacl_at..dacl_at + length)
            .ok_or(Failure::InvalidRecord)?;
        ranges.push((dacl_at, dacl_at + length, false));
        field(&mut hash, &[head[0]]);
        field(&mut hash, &(count as u64).to_le_bytes());
        logical += 8;
        let mut at = 8usize;
        for _ in 0..count {
            cancelled(cancel)?;
            let entry_head = acl.get(at..at + 4).ok_or(Failure::InvalidRecord)?;
            let size = usize::from(u16::from_le_bytes([entry_head[2], entry_head[3]]));
            if size < 4 || !size.is_multiple_of(4) {
                return Err(Failure::InvalidRecord);
            }
            let entry = acl.get(at..at + size).ok_or(Failure::InvalidRecord)?;
            let body = ace_body(entry)?;
            field(&mut hash, &entry[..2]);
            field(&mut hash, body);
            logical += 4 + body.len();
            aces += 1;
            at += size;
        }
        // AclSize may include free bytes after its AceCount entries. They are
        // not ACEs and are not zero-checked or hashed as permission semantics.
    }
    let end = admit_ranges(&ranges)?;
    if bytes.len() != end && bytes.len() != ((end + 3) & !3) {
        return Err(Failure::InvalidRecord);
    }
    cancelled(cancel)?;
    Ok(Observation {
        aces,
        logical_bytes: logical as u64,
        sha256: hash.finalize().into(),
    })
}

// The native BOOL and returned required span are authoritative. A failure,
// denied query or insufficient offer is not an empty security descriptor.
pub(super) fn complete(
    returned: &[u8],
    budget: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<Observation, Failure> {
    budget.charge(returned.len())?;
    cancelled(cancel)?;
    records(returned, cancel)
}

#[cfg(test)]
#[path = "security_records_tests.rs"]
mod tests;
