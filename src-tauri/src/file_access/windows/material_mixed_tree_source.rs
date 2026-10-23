//! Full held topology before carrier creation. No alias success or cache-time Eq.
use super::*;
use super::{
    directory::Owner, material_directory_carrier::pin_error,
    material_directory_tree_source::listing, material_pin::MaterialPin,
};
use crate::file_access::{
    ea_records::WorkBudget,
    material_carrier_records::{Error, Resident, ResidentLease, Result, charge, check, io_error},
    material_mixed_tree_records::{self as tree, Kind},
};
use std::{os::windows::ffi::OsStringExt, sync::atomic::AtomicBool};
fn root_git_name(raw: &[u16], work: &mut WorkBudget, cancel: &AtomicBool) -> Result<bool> {
    check(cancel)?;
    let fixed = [46u16, 103, 105, 116];
    charge(work, (raw.len() + fixed.len()) * 2)?;
    match unsafe { CompareStringOrdinal(raw.as_ptr(), raw.len() as i32, fixed.as_ptr(), 4, 1) } {
        0 => Err(io_error("mixedManagedName", io::Error::last_os_error())),
        value => Ok(value == CSTR_EQUAL),
    }
}
fn duplicate_identity<'a>(
    known: impl Iterator<Item = &'a Identity>,
    candidate: &Identity,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<bool> {
    for existing in known {
        if same_identity(existing, candidate, work, cancel)? {
            return Ok(true);
        }
    }
    Ok(false)
}
fn same_identity(
    left: &Identity,
    right: &Identity,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<bool> {
    check(cancel)?;
    charge(work, 2 * size_of::<Identity>())?;
    Ok(left == right)
}
fn next_child<'a>(
    nodes: &mut std::slice::Iter<'a, Node>,
    parent: u32,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<Option<&'a Node>> {
    for node in nodes {
        check(cancel)?;
        charge(work, 2 * size_of::<u32>())?;
        if node.parent == parent {
            return Ok(Some(node));
        }
    }
    Ok(None)
}
fn same_name(
    left: &[u16],
    right: &[u16],
    work: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<bool> {
    check(cancel)?;
    charge(
        work,
        left.len()
            .checked_add(right.len())
            .and_then(|n| n.checked_mul(2))
            .ok_or(Error::Limit)?,
    )?;
    Ok(left == right)
}
fn find_child<'a>(
    available: &'a [Node],
    parent: u32,
    name: &[u16],
    work: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<&'a Node> {
    let mut nodes = available.iter();
    while let Some(child) = next_child(&mut nodes, parent, work, cancel)? {
        if same_name(name, &child.leaf, work, cancel)? {
            return Ok(child);
        }
    }
    Err(Error::Changed)
}
pub(super) struct Node {
    pub parent: u32,
    pub leaf: Vec<u16>,
    pub kind: Kind,
    pub pin: MaterialPin,
}
pub(super) struct Sources {
    pub nodes: Vec<Node>,
    pub user_nodes: usize,
    recovery_git: Option<crate::worktrees::PreparedRecoveryGit>,
    managed_root_git: Option<crate::worktrees::ManagedRootGitEdge>,
    removal_hold: Option<crate::worktrees::ManagedRemovalHold>,
    excluded: Option<(Vec<u16>, EntryMetadata)>,
    _managed_memory: Option<ResidentLease>,
    _recovery_memory: Option<ResidentLease>,
    _memory: ResidentLease,
}
impl Sources {
    pub fn collect(
        root: MaterialPin,
        leaf: Vec<u16>,
        managed_root_git: Option<crate::worktrees::ManagedRootGitEdge>,
        recovery_git: Option<crate::worktrees::PreparedRecoveryGit>,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
        resident: &Resident,
    ) -> Result<Self> {
        root.directory_carrier_leaf(&leaf).map_err(pin_error)?;
        let mut memory = resident.lease(4096)?;
        let managed_memory = if managed_root_git.is_some() {
            Some(resident.lease(4096)?)
        } else {
            None
        };
        if let Some(proof) = &managed_root_git {
            proof.verify(work, cancel)?;
        }
        let mut excluded = None;
        // Only this one non-recursive recovery subtree can be merged. Keep its
        // original lease with the moved nodes, without a lease queue or gap.
        let mut recovery_memory = None;
        let mut nodes = Vec::with_capacity(1);
        nodes.push(Node {
            parent: tree::ROOT,
            leaf,
            kind: Kind::Directory,
            pin: root,
        });
        let mut at = 0;
        while at < nodes.len() {
            check(cancel)?;
            if nodes[at].kind == Kind::Directory {
                // One proved administrative edge counts in the COMPLETE listing,
                // but cannot consume a payload node slot or enter FFMTREE1.
                let extra = usize::from(at == 0 && managed_root_git.is_some());
                let values = listing(
                    &nodes[at].pin,
                    tree::MAX_NODES - nodes.len() + extra,
                    work,
                    cancel,
                )?;
                for (raw, observed) in values.as_entries() {
                    if at == 0
                        && let Some(proof) = &managed_root_git
                        && root_git_name(raw, work, cancel)?
                    {
                        if excluded.is_some() {
                            return Err(Error::Changed);
                        }
                        proof.matches(Owner::file(&nodes[0].pin), raw, observed)?;
                        let actual = metadata_child(
                            Owner::file(&nodes[0].pin),
                            &std::ffi::OsString::from_wide(raw),
                        )
                        .map_err(|_| Error::Changed)?
                        .ok_or(Error::Changed)?;
                        excluded = Some((raw.clone(), actual));
                        continue;
                    }
                    if observed.reparse_tag.is_some() {
                        return Err(Error::Unsupported);
                    }
                    if nodes.len() == tree::MAX_NODES {
                        return Err(Error::Limit);
                    }
                    resident.grow(&mut memory, 4096)?;
                    nodes.try_reserve_exact(1).map_err(|_| Error::Limit)?;
                    let pin = nodes[at]
                        .pin
                        .child(raw, observed, cancel)
                        .map_err(pin_error)?;
                    let kind = match pin.opening_metadata().kind {
                        MetadataKind::Directory => Kind::Directory,
                        MetadataKind::File => Kind::Regular,
                        _ => return Err(Error::Unsupported),
                    };
                    // Complete observed namespace groups are enumerated, never flatten aliases.
                    // Each actual links==1 rejects both duplicate inside names and outside links.
                    let current =
                        stamp(Owner::file(&pin)).map_err(|e| io_error("mixedLinks", e))?;
                    if current.links != 1 {
                        return Err(Error::Unsupported);
                    }
                    if duplicate_identity(
                        nodes.iter().map(|n| n.pin.identity()),
                        pin.identity(),
                        work,
                        cancel,
                    )? {
                        return Err(Error::Unsupported);
                    }
                    nodes.push(Node {
                        parent: at as u32,
                        leaf: raw.clone(),
                        kind,
                        pin,
                    });
                }
            }
            at += 1;
        }
        if managed_root_git.is_some() && excluded.is_none() {
            return Err(Error::Changed);
        }
        let user_nodes = nodes.len();
        if let Some(proof) = &recovery_git {
            if managed_root_git.is_none() {
                return Err(Error::Unsupported);
            }
            proof.verify(cancel).map_err(|_| Error::Changed)?;
            let full_root = proof
                .root_for(nodes[0].pin.full_security_purpose(), cancel)
                .map_err(|_| Error::Unsupported)?;
            let pin = MaterialPin::root(full_root, resident, cancel).map_err(pin_error)?;
            let extra = Self::collect(
                pin,
                vec![46, 103, 105, 116],
                None,
                None,
                work,
                cancel,
                resident,
            )?;
            let total = nodes
                .len()
                .checked_add(extra.nodes.len())
                .ok_or(Error::Limit)?;
            if total > tree::MAX_NODES {
                return Err(Error::Limit);
            }
            // The receiving vector may be reallocated while the donor still
            // exists. Admit that actual capacity before moving any nodes, and
            // retain the donor's existing node/name lease until Sources drops.
            resident.grow(
                &mut memory,
                total.checked_mul(size_of::<Node>()).ok_or(Error::Limit)?,
            )?;
            nodes
                .try_reserve_exact(extra.nodes.len())
                .map_err(|_| Error::Limit)?;
            recovery_memory = Some(extra._memory);
            for (index, mut node) in extra.nodes.into_iter().enumerate() {
                if duplicate_identity(
                    nodes.iter().map(|n| n.pin.identity()),
                    node.pin.identity(),
                    work,
                    cancel,
                )? {
                    return Err(Error::Changed);
                }
                node.parent = if index == 0 {
                    0
                } else {
                    node.parent + user_nodes as u32
                };
                nodes.push(node);
            }
            proof.verify(cancel).map_err(|_| Error::Changed)?;
        }
        let result = Self {
            nodes,
            user_nodes,
            recovery_git,
            managed_root_git,
            removal_hold: None,
            excluded,
            _managed_memory: managed_memory,
            _recovery_memory: recovery_memory,
            _memory: memory,
        };
        result.verify(work, cancel)?;
        Ok(result)
    }
    pub fn verify(&self, work: &mut WorkBudget, cancel: &AtomicBool) -> Result<()> {
        if let Some(proof) = &self.recovery_git {
            proof.verify(cancel).map_err(|_| Error::Changed)?;
        }
        if let Some(proof) = &self.managed_root_git {
            proof.verify(work, cancel)?;
        }
        for (index, node) in self.nodes.iter().enumerate() {
            check(cancel)?;
            node.pin
                .verify()
                .map_err(|e| io_error("mixedSourceFinal", e))?;
            if metadata_file(Owner::file(&node.pin)).map_err(|_| Error::Invalid)?
                != *node.pin.opening_metadata()
            {
                return Err(Error::Changed);
            }
            let current =
                stamp(Owner::file(&node.pin)).map_err(|e| io_error("mixedSourceStamp", e))?;
            if current.links != 1
                || !same_identity(&current.identity, node.pin.identity(), work, cancel)?
                || current.regular != (node.kind == Kind::Regular)
            {
                return Err(Error::Changed);
            }
            if node.kind == Kind::Directory {
                let available = &self.nodes[..if index == 0 {
                    self.user_nodes
                } else {
                    self.nodes.len()
                }];
                let excluded = if index == 0 {
                    self.excluded.as_ref()
                } else {
                    None
                };
                let mut scan = available.iter();
                let mut count = usize::from(excluded.is_some());
                while next_child(&mut scan, index as u32, work, cancel)?.is_some() {
                    count += 1;
                }
                let values = listing(&node.pin, count, work, cancel)?;
                if values.as_entries().len() != count {
                    return Err(Error::Changed);
                }
                // Match actual names to original children independent of their
                // storage order (a recovery subtree may be appended later).
                // Both loops charge each parent/raw comparison before use.
                let mut saw_excluded = false;
                for (raw, actual) in values.as_entries() {
                    if let Some((original_raw, original)) = excluded
                        && same_name(raw, original_raw, work, cancel)?
                    {
                        saw_excluded = true;
                        self.managed_root_git
                            .as_ref()
                            .ok_or(Error::Changed)?
                            .matches(Owner::file(&node.pin), raw, actual)?;
                        let current = metadata_child(
                            Owner::file(&node.pin),
                            &std::ffi::OsString::from_wide(raw),
                        )
                        .map_err(|_| Error::Changed)?
                        .ok_or(Error::Changed)?;
                        if &current != original {
                            return Err(Error::Changed);
                        }
                        continue;
                    }
                    let child = find_child(available, index as u32, raw, work, cancel)?;
                    if !same_identity(&actual.identity, child.pin.identity(), work, cancel)?
                        || actual.reparse_tag.is_some()
                        || ((actual.attributes & FILE_ATTRIBUTE_DIRECTORY != 0)
                            != (child.kind == Kind::Directory))
                    {
                        return Err(Error::Changed);
                    }
                }
                if saw_excluded != excluded.is_some() {
                    return Err(Error::Changed);
                }
            }
        }
        if let Some(proof) = &self.managed_root_git {
            proof.verify(work, cancel)?;
        }
        if let Some(proof) = &self.recovery_git {
            proof.verify(cancel).map_err(|_| Error::Changed)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_access::material_carrier_records::RESIDENT_LIMIT;
    #[test]
    fn comparison_budget_and_cancel_precede_matching_identity_and_raw_names() {
        let id = Identity {
            device: 7,
            inode: 9,
        };
        let cancel = AtomicBool::new(false);
        let mut none = WorkBudget::new(0);
        assert_eq!(
            duplicate_identity([&id].into_iter(), &id, &mut none, &cancel),
            Err(Error::Limit)
        );
        let mut exact = WorkBudget::new((2 * size_of::<Identity>()) as u64);
        assert!(duplicate_identity([&id].into_iter(), &id, &mut exact, &cancel).unwrap());
        assert_eq!(exact.remaining(), 0);
        let mut name = WorkBudget::new(3);
        assert_eq!(
            same_name(&[65], &[65], &mut name, &cancel),
            Err(Error::Limit)
        );
        assert_eq!(name.remaining(), 3);
        let mut stopped = WorkBudget::new(1024);
        assert_eq!(
            duplicate_identity([&id].into_iter(), &id, &mut stopped, &AtomicBool::new(true)),
            Err(Error::Cancelled)
        );
        assert_eq!(stopped.remaining(), 1024);
    }
    #[test]
    #[ignore = "manual: actual NTFS with existing FullSecurity rights; no privilege change"]
    fn more_than_sixty_four_actual_sources_fit_unchanged_pool_and_release_their_leases() {
        let temp = tempfile::tempdir().unwrap();
        let root_path = temp.path().join("owned mixed root");
        std::fs::create_dir(&root_path).unwrap();
        for n in 0..80 {
            std::fs::write(root_path.join(format!("owned-{n:03}")), b"owned").unwrap();
        }
        let cancel = AtomicBool::new(false);
        let resident = Resident::new(RESIDENT_LIMIT);
        let pin = PinnedPath::directory_full_security(&root_path).unwrap();
        let root = MaterialPin::root(pin, &resident, &cancel).unwrap();
        let mut work = WorkBudget::new(4 * 1024 * 1024);
        let mut sources = Sources::collect(
            root,
            "owned mixed root".encode_utf16().collect(),
            None,
            None,
            &mut work,
            &cancel,
            &resident,
        )
        .unwrap();
        assert_eq!(sources.nodes.len(), 81);
        assert!(resident.lease(RESIDENT_LIMIT).is_err());
        // Actual names must match original nodes even when their retained
        // storage order changes; do not zip the carrier order with a listing.
        sources.nodes[1..].reverse();
        sources.verify(&mut work, &cancel).unwrap();
        drop(sources);
        assert!(resident.lease(RESIDENT_LIMIT).is_ok());
    }
}

#[path = "material_remove_fence.rs"]
mod removal_fence;
pub(crate) use removal_fence::RemovalMaterial;
pub(super) use removal_fence::RemovalProgress;
