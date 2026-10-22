//! Shared repository observations survive retirement of linked-tree read pins.
//! No mutation authority over common objects, refs, configuration or program.
use super::*;
use crate::file_access::{Stamp, stamp};
use std::io::{Seek, SeekFrom};

struct HeldRef {
    pin: PinnedPath,
    before: Stamp,
}
pub(in crate::worktrees) struct RemoveMetadata {
    common: PinnedPath,
    _common_parent: PinnedPath,
    pointers: Vec<PinnedPath>,
    absent: Vec<PathBuf>,
    references: Vec<HeldRef>,
}
fn text(pin: &PinnedPath) -> Result<String> {
    pin.verify().map_err(failure)?;
    let before = stamp(pin.file()).map_err(failure)?;
    if !before.regular || before.links != 1 || before.size > 4096 {
        return Err(error("unsupportedGit"));
    }
    let mut reader = pin.file().try_clone().map_err(failure)?;
    reader.seek(SeekFrom::Start(0)).map_err(failure)?;
    let mut bytes = Vec::new();
    reader.take(4097).read_to_end(&mut bytes).map_err(failure)?;
    if bytes.len() as u64 != before.size || stamp(pin.file()).map_err(failure)? != before {
        return Err(error("changed"));
    }
    String::from_utf8(bytes).map_err(|_| error("unsupportedGit"))
}
fn ref_name(value: &str) -> bool {
    value.starts_with("refs/heads/")
        && value.len() <= 4096
        && !value.contains(['\0', '\r', '\n', '\\'])
        && Path::new(value)
            .components()
            .all(|v| matches!(v, Component::Normal(_)))
}
fn selected_refs(scope: &Scope, snapshot: &Snapshot) -> Result<Vec<HeldRef>> {
    let head = scope
        .git
        .child(&"HEAD".encode_utf16().collect::<Vec<_>>(), false)
        .map_err(failure)?;
    let current = text(&head)?;
    let current = current.trim_end_matches(['\r', '\n']);
    let Some(mut name) = current.strip_prefix("ref: ").map(str::to_owned) else {
        if snapshot.branch.is_some() || snapshot.head.as_deref() != Some(current) {
            return Err(error("changed"));
        }
        return Ok(Vec::new());
    };
    let mut references: Vec<HeldRef> = Vec::new();
    loop {
        if !ref_name(&name) || references.len() == 16 {
            return Err(error("unsupportedGit"));
        }
        // A missing loose ref could be shadowed by a newly created child even
        // while its directory is pinned. Refuse that packed-only case instead
        // of claiming a directory read handle locks future child creation.
        let pin = PinnedPath::git_regular(&scope.common.guid_path.join(&name))
            .map_err(|_| error("unsupportedGit"))?;
        if !pin.has_ancestor(scope.common.identity())
            || references
                .iter()
                .any(|v| v.pin.identity() == pin.identity())
        {
            return Err(error("unsupportedGit"));
        }
        let value = text(&pin)?;
        let before = stamp(pin.file()).map_err(failure)?;
        references.push(HeldRef { pin, before });
        let value = value.trim_end_matches(['\r', '\n']);
        if let Some(next) = value.strip_prefix("ref: ") {
            name = next.to_owned();
            continue;
        }
        if !super::super::types::oid(value)
            || snapshot.head.as_deref() != Some(value)
            || snapshot.branch.as_deref() != Some(name.as_str())
        {
            return Err(error("changed"));
        }
        return Ok(references);
    }
}
impl Scope {
    pub(in crate::worktrees) fn into_remove_metadata(
        self,
        snapshot: &Snapshot,
    ) -> Result<RemoveMetadata> {
        self.matches(snapshot)?;
        let references = selected_refs(&self, snapshot)?;
        self.verify()?;
        let Self {
            root,
            git,
            common,
            common_parent,
            _selected,
            pointers,
            absent,
        } = self;
        let pointers = pointers
            .into_iter()
            .filter(|p| !p.has_ancestor(root.identity()) && !p.has_ancestor(git.identity()))
            .collect();
        let absent = absent
            .into_iter()
            .filter(|p| !p.starts_with(&root.guid_path) && !p.starts_with(&git.guid_path))
            .collect();
        // Common config and actual selected refs/program remain held. Only the
        // original linked body/private metadata read pins retire for DELETE.
        drop((root, git, _selected));
        let value = RemoveMetadata {
            common,
            _common_parent: common_parent,
            pointers,
            absent,
            references,
        };
        value.verify()?;
        Ok(value)
    }
}
impl RemoveMetadata {
    pub(in crate::worktrees) fn verify(&self) -> Result<()> {
        for pin in [&self.common, &self._common_parent]
            .into_iter()
            .chain(self.pointers.iter())
        {
            pin.verify().map_err(failure)?;
        }
        for reference in &self.references {
            reference.pin.verify().map_err(failure)?;
            if stamp(reference.pin.file()).map_err(failure)? != reference.before {
                return Err(error("changed"));
            }
        }
        for path in &self.absent {
            if !matches!(fs::symlink_metadata(path), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
            {
                return Err(error("changed"));
            }
        }
        Ok(())
    }
}
#[cfg(test)]
#[path = "windows_scope_remove_tests.rs"]
mod tests;
