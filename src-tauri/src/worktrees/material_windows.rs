//! Read-only namespace/default-data/EA plus held DATA stream observations.
//! Partial default profile; explicit strict-security adds full SD bytes only.
//! No link/security restoration, atomic snapshot, or complete material authority.
//! The linked root .git pointer keeps its historical explicit skip.
use super::{
    ListingBudget, MaterialSummary, hex,
    links::{self, Topology},
};
use crate::{
    file_access::{
        DirectoryObservation, EaFailure, EaObservation, EaWorkBudget, FullSecurityFailure,
        FullSecurityObservation, IntegrityObservation, MetadataKind, PinnedPath, RetiredBackup,
        SecurityObservation, StreamsFailure, StreamsObservation, directory_entries, ea_observation,
        full_security_observation, integrity_observation, metadata_child, metadata_file,
        security_observation, streams_observation,
    },
    worktrees::{
        recycle_types::MaterialProfile,
        types::{Result, error},
    },
};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};
use windows_sys::Win32::Globalization::{CSTR_EQUAL, CompareStringOrdinal};
const MAX_ENTRIES: u64 = 100_000;
const MAX_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_FILE: u64 = 256 * 1024 * 1024;
// One completed-returned work cap shared by EA, stream inventories and
// BackupRead/default/named/opaque bytes, including all rechecks. Not RSS/I/O.
const MAX_OBSERVATION_WORK: u64 = 1024 * 1024 * 1024;
struct Scan {
    hash: Sha256,
    entries: ListingBudget,
    bytes: u64,
    ea_work: EaWorkBudget,
    links: Topology,
    full_security: bool,
}
fn full_error(value: FullSecurityFailure) -> crate::worktrees::types::Failure {
    error(match value {
        FullSecurityFailure::AccessCondition { .. } => "securityAccessRequired",
        FullSecurityFailure::Record(EaFailure::Cancelled) => "cancelled",
        FullSecurityFailure::Record(EaFailure::Changed) => "materialChanged",
        FullSecurityFailure::Record(EaFailure::Limit) => "materialLimit",
        _ => "unavailable",
    })
}
impl Scan {
    fn observe_full_security(
        &mut self,
        pin: &PinnedPath,
        cancel: &AtomicBool,
    ) -> Result<Option<FullSecurityObservation>> {
        if !self.full_security {
            return Ok(None);
        }
        full_security_observation(pin, &mut self.ea_work, cancel)
            .map(Some)
            .map_err(full_error)
    }
    fn full_security_field(&mut self, value: &Option<FullSecurityObservation>) {
        if let Some(value) = value {
            self.field(&value.requested_information().to_le_bytes());
            self.field(&value.aces().to_le_bytes());
            self.field(&value.returned_bytes().to_le_bytes());
            self.field(value.sha256());
        }
    }
    fn ea(&mut self, value: &EaObservation) {
        self.field(&value.count.to_le_bytes());
        self.field(&value.logical_bytes.to_le_bytes());
        self.field(&value.sha256);
    }
    fn observe_ea(&mut self, pin: &PinnedPath, cancel: &AtomicBool) -> Result<EaObservation> {
        ea_observation(pin, &mut self.ea_work, cancel).map_err(|e| {
            error(match e {
                EaFailure::Cancelled => "cancelled",
                EaFailure::Changed => "materialChanged",
                EaFailure::Limit => "materialLimit",
                _ => "unavailable",
            })
        })
    }
    fn integrity(&mut self, value: &IntegrityObservation) {
        self.field(&value.labels.to_le_bytes());
        self.field(&value.logical_bytes.to_le_bytes());
        self.field(&value.sha256);
    }
    fn observe_integrity(
        &mut self,
        pin: &PinnedPath,
        cancel: &AtomicBool,
    ) -> Result<IntegrityObservation> {
        integrity_observation(pin, &mut self.ea_work, cancel).map_err(|e| {
            error(match e {
                EaFailure::Cancelled => "cancelled",
                EaFailure::Changed => "materialChanged",
                EaFailure::Limit => "materialLimit",
                _ => "unavailable",
            })
        })
    }
    fn security(&mut self, value: &SecurityObservation) {
        self.field(&value.aces.to_le_bytes());
        self.field(&value.logical_bytes.to_le_bytes());
        self.field(&value.sha256);
    }
    fn observe_security(
        &mut self,
        pin: &PinnedPath,
        cancel: &AtomicBool,
    ) -> Result<SecurityObservation> {
        security_observation(pin, &mut self.ea_work, cancel).map_err(|e| {
            error(match e {
                EaFailure::Cancelled => "cancelled",
                EaFailure::Changed => "materialChanged",
                EaFailure::Limit => "materialLimit",
                _ => "unavailable",
            })
        })
    }
    fn streams(&mut self, value: &StreamsObservation) {
        self.field(&value.count.to_le_bytes());
        self.field(&value.logical_bytes.to_le_bytes());
        self.field(&value.sha256);
    }
    fn observe_streams(
        &mut self,
        pin: PinnedPath,
        cancel: &AtomicBool,
        retired: &mut Option<RetiredBackup>,
    ) -> Result<(PinnedPath, StreamsObservation)> {
        streams_observation(pin, &mut self.ea_work, cancel, retired).map_err(|failure| {
            error(match failure {
                StreamsFailure::Cancelled => "cancelled",
                StreamsFailure::Limit => "materialLimit",
                StreamsFailure::Changed => "materialChanged",
                _ => "unavailable",
            })
        })
    }
    fn field(&mut self, bytes: &[u8]) {
        self.hash.update((bytes.len() as u64).to_le_bytes());
        self.hash.update(bytes);
    }
}
fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::SeqCst) {
        Err(error("cancelled"))
    } else {
        Ok(())
    }
}
fn ordinal(raw: &[u16], name: &str) -> Result<bool> {
    let fixed = name.encode_utf16().collect::<Vec<_>>();
    let result = unsafe {
        CompareStringOrdinal(
            raw.as_ptr(),
            raw.len() as i32,
            fixed.as_ptr(),
            fixed.len() as i32,
            1,
        )
    };
    if result == 0 {
        Err(error("unavailable"))
    } else {
        Ok(result == CSTR_EQUAL)
    }
}
fn admitted(value: &DirectoryObservation) -> Result<()> {
    // Refuse declared reparse/offline/recall/EFS profiles before content reads.
    // This is not an arbitrary concurrent hydration/recall-prevention guarantee.
    // Other recorded attributes remain observation data, not restore promises.
    if value.reparse_tag.is_some()
        || value.attributes & (0x400 | 0x1000 | 0x4000 | 0x40000 | 0x400000) != 0
    {
        return Err(error("specialFile"));
    }
    Ok(())
}
fn enumeration_error(
    value: crate::file_access::DirectoryFailure,
) -> crate::worktrees::types::Failure {
    use crate::file_access::DirectoryFailure as F;
    error(match value {
        F::Cancelled => "cancelled",
        F::Limit => "materialLimit",
        F::Changed => "materialChanged",
        _ => "unavailable",
    })
}
fn topology_error(value: links::Failure) -> crate::worktrees::types::Failure {
    error(match value {
        links::Failure::Cancelled => "cancelled",
        links::Failure::Limit => "materialLimit",
        links::Failure::Changed => "materialChanged",
        links::Failure::UnaccountedLinks => "specialFile",
        links::Failure::InvalidName => "unsafePath",
    })
}
fn names_field(raw: &[u16]) -> Vec<u8> {
    raw.iter().flat_map(|v| v.to_le_bytes()).collect()
}
fn walk(
    scan: &mut Scan,
    dir: PinnedPath,
    prefix: &[u16],
    depth: usize,
    cancel: &AtomicBool,
    retired: &mut Option<RetiredBackup>,
) -> Result<PinnedPath> {
    if depth > 64 {
        return Err(error("materialLimit"));
    }
    cancelled(cancel)?;
    dir.verify().map_err(|_| error("materialChanged"))?;
    let before = metadata_file(dir.file()).map_err(|_| error("unavailable"))?;
    if before.kind != MetadataKind::Directory {
        return Err(error("specialFile"));
    }
    // The same shared completed-returned budget charges BOTH actual security
    // queries. Raw descriptors retire inside observation before recursion.
    // Stored label is an independent READ_CONTROL facet, not full audit SACL.
    let full_before = scan.observe_full_security(&dir, cancel)?;
    scan.full_security_field(&full_before);
    let integrity_before = scan.observe_integrity(&dir, cancel)?;
    scan.integrity(&integrity_before);
    let security_before = scan.observe_security(&dir, cancel)?;
    scan.security(&security_before);
    // Directory EA gets one pre/post pair here, never a second pair in
    // its parent. Only this fixed-size digest survives recursion.
    let ea_before = scan.observe_ea(&dir, cancel)?;
    scan.ea(&ea_before);
    let (dir, streams_before) = scan.observe_streams(dir, cancel, retired)?;
    if streams_before.default_present {
        return Err(error("specialFile"));
    }
    scan.streams(&streams_before);
    // Reserve the entire returned listing before processing even its first
    // child. The parent map remains alive across recursive calls.
    let (listed, first_capacity) = scan.entries.collect(
        cancel,
        |capacity| directory_entries(&dir, capacity, cancel).map_err(enumeration_error),
        |values| values.len(),
    )?;
    let mut dot_git = 0;
    let mut bare = [false; 3];
    for raw in listed.keys() {
        if ordinal(raw, ".git")? {
            dot_git += 1;
        }
        for (slot, name) in bare.iter_mut().zip(["HEAD", "objects", "refs"]) {
            if ordinal(raw, name)? {
                *slot = true;
            }
        }
    }
    if dot_git > 1 {
        return Err(error("unsafePath"));
    }
    if depth > 0 && (dot_git != 0 || bare.iter().all(|v| *v)) {
        return Err(error("nestedRepository"));
    }
    scan.field(&before.version_fields());
    for (raw, observed) in &listed {
        cancelled(cancel)?;
        admitted(observed)?;
        if depth == 0 && ordinal(raw, ".git")? {
            if observed.attributes & 0x10 != 0 {
                return Err(error("notLinked"));
            }
            // The linked Git pointer is checked by the independent Git scope.
            continue;
        }
        if ordinal(raw, ".gitmodules")? {
            return Err(error("submodules"));
        }
        let text = String::from_utf16(raw).map_err(|_| error("unsafePath"))?;
        let metadata = metadata_child(dir.file(), OsStr::new(&text))
            .map_err(|_| error("unavailable"))?
            .ok_or(error("materialChanged"))?;
        if !metadata.matches_directory_entry(observed) {
            return Err(error("materialChanged"));
        }
        let directory = metadata.kind == MetadataKind::Directory;
        if !directory && metadata.kind != MetadataKind::File {
            return Err(error("specialFile"));
        }
        let mut child = dir.child(raw, directory).map_err(|e| {
            if scan.full_security {
                full_error(FullSecurityFailure::child_open(e))
            } else {
                error("unavailable")
            }
        })?;
        let opened = metadata_file(child.file()).map_err(|_| error("unavailable"))?;
        if opened != metadata || !opened.matches_directory_entry(observed) {
            return Err(error("materialChanged"));
        }
        let mut relative = prefix.to_vec();
        if !relative.is_empty() {
            relative.push(u16::from(b'/'));
        }
        relative.extend(raw);
        scan.field(&names_field(&relative));
        scan.field(&opened.version_fields());
        // EaSize is only a recorded hint; no empty-EA claim follows from zero.
        scan.field(&observed.ea_size.to_le_bytes());
        if directory {
            child = walk(scan, child, &relative, depth + 1, cancel, retired)?;
        } else {
            let full_before = scan.observe_full_security(&child, cancel)?;
            scan.full_security_field(&full_before);
            let integrity_before = scan.observe_integrity(&child, cancel)?;
            scan.integrity(&integrity_before);
            let security_before = scan.observe_security(&child, cancel)?;
            scan.security(&security_before);
            let ea_before = scan.observe_ea(&child, cancel)?;
            scan.ea(&ea_before);
            let stamp =
                crate::file_access::stamp(child.file()).map_err(|_| error("unavailable"))?;
            if !stamp.regular || stamp.size > MAX_FILE {
                return Err(error("materialLimit"));
            }
            scan.bytes = scan
                .bytes
                .checked_add(stamp.size)
                .ok_or(error("materialLimit"))?;
            if scan.bytes > MAX_BYTES {
                return Err(error("materialLimit"));
            }
            let (owned, streams) = scan.observe_streams(child, cancel, retired)?;
            child = owned;
            if !streams.default_present
                || streams.default_size != stamp.size
                || crate::file_access::stamp(child.file()).map_err(|_| error("unavailable"))?
                    != stamp
            {
                return Err(error("materialChanged"));
            }
            scan.field(&streams.default_sha256);
            scan.streams(&streams);
            if scan.observe_ea(&child, cancel)? != ea_before {
                return Err(error("materialChanged"));
            }
            if scan.observe_security(&child, cancel)? != security_before {
                return Err(error("materialChanged"));
            }
            if scan.observe_integrity(&child, cancel)? != integrity_before {
                return Err(error("materialChanged"));
            }
            if scan.observe_full_security(&child, cancel)? != full_before {
                return Err(error("materialChanged"));
            }
            // This is the same held child's full stamp already paired around
            // its streams/EA/security reads. No path reopen or link enumeration
            // outside the authorized namespace is used to fill missing names.
            scan.links
                .observe(&stamp.identity, stamp.links, &relative, cancel)
                .map_err(topology_error)?;
        }
        if metadata_file(child.file()).map_err(|_| error("unavailable"))? != opened
            || metadata_child(dir.file(), OsStr::new(&text))
                .map_err(|_| error("unavailable"))?
                .as_ref()
                != Some(&opened)
        {
            return Err(error("materialChanged"));
        }
        child.verify().map_err(|_| error("materialChanged"))?;
    }
    if scan.observe_ea(&dir, cancel)? != ea_before {
        return Err(error("materialChanged"));
    }
    if scan.observe_security(&dir, cancel)? != security_before {
        return Err(error("materialChanged"));
    }
    if scan.observe_integrity(&dir, cancel)? != integrity_before {
        return Err(error("materialChanged"));
    }
    if scan.observe_full_security(&dir, cancel)? != full_before {
        return Err(error("materialChanged"));
    }
    // A complete second observation checks names/IDs/metadata after traversal;
    // it is still not an atomic snapshot against arbitrary external writers.
    if directory_entries(&dir, first_capacity, cancel).map_err(enumeration_error)? != listed
        || metadata_file(dir.file()).map_err(|_| error("unavailable"))? != before
    {
        return Err(error("materialChanged"));
    }
    dir.verify().map_err(|_| error("materialChanged"))?;
    let (dir, streams_after) = scan.observe_streams(dir, cancel, retired)?;
    if streams_before != streams_after {
        return Err(error("materialChanged"));
    }
    cancelled(cancel)?;
    Ok(dir)
}
#[cfg(test)]
pub(super) fn capture(
    root: &Path,
    cancel: &AtomicBool,
    retired: &mut Option<RetiredBackup>,
) -> Result<MaterialSummary> {
    let root = PinnedPath::directory(root).map_err(|_| error("unsafePath"))?;
    capture_pin(root, false, cancel, retired)
}
pub(super) fn capture_security_complete(
    root: &Path,
    expected: &super::super::inspect::Stamp,
    cancel: &AtomicBool,
    retired: &mut Option<RetiredBackup>,
) -> Result<MaterialSummary> {
    cancelled(cancel)?;
    let root = PinnedPath::directory_full_security(root).map_err(full_error)?;
    if &super::super::inspect::pinned_stamp(&root)? != expected {
        return Err(error("materialChanged"));
    }
    capture_pin(root, true, cancel, retired)
}
fn capture_pin(
    root: PinnedPath,
    full_security: bool,
    cancel: &AtomicBool,
    retired: &mut Option<RetiredBackup>,
) -> Result<MaterialSummary> {
    let mut scan = Scan {
        hash: Sha256::new(),
        entries: ListingBudget::new(MAX_ENTRIES),
        bytes: 0,
        ea_work: EaWorkBudget::new(MAX_OBSERVATION_WORK),
        links: Topology::new(MAX_ENTRIES),
        full_security,
    };
    scan.field(if full_security {
        b"farfold-windows-default-data-ea-streams-links-full-security-observation-v1".as_slice()
    } else {
        b"farfold-windows-default-data-ea-streams-owner-group-dacl-links-label-observation-v1"
            .as_slice()
    });
    let _root = walk(&mut scan, root, &[], 0, cancel, retired)?;
    // All regular names must account for every observed declared link before
    // a partial observation can publish. Both transient maps retire here.
    let topology = scan.links.finish(cancel).map_err(topology_error)?;
    scan.field(&topology.objects.to_le_bytes());
    scan.field(&topology.names.to_le_bytes());
    scan.field(&topology.aliases.to_le_bytes());
    scan.field(&topology.sha256);
    Ok(MaterialSummary {
        profile: Some(if full_security {
            MaterialProfile::WindowsDefaultDataEaStreamsLinksFullSecurityV1
        } else {
            MaterialProfile::WindowsDefaultDataEaStreamsOwnerGroupDaclLinksLabelV1
        }),
        entries: scan.entries.reserved,
        bytes: scan.bytes,
        sha256: hex(scan.hash.finalize()),
    })
}
