//! First retained material.bin body, not another temporary restore roundtrip.
use super::super::{
    inspect,
    types::{Result, error},
};
use crate::file_access::{MaterialStoreRequest, MixedMemory};
use std::path::Path;
pub(in crate::worktrees) fn reserved(
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
// The unique worktree-to-material adapter. The proof owns the SAME admitted
// SourceOwner, not a string exclusion, copied receipt or new ReadContext.
pub(in crate::worktrees) fn worktree_source(
    graph: &super::super::git::source_roots::SourceGraph,
    root: crate::file_access::PinnedPath,
    leaf: Vec<u16>,
    memory: &MixedMemory,
    cancel: &std::sync::atomic::AtomicBool,
) -> std::result::Result<crate::file_access::MixedRequest, crate::file_access::CarrierFailure> {
    crate::file_access::MixedRequest::worktree(
        root,
        leaf,
        memory,
        cancel,
        graph.managed_root_git_edge(),
    )
}
#[cfg(test)]
#[path = "recovery_material_windows_tests.rs"]
mod tests;
