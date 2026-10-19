//! Full held topology before carrier creation. No alias success or cache-time Eq.
use super::*;
use super::{
    directory::Owner, material_directory_carrier::pin_error,
    material_directory_tree_source::listing, material_pin::MaterialPin,
};
use crate::file_access::{
    ea_records::WorkBudget,
    material_carrier_records::{Error, Resident, ResidentLease, Result, check, io_error},
    material_mixed_tree_records::{self as tree, Kind},
};
use std::{os::windows::ffi::OsStringExt, sync::atomic::AtomicBool};
fn root_git_name(raw: &[u16]) -> Result<bool> {
    let fixed = [46u16, 103, 105, 116];
    match unsafe { CompareStringOrdinal(raw.as_ptr(), raw.len() as i32, fixed.as_ptr(), 4, 1) } {
        0 => Err(io_error("mixedManagedName", io::Error::last_os_error())),
        value => Ok(value == CSTR_EQUAL),
    }
}
pub(super) struct Node {
    pub parent: u32,
    pub leaf: Vec<u16>,
    pub kind: Kind,
    pub pin: MaterialPin,
}
pub(super) struct Sources {
    pub nodes: Vec<Node>,
    managed_root_git: Option<crate::worktrees::ManagedRootGitEdge>,
    excluded: Option<(Vec<u16>, EntryMetadata)>,
    _managed_memory: Option<ResidentLease>,
    _memory: ResidentLease,
}
impl Sources {
    pub fn collect(
        root: MaterialPin,
        leaf: Vec<u16>,
        managed_root_git: Option<crate::worktrees::ManagedRootGitEdge>,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
        resident: &Resident,
    ) -> Result<Self> {
        if !root.full_security_purpose() {
            return Err(Error::Unsupported);
        }
        root.directory_carrier_leaf(&leaf).map_err(pin_error)?;
        let memory = resident.lease(tree::MAX_NODES * 4096)?;
        let managed_memory = if managed_root_git.is_some() {
            Some(resident.lease(4096)?)
        } else {
            None
        };
        if let Some(proof) = &managed_root_git {
            proof.verify(work, cancel)?;
        }
        let mut excluded = None;
        let mut nodes = Vec::with_capacity(tree::MAX_NODES);
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
                        && root_git_name(raw)?
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
                    if nodes.iter().any(|n| n.pin.identity() == pin.identity()) {
                        return Err(Error::Unsupported);
                    }
                    if nodes.len() == tree::MAX_NODES {
                        return Err(Error::Limit);
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
        let result = Self {
            nodes,
            managed_root_git,
            excluded,
            _managed_memory: managed_memory,
            _memory: memory,
        };
        result.verify(work, cancel)?;
        Ok(result)
    }
    pub fn verify(&self, work: &mut WorkBudget, cancel: &AtomicBool) -> Result<()> {
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
                || &current.identity != node.pin.identity()
                || current.regular != (node.kind == Kind::Regular)
            {
                return Err(Error::Changed);
            }
            if node.kind == Kind::Directory {
                let values = listing(&node.pin, tree::MAX_NODES, work, cancel)?;
                let children = self.nodes.iter().filter(|n| n.parent == index as u32);
                let excluded = if index == 0 {
                    self.excluded.as_ref()
                } else {
                    None
                };
                if values.as_entries().len()
                    != children.clone().count() + usize::from(excluded.is_some())
                {
                    return Err(Error::Changed);
                }
                if let Some((raw, original)) = excluded {
                    let actual = values.as_entries().get(raw).ok_or(Error::Changed)?;
                    self.managed_root_git
                        .as_ref()
                        .ok_or(Error::Changed)?
                        .matches(Owner::file(&node.pin), raw, actual)?;
                    let current =
                        metadata_child(Owner::file(&node.pin), &std::ffi::OsString::from_wide(raw))
                            .map_err(|_| Error::Changed)?
                            .ok_or(Error::Changed)?;
                    if &current != original {
                        return Err(Error::Changed);
                    }
                }
                for child in children {
                    let actual = values.as_entries().get(&child.leaf).ok_or(Error::Changed)?;
                    if &actual.identity != child.pin.identity()
                        || actual.reparse_tag.is_some()
                        || ((actual.attributes & FILE_ATTRIBUTE_DIRECTORY != 0)
                            != (child.kind == Kind::Directory))
                    {
                        return Err(Error::Changed);
                    }
                }
            }
        }
        if let Some(proof) = &self.managed_root_git {
            proof.verify(work, cancel)?;
        }
        Ok(())
    }
}
