//! Data-only fixed-name observations; one held Git context for each operation.
use super::{
    inspect,
    preparation_git::GitObservation,
    preparation_types::{FIXED_NAMES, PreparationFact, PreparationGit, PreparationNodeKind},
    read_context::Reader,
    storage::SavedLocation,
    types::{Result, error},
};
use crate::file_access::{
    EntryMetadata, Identity, MetadataFailure, MetadataKind, PinnedPath, metadata_child,
};
use std::{ffi::OsStr, path::Path};

#[derive(Debug, Clone, PartialEq, Eq)]
enum Node {
    Missing,
    Present(EntryMetadata),
    Unreadable(MetadataFailure),
}
impl Node {
    fn kind(&self) -> PreparationNodeKind {
        match self {
            Self::Missing => PreparationNodeKind::Missing,
            Self::Unreadable(_) => PreparationNodeKind::Unreadable,
            Self::Present(v) => match v.kind {
                MetadataKind::File => PreparationNodeKind::File,
                MetadataKind::Directory => PreparationNodeKind::Directory,
                MetadataKind::Symlink => PreparationNodeKind::Symlink,
                MetadataKind::Other => PreparationNodeKind::Other,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct MetadataObservation {
    directories: Vec<Identity>,
    entries: Vec<Node>,
}
impl MetadataObservation {
    pub(super) fn facts(&self) -> Vec<PreparationFact> {
        FIXED_NAMES
            .iter()
            .zip(&self.entries)
            .map(|((name, role), node)| PreparationFact {
                name,
                role: *role,
                node_kind: node.kind(),
            })
            .collect()
    }
}

pub(super) struct Scope {
    reader: Reader,
    project: PinnedPath,
    project_path: String,
}
impl Scope {
    pub(super) fn open(saved: &SavedLocation, segments: &[&str]) -> Result<Self> {
        let reader = Reader::open(Path::new(&saved.location.path))?;
        let root = &reader.windows_scope().root;
        let mut path = root.guid_path.clone();
        for segment in segments {
            path.push(segment);
        }
        let project = PinnedPath::git_directory(&path).map_err(|_| error("unsafePath"))?;
        if !project.has_ancestor(root.identity()) {
            return Err(error("changed"));
        }
        // This is the strict existing wire spelling, not an authorization path.
        // No PathBuf::display conversion or relaxed frontend comparison.
        let project_path = if segments.is_empty() {
            saved.location.path.clone()
        } else {
            format!("{}/{}", saved.location.path, segments.join("/"))
        };
        if project_path.len() > 4096 {
            return Err(error("unsafePath"));
        }
        let scope = Self {
            reader,
            project,
            project_path,
        };
        scope.recheck(saved)?;
        Ok(scope)
    }
    pub(super) fn project_path(&self) -> String {
        self.project_path.clone()
    }
    pub(super) fn observe(&self) -> Result<MetadataObservation> {
        self.project.verify().map_err(|_| error("changed"))?;
        let entries = FIXED_NAMES
            .iter()
            .map(
                |(name, _)| match metadata_child(self.project.file(), OsStr::new(name)) {
                    Ok(None) => Node::Missing,
                    Ok(Some(value)) => Node::Present(value),
                    Err(error) => Node::Unreadable(error),
                },
            )
            .collect();
        self.project.verify().map_err(|_| error("changed"))?;
        Ok(MetadataObservation {
            directories: self.project.chain_identities().to_vec(),
            entries,
        })
    }
    pub(super) fn recheck(&self, saved: &SavedLocation) -> Result<()> {
        let scope = self.reader.windows_scope();
        scope.verify()?;
        for (pin, path, stamp) in [
            (
                &scope.root,
                &saved.identity.root,
                &saved.identity.root_stamp,
            ),
            (
                &scope.git,
                &saved.identity.git_dir,
                &saved.identity.git_stamp,
            ),
            (
                &scope.common,
                &saved.identity.common_dir,
                &saved.identity.common_stamp,
            ),
        ] {
            if pin.path != *path || inspect::pinned_stamp(pin)? != *stamp {
                return Err(error("changed"));
            }
        }
        saved.identity.check()?;
        self.project.verify().map_err(|_| error("changed"))?;
        let current =
            PinnedPath::git_directory(&self.project.guid_path).map_err(|_| error("changed"))?;
        if current.chain_identities() != self.project.chain_identities()
            || !current.has_ancestor(scope.root.identity())
        {
            return Err(error("changed"));
        }
        Ok(())
    }
    pub(super) fn git(&self, saved: &SavedLocation) -> Result<GitObservation> {
        self.recheck(saved)?;
        let snapshot = inspect::observe_with_reader(Path::new(&saved.location.path), &self.reader)?;
        if !saved.identity.matches(&snapshot)
            || snapshot.head.as_deref() != Some(saved.location.head_oid.as_str())
            || snapshot.branch != saved.location.branch
            || !snapshot.blockers.is_empty()
        {
            return Err(error("changed"));
        }
        self.recheck(saved)?;
        Ok(GitObservation {
            summary: PreparationGit {
                kind: if saved.location.path == saved.location.repository_root {
                    "main"
                } else {
                    "linked"
                },
                other_worktree_count: snapshot
                    .trees
                    .len()
                    .checked_sub(1)
                    .ok_or(error("changed"))?,
            },
            trees: snapshot.trees,
        })
    }
}
