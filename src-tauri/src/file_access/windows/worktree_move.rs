//! One held linked-worktree root, same-volume no-replace rename only.
use super::pinned::local_guid;
use super::*;

pub(crate) struct WorktreeMove {
    source_parent: PinnedPath,
    target_parent: PinnedPath,
    root: Option<PinnedPath>,
    root_id: Identity,
    target_leaf: String,
    source_path: PathBuf,
    target_path: PathBuf,
    basic: FILE_BASIC_INFO,
    moved: bool,
}
#[cfg(test)]
#[path = "worktree_move_tests.rs"]
mod tests;
use std::path::PathBuf;
impl WorktreeMove {
    pub(crate) fn open(
        from: &Path,
        to: &Path,
        root_id: Identity,
        source_parent_id: Identity,
        target_parent_id: Identity,
    ) -> io::Result<Self> {
        Self::open_for(
            from,
            to,
            root_id,
            source_parent_id,
            target_parent_id,
            ReadPurpose::Ordinary,
        )
    }
    // Legacy archives that actually observed full SD keep their original
    // access requirement. No failed full-security open falls back to ordinary.
    pub(crate) fn open_full_security(
        from: &Path,
        to: &Path,
        root_id: Identity,
        source_parent_id: Identity,
        target_parent_id: Identity,
    ) -> io::Result<Self> {
        Self::open_for(
            from,
            to,
            root_id,
            source_parent_id,
            target_parent_id,
            ReadPurpose::FullSecurity,
        )
    }
    fn open_for(
        from: &Path,
        to: &Path,
        root_id: Identity,
        source_parent_id: Identity,
        target_parent_id: Identity,
        purpose: ReadPurpose,
    ) -> io::Result<Self> {
        absolute(from)?;
        absolute(to)?;
        let source_parent = PinnedPath::directory(from.parent().ok_or_else(invalid)?)?;
        let target_parent = PinnedPath::directory(to.parent().ok_or_else(invalid)?)?;
        if source_parent.identity() != &source_parent_id
            || target_parent.identity() != &target_parent_id
            || source_parent_id.device != target_parent_id.device
        {
            return Err(denied());
        }
        let source_leaf = from
            .file_name()
            .and_then(OsStr::to_str)
            .ok_or_else(invalid)?;
        let target_leaf = to
            .file_name()
            .and_then(OsStr::to_str)
            .ok_or_else(invalid)?
            .to_owned();
        name(OsStr::new(&target_leaf))?;
        let root = PinnedPath::move_root(&source_parent, source_leaf, purpose)?;
        if root.identity() != &root_id || root_id.device != target_parent_id.device {
            return Err(denied());
        }
        // The ordinary preservation route is explicitly the same NTFS object,
        // not a cross-volume copy or a claim about other filesystem semantics.
        let mut filesystem = [0u16; 32];
        if unsafe {
            GetVolumeInformationByHandleW(
                handle(root.file()),
                ptr::null_mut(),
                0,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                filesystem.as_mut_ptr(),
                filesystem.len() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if filesystem[..5] != [78, 84, 70, 83, 0] {
            return Err(denied());
        }
        if metadata_child(target_parent.file(), OsStr::new(&target_leaf))
            .map_err(|_| denied())?
            .is_some()
        {
            return Err(io::ErrorKind::AlreadyExists.into());
        }
        let mut basic = FILE_BASIC_INFO::default();
        if unsafe {
            GetFileInformationByHandleEx(
                handle(root.file()),
                FileBasicInfo,
                (&mut basic as *mut FILE_BASIC_INFO).cast(),
                size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let source_path = root.guid_path.clone();
        let target_path = target_parent.guid_path.join(&target_leaf);
        Ok(Self {
            source_parent,
            target_parent,
            root: Some(root),
            root_id,
            target_leaf,
            source_path,
            target_path,
            basic,
            moved: false,
        })
    }
    pub(crate) fn take_root(&mut self) -> io::Result<PinnedPath> {
        self.root.take().ok_or_else(denied)
    }
    pub(crate) fn return_root(&mut self, root: PinnedPath) -> io::Result<()> {
        if self.root.is_some()
            || root.guid_path != self.expected_path()
            || root.identity() != &self.root_id
        {
            return Err(denied());
        }
        root.verify()?;
        self.root = Some(root);
        Ok(())
    }
    fn expected_path(&self) -> &Path {
        if self.moved {
            &self.target_path
        } else {
            &self.source_path
        }
    }
    pub(crate) fn root(&self) -> io::Result<&PinnedPath> {
        self.root.as_ref().ok_or_else(denied)
    }
    pub(crate) fn verify(&self) -> io::Result<()> {
        self.source_parent.verify()?;
        self.target_parent.verify()?;
        let root = self.root()?;
        root.verify()?;
        if local_guid(root.file())? != self.expected_path() {
            return Err(denied());
        }
        Ok(())
    }
    pub(crate) fn git_path(&self) -> io::Result<PathBuf> {
        self.verify()?;
        if !self.moved {
            return Err(invalid());
        }
        // Git's documented pointer spelling uses a normal absolute drive path.
        // Reopen only the held parent (not the DELETE-owned root), then join
        // the actual verified leaf. A changed DOS mapping cannot mint identity.
        let plain = self
            .target_parent
            .path
            .strip_prefix(r"\\?\")
            .ok_or_else(denied)?;
        let alias = PinnedPath::directory(Path::new(plain))?;
        if alias.identity() != self.target_parent.identity()
            || alias.guid_path != self.target_parent.guid_path
            || alias.path != self.target_parent.path
            || metadata_child(alias.file(), OsStr::new(&self.target_leaf))
                .map_err(|_| denied())?
                .is_none_or(|value| value.identity() != &self.root_id)
        {
            return Err(denied());
        }
        let target = Path::new(plain).join(&self.target_leaf);
        absolute(&target)?;
        self.verify()?;
        Ok(target)
    }
    pub(crate) fn rename(&mut self) -> io::Result<()> {
        #[cfg(test)]
        let progress = tests::Observation::new();
        self.verify()?;
        if self.moved {
            return Err(invalid());
        }
        let destination = name(OsStr::new(&self.target_leaf))?;
        let count = size_of::<FILE_RENAME_INFORMATION>() + destination.len() * 2;
        let mut allocation = vec![0usize; count.div_ceil(size_of::<usize>())];
        let rename = allocation.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
        unsafe {
            (*rename).RootDirectory = handle(self.target_parent.file());
            (*rename).FileNameLength = (destination.len() * 2) as u32;
            ptr::copy_nonoverlapping(
                destination.as_ptr(),
                (*rename).FileName.as_mut_ptr(),
                destination.len(),
            );
        }
        let mut status = IO_STATUS_BLOCK::default();
        let code = unsafe {
            NtSetInformationFile(
                handle(self.root()?.file()),
                &mut status,
                rename.cast(),
                count as u32,
                FileRenameInformation,
            )
        };
        #[cfg(test)]
        progress.at("rename-information-dispatched");
        if code != 0 {
            return Err(io::Error::from_raw_os_error(
                unsafe { RtlNtStatusToDosError(code) } as i32,
            ));
        }
        // The move already happened. Following errors preserve unknown; never
        // retry or roll a replacement path back into the source name.
        self.moved = true;
        #[cfg(test)]
        progress.at("rename-information-succeeded");
        let root = self.root.take().ok_or_else(denied)?;
        self.root = Some(root.after_owned_move(&self.target_parent, &self.target_leaf)?);
        #[cfg(test)]
        progress.at("original-root-new-parent-verified");
        // Microsoft FileBasicInfo uses zero attributes to preserve the actual
        // flags; DIRECTORY is not a writable FILE_BASIC_INFO attribute.
        // https://learn.microsoft.com/windows/win32/api/winbase/ns-winbase-file_basic_info
        let restore = FILE_BASIC_INFO {
            FileAttributes: 0,
            ..self.basic
        };
        if unsafe {
            SetFileInformationByHandle(
                handle(self.root()?.file()),
                FileBasicInfo,
                (&restore as *const FILE_BASIC_INFO).cast(),
                size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        #[cfg(test)]
        progress.at("root-basic-restored");
        let mut observed = FILE_BASIC_INFO::default();
        if unsafe {
            GetFileInformationByHandleEx(
                handle(self.root()?.file()),
                FileBasicInfo,
                (&mut observed as *mut FILE_BASIC_INFO).cast(),
                size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if observed.CreationTime != self.basic.CreationTime
            || observed.LastAccessTime != self.basic.LastAccessTime
            || observed.LastWriteTime != self.basic.LastWriteTime
            || observed.ChangeTime != self.basic.ChangeTime
            || observed.FileAttributes != self.basic.FileAttributes
        {
            #[cfg(test)]
            eprintln!(
                "FARFOLD_WINDOWS_MOVE_BASIC creationEqual={} accessEqual={} writeEqual={} changeEqual={} attributesEqual={}",
                observed.CreationTime == self.basic.CreationTime,
                observed.LastAccessTime == self.basic.LastAccessTime,
                observed.LastWriteTime == self.basic.LastWriteTime,
                observed.ChangeTime == self.basic.ChangeTime,
                observed.FileAttributes == self.basic.FileAttributes,
            );
            return Err(denied());
        }
        #[cfg(test)]
        progress.at("root-basic-verified");
        self.verify()
    }
}
