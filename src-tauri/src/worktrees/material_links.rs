//! Transient full-ID/name membership; no names, handles or index are persisted.
use crate::file_access::Identity;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicBool, Ordering},
};

type Key = (u64, u128);
type Name = [u8; 32];
struct Group {
    declared: u64,
    observed: u64,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Failure {
    Cancelled,
    Limit,
    Changed,
    UnaccountedLinks,
    InvalidName,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Observation {
    pub objects: u64,
    pub names: u64,
    pub aliases: u64,
    pub sha256: [u8; 32],
}
pub(super) struct Topology {
    limit: u64,
    groups: BTreeMap<Key, Group>,
    // Each raw UTF-16 relative name is hashed once. Fixed-size keys prevent
    // 100k deep paths from becoming a second retained path/body inventory.
    // Duplicate keys refuse, including a hypothetical digest collision.
    names: BTreeMap<Name, Key>,
    finished: bool,
}
fn check(cancel: &AtomicBool) -> Result<(), Failure> {
    if cancel.load(Ordering::SeqCst) {
        Err(Failure::Cancelled)
    } else {
        Ok(())
    }
}
fn field(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_le_bytes());
    hash.update(bytes);
}
fn relative_name(raw: &[u16], cancel: &AtomicBool) -> Result<Name, Failure> {
    if raw.is_empty() {
        return Err(Failure::InvalidName);
    }
    let mut components = 0usize;
    for part in raw.split(|v| *v == u16::from(b'/')) {
        components += 1;
        if components > 65
            || part.is_empty()
            || part.len() > 255
            || part == [u16::from(b'.')]
            || part == [u16::from(b'.'); 2]
            || part.ends_with(&[u16::from(b'.')])
            || part.ends_with(&[u16::from(b' ')])
            || part.iter().any(|v| {
                *v < 32
                    || (0x7f..=0x9f).contains(v)
                    || [b'\\', b':', b'?', b'*', b'"', b'<', b'>', b'|']
                        .iter()
                        .any(|c| *v == u16::from(*c))
            })
        {
            return Err(Failure::InvalidName);
        }
    }
    // Existing walk permits at most64 nested directories plus a regular file.
    // No String conversion, case folding, Unicode normalization or DOS reopen.
    let mut hash = Sha256::new();
    field(&mut hash, b"farfold-raw-utf16-relative-member-v1");
    hash.update((raw.len() as u64).to_le_bytes());
    for (i, unit) in raw.iter().enumerate() {
        if i.is_multiple_of(256) {
            check(cancel)?;
        }
        hash.update(unit.to_le_bytes());
    }
    Ok(hash.finalize().into())
}
impl Topology {
    pub(super) fn new(limit: u64) -> Self {
        Self {
            limit,
            groups: BTreeMap::new(),
            names: BTreeMap::new(),
            finished: false,
        }
    }
    pub(super) fn observe(
        &mut self,
        identity: &Identity,
        links: u64,
        raw_relative: &[u16],
        cancel: &AtomicBool,
    ) -> Result<(), Failure> {
        check(cancel)?;
        if self.finished || identity.inode == 0 || links == 0 {
            return Err(Failure::Changed);
        }
        if links > self.limit || self.names.len() as u64 >= self.limit {
            return Err(Failure::Limit);
        }
        let key = (identity.device, identity.inode);
        let name = relative_name(raw_relative, cancel)?;
        if self.names.contains_key(&name) {
            // Repeating a path cannot satisfy a missing hardlink elsewhere.
            return Err(Failure::Changed);
        }
        if let Some(group) = self.groups.get(&key)
            && (group.declared != links || group.observed >= links)
        {
            return Err(Failure::Changed);
        }
        let group = self.groups.entry(key).or_insert(Group {
            declared: links,
            observed: 0,
        });
        group.observed = group.observed.checked_add(1).ok_or(Failure::Limit)?;
        self.names.insert(name, key);
        Ok(())
    }
    pub(super) fn finish(&mut self, cancel: &AtomicBool) -> Result<Observation, Failure> {
        if self.finished {
            return Err(Failure::Changed);
        }
        self.finished = true;
        // Retire both transient maps on every success/error before returning.
        let groups = std::mem::take(&mut self.groups);
        let names = std::mem::take(&mut self.names);
        check(cancel)?;
        for group in groups.values() {
            check(cancel)?;
            if group.observed < group.declared {
                // Includes links outside the admitted tree or excluded .git.
                return Err(Failure::UnaccountedLinks);
            }
            if group.observed != group.declared {
                return Err(Failure::Changed);
            }
        }
        let objects = groups.len() as u64;
        let count = names.len() as u64;
        let aliases = count.checked_sub(objects).ok_or(Failure::Changed)?;
        let mut hash = Sha256::new();
        field(&mut hash, b"farfold-observed-fullid-hardlink-membership-v1");
        field(&mut hash, &objects.to_le_bytes());
        field(&mut hash, &count.to_le_bytes());
        for ((device, inode), group) in &groups {
            check(cancel)?;
            field(&mut hash, &device.to_le_bytes());
            field(&mut hash, &inode.to_le_bytes());
            field(&mut hash, &group.declared.to_le_bytes());
            field(&mut hash, &group.observed.to_le_bytes());
        }
        for (name, (device, inode)) in &names {
            check(cancel)?;
            field(&mut hash, name);
            field(&mut hash, &device.to_le_bytes());
            field(&mut hash, &inode.to_le_bytes());
        }
        Ok(Observation {
            objects,
            names: count,
            aliases,
            sha256: hash.finalize().into(),
        })
    }
}

#[cfg(test)]
#[path = "material_links_tests.rs"]
mod tests;
