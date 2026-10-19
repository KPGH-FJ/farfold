//! Internal owned-namespace one-alias primitive, not LINK-carrier replay.
//! No source PinnedPath, arbitrary target path, replace, rename or public gate.
use super::super::*;
use super::{Namespace, StoppedHandle, close, dispose, set_basic};
use crate::file_access::{
    ea_records::WorkBudget,
    material_carrier_records::{
        self as records, Error, Resident, ResidentLease, Result, charge, check, io_error,
    },
    material_raw_name,
};
use std::{
    io::{Read, Seek, SeekFrom},
    sync::atomic::AtomicBool,
};
use windows_sys::Wdk::Storage::FileSystem::{
    FILE_LINK_INFORMATION, FileLinkInformation, NtSetInformationFile,
};
use windows_sys::Win32::System::SystemServices::ACCESS_SYSTEM_SECURITY;
#[path = "material_link_snapshot.rs"]
mod snapshot;
use snapshot::Snapshot;

pub(crate) const WORK_LIMIT: u64 = records::WORK_LIMIT;
pub(crate) struct Memory(Resident);
impl Default for Memory {
    fn default() -> Self {
        Self(Resident::new(records::RESIDENT_LIMIT))
    }
}
const COLLISION: i32 = 0xc0000035u32 as i32;
const TARGET: &[u16] = &[
    111, 119, 110, 101, 100, 45, 108, 105, 110, 107, 45, 116, 97, 114, 103, 101, 116, 46, 98, 105,
    110,
];
pub(super) struct State {
    primary: Option<File>,
    alias: Option<File>,
    cleanup_alias: Option<File>,
    leaf: Vec<u16>,
    attempted: bool,
    pending: bool,
    status: Option<i32>,
    full_security: bool,
    stopped: Vec<StoppedHandle>,
    buffer: Option<Vec<u64>>,
    buffer_memory: Option<ResidentLease>,
    _memory: ResidentLease,
}
impl State {
    fn reserve(resident: &Resident, full: bool) -> Result<Self> {
        let memory = resident.lease(4096)?;
        Ok(Self {
            primary: None,
            alias: None,
            cleanup_alias: None,
            leaf: Vec::with_capacity(255),
            attempted: false,
            pending: false,
            status: None,
            full_security: full,
            stopped: Vec::with_capacity(3),
            buffer: None,
            buffer_memory: None,
            _memory: memory,
        })
    }
    fn create(&mut self, root: &File) -> Result<()> {
        let mut raw = ptr::null_mut();
        let code = open(
            root,
            TARGET,
            FILE_CREATE,
            FILE_GENERIC_READ
                | FILE_GENERIC_WRITE
                | DELETE
                | if self.full_security {
                    WRITE_DAC | WRITE_OWNER | ACCESS_SYSTEM_SECURITY
                } else {
                    0
                },
            // This original FileObject has DELETE for its own cleanup, but
            // denies later DELETE opens. Its original parent cannot move
            // while the same-directory link operation is in progress.
            FILE_SHARE_READ,
            &mut raw,
        );
        if code >= 0 && !raw.is_null() && raw != INVALID_HANDLE_VALUE {
            self.primary = Some(unsafe { File::from_raw_handle(raw) });
        }
        if code != 0 {
            self.pending = code >= 0;
            self.status = Some(code);
            return Err(Error::NtStatus {
                phase: "ownedLinkTargetCreate",
                status: code,
            });
        }
        if self.primary.is_none() {
            self.pending = true;
            return Err(Error::Invalid);
        }
        Ok(())
    }
    pub(super) fn cleanup(&mut self, root: &File) -> Result<()> {
        if self.pending || !self.stopped.is_empty() {
            return Err(Error::CleanupUnknown);
        }
        if let Some(primary) = self.primary.as_ref() {
            let mut basic: FILE_BASIC_INFO =
                info(primary, FileBasicInfo).map_err(|e| io_error("linkCleanupBasic", e))?;
            basic.FileAttributes = FILE_ATTRIBUTE_NORMAL;
            set_basic(primary, &basic)?;
        }
        if self.alias.is_some() {
            let primary = self.primary.as_ref().ok_or(Error::Invalid)?;
            let expected = stamp(primary).map_err(|e| io_error("linkCleanupPrimary", e))?;
            let alias = stamp(self.alias.as_ref().ok_or(Error::Invalid)?)
                .map_err(|e| io_error("linkCleanupAlias", e))?;
            if !expected.regular
                || !alias.regular
                || expected.links != 2
                || alias.links != 2
                || expected.identity != alias.identity
            {
                return Err(Error::Changed);
            }
            // The read-only alias keeps the actual object alive. Close the
            // primary's DELETE FileObject before asking for another DELETE
            // open; no sharing flag on the original namespace is widened.
            dispose(primary)?;
            close(&mut self.primary, &mut self.stopped)?;
            self.delete_verified_alias(root, &expected.identity)?;
            close(&mut self.alias, &mut self.stopped)?;
        } else {
            if let Some(primary) = self.primary.as_ref() {
                dispose(primary)?;
            }
            close(&mut self.primary, &mut self.stopped)?;
        }
        Ok(())
    }
    fn delete_verified_alias(&mut self, root: &File, expected: &Identity) -> Result<()> {
        // This is a non-atomic name reacquisition, not immutable authority.
        // Capture its actual handle before any fallible status/identity check.
        // A replacement is never disposed. On failure the original READ alias,
        // any returned DELETE handle and the namespace stay in the same owner.
        let mut raw = ptr::null_mut();
        let code = open(
            root,
            &self.leaf,
            FILE_OPEN,
            FILE_READ_ATTRIBUTES | DELETE | SYNCHRONIZE,
            FILE_SHARE_READ,
            &mut raw,
        );
        if code >= 0 && !raw.is_null() && raw != INVALID_HANDLE_VALUE {
            self.cleanup_alias = Some(unsafe { File::from_raw_handle(raw) });
        }
        if code != 0 {
            return Err(Error::NtStatus {
                phase: "ownedLinkCleanupAliasOpen",
                status: code,
            });
        }
        let actual = self.cleanup_alias.as_ref().ok_or(Error::Invalid)?;
        for file in [actual, self.alias.as_ref().ok_or(Error::Invalid)?] {
            let value = stamp(file).map_err(|e| io_error("linkCleanupAliasVerify", e))?;
            if !value.regular || &value.identity != expected || value.links != 1 {
                return Err(Error::Changed);
            }
        }
        dispose(actual)?;
        close(&mut self.cleanup_alias, &mut self.stopped)
    }
}
// A non-Clone value containing the existing namespace. Caller must reserve its
// existing Slot BEFORE open and retire this exact value if cleanup is unknown.
// There is no new slot/controller or detached cleanup worker in this module.
pub(crate) struct OwnedLinks {
    namespace: Namespace,
    resident: Resident,
    operation_error: Option<Error>,
    opened: bool,
    ready: bool,
    cleanup_error: Option<Error>,
    _memory: ResidentLease,
}
#[derive(Debug)]
pub(crate) struct Receipt {
    pub identity: Identity,
    pub alias_identity: Identity,
    pub links: u64,
    pub data_bytes: u64,
    pub data_sha256: [u8; 32],
    pub ea_count: u64,
    pub ea_sha256: [u8; 32],
    pub before_ea_sha256: [u8; 32],
    pub before_security_sha256: [u8; 32],
    pub security_sha256: [u8; 32],
    pub full_security_observed: bool,
}
impl OwnedLinks {
    pub(crate) fn reserve(memory: &Memory) -> Result<Self> {
        let resident = &memory.0;
        let memory = resident.lease(4 * records::BLOCK)?;
        Ok(Self {
            namespace: Namespace::reserve()?,
            resident: resident.clone(),
            operation_error: None,
            opened: false,
            ready: false,
            cleanup_error: None,
            _memory: memory,
        })
    }
    pub(crate) fn open(&mut self, full: bool, cancel: &AtomicBool) -> Result<()> {
        let result = (|| {
            check(cancel)?;
            if self.opened || self.namespace.cleaned {
                return Err(Error::Invalid);
            }
            self.opened = true;
            self.namespace.open()?;
            self.namespace.verify()?;
            // Install before the first target-create call, not after success.
            self.namespace.links = Some(State::reserve(&self.resident, full)?);
            let root = self.namespace.root.as_ref().ok_or(Error::Invalid)?;
            self.namespace
                .links
                .as_mut()
                .ok_or(Error::Invalid)?
                .create(root)?;
            self.namespace.verify()?;
            check(cancel)
        })();
        if result.is_ok() {
            self.ready = true;
        }
        if self.operation_error.is_none()
            && let Err(e) = &result
        {
            self.operation_error = Some(e.clone());
        }
        result
    }
    pub(crate) fn record_failure(&mut self, error: Error) {
        if self.operation_error.is_none() {
            self.operation_error = Some(error);
        }
    }
    pub(crate) fn last_native_status(&self) -> Option<i32> {
        self.namespace.links.as_ref().and_then(|s| s.status)
    }
    pub(crate) fn target(&mut self) -> Result<&mut File> {
        if !self.ready
            || self.namespace.cleaned
            || self.cleanup_error.is_some()
            || self.namespace.links.as_ref().is_some_and(|s| s.pending)
        {
            return Err(Error::CleanupUnknown);
        }
        self.namespace
            .links
            .as_mut()
            .and_then(|s| s.primary.as_mut())
            .ok_or(Error::Invalid)
    }
    pub(crate) fn add(
        &mut self,
        leaf: &[u16],
        work: &mut WorkBudget,
        cancel: &AtomicBool,
    ) -> Result<Receipt> {
        let result = self.add_inner(leaf, work, cancel);
        if self.operation_error.is_none()
            && let Err(e) = &result
        {
            self.operation_error = Some(e.clone());
        }
        result
    }
    fn add_inner(
        &mut self,
        leaf: &[u16],
        work: &mut WorkBudget,
        cancel: &AtomicBool,
    ) -> Result<Receipt> {
        if !self.ready || self.namespace.cleaned || self.cleanup_error.is_some() {
            return Err(Error::CleanupUnknown);
        }
        if work.remaining() > WORK_LIMIT {
            return Err(Error::Limit);
        }
        material_raw_name::check(leaf).map_err(|_| Error::Invalid)?;
        check(cancel)?;
        self.namespace.verify()?;
        let root = self.namespace.root.as_ref().ok_or(Error::Invalid)?;
        let root_id = stamp(root)
            .map_err(|e| io_error("linkRootStamp", e))?
            .identity;
        let state = self.namespace.links.as_mut().ok_or(Error::Invalid)?;
        if state.attempted || state.pending || !state.stopped.is_empty() {
            return Err(Error::Invalid);
        }
        let primary = state.primary.as_ref().ok_or(Error::Invalid)?;
        let before = Snapshot::take(primary, state.full_security, work, cancel, &self.resident)?;
        if before.stamp.links != 1 || before.stamp.identity.device != root_id.device {
            return Err(Error::Unsupported);
        }
        let bytes = size_of::<FILE_LINK_INFORMATION>()
            .max(offset_of!(FILE_LINK_INFORMATION, FileName) + leaf.len() * 2);
        state.buffer_memory = Some(self.resident.lease(bytes.next_multiple_of(8))?);
        // Input bytes share the original completed-work budget before mutation.
        charge(work, bytes)?;
        state.buffer = Some(vec![0u64; bytes.div_ceil(8)]);
        let record = state
            .buffer
            .as_mut()
            .ok_or(Error::Invalid)?
            .as_mut_ptr()
            .cast::<FILE_LINK_INFORMATION>();
        unsafe {
            (*record).Anonymous.ReplaceIfExists = false;
            // A checked single leaf beside this original, DELETE-denying
            // FileObject: use the documented same-parent branch. Passing
            // our share=0 root would force an incompatible directory open.
            (*record).RootDirectory = ptr::null_mut();
            (*record).FileNameLength = (leaf.len() * 2) as u32;
            ptr::copy_nonoverlapping(
                leaf.as_ptr(),
                ptr::addr_of_mut!((*record).FileName).cast::<u16>(),
                leaf.len(),
            );
        }
        check(cancel)?;
        // Exact name and uncertain effect are owned BEFORE calling the kernel.
        state.leaf.extend_from_slice(leaf);
        state.attempted = true;
        state.pending = true;
        let mut ios = IO_STATUS_BLOCK::default();
        let code = unsafe {
            NtSetInformationFile(
                handle(primary),
                &mut ios,
                record.cast(),
                bytes as u32,
                FileLinkInformation,
            )
        };
        state.status = Some(code);
        if code != 0 {
            // Exact collision with Replace=false is a known non-creation.
            // All other outcomes retain this owner; no retry/fallback/probe.
            if code == COLLISION {
                state.pending = false;
                drop(state.buffer.take());
                drop(state.buffer_memory.take());
            }
            return Err(Error::NtStatus {
                phase: "ownedRelativeLink",
                status: code,
            });
        }
        drop(state.buffer.take());
        drop(state.buffer_memory.take());
        // Hold the actual alias without requesting DELETE: the primary
        // still denies any new DELETE opens and therefore cannot move.
        let mut raw = ptr::null_mut();
        let access = FILE_GENERIC_READ
            | if state.full_security {
                ACCESS_SYSTEM_SECURITY
            } else {
                0
            };
        let code = open(
            root,
            leaf,
            FILE_OPEN,
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            &mut raw,
        );
        if code >= 0 && !raw.is_null() && raw != INVALID_HANDLE_VALUE {
            state.alias = Some(unsafe { File::from_raw_handle(raw) });
        }
        if code != 0 {
            return Err(Error::NtStatus {
                phase: "ownedLinkAliasOpen",
                status: code,
            });
        }
        let alias = state.alias.as_ref().ok_or(Error::Invalid)?;
        if stamp(alias)
            .map_err(|e| io_error("linkAliasIdentity", e))?
            .identity
            != before.stamp.identity
            || stamp(primary)
                .map_err(|e| io_error("linkPrimaryIdentity", e))?
                .identity
                != before.stamp.identity
        {
            return Err(Error::Changed);
        }
        // Both handles now prove the new name denotes only our created object.
        // Cancellation/verification failure may safely dispose these exact links.
        state.pending = false;
        let after = Snapshot::take(primary, state.full_security, work, cancel, &self.resident)?;
        let alias_after = Snapshot::take(alias, state.full_security, work, cancel, &self.resident)?;
        if !before.same_link_payload(&after) || !after.exact(&alias_after) || after.stamp.links != 2
        {
            return Err(Error::Changed);
        }
        let receipt = Receipt {
            identity: before.stamp.identity.clone(),
            alias_identity: alias_after.stamp.identity.clone(),
            links: after.stamp.links,
            data_bytes: after.stamp.size,
            data_sha256: after.data_sha256,
            ea_count: after.ea.count,
            ea_sha256: after.ea.sha256,
            security_sha256: after.security.sha256(),
            before_ea_sha256: before.ea.sha256,
            before_security_sha256: before.security.sha256(),
            full_security_observed: state.full_security,
        };
        self.namespace.verify()?;
        check(cancel)?;
        Ok(receipt)
    }
    pub(crate) fn cleanup(&mut self) -> Result<()> {
        if self.cleanup_error.is_some() {
            return Err(Error::CleanupUnknown);
        }
        let result = self.namespace.cleanup();
        if let Err(e) = &result {
            self.cleanup_error = Some(e.clone());
        }
        result
    }
}
fn open(
    root: &File,
    leaf: &[u16],
    disposition: u32,
    access: u32,
    share: u32,
    raw: &mut HANDLE,
) -> i32 {
    // Only fixed owned target or a previously checked material counted leaf.
    let unicode = UNICODE_STRING {
        Length: (leaf.len() * 2) as u16,
        MaximumLength: (leaf.len() * 2) as u16,
        Buffer: leaf.as_ptr().cast_mut(),
    };
    let object = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: handle(root),
        ObjectName: &unicode,
        Attributes: OBJ_CASE_INSENSITIVE,
        ..Default::default()
    };
    let mut ios = IO_STATUS_BLOCK::default();
    unsafe {
        NtCreateFile(
            raw,
            access,
            &object,
            &mut ios,
            ptr::null(),
            FILE_ATTRIBUTE_NORMAL,
            share,
            disposition,
            FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
            ptr::null(),
            0,
        )
    }
}
