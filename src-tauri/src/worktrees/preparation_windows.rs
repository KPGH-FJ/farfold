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
    DirectoryEntries, DirectoryFailure, DirectoryObservation, EntryMetadata, Identity,
    MetadataFailure, MetadataKind, PinnedPath, directory_entries, metadata_child,
};
use std::{ffi::OsStr, path::Path, sync::atomic::AtomicBool};
use windows_sys::Win32::Globalization::{CSTR_EQUAL, CompareStringOrdinal};

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
struct NamedObservation {
    raw_name: Vec<u16>,
    metadata: DirectoryObservation,
}

// Complete enumeration is used only to resolve the existing fixed-name set.
// Unrelated names are dropped, not retained as a whole-project version.
fn fixed_namespace(listed: DirectoryEntries) -> Result<Vec<Option<NamedObservation>>> {
    let fixed = FIXED_NAMES
        .iter()
        .map(|(name, _)| name.encode_utf16().collect::<Vec<_>>())
        .collect::<Vec<_>>();
    let mut selected = vec![None; fixed.len()];
    for (raw_name, metadata) in listed {
        for (index, expected) in fixed.iter().enumerate() {
            // Same OS ordinal policy as the existing metadata leaf-name check.
            // A comparison failure is not evidence that a name is unrelated.
            let compared = unsafe {
                CompareStringOrdinal(
                    raw_name.as_ptr(),
                    raw_name.len() as i32,
                    expected.as_ptr(),
                    expected.len() as i32,
                    1,
                )
            };
            if compared == 0 {
                return Err(error("unavailable"));
            }
            if compared == CSTR_EQUAL {
                if selected[index].is_some() {
                    return Err(error("unsafePath"));
                }
                selected[index] = Some(NamedObservation {
                    raw_name: raw_name.clone(),
                    metadata: metadata.clone(),
                });
            }
        }
    }
    Ok(selected)
}

fn enumeration_failure(failure: DirectoryFailure) -> super::types::Failure {
    error(if failure == DirectoryFailure::Changed {
        "changed"
    } else {
        // No partial report, Missing, new UI error/cancellation contract, or
        // raw OS text is produced for access, budget, unsupported or parse errors.
        "unavailable"
    })
}

fn observe_listed(project: &PinnedPath, listed: DirectoryEntries) -> Result<MetadataObservation> {
    let namespace = fixed_namespace(listed)?;
    let mut entries = Vec::with_capacity(FIXED_NAMES.len());
    for ((name, _), listed) in FIXED_NAMES.iter().zip(&namespace) {
        let node = match metadata_child(project.file(), OsStr::new(name)) {
            Ok(None) if listed.is_none() => Node::Missing,
            Ok(Some(value))
                if listed
                    .as_ref()
                    .is_some_and(|listed| value.matches_directory_entry(&listed.metadata)) =>
            {
                Node::Present(value)
            }
            Ok(_) => return Err(error("changed")),
            Err(failure) => Node::Unreadable(failure),
        };
        entries.push(node);
    }
    project.verify().map_err(|_| error("changed"))?;
    Ok(MetadataObservation {
        directories: project.chain_identities().to_vec(),
        entries,
        namespace,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct MetadataObservation {
    directories: Vec<Identity>,
    entries: Vec<Node>,
    namespace: Vec<Option<NamedObservation>>,
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
        // Existing IPC supplies no cancellation token. This does not add one.
        // A synchronous OS call runs inside file_read_check's real blocking slot;
        // its 15-second response deadline cannot abort an in-flight kernel call.
        let cancel = AtomicBool::new(false);
        let listed =
            directory_entries(&self.project, 100_000, &cancel).map_err(enumeration_failure)?;
        observe_listed(&self.project, listed)
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

#[cfg(test)]
mod namespace_tests {
    use super::*;
    use std::{fs, sync::atomic::AtomicBool};

    fn value(id: u128) -> DirectoryObservation {
        DirectoryObservation {
            identity: Identity {
                device: 7,
                inode: id,
            },
            attributes: 0,
            reparse_tag: None,
            ea_size: 0,
            size: 0,
            allocation_size: 0,
            created: 0,
            modified: 0,
            changed: 0,
        }
    }
    fn encoded(name: &str) -> Vec<u16> {
        name.encode_utf16().collect()
    }

    #[test]
    fn fixed_namespace_rejects_ordinal_aliases_without_retaining_unknown_names() {
        let raw = encoded("PACKAGE.JSON");
        let mut listed = DirectoryEntries::new();
        listed.insert(raw.clone(), value((1 << 120) | 9));
        listed.insert(vec![0xd800, 65], value(10));
        let relevant = fixed_namespace(listed.clone()).unwrap();
        assert_eq!(relevant.len(), FIXED_NAMES.len());
        assert_eq!(relevant.iter().filter(|v| v.is_some()).count(), 1);
        let selected = relevant[0].as_ref().unwrap();
        assert_eq!(selected.raw_name, raw);
        assert_eq!(selected.metadata.identity.inode, (1 << 120) | 9);
        listed.insert(encoded("package.json"), value(11));
        assert_eq!(fixed_namespace(listed).unwrap_err().code, "unsafePath");
    }

    #[test]
    fn whole_enumeration_failures_cannot_become_missing_or_a_partial_report() {
        for failure in [
            DirectoryFailure::Cancelled,
            DirectoryFailure::Limit,
            DirectoryFailure::InvalidRecord,
            DirectoryFailure::Unsupported,
            DirectoryFailure::Io {
                phase: "query",
                code: Some(5),
                nt_status: None,
            },
        ] {
            assert_eq!(enumeration_failure(failure).code, "unavailable");
        }
        assert_eq!(
            enumeration_failure(DirectoryFailure::Changed).code,
            "changed"
        );
    }

    #[test]
    fn real_leaf_pairing_rejects_high_identity_bits_ea_and_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("package.json");
        fs::write(&path, b"owned-public-same-body").unwrap();
        let pin = PinnedPath::directory(temp.path()).unwrap();
        let cancel = AtomicBool::new(false);
        let listed = directory_entries(&pin, 100_000, &cancel).unwrap();
        let before = observe_listed(&pin, listed.clone()).unwrap();
        let mut identity_changed = listed.clone();
        identity_changed
            .get_mut(&encoded("package.json"))
            .unwrap()
            .identity
            .inode ^= 1 << 120;
        assert_eq!(
            observe_listed(&pin, identity_changed).unwrap_err().code,
            "changed"
        );
        // EA length is an observed hint only, not EA contents/preservation.
        let mut ea_changed = listed.clone();
        ea_changed
            .get_mut(&encoded("package.json"))
            .unwrap()
            .ea_size += 1;
        assert_ne!(observe_listed(&pin, ea_changed).unwrap(), before);
        fs::rename(&path, temp.path().join("previous-package")).unwrap();
        fs::write(&path, b"owned-public-same-body").unwrap();
        assert_eq!(observe_listed(&pin, listed).unwrap_err().code, "changed");
        let fresh = directory_entries(&pin, 100_000, &cancel).unwrap();
        assert!(observe_listed(&pin, fresh).is_ok());
    }
}
