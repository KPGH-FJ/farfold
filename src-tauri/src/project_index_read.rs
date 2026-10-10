//! A bounded current read; it is not a promise that a later send sees this version.
use super::Failure;
use crate::file_access;
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};
const MAX: u64 = 256 * 1024;
struct Opened {
    root_path: PathBuf,
    relative: PathBuf,
    root: File,
    file: File,
    before: file_access::Stamp,
}
impl Opened {
    fn open(root_path: &Path, relative: &Path) -> Result<Self, Failure> {
        let root =
            file_access::open_directory(root_path).map_err(|_| Failure::new("unreadable"))?;
        let file =
            file_access::open_relative(&root, relative).map_err(|_| Failure::new("unreadable"))?;
        let before = file_access::stamp(&file).map_err(|_| Failure::new("unreadable"))?;
        if !before.regular {
            return Err(Failure::new("unreadable"));
        }
        if before.size > MAX {
            return Err(Failure::new("tooLarge"));
        }
        Ok(Self {
            root_path: root_path.into(),
            relative: relative.into(),
            root,
            file,
            before,
        })
    }
    fn finish(&self) -> Result<String, Failure> {
        let mut bytes = Vec::new();
        (&self.file)
            .take(MAX + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Failure::new("unreadable"))?;
        if bytes.len() as u64 > MAX {
            return Err(Failure::new("tooLarge"));
        }
        if file_access::stamp(&self.file).map_err(|_| Failure::new("changed"))? != self.before {
            return Err(Failure::new("changed"));
        }
        let current_root =
            file_access::open_directory(&self.root_path).map_err(|_| Failure::new("changed"))?;
        if !file_access::same_object(&self.root, &current_root)
            .map_err(|_| Failure::new("changed"))?
        {
            return Err(Failure::new("changed"));
        }
        let current_path = file_access::open_relative(&current_root, &self.relative)
            .map_err(|_| Failure::new("changed"))?;
        if file_access::stamp(&current_path).map_err(|_| Failure::new("changed"))? != self.before {
            return Err(Failure::new("changed"));
        }
        String::from_utf8(bytes).map_err(|_| Failure::new("notText"))
    }
}
pub(super) fn read(root: &Path, relative: &Path) -> Result<String, Failure> {
    Opened::open(root, relative)?.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }
    #[test]
    fn exact_limit_and_utf8_are_explicit() {
        let dir = root();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("text"), vec![b'a'; MAX as usize]).unwrap();
        assert_eq!(read(&root, Path::new("text")).unwrap().len(), MAX as usize);
        std::fs::write(root.join("text"), vec![b'a'; MAX as usize + 1]).unwrap();
        assert_eq!(read(&root, Path::new("text")).unwrap_err().code, "tooLarge");
        std::fs::write(root.join("text"), [0xff]).unwrap();
        assert_eq!(read(&root, Path::new("text")).unwrap_err().code, "notText");
    }
    #[test]
    fn an_opened_file_replaced_with_other_bytes_is_not_returned() {
        let dir = root();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("text"), "old").unwrap();
        let opened = Opened::open(&root, Path::new("text")).unwrap();
        std::fs::rename(root.join("text"), root.join("old")).unwrap();
        std::fs::write(root.join("text"), "new").unwrap();
        assert_eq!(opened.finish().unwrap_err().code, "changed");
    }
    #[test]
    fn growth_after_open_is_bounded_and_rejected() {
        let dir = root();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("text"), "old").unwrap();
        let opened = Opened::open(&root, Path::new("text")).unwrap();
        std::fs::write(root.join("text"), vec![b'x'; MAX as usize + 1]).unwrap();
        assert_eq!(opened.finish().unwrap_err().code, "tooLarge");
    }
    #[cfg(unix)]
    #[test]
    fn symlink_leaf_and_intermediate_components_are_never_read() {
        use std::os::unix::fs::symlink;
        let dir = root();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir(root.join("folder")).unwrap();
        std::fs::write(root.join("folder/text"), "private").unwrap();
        symlink("folder/text", root.join("link")).unwrap();
        symlink("folder", root.join("alias")).unwrap();
        for path in ["link", "alias/text", "../text"] {
            assert!(read(&root, Path::new(path)).is_err());
        }
    }
    #[cfg(unix)]
    #[test]
    fn replacing_the_root_or_leaf_after_open_does_not_follow_a_link() {
        use std::os::unix::fs::symlink;
        let dir = root();
        let parent = dir.path().canonicalize().unwrap();
        let root = parent.join("root");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("text"), "old").unwrap();
        let opened = Opened::open(&root, Path::new("text")).unwrap();
        std::fs::rename(&root, parent.join("moved")).unwrap();
        symlink("moved", &root).unwrap();
        assert_eq!(opened.finish().unwrap_err().code, "changed");
    }
}
