//! First retained material.bin body, not another temporary restore roundtrip.
use super::super::{
    inspect,
    types::{Result, error},
};
use crate::file_access::{MaterialStoreRequest, MixedMemory};
use std::path::Path;
pub(super) fn reserved(
    parent: &Path,
    directory: &Path,
    parent_stamp: &inspect::Stamp,
    directory_stamp: &inspect::Stamp,
    memory: &MixedMemory,
) -> Result<MaterialStoreRequest> {
    let parent_id = parent_stamp
        .windows_identity()
        .ok_or(error("recoveryChanged"))?;
    let directory_id = directory_stamp
        .windows_identity()
        .ok_or(error("recoveryChanged"))?;
    if parent == directory {
        return Err(error("unsafePath"));
    }
    // Only an existing operation-reserved sibling directory is admitted by
    // the real worker. The component creates no directory or public intent.
    MaterialStoreRequest::reserved(parent, directory, &parent_id, &directory_id, memory)
        .map_err(|_| error("recoveryChanged"))
}
#[cfg(test)]
#[path = "recovery_material_windows_tests.rs"]
mod tests;
