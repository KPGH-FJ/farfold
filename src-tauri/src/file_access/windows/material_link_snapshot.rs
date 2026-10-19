//! Actual same-handle facets. Ordinary query explicitly EXCLUDES SACL.
use super::super::super::{material_carrier_native as native, security};
use super::*;
use crate::file_access::{ea_records, full_security_records, security_records};
use sha2::{Digest, Sha256};
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Security {
    Ordinary(security_records::Observation),
    Full(full_security_records::Decoded),
}
impl Security {
    pub(super) fn sha256(&self) -> [u8; 32] {
        match self {
            Self::Ordinary(v) => v.sha256,
            Self::Full(v) => v.sha256,
        }
    }
}
pub(super) struct Snapshot {
    pub stamp: Stamp,
    version: EntryMetadata,
    allocation: i64,
    created: i64,
    modified: i64,
    attributes: u32,
    pub data_sha256: [u8; 32],
    pub ea: ea_records::Observation,
    pub security: Security,
    _memory: ResidentLease,
}
impl Snapshot {
    pub(super) fn take(
        file: &File,
        full: bool,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
        resident: &Resident,
    ) -> Result<Self> {
        let memory = resident.lease(records::CATALOG_RESIDENT + 3 * records::BLOCK)?;
        check(cancel)?;
        let before = stamp(file).map_err(|e| io_error("linkSnapshotBefore", e))?;
        let version = metadata_file(file).map_err(|_| Error::Invalid)?;
        let basic: FILE_BASIC_INFO =
            info(file, FileBasicInfo).map_err(|e| io_error("linkBasic", e))?;
        let standard: FILE_STANDARD_INFO =
            info(file, FileStandardInfo).map_err(|e| io_error("linkStandard", e))?;
        const ALLOWED: u32 = FILE_ATTRIBUTE_READONLY
            | FILE_ATTRIBUTE_HIDDEN
            | FILE_ATTRIBUTE_SYSTEM
            | FILE_ATTRIBUTE_ARCHIVE
            | FILE_ATTRIBUTE_NORMAL
            | FILE_ATTRIBUTE_NOT_CONTENT_INDEXED;
        if !before.regular
            || before.identity.inode == 0
            || version.kind != MetadataKind::File
            || standard.Directory
            || standard.DeletePending
            || standard.NumberOfLinks as u64 != before.links
            || standard.EndOfFile < 0
            || standard.AllocationSize < 0
            || standard.EndOfFile as u64 != before.size
            || basic.FileAttributes & !ALLOWED != 0
        {
            return Err(Error::Unsupported);
        }
        let ea = native::ea(file, work, cancel)?;
        let security = if full {
            Security::Full(native::security(file, work, cancel)?)
        } else {
            Security::Ordinary(security::query(file, work, cancel).map_err(records::record)?)
        };
        let mut input = file;
        input
            .seek(SeekFrom::Start(0))
            .map_err(|e| io_error("linkDataSeek", e))?;
        let mut buffer = vec![0u8; records::BLOCK];
        let mut hash = Sha256::new();
        let mut total = 0u64;
        loop {
            check(cancel)?;
            let offer = (work.remaining().min(records::BLOCK as u64)) as usize;
            if offer == 0 {
                return Err(Error::Limit);
            }
            let n = input
                .read(&mut buffer[..offer])
                .map_err(|e| io_error("linkDataRead", e))?;
            charge(work, n)?;
            if n == 0 {
                break;
            }
            total = total.checked_add(n as u64).ok_or(Error::Limit)?;
            if total > before.size {
                return Err(Error::Changed);
            }
            hash.update(&buffer[..n]);
        }
        if total != before.size
            || stamp(file).map_err(|e| io_error("linkSnapshotAfter", e))? != before
            || metadata_file(file).map_err(|_| Error::Invalid)? != version
        {
            return Err(Error::Changed);
        }
        Ok(Self {
            stamp: before,
            version,
            allocation: standard.AllocationSize,
            created: basic.CreationTime,
            modified: basic.LastWriteTime,
            attributes: basic.FileAttributes,
            data_sha256: hash.finalize().into(),
            ea,
            security,
            _memory: memory,
        })
    }
    pub(super) fn same_link_payload(&self, other: &Self) -> bool {
        // Link count and ChangeTime legitimately change. No data/EA/security,
        // full identity, allocation, size, Creation/Write time or attr is waived.
        self.stamp.identity == other.stamp.identity
            && self.stamp.size == other.stamp.size
            && self.stamp.regular == other.stamp.regular
            && self.allocation == other.allocation
            && self.created == other.created
            && self.modified == other.modified
            && self.attributes == other.attributes
            && self.data_sha256 == other.data_sha256
            && self.ea == other.ea
            && self.security == other.security
    }
    pub(super) fn exact(&self, other: &Self) -> bool {
        self.version == other.version && self.stamp == other.stamp && self.same_link_payload(other)
    }
}
