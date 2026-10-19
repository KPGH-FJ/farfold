//! Same FileObject directory metadata. No recursive child/material claim.
use super::material_carrier_native::{self as native, Basic};
use super::*;
use crate::file_access::{
    ads_records::Inventory,
    ea_records::{self, WorkBudget},
    full_security_records,
    material_carrier_records::{
        BLOCK, CATALOG_RESIDENT, Error, Expected, Resident, ResidentLease, Result, check, io_error,
    },
};
use std::sync::atomic::AtomicBool;
pub(super) struct Facts {
    pub version: EntryMetadata,
    pub stamp: Stamp,
    pub basic: Basic,
    pub expected: Expected,
    pub inventory: Inventory,
    pub ea: ea_records::Observation,
    pub security: Option<full_security_records::Decoded>,
    _memory: ResidentLease,
}
impl Facts {
    pub fn unchanged(&self, b: &Self) -> bool {
        self.version == b.version
            && self.stamp == b.stamp
            && self.inventory == b.inventory
            && self.ea == b.ea
            && self.security == b.security
    }
}
pub(super) fn take(
    file: &File,
    full: bool,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    resident: &Resident,
) -> Result<Facts> {
    let memory = resident.lease(CATALOG_RESIDENT)?;
    let _scratch = resident.lease(2 * BLOCK)?;
    check(cancel)?;
    let before = stamp(file).map_err(|e| io_error("directoryStamp", e))?;
    let version = metadata_file(file).map_err(|_| Error::Invalid)?;
    let basic: FILE_BASIC_INFO =
        info(file, FileBasicInfo).map_err(|e| io_error("directoryBasic", e))?;
    const ALLOWED: u32 = FILE_ATTRIBUTE_DIRECTORY
        | FILE_ATTRIBUTE_READONLY
        | FILE_ATTRIBUTE_HIDDEN
        | FILE_ATTRIBUTE_SYSTEM
        | FILE_ATTRIBUTE_ARCHIVE
        | FILE_ATTRIBUTE_NORMAL
        | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED;
    if before.regular
        || before.identity.inode == 0
        || before.links != 1
        || version.kind != MetadataKind::Directory
        || basic.FileAttributes & !ALLOWED != 0
        || basic.FileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        || basic.CreationTime <= 0
        || basic.LastAccessTime <= 0
        || basic.LastWriteTime <= 0
    {
        return Err(Error::Unsupported);
    }
    let inventory = native::directory_inventory(file, work, cancel)?;
    if inventory.has_default() {
        return Err(Error::Unsupported);
    }
    let expected = inventory.carrier_data();
    let ea = native::ea(file, work, cancel)?;
    let security = if full {
        Some(native::security(file, work, cancel)?)
    } else {
        None
    };
    check(cancel)?;
    if stamp(file).map_err(|e| io_error("directoryAfter", e))? != before
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
