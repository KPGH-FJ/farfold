//! Original ReadContext-owned root .git role evidence only.
//! No payload exclusion API, material success, persisted locator or public gate.
use super::super::{
    types::{Result, error},
    windows_git::ReadContext,
};
use super::pointer;
use crate::file_access::{
    EntryMetadata, MetadataKind, PinnedPath, Stamp, metadata_child, metadata_file, stamp,
};
use std::{
    ffi::OsString,
    fs::File,
    os::windows::ffi::{OsStrExt, OsStringExt},
};

const ROOT: usize = 0;
const GIT: usize = 1;
const COMMON: usize = 2;
const COMMON_PARENT: usize = 3;
const PROGRAM: usize = 5;
const MAX_PINS: usize = 16;
const DOT_GIT: &[u16] = &[46, 103, 105, 116];
const COMMONDIR: &[u16] = &[99, 111, 109, 109, 111, 110, 100, 105, 114];
const BACK: &[u16] = &[103, 105, 116, 100, 105, 114];
const WORKTREES: &[u16] = &[119, 111, 114, 107, 116, 114, 101, 101, 115];

#[derive(Clone, Copy)]
enum Kind {
    Main,
    Linked,
}
struct Version {
    // try_clone keeps the original FileObject; no reopened pathname is its owner.
    file: File,
    before: Stamp,
    metadata: EntryMetadata,
}
impl Version {
    fn capture(pin: &PinnedPath) -> Result<Self> {
        pin.verify().map_err(|_| error("recoveryChanged"))?;
        let before = stamp(pin.file()).map_err(|_| error("recoveryChanged"))?;
        let metadata = metadata_file(pin.file()).map_err(|_| error("recoveryChanged"))?;
        if !matches!(metadata.kind, MetadataKind::File | MetadataKind::Directory)
            || (metadata.kind == MetadataKind::File) != before.regular
            || stamp(pin.file()).map_err(|_| error("recoveryChanged"))? != before
        {
            return Err(error("recoveryChanged"));
        }
        Ok(Self {
            file: pin.file().try_clone().map_err(|_| error("unavailable"))?,
            before,
            metadata,
        })
    }
    fn verify(&self) -> Result<()> {
        if stamp(&self.file).map_err(|_| error("recoveryChanged"))? != self.before
            || metadata_file(&self.file).map_err(|_| error("recoveryChanged"))? != self.metadata
            || stamp(&self.file).map_err(|_| error("recoveryChanged"))? != self.before
        {
            return Err(error("recoveryChanged"));
        }
        Ok(())
    }
}
struct Edge {
    parent: usize,
    child: usize,
    raw: Vec<u16>,
}
fn child_metadata(parent: &File, raw: &[u16]) -> Result<EntryMetadata> {
    let name = OsString::from_wide(raw);
    metadata_child(parent, &name)
        .map_err(|_| error("recoveryChanged"))?
        .ok_or(error("recoveryChanged"))
}
fn raw(pin: &PinnedPath) -> Result<Vec<u16>> {
    let value = pin.guid_path.file_name().ok_or(error("unsupportedGit"))?;
    Ok(value.encode_wide().collect())
}
fn ascii_same(a: &[u16], b: &[u16]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(a, b)| *a <= 127 && *b <= 127 && (*a as u8).eq_ignore_ascii_case(&(*b as u8)))
}
fn original_pointer(pins: &[&PinnedPath], parent: usize, leaf: &[u16]) -> Result<usize> {
    pins.iter()
        .enumerate()
        .find_map(|(i, p)| {
            (p.guid_path.parent() == Some(pins[parent].guid_path.as_path())
                && raw(p).is_ok_and(|name| ascii_same(&name, leaf)))
            .then_some(i)
        })
        .ok_or(error("unsupportedGit"))
}
fn edge(pins: &[&PinnedPath], parent: usize, child: usize, fixed: Option<&[u16]>) -> Result<Edge> {
    let name = raw(pins[child])?;
    if pins[child].guid_path.parent() != Some(pins[parent].guid_path.as_path())
        || fixed.is_some_and(|fixed| !ascii_same(&name, fixed))
    {
        return Err(error("unsupportedGit"));
    }
    let listed = child_metadata(pins[parent].file(), &name)?;
    let held = metadata_file(pins[child].file()).map_err(|_| error("recoveryChanged"))?;
    if listed != held {
        return Err(error("recoveryChanged"));
    }
    Ok(Edge {
        parent,
        child,
        raw: name,
    })
}
fn pointer_target(
    pins: &[&PinnedPath],
    index: usize,
    target: &PinnedPath,
    regular: bool,
) -> Result<()> {
    // Reuse the original bounded pointer parser/resolver; never strip a path,
    // search another repo or treat raw pointer text as an exclusion authority.
    let (fresh_pointer, path) = pointer(&pins[index].guid_path, "")?;
    if fresh_pointer.identity() != pins[index].identity()
        || stamp(fresh_pointer.file()).map_err(|_| error("recoveryChanged"))?
            != stamp(pins[index].file()).map_err(|_| error("recoveryChanged"))?
    {
        return Err(error("recoveryChanged"));
    }
    let fresh_target = if regular {
        PinnedPath::git_regular(&path)
    } else {
        PinnedPath::git_directory(&path)
    }
    .map_err(|_| error("recoveryChanged"))?;
    if fresh_target.identity() != target.identity()
        || fresh_target.guid_path != target.guid_path
        || stamp(fresh_target.file()).map_err(|_| error("recoveryChanged"))?
            != stamp(target.file()).map_err(|_| error("recoveryChanged"))?
    {
        return Err(error("recoveryChanged"));
    }
    Ok(())
}

