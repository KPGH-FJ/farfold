//! Typed DIRECTORY backup bytes only: no default DATA or implicit security.
//! Source kind/actual EOF are supplied by the held native caller, never inferred.
use super::{
    ea_records::{self, WorkBudget},
    full_security_records,
    material_carrier_records::{
        BLOCK, CATALOG_RESIDENT, Error, Expected, Resident, ResidentLease, Result, STREAM_LIMIT,
        charge, check, io_error, record,
    },
};
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::io;
use std::{collections::BTreeMap, io::Read, sync::atomic::AtomicBool};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Profile {
    PayloadOnly,
    WithFullSecurity,
}
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
    pub security_record: Option<std::ops::Range<u64>>,
    pub ea: Option<ea_records::Observation>,
    _memory: ResidentLease,
}
impl PartialEq for Parsed {
    fn eq(&self, other: &Self) -> bool {
        self.parts == other.parts
            && self.bytes == other.bytes
            && self.sha256 == other.sha256
            && self.security == other.security
            && self.ea == other.ea
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
        self.parts == other.parts && self.security == other.security && self.ea == other.ea
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
    profile: Profile,
    budget: &mut WorkBudget,
    cancel: &AtomicBool,
    resident: &Resident,
) -> Result<Parsed> {
    let memory = resident.lease(CATALOG_RESIDENT)?;
    let _scratch = resident.lease(2 * BLOCK)?;
    if expected.contains_key(&Vec::new()) || expected.len() > BLOCK / 24 {
        return Err(Error::Invalid);
    }
    // Four catalog allocations are bounded by the <=64KiB native inventory.
    // Sum of admitted stream-name bytes <=64KiB; no DATA body is retained.
    let mut names = 0usize;
    let mut parts = BTreeMap::new();
    let mut security = None;
    let mut security_record = None;
    let mut ea = None;
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
        // Default DATA/LINK/objectID/reparse/sparse/EFS/TxF/property/unknown are not admitted.
        if !matches!(id, 2..=4) || (id == 3 && profile == Profile::PayloadOnly) {
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
        if matches!(id, 2 | 3) {
            descriptor.reserve_exact(size as usize);
        }
        while remaining != 0 {
            let n = remaining.min(BLOCK as u64) as usize;
            input.exact(&mut scratch[..n])?;
            hash.update(&scratch[..n]);
            if matches!(id, 2 | 3) {
                descriptor.extend_from_slice(&scratch[..n]);
            }
            remaining -= n as u64;
        }
        if id == 2 {
            ea = Some(
                ea_records::complete(0, descriptor.len(), &descriptor, input.budget, cancel)
                    .map_err(record)?,
            );
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
    let data_count = parts.keys().filter(|k| matches!(k, Key::Data(_))).count();
    if data_count != expected.len() {
        return Err(Error::Changed);
    }
    if profile == Profile::WithFullSecurity && security.is_none() {
        return Err(Error::Invalid);
    }
    Ok(Parsed {
        _memory: memory,
        parts,
        bytes: input.total,
        sha256: input.digest.finalize().into(),
        security,
        security_record,
        ea,
    })
}

#[cfg(test)]
#[path = "material_directory_records_tests.rs"]
mod tests;
