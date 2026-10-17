//! Explicit, transient user-chosen skill roots. No config writes or implicit roots.
use super::{launch::Directory, types::*};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

pub(super) fn validate(roots: &[String], kind: Kind) -> Result<()> {
    if roots.len() > 4
        || (!roots.is_empty() && kind != Kind::Skills)
        || roots.iter().map(String::len).sum::<usize>() > 16_384
        || roots.iter().any(|p| {
            p.is_empty()
                || p.len() > 4096
                || !Path::new(p).is_absolute()
                || p.chars().any(char::is_control)
        })
    {
        return Err(Code::InvalidRequest.into());
    }
    Ok(())
}

struct Root {
    requested: String,
    canonical: PathBuf,
    directory: Directory,
}
pub(super) struct PinnedRoots(Vec<Root>);
impl PinnedRoots {
    pub fn open(requested: &[String]) -> Result<Self> {
        validate(requested, Kind::Skills)?;
        let mut seen = HashSet::new();
        let mut roots = Vec::with_capacity(requested.len());
        for path in requested {
            let canonical = std::fs::canonicalize(path).map_err(|_| Code::CwdUnavailable)?;
            let actual = canonical.to_str().ok_or(Code::CwdUnavailable)?;
            if actual.len() > 4096 || actual.chars().any(char::is_control) {
                return Err(Code::CwdUnavailable.into());
            }
            if !seen.insert(canonical.clone()) {
                return Err(Code::InvalidRequest.into());
            }
            roots.push(Root {
                requested: path.clone(),
                directory: Directory::open(actual)?,
                canonical,
            });
        }
        let pinned = Self(roots);
        if !pinned.current() {
            return Err(Code::CwdUnavailable.into());
        }
        Ok(pinned)
    }
    pub fn paths(&self) -> Vec<String> {
        self.0
            .iter()
            .map(|root| root.canonical.to_str().unwrap_or_default().to_owned())
            .collect()
    }
    pub fn current(&self) -> bool {
        self.0.iter().all(|root| {
            std::fs::canonicalize(&root.requested).is_ok_and(|path| path == root.canonical)
                && root.directory.current()
        })
    }
}
