//! Exact short ordinary default data on the original fresh target FileObject.
//! BackupWrite's minimum offer remains unchanged; no synthetic record/padding.
use super::*;
use sha2::{Digest, Sha256};
use std::io::Write;

pub(super) fn restore<R: Read + Seek>(
    mut input: R,
    target: &File,
    parsed: &records::Parsed,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    resident: &Resident,
) -> Result<()> {
    check(cancel)?;
    let proof = parsed.single_default_payload().ok_or(Error::Unsupported)?;
    let range = proof.range();
    let minimum = size_of::<WIN32_STREAM_ID>() + 1;
    if range.end >= minimum as u64 || range.end != parsed.bytes {
        return Err(Error::Unsupported);
    }
    let length = usize::try_from(range.end - range.start).map_err(|_| Error::Limit)?;
    let _memory = resident.lease(minimum)?;
    // Pay read + exact hash + write and EOF before any target mutation.
    charge(
        work,
        length
            .checked_mul(3)
            .and_then(|n| n.checked_add(1))
            .ok_or(Error::Limit)?,
    )?;
    let before = stamp(target).map_err(|e| io_error("shortDefaultTargetBefore", e))?;
    if !before.regular || before.size != 0 || before.links != 1 {
        return Err(Error::Changed);
    }
    let mut bytes = [0u8; size_of::<WIN32_STREAM_ID>()];
    let body = bytes.get_mut(..length).ok_or(Error::Limit)?;
    if input
        .seek(SeekFrom::Start(range.start))
        .map_err(|e| io_error("shortDefaultSeek", e))?
        != range.start
    {
        return Err(Error::Changed);
    }
    input
        .read_exact(body)
        .map_err(|e| io_error("shortDefaultRead", e))?;
    let mut tail = [0];
    if input
        .read(&mut tail)
        .map_err(|e| io_error("shortDefaultEof", e))?
        != 0
        || <[u8; 32]>::from(Sha256::digest(&*body)) != proof.sha256()
    {
        return Err(Error::Changed);
    }
    check(cancel)?;
    let mut target = target;
    if target
        .seek(SeekFrom::Start(0))
        .map_err(|e| io_error("shortDefaultTargetSeek", e))?
        != 0
    {
        return Err(Error::Changed);
    }
    if target
        .write(body)
        .map_err(|e| io_error("shortDefaultWrite", e))?
        != length
    {
        return Err(Error::Invalid);
    }
    check(cancel)?;
    let after = stamp(target).map_err(|e| io_error("shortDefaultTargetAfter", e))?;
    if after.identity != before.identity
        || !after.regular
        || after.links != 1
        || after.size != length as u64
    {
        return Err(Error::Changed);
    }
    // The caller must still flush and recapture every native facet, then apply
    // and verify the original basic metadata under the same complete-tree owner.
    Ok(())
}

#[cfg(test)]
#[path = "material_short_default_restore_tests.rs"]
mod tests;
