//! Private one-node native backup carrier; no manifest/IPC deserializer.
//! Disk stores actual returned bytes. Only bounded names/metadata enter RAM.
use super::{
    ea_records::{self, WorkBudget},
    full_security_records,
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{self, Read},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

pub(super) const BLOCK: usize = 65_536;
pub(super) const STREAM_LIMIT: u64 = 256 * 1024 * 1024;
pub(crate) const WORK_LIMIT: u64 = 1024 * 1024 * 1024;
pub(super) const RESIDENT_LIMIT: usize = 8 * 1024 * 1024;
pub(super) const CATALOG_RESIDENT: usize = 16 * BLOCK;
// Conservative logical reservations cover catalog key/value/header capacities;
// they do not claim allocator metadata, OS cache, kernel memory or RSS limits.
#[derive(Clone)]
pub(super) struct Resident {
    used: Arc<AtomicUsize>,
    limit: usize,
}
#[derive(Debug)]
pub(super) struct ResidentLease {
    used: Arc<AtomicUsize>,
    bytes: usize,
}
impl Resident {
    pub fn new(limit: usize) -> Self {
        Self {
            used: Arc::new(AtomicUsize::new(0)),
            limit,
        }
    }
    pub fn lease(&self, bytes: usize) -> Result<ResidentLease> {
        self.used
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                n.checked_add(bytes).filter(|n| *n <= self.limit)
            })
            .map_err(|_| Error::Limit)?;
        Ok(ResidentLease {
            used: self.used.clone(),
            bytes,
        })
    }
    // Extend one existing owner, avoiding an unmetered Vec<Lease> per record.
    // A different pool cannot grow/release a lease belonging to this pool.
    pub fn grow(&self, lease: &mut ResidentLease, bytes: usize) -> Result<()> {
        if !Arc::ptr_eq(&self.used, &lease.used) {
            return Err(Error::Invalid);
        }
        let total = lease.bytes.checked_add(bytes).ok_or(Error::Limit)?;
        self.used
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                n.checked_add(bytes).filter(|n| *n <= self.limit)
            })
            .map_err(|_| Error::Limit)?;
        lease.bytes = total;
        Ok(())
    }
}
impl Drop for ResidentLease {
    fn drop(&mut self) {
        self.used.fetch_sub(self.bytes, Ordering::SeqCst);
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Error {
    Cancelled,
    Limit,
    Invalid,
    Unsupported,
    Changed,
    CleanupUnknown,
    Io {
        phase: &'static str,
        code: Option<i32>,
    },
    NtStatus {
        phase: &'static str,
        status: i32,
    },
}
pub(super) type Result<T> = std::result::Result<T, Error>;
pub(super) fn io_error(phase: &'static str, e: io::Error) -> Error {
    Error::Io {
        phase,
        code: e.raw_os_error(),
    }
}
pub(super) fn record(e: ea_records::Failure) -> Error {
    match e {
        ea_records::Failure::Cancelled => Error::Cancelled,
        ea_records::Failure::Limit => Error::Limit,
        ea_records::Failure::Unsupported => Error::Unsupported,
        ea_records::Failure::Status(status) => Error::NtStatus {
            phase: "record",
            status,
        },
        _ => Error::Invalid,
    }
}
pub(super) fn check(cancel: &AtomicBool) -> Result<()> {
    ea_records::cancelled(cancel).map_err(record)
}
pub(super) fn charge(budget: &mut WorkBudget, bytes: usize) -> Result<()> {
    budget.charge(bytes).map_err(record)
}
// Inventory already performed native case-insensitive duplicate/alias checks.
// A regular file always has the default key (empty), including a zero-size DATA.
pub(super) type Expected = BTreeMap<Vec<u16>, u64>;
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Key {
    Data(Vec<u16>),
    Ea,
    Security,
}
#[derive(Debug, Clone, PartialEq, Eq)]
struct Part {
    size: u64,
    flags: u32,
    sha256: [u8; 32],
}
#[derive(Debug)]
pub(super) struct Parsed {
    parts: BTreeMap<Key, Part>,
    pub bytes: u64,
    pub sha256: [u8; 32],
    pub security: Option<full_security_records::Decoded>,
    // Transient location in these exact parsed native bytes; not persisted
    // authority or a substitute for the complete descriptor/content checks.
    pub security_record: Option<std::ops::Range<u64>>,
    _memory: ResidentLease,
}
impl PartialEq for Parsed {
    fn eq(&self, other: &Self) -> bool {
        self.parts == other.parts
            && self.bytes == other.bytes
            && self.sha256 == other.sha256
            && self.security == other.security
    }
}
impl Eq for Parsed {}
impl Parsed {
    pub fn semantic_sha256(&self) -> [u8; 32] {
        let mut hash = Sha256::new();
        hash.update(b"FFNATIVESEM1");
        hash.update((self.parts.len() as u64).to_le_bytes());
        for (key, part) in &self.parts {
            let (tag, name): (u8, &[u16]) = match key {
                Key::Data(name) => (1, name),
                Key::Ea => (2, &[]),
                Key::Security => (3, &[]),
            };
            hash.update([tag]);
            hash.update((name.len() as u64).to_le_bytes());
            for value in name {
                hash.update(value.to_le_bytes());
            }
            hash.update(part.size.to_le_bytes());
            hash.update(part.flags.to_le_bytes());
            hash.update(part.sha256);
        }
        hash.finalize().into()
    }
    pub fn same_contents(&self, other: &Self) -> bool {
        // Native substream order need not be identical; no payload is omitted.
        self.parts == other.parts && self.security == other.security
    }
    pub fn has_ea(&self) -> bool {
        self.parts.contains_key(&Key::Ea)
    }
}
struct Reader<'a, R> {
    source: R,
    budget: &'a mut WorkBudget,
    cancel: &'a AtomicBool,
    total: u64,
    digest: Sha256,
}
impl<R: Read> Reader<'_, R> {
    fn read(&mut self, bytes: &mut [u8]) -> Result<usize> {
        check(self.cancel)?;
        let capacity = self.budget.remaining().min(bytes.len() as u64) as usize;
        if capacity == 0 {
            return Err(Error::Limit);
        }
        let n = self
            .source
            .read(&mut bytes[..capacity])
            .map_err(|e| io_error("carrierRead", e))?;
        if n > capacity {
            return Err(Error::Invalid);
        }
        charge(self.budget, n)?;
        self.total = self.total.checked_add(n as u64).ok_or(Error::Limit)?;
        self.digest.update(&bytes[..n]);
        Ok(n)
    }
    fn exact(&mut self, mut bytes: &mut [u8]) -> Result<()> {
        while !bytes.is_empty() {
            let n = self.read(bytes)?;
            if n == 0 {
                return Err(Error::Invalid);
            }
            bytes = &mut bytes[n..];
        }
        Ok(())
    }
}
pub(super) fn parse<R: Read>(
    source: R,
    expected: &Expected,
    budget: &mut WorkBudget,
    cancel: &AtomicBool,
    resident: &Resident,
) -> Result<Parsed> {
    parse_profile(source, expected, true, budget, cancel, resident)
}
pub(super) fn parse_profile<R: Read>(
    source: R,
    expected: &Expected,
    full: bool,
    budget: &mut WorkBudget,
    cancel: &AtomicBool,
    resident: &Resident,
) -> Result<Parsed> {
    let memory = resident.lease(CATALOG_RESIDENT)?;
    let _scratch = resident.lease(2 * BLOCK)?;
    if !expected.contains_key(&Vec::new()) || expected.len() > BLOCK / 24 {
        return Err(Error::Invalid);
    }
    // Four catalog allocations are bounded by the <=64KiB native inventory.
    // Sum of admitted stream-name bytes <=64KiB; no DATA body is retained.
    let mut names = 0usize;
    let mut parts = BTreeMap::new();
    let mut security = None;
    let mut security_record = None;
    let mut input = Reader {
        source,
        budget,
        cancel,
        total: 0,
        digest: Sha256::new(),
    };
    let mut scratch = vec![0u8; BLOCK];
    loop {
        let record_start = input.total;
        let mut head = [0u8; 20];
        let n = input.read(&mut head[..1])?;
        if n == 0 {
            break;
        }
        input.exact(&mut head[1..])?;
        let id = u32::from_le_bytes(head[..4].try_into().expect("fixed"));
        let flags = u32::from_le_bytes(head[4..8].try_into().expect("fixed"));
        let size = u64::from_le_bytes(head[8..16].try_into().expect("fixed"));
        let length = u32::from_le_bytes(head[16..20].try_into().expect("fixed")) as usize;
        if length > BLOCK || !length.is_multiple_of(2) || size > STREAM_LIMIT {
            return Err(Error::Limit);
        }
        if flags != 0 && !(id == 3 && flags == 2) {
            return Err(Error::Unsupported);
        }
        // LINK/objectID/reparse/sparse/EFS/TxF/property/unknown never reach BackupWrite.
        if !matches!(id, 1..=4) || (!full && id == 3) {
            return Err(Error::Unsupported);
        }
        if matches!(id, 2 | 3) && (length != 0 || size > BLOCK as u64) {
            return Err(Error::Unsupported);
        }
        names = names.checked_add(length).ok_or(Error::Limit)?;
        if names > BLOCK {
            return Err(Error::Limit);
        }
        input.exact(&mut scratch[..length])?;
        let name: Vec<u16> = scratch[..length]
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect();
        let key = match id {
            1 if length == 0 => Key::Data(Vec::new()),
            4 if length != 0 => Key::Data(name),
            2 => Key::Ea,
            3 => Key::Security,
            _ => return Err(Error::Invalid),
        };
        if let Key::Data(name) = &key
            && expected.get(name) != Some(&size)
        {
            return Err(Error::Changed);
        }
        if parts.contains_key(&key) {
            return Err(Error::Invalid);
        }
        let mut hash = Sha256::new();
        let mut remaining = size;
        let mut descriptor = Vec::new();
        if id == 3 {
            descriptor.reserve_exact(size as usize);
        }
        while remaining != 0 {
            let n = remaining.min(BLOCK as u64) as usize;
            input.exact(&mut scratch[..n])?;
            hash.update(&scratch[..n]);
            if id == 3 {
                descriptor.extend_from_slice(&scratch[..n]);
            }
            remaining -= n as u64;
        }
        if id == 3 {
            security = Some(
                full_security_records::complete(&descriptor, input.budget, cancel)
                    .map_err(record)?,
            );
            security_record = Some(record_start..input.total);
        }
        parts.insert(
            key,
            Part {
                size,
                flags,
                sha256: hash.finalize().into(),
            },
        );
        if parts.len() > expected.len() + 2 {
            return Err(Error::Limit);
        }
    }
    // BackupRead can omit the physical default record for a zero-size regular
    // file in either security profile, including one with EA or named streams.
    // The supplied inventory already observed that empty default on the same
    // original handle. Record only its semantic fact: never synthesize carrier
    // bytes, a successful native write, or the required full-security record.
    if expected.get(&Vec::new()) == Some(&0) && !parts.contains_key(&Key::Data(Vec::new())) {
        parts.insert(
            Key::Data(Vec::new()),
            Part {
                size: 0,
                flags: 0,
                sha256: Sha256::digest([]).into(),
            },
        );
    }
    let data_count = parts.keys().filter(|k| matches!(k, Key::Data(_))).count();
    if data_count != expected.len() {
        #[cfg(test)]
        eprintln!(
            "FARFOLD_ORDINARY_DIAGNOSTIC phase=carrier-data-count full={full} native_bytes={} expected_data={} actual_data={data_count} expected_zero_default={} actual_default={}",
            input.total,
            expected.len(),
            expected.get(&Vec::new()) == Some(&0),
            parts.contains_key(&Key::Data(Vec::new())),
        );
        return Err(Error::Changed);
    }
    if full && security.is_none() {
        return Err(Error::Invalid);
    }
    Ok(Parsed {
        _memory: memory,
        parts,
        bytes: input.total,
        sha256: input.digest.finalize().into(),
        security,
        security_record,
    })
}
#[cfg(test)]
#[path = "material_carrier_records_tests.rs"]
mod tests;
