//! Held source STRUCTURE only. No BackupRead/parser/target LINK success claim.
//! Future material owner must own Sources directly in the same retirement unit.
use super::*;
use super::{
    directory::Owner,
    material_pin::{self, MaterialPin},
};
use crate::file_access::{
    ea_records::WorkBudget,
    material_carrier_records::{self as records, Resident, ResidentLease},
    material_raw_name,
};
use std::sync::atomic::{AtomicBool, Ordering};
use windows_sys::Win32::Storage::FileSystem::GetVolumeInformationByHandleW;
use windows_sys::Win32::System::SystemServices::FILE_SUPPORTS_HARD_LINKS;
const MAX: usize = 64;
const ROOT: u32 = u32::MAX;
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AliasFailure {
    Cancelled,
    Limit,
    Changed,
    Unsupported,
    Io {
        phase: &'static str,
        code: Option<i32>,
        status: Option<i32>,
    },
    Metadata(MetadataFailure),
    Incomplete {
        group: u32,
        known_names: u32,
        reported_links: u64,
    },
}
type Result<T> = std::result::Result<T, AliasFailure>;
fn io_error(phase: &'static str, e: io::Error) -> AliasFailure {
    AliasFailure::Io {
        phase,
        code: e.raw_os_error(),
        status: None,
    }
}
fn record(e: records::Error) -> AliasFailure {
    match e {
        records::Error::Cancelled => AliasFailure::Cancelled,
        records::Error::Limit => AliasFailure::Limit,
        _ => AliasFailure::Unsupported,
    }
}
fn pin_error(e: material_pin::Failure) -> AliasFailure {
    match e {
        material_pin::Failure::Cancelled => AliasFailure::Cancelled,
        material_pin::Failure::Limit => AliasFailure::Limit,
        material_pin::Failure::Changed => AliasFailure::Changed,
        material_pin::Failure::Metadata(e) => AliasFailure::Metadata(e),
        material_pin::Failure::Io {
            phase,
            code,
            nt_status,
            ..
        } => AliasFailure::Io {
            phase,
            code,
            status: nt_status,
        },
        _ => AliasFailure::Unsupported,
    }
}
fn check(c: &AtomicBool) -> Result<()> {
    if c.load(Ordering::SeqCst) {
        Err(AliasFailure::Cancelled)
    } else {
        Ok(())
    }
}
fn list(
    pin: &MaterialPin,
    left: usize,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
) -> Result<crate::file_access::material_directory_budget::MaterialEntries> {
    records::charge(
        work,
        left.checked_add(3)
            .and_then(|n| n.checked_mul(records::BLOCK))
            .ok_or(AliasFailure::Limit)?,
    )
    .map_err(record)?;
    pin.entries(left as u64, cancel).map_err(|e| match e {
        crate::file_access::DirectoryFailure::Cancelled => AliasFailure::Cancelled,
        crate::file_access::DirectoryFailure::Limit => AliasFailure::Limit,
        crate::file_access::DirectoryFailure::Changed => AliasFailure::Changed,
        crate::file_access::DirectoryFailure::Io {
            phase,
            code,
            nt_status,
            ..
        } => AliasFailure::Io {
            phase,
            code,
            status: nt_status,
        },
        _ => AliasFailure::Unsupported,
    })
}
pub(crate) struct AliasMemory(Resident);
impl Default for AliasMemory {
    fn default() -> Self {
        Self(Resident::new(records::RESIDENT_LIMIT))
    }
}
impl AliasMemory {
    pub(crate) fn whole_allowance_available(&self) -> bool {
        self.0.lease(records::RESIDENT_LIMIT).is_ok()
    }
}
fn ntfs_root(pin: &PinnedPath) -> Result<()> {
    let mut name = [0u16; 32];
    let mut flags = 0;
    let ok = unsafe {
        GetVolumeInformationByHandleW(
            handle(pin.file()),
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut flags,
            name.as_mut_ptr(),
            name.len() as u32,
        )
    };
    if ok == 0 {
        return Err(io_error("aliasVolume", io::Error::last_os_error()));
    }
    if name[..5] != [78, 84, 70, 83, 0] || flags & FILE_SUPPORTS_HARD_LINKS == 0 {
        return Err(AliasFailure::Unsupported);
    }
    Ok(())
}
pub(crate) struct AliasRequest {
    root: MaterialPin,
    leaf: Vec<u16>,
    resident: Resident,
    _memory: ResidentLease,
}
impl AliasRequest {
    pub(crate) fn held(
        pin: PinnedPath,
        leaf: Vec<u16>,
        memory: &AliasMemory,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        check(cancel)?;
        ntfs_root(&pin)?;
        material_raw_name::check(&leaf).map_err(|_| AliasFailure::Unsupported)?;
        let reserved = memory.0.lease(2048).map_err(record)?;
        let root = MaterialPin::root(pin, &memory.0, cancel).map_err(pin_error)?;
        root.directory_carrier_leaf(&leaf).map_err(pin_error)?;
        Ok(Self {
            root,
            leaf,
            resident: memory.0.clone(),
            _memory: reserved,
        })
    }
}
pub(crate) struct AliasEdge {
    pub parent: u32,
    pub raw_leaf: Vec<u16>,
    pub identity: Identity,
    pub directory: bool,
    pub reported_links: u64,
}
pub(crate) struct AliasGroup {
    pub identity: Identity,
    pub members: Vec<u32>,
    pub reported_links: u64,
}
struct Node {
    edge: AliasEdge,
    pin: MaterialPin,
    version: EntryMetadata,
    stamp: Stamp,
}
struct Sources {
    nodes: Vec<Node>,
    groups: Vec<AliasGroup>,
    _memory: ResidentLease,
}
fn group_name(
    groups: &mut Vec<AliasGroup>,
    identity: &Identity,
    links: u64,
    index: u32,
) -> Result<()> {
    if links == 0 || index as usize >= MAX {
        return Err(AliasFailure::Unsupported);
    }
    if let Some(group) = groups.iter_mut().find(|g| &g.identity == identity) {
        if group.reported_links != links || group.members.len() == MAX {
            return Err(AliasFailure::Changed);
        }
        group.members.push(index);
    } else {
        if groups.len() == MAX {
            return Err(AliasFailure::Limit);
        }
        let mut members = Vec::with_capacity(MAX);
        members.push(index);
        groups.push(AliasGroup {
            identity: identity.clone(),
            members,
            reported_links: links,
        });
    }
    Ok(())
}
fn counts_closed(groups: &[AliasGroup]) -> Result<()> {
    for (index, group) in groups.iter().enumerate() {
        if group.members.len() as u64 != group.reported_links {
            return Err(AliasFailure::Incomplete {
                group: index as u32,
                known_names: group.members.len() as u32,
                reported_links: group.reported_links,
            });
        }
    }
    Ok(())
}
fn observed(pin: MaterialPin, parent: u32, leaf: Vec<u16>) -> Result<Node> {
    let _query = pin
        .try_observation_owner()
        .map_err(|_| AliasFailure::Unsupported)?;
    pin.verify().map_err(|e| io_error("aliasEdgeVerify", e))?;
    let version = metadata_file(Owner::file(&pin)).map_err(AliasFailure::Metadata)?;
    let current = stamp(Owner::file(&pin)).map_err(|e| io_error("aliasEdgeStamp", e))?;
    let directory = match version.kind {
        MetadataKind::Directory => true,
        MetadataKind::File => false,
        _ => return Err(AliasFailure::Unsupported),
    };
    if version != *pin.opening_metadata()
        || &current.identity != pin.identity()
        || current.regular == directory
        || current.links == 0
        || directory && current.links != 1
    {
        return Err(AliasFailure::Changed);
    }
    drop(_query);
    Ok(Node {
        edge: AliasEdge {
            parent,
            raw_leaf: leaf,
            identity: current.identity.clone(),
            directory,
            reported_links: current.links,
        },
        pin,
        version,
        stamp: current,
    })
}
impl Sources {
    fn collect(
        root: MaterialPin,
        leaf: Vec<u16>,
        resident: &Resident,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        check(cancel)?;
        let memory = resident.lease(MAX * 8192).map_err(record)?;
        let mut nodes = Vec::with_capacity(MAX);
        let mut groups = Vec::with_capacity(MAX);
        nodes.push(observed(root, ROOT, leaf)?);
        if !nodes[0].edge.directory {
            return Err(AliasFailure::Unsupported);
        }
        let mut at = 0;
        while at < nodes.len() {
            check(cancel)?;
            if nodes[at].edge.directory {
                let values = list(&nodes[at].pin, MAX - nodes.len(), work, cancel)?;
                for (raw, listed) in values.as_entries() {
                    if nodes.len() == MAX {
                        return Err(AliasFailure::Limit);
                    }
                    if listed.reparse_tag.is_some() {
                        return Err(AliasFailure::Unsupported);
                    }
                    let child = nodes[at]
                        .pin
                        .child(raw, listed, cancel)
                        .map_err(pin_error)?;
                    let node = observed(child, at as u32, raw.clone())?;
                    if node.edge.identity.device != nodes[0].edge.identity.device {
                        return Err(AliasFailure::Changed);
                    }
                    if node.edge.directory
                        && nodes.iter().any(|n| n.edge.identity == node.edge.identity)
                    {
                        return Err(AliasFailure::Unsupported);
                    }
                    if nodes.iter().any(|n| {
                        n.edge.identity == node.edge.identity
                            && n.edge.directory != node.edge.directory
                    }) {
                        return Err(AliasFailure::Changed);
                    }
                    if !node.edge.directory {
                        group_name(
                            &mut groups,
                            &node.edge.identity,
                            node.edge.reported_links,
                            nodes.len() as u32,
                        )?;
                    }
                    nodes.push(node);
                }
            }
            at += 1;
        }
        let value = Self {
            nodes,
            groups,
            _memory: memory,
        };
        value.verify(work, cancel)?;
        Ok(value)
    }
    fn require_closed(&self) -> Result<()> {
        counts_closed(&self.groups)
    }
    fn verify(&self, work: &mut WorkBudget, cancel: &AtomicBool) -> Result<()> {
        for (index, node) in self.nodes.iter().enumerate() {
            check(cancel)?;
            {
                let _query = node
                    .pin
                    .try_observation_owner()
                    .map_err(|_| AliasFailure::Unsupported)?;
                node.pin
                    .verify()
                    .map_err(|e| io_error("aliasFinalHeld", e))?;
                if metadata_file(Owner::file(&node.pin)).map_err(AliasFailure::Metadata)?
                    != node.version
                    || stamp(Owner::file(&node.pin)).map_err(|e| io_error("aliasFinalStamp", e))?
                        != node.stamp
                {
                    return Err(AliasFailure::Changed);
                }
            }
            if node.edge.directory {
                let values = list(&node.pin, MAX, work, cancel)?;
                let count = self
                    .nodes
                    .iter()
                    .filter(|n| n.edge.parent == index as u32)
                    .count();
                if values.as_entries().len() != count {
                    return Err(AliasFailure::Changed);
                }
                for child in self.nodes.iter().filter(|n| n.edge.parent == index as u32) {
                    let actual = values
                        .as_entries()
                        .get(&child.edge.raw_leaf)
                        .ok_or(AliasFailure::Changed)?;
                    if actual.identity != child.edge.identity
                        || actual.reparse_tag.is_some()
                        || ((actual.attributes & FILE_ATTRIBUTE_DIRECTORY != 0)
                            != child.edge.directory)
                    {
                        return Err(AliasFailure::Changed);
                    }
                }
            }
        }
        // Group membership is fixed by complete collected edges. Recheck every held
        // member's SAME fullID/linkcount through exact actual versions above.
        self.require_closed()
    }
}
pub(crate) struct AliasView<'a> {
    sources: &'a Sources,
}
impl AliasView<'_> {
    pub(crate) fn edge_count(&self) -> usize {
        self.sources.nodes.len()
    }
    pub(crate) fn edge(&self, index: usize) -> Option<&AliasEdge> {
        self.sources.nodes.get(index).map(|n| &n.edge)
    }
    pub(crate) fn groups(&self) -> &[AliasGroup] {
        &self.sources.groups
    }
}
// Readonly structural consumer only; does not expose a File/Pin to BackupRead.
// Future native material owner must directly own Sources in its outer retired
// resource unit, retain original payload Facts, then reverify after real restore.
pub(crate) fn with_alias_structure<T, F>(
    request: AliasRequest,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    consume: F,
) -> Result<T>
where
    F: for<'a> FnOnce(AliasView<'a>) -> Result<T>,
{
    if work.remaining() > records::WORK_LIMIT {
        return Err(AliasFailure::Limit);
    }
    let AliasRequest {
        root,
        leaf,
        resident,
        _memory,
    } = request;
    let sources = Sources::collect(root, leaf, &resident, work, cancel)?;
    sources.require_closed()?;
    let result = consume(AliasView { sources: &sources })?;
    sources.verify(work, cancel)?;
    Ok(result)
}
#[cfg(test)]
#[path = "material_alias_topology_unit_tests.rs"]
mod tests;
