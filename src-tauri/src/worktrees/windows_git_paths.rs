//! DOS spellings of already selected, held objects; never program selection.
use crate::file_access::{PinnedPath, Stamp, stamp};
use crate::worktrees::types::{Result, error};
use std::{
    fs::File,
    path::{Path, PathBuf},
};

struct Pair {
    // Metadata-only duplicate of the original FileObject. Never read/seek it.
    original: File,
    alias: PinnedPath,
    plain: PathBuf,
    guid: PathBuf,
    before: Stamp,
}
fn plain_drive(extended: &str) -> Result<PathBuf> {
    // This spelling is eligible ONLY after it came from the selected pin.
    // A strict parse plus the held reopen below is required, never a fallback.
    let text = extended.strip_prefix(r"\\?\").ok_or(error("changed"))?;
    let bytes = text.as_bytes();
    if text.contains('/')
        || bytes.len() < 3
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || bytes[2] != b'\\'
        || (!text[3..].is_empty()
            && text[3..]
                .split('\\')
                .any(|part| part.is_empty() || part == "." || part == ".."))
    {
        return Err(error("changed"));
    }
    let plain = PathBuf::from(text);
    // Also rejects ADS, control/reserved names, trailing dot/space and names
    // exceeding the original UTF-16 component bound. A drive root stays valid.
    crate::file_access::absolute(&plain).map_err(|_| error("changed"))?;
    Ok(plain)
}
fn reopen(path: &Path, regular: bool) -> Result<PinnedPath> {
    let opened = if regular {
        PinnedPath::regular(path)
    } else {
        PinnedPath::git_directory(path)
    };
    opened.map_err(|_| error("changed"))
}
impl Pair {
    fn new(pin: &PinnedPath) -> Result<Self> {
        pin.verify().map_err(|_| error("changed"))?;
        let before = stamp(pin.file()).map_err(|_| error("changed"))?;
        let plain = plain_drive(&pin.path)?;
        let alias = reopen(&plain, before.regular)?;
        let value = Self {
            original: pin.file().try_clone().map_err(|_| error("changed"))?,
            alias,
            plain,
            guid: pin.guid_path.clone(),
            before,
        };
        value.verify()?;
        Ok(value)
    }
    fn verify(&self) -> Result<()> {
        self.alias.verify().map_err(|_| error("changed"))?;
        let left = stamp(&self.original).map_err(|_| error("changed"))?;
        let right = stamp(self.alias.file()).map_err(|_| error("changed"))?;
        // Directories in the owned private repository may legitimately change
        // during init/ref/index operations. Pair full stamps at each endpoint;
        // do not invent a cross-command immutable-directory requirement.
        if left.identity != self.before.identity
            || left != right
            || self.alias.guid_path != self.guid
            || (self.before.regular && left != self.before)
        {
            return Err(error("changed"));
        }
        // Query the DOS namespace again; verifying an old handle alone would
        // miss a changed drive mapping. No fallback or lossy path conversion.
        let fresh = reopen(&self.plain, self.before.regular)?;
        if fresh.guid_path != self.guid
            || fresh.path != self.alias.path
            || stamp(fresh.file()).map_err(|_| error("changed"))? != left
        {
            return Err(error("changed"));
        }
        Ok(())
    }
}
pub(in crate::worktrees) struct Paths {
    pairs: Vec<Pair>,
}
impl Paths {
    pub(in crate::worktrees) fn new(pins: &[&PinnedPath]) -> Result<Self> {
        let pairs = pins
            .iter()
            .map(|pin| Pair::new(pin))
            .collect::<Result<Vec<_>>>()?;
        Ok(Self { pairs })
    }
    pub(in crate::worktrees) fn path(&self, pin: &PinnedPath) -> Result<&Path> {
        self.pairs
            .iter()
            .find(|pair| pair.guid == pin.guid_path && pair.before.identity == *pin.identity())
            .map(|pair| pair.plain.as_path())
            .ok_or(error("changed"))
    }
    pub(in crate::worktrees) fn verify(&self) -> Result<()> {
        for pair in &self.pairs {
            pair.verify()?;
        }
        Ok(())
    }
}
#[cfg(test)]
#[path = "windows_git_paths_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "windows_git_plain_paths_tests.rs"]
mod plain_tests;
