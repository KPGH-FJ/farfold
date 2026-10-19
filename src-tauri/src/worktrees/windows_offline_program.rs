//! Saved worktree-local exclusion facts, not a program/config/locator registry.
use super::{
    inspect,
    storage::Identity,
    types::{Result, error},
};
use crate::file_access::PinnedPath;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path};
use windows_sys::Win32::Globalization::{CSTR_EQUAL, CompareStringOrdinal};
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct DirectoryFact {
    path: String,
    guid: String,
    identity: inspect::Stamp,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WindowsFacts {
    root: DirectoryFact,
    git: DirectoryFact,
    common: DirectoryFact,
    common_parent: DirectoryFact,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Origin {
    version: u32,
    windows: WindowsFacts,
}
pub(super) fn deserialize_optional<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<Origin>, D::Error> {
    // Absent legacy field defaults to None. Explicit null is never absent.
    Origin::deserialize(d).map(Some)
}
fn local_path(path: &str) -> bool {
    !path.is_empty() && path.len() <= 4096 && crate::file_access::absolute(Path::new(path)).is_ok()
}
fn guid_path(path: &str) -> bool {
    if path.len() > 4160 || path.contains(['\0', '\r', '\n']) {
        return false;
    }
    let Some(tail) = path.strip_prefix(r"\\?\Volume{") else {
        return false;
    };
    let Some((id, _)) = tail.split_once("}\\") else {
        return false;
    };
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
        && Path::new(path).is_absolute()
        && Path::new(path).components().all(|c| {
            matches!(
                c,
                Component::Prefix(_) | Component::RootDir | Component::Normal(_)
            )
        })
}
fn equal(left: &[u16], right: &[u16]) -> Result<bool> {
    let a = i32::try_from(left.len()).map_err(|_| error("unsafePath"))?;
    let b = i32::try_from(right.len()).map_err(|_| error("unsafePath"))?;
    let value = unsafe { CompareStringOrdinal(left.as_ptr(), a, right.as_ptr(), b, 1) };
    if value == 0 {
        Err(error("unavailable"))
    } else {
        Ok(value == CSTR_EQUAL)
    }
}
pub(super) fn within(path: &str, root: &str) -> Result<bool> {
    let path: Vec<_> = path.encode_utf16().collect();
    let root: Vec<_> = root.encode_utf16().collect();
    if root.is_empty() || root.len() > path.len() {
        return Ok(false);
    }
    Ok(equal(&path[..root.len()], &root)?
        && (path.len() == root.len()
            || root.last() == Some(&u16::from(b'\\'))
            || path[root.len()] == u16::from(b'\\')))
}
impl DirectoryFact {
    fn capture(pin: &PinnedPath) -> Result<Self> {
        pin.verify().map_err(|_| error("changed"))?;
        Ok(Self {
            path: pin.path.clone(),
            guid: pin.guid_path.to_str().ok_or(error("unsafePath"))?.into(),
            identity: inspect::pinned_stamp(pin)?,
        })
    }
    fn valid(&self) -> Result<bool> {
        if !local_path(&self.path)
            || !guid_path(&self.guid)
            || self
                .identity
                .windows_identity()
                .is_none_or(|id| id.inode == 0)
        {
            return Ok(false);
        }
        // DOS and GUID spellings were captured from one handle. Keep their
        // component suffix coupled without reopening that disappeared path.
        use std::os::windows::ffi::OsStrExt;
        let names = |p: &str| {
            Path::new(p)
                .components()
                .filter_map(|c| match c {
                    Component::Normal(n) => Some(n.encode_wide().collect::<Vec<_>>()),
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        let a = names(&self.path);
        let b = names(&self.guid);
        if a.len() != b.len() {
            return Ok(false);
        }
        for (a, b) in a.iter().zip(&b) {
            if !equal(a, b)? {
                return Ok(false);
            }
        }
        Ok(true)
    }
}
impl Origin {
    pub(super) fn capture([root, git, common, common_parent]: [&PinnedPath; 4]) -> Result<Self> {
        let value = Self {
            version: 1,
            windows: WindowsFacts {
                root: DirectoryFact::capture(root)?,
                git: DirectoryFact::capture(git)?,
                common: DirectoryFact::capture(common)?,
                common_parent: DirectoryFact::capture(common_parent)?,
            },
        };
        if !value.structurally_valid()? {
            return Err(error("unsafePath"));
        }
        Ok(value)
    }
    fn facts(&self) -> [&DirectoryFact; 4] {
        [
            &self.windows.root,
            &self.windows.git,
            &self.windows.common,
            &self.windows.common_parent,
        ]
    }
    fn structurally_valid(&self) -> Result<bool> {
        if self.version != 1 {
            return Ok(false);
        }
        for fact in self.facts() {
            if !fact.valid()? {
                return Ok(false);
            }
        }
        let parent = |p: &str| {
            Path::new(p)
                .parent()
                .and_then(Path::to_str)
                .map(str::to_owned)
                .ok_or(error("unsafePath"))
        };
        let a = parent(&self.windows.common.path)?;
        let b = parent(&self.windows.common.guid)?;
        Ok(equal(
            &a.encode_utf16().collect::<Vec<_>>(),
            &self
                .windows
                .common_parent
                .path
                .encode_utf16()
                .collect::<Vec<_>>(),
        )? && equal(
            &b.encode_utf16().collect::<Vec<_>>(),
            &self
                .windows
                .common_parent
                .guid
                .encode_utf16()
                .collect::<Vec<_>>(),
        )?)
    }
    pub(super) fn matches(&self, source: &Identity, retained: &str) -> Result<()> {
        if !self.structurally_valid()?
            || self.windows.root.path != retained
            || self.windows.root.identity != source.root_stamp
            || self.windows.git.identity != source.git_stamp
            || self.windows.common.identity != source.common_stamp
            || ![
                &source.root,
                &source.repository_root,
                &source.git_dir,
                &source.common_dir,
            ]
            .iter()
            .all(|p| local_path(p))
            || [&source.root_stamp, &source.git_stamp, &source.common_stamp]
                .iter()
                .any(|s| s.windows_identity().is_none())
        {
            return Err(error("unsupportedGit"));
        }
        Ok(())
    }
    pub(super) fn excludes_path(
        &self,
        path: &str,
        source: &Identity,
        retained: &str,
    ) -> Result<bool> {
        self.matches(source, retained)?;
        for fact in self.facts() {
            if within(path, &fact.path)? || within(path, &fact.guid)? {
                return Ok(true);
            }
        }
        // Preserve the pre-archive spellings too: a replacement at an old path
        // must not become eligible merely because the original object moved.
        for old in [
            &source.root,
            &source.repository_root,
            &source.git_dir,
            &source.common_dir,
        ] {
            if within(path, old)? {
                return Ok(true);
            }
        }
        let parent = Path::new(&source.common_dir)
            .parent()
            .and_then(Path::to_str)
            .ok_or(error("unsafePath"))?;
        within(path, parent)
    }
    pub(super) fn excludes_pin(
        &self,
        pin: &PinnedPath,
        source: &Identity,
        retained: &str,
    ) -> Result<bool> {
        pin.verify().map_err(|_| error("changed"))?;
        if self.excludes_path(&pin.path, source, retained)?
            || self.excludes_path(
                pin.guid_path.to_str().ok_or(error("unsafePath"))?,
                source,
                retained,
            )?
        {
            return Ok(true);
        }
        Ok(self.facts().iter().any(|f| {
            f.identity
                .windows_identity()
                .is_none_or(|id| pin.has_ancestor(&id))
        }))
    }
}
