//! Raw material descendants of one existing selected root. No DOS reopen.
//! Test-registered until a real whole-tree carrier consumer is closed.
use super::*;
use crate::file_access::{
    material_carrier_records::{Resident, ResidentLease},
    material_raw_name,
};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    sync::{Arc, Mutex, MutexGuard, TryLockError},
};
use windows_sys::Win32::Globalization::{CSTR_GREATER_THAN, CSTR_LESS_THAN};
use windows_sys::Win32::System::{
    SystemServices::ACCESS_SYSTEM_SECURITY,
    WindowsProgramming::{DRIVE_CDROM, DRIVE_FIXED, DRIVE_RAMDISK, DRIVE_REMOVABLE},
};
const MAX_UNITS: usize = 32768;
const NODE_MEMORY: usize = 2048;
#[derive(Debug)]
pub(super) enum Failure {
    Name(material_raw_name::Failure),
    Cancelled,
    Limit,
    Changed,
    Unsupported,
    Io {
        phase: &'static str,
        kind: io::ErrorKind,
        code: Option<i32>,
        nt_status: Option<i32>,
    },
    Metadata(MetadataFailure),
}
fn failure(phase: &'static str, error: io::Error) -> Failure {
    Failure::Io {
        phase,
        kind: error.kind(),
        code: error.raw_os_error(),
        nt_status: None,
    }
}
fn cancelled(cancel: &AtomicBool) -> Result<(), Failure> {
    if cancel.load(Ordering::SeqCst) {
        Err(Failure::Cancelled)
    } else {
        Ok(())
    }
}
fn invalid() -> io::Error {
    io::Error::from(io::ErrorKind::InvalidData)
}
pub(super) fn into_io(value: Failure) -> io::Error {
    match value {
        Failure::Io { kind, code, .. } => {
            code.map_or_else(|| kind.into(), io::Error::from_raw_os_error)
        }
        Failure::Limit => io::Error::from(io::ErrorKind::OutOfMemory),
        Failure::Cancelled => io::Error::from(io::ErrorKind::Interrupted),
        Failure::Metadata(original) => io::Error::other(format!("{original:?}")),
        _ => invalid(),
    }
}
pub(super) struct Guid {
    units: Vec<u16>,
    volume: [u8; 36],
    _memory: ResidentLease,
}
pub(super) fn guid(file: &File, resident: &Resident) -> Result<Guid, Failure> {
    let flags = FILE_NAME_NORMALIZED | VOLUME_NAME_GUID;
    let count = unsafe { GetFinalPathNameByHandleW(handle(file), ptr::null_mut(), 0, flags) };
    if count == 0 {
        return Err(failure("guidSize", io::Error::last_os_error()));
    }
    if (count as usize) > MAX_UNITS {
        return Err(Failure::Limit);
    }
    // Size query includes the terminator. No retry if the spelling grows.
    let memory = resident
        .lease(count as usize * 2)
        .map_err(|_| Failure::Limit)?;
    let mut units = vec![0u16; count as usize];
    let length =
        unsafe { GetFinalPathNameByHandleW(handle(file), units.as_mut_ptr(), count, flags) };
    if length == 0 {
        return Err(failure("guidRead", io::Error::last_os_error()));
    }
    if length >= count {
        return Err(Failure::Changed);
    }
    units.truncate(length as usize);
    const PREFIX: [u16; 11] = [92, 92, 63, 92, 86, 111, 108, 117, 109, 101, 123];
    if units.len() < 49 || !units.starts_with(&PREFIX) || units[47] != 125 || units[48] != 92 {
        return Err(Failure::Unsupported);
    }
    let mut volume = [0u8; 36];
    for (at, value) in units[11..47].iter().enumerate() {
        if *value > 127 {
            return Err(Failure::Unsupported);
        }
        let value = *value as u8;
        if if [8, 13, 18, 23].contains(&at) {
            value != b'-'
        } else {
            !value.is_ascii_hexdigit()
        } {
            return Err(Failure::Unsupported);
        }
        volume[at] = value.to_ascii_lowercase();
    }
    let mut root = [0u16; 50];
    root[..49].copy_from_slice(&units[..49]);
    if !matches!(
        unsafe { GetDriveTypeW(root.as_ptr()) },
        DRIVE_FIXED | DRIVE_REMOVABLE | DRIVE_CDROM | DRIVE_RAMDISK
    ) {
        return Err(Failure::Unsupported);
    }
    Ok(Guid {
        units,
        volume,
        _memory: memory,
    })
}
impl Guid {
    // Material-only actual-handle spelling. This is not path/open authority.
    pub(super) fn same_path(&self, other: &Self) -> bool {
        self.volume == other.volume && self.units == other.units
    }
    pub(super) fn child_of(&self, parent: &Self, leaf: &[u16]) -> bool {
        if material_raw_name::check(leaf).is_err() || self.volume != parent.volume {
            return false;
        }
        // No joined Vec/String/lossy conversion: compare the exact counted edge
        // to the actual held parent's raw GUID spelling, including all units.
        let separator = (parent.units.last() != Some(&92)).then_some(92);
        self.units.iter().copied().eq(parent
            .units
            .iter()
            .copied()
            .chain(separator)
            .chain(leaf.iter().copied()))
    }
}
fn ordinary(meta: &EntryMetadata) -> bool {
    // Both metadata-only and actual data-handle checks precede any body read.
    // No compressed/sparse/reparse/EFS/offline/recall/unknown profile is implied.
    matches!(meta.kind, MetadataKind::File | MetadataKind::Directory)
        && meta.attributes() & !allowed_attributes() == 0
}
fn opened(
    parent: &File,
    raw: &[u16],
    metadata_only: bool,
    directory: bool,
    full: bool,
) -> Result<File, Failure> {
    let mut encoded = raw.to_vec();
    let unicode = UNICODE_STRING {
        Length: (encoded.len() * 2) as u16,
        MaximumLength: (encoded.len() * 2) as u16,
        Buffer: encoded.as_mut_ptr(),
    };
    let object = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: handle(parent),
        ObjectName: &unicode,
        Attributes: OBJ_CASE_INSENSITIVE,
        ..Default::default()
    };
    let mut ios = IO_STATUS_BLOCK::default();
    let mut result = ptr::null_mut();
    let access = if metadata_only {
        FILE_READ_ATTRIBUTES | SYNCHRONIZE
    } else {
        FILE_GENERIC_READ | if full { ACCESS_SYSTEM_SECURITY } else { 0 }
    };
    let share = if metadata_only {
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
    } else {
        FILE_SHARE_READ | if directory { FILE_SHARE_WRITE } else { 0 }
    };
    let options = FILE_OPEN_REPARSE_POINT
        | FILE_SYNCHRONOUS_IO_NONALERT
        | if metadata_only {
            0
        } else if directory {
            FILE_DIRECTORY_FILE
        } else {
            FILE_NON_DIRECTORY_FILE
        };
    let status = unsafe {
        NtCreateFile(
            &mut result,
            access,
            &object,
            &mut ios,
            ptr::null(),
            FILE_ATTRIBUTE_NORMAL,
            share,
            FILE_OPEN,
            options,
            ptr::null(),
            0,
        )
    };
    if status < 0 {
        let code = unsafe { RtlNtStatusToDosError(status) } as i32;
        return Err(Failure::Io {
            phase: if metadata_only {
                "rawMetadataOpen"
            } else {
                "rawDataOpen"
            },
            kind: io::Error::from_raw_os_error(code).kind(),
            code: Some(code),
            nt_status: Some(status),
        });
    }
    if result.is_null() || result == INVALID_HANDLE_VALUE {
        return Err(Failure::Unsupported);
    }
    // A nonnegative result transferred one handle. Unexpected nonzero success
    // is refused with this exact File owner; never reinterpret it as missing.
    let file = unsafe { File::from_raw_handle(result) };
    if status != 0 {
        return Err(Failure::Unsupported);
    }
    Ok(file)
}
fn long_leaf(value: &Guid, raw: &[u16]) -> Result<(), Failure> {
    let actual = value
        .units
        .rsplit(|u| matches!(*u, 47 | 92))
        .next()
        .ok_or(Failure::Changed)?;
    match unsafe {
        CompareStringOrdinal(
            actual.as_ptr(),
            actual.len() as i32,
            raw.as_ptr(),
            raw.len() as i32,
            1,
        )
    } {
        CSTR_EQUAL => Ok(()),
        0 => Err(failure("rawLongName", io::Error::last_os_error())),
        _ => Err(Failure::Changed),
    }
}
// Material-only case-insensitive uniqueness. Fallible merge ordering avoids
// a panicking/inconsistent comparator and quadratic insertion/alias searches.
fn unique_names(
    values: &crate::file_access::DirectoryEntries,
    resident: &Resident,
    cancel: &AtomicBool,
) -> Result<(), crate::file_access::DirectoryFailure> {
    use crate::file_access::DirectoryFailure as D;
    if values.len() > crate::file_access::directory_page::MAX_ENTRIES {
        return Err(D::Limit);
    }
    for raw in values.keys() {
        crate::file_access::directory_page::cancelled(cancel)?;
        material_raw_name::check(raw).map_err(|_| D::Unsupported)?;
    }
    let count = values.len();
    if count < 2 {
        return Ok(());
    }
    let bytes = count.checked_mul(3 * size_of::<usize>()).ok_or(D::Limit)?;
    let _memory = resident.lease(bytes).map_err(|_| D::Limit)?;
    let names: Vec<_> = values.keys().collect();
    let mut order: Vec<usize> = (0..count).collect();
    let mut scratch = vec![0usize; count];
    let mut width = 1usize;
    while width < count {
        let mut base = 0;
        while base < count {
            let middle = (base + width).min(count);
            let end = (middle + width).min(count);
            let (mut a, mut b, mut out) = (base, middle, base);
            while a < middle && b < end {
                crate::file_access::directory_page::cancelled(cancel)?;
                let left = names[order[a]];
                let right = names[order[b]];
                let take_left = match unsafe {
                    CompareStringOrdinal(
                        left.as_ptr(),
                        left.len() as i32,
                        right.as_ptr(),
                        right.len() as i32,
                        1,
                    )
                } {
                    CSTR_LESS_THAN => true,
                    CSTR_GREATER_THAN => false,
                    CSTR_EQUAL => return Err(D::Changed),
                    _ => {
                        return Err(D::Io {
                            phase: "rawNameOrder",
                            code: io::Error::last_os_error().raw_os_error(),
                            nt_status: None,
                        });
                    }
                };
                scratch[out] = if take_left {
                    let v = order[a];
                    a += 1;
                    v
                } else {
                    let v = order[b];
                    b += 1;
                    v
                };
                out += 1;
            }
            while a < middle {
                if out.is_multiple_of(256) {
                    crate::file_access::directory_page::cancelled(cancel)?;
                }
                scratch[out] = order[a];
                a += 1;
                out += 1;
            }
            while b < end {
                if out.is_multiple_of(256) {
                    crate::file_access::directory_page::cancelled(cancel)?;
                }
                scratch[out] = order[b];
                b += 1;
                out += 1;
            }
            base = end;
        }
        std::mem::swap(&mut order, &mut scratch);
        width = width.checked_mul(2).ok_or(D::Limit)?;
    }
    crate::file_access::directory_page::cancelled(cancel)?;
    Ok(())
}
enum Resource {
    Root(PinnedPath),
    Child {
        parent: MaterialPin,
        file: File,
        scan: Mutex<()>,
    },
}
struct Node {
    resource: Resource,
    identity: Identity,
    guid: Guid,
    opening: EntryMetadata,
    full_security: bool,
    depth: usize,
    resident: Resident,
    _memory: ResidentLease,
}
// Cloning shares this exact FileObject AND its query owner. No File::try_clone,
// independent cursor, arbitrary File constructor or global identity map exists.
#[derive(Clone)]
pub(super) struct MaterialPin {
    inner: Arc<Node>,
}
impl MaterialPin {
    pub(super) fn root(
        pin: PinnedPath,
        resident: &Resident,
        cancel: &AtomicBool,
    ) -> Result<Self, Failure> {
        cancelled(cancel)?;
        let memory = resident.lease(NODE_MEMORY).map_err(|_| Failure::Limit)?;
        pin.verify().map_err(|e| failure("rawRootVerify", e))?;
        let opening = metadata_file(pin.file()).map_err(Failure::Metadata)?;
        if opening.kind != MetadataKind::Directory || !ordinary(&opening) {
            return Err(Failure::Unsupported);
        }
        let identity = stamp(pin.file())
            .map_err(|e| failure("rawRootStamp", e))?
            .identity;
        let guid = guid(pin.file(), resident)?;
        pin.verify().map_err(|e| failure("rawRootAfter", e))?;
        cancelled(cancel)?;
        let full_security = pin.full_security_purpose();
        Ok(Self {
            inner: Arc::new(Node {
                resource: Resource::Root(pin),
                identity,
                guid,
                opening,
                full_security,
                depth: 0,
                resident: resident.clone(),
                _memory: memory,
            }),
        })
    }
    pub(super) fn child(
        &self,
        raw: &[u16],
        listed: &crate::file_access::DirectoryObservation,
        cancel: &AtomicBool,
    ) -> Result<Self, Failure> {
        material_raw_name::check(raw).map_err(Failure::Name)?;
        cancelled(cancel)?;
        self.verify().map_err(|e| failure("rawParentVerify", e))?;
        if self.inner.opening.kind != MetadataKind::Directory {
            return Err(Failure::Unsupported);
        }
        let directory = listed.attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
        if listed.reparse_tag.is_some() || listed.attributes & !allowed_attributes() != 0 {
            return Err(Failure::Unsupported);
        }
        let depth = self.inner.depth.checked_add(1).ok_or(Failure::Limit)?;
        if depth > (if directory { 64 } else { 65 }) {
            return Err(Failure::Limit);
        }
        // This reservation covers fixed node/Arc/name/metadata storage before
        // copying the bounded raw leaf into the native counted-name buffer.
        let memory = self
            .inner
            .resident
            .lease(NODE_MEMORY)
            .map_err(|_| Failure::Limit)?;
        let probe = opened(self.file(), raw, true, directory, false)?;
        let before = metadata_file(&probe).map_err(Failure::Metadata)?;
        if !ordinary(&before) {
            return Err(Failure::Unsupported);
        }
        if !before.matches_directory_identity(listed)
            || (before.kind == MetadataKind::Directory) != directory
        {
            return Err(Failure::Changed);
        }
        cancelled(cancel)?;
        let file = opened(self.file(), raw, false, directory, self.inner.full_security)?;
        let opening = metadata_file(&file).map_err(Failure::Metadata)?;
        let actual = stamp(&file).map_err(|e| failure("rawChildStamp", e))?;
        if opening != before
            || !ordinary(&opening)
            || actual.identity != listed.identity
            || actual.identity.device != self.inner.identity.device
            || actual.regular == directory
        {
            return Err(Failure::Changed);
        }
        let guid = guid(&file, &self.inner.resident)?;
        if guid.volume != self.inner.guid.volume {
            return Err(Failure::Changed);
        }
        long_leaf(&guid, raw)?;
        if metadata_file(&probe).map_err(Failure::Metadata)? != before
            || metadata_file(&file).map_err(Failure::Metadata)? != opening
        {
            return Err(Failure::Changed);
        }
        self.verify().map_err(|e| failure("rawParentAfter", e))?;
        cancelled(cancel)?;
        Ok(Self {
            inner: Arc::new(Node {
                resource: Resource::Child {
                    parent: self.clone(),
                    file,
                    scan: Mutex::new(()),
                },
                identity: actual.identity,
                guid,
                opening,
                full_security: self.inner.full_security,
                depth,
                resident: self.inner.resident.clone(),
                _memory: memory,
            }),
        })
    }
    fn file(&self) -> &File {
        match &self.inner.resource {
            Resource::Root(pin) => pin.file(),
            Resource::Child { file, .. } => file,
        }
    }
    // Bind a directory-facet label to this SAME held object's final raw leaf.
    // This grants no path/open authority and never String-normalizes the name.
    pub(super) fn directory_carrier_leaf(&self, raw: &[u16]) -> Result<(), Failure> {
        material_raw_name::check(raw).map_err(Failure::Name)?;
        if self.inner.opening.kind != MetadataKind::Directory {
            return Err(Failure::Unsupported);
        }
        let actual = self
            .inner
            .guid
            .units
            .rsplit(|u| matches!(*u, 47 | 92))
            .next()
            .ok_or(Failure::Changed)?;
        if actual != raw {
            return Err(Failure::Changed);
        }
        Ok(())
    }
    pub(super) fn identity(&self) -> &Identity {
        &self.inner.identity
    }
    pub(super) fn opening_metadata(&self) -> &EntryMetadata {
        &self.inner.opening
    }
    pub(super) fn full_security_purpose(&self) -> bool {
        self.inner.full_security
    }
    pub(super) fn verify(&self) -> io::Result<()> {
        match &self.inner.resource {
            Resource::Root(pin) => pin.verify()?,
            Resource::Child { parent, .. } => parent.verify()?,
        }
        if stamp(self.file())?.identity != self.inner.identity {
            return Err(invalid());
        }
        let current = guid(self.file(), &self.inner.resident).map_err(into_io)?;
        if current.units != self.inner.guid.units || current.volume != self.inner.guid.volume {
            return Err(invalid());
        }
        Ok(())
    }
    fn directory_scan(&self) -> io::Result<MutexGuard<'_, ()>> {
        match &self.inner.resource {
            Resource::Root(pin) => pin.directory_scan(),
            Resource::Child { scan, .. } => scan
                .lock()
                .map_err(|_| io::Error::other("material scan owner poisoned")),
        }
    }
    pub(super) fn try_observation_owner(
        &self,
    ) -> Result<MutexGuard<'_, ()>, TryLockError<MutexGuard<'_, ()>>> {
        match &self.inner.resource {
            Resource::Root(pin) => pin.try_observation_owner(),
            Resource::Child { scan, .. } => scan.try_lock(),
        }
    }
    pub(super) fn entries(
        &self,
        remaining: u64,
        cancel: &AtomicBool,
    ) -> Result<
        crate::file_access::material_directory_budget::MaterialEntries,
        crate::file_access::DirectoryFailure,
    > {
        let values =
            super::directory::collect_budgeted_from(self, remaining, cancel, &self.inner.resident)?;
        unique_names(values.as_entries(), &self.inner.resident, cancel)?;
        Ok(values)
    }
}
fn allowed_attributes() -> u32 {
    FILE_ATTRIBUTE_READONLY
        | FILE_ATTRIBUTE_HIDDEN
        | FILE_ATTRIBUTE_SYSTEM
        | FILE_ATTRIBUTE_ARCHIVE
        | FILE_ATTRIBUTE_NORMAL
        | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED
        | FILE_ATTRIBUTE_DIRECTORY
}
impl super::directory::Owner for MaterialPin {
    fn file(&self) -> &File {
        MaterialPin::file(self)
    }
    fn verify(&self) -> io::Result<()> {
        MaterialPin::verify(self)
    }
    fn directory_scan(&self) -> io::Result<MutexGuard<'_, ()>> {
        MaterialPin::directory_scan(self)
    }
}
#[cfg(test)]
#[path = "material_pin_tests.rs"]
mod tests;
