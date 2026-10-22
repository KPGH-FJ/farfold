use super::*;
use crate::file_access::PinnedPath;
pub(super) struct Directory {
    parent: PinnedPath,
    root: PinnedPath,
    leaf: Vec<u16>,
    parent_stamp: inspect::Stamp,
    root_stamp: inspect::Stamp,
}
pub(super) struct Opened {
    pin: PinnedPath,
}
impl Opened {
    pub(super) fn file(&self) -> &File {
        self.pin.file()
    }
    pub(super) fn verify(&self) -> Result<()> {
        self.pin.verify().map_err(|_| error("recoveryChanged"))
    }
}
impl Directory {
    pub(super) fn open(
        root: &Path,
        parent: &Path,
        parent_stamp: &inspect::Stamp,
        root_stamp: &inspect::Stamp,
    ) -> Result<Self> {
        use std::os::windows::ffi::OsStrExt;
        let parent = PinnedPath::directory(parent).map_err(|_| error("recoveryChanged"))?;
        let leaf = root
            .file_name()
            .ok_or(error("unsafePath"))?
            .encode_wide()
            .collect::<Vec<_>>();
        let held_root = parent
            .child(&leaf, true)
            .map_err(|_| error("recoveryChanged"))?;
        let value = Self {
            parent,
            root: held_root,
            leaf,
            parent_stamp: parent_stamp.clone(),
            root_stamp: root_stamp.clone(),
        };
        value.verify()?;
        Ok(value)
    }
    pub(super) fn verify(&self) -> Result<()> {
        self.parent.verify().map_err(|_| error("recoveryChanged"))?;
        self.root.verify().map_err(|_| error("recoveryChanged"))?;
        if inspect::pinned_stamp(&self.parent)? != self.parent_stamp
            || inspect::pinned_stamp(&self.root)? != self.root_stamp
        {
            return Err(error("recoveryChanged"));
        }
        let fresh = self
            .parent
            .child(&self.leaf, true)
            .map_err(|_| error("recoveryChanged"))?;
        if inspect::pinned_stamp(&fresh)? != self.root_stamp {
            return Err(error("recoveryChanged"));
        }
        Ok(())
    }
    pub(super) fn open_file(&self, name: &'static str) -> Result<Opened> {
        self.verify()?;
        // Ordinary read purpose only. Existing regular FILE_SHARE_READ and
        // directory READ|WRITE/no DELETE discipline are unchanged globally.
        let pin = self
            .root
            .child(&name.encode_utf16().collect::<Vec<_>>(), false)
            .map_err(|_| error("recoveryChanged"))?;
        let value = Opened { pin };
        value.verify()?;
        self.verify()?;
        Ok(value)
    }
}
