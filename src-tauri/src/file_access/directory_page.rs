//! Bounded metadata records only. No pathname decoding or mutation authority.
use super::Identity;
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicBool, Ordering},
};

pub(super) const PAGE_BYTES: usize = 65_536;
pub(super) const MAX_ENTRIES: usize = 100_000;
// FILE_ID_EXTD_DIR_INFORMATION: fixed-width fields, then WCHAR FileName[].
pub(super) const HEADER: usize = 88;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Observation {
    pub identity: Identity,
    pub attributes: u32,
    pub reparse_tag: Option<u32>,
    pub ea_size: u32,
    pub size: i64,
    pub allocation_size: i64,
    pub created: i64,
    pub modified: i64,
    pub changed: i64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Failure {
    Cancelled,
    Changed,
    Limit,
    InvalidRecord,
    Unsupported,
    Io {
        phase: &'static str,
        code: Option<i32>,
        nt_status: Option<i32>,
    },
}
pub(crate) type Entries = BTreeMap<Vec<u16>, Observation>;

// Actual completed native query span, including every ignored alignment/gap
// byte. Called after status/Information validation and BEFORE copying/decoding.
// The native call can return at most one PAGE_BYTES beyond the remaining work;
// that response refuses without copying/parsing or another query. Not OS/RSS/CPU.
#[cfg(any(windows, test))]
pub(super) fn charge_query_bytes(
    used: usize,
    work: &mut super::ea_records::WorkBudget,
) -> Result<(), Failure> {
    if used == 0 || used > PAGE_BYTES {
        return Err(Failure::InvalidRecord);
    }
    work.charge(used).map_err(|_| Failure::Limit)
}

pub(super) fn cancelled(cancel: &AtomicBool) -> Result<(), Failure> {
    if cancel.load(Ordering::SeqCst) {
        Err(Failure::Cancelled)
    } else {
        Ok(())
    }
}
fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().expect("checked fixed header"))
}
fn i64_at(bytes: &[u8], at: usize) -> i64 {
    i64::from_le_bytes(bytes[at..at + 8].try_into().expect("checked fixed header"))
}
fn page(bytes: &[u8], volume: u64, cancel: &AtomicBool) -> Result<Entries, Failure> {
    page_reserved(bytes, volume, cancel, |_| Ok(()))
}
// Purpose-specific allocation admission; the legacy collector uses a no-op.
// The same parser/offset/identity/error rules remain the only decoding body.
pub(super) fn page_reserved(
    bytes: &[u8],
    volume: u64,
    cancel: &AtomicBool,
    mut reserve: impl FnMut(usize) -> Result<(), Failure>,
) -> Result<Entries, Failure> {
    if bytes.is_empty() || bytes.len() > PAGE_BYTES {
        return Err(Failure::InvalidRecord);
    }
    let mut at = 0usize;
    let mut entries = Entries::new();
    loop {
        cancelled(cancel)?;
        let start = at.checked_add(HEADER).ok_or(Failure::InvalidRecord)?;
        let header = bytes.get(at..start).ok_or(Failure::InvalidRecord)?;
        let next = u32_at(header, 0) as usize;
        let length = u32_at(header, 60) as usize;
        if length == 0 || !length.is_multiple_of(2) || length > 510 {
            return Err(Failure::InvalidRecord);
        }
        let end = start
            .checked_add(length)
            .filter(|end| *end <= bytes.len())
            .ok_or(Failure::InvalidRecord)?;
        if next != 0
            && (!next.is_multiple_of(8)
                || next < HEADER + length
                || at.checked_add(next).is_none_or(|n| n >= bytes.len()))
        {
            return Err(Failure::InvalidRecord);
        }
        // Information is the actual used byte count, not the transport capacity.
        // A final record may include its alignment padding, never another page.
        if next == 0 && bytes.len() - end >= 8 {
            return Err(Failure::InvalidRecord);
        }
        // The requested counted-name payload and one logical map entry are
        // reserved before either the Vec or the map insertion can allocate.
        reserve(length)?;
        let name = bytes[start..end]
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect::<Vec<_>>();
        if name.iter().any(|c| matches!(*c, 0 | 47 | 92)) {
            return Err(Failure::InvalidRecord);
        }
        let id = u128::from_le_bytes(header[72..88].try_into().expect("checked fixed header"));
        if id == 0 {
            return Err(Failure::Unsupported);
        }
        let attributes = u32_at(header, 56);
        let size = i64_at(header, 40);
        let allocation_size = i64_at(header, 48);
        if size < 0 || allocation_size < 0 {
            return Err(Failure::InvalidRecord);
        }
        let value = Observation {
            identity: Identity {
                device: volume,
                inode: id,
            },
            attributes,
            reparse_tag: (attributes & 0x400 != 0).then(|| u32_at(header, 68)),
            ea_size: u32_at(header, 64),
            size,
            allocation_size,
            created: i64_at(header, 8),
            modified: i64_at(header, 24),
            changed: i64_at(header, 32),
        };
        if entries.insert(name, value).is_some() {
            return Err(Failure::Changed);
        }
        if next == 0 {
            break;
        }
        at = at.checked_add(next).ok_or(Failure::InvalidRecord)?;
    }
    Ok(entries)
}

// None is supplied only by the OS adapter's exact EOF status, never by empty
// success, access denial, overflow, unsupported classes or cancellation.
pub(super) fn collect(
    volume: u64,
    remaining: usize,
    cancel: &AtomicBool,
    mut query: impl FnMut() -> Result<Option<Vec<u8>>, Failure>,
) -> Result<Entries, Failure> {
    let limit = remaining.min(MAX_ENTRIES);
    let mut result = Entries::new();
    let mut dots = [false; 2];
    loop {
        cancelled(cancel)?;
        let bytes = query()?;
        cancelled(cancel)?;
        let Some(bytes) = bytes else {
            return Ok(result);
        };
        for (name, value) in page(&bytes, volume, cancel)? {
            cancelled(cancel)?;
            let dot = if name == [46] {
                Some(0)
            } else if name == [46, 46] {
                Some(1)
            } else {
                None
            };
            if let Some(dot) = dot {
                if std::mem::replace(&mut dots[dot], true) {
                    return Err(Failure::Changed);
                }
                continue;
            }
            if result.contains_key(&name) {
                return Err(Failure::Changed);
            }
            if result.len() >= limit {
                return Err(Failure::Limit);
            }
            result.insert(name, value);
        }
    }
}

#[cfg(test)]
#[path = "directory_page_tests.rs"]
mod tests;
