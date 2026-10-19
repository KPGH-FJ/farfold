//! Directory destinations all live inside ONE original Namespace owner.
//! No source writes, arbitrary pathname, aliases, raw LINK replay or controller.
use super::owned_directory::State as Directory;
use super::*;
use crate::file_access::{
    ea_records::WorkBudget,
    material_carrier_records::{self as records, Resident, ResidentLease, charge, check},
    material_directory_tree_records as tree,
};
use std::sync::atomic::AtomicBool;
struct Node {
    parent: u32,
    leaf: Vec<u16>,
    directory: Directory,
}
pub(super) struct State {
    nodes: Vec<Node>,
    resident: Resident,
    _memory: ResidentLease,
}
impl State {
    pub fn reserve(resident: &Resident) -> Result<Self> {
        let memory = resident.lease(tree::MAX_NODES * 4096)?;
        Ok(Self {
            nodes: Vec::with_capacity(tree::MAX_NODES),
            resident: resident.clone(),
            _memory: memory,
        })
    }
    pub fn create(&mut self, root: &File, parent: u32, leaf: &[u16], full: bool) -> Result<usize> {
        let ordinal = self.nodes.len();
        if ordinal >= tree::MAX_NODES
            || (ordinal == 0 && parent != tree::ROOT)
            || (ordinal != 0 && parent >= ordinal as u32)
        {
            return Err(Error::Invalid);
        }
        crate::file_access::material_raw_name::check(leaf).map_err(|_| Error::Unsupported)?;
        // Store the target owner before its FILE_CREATE call. No later Vec growth.
        self.nodes.push(Node {
            parent,
            leaf: leaf.to_vec(),
            directory: Directory::reserved(&self.resident),
        });
        let (previous, current) = self.nodes.split_at_mut(ordinal);
        let held = if parent == tree::ROOT {
            root
        } else {
            previous[parent as usize].directory.file()?
        };
        const ROOT_LEAF: &[u16] = &[
            114, 101, 115, 116, 111, 114, 101, 100, 45, 116, 114, 101, 101,
        ];
        let target = if parent == tree::ROOT {
            ROOT_LEAF
        } else {
            leaf
        };
        current[0].directory.create_named(held, target, full)?;
        Ok(ordinal)
    }
    pub fn file(&self, index: usize) -> Result<&File> {
        self.nodes
            .get(index)
            .ok_or(Error::Invalid)?
            .directory
            .file()
    }
    pub fn empty(
        &self,
        index: usize,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
        resident: &Resident,
    ) -> Result<()> {
        self.nodes
            .get(index)
            .ok_or(Error::Invalid)?
            .directory
            .empty(work, cancel, resident)
    }
    pub fn verify_edges(
        &self,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
        resident: &Resident,
    ) -> Result<()> {
        for (index, node) in self.nodes.iter().enumerate() {
            check(cancel)?;
            charge(work, (tree::MAX_NODES + 3) * records::BLOCK)?;
            let observed = super::super::directory::collect_budgeted_from(
                &node.directory,
                tree::MAX_NODES as u64,
                cancel,
                resident,
            )
            .map_err(super::super::material_directory_tree_source::directory_error)?;
            if observed.as_entries().len()
                != self
                    .nodes
                    .iter()
                    .filter(|n| n.parent == index as u32)
                    .count()
            {
                return Err(Error::Changed);
            }
            for child in self.nodes.iter().filter(|n| n.parent == index as u32) {
                let actual = observed
                    .as_entries()
                    .get(&child.leaf)
                    .ok_or(Error::Changed)?;
                if actual.identity
                    != stamp(child.directory.file()?)
                        .map_err(|e| io_error("treeTargetChildId", e))?
                        .identity
                    || actual.attributes & FILE_ATTRIBUTE_DIRECTORY == 0
                    || actual.reparse_tag.is_some()
                {
                    return Err(Error::Changed);
                }
            }
        }
        Ok(())
    }
    pub fn cleanup(&mut self) -> Result<()> {
        for node in self.nodes.iter_mut().rev() {
            node.directory.cleanup()?;
        }
        Ok(())
    }
}
