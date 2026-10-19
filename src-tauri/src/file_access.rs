//! OS-owned file handles for delivery and restricted local-page resources.
//! Callers choose the authorized root; this layer refuses redirected components.
use std::{fs::File, io};
#[cfg(any(windows, test))]
mod ads_records;
#[cfg(any(windows, test))]
mod directory_page;
#[cfg(any(windows, test))]
mod ea_records;
#[cfg(any(windows, test))]
mod full_security_records;
#[cfg(any(windows, test))]
mod integrity_records;
#[cfg(any(windows, test))]
mod security_records;
#[cfg(all(windows, test))]
pub(crate) mod security_test_fixture;
#[cfg(windows)]
pub(crate) use ads_records::{Failure as StreamsFailure, Observation as StreamsObservation};
#[cfg(windows)]
pub(crate) use ea_records::{
    Failure as EaFailure, Observation as EaObservation, WorkBudget as EaWorkBudget,
};
#[cfg(windows)]
pub(crate) use integrity_records::Observation as IntegrityObservation;
#[cfg(windows)]
pub(crate) use security_records::Observation as SecurityObservation;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub(crate) use directory_page::{
    Entries as DirectoryEntries, Failure as DirectoryFailure, Observation as DirectoryObservation,
};
#[cfg(unix)]
pub(crate) use unix::{TemporaryExport, absolute, open_directory, open_relative, stamp};
#[cfg(windows)]
pub(crate) use windows::{
    EntryMetadata, FullSecurityFailure, FullSecurityObservation, MetadataFailure, MetadataKind,
    PinnedPath, RetiredBackup, directory_entries, ea_observation, full_security_observation,
    integrity_observation, metadata_child, metadata_file, security_observation,
    streams_observation,
};
#[cfg(windows)]
pub(crate) use windows::{TemporaryExport, absolute, open_directory, open_relative, stamp};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Identity {
    pub device: u64,
    pub inode: u128,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Stamp {
    pub identity: Identity,
    pub size: u64,
    pub modified: (i64, i64),
    pub changed: (i64, i64),
    pub links: u64,
    pub regular: bool,
}
pub(crate) fn same_object(left: &File, right: &File) -> io::Result<bool> {
    Ok(stamp(left)?.identity == stamp(right)?.identity)
}

#[cfg(test)]
mod material_backup_io;
#[cfg(test)]
mod material_carrier_records;
#[cfg(all(windows, test))]
pub(crate) use material_carrier_records::Error as CarrierFailure;
#[cfg(all(windows, test))]
pub(crate) use windows::{CarrierReceipt, CarrierRequest, CarrierRetirement, carrier_roundtrip};

#[cfg(test)]
mod material_carrier_fragment;
#[cfg(all(windows, test))]
pub(crate) use windows::{FragmentRetirement, carrier_fragment_roundtrip};
