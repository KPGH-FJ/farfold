//! Actual fixed material.bin retention, independent reopen, original Slot only.
//! The unique Manifest binds its descriptor; a separate held target request admits restoration.
use super::*;
use super::{
    material_mixed_tree_input::with_mixed_tree_input,
    material_mixed_tree_input::{
        MixedBytes, MixedInput, MixedMemory, MixedRequest, MixedRetirement,
    },
};
use crate::file_access::{
    ea_records::WorkBudget,
    material_carrier_records::{
        self as records, Error, Resident, ResidentLease, Result, charge, check, io_error,
    },
    material_mixed_tree_records as tree,
};
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::io::{SeekFrom, Write};
use std::{ffi::OsString, mem::size_of_val, os::windows::ffi::OsStringExt};
use std::{
    io::{Read, Seek},
    os::windows::io::IntoRawHandle,
    panic::AssertUnwindSafe,
    sync::atomic::AtomicBool,
};
use windows_sys::Win32::Foundation::CloseHandle;

#[path = "material_persistent_restore.rs"]
mod restore;
pub(crate) use restore::MaterialTreeReceipt;
#[path = "material_persistent_reopen.rs"]
mod reopen;
pub(crate) use reopen::with_reopened_material;
#[path = "material_persistent_target.rs"]
mod target;
pub(crate) use target::MaterialTargetRequest;

