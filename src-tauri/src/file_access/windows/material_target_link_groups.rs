//! Composable target-only groups in the ORIGINAL Namespace and retirement Slot.
//! Actual cross-parent links, not BACKUP_LINK replay or complete source restore.
use super::super::*;
use super::owned_link::snapshot::Snapshot;
use super::{Namespace, StoppedHandle, close, dispose, set_basic};
use crate::file_access::{
    ea_records::WorkBudget,
    material_carrier_records::{
        self as records, Error, Resident, ResidentLease, Result, charge, check, io_error,
    },
    material_raw_name,
};
#[cfg(test)]
use std::io::Write as _;
use std::sync::atomic::AtomicBool;
use windows_sys::Wdk::Storage::FileSystem::{FILE_LINK_INFORMATION, FileLinkInformation};
use windows_sys::Win32::System::SystemServices::ACCESS_SYSTEM_SECURITY;
#[path = "material_target_link_parent.rs"]
mod parent;
use parent::Parent;
// This separate alias-group component retains its original supported bound;
// extending the mixed single-link tree must not enlarge its fixed reservations.
pub(crate) const MAX_NODES: usize = 64;
pub(crate) const ROOT: u32 = crate::file_access::material_mixed_tree_records::ROOT;
const COLLISION: i32 = 0xc0000035u32 as i32;
struct Directory {
    ancestor: u32,
    leaf: Vec<u16>,
    owner: Parent,
}
struct Member {
    group: usize,
    parent: usize,
    leaf: Vec<u16>,
    file: Option<File>,
    delete: Option<File>,
}
struct Group {
    primary: usize,
    full: bool,
}
pub(super) struct State {
    directories: Vec<Directory>,
    groups: Vec<Group>,
    members: Vec<Member>,
    pending: bool,
    stopped: Vec<StoppedHandle>,
    status: Option<(&'static str, i32)>,
    buffer: Option<Vec<u64>>,
    buffer_memory: Option<ResidentLease>,
    resident: Resident,
    _memory: ResidentLease,
}
impl State {
    pub(super) fn reserve(resident: &Resident) -> Result<Self> {
        // All Vec capacities and counted names are reserved BEFORE native calls.
        let memory = resident.lease(MAX_NODES * 8192)?;
        Ok(Self {
            directories: Vec::with_capacity(MAX_NODES),
            groups: Vec::with_capacity(MAX_NODES),
            members: Vec::with_capacity(MAX_NODES),
            pending: false,
            stopped: Vec::with_capacity(2 * MAX_NODES),
            status: None,
            buffer: None,
            buffer_memory: None,
            resident: resident.clone(),
            _memory: memory,
        })
    }
    fn ready(&self) -> Result<()> {
        if self.pending || !self.stopped.is_empty() {
            Err(Error::CleanupUnknown)
        } else {
            Ok(())
        }
    }
    fn room(&self) -> Result<()> {
        self.ready()?;
        if self.directories.len() + self.members.len() >= MAX_NODES {
            Err(Error::Limit)
        } else {
            Ok(())
        }
    }
    fn parent(&self, index: usize) -> Result<&File> {
        self.ready()?;
        self.directories
            .get(index)
            .ok_or(Error::Invalid)?
            .owner
            .file()
    }
    pub(super) fn create_parent(
        &mut self,
        root: &File,
        ancestor: u32,
        leaf: &[u16],
        cancel: &AtomicBool,
    ) -> Result<u32> {
        check(cancel)?;
        self.room()?;
        material_raw_name::check(leaf).map_err(|_| Error::Invalid)?;
        let at = self.directories.len();
        if (at == 0 && ancestor != ROOT) || (at != 0 && ancestor as usize >= at) {
            return Err(Error::Invalid);
        }
        const TOP: &[u16] = &[
            116, 97, 114, 103, 101, 116, 45, 108, 105, 110, 107, 45, 116, 114, 101, 101,
        ];
        let name = if at == 0 { TOP } else { leaf };
        self.directories.push(Directory {
            ancestor,
            leaf: name.to_vec(),
            owner: Parent::reserve(&self.resident),
        });
        let (old, new) = self.directories.split_at_mut(at);
        let held = if ancestor == ROOT {
            root
        } else {
            old[ancestor as usize].owner.file()?
        };
        new[0].owner.create(held, name)?;
        Ok(at as u32)
    }
    pub(super) fn create_group(
        &mut self,
        parent: u32,
        leaf: &[u16],
        full: bool,
        cancel: &AtomicBool,
    ) -> Result<u32> {
        check(cancel)?;
        self.room()?;
        material_raw_name::check(leaf).map_err(|_| Error::Invalid)?;
        self.parent(parent as usize)?;
        let group = self.groups.len();
        let at = self.members.len();
        self.groups.push(Group { primary: at, full });
        self.members.push(Member {
            group,
            parent: parent as usize,
            leaf: leaf.to_vec(),
            file: None,
            delete: None,
        });
        let held = self.directories[parent as usize].owner.file()?;
        let access = FILE_GENERIC_READ
            | FILE_GENERIC_WRITE
            | DELETE
            | if full {
                WRITE_DAC | WRITE_OWNER | ACCESS_SYSTEM_SECURITY
            } else {
                0
            };
        let status = open(
            held,
            leaf,
            false,
            FILE_CREATE,
            access,
            FILE_SHARE_READ,
            &mut self.members[at].file,
        );
        self.status = Some(("targetGroupPrimary", status));
        if status != 0 {
            self.pending = status >= 0;
            return Err(Error::NtStatus {
                phase: "targetGroupPrimary",
                status,
            });
        }
        if self.members[at].file.is_none() {
            self.pending = true;
            return Err(Error::Invalid);
        }
        let value = stamp(self.members[at].file.as_ref().ok_or(Error::Invalid)?)
            .map_err(|e| io_error("targetGroupPrimaryId", e))?;
        if !value.regular
            || value.links != 1
            || value.identity.device
                != stamp(held)
                    .map_err(|e| io_error("targetGroupParentId", e))?
                    .identity
                    .device
        {
            return Err(Error::Unsupported);
        }
        // Temporary target metadata only. MS-FSA FileLinkInformation sets
        // ARCHIVE even for an empty file; establish that before comparisons.
        // Source final attributes are a later metadata-last responsibility.
        set_basic(
            self.members[at].file.as_ref().ok_or(Error::Invalid)?,
            &FILE_BASIC_INFO {
                FileAttributes: FILE_ATTRIBUTE_ARCHIVE,
                ..Default::default()
            },
        )?;
        Ok(group as u32)
    }
    pub(super) fn target(&mut self, group: u32) -> Result<&mut File> {
        self.ready()?;
        let g = self.groups.get(group as usize).ok_or(Error::Invalid)?;
        if self
            .members
            .iter()
            .filter(|m| m.group == group as usize)
            .count()
            != 1
        {
            return Err(Error::Invalid);
        }
        self.members[g.primary].file.as_mut().ok_or(Error::Invalid)
    }
    pub(super) fn add(
        &mut self,
        group: u32,
        parent: u32,
        leaf: &[u16],
        work: &mut WorkBudget,
        cancel: &AtomicBool,
    ) -> Result<()> {
        self.room()?;
        check(cancel)?;
        if work.remaining() > records::WORK_LIMIT {
            return Err(Error::Limit);
        }
        material_raw_name::check(leaf).map_err(|_| Error::Invalid)?;
        self.parent(parent as usize)?;
        let group = group as usize;
        let g = self.groups.get(group).ok_or(Error::Invalid)?;
        let primary_index = g.primary;
        let full = g.full;
        let primary = self.members[primary_index]
            .file
            .as_ref()
            .ok_or(Error::Invalid)?;
        let before =
            Snapshot::take(primary, full, work, cancel, &self.resident).inspect_err(|error| {
                #[cfg(test)]
                Snapshot::diagnostic_error("targetGroup.before", error);
            })?;
        let primary_handle = handle(primary);
        let count = self.members.iter().filter(|m| m.group == group).count();
        if before.stamp.links != count as u64 {
            #[cfg(test)]
            let _ = writeln!(
                std::io::stderr().lock(),
                "FARFOLD_LINK_CHANGED phase=targetGroup.beforeLinkCount group={group} expected={count} actual={}",
                before.stamp.links
            );
            return Err(Error::Changed);
        }
        let held = self.directories[parent as usize].owner.file()?;
        if before.stamp.identity.device
            != stamp(held)
                .map_err(|e| io_error("targetLinkParentId", e))?
                .identity
                .device
        {
            return Err(Error::Unsupported);
        }
        let bytes = size_of::<FILE_LINK_INFORMATION>()
            .max(offset_of!(FILE_LINK_INFORMATION, FileName) + leaf.len() * 2);
        self.buffer_memory = Some(self.resident.lease(bytes.next_multiple_of(8))?);
        charge(work, bytes)?;
        self.buffer = Some(vec![0; bytes.div_ceil(8)]);
        let record = self
            .buffer
            .as_mut()
            .ok_or(Error::Invalid)?
            .as_mut_ptr()
            .cast::<FILE_LINK_INFORMATION>();
        unsafe {
            (*record).Anonymous.ReplaceIfExists = false;
            // Same parent uses the old documented NULL branch; cross-parent
            // uses ONLY our actual target-only held Parent, never a pathname.
            (*record).RootDirectory = if self.members[primary_index].parent == parent as usize {
                ptr::null_mut()
            } else {
                handle(held)
            };
            (*record).FileNameLength = (leaf.len() * 2) as u32;
            ptr::copy_nonoverlapping(
                leaf.as_ptr(),
                ptr::addr_of_mut!((*record).FileName).cast::<u16>(),
                leaf.len(),
            );
        }
        check(cancel)?;
        let at = self.members.len();
        self.members.push(Member {
            group,
            parent: parent as usize,
            leaf: leaf.to_vec(),
            file: None,
            delete: None,
        });
        self.pending = true;
        let mut ios = IO_STATUS_BLOCK::default();
        let status = unsafe {
            NtSetInformationFile(
                primary_handle,
                &mut ios,
                record.cast(),
                bytes as u32,
                FileLinkInformation,
            )
        };
        self.status = Some(("targetGroupRelativeLink", status));
        if status != 0 {
            if status == COLLISION {
                self.pending = false;
                self.members.pop();
                drop(self.buffer.take());
                drop(self.buffer_memory.take());
            }
            return Err(Error::NtStatus {
                phase: "targetGroupRelativeLink",
                status,
            });
        }
        drop(self.buffer.take());
        drop(self.buffer_memory.take());
        let held = self.directories[parent as usize].owner.file()?;
        let status = open(
            held,
            leaf,
            false,
            FILE_OPEN,
            FILE_GENERIC_READ | if full { ACCESS_SYSTEM_SECURITY } else { 0 },
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            &mut self.members[at].file,
        );
        self.status = Some(("targetGroupAliasOpen", status));
        if status != 0 {
            return Err(Error::NtStatus {
                phase: "targetGroupAliasOpen",
                status,
            });
        }
        let primary = self.members[primary_index]
            .file
            .as_ref()
            .ok_or(Error::Invalid)?;
        let alias = self.members[at].file.as_ref().ok_or(Error::Invalid)?;
        let id = stamp(alias).map_err(|e| io_error("targetGroupAliasId", e))?;
        if !id.regular
            || id.identity != before.stamp.identity
            || stamp(primary)
                .map_err(|e| io_error("targetGroupPrimaryAfter", e))
                .inspect(|actual| {
                    #[cfg(test)]
                    if actual.identity != before.stamp.identity {
                        let _ = writeln!(std::io::stderr().lock(), "FARFOLD_LINK_CHANGED phase=targetGroup.primaryIdentity group={group} expected={:?} actual={actual:?}", before.stamp.identity);
                    }
                })?
                .identity
                != before.stamp.identity
        {
            #[cfg(test)]
            let _ = writeln!(std::io::stderr().lock(), "FARFOLD_LINK_CHANGED phase=targetGroup.aliasIdentityGate group={group} parent={parent} leafUnits={} expected={:?} alias={id:?}", leaf.len(), before.stamp.identity);
            return Err(Error::Changed);
        }
        // Native effect and its actual same-object read witness are now owned.
        self.pending = false;
        let after =
            Snapshot::take(primary, full, work, cancel, &self.resident).inspect_err(|error| {
                #[cfg(test)]
                Snapshot::diagnostic_error("targetGroup.after", error);
            })?;
        let alias_after =
            Snapshot::take(alias, full, work, cancel, &self.resident).inspect_err(|error| {
                #[cfg(test)]
                Snapshot::diagnostic_error("targetGroup.alias", error);
            })?;
        if !before.same_after_owned_link(&after)
            || !after.exact(&alias_after)
            || after.stamp.links != (count + 1) as u64
        {
            #[cfg(test)]
            {
                before.diagnostic_pair(&after, "targetGroup.beforeAfter");
                after.diagnostic_pair(&alias_after, "targetGroup.primaryAlias");
                let _ = writeln!(
                    std::io::stderr().lock(),
                    "FARFOLD_LINK_CHANGED phase=targetGroup.postLink group={group} parent={parent} leafUnits={} expectedLinks={} actualLinks={}",
                    leaf.len(),
                    count + 1,
                    after.stamp.links
                );
            }
            return Err(Error::Changed);
        }
        Ok(())
    }
    pub(super) fn verify(
        &self,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
    ) -> Result<Vec<GroupReceipt>> {
        self.ready()?;
        check(cancel)?;
        if work.remaining() > records::WORK_LIMIT {
            return Err(Error::Limit);
        }
        for (at, parent) in self.directories.iter().enumerate() {
            charge(work, (MAX_NODES + 3) * records::BLOCK)?;
            let entries = super::super::directory::collect_budgeted_from(
                &parent.owner,
                MAX_NODES as u64,
                cancel,
                &self.resident,
            )
            .map_err(directory_error)?;
            let dirs = self.directories.iter().filter(|n| n.ancestor == at as u32);
            let files = self.members.iter().filter(|n| n.parent == at);
            if entries.as_entries().len() != dirs.clone().count() + files.clone().count() {
                #[cfg(test)]
                let _ = writeln!(
                    std::io::stderr().lock(),
                    "FARFOLD_LINK_CHANGED phase=targetGroup.verifyListingCount parent={at} actual={} expected={}",
                    entries.as_entries().len(),
                    dirs.clone().count() + files.clone().count()
                );
                return Err(Error::Changed);
            }
            for child in dirs {
                let actual = entries
                    .as_entries()
                    .get(&child.leaf)
                    .ok_or(Error::Changed)
                    .inspect_err(|error| {
                        #[cfg(test)]
                        Snapshot::diagnostic_error("targetGroup.verifyMissingDirectory", error);
                    })?;
                let id = stamp(child.owner.file()?)
                    .map_err(|e| io_error("targetDirMemberId", e))?
                    .identity;
                if actual.identity != id
                    || actual.reparse_tag.is_some()
                    || actual.attributes & FILE_ATTRIBUTE_DIRECTORY == 0
                {
                    #[cfg(test)]
                    let _ = writeln!(
                        std::io::stderr().lock(),
                        "FARFOLD_LINK_CHANGED phase=targetGroup.verifyDirectoryEntry parent={at} leafUnits={} listedIdentity={:?} heldIdentity={id:?} attributes={} reparse={:?}",
                        child.leaf.len(),
                        actual.identity,
                        actual.attributes,
                        actual.reparse_tag
                    );
                    return Err(Error::Changed);
                }
            }
            for child in files {
                let actual = entries
                    .as_entries()
                    .get(&child.leaf)
                    .ok_or(Error::Changed)
                    .inspect_err(|error| {
                        #[cfg(test)]
                        Snapshot::diagnostic_error("targetGroup.verifyMissingFile", error);
                    })?;
                let id = stamp(child.file.as_ref().ok_or(Error::Changed)?)
                    .map_err(|e| io_error("targetFileMemberId", e))?
                    .identity;
                if actual.identity != id
                    || actual.reparse_tag.is_some()
                    || actual.attributes & FILE_ATTRIBUTE_DIRECTORY != 0
                {
                    #[cfg(test)]
                    let _ = writeln!(
                        std::io::stderr().lock(),
                        "FARFOLD_LINK_CHANGED phase=targetGroup.verifyFileEntry parent={at} leafUnits={} listedIdentity={:?} heldIdentity={id:?} attributes={} reparse={:?}",
                        child.leaf.len(),
                        actual.identity,
                        actual.attributes,
                        actual.reparse_tag
                    );
                    return Err(Error::Changed);
                }
            }
        }
        let mut result = Vec::with_capacity(self.groups.len());
        for (at, group) in self.groups.iter().enumerate() {
            let expected = Snapshot::take(
                self.members[group.primary]
                    .file
                    .as_ref()
                    .ok_or(Error::Changed)?,
                group.full,
                work,
                cancel,
                &self.resident,
            )
            .inspect_err(|error| {
                #[cfg(test)]
                Snapshot::diagnostic_error("targetGroup.verifyPrimary", error);
            })?;
            let count = self.members.iter().filter(|m| m.group == at).count();
            if expected.stamp.links != count as u64 {
                #[cfg(test)]
                let _ = writeln!(
                    std::io::stderr().lock(),
                    "FARFOLD_LINK_CHANGED phase=targetGroup.verifyLinkCount group={at} expected={count} actual={}",
                    expected.stamp.links
                );
                return Err(Error::Changed);
            }
            for member in self.members.iter().filter(|m| m.group == at) {
                let actual = Snapshot::take(
                    member.file.as_ref().ok_or(Error::Changed)?,
                    group.full,
                    work,
                    cancel,
                    &self.resident,
                )
                .inspect_err(|error| {
                    #[cfg(test)]
                    Snapshot::diagnostic_error("targetGroup.verifyMember", error);
                })?;
                if !expected.exact(&actual) {
                    #[cfg(test)]
                    expected.diagnostic_pair(&actual, "targetGroup.verifyMember");
                    return Err(Error::Changed);
                }
            }
            result.push(GroupReceipt {
                identity: expected.stamp.identity.clone(),
                links: count as u64,
                data_bytes: expected.stamp.size,
                data_sha256: expected.data_sha256,
                ea_count: expected.ea.count,
                ea_sha256: expected.ea.sha256,
                security_sha256: expected.security.sha256(),
                full_security_observed: group.full,
            });
        }
        Ok(result)
    }
    pub(super) fn cleanup(&mut self, root: &File) -> Result<()> {
        self.ready()?;
        for at in 0..self.groups.len() {
            self.cleanup_group(at)?;
        }
        let mut work = WorkBudget::new(records::WORK_LIMIT);
        for at in (0..self.directories.len()).rev() {
            let (old, current) = self.directories.split_at_mut(at);
            let ancestor = current[0].ancestor;
            let held = if ancestor == ROOT {
                root
            } else {
                old[ancestor as usize].owner.file()?
            };
            let node = &mut current[0];
            node.owner.cleanup(held, &node.leaf, &mut work)?;
        }
        Ok(())
    }
    fn cleanup_group(&mut self, group: usize) -> Result<()> {
        let primary_index = self.groups[group].primary;
        let count = self
            .members
            .iter()
            .filter(|m| m.group == group && m.file.is_some())
            .count();
        let Some(primary) = self.members[primary_index].file.as_ref() else {
            return if count == 0 {
                Ok(())
            } else {
                Err(Error::CleanupUnknown)
            };
        };
        let expected = stamp(primary).map_err(|e| io_error("targetGroupCleanupId", e))?;
        if !expected.regular || expected.links != count as u64 {
            return Err(Error::Changed);
        }
        for member in self.members.iter().filter(|m| m.group == group) {
            let file = member.file.as_ref().ok_or(Error::CleanupUnknown)?;
            let actual = stamp(file).map_err(|e| io_error("targetGroupCleanupMember", e))?;
            if !actual.regular
                || actual.identity != expected.identity
                || actual.links != expected.links
            {
                return Err(Error::Changed);
            }
        }
        let mut basic: FILE_BASIC_INFO =
            info(primary, FileBasicInfo).map_err(|e| io_error("targetGroupCleanupBasic", e))?;
        basic.FileAttributes = FILE_ATTRIBUTE_NORMAL;
        set_basic(primary, &basic)?;
        dispose(primary)?;
        close(&mut self.members[primary_index].file, &mut self.stopped)?;
        let mut left = count - 1;
        for at in 0..self.members.len() {
            if self.members[at].group != group || at == primary_index {
                continue;
            }
            let member = &mut self.members[at];
            let held = self.directories[member.parent].owner.file()?;
            // The original READ alias is the witness while this exact name is
            // non-atomically reacquired. A foreign replacement is never deleted.
            let status = open(
                held,
                &member.leaf,
                false,
                FILE_OPEN,
                FILE_READ_ATTRIBUTES | DELETE | SYNCHRONIZE,
                FILE_SHARE_READ,
                &mut member.delete,
            );
            self.status = Some(("targetGroupDeleteAlias", status));
            if status != 0 {
                return Err(Error::NtStatus {
                    phase: "targetGroupDeleteAlias",
                    status,
                });
            }
            for file in [
                member.file.as_ref().ok_or(Error::CleanupUnknown)?,
                member.delete.as_ref().ok_or(Error::CleanupUnknown)?,
            ] {
                let actual = stamp(file).map_err(|e| io_error("targetGroupDeletePair", e))?;
                if !actual.regular
                    || actual.identity != expected.identity
                    || actual.links != left as u64
                {
                    return Err(Error::Changed);
                }
            }
            dispose(member.delete.as_ref().ok_or(Error::CleanupUnknown)?)?;
            close(&mut member.delete, &mut self.stopped)?;
            close(&mut member.file, &mut self.stopped)?;
            left -= 1;
        }
        Ok(())
    }
}
#[derive(Debug)]
pub(crate) struct GroupReceipt {
    pub identity: Identity,
    pub links: u64,
    pub data_bytes: u64,
    pub data_sha256: [u8; 32],
    pub ea_count: u64,
    pub ea_sha256: [u8; 32],
    pub security_sha256: [u8; 32],
    pub full_security_observed: bool,
}
pub(crate) struct Memory(Resident);
impl Default for Memory {
    fn default() -> Self {
        Self(Resident::new(records::RESIDENT_LIMIT))
    }
}
// This is a value in the EXISTING caller Slot, not a new reservation/controller.
// Future target-tree coordinator uses Namespace.targets within its original Slot.
pub(crate) struct OwnedTargetLinks {
    namespace: Namespace,
    opened: bool,
    cleanup_error: Option<Error>,
}
impl OwnedTargetLinks {
    pub(crate) fn reserve(memory: &Memory) -> Result<Self> {
        let mut namespace = Namespace::reserve()?;
        namespace.targets = Some(State::reserve(&memory.0)?);
        Ok(Self {
            namespace,
            opened: false,
            cleanup_error: None,
        })
    }
    pub(crate) fn open(&mut self, cancel: &AtomicBool) -> Result<()> {
        check(cancel)?;
        if self.opened || self.cleanup_error.is_some() || self.namespace.cleaned {
            return Err(Error::Invalid);
        }
        self.opened = true;
        self.namespace.open_directory_namespace()
    }
    fn ready(&self) -> Result<()> {
        if !self.opened || self.cleanup_error.is_some() || self.namespace.cleaned {
            return Err(Error::CleanupUnknown);
        }
        self.namespace.verify()
    }
    pub(crate) fn create_parent(
        &mut self,
        ancestor: u32,
        leaf: &[u16],
        cancel: &AtomicBool,
    ) -> Result<u32> {
        self.ready()?;
        self.namespace
            .targets
            .as_mut()
            .ok_or(Error::Invalid)?
            .create_parent(
                self.namespace.root.as_ref().ok_or(Error::Invalid)?,
                ancestor,
                leaf,
                cancel,
            )
    }
    pub(crate) fn create_group(
        &mut self,
        parent: u32,
        leaf: &[u16],
        full: bool,
        cancel: &AtomicBool,
    ) -> Result<u32> {
        self.ready()?;
        self.namespace
            .targets
            .as_mut()
            .ok_or(Error::Invalid)?
            .create_group(parent, leaf, full, cancel)
    }
    pub(crate) fn target(&mut self, group: u32) -> Result<&mut File> {
        self.ready()?;
        self.namespace
            .targets
            .as_mut()
            .ok_or(Error::Invalid)?
            .target(group)
    }
    pub(crate) fn add(
        &mut self,
        group: u32,
        parent: u32,
        leaf: &[u16],
        work: &mut WorkBudget,
        cancel: &AtomicBool,
    ) -> Result<()> {
        self.ready()?;
        self.namespace
            .targets
            .as_mut()
            .ok_or(Error::Invalid)?
            .add(group, parent, leaf, work, cancel)
    }
    pub(crate) fn verify(
        &self,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
    ) -> Result<Vec<GroupReceipt>> {
        self.ready()?;
        self.namespace
            .targets
            .as_ref()
            .ok_or(Error::Invalid)?
            .verify(work, cancel)
    }
    pub(crate) fn last_native_status(&self) -> Option<(&'static str, i32)> {
        self.namespace.targets.as_ref().and_then(|s| s.status)
    }
    pub(crate) fn cleanup(&mut self) -> Result<()> {
        if self.cleanup_error.is_some() {
            return Err(Error::CleanupUnknown);
        }
        let result = self.namespace.cleanup();
        if let Err(error) = &result {
            self.cleanup_error = Some(error.clone());
        }
        result
    }
}
fn directory_error(error: crate::file_access::DirectoryFailure) -> Error {
    match error {
        crate::file_access::DirectoryFailure::Cancelled => Error::Cancelled,
        crate::file_access::DirectoryFailure::Limit => Error::Limit,
        crate::file_access::DirectoryFailure::Changed => Error::Changed,
        crate::file_access::DirectoryFailure::Io {
            phase,
            nt_status: Some(status),
            ..
        } => Error::NtStatus { phase, status },
        crate::file_access::DirectoryFailure::Io { phase, code, .. } => Error::Io { phase, code },
        _ => Error::Invalid,
    }
}
fn open(
    parent: &File,
    leaf: &[u16],
    directory: bool,
    disposition: u32,
    access: u32,
    share: u32,
    slot: &mut Option<File>,
) -> i32 {
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
    let mut raw = ptr::null_mut();
    let mut ios = IO_STATUS_BLOCK::default();
    let code = unsafe {
        NtCreateFile(
            &mut raw,
            access,
            &object,
            &mut ios,
            ptr::null(),
            if directory {
                FILE_ATTRIBUTE_DIRECTORY
            } else {
                FILE_ATTRIBUTE_NORMAL
            },
            share,
            disposition,
            (if directory {
                FILE_DIRECTORY_FILE
            } else {
                FILE_NON_DIRECTORY_FILE
            }) | FILE_OPEN_REPARSE_POINT
                | FILE_SYNCHRONOUS_IO_NONALERT,
            ptr::null(),
            0,
        )
    };
    if code >= 0 && !raw.is_null() && raw != INVALID_HANDLE_VALUE {
        *slot = Some(unsafe { File::from_raw_handle(raw) });
    }
    code
}
