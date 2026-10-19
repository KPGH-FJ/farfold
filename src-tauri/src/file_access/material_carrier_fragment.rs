//! Private byte consumer for a verified native node; not a complete tree/profile.
//! This format cannot be mistaken for Manifest1 or a product restore receipt.
use super::{
    ea_records::WorkBudget,
    material_carrier_records::{
        BLOCK, Error, Resident, ResidentLease, Result, charge, check, io_error,
    },
};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    sync::atomic::AtomicBool,
};
const MAGIC: &[u8; 8] = b"FFNODE1\0";
const END: &[u8; 8] = b"FFENDN1\0";
const FIXED: usize = 102;
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
pub(super) struct NativeExtent {
    pub bytes: u64,
    pub sha256: [u8; 32],
}
pub(super) struct Verified {
    _memory: ResidentLease,
    pub metadata: Metadata,
    pub native: NativeExtent,
    pub record_sha256: [u8; 32],
    pub stored_bytes: u64,
}
fn leaf(raw: &[u16]) -> Result<()> {
    if raw.is_empty()
        || raw.len() > 255
        || raw == [46]
        || raw == [46, 46]
        || matches!(raw.last(), Some(46 | 32))
        || raw.iter().any(|v| {
            *v < 32
                || (0x7f..=0x9f).contains(v)
                || [47, 92, 58, 63, 42, 34, 60, 62, 124].contains(v)
        })
    {
        return Err(Error::Unsupported);
    }
    // Identity is raw UTF-16. No lossy String conversion or Unicode folding.
    // DOS-device-name admission remains the actual native producer's policy;
    // this byte format grants no filesystem name/open authority.
    Ok(())
}
fn header(meta: &Metadata, extent: &NativeExtent) -> Result<Vec<u8>> {
    leaf(&meta.raw_leaf)?;
    if meta.source_id == 0
        || extent.bytes < 20
        || meta.created <= 0
        || meta.accessed <= 0
        || meta.modified <= 0
    {
        return Err(Error::Invalid);
    }
    let mut out = Vec::with_capacity(FIXED + meta.raw_leaf.len() * 2);
    out.extend(MAGIC);
    out.extend((meta.raw_leaf.len() as u16).to_le_bytes());
    out.extend(meta.source_volume.to_le_bytes());
    out.extend(meta.source_id.to_le_bytes());
    out.extend(meta.created.to_le_bytes());
    out.extend(meta.accessed.to_le_bytes());
    out.extend(meta.modified.to_le_bytes());
    out.extend(meta.attributes.to_le_bytes());
    out.extend(extent.bytes.to_le_bytes());
    out.extend(extent.sha256);
    for unit in &meta.raw_leaf {
        out.extend(unit.to_le_bytes());
    }
    Ok(out)
}
fn write<W: Write>(
    out: &mut W,
    bytes: &[u8],
    work: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<()> {
    check(cancel)?;
    // Charge a conservative offered-output bound before write_all. A partial
    // failed write remains a failure, never a smaller successful carrier.
    charge(work, bytes.len())?;
    out.write_all(bytes)
        .map_err(|e| io_error("fragmentWrite", e))
}
fn read<R: Read>(
    source: &mut R,
    bytes: &mut [u8],
    work: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<usize> {
    check(cancel)?;
    let capacity = work.remaining().min(bytes.len() as u64) as usize;
    if capacity == 0 {
        return Err(Error::Limit);
    }
    let n = source
        .read(&mut bytes[..capacity])
        .map_err(|e| io_error("fragmentRead", e))?;
    if n > capacity {
        return Err(Error::Invalid);
    }
    charge(work, n)?;
    Ok(n)
}
fn exact<R: Read>(
    source: &mut R,
    mut bytes: &mut [u8],
    work: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<()> {
    while !bytes.is_empty() {
        let n = read(source, bytes, work, cancel)?;
        if n == 0 {
            return Err(Error::Invalid);
        }
        bytes = &mut bytes[n..];
    }
    Ok(())
}
// The Windows caller supplies its SAME WorkBudget/Resident and exclusive
// owned namespace file. It constructs extent only from actual native EOF plus
// the existing Parsed result; the serializer itself is not native validation.
// Source is positioned at the first backup byte and must really reach EOF.
pub(super) fn append<R: Read, W: Write>(
    source: &mut R,
    out: &mut W,
    meta: &Metadata,
    extent: &NativeExtent,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    resident: &Resident,
) -> Result<u64> {
    let _memory = resident.lease(2 * BLOCK)?;
    check(cancel)?;
    let head = header(meta, extent)?;
    let stored_bytes = (head.len() as u64)
        .checked_add(extent.bytes)
        .and_then(|n| n.checked_add(40))
        .ok_or(Error::Limit)?;
    write(out, &head, work, cancel)?;
    let mut full = Sha256::new();
    full.update(&head);
    let mut native = Sha256::new();
    let mut left = extent.bytes;
    let mut scratch = vec![0u8; BLOCK];
    while left != 0 {
        let capacity = left.min(BLOCK as u64) as usize;
        let n = read(source, &mut scratch[..capacity], work, cancel)?;
        if n == 0 {
            return Err(Error::Invalid);
        }
        native.update(&scratch[..n]);
        full.update(&scratch[..n]);
        write(out, &scratch[..n], work, cancel)?;
        left -= n as u64;
    }
    let mut extra = [0u8; 1];
    if read(source, &mut extra, work, cancel)? != 0 {
        return Err(Error::Changed);
    }
    let actual: [u8; 32] = native.finalize().into();
    if actual != extent.sha256 {
        return Err(Error::Changed);
    }
    // No completion marker is emitted after any error/cancellation/hash drift.
    write(out, END, work, cancel)?;
    write(out, &full.finalize(), work, cancel)?;
    Ok(stored_bytes)
}
// Reads real stored bytes. This verifies framing/preservation, NOT admission
// to BackupWrite: the existing native-record parser remains mandatory there.
// No Vec of DATA, raw SD or all tree names is returned or logged.
pub(super) fn verify_exact<R: Read>(
    source: &mut R,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    resident: &Resident,
) -> Result<Verified> {
    let memory = resident.lease(1024)?;
    let _scratch = resident.lease(2 * BLOCK)?;
    let mut fixed = [0u8; FIXED];
    exact(source, &mut fixed, work, cancel)?;
    if &fixed[..8] != MAGIC {
        return Err(Error::Invalid);
    }
    let count = u16::from_le_bytes(fixed[8..10].try_into().expect("fixed")) as usize;
    if count == 0 || count > 255 {
        return Err(Error::Invalid);
    }
    let mut raw = vec![0u8; count * 2];
    exact(source, &mut raw, work, cancel)?;
    let metadata = Metadata {
        raw_leaf: raw
            .chunks_exact(2)
            .map(|v| u16::from_le_bytes([v[0], v[1]]))
            .collect(),
        source_volume: u64::from_le_bytes(fixed[10..18].try_into().expect("fixed")),
        source_id: u128::from_le_bytes(fixed[18..34].try_into().expect("fixed")),
        created: i64::from_le_bytes(fixed[34..42].try_into().expect("fixed")),
        accessed: i64::from_le_bytes(fixed[42..50].try_into().expect("fixed")),
        modified: i64::from_le_bytes(fixed[50..58].try_into().expect("fixed")),
        attributes: u32::from_le_bytes(fixed[58..62].try_into().expect("fixed")),
    };
    let native = NativeExtent {
        bytes: u64::from_le_bytes(fixed[62..70].try_into().expect("fixed")),
        sha256: fixed[70..102].try_into().expect("fixed"),
    };
    let head = header(&metadata, &native)?;
    let stored_bytes = (head.len() as u64)
        .checked_add(native.bytes)
        .and_then(|n| n.checked_add(40))
        .ok_or(Error::Limit)?;
    let mut full = Sha256::new();
    full.update(&head);
    let mut payload = Sha256::new();
    let mut buffer = vec![0u8; BLOCK];
    let mut left = native.bytes;
    while left != 0 {
        let offered = left.min(BLOCK as u64) as usize;
        let n = read(source, &mut buffer[..offered], work, cancel)?;
        if n == 0 {
            return Err(Error::Invalid);
        }
        full.update(&buffer[..n]);
        payload.update(&buffer[..n]);
        left -= n as u64;
    }
    let actual: [u8; 32] = payload.finalize().into();
    if actual != native.sha256 {
        return Err(Error::Changed);
    }
    let mut foot = [0u8; 40];
    exact(source, &mut foot, work, cancel)?;
    let record_sha256: [u8; 32] = full.finalize().into();
    if &foot[..8] != END || foot[8..] != record_sha256[..] {
        return Err(Error::Invalid);
    }
    let mut extra = [0u8; 1];
    if read(source, &mut extra, work, cancel)? != 0 {
        return Err(Error::Invalid);
    }
    Ok(Verified {
        _memory: memory,
        metadata,
        native,
        record_sha256,
        stored_bytes,
    })
}
#[cfg(test)]
#[path = "material_carrier_fragment_tests.rs"]
mod tests;
