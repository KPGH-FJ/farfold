//! Actual same-handle facets. Ordinary query explicitly EXCLUDES SACL.
use super::super::super::{material_carrier_native as native, security};
use super::*;
use crate::file_access::{ea_records, full_security_records, security_records};
use sha2::{Digest, Sha256};
#[derive(Debug, PartialEq, Eq)]
pub(in super::super) enum Security {
    Ordinary(security_records::Observation),
    Full(full_security_records::Decoded),
}
impl Security {
    pub(in super::super) fn sha256(&self) -> [u8; 32] {
        match self {
            Self::Ordinary(v) => v.sha256,
            Self::Full(v) => v.sha256,
        }
    }
}
pub(in super::super) struct Snapshot {
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
    pub(in super::super) fn take(
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
                #[cfg(test)]
                let _ = writeln!(
                    std::io::stderr().lock(),
                    "FARFOLD_LINK_SNAPSHOT_CHANGED phase=dataGrowth total={total} before={before:?}"
                );
                return Err(Error::Changed);
            }
            hash.update(&buffer[..n]);
        }
        if total != before.size
            || stamp(file).map_err(|e| io_error("linkSnapshotAfter", e))
                .inspect(|actual| {
                    #[cfg(test)]
                    if actual != &before {
                        let _ = writeln!(std::io::stderr().lock(), "FARFOLD_LINK_SNAPSHOT_CHANGED phase=heldStamp before={before:?} after={actual:?}");
                    }
                })? != before
            || metadata_file(file).map_err(|_| Error::Invalid)
                .inspect(|actual| {
                    #[cfg(test)]
                    if actual != &version {
                        let _ = writeln!(std::io::stderr().lock(), "FARFOLD_LINK_SNAPSHOT_CHANGED phase=heldMetadata before={version:?} after={actual:?}");
                    }
                })? != version
        {
            #[cfg(test)]
            if total != before.size {
                let _ = writeln!(std::io::stderr().lock(), "FARFOLD_LINK_SNAPSHOT_CHANGED phase=dataLength total={total} before={before:?}");
            }
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
    fn same_content_facets(&self, other: &Self) -> bool {
        self.stamp.identity == other.stamp.identity
            && self.stamp.size == other.stamp.size
            && self.stamp.regular == other.stamp.regular
            && self.created == other.created
            && self.modified == other.modified
            && self.attributes == other.attributes
            && self.data_sha256 == other.data_sha256
            && self.ea == other.ea
            && self.security == other.security
    }
    pub(in super::super) fn same_link_payload(&self, other: &Self) -> bool {
        // Strict comparisons still require the allocation layout to match.
        // Link count and ChangeTime are checked by the separate exact fence.
        self.allocation == other.allocation && self.same_content_facets(other)
    }
    pub(in super::super) fn same_after_owned_link(&self, other: &Self) -> bool {
        // Only the successful, owned FileLinkInformation before/after boundary
        // admits allocation-layout changes. No content, identity or basic
        // metadata difference is waived; alias/existing-member fences stay exact.
        self.same_content_facets(other)
    }
    pub(in super::super) fn exact(&self, other: &Self) -> bool {
        self.version == other.version && self.stamp == other.stamp && self.same_link_payload(other)
    }
    // Existing snapshots only: no extra query/read, DATA/EA/SD bytes, raw name,
    // path or handle address. These helpers are test-only and never choose Error.
    #[cfg(test)]
    pub(in super::super) fn diagnostic_error(phase: &'static str, error: &Error) {
        let _ = writeln!(
            std::io::stderr().lock(),
            "FARFOLD_LINK_STAGE_ERROR phase={phase} error={error:?}"
        );
    }
    #[cfg(test)]
    pub(in super::super) fn diagnostic_pair(&self, other: &Self, phase: &'static str) {
        let _ = writeln!(
            std::io::stderr().lock(),
            concat!(
                "FARFOLD_LINK_SNAPSHOT_COMPARE phase={} payloadEqual={} versionEqual={} stampEqual={} ",
                "identityEqual={} sizeEqual={} regularEqual={} allocationEqual={} creationEqual={} writeEqual={} ",
                "attributesEqual={} dataEqual={} eaEqual={} securityEqual={} ",
                "beforeAllocation={} afterAllocation={} beforeCreated={} afterCreated={} ",
                "beforeModified={} afterModified={} beforeAttributes={} afterAttributes={} ",
                "beforeVolume={:016x} beforeFileId={:032x} afterVolume={:016x} afterFileId={:032x} ",
                "beforeStamp={:?} afterStamp={:?} beforeVersion={:?} afterVersion={:?}"
            ),
            phase,
            self.same_link_payload(other),
            self.version == other.version,
            self.stamp == other.stamp,
            self.stamp.identity == other.stamp.identity,
            self.stamp.size == other.stamp.size,
            self.stamp.regular == other.stamp.regular,
            self.allocation == other.allocation,
            self.created == other.created,
            self.modified == other.modified,
            self.attributes == other.attributes,
            self.data_sha256 == other.data_sha256,
            self.ea == other.ea,
            self.security == other.security,
            self.allocation,
            other.allocation,
            self.created,
            other.created,
            self.modified,
            other.modified,
            self.attributes,
            other.attributes,
            self.stamp.identity.device,
            self.stamp.identity.inode,
            other.stamp.identity.device,
            other.stamp.identity.inode,
            self.stamp,
            other.stamp,
            self.version,
            other.version
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owned_link_transition_accepts_only_allocation_and_strict_checks_stay_strict() {
        // Actual ordinary same-handle snapshots seed the comparison control.
        // Only the owned fixture is read; mutations below are RAM-only samples,
        // not a substitute for the four native FileLinkInformation regressions.
        let temp = tempfile::tempdir().expect("owned snapshot fixture");
        let path = temp.path().join("comparison.bin");
        std::fs::write(&path, [0x5a; 300]).expect("write owned snapshot fixture");
        let file = File::open(&path).expect("open owned snapshot fixture read-only");
        let resident = Resident::new(records::RESIDENT_LIMIT);
        let cancel = AtomicBool::new(false);
        let mut work = WorkBudget::new(records::WORK_LIMIT);
        let mut fresh = || {
            Snapshot::take(&file, false, &mut work, &cancel, &resident)
                .expect("actual ordinary snapshot")
        };
        let before = fresh();
        let same = fresh();
        assert!(before.same_after_owned_link(&same));
        assert!(before.same_link_payload(&same));
        assert!(before.exact(&same));
        drop(same);

        let mut allocation_only = fresh();
        allocation_only.allocation = allocation_only
            .allocation
            .checked_add(4096)
            .expect("bounded fixture allocation");
        assert!(before.same_after_owned_link(&allocation_only));
        assert!(allocation_only.same_after_owned_link(&before));
        assert!(!before.same_link_payload(&allocation_only));
        assert!(!before.exact(&allocation_only));
        drop(allocation_only);

        type FacetMutation = fn(&mut Snapshot);
        let changes: [(&str, FacetMutation); 10] = [
            ("volume", |value| value.stamp.identity.device ^= 1),
            ("full file identity", |value| {
                value.stamp.identity.inode ^= 1
            }),
            ("logical size", |value| value.stamp.size ^= 1),
            ("regular file kind", |value| value.stamp.regular = false),
            ("creation time", |value| value.created ^= 1),
            ("last write time", |value| value.modified ^= 1),
            ("attributes", |value| {
                value.attributes ^= FILE_ATTRIBUTE_HIDDEN
            }),
            ("DATA", |value| value.data_sha256[0] ^= 1),
            ("EA", |value| value.ea.sha256[0] ^= 1),
            ("ordinary security", |value| {
                let Security::Ordinary(security) = &mut value.security else {
                    panic!("ordinary snapshot must not claim SACL coverage");
                };
                security.sha256[0] ^= 1;
            }),
        ];
        for (name, change) in changes {
            let mut changed = fresh();
            change(&mut changed);
            assert!(!before.same_after_owned_link(&changed), "{name}");
            assert!(!before.same_link_payload(&changed), "{name}");
            assert!(!before.exact(&changed), "{name}");
            changed.allocation = changed
                .allocation
                .checked_add(4096)
                .expect("bounded fixture allocation");
            assert!(
                !before.same_after_owned_link(&changed),
                "{name} with allocation change"
            );
        }
    }
}
