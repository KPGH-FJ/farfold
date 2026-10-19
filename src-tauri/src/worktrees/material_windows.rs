//! Read-only namespace/default-data version profile. Not a complete Windows
//! material backup: ADS, EA and security contents are not captured here.
use super::{ListingBudget, MaterialSummary, hex};
use crate::{
    file_access::{
        DirectoryObservation, MetadataKind, PinnedPath, directory_entries, metadata_child,
        metadata_file,
    },
    worktrees::{
        recycle_types::MaterialProfile,
        types::{Result, error},
    },
};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    io::Read,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};
use windows_sys::Win32::Globalization::{CSTR_EQUAL, CompareStringOrdinal};
const MAX_ENTRIES: u64 = 100_000;
const MAX_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_FILE: u64 = 256 * 1024 * 1024;
struct Scan {
    hash: Sha256,
    entries: ListingBudget,
    bytes: u64,
}
impl Scan {
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
fn names_field(raw: &[u16]) -> Vec<u8> {
    raw.iter().flat_map(|v| v.to_le_bytes()).collect()
}
fn walk(
    scan: &mut Scan,
    dir: &PinnedPath,
    prefix: &[u16],
    depth: usize,
    cancel: &AtomicBool,
) -> Result<()> {
    if depth > 64 {
        return Err(error("materialLimit"));
    }
    cancelled(cancel)?;
    dir.verify().map_err(|_| error("materialChanged"))?;
    let before = metadata_file(dir.file()).map_err(|_| error("unavailable"))?;
    if before.kind != MetadataKind::Directory {
        return Err(error("specialFile"));
    }
    // Reserve the entire returned listing before processing even its first
    // child. The parent map remains alive across recursive calls.
    let (listed, first_capacity) = scan.entries.collect(
        cancel,
        |capacity| directory_entries(dir, capacity, cancel).map_err(enumeration_error),
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
        let child = dir
            .child(raw, directory)
            .map_err(|_| error("unavailable"))?;
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
            walk(scan, &child, &relative, depth + 1, cancel)?;
        } else {
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
            let mut bytes = 0u64;
            let mut hash = Sha256::new();
            let mut file = child.file();
            let mut buffer = [0u8; 65_536];
            loop {
                cancelled(cancel)?;
                let n = file.read(&mut buffer).map_err(|_| error("unavailable"))?;
                if n == 0 {
                    break;
                }
                bytes = bytes.checked_add(n as u64).ok_or(error("materialLimit"))?;
                if bytes > stamp.size {
                    return Err(error("materialChanged"));
                }
                hash.update(&buffer[..n]);
            }
            if bytes != stamp.size
                || crate::file_access::stamp(child.file()).map_err(|_| error("unavailable"))?
                    != stamp
            {
                return Err(error("materialChanged"));
            }
            scan.field(&hash.finalize());
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
    // A complete second observation checks names/IDs/metadata after traversal;
    // it is still not an atomic snapshot against arbitrary external writers.
    if directory_entries(dir, first_capacity, cancel).map_err(enumeration_error)? != listed
        || metadata_file(dir.file()).map_err(|_| error("unavailable"))? != before
    {
        return Err(error("materialChanged"));
    }
    dir.verify().map_err(|_| error("materialChanged"))?;
    cancelled(cancel)
}
pub(super) fn capture(root: &Path, cancel: &AtomicBool) -> Result<MaterialSummary> {
    let root = PinnedPath::directory(root).map_err(|_| error("unsafePath"))?;
    let mut scan = Scan {
        hash: Sha256::new(),
        entries: ListingBudget::new(MAX_ENTRIES),
        bytes: 0,
    };
    scan.field(b"farfold-windows-default-data-observation-v1");
    walk(&mut scan, &root, &[], 0, cancel)?;
    Ok(MaterialSummary {
        profile: Some(MaterialProfile::WindowsDefaultDataV1),
        entries: scan.entries.reserved,
        bytes: scan.bytes,
        sha256: hex(scan.hash.finalize()),
    })
}
