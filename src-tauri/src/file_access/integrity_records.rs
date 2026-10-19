//! Stored mandatory-label facet only. No audit/SACL completeness or access decision.
use super::ea_records::{Failure, WorkBudget, cancelled};
use sha2::{Digest, Sha256};
use std::sync::atomic::AtomicBool;

pub(super) const QUERY_BYTES: usize = 65_536;
const HEADER: usize = 20;
const SELF_RELATIVE: u16 = 0x8000;
const SACL_PRESENT: u16 = 0x0010;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Observation {
    pub labels: u64,
    pub logical_bytes: u64,
    pub sha256: [u8; 32],
}
fn u16_at(bytes: &[u8], at: usize) -> Result<u16, Failure> {
    let raw = bytes.get(at..at + 2).ok_or(Failure::InvalidRecord)?;
    Ok(u16::from_le_bytes(raw.try_into().expect("fixed field")))
}
fn u32_at(bytes: &[u8], at: usize) -> Result<u32, Failure> {
    let raw = bytes.get(at..at + 4).ok_or(Failure::InvalidRecord)?;
    Ok(u32::from_le_bytes(raw.try_into().expect("fixed field")))
}
fn field(hash: &mut Sha256, raw: &[u8]) {
    hash.update((raw.len() as u64).to_le_bytes());
    hash.update(raw);
}
fn records(bytes: &[u8], cancel: &AtomicBool) -> Result<Observation, Failure> {
    if bytes.len() < HEADER || bytes.len() > QUERY_BYTES || bytes[0] != 1 {
        return Err(Failure::InvalidRecord);
    }
    let control = u16_at(bytes, 2)?;
    if control & SELF_RELATIVE == 0 {
        return Err(Failure::Unsupported);
    }
    // Native query requests LABEL only, not owner/group/DACL or all SACL.
    // Unexpected sections never silently increase this facet's authority.
    if u32_at(bytes, 4)? != 0 || u32_at(bytes, 8)? != 0 || u32_at(bytes, 16)? != 0 {
        return Err(Failure::Unsupported);
    }
    let at = u32_at(bytes, 12)? as usize;
    if at != 0
        && (at < HEADER
            || at >= bytes.len()
            || !at.is_multiple_of(4)
            || control & SACL_PRESENT == 0)
    {
        return Err(Failure::InvalidRecord);
    }
    let mut hash = Sha256::new();
    field(
        &mut hash,
        b"farfold-held-stored-mandatory-label-observation-v1",
    );
    field(&mut hash, &control.to_le_bytes());
    field(
        &mut hash,
        &[if control & 0x4000 != 0 { bytes[1] } else { 0 }],
    );
    // These are distinct stored query results. None means no stored requested
    // label, not no audit ACEs, no effective OS policy or a full empty SACL.
    field(
        &mut hash,
        &[u8::from(control & SACL_PRESENT != 0), u8::from(at != 0)],
    );
    let mut end = HEADER;
    let mut logical = HEADER;
    let mut labels = 0u64;
    if at != 0 {
        let head = bytes.get(at..at + 8).ok_or(Failure::InvalidRecord)?;
        if !matches!(head[0], 2 | 4) {
            return Err(Failure::Unsupported);
        }
        let length = usize::from(u16_at(bytes, at + 2)?);
        if length < 8 || !length.is_multiple_of(4) {
            return Err(Failure::InvalidRecord);
        }
        let acl = bytes.get(at..at + length).ok_or(Failure::InvalidRecord)?;
        end = at + length;
        let count = usize::from(u16_at(bytes, at + 4)?);
        field(&mut hash, &[head[0]]);
        field(&mut hash, &(count as u64).to_le_bytes());
        logical += 8;
        let mut pos = 8usize;
        for _ in 0..count {
            cancelled(cancel)?;
            let ace = acl.get(pos..pos + 4).ok_or(Failure::InvalidRecord)?;
            let size = usize::from(u16::from_le_bytes([ace[2], ace[3]]));
            if size < 20 || !size.is_multiple_of(4) {
                return Err(Failure::InvalidRecord);
            }
            let ace = acl.get(pos..pos + size).ok_or(Failure::InvalidRecord)?;
            if ace[0] != 0x11 {
                return Err(Failure::Unsupported);
            }
            // SYSTEM_MANDATORY_LABEL_ACE: MASK then SID S-1-16-RID.
            // Preserve mask/AceFlags/RID as data; do not infer access/elevation.
            if ace[8] != 1 || ace[9] != 1 || ace[10..16] != [0, 0, 0, 0, 0, 16] {
                return Err(Failure::Unsupported);
            }
            field(&mut hash, &ace[..2]);
            field(&mut hash, &ace[4..20]);
            // Ordinary ACE allocation/alignment tail and ACL free storage
            // are ignored, never required zero or called policy semantics.
            logical += 20;
            labels += 1;
            pos += size;
        }
    }
    // Conservative exact/minimal terminal alignment grammar, not permission.
    if bytes.len() != end && bytes.len() != ((end + 3) & !3) {
        return Err(Failure::InvalidRecord);
    }
    cancelled(cancel)?;
    Ok(Observation {
        labels,
        logical_bytes: logical as u64,
        sha256: hash.finalize().into(),
    })
}
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
#[path = "integrity_records_tests.rs"]
mod tests;
