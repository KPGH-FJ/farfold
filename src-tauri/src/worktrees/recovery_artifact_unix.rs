use super::*;
use std::ffi::OsString;
pub(super) struct Directory {
    parent: File,
    root: File,
    parent_path: PathBuf,
    root_path: PathBuf,
    leaf: OsString,
    parent_stamp: inspect::Stamp,
    root_stamp: inspect::Stamp,
}
pub(super) struct Opened {
    file: File,
    path: PathBuf,
}
impl Opened {
    pub(super) fn file(&self) -> &File {
        &self.file
    }
    pub(super) fn path(&self) -> PathBuf {
        self.path.clone()
    }
    pub(super) fn verify(&self) -> Result<()> {
        if !crate::file_access::stamp(&self.file)
            .map_err(|_| error("recoveryChanged"))?
            .regular
        {
            return Err(error("recoveryChanged"));
        }
        Ok(())
    }
}
impl Directory {
    pub(super) fn open(
        root: &Path,
        parent: &Path,
        parent_stamp: &inspect::Stamp,
        root_stamp: &inspect::Stamp,
    ) -> Result<Self> {
        let held_parent =
            crate::file_access::open_directory(parent).map_err(|_| error("recoveryChanged"))?;
        let leaf = root.file_name().ok_or(error("unsafePath"))?.to_owned();
        let held_root = crate::file_access::open_relative(&held_parent, Path::new(&leaf))
            .map_err(|_| error("recoveryChanged"))?;
        let value = Self {
            parent: held_parent,
            root: held_root,
            parent_path: parent.into(),
            root_path: root.into(),
            leaf,
            parent_stamp: parent_stamp.clone(),
            root_stamp: root_stamp.clone(),
        };
        value.verify()?;
        Ok(value)
    }
    pub(super) fn verify(&self) -> Result<()> {
        if inspect::held_directory_stamp(&self.parent)? != self.parent_stamp
            || inspect::held_directory_stamp(&self.root)? != self.root_stamp
        {
            return Err(error("recoveryChanged"));
        }
        inspect::same(
            self.parent_path.to_str().ok_or(error("unsafePath"))?,
            &self.parent_stamp,
        )?;
        let fresh = crate::file_access::open_relative(&self.parent, Path::new(&self.leaf))
            .map_err(|_| error("recoveryChanged"))?;
        if inspect::held_directory_stamp(&fresh)? != self.root_stamp {
            return Err(error("recoveryChanged"));
        }
        inspect::same(
            self.root_path.to_str().ok_or(error("unsafePath"))?,
            &self.root_stamp,
        )
    }
    pub(super) fn open_file(&self, name: &'static str) -> Result<Opened> {
        self.verify()?;
        let file = crate::file_access::open_relative(&self.root, Path::new(name))
            .map_err(|_| error("recoveryChanged"))?;
        let value = Opened {
            file,
            path: self.root_path.join(name),
        };
        value.verify()?;
        self.verify()?;
        Ok(value)
    }
}
