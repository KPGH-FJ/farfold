//! First retained material.bin body, not another temporary restore roundtrip.
use super::super::{
    inspect,
    types::{Result, error},
};
use crate::file_access::{MaterialStoreRequest, MixedMemory};
use std::path::Path;
pub(in crate::worktrees) fn archive_full(
    profile: Option<&super::super::MaterialProfile>,
) -> Result<bool> {
    use super::super::MaterialProfile::*;
    match profile {
        Some(WindowsDefaultDataEaStreamsLinksFullSecurityV1) => Ok(true),
        Some(WindowsDefaultDataEaStreamsOwnerGroupDaclLinksLabelV1) => Ok(false),
        _ => Err(error("unsupportedMaterial")),
    }
}
pub(in crate::worktrees) fn retained_full(
    profile: Option<&super::super::MaterialProfile>,
) -> Result<bool> {
    use super::super::MaterialProfile::*;
    match profile {
        Some(WindowsRetainedTreeV1) => Ok(true),
        Some(WindowsOrdinaryRetainedTreeV1) => Ok(false),
        _ => Err(error("unsupportedMaterial")),
    }
}
fn root_for(path: &Path, full: bool) -> Result<crate::file_access::PinnedPath> {
    if full {
        crate::file_access::PinnedPath::directory_full_security(path)
            .map_err(|_| error("unsupportedMaterial"))
    } else {
        crate::file_access::PinnedPath::directory(path).map_err(|_| error("unsupportedMaterial"))
    }
}
fn complete_receipt(
    actual: &crate::file_access::MaterialTreeReceipt,
    expected: &super::material_manifest::WindowsMaterial,
    retained: bool,
) -> bool {
    let nodes = expected.nodes.len();
    let directories = expected
        .nodes
        .iter()
        .filter(|n| n.kind == super::material_manifest::MaterialKind::Directory)
        .count();
    actual.nodes == nodes
        && actual.target_ids.len() == nodes
        && actual.directories == directories
        && actual.regulars == nodes - directories
        && (actual.write_aborts as u64 + actual.direct_data_writes as u64)
            == expected
                .nodes
                .iter()
                .filter(|n| {
                    n.ordinary_security.is_none()
                        || n.ea.count != 0
                        || n.streams.iter().any(|s| !s.name.is_empty() || s.bytes != 0)
                })
                .count() as u64
        && actual.read_aborts as usize == nodes
        && actual.all_native_recaptured
        && actual.exact_edges_verified
        && actual.metadata_finalized
        && actual.retained == retained
}
pub(super) fn capture(
    owner: &super::super::material_owner::Owner,
    graph: &super::super::git::source_roots::SourceGraph,
    snapshot: &inspect::Snapshot,
    full: bool,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<super::MaterialSummary> {
    capture_edge(owner, graph.managed_root_git_edge(), snapshot, full, cancel)
}
fn capture_edge(
    owner: &super::super::material_owner::Owner,
    edge: crate::worktrees::ManagedRootGitEdge,
    snapshot: &inspect::Snapshot,
    full: bool,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<super::MaterialSummary> {
    use std::os::windows::ffi::OsStrExt;
    let root = root_for(Path::new(&snapshot.root), full)?;
    if inspect::pinned_stamp(&root)? != snapshot.root_stamp {
        return Err(error("recoveryChanged"));
    }
    let memory = MixedMemory::default();
    let leaf = Path::new(&snapshot.root)
        .file_name()
        .ok_or(error("unsafePath"))?
        .encode_wide()
        .collect();
    let request = if full {
        crate::file_access::MixedRequest::worktree(root, leaf, &memory, cancel, edge)
    } else {
        crate::file_access::MixedRequest::worktree_ordinary(root, leaf, &memory, cancel, edge)
    }
    .map_err(|_| error("unsupportedMaterial"))?;
    owner.capture_complete_tree(request, cancel)
}
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
    if root.full_security_purpose() {
        crate::file_access::MixedRequest::worktree(
            root,
            leaf,
            memory,
            cancel,
            graph.managed_root_git_edge(),
        )
    } else {
        crate::file_access::MixedRequest::worktree_ordinary(
            root,
            leaf,
            memory,
            cancel,
            graph.managed_root_git_edge(),
        )
    }
}
#[cfg(test)]
#[path = "recovery_material_windows_tests.rs"]
mod tests;

pub(super) fn build(
    owner: &super::super::material_owner::Owner,
    saved: &super::SavedArchive,
    captured: &super::Capture,
    destination: &Path,
    stamp: &inspect::Stamp,
    prepared: crate::worktrees::PreparedRecoveryGit,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<super::material_manifest::WindowsMaterial> {
    use std::os::windows::ffi::OsStrExt;
    let snapshot = inspect::snapshot(Path::new(&saved.archive.retained_path))?;
    if snapshot.root_stamp != saved.original.identity.root_stamp {
        return Err(error("recoveryChanged"));
    }
    let graph = super::super::git::source_roots::SourceGraph::capture(&snapshot, cancel)?;
    if graph.roots() != &captured.roots || graph.objects() != captured.objects {
        return Err(error("recoveryChanged"));
    }
    let (configs, attributes) = graph.checkout_profile(cancel)?;
    if configs != captured.configs || attributes != captured.attributes {
        return Err(error("recoveryChanged"));
    }
    let memory = MixedMemory::default();
    let root = root_for(
        Path::new(&snapshot.root),
        archive_full(saved.material.profile.as_ref())?,
    )?;
    if inspect::pinned_stamp(&root)? != snapshot.root_stamp {
        return Err(error("recoveryChanged"));
    }
    let leaf = Path::new(&snapshot.root)
        .file_name()
        .ok_or(error("unsafePath"))?
        .encode_wide()
        .collect();
    let source = worktree_source(&graph, root, leaf, &memory, cancel)
        .and_then(|r| r.with_recovery_git(prepared, cancel))
        .map_err(|_| error("unsupportedMaterial"))?;
    let output = reserved(
        Path::new(&saved.parent),
        destination,
        &saved.parent_stamp,
        stamp,
        &memory,
    )?;
    let (descriptor, _) = owner.sealed_material(source, output, cancel, |sealed| {
        let descriptor = sealed.descriptor()?;
        if descriptor.content.nodes as u64 != captured.content.entries
            || descriptor.content.bytes != captured.content.bytes
            || super::material_scan::hex(descriptor.content.sha256) != captured.content.sha256
            || descriptor.content.nodes as usize >= descriptor.nodes.len()
        {
            return Err(crate::file_access::CarrierFailure::Changed);
        }
        let actual = sealed.reconstruct_tree()?;
        if !complete_receipt(&actual, &descriptor, false) {
            return Err(crate::file_access::CarrierFailure::Changed);
        }
        Ok(descriptor)
    })?;
    graph.recheck(cancel)?;
    Ok(descriptor)
}

pub(super) fn verify(
    owner: &super::super::material_owner::Owner,
    saved: &super::SavedRecovery,
    manifest: &super::Manifest,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<()> {
    let memory = MixedMemory::default();
    let request = reserved(
        Path::new(&saved.parent),
        Path::new(&saved.receipt.path),
        &saved.parent_stamp,
        &saved.directory_stamp,
        &memory,
    )?;
    let expected = manifest
        .windows_material
        .as_ref()
        .ok_or(error("recoveryInvalid"))?;
    owner.reopen_material(request, expected, cancel, |sealed| {
        let actual = sealed.reconstruct_tree()?;
        if !complete_receipt(&actual, expected, false) {
            return Err(crate::file_access::CarrierFailure::Changed);
        }
        Ok(())
    })?;
    Ok(())
}

pub(in crate::worktrees) fn restore_target(
    owner: &super::super::material_owner::Owner,
    intent: &super::super::storage::RecoverIntent,
    manifest: &super::Manifest,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<inspect::Stamp> {
    use std::os::windows::ffi::OsStrExt;
    let saved = &intent.recovery;
    let memory = MixedMemory::default();
    let request = reserved(
        Path::new(&saved.parent),
        Path::new(&saved.receipt.path),
        &saved.parent_stamp,
        &saved.directory_stamp,
        &memory,
    )?;
    let parent = crate::file_access::PinnedPath::directory(Path::new(&intent.parent))
        .map_err(|_| error("unsafePath"))?;
    let expected_parent = intent
        .parent_stamp
        .windows_identity()
        .ok_or(error("recoveryChanged"))?;
    let leaf = Path::new(&intent.target)
        .file_name()
        .ok_or(error("unsafePath"))?
        .encode_wide()
        .collect();
    let target = crate::file_access::MaterialTargetRequest::new(
        Path::new(&parent.path),
        &expected_parent,
        leaf,
        &memory,
    )
    .map_err(|_| error("recoveryChanged"))?;
    let expected = manifest
        .windows_material
        .as_ref()
        .ok_or(error("recoveryInvalid"))?;
    let (actual, _) = owner.reopen_material(request, expected, cancel, |sealed| {
        sealed.reconstruct_target(target)
    })?;
    if !complete_receipt(&actual, expected, true) {
        return Err(error("recoveryChanged"));
    }
    let stamp = inspect::stamp(Path::new(&intent.target))?;
    if stamp.windows_identity().as_ref() != actual.target_ids.first() {
        return Err(error("recoveryChanged"));
    }
    Ok(stamp)
}

pub(in crate::worktrees) fn verify_target(
    owner: &super::super::material_owner::Owner,
    target: &Path,
    manifest: &super::Manifest,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<()> {
    let snapshot = inspect::snapshot(target)?;
    let graph =
        super::super::git::source_roots::RecoveryGraph::capture(&snapshot, manifest, cancel)?;
    let (configs, attributes) = graph.checkout_profile(cancel)?;
    if configs != manifest.configs
        || attributes != manifest.attributes
        || capture_edge(
            owner,
            graph.managed_root_git_edge(),
            &snapshot,
            retained_full(manifest.content.profile.as_ref())?,
            cancel,
        )? != manifest.content
    {
        return Err(error("recoveryChanged"));
    }
    graph.recheck(cancel)
}
