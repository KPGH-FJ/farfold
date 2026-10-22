//! One transient, handle-held local repository observation; never durable authority.
use super::{
    inspect::Snapshot,
    types::{Result, error},
};
use crate::file_access::PinnedPath;
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

#[path = "windows_scope_managed_git.rs"]
pub(super) mod managed_git;
#[path = "windows_scope_move.rs"]
mod move_metadata;
pub(super) use move_metadata::MoveMetadata;

pub(super) struct Scope {
    pub root: PinnedPath,
    pub git: PinnedPath,
    pub common: PinnedPath,
    common_parent: PinnedPath,
    _selected: PinnedPath,
    pointers: Vec<PinnedPath>,
    absent: Vec<PathBuf>,
}
fn failure(_: std::io::Error) -> super::types::Failure {
    error("unsafePath")
}
fn resolve(parent: &Path, text: &str) -> Result<PathBuf> {
    if text.is_empty() || text.contains(['\0', '\r', '\n']) {
        return Err(error("unsafePath"));
    }
    let target = Path::new(text);
    if !target.is_absolute()
        && (target.has_root() || matches!(target.components().next(), Some(Component::Prefix(_))))
    {
        return Err(error("unsafePath"));
    }
    let joined = parent.join(text);
    let mut result = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                result.push(component.as_os_str())
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if !result.pop() {
                    return Err(error("unsafePath"));
                }
            }
        }
    }
    // The parent is an actual held volume-GUID namespace. The target is still
    // opened component-by-component below; never fall back to a DOS alias.
    if !result.is_absolute() {
        return Err(error("unsafePath"));
    }
    Ok(result)
}
fn pointer(path: &Path, prefix: &str) -> Result<(PinnedPath, PathBuf)> {
    let pin = PinnedPath::git_regular(path).map_err(failure)?;
    let mut bytes = Vec::new();
    pin.file()
        .try_clone()
        .map_err(failure)?
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(failure)?;
    if bytes.len() > 4096 {
        return Err(error("tooLarge"));
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| error("unsafePath"))?;
    let text = text.strip_suffix('\n').unwrap_or(text);
    let text = text.strip_suffix('\r').unwrap_or(text);
    let value = text.strip_prefix(prefix).ok_or(error("unsafePath"))?;
    let resolved = resolve(path.parent().ok_or(error("unsafePath"))?, value)?;
    Ok((pin, resolved))
}
fn optional_pointer(
    path: &Path,
    absent: &mut Vec<PathBuf>,
) -> Result<Option<(PinnedPath, PathBuf)>> {
    match fs::symlink_metadata(path) {
        Ok(_) => pointer(path, "").map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            absent.push(path.into());
            Ok(None)
        }
        Err(_) => Err(error("unavailable")),
    }
}
impl Scope {
    pub(super) fn offline_program_origin(&self) -> Result<super::windows_offline_program::Origin> {
        self.verify()?;
        // All four facts come from these SAME live held directories, including
        // common_parent. No later lookup reconstructs a missing parent.
        let value = super::windows_offline_program::Origin::capture([
            &self.root,
            &self.git,
            &self.common,
            &self.common_parent,
        ])?;
        self.verify()?;
        Ok(value)
    }
    pub fn open(path: &Path) -> Result<Self> {
        let selected = PinnedPath::directory(path).map_err(failure)?;
        let mut found = None;
        for ancestor in selected.guid_path.ancestors() {
            let dot_git = ancestor.join(".git");
            match fs::symlink_metadata(&dot_git) {
                Ok(metadata) => {
                    found = Some((ancestor.to_owned(), dot_git, metadata.is_dir()));
                    break;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(error("unavailable")),
            }
        }
        let (root, dot_git, directory) = found.ok_or(error("unsupportedGit"))?;
        let root = PinnedPath::git_directory(&root).map_err(failure)?;
        if !selected.has_ancestor(root.identity()) {
            return Err(error("changed"));
        }
        let mut pointers = Vec::new();
        let git_path = if directory {
            dot_git.clone()
        } else {
            let (pin, target) = pointer(&dot_git, "gitdir: ")?;
            pointers.push(pin);
            target
        };
        let git = PinnedPath::git_directory(&git_path).map_err(failure)?;
        let mut absent = Vec::new();
        let common = if let Some((pin, target)) =
            optional_pointer(&git.guid_path.join("commondir"), &mut absent)?
        {
            pointers.push(pin);
            PinnedPath::git_directory(&target).map_err(failure)?
        } else {
            PinnedPath::git_directory(&git.guid_path).map_err(failure)?
        };
        if let Some((pin, target)) = optional_pointer(&git.guid_path.join("gitdir"), &mut absent)? {
            let back = PinnedPath::git_regular(&target).map_err(failure)?;
            let expected = PinnedPath::git_regular(&dot_git).map_err(failure)?;
            if back.identity() != expected.identity() {
                return Err(error("changed"));
            }
            pointers.extend([pin, back, expected]);
        }
        // Git may read per-worktree config only when its shared extension is
        // enabled. Hold both files regardless; an absent file must stay absent.
        for path in [
            common.guid_path.join("config"),
            git.guid_path.join("config.worktree"),
        ] {
            match fs::symlink_metadata(&path) {
                Ok(_) => pointers.push(PinnedPath::git_regular(&path).map_err(failure)?),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => absent.push(path),
                Err(_) => return Err(error("unavailable")),
            }
        }
        let common_parent =
            PinnedPath::git_directory(common.guid_path.parent().ok_or(error("unsafePath"))?)
                .map_err(failure)?;
        let scope = Self {
            root,
            git,
            common,
            common_parent,
            _selected: selected,
            pointers,
            absent,
        };
        scope.verify()?;
        Ok(scope)
    }
    pub fn verify(&self) -> Result<()> {
        for pin in [
            &self.root,
            &self.git,
            &self.common,
            &self.common_parent,
            &self._selected,
        ]
        .into_iter()
        .chain(self.pointers.iter())
        {
            pin.verify().map_err(failure)?;
        }
        for path in &self.absent {
            match fs::symlink_metadata(path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                _ => return Err(error("changed")),
            }
        }
        Ok(())
    }
    pub fn matches(&self, snapshot: &Snapshot) -> Result<()> {
        self.verify()?;
        for (pin, path, stamp) in [
            (&self.root, &snapshot.root, &snapshot.root_stamp),
            (&self.git, &snapshot.git_dir, &snapshot.git_stamp),
            (&self.common, &snapshot.common_dir, &snapshot.common_stamp),
        ] {
            if super::inspect::pinned_stamp(pin)? != *stamp {
                return Err(error("changed"));
            }
            let current = PinnedPath::directory(Path::new(path)).map_err(failure)?;
            if pin.identity() != current.identity() || pin.path != *path {
                return Err(error("changed"));
            }
        }
        Ok(())
    }
    pub fn contains_project(&self, candidate: &PinnedPath) -> bool {
        [&self.root, &self.git, &self.common_parent]
            .into_iter()
            .any(|p| candidate.has_ancestor(p.identity()))
    }
}

#[path = "windows_scope_remove.rs"]
mod remove_metadata;
pub(super) use remove_metadata::RemoveMetadata;
