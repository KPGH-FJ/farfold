//! Logical resident ownership for the material-only directory collector.
//! No RSS/allocator/OS-cache bound and no new directory/material admission.
use super::{
    directory_page::{self, Entries, Failure, MAX_ENTRIES, Observation, PAGE_BYTES},
    material_carrier_records::{Resident, ResidentLease},
};
use std::{collections::btree_map, mem::size_of, ops::Index, sync::atomic::AtomicBool};

// Logical per-entry representation: key/value plus a declared structural
// allowance. BTree allocator nodes/rounding and arbitrary caller-made copies
// are not measured or claimed. The counted name payload is charged separately.
const ENTRY_BYTES: usize = size_of::<(Vec<u16>, Observation)>() + 4 * size_of::<usize>();
pub(super) const QUERY_BYTES: usize = 2 * PAGE_BYTES;

fn entry_bytes(name_bytes: usize) -> Result<usize, Failure> {
    ENTRY_BYTES.checked_add(name_bytes).ok_or(Failure::Limit)
}
fn lease(resident: &Resident, bytes: usize) -> Result<ResidentLease, Failure> {
    resident.lease(bytes).map_err(|_| Failure::Limit)
}
fn grow(resident: &Resident, memory: &mut ResidentLease, bytes: usize) -> Result<(), Failure> {
    resident.grow(memory, bytes).map_err(|_| Failure::Limit)
}
// Field drop order is intentional: real maps/closures go away BEFORE their
// reservations. No into-map/Clone escape can discard a live map's lease.
#[derive(Debug)]
pub(crate) struct MaterialEntries {
    entries: Entries,
    _memory: ResidentLease,
}
impl PartialEq for MaterialEntries {
    fn eq(&self, other: &Self) -> bool {
        self.entries == other.entries
    }
}
impl Eq for MaterialEntries {}
impl MaterialEntries {
    pub(super) fn len(&self) -> usize {
        self.entries.len()
    }
    pub(super) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    pub(super) fn keys(&self) -> btree_map::Keys<'_, Vec<u16>, Observation> {
        self.entries.keys()
    }
    pub(super) fn iter(&self) -> btree_map::Iter<'_, Vec<u16>, Observation> {
        self.entries.iter()
    }
    pub(super) fn contains_key(&self, raw: &[u16]) -> bool {
        self.entries.contains_key(raw)
    }
    pub(super) fn as_entries(&self) -> &Entries {
        &self.entries
    }
}
impl Index<&Vec<u16>> for MaterialEntries {
    type Output = Observation;
    fn index(&self, raw: &Vec<u16>) -> &Self::Output {
        &self.entries[raw]
    }
}
struct QueryOwner<F> {
    query: F,
    _buffers: ResidentLease,
}
pub(super) fn collect(
    volume: u64,
    remaining: usize,
    cancel: &AtomicBool,
    resident: &Resident,
    query: impl FnMut() -> Result<Option<Vec<u8>>, Failure>,
) -> Result<MaterialEntries, Failure> {
    directory_page::cancelled(cancel)?;
    // Native adapter allocates its aligned buffer lazily on the first query.
    // This single reservation covers that buffer AND the returned page copy.
    let buffers = lease(resident, QUERY_BYTES)?;
    let mut source = QueryOwner {
        query,
        _buffers: buffers,
    };
    let limit = remaining.min(MAX_ENTRIES);
    let mut result = MaterialEntries {
        entries: Entries::new(),
        _memory: lease(resident, 0)?,
    };
    let mut dots = [false; 2];
    loop {
        directory_page::cancelled(cancel)?;
        let bytes = (source.query)()?;
        directory_page::cancelled(cancel)?;
        let Some(bytes) = bytes else {
            return Ok(result);
        };
        // The page parser's own temporary tree has a separate live lease.
        // Records moved to the result briefly have both tree reservations.
        let mut page_memory = lease(resident, 0)?;
        let page = directory_page::page_reserved(&bytes, volume, cancel, |name| {
            grow(resident, &mut page_memory, entry_bytes(name)?)
        })?;
        for (name, value) in page {
            directory_page::cancelled(cancel)?;
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
            if result.entries.contains_key(&name) {
                return Err(Failure::Changed);
            }
            if result.entries.len() >= limit {
                return Err(Failure::Limit);
            }
            let names = name.len().checked_mul(2).ok_or(Failure::Limit)?;
            grow(resident, &mut result._memory, entry_bytes(names)?)?;
            result.entries.insert(name, value);
        }
    }
}

#[cfg(test)]
#[path = "material_directory_budget_tests.rs"]
mod tests;
