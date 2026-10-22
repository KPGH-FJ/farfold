//! A transient comparison baseline after the original read owner retires.
//! These values alone never grant deletion; a later DELETE-purpose owner must
//! prove the exact actual objects, default bytes, namespace and extra material.
use super::*;
use crate::file_access::{EntryMetadata, metadata_file};
use std::{fs::File, path::PathBuf};

pub(in crate::worktrees) struct FrozenNode {
    pub relative: PathBuf,
    pub before: Stamp,
    pub metadata: EntryMetadata,
    pub sha256: Option<[u8; 32]>,
    pub children: Option<DirectoryEntries>,
}
pub(in crate::worktrees) struct FrozenSource {
    pub common: Arc<super::super::super::windows_git::RemovalContext>,
    pub snapshot: Snapshot,
    pub root: FrozenNode,
    pub pointer: FrozenNode,
    pub private: Vec<FrozenNode>,
    pub roots: Roots,
    pub objects: Vec<String>,
    pub configs: Vec<String>,
    pub attributes: Vec<u8>,
}
pub(in crate::worktrees) fn hash_file(
    file: &File,
    expected: &Stamp,
    used: &mut u64,
    cancel: &AtomicBool,
) -> Result<[u8; 32]> {
    if !expected.regular || expected.links != 1 {
        return Err(error("unsupportedMaterial"));
    }
    *used = used
        .checked_add(expected.size)
        .filter(|v| *v <= MAX_BYTES)
        .ok_or(error("recoveryLimit"))?;
    let mut reader = file.try_clone().map_err(|_| error("unavailable"))?;
    reader.rewind().map_err(|_| error("unavailable"))?;
    let mut remaining = expected.size;
    let mut buffer = [0_u8; 64 * 1024];
    let mut hash = Sha256::new();
    while remaining != 0 {
        cancelled(cancel)?;
        let count = usize::try_from(remaining.min(buffer.len() as u64))
            .map_err(|_| error("recoveryLimit"))?;
        let read = reader
            .read(&mut buffer[..count])
            .map_err(|_| error("unavailable"))?;
        if read == 0 {
            return Err(error("recoveryChanged"));
        }
        hash.update(&buffer[..read]);
        remaining -= read as u64;
    }
    if reader
        .read(&mut buffer[..1])
        .map_err(|_| error("unavailable"))?
        != 0
        || stamp(file).map_err(|_| error("recoveryChanged"))? != *expected
    {
        return Err(error("recoveryChanged"));
    }
    cancelled(cancel)?;
    Ok(hash.finalize().into())
}
fn node(
    pin: &PinnedPath,
    relative: PathBuf,
    children: Option<DirectoryEntries>,
    used: &mut u64,
    cancel: &AtomicBool,
) -> Result<FrozenNode> {
    pin.verify().map_err(|_| error("recoveryChanged"))?;
    let before = stamp(pin.file()).map_err(|_| error("recoveryChanged"))?;
    let metadata = metadata_file(pin.file()).map_err(|_| error("recoveryChanged"))?;
    if before.links != 1 || before.regular == children.is_some() {
        return Err(error("unsupportedMaterial"));
    }
    let sha256 = before
        .regular
        .then(|| hash_file(pin.file(), &before, used, cancel))
        .transpose()?;
    if metadata_file(pin.file()).map_err(|_| error("recoveryChanged"))? != metadata {
        return Err(error("recoveryChanged"));
    }
    Ok(FrozenNode {
        relative,
        before,
        metadata,
        sha256,
        children,
    })
}
impl SourceGraph {
    pub(in crate::worktrees) fn freeze_for_remove(
        self,
        cancel: &AtomicBool,
    ) -> Result<FrozenSource> {
        self.require_clean_index(cancel)?;
        let (configs, attributes) = self.checkout_profile(cancel)?;
        let source = &self.owner.source.scope;
        if source.root.identity() == source.git.identity()
            || source.git.identity() == source.common.identity()
        {
            return Err(error("unsupportedGit"));
        }
        let mut used = 0;
        let root_children =
            directory_entries(&source.root, 100_000, cancel).map_err(directory_error)?;
        let root = node(
            &source.root,
            PathBuf::new(),
            Some(root_children),
            &mut used,
            cancel,
        )?;
        let pointer_pin = source
            .root
            .child(&[46, 103, 105, 116], false)
            .map_err(|_| error("recoveryChanged"))?;
        let pointer = node(&pointer_pin, PathBuf::from(".git"), None, &mut used, cancel)?;
        let inventory = &self.owner.inventory;
        let mut private = vec![node(
            &source.git,
            PathBuf::new(),
            Some(inventory.first.clone()),
            &mut used,
            cancel,
        )?];
        for directory in &inventory.directories {
            let relative = directory
                .pin
                .guid_path
                .strip_prefix(&source.git.guid_path)
                .map_err(|_| error("recoveryChanged"))?
                .to_owned();
            private.push(node(
                &directory.pin,
                relative,
                Some(directory.before.clone()),
                &mut used,
                cancel,
            )?);
        }
        for leaf in &inventory.leaves {
            private.push(node(
                &leaf.pin,
                PathBuf::from(&leaf.path),
                None,
                &mut used,
                cancel,
            )?);
        }
        private.sort_by_key(|entry| entry.relative.components().count());
        let snapshot = self.owner.expected.clone();
        let roots = self.roots().clone();
        let objects = self.objects.clone();
        self.recheck(cancel)?;
        // Any retained material operation still using this exact owner must
        // retire first. A copied baseline cannot turn an old live pin into a
        // supposedly released object or silently replace its file identity.
        if Arc::strong_count(&self.owner) != 1 {
            return Err(error("busy"));
        }
        drop(pointer_pin);
        let SourceGraph { owner, .. } = self;
        let SourceOwner {
            source,
            managed_root_git,
            inventory,
            ..
        } = Arc::try_unwrap(owner).map_err(|_| error("busy"))?;
        drop((managed_root_git, inventory));
        let common = Arc::new(source.into_removal_context(&snapshot)?);
        Ok(FrozenSource {
            common,
            snapshot,
            root,
            pointer,
            private,
            roots,
            objects,
            configs,
            attributes,
        })
    }
}
