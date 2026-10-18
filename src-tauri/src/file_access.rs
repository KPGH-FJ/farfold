//! OS-owned file handles for delivery and restricted local-page resources.
//! Callers choose the authorized root; this layer refuses redirected components.
use std::{fs::File, io};
#[cfg(any(windows, test))]
mod directory_page;
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
    EntryMetadata, MetadataFailure, MetadataKind, PinnedPath, directory_entries, metadata_child,
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
