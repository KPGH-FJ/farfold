//! Links1 complete targets. DELETE/full rights are granted BEFORE source DACL.
//! No alias, arbitrary path, new pool/Slot, source write or public restore gate.
use super::owned_directory::State as Directory;
use super::*;
use crate::file_access::{
    ea_records::WorkBudget,
    material_carrier_records::{Resident, ResidentLease, charge, check},
    material_mixed_tree_records as tree, material_raw_name,
};
use std::sync::atomic::AtomicBool;
use windows_sys::Win32::System::SystemServices::ACCESS_SYSTEM_SECURITY;
enum Object {
    Directory(Directory),
    Regular(Option<File>),
}
struct Node {
    parent: u32,
    leaf: Vec<u16>,
    kind: tree::Kind,
    identity: Option<Identity>,
    object: Object,
}
pub(in super::super) struct HeldTarget<'a> {
    pub(in super::super) file: &'a File,
    pub(in super::super) identity: &'a Identity,
    pub(in super::super) kind: tree::Kind,
}
pub(in super::super) struct State {
    nodes: Vec<Node>,
    resident: Resident,
    pending: bool,
    stopped: Vec<StoppedHandle>,
    retained: bool,
    limit: usize,
    _memory: ResidentLease,
}
impl State {
    pub(in super::super) fn reserve(resident: &Resident, count: usize) -> Result<Self> {
        if count == 0 || count > tree::MAX_NODES {
            return Err(Error::Limit);
        }
        let memory = resident.lease(count.checked_mul(4096).ok_or(Error::Limit)?)?;
        Ok(Self {
            nodes: Vec::with_capacity(count),
            resident: resident.clone(),
            pending: false,
            stopped: Vec::with_capacity(count),
            retained: false,
            limit: count,
            _memory: memory,
        })
    }
    pub(in super::super) fn create(
        &mut self,
        root: &File,
        source: &tree::Node,
        cancel: &AtomicBool,
    ) -> Result<()> {
        const TOP: &[u16] = &[
            114, 101, 115, 116, 111, 114, 101, 100, 45, 109, 97, 116, 101, 114, 105, 97, 108, 45,
            116, 114, 101, 101,
        ];
        self.create_at(root, TOP, source, cancel)
    }
    pub(in super::super) fn create_at(
        &mut self,
        root: &File,
        top: &[u16],
        source: &tree::Node,
        cancel: &AtomicBool,
    ) -> Result<()> {
        check(cancel)?;
        let at = self.nodes.len();
        if self.pending || !self.stopped.is_empty() || self.retained {
            return Err(Error::CleanupUnknown);
        }
        if at >= self.limit
            || (at == 0 && (source.kind != tree::Kind::Directory || source.parent != tree::ROOT))
            || (at != 0
                && (source.parent as usize >= at
                    || self.nodes[source.parent as usize].kind != tree::Kind::Directory))
        {
            return Err(Error::Invalid);
        }
        material_raw_name::check(&source.metadata.raw_leaf).map_err(|_| Error::Unsupported)?;
        let leaf = if at == 0 {
            top
        } else {
            &source.metadata.raw_leaf
        };
        material_raw_name::check(leaf).map_err(|_| Error::Unsupported)?;
        let object = match source.kind {
            tree::Kind::Directory => Object::Directory(Directory::reserved(&self.resident)),
            tree::Kind::Regular => Object::Regular(None),
        };
        self.nodes.push(Node {
            parent: source.parent,
            leaf: leaf.to_vec(),
            kind: source.kind,
            identity: None,
            object,
        });
        let (before, current) = self.nodes.split_at_mut(at);
        let parent = if at == 0 {
            root
        } else {
            match &before[source.parent as usize].object {
                Object::Directory(d) => d.file()?,
                _ => return Err(Error::Invalid),
            }
        };
        let node = &mut current[0];
        match &mut node.object {
            Object::Directory(directory) => directory.create_named(parent, leaf, true)?,
            Object::Regular(file) => {
                let unicode = UNICODE_STRING {
                    Length: (leaf.len() * 2) as u16,
                    MaximumLength: (leaf.len() * 2) as u16,
                    Buffer: leaf.as_ptr().cast_mut(),
                };
                let object = OBJECT_ATTRIBUTES {
                    Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
                    RootDirectory: handle(parent),
                    ObjectName: &unicode,
                    Attributes: OBJ_CASE_INSENSITIVE,
                    ..Default::default()
                };
                let mut ios = IO_STATUS_BLOCK::default();
                let mut raw = ptr::null_mut();
                let status = unsafe {
                    NtCreateFile(
                        &mut raw,
                        FILE_GENERIC_READ
                            | FILE_GENERIC_WRITE
                            | DELETE
                            | WRITE_DAC
                            | WRITE_OWNER
                            | ACCESS_SYSTEM_SECURITY,
                        &object,
                        &mut ios,
                        ptr::null(),
                        FILE_ATTRIBUTE_NORMAL,
                        0,
                        FILE_CREATE,
                        FILE_NON_DIRECTORY_FILE
                            | FILE_OPEN_REPARSE_POINT
                            | FILE_SYNCHRONOUS_IO_NONALERT,
                        ptr::null(),
                        0,
                    )
                };
                if status >= 0 && !raw.is_null() && raw != INVALID_HANDLE_VALUE {
                    *file = Some(unsafe { File::from_raw_handle(raw) });
                }
                if status != 0 {
                    self.pending = status >= 0;
                    return Err(Error::NtStatus {
                        phase: "sealedTreeRegularCreate",
                        status,
                    });
                }
                if file.is_none() {
                    self.pending = true;
                    return Err(Error::Invalid);
                }
            }
        }
        let file = match &node.object {
            Object::Directory(d) => d.file()?,
            Object::Regular(f) => f.as_ref().ok_or(Error::Invalid)?,
        };
        let value = stamp(file).map_err(|e| io_error("sealedTreeCreated", e))?;
        if value.regular != (source.kind == tree::Kind::Regular)
            || value.links != 1
            || value.identity.inode == 0
            || (value.identity.device == source.metadata.source_volume
                && value.identity.inode == source.metadata.source_id)
        {
            return Err(Error::Changed);
        }
        node.identity = Some(value.identity);
        Ok(())
    }
    pub(in super::super) fn node(&self, index: usize) -> Result<HeldTarget<'_>> {
        if self.pending || !self.stopped.is_empty() {
            return Err(Error::CleanupUnknown);
        }
        let node = self.nodes.get(index).ok_or(Error::Invalid)?;
        let file = match &node.object {
            Object::Directory(d) => d.file()?,
            Object::Regular(f) => f.as_ref().ok_or(Error::Invalid)?,
        };
        let identity = node.identity.as_ref().ok_or(Error::Changed)?;
        let actual = stamp(file).map_err(|e| io_error("sealedTreeHeld", e))?;
        if &actual.identity != identity
            || actual.links != 1
            || actual.regular != (node.kind == tree::Kind::Regular)
        {
            return Err(Error::Changed);
        }
        Ok(HeldTarget {
            file,
            identity,
            kind: node.kind,
        })
    }
    pub(in super::super) fn verify_edges(
        &self,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
    ) -> Result<()> {
        for (index, node) in self.nodes.iter().enumerate() {
            check(cancel)?;
            self.node(index)?;
            if let Object::Directory(directory) = &node.object {
                let mut expected = 0;
                for child in &self.nodes {
                    check(cancel)?;
                    charge(work, 2 * size_of::<u32>())?;
                    expected += usize::from(child.parent == index as u32);
                }
                let values = super::super::directory::collect_budgeted_with_work_from(
                    directory,
                    expected as u64,
                    cancel,
                    &self.resident,
                    work,
                )
                .map_err(super::super::material_directory_tree_source::directory_error)?;
                if values.as_entries().len() != expected {
                    return Err(Error::Changed);
                }
                for (name, actual) in values.as_entries() {
                    let mut known = None;
                    for child in &self.nodes {
                        check(cancel)?;
                        charge(work, 2 * size_of::<u32>())?;
                        if child.parent != index as u32 {
                            continue;
                        }
                        charge(work, (name.len() + child.leaf.len()) * size_of::<u16>())?;
                        if name == &child.leaf {
                            known = Some(child);
                            break;
                        }
                    }
                    let child = known.ok_or(Error::Changed)?;
                    charge(work, 2 * size_of::<Identity>())?;
                    if Some(&actual.identity) != child.identity.as_ref()
                        || actual.reparse_tag.is_some()
                        || ((actual.attributes & FILE_ATTRIBUTE_DIRECTORY != 0)
                            != (child.kind == tree::Kind::Directory))
                    {
                        return Err(Error::Changed);
                    }
                }
            }
        }
        Ok(())
    }
    pub(in super::super) fn cleanup(&mut self) -> Result<()> {
        if self.pending || !self.stopped.is_empty() {
            return Err(Error::CleanupUnknown);
        }
        // Original DELETE/WRITE_ATTRIBUTES FileObjects survive source SD/readonly.
        // No pathname/DACL reopen, privilege adjustment or outside-name sweep.
        for node in self.nodes.iter_mut().rev() {
            if let Object::Regular(slot) = &mut node.object {
                if let Some(file) = slot.as_ref().filter(|_| !self.retained) {
                    let mut basic: FILE_BASIC_INFO = info(file, FileBasicInfo)
                        .map_err(|e| io_error("sealedTreeCleanupBasic", e))?;
                    basic.FileAttributes = FILE_ATTRIBUTE_NORMAL;
                    set_basic(file, &basic)?;
                    dispose(file)?;
                }
                close(slot, &mut self.stopped)?;
            }
        }
        for node in self.nodes.iter_mut().rev() {
            if let Object::Directory(directory) = &mut node.object {
                if self.retained {
                    directory.release()?;
                } else {
                    directory.cleanup()?;
                }
            }
        }
        Ok(())
    }
    pub(in super::super) fn retain(&mut self) -> Result<()> {
        if self.pending || !self.stopped.is_empty() || self.nodes.is_empty() || self.retained {
            return Err(Error::CleanupUnknown);
        }
        // No fallible close precedes this latch: failure during release must
        // retain all remaining original handles, never delete published data.
        self.retained = true;
        Ok(())
    }
}
