//! Explicit current-file text inspection. Receipts do not grant future reads.
use super::{DeliveryError, OpenedFile, RevisionCheck, RevisionFailure, VerifiedFile};
use std::path::Path;

pub fn inspect_text(path: &Path) -> Result<VerifiedFile, RevisionFailure> {
    let parent = path.parent().ok_or(DeliveryError::InvalidPath)?;
    capture_text(parent, path, None)
}

pub fn check_text_revision(file: &VerifiedFile) -> Result<RevisionCheck, RevisionFailure> {
    capture_text(Path::new(&file.root), Path::new(&file.path), Some(file))
        .map(|file| RevisionCheck::Verified { file })
}

fn capture_text(
    root: &Path,
    path: &Path,
    expected: Option<&VerifiedFile>,
) -> Result<VerifiedFile, RevisionFailure> {
    let opened = open_text(root, path, expected)?;
    super::capture_opened(opened, super::MAX_TEXT_BYTES)
        .map(|(file, _)| file)
        .map_err(Into::into)
}

fn open_text(
    root: &Path,
    path: &Path,
    expected: Option<&VerifiedFile>,
) -> Result<OpenedFile, RevisionFailure> {
    // Bound both the initial metadata check and any growth during capture.
    // UTF-8 validation remains in read_text; this only verifies the full source.
    super::open_source_detailed(root, path, super::MAX_TEXT_BYTES, expected).map_err(Into::into)
}

#[cfg(test)]
#[path = "text_inspection_tests.rs"]
mod tests;