const PENDING: &[u16] = &[
    46, 109, 97, 116, 101, 114, 105, 97, 108, 45, 112, 101, 110, 100, 105, 110, 103,
];
const FINAL: &[u16] = &[109, 97, 116, 101, 114, 105, 97, 108, 46, 98, 105, 110];
// The constructor is called only with the original reserved operation directory
// and the persisted native identities already verified by the rpack composer.
pub(crate) struct MaterialStoreRequest {
    parent: PinnedPath,
    root: PinnedPath,
    resident: Resident,
    _memory: ResidentLease,
}
impl MaterialStoreRequest {
    pub(crate) fn reserved(
        parent: &Path,
        root: &Path,
        parent_id: &Identity,
        root_id: &Identity,
        memory: &MixedMemory,
    ) -> Result<Self> {
        if root.as_os_str().len() > 4096
            || parent.as_os_str().len() > 4096
            || root.parent() != Some(parent)
            || parent_id == root_id
            || root_id.inode == 0
        {
            return Err(Error::Invalid);
        }
        let resident = memory.shared();
        // Reserve before these additional PinnedPath buffers/ancestor vectors.
        let reserved = resident.lease(8 * records::BLOCK)?;
        let parent = PinnedPath::directory(parent).map_err(|e| io_error("materialParent", e))?;
        let leaf = root
            .file_name()
            .ok_or(Error::Invalid)?
            .encode_wide()
            .collect::<Vec<_>>();
        let root = parent
            .child(&leaf, true)
            .map_err(|e| io_error("materialRoot", e))?;
        if parent.identity() != parent_id
            || root.identity() != root_id
            || root.guid_path.parent() != Some(parent.guid_path.as_path())
        {
            return Err(Error::Changed);
        }
        let value = Self {
            parent,
            root,
            resident,
            _memory: reserved,
        };
        value.verify()?;
        Ok(value)
    }
    fn verify(&self) -> Result<()> {
        self.parent
            .verify()
            .map_err(|e| io_error("materialParentVerify", e))?;
        self.root
            .verify()
            .map_err(|e| io_error("materialRootVerify", e))?;
        if self.root.guid_path.parent() != Some(self.parent.guid_path.as_path()) {
            return Err(Error::Changed);
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MaterialSealReceipt {
    pub identity: Identity,
    pub stamp: Stamp,
    pub bytes: u64,
    pub sha256: [u8; 32],
    pub tree_sha256: [u8; 32],
    pub nodes: usize,
    pub directories: usize,
    pub regulars: usize,
}
struct Store {
    file: Option<File>,
    stopped: Option<(usize, Option<i32>)>,
    uncertain: bool,
    mixed: Option<MixedRetirement>,
    verified: Option<tree::Verified>,
    copied: Option<MixedBytes>,
    published: bool,
    reading: bool,
    sealed_stamp: Option<Stamp>,
    restore: Option<restore::Restore>,
    request: MaterialStoreRequest,
}
pub(crate) struct MaterialStoreRetirement {
    _store: Box<Store>,
    _operation_error: Option<Error>,
    _cleanup_error: Error,
}
fn same(a: &[u16], b: &[u16]) -> Result<bool> {
    match unsafe { CompareStringOrdinal(a.as_ptr(), a.len() as i32, b.as_ptr(), b.len() as i32, 1) }
    {
        0 => Err(io_error("sealedNameCompare", io::Error::last_os_error())),
        n => Ok(n == CSTR_EQUAL),
    }
}
impl Store {
    fn open(&mut self, create: bool) -> Result<()> {
        if self.file.is_some() || self.stopped.is_some() || create == self.published {
            return Err(Error::Invalid);
        }
        self.request.verify()?;
        self.reading = !create;
        let leaf = if create { PENDING } else { FINAL };
        let unicode = UNICODE_STRING {
            Length: (leaf.len() * 2) as u16,
            MaximumLength: (leaf.len() * 2) as u16,
            Buffer: leaf.as_ptr().cast_mut(),
        };
        let object = OBJECT_ATTRIBUTES {
            Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: handle(self.request.root.file()),
            ObjectName: &unicode,
            Attributes: OBJ_CASE_INSENSITIVE,
            ..Default::default()
        };
        let mut raw = ptr::null_mut();
        let mut ios = IO_STATUS_BLOCK::default();
        let status = unsafe {
            NtCreateFile(
                &mut raw,
                FILE_GENERIC_READ
                    | if create {
                        FILE_GENERIC_WRITE | DELETE
                    } else {
                        0
                    },
                &object,
                &mut ios,
                ptr::null(),
                FILE_ATTRIBUTE_NORMAL,
                if create { 0 } else { FILE_SHARE_READ },
                if create { FILE_CREATE } else { FILE_OPEN },
                FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
                ptr::null(),
                0,
            )
        };
        // Install the actual owner before any fallible query. Nonzero success
        // status is not treated as a fresh known creation or normal open.
        if status >= 0 && !raw.is_null() && raw != INVALID_HANDLE_VALUE {
            self.file = Some(unsafe { File::from_raw_handle(raw) });
        }
        if status != 0 {
            self.uncertain = status >= 0;
            return Err(Error::NtStatus {
                phase: "materialOpen",
                status,
            });
        }
        if self.file.is_none() {
            self.uncertain = true;
            return Err(Error::Invalid);
        }
        let file = self.file.as_ref().ok_or(Error::Invalid)?;
        let actual = stamp(file).map_err(|e| io_error("materialStamp", e))?;
        if !actual.regular
            || actual.links != 1
            || actual.identity.inode == 0
            || actual.identity.device != self.request.root.identity().device
        {
            return Err(Error::Unsupported);
        }
        // Fixed destination leaf has ordinary Unicode spelling; user raw names
        // live only in carrier bytes, never in this destination path API.
        let guid = super::pinned::local_guid(file).map_err(|e| io_error("materialLocal", e))?;
        let expected = self.request.root.guid_path.join(OsString::from_wide(leaf));
        if guid != expected {
            return Err(Error::Changed);
        }
        self.request.verify()
    }
    fn close(&mut self) -> Result<()> {
        if self.stopped.is_some() {
            return Err(Error::CleanupUnknown);
        }
        if let Some(file) = self.file.take() {
            let raw = file.into_raw_handle();
            if unsafe { CloseHandle(raw) } == 0 {
                let code = io::Error::last_os_error().raw_os_error();
                self.stopped = Some((raw as usize, code));
                return Err(Error::Io {
                    phase: "materialClose",
                    code,
                });
            }
        }
        Ok(())
    }
    fn cleanup_all(&mut self) -> Result<()> {
        self.restore
            .as_mut()
            .map_or(Ok(()), restore::Restore::cleanup)
            .and_then(|()| self.dispose_pending())
    }
    fn dispose_pending(&mut self) -> Result<()> {
        if self.stopped.is_some() || self.uncertain {
            return Err(Error::CleanupUnknown);
        }
        if !self.published
            && let Some(file) = self.file.as_ref()
        {
            let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
            if unsafe {
                SetFileInformationByHandle(
                    handle(file),
                    FileDispositionInfo,
                    (&disposition as *const FILE_DISPOSITION_INFO).cast(),
                    size_of::<FILE_DISPOSITION_INFO>() as u32,
                )
            } == 0
            {
                return Err(io_error("materialDiscard", io::Error::last_os_error()));
            }
        }
        self.close()
    }
    fn publish(&mut self) -> Result<()> {
        if self.published || self.stopped.is_some() {
            return Err(Error::Invalid);
        }
        self.request.verify()?;
        let count = size_of::<FILE_RENAME_INFORMATION>() + FINAL.len() * 2;
        let mut storage = [0usize; 16];
        if count > size_of_val(&storage) {
            return Err(Error::Limit);
        }
        let rename = storage.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
        unsafe {
            (*rename).RootDirectory = handle(self.request.root.file());
            (*rename).FileNameLength = (FINAL.len() * 2) as u32;
            ptr::copy_nonoverlapping(FINAL.as_ptr(), (*rename).FileName.as_mut_ptr(), FINAL.len());
        }
        let mut ios = IO_STATUS_BLOCK::default();
        let file = self.file.as_ref().ok_or(Error::Invalid)?;
        let code = unsafe {
            NtSetInformationFile(
                handle(file),
                &mut ios,
                rename.cast(),
                count as u32,
                FileRenameInformation,
            )
        };
        if code != 0 {
            self.uncertain = code >= 0;
            return Err(Error::NtStatus {
                phase: "materialPublish",
                status: code,
            });
        }
        // Irrevocable local ownership transfer: no later cleanup deletes FINAL.
        self.published = true;
        file.sync_all()
            .map_err(|e| io_error("materialPublishedSync", e))?;
        self.request.verify()
    }
    fn verify(
        &mut self,
        work: &mut WorkBudget,
        cancel: &AtomicBool,
    ) -> Result<MaterialSealReceipt> {
        check(cancel)?;
        self.request.verify()?;
        let expected = self.copied.as_ref().ok_or(Error::Invalid)?;
        let mut file = self.file.as_ref().ok_or(Error::Invalid)?;
        let before = stamp(file).map_err(|e| io_error("materialVerifyStamp", e))?;
        if !before.regular
            || before.links != 1
            || before.size != expected.summary.carrier_bytes
            || self
                .sealed_stamp
                .as_ref()
                .is_some_and(|value| value != &before)
        {
            return Err(Error::Changed);
        }
        file.rewind()
            .map_err(|e| io_error("materialVerifySeek", e))?;
        let verified = tree::verify_exact(&mut file, work, cancel, &self.request.resident, same)?;
        if let Some(catalog) = expected.native_catalog.as_ref()
            && (catalog.len() != verified.nodes.len()
                || catalog
                    .iter()
                    .zip(&verified.nodes)
                    .any(|(p, n)| !p.matches(n)))
        {
            return Err(Error::Changed);
        }
        if crate::file_access::material_mixed_semantic::summarize(
            &verified.nodes,
            expected.content.nodes as usize,
            |index| {
                expected
                    .native_catalog
                    .as_ref()
                    .map_or(verified.nodes[index].native_sha256, |catalog| {
                        catalog[index].semantic_sha256
                    })
            },
            work,
            cancel,
        )? != expected.content
        {
            return Err(Error::Changed);
        }
        let directories = verified
            .nodes
            .iter()
            .filter(|v| v.kind == tree::Kind::Directory)
            .count();
        if verified.bytes != before.size
            || verified.sha256 != expected.summary.carrier_sha256
            || verified.nodes.len() != expected.summary.nodes
            || directories != expected.summary.directories
            || verified.nodes.len() - directories != expected.summary.regulars
        {
            return Err(Error::Changed);
        }
        let _memory = self.request.resident.lease(2 * records::BLOCK)?;
        let mut buffer = vec![0u8; records::BLOCK];
        file.rewind().map_err(|e| io_error("materialHashSeek", e))?;
        let mut hash = Sha256::new();
        let mut count = 0u64;
        loop {
            check(cancel)?;
            let offer = (before.size - count)
                .saturating_add(1)
                .min(buffer.len() as u64)
                .min(work.remaining()) as usize;
            if offer == 0 {
                return Err(Error::Limit);
            }
            let n = file
                .read(&mut buffer[..offer])
                .map_err(|e| io_error("materialHashRead", e))?;
            charge(work, n)?;
            if n == 0 {
                break;
            }
            count = count.checked_add(n as u64).ok_or(Error::Limit)?;
            if count > before.size {
                return Err(Error::Changed);
            }
            hash.update(&buffer[..n]);
        }
        let hash: [u8; 32] = hash.finalize().into();
        if count != before.size
            || hash != expected.whole_sha256
            || stamp(file).map_err(|e| io_error("materialVerifyAfter", e))? != before
        {
            return Err(Error::Changed);
        }
        self.request.verify()?;
        self.verified = Some(verified);
        if self.reading && self.sealed_stamp.is_none() {
            self.sealed_stamp = Some(before.clone());
        }
        Ok(MaterialSealReceipt {
            identity: before.identity.clone(),
            stamp: before,
            bytes: count,
            sha256: hash,
            tree_sha256: expected.summary.carrier_sha256,
            nodes: expected.summary.nodes,
            directories: expected.summary.directories,
            regulars: expected.summary.regulars,
        })
    }
}
// The held FileObject capability cannot escape this callback. Copied payloads
// remain the trusted consumer's responsibility and must reserve the shared pool.
pub(crate) struct OwnedSealedMaterial<'a> {
    store: &'a mut Store,
    work: &'a mut WorkBudget,
    cancel: &'a AtomicBool,
}
impl OwnedSealedMaterial<'_> {
    pub(crate) fn descriptor(&mut self) -> Result<crate::worktrees::WindowsMaterial> {
        let receipt = self.verify()?;
        let catalog = self
            .store
            .copied
            .as_ref()
            .and_then(|v| v.native_catalog.as_ref())
            .ok_or(Error::Unsupported)?;
        let value = crate::worktrees::WindowsMaterial {
            version: if catalog
                .first()
                .is_some_and(|p| p.ordinary_security.is_some())
            {
                2
            } else {
                1
            },
            volume: receipt.identity.device,
            file_id: receipt.identity.inode.to_le_bytes(),
            bytes: receipt.bytes,
            sha256: receipt.sha256,
            tree_sha256: receipt.tree_sha256,
            content: self
                .store
                .copied
                .as_ref()
                .ok_or(Error::Invalid)?
                .content
                .clone(),
            nodes: catalog
                .iter()
                .map(super::material_mixed_tree_input::NativeProof::descriptor)
                .collect(),
        };
        if !value.validate() {
            return Err(Error::Invalid);
        }
        Ok(value)
    }
    pub(crate) fn reconstruct_tree(&mut self) -> Result<MaterialTreeReceipt> {
        restore::rebuild(self.store, None, self.work, self.cancel)
    }
    pub(crate) fn reconstruct_target(
        &mut self,
        target: MaterialTargetRequest,
    ) -> Result<MaterialTreeReceipt> {
        restore::rebuild(self.store, Some(target), self.work, self.cancel)
    }
    pub(crate) fn verify(&mut self) -> Result<MaterialSealReceipt> {
        self.store.verify(self.work, self.cancel)
    }
    #[cfg(test)]
    pub(crate) fn reserve_output(
        &self,
        bytes: usize,
    ) -> Result<super::material_mixed_tree_input::MixedOutputLease> {
        super::material_mixed_tree_input::MixedOutputLease::reserve(
            &self.store.request.resident,
            bytes,
        )
    }
    #[cfg(test)]
    pub(crate) fn copy_node<W: Write>(&mut self, index: usize, out: &mut W) -> Result<[u8; 32]> {
        self.verify()?;
        let node = self
            .store
            .verified
            .as_ref()
            .and_then(|v| v.nodes.get(index))
            .ok_or(Error::Invalid)?;
        let (start, length) = (node.typed_start, node.typed_bytes);
        let _memory = self.store.request.resident.lease(2 * records::BLOCK)?;
        let mut buffer = vec![0u8; records::BLOCK];
        let mut file = self.store.file.as_ref().ok_or(Error::Invalid)?;
        let before = stamp(file).map_err(|e| io_error("sealedCopyBefore", e))?;
        file.seek(SeekFrom::Start(start))
            .map_err(|e| io_error("sealedCopySeek", e))?;
        let mut left = length;
        let mut hash = Sha256::new();
        while left != 0 {
            check(self.cancel)?;
            let offer = left
                .min(records::BLOCK as u64)
                .min(self.work.remaining() / 2) as usize;
            if offer == 0 {
                return Err(Error::Limit);
            }
            charge(self.work, offer * 2)?;
            file.read_exact(&mut buffer[..offer])
                .map_err(|e| io_error("sealedCopyRead", e))?;
            out.write_all(&buffer[..offer])
                .map_err(|e| io_error("sealedCopyWrite", e))?;
            hash.update(&buffer[..offer]);
            left -= offer as u64;
        }
        if stamp(file).map_err(|e| io_error("sealedCopyAfter", e))? != before {
            return Err(Error::Changed);
        }
        self.store.request.verify()?;
        Ok(hash.finalize().into())
    }
}
pub(crate) fn with_sealed_material<T, F>(
    source: MixedRequest,
    mut destination: MaterialStoreRequest,
    work: &mut WorkBudget,
    cancel: &AtomicBool,
    retired: &mut Option<MaterialStoreRetirement>,
    consume: F,
) -> Result<(T, MaterialSealReceipt)>
where
    F: for<'a> FnOnce(&mut OwnedSealedMaterial<'a>) -> Result<T>,
{
    if retired.is_some() {
        return Err(Error::CleanupUnknown);
    }
    source.require_pool(&mut destination._memory)?;
    let source = source.for_material_store();
    // Allocate this finite owner before any native capture/context. Retirement
    // only moves its Box; it never allocates another large enum payload.
    let mut store = Box::new(Store {
        file: None,
        stopped: None,
        uncertain: false,
        mixed: None,
        verified: None,
        copied: None,
        published: false,
        reading: false,
        sealed_stamp: None,
        restore: None,
        request: destination,
    });
    let mut mixed_retirement = None;
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        with_mixed_tree_input(
            source,
            work,
            cancel,
            &mut mixed_retirement,
            |mut input: MixedInput<'_>| {
                // Only the typed prepared Git suffix can contribute root .git.
                // User material may never smuggle an administrative name into it.
                for (index, node) in input.verified.nodes.iter().enumerate() {
                    if node.parent == 0
                        && same(&node.metadata.raw_leaf, &[46, 103, 105, 116])?
                        && index != input.user_nodes
                    {
                        return Err(Error::Unsupported);
                    }
                    let id = Identity {
                        device: node.metadata.source_volume,
                        inode: node.metadata.source_id,
                    };
                    if store.request.root.has_ancestor(&id)
                        || store.request.parent.identity() == &id
                    {
                        return Err(Error::Changed);
                    }
                }
                store.open(true)?;
                let copied = input.copy_tree(store.file.as_mut().ok_or(Error::Invalid)?)?;
                store
                    .file
                    .as_ref()
                    .ok_or(Error::Invalid)?
                    .sync_all()
                    .map_err(|e| io_error("materialPendingSync", e))?;
                store.copied = Some(copied);
                store.verify(&mut *input.work, input.cancel)?;
                Ok(())
            },
        )?;
        // Original source Facts/topology fence and original native context/scratch
        // cleanup have completed. No source reference is needed from here on.
        check(cancel)?;
        let before = stamp(store.file.as_ref().ok_or(Error::Invalid)?)
            .map_err(|e| io_error("materialBeforePublish", e))?;
        store.publish()?;
        let committed = stamp(store.file.as_ref().ok_or(Error::Invalid)?)
            .map_err(|e| io_error("materialPublishedStamp", e))?;
        if committed.identity != before.identity || committed.size != before.size {
            return Err(Error::Changed);
        }
        store.close()?;
        store.open(false)?;
        let actual = store.verify(work, cancel)?;
        if actual.identity != committed.identity {
            return Err(Error::Changed);
        }
        let value = consume(&mut OwnedSealedMaterial {
            store: &mut store,
            work,
            cancel,
        })?;
        if store.verify(work, cancel)? != actual {
            return Err(Error::Changed);
        }
        // Target cleanup must complete before the original sealed owner closes.
        Ok((value, actual))
    }))
    .unwrap_or(Err(Error::Unsupported));
    store.mixed = mixed_retirement;
    let cleanup = store.cleanup_all();
    if let Err(cleanup_error) = cleanup {
        *retired = Some(MaterialStoreRetirement {
            _store: store,
            _operation_error: result.err(),
            _cleanup_error: cleanup_error,
        });
        return Err(Error::CleanupUnknown);
    }
    if store.mixed.is_some() {
        *retired = Some(MaterialStoreRetirement {
            _store: store,
            _operation_error: result.err(),
            _cleanup_error: Error::CleanupUnknown,
        });
        return Err(Error::CleanupUnknown);
    }
    result
}

#[cfg(test)]
#[path = "material_persistent_store_tests.rs"]
mod tests;
