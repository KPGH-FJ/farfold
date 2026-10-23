//! Same-FileObject facts; no path reopening, privilege adjustment or SD logging.
use super::*;
use crate::file_access::{
    ads_records::{Failure as AdsFailure, Inventory},
    ea_records::{self, WorkBudget},
    full_security_records,
    material_carrier_records::{
        BLOCK, CATALOG_RESIDENT, Error, Expected, Resident, ResidentLease, Result, check, io_error,
        record,
    },
};
use std::sync::atomic::AtomicBool;
use windows_sys::{
    Wdk::Storage::FileSystem::{FileStreamInformation, NtQueryEaFile, NtQueryInformationFile},
    Win32::{
        Globalization::{CSTR_GREATER_THAN, CSTR_LESS_THAN},
        Security::{
            BACKUP_SECURITY_INFORMATION, GetKernelObjectSecurity, GetSecurityDescriptorLength,
            IsValidSecurityDescriptor,
        },
    },
};
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Basic {
    pub created: i64,
    pub accessed: i64,
    pub modified: i64,
    pub attributes: u32,
}
#[derive(Debug)]
pub(super) struct Facts {
    pub version: EntryMetadata,
    pub stamp: Stamp,
    pub basic: Basic,
    pub expected: Expected,
    pub inventory: Inventory,
    pub ea: ea_records::Observation,
    pub security: full_security_records::Decoded,
    _memory: ResidentLease,
}
impl Facts {
    pub fn unchanged(&self, other: &Self) -> bool {
        // Access time is recorded before reading, not a stable source fence.
        // Allocation/change/full128/link/etc still use complete actual metadata.
        self.version == other.version
            && self.stamp == other.stamp
            && self.inventory == other.inventory
            && self.ea == other.ea
            && self.security == other.security
    }
}
fn compare(a: &[u16], b: &[u16]) -> std::result::Result<std::cmp::Ordering, AdsFailure> {
    if a.is_empty() || b.is_empty() {
        return Ok(a.len().cmp(&b.len()));
    }
    match unsafe { CompareStringOrdinal(a.as_ptr(), a.len() as i32, b.as_ptr(), b.len() as i32, 1) }
    {
        CSTR_LESS_THAN => Ok(std::cmp::Ordering::Less),
        CSTR_EQUAL => Ok(std::cmp::Ordering::Equal),
        CSTR_GREATER_THAN => Ok(std::cmp::Ordering::Greater),
        _ => Err(AdsFailure::Compare),
    }
}
pub(super) fn facts(
    file: &File,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    resident: &Resident,
) -> Result<Facts> {
    let memory = resident.lease(CATALOG_RESIDENT)?;
    let _scratch = resident.lease(2 * BLOCK)?;
    check(cancel)?;
    let before = stamp(file).map_err(|e| io_error("factsStamp", e))?;
    let version = metadata_file(file).map_err(|_| Error::Invalid)?;
    let basic: FILE_BASIC_INFO = info(file, FileBasicInfo).map_err(|e| io_error("basic", e))?;
    // This first slice is a single ordinary regular node, not a tree/special-file
    // preservation claim. Every non-whitelisted attribute is a refusal.
    const ORDINARY: u32 = FILE_ATTRIBUTE_READONLY
        | FILE_ATTRIBUTE_HIDDEN
        | FILE_ATTRIBUTE_SYSTEM
        | FILE_ATTRIBUTE_ARCHIVE
        | FILE_ATTRIBUTE_NORMAL
        | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED;
    if version.kind != MetadataKind::File
        || !before.regular
        || before.links != 1
        || basic.FileAttributes & !ORDINARY != 0
        || basic.CreationTime <= 0
        || basic.LastAccessTime <= 0
        || basic.LastWriteTime <= 0
    {
        return Err(Error::Unsupported);
    }
    let inventory = inventory(file, work, cancel)?;
    if inventory.default_size() != Some(before.size) {
        return Err(Error::Changed);
    }
    let expected = inventory.carrier_data();
    let ea = ea(file, work, cancel)?;
    let security = security(file, work, cancel)?;
    check(cancel)?;
    if stamp(file).map_err(|e| io_error("factsAfter", e))? != before
        || metadata_file(file).map_err(|_| Error::Invalid)? != version
    {
        return Err(Error::Changed);
    }
    Ok(Facts {
        _memory: memory,
        version,
        stamp: before,
        basic: Basic {
            created: basic.CreationTime,
            accessed: basic.LastAccessTime,
            modified: basic.LastWriteTime,
            attributes: basic.FileAttributes,
        },
        expected,
        inventory,
        ea,
        security,
    })
}
pub(super) fn inventory(
    file: &File,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<Inventory> {
    check(cancel)?;
    let capacity = Inventory::query_capacity(work).map_err(record)?;
    let mut bytes = vec![0u64; BLOCK / 8];
    let mut ios = IO_STATUS_BLOCK::default();
    let status = unsafe {
        NtQueryInformationFile(
            handle(file),
            &mut ios,
            bytes.as_mut_ptr().cast(),
            capacity as u32,
            FileStreamInformation,
        )
    };
    let raw = unsafe { std::slice::from_raw_parts(bytes.as_ptr().cast::<u8>(), capacity) };
    Inventory::decode(status, ios.Information, raw, work, cancel, compare).map_err(|e| match e {
        AdsFailure::Cancelled => Error::Cancelled,
        AdsFailure::Limit => Error::Limit,
        AdsFailure::Status(status) => Error::NtStatus {
            phase: "streamInventory",
            status,
        },
        AdsFailure::Io { phase, code } => Error::Io { phase, code },
        AdsFailure::Changed => Error::Changed,
        _ => Error::Unsupported,
    })
}
pub(super) fn ea(
    file: &File,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<ea_records::Observation> {
    check(cancel)?;
    let capacity = work.capacity().map_err(record)?;
    let mut bytes = vec![0u64; BLOCK / 8];
    let mut ios = IO_STATUS_BLOCK::default();
    let status = unsafe {
        NtQueryEaFile(
            handle(file),
            &mut ios,
            bytes.as_mut_ptr().cast(),
            capacity as u32,
            false,
            ptr::null(),
            0,
            ptr::null(),
            true,
        )
    };
    let raw = unsafe { std::slice::from_raw_parts(bytes.as_ptr().cast::<u8>(), capacity) };
    ea_records::complete(status, ios.Information, raw, work, cancel).map_err(record)
}
pub(super) fn security(
    file: &File,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<full_security_records::Decoded> {
    check(cancel)?;
    let capacity = work.capacity().map_err(record)?;
    let mut bytes = vec![0u64; BLOCK / 8];
    let mut returned = 0;
    if unsafe {
        GetKernelObjectSecurity(
            handle(file),
            BACKUP_SECURITY_INFORMATION,
            bytes.as_mut_ptr().cast(),
            capacity as u32,
            &mut returned,
        )
    } == 0
    {
        return Err(io_error("fullSecurityQuery", io::Error::last_os_error()));
    }
    if returned < 20 || returned as usize > capacity {
        return Err(Error::Invalid);
    }
    let raw = unsafe { std::slice::from_raw_parts(bytes.as_ptr().cast::<u8>(), returned as usize) };
    let decoded = full_security_records::complete(raw, work, cancel).map_err(record)?;
    if unsafe { IsValidSecurityDescriptor(bytes.as_mut_ptr().cast()) } == 0
        || unsafe { GetSecurityDescriptorLength(bytes.as_mut_ptr().cast()) } != returned
    {
        return Err(Error::Invalid);
    }
    // All owner/group/SACL/DACL and opaque admitted ACE bytes are part of this
    // digest. Access-denied/privilege errors remain failures, never partial SD.
    Ok(decoded)
}

// Only a SAME-handle Directory kind caller may request this inventory.
pub(super) fn directory_inventory(
    file: &File,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<Inventory> {
    check(cancel)?;
    let capacity = Inventory::query_capacity(work).map_err(record)?;
    let mut bytes = vec![0u64; BLOCK / 8];
    let mut ios = IO_STATUS_BLOCK::default();
    let status = unsafe {
        NtQueryInformationFile(
            handle(file),
            &mut ios,
            bytes.as_mut_ptr().cast(),
            capacity as u32,
            FileStreamInformation,
        )
    };
    let raw = unsafe { std::slice::from_raw_parts(bytes.as_ptr().cast::<u8>(), capacity) };
    let result = if status == 0 && ios.Information == 0 {
        Inventory::empty_directory(status, ios.Information, raw, work, cancel)
    } else {
        Inventory::decode(status, ios.Information, raw, work, cancel, compare)
            .and_then(Inventory::for_directory)
    };
    result.map_err(|e| match e {
        AdsFailure::Cancelled => Error::Cancelled,
        AdsFailure::Limit => Error::Limit,
        AdsFailure::Status(status) => Error::NtStatus {
            phase: "streamInventory",
            status,
        },
        AdsFailure::Io { phase, code } => Error::Io { phase, code },
        AdsFailure::Changed => Error::Changed,
        _ => Error::Unsupported,
    })
}
