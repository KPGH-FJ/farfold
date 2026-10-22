//! The same read context's metadata pins, excluding exactly two linked pointers.
use super::*;
use crate::file_access::Identity;

pub(in crate::worktrees) struct MoveMetadata {
    pub(in crate::worktrees) git: PinnedPath,
    pub(in crate::worktrees) common: PinnedPath,
    _common_parent: PinnedPath,
    pointers: Vec<PinnedPath>,
    absent: Vec<PathBuf>,
}
impl Scope {
    pub(in crate::worktrees) fn into_move_metadata(
        self,
        forward: &Identity,
        backward: &Identity,
    ) -> Result<MoveMetadata> {
        self.verify()?;
        if forward == backward
            || !self.pointers.iter().any(|p| p.identity() == forward)
            || !self.pointers.iter().any(|p| p.identity() == backward)
        {
            return Err(error("changed"));
        }
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
            .filter(|p| p.identity() != forward && p.identity() != backward)
            .collect();
        // Ordinary root pins deny DELETE sharing. Release ONLY those root and
        // pointer FileObjects before acquiring the dedicated move authority.
        drop((root, _selected));
        let metadata = MoveMetadata {
            git,
            common,
            _common_parent: common_parent,
            pointers,
            absent,
        };
        metadata.verify()?;
        Ok(metadata)
    }
}
impl MoveMetadata {
    pub(in crate::worktrees) fn verify(&self) -> Result<()> {
        for pin in [&self.git, &self.common, &self._common_parent]
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
}
