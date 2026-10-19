//! OS-owned file handles for delivery and restricted local-page resources.
//! Callers choose the authorized root; this layer refuses redirected components.
use std::{fs::File, io};
#[cfg(any(windows, test))]
mod ads_records;
#[cfg(any(windows, test))]
mod directory_page;
#[cfg(any(windows, test))]
mod ea_records;
#[cfg(windows)]
pub(crate) use ads_records::{Failure as StreamsFailure, Observation as StreamsObservation};
#[cfg(windows)]
pub(crate) use ea_records::{
    Failure as EaFailure, Observation as EaObservation, WorkBudget as EaWorkBudget,
};
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
    EntryMetadata, MetadataFailure, MetadataKind, PinnedPath, RetiredBackup, directory_entries,
    ea_observation, metadata_child, metadata_file, streams_observation,
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