/// Not Clone/Serialize and no public constructor, File or arbitrary skip method.
/// SourceOwner keeps this beside the SAME ReadContext through its final fence.
pub(in crate::worktrees) struct RootGit {
    kind: Kind,
    dot_git: usize,
    versions: Vec<Version>,
    edges: Vec<Edge>,
    worktrees: Option<PinnedPath>,
}
impl RootGit {
    pub(in crate::worktrees) fn capture(source: &ReadContext) -> Result<Self> {
        let scope = &source.scope;
        scope.verify()?;
        source
            .selected_program()
            .verify()
            .map_err(|_| error("recoveryChanged"))?;
        let observed = child_metadata(scope.root.file(), DOT_GIT)?;
        let kind = match observed.kind {
            MetadataKind::Directory => Kind::Main,
            MetadataKind::File => Kind::Linked,
            _ => return Err(error("unsupportedGit")),
        };
        let worktrees = if matches!(kind, Kind::Linked) {
            Some(
                scope
                    .common
                    .child(WORKTREES, true)
                    .map_err(|_| error("unsupportedGit"))?,
            )
        } else {
            None
        };
        // All dynamic pointer slots come from Scope::open's finite fixed list.
        let mut pins = vec![
            &scope.root,
            &scope.git,
            &scope.common,
            &scope.common_parent,
            &scope._selected,
            source.selected_program(),
        ];
        pins.extend(scope.pointers.iter());
        let extra = pins.len();
        if let Some(worktrees) = &worktrees {
            pins.push(worktrees);
        }
        if pins.len() > MAX_PINS {
            return Err(error("unsupportedGit"));
        }
        let versions = pins
            .iter()
            .map(|pin| Version::capture(pin))
            .collect::<Result<Vec<_>>>()?;
        let dot_git = match kind {
            Kind::Main => GIT,
            Kind::Linked => original_pointer(&pins, ROOT, DOT_GIT)?,
        };
        if versions[dot_git].before.links != 1 || versions[dot_git].metadata != observed {
            return Err(error("unsupportedGit"));
        }
        let mut edges = vec![
            edge(&pins, ROOT, dot_git, Some(DOT_GIT))?,
            edge(&pins, COMMON_PARENT, COMMON, Some(DOT_GIT))?,
        ];
        match kind {
            Kind::Main => {
                if scope.git.identity() != scope.common.identity()
                    || scope.git.guid_path != scope.common.guid_path
                    || scope.root.identity() != scope.common_parent.identity()
                    || !scope
                        .absent
                        .contains(&scope.git.guid_path.join("commondir"))
                    || !scope.absent.contains(&scope.git.guid_path.join("gitdir"))
                {
                    return Err(error("unsupportedGit"));
                }
            }
            Kind::Linked => {
                if scope.git.identity() == scope.common.identity() {
                    return Err(error("unsupportedGit"));
                }
                edges.push(edge(&pins, COMMON, extra, Some(WORKTREES))?);
                edges.push(edge(&pins, extra, GIT, None)?);
                let commondir = original_pointer(&pins, GIT, COMMONDIR)?;
                let back = original_pointer(&pins, GIT, BACK)?;
                pointer_target(&pins, commondir, &scope.common, false)?;
                pointer_target(&pins, back, pins[dot_git], true)?;
            }
        }
        let result = Self {
            kind,
            dot_git,
            versions,
            edges,
            worktrees,
        };
        result.verify(source)?;
        Ok(result)
    }
    #[cfg(test)]
    pub(in crate::worktrees) fn matches_material_edge(
        &self,
        root: &File,
        raw: &[u16],
        listed: &crate::file_access::DirectoryObservation,
    ) -> Result<()> {
        let original_root = &self.versions[ROOT];
        let edge = self.edges.first().ok_or(error("recoveryChanged"))?;
        if edge.parent != ROOT
            || edge.child != self.dot_git
            || raw != edge.raw
            || !ascii_same(raw, DOT_GIT)
            || stamp(root).map_err(|_| error("recoveryChanged"))? != original_root.before
            || metadata_file(root).map_err(|_| error("recoveryChanged"))? != original_root.metadata
        {
            return Err(error("recoveryChanged"));
        }
        let child = &self.versions[self.dot_git];
        child.verify()?;
        let actual = child_metadata(root, raw)?;
        // Listing versions may be cached. Current complete metadata comes from
        // the held object + this actual relative query, not cached timestamps.
        if actual != child.metadata
            || !actual.matches_directory_identity(listed)
            || listed.reparse_tag.is_some()
            || ((listed.attributes
                & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_DIRECTORY
                != 0)
                != (actual.kind == MetadataKind::Directory))
            || stamp(root).map_err(|_| error("recoveryChanged"))? != original_root.before
        {
            return Err(error("recoveryChanged"));
        }
        child.verify()
    }
    pub(in crate::worktrees) fn verify(&self, source: &ReadContext) -> Result<()> {
        let scope = &source.scope;
        scope.verify()?;
        source
            .selected_program()
            .verify()
            .map_err(|_| error("recoveryChanged"))?;
        for (index, pin) in [
            (ROOT, &scope.root),
            (GIT, &scope.git),
            (COMMON, &scope.common),
            (COMMON_PARENT, &scope.common_parent),
            (PROGRAM, source.selected_program()),
        ] {
            if self.versions[index].before.identity != *pin.identity() {
                return Err(error("recoveryChanged"));
            }
        }
        if self.edges.len()
            != match self.kind {
                Kind::Main => 2,
                Kind::Linked => 4,
            }
            || self.versions[self.dot_git].before.regular != matches!(self.kind, Kind::Linked)
        {
            return Err(error("recoveryChanged"));
        }
        if let Some(worktrees) = &self.worktrees {
            worktrees.verify().map_err(|_| error("recoveryChanged"))?;
        }
        for version in &self.versions {
            version.verify()?;
        }
        for edge in &self.edges {
            let actual = child_metadata(&self.versions[edge.parent].file, &edge.raw)?;
            if actual != self.versions[edge.child].metadata {
                return Err(error("recoveryChanged"));
            }
        }
        // Close the read interval after all relative-edge observations too.
        for version in &self.versions {
            version.verify()?;
        }
        scope.verify()
    }
}
