//! A metadata observation is not a new content receipt or permission to read.
use super::{DeliveryError, OpenedFile, SourceOpenError, VerifiedFile};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RevisionMode {
    Hint,
    Content,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RevisionCheck {
    /// No changed metadata was observed. No file body was read or revalidated.
    HintUnchanged,
    /// A complete protected read, including the content digest and final checks.
    Verified { file: VerifiedFile },
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct RevisionFailure {
    pub code: &'static str,
}

impl RevisionFailure {
    pub fn check(message: &str) -> Self {
        use crate::file_read_check::{FailureKind, classify_error};
        Self {
            code: match classify_error(message) {
                FailureKind::Pending => "pending",
                FailureKind::Busy => "busy",
                FailureKind::Unavailable => "unavailable",
            },
        }
    }
}
impl From<DeliveryError> for RevisionFailure {
    fn from(value: DeliveryError) -> Self {
        Self {
            code: match value {
                DeliveryError::OutsideRoot | DeliveryError::InvalidPath => "redirected",
                DeliveryError::NotFile => "notFile",
                DeliveryError::TooLarge => "tooLarge",
                DeliveryError::Changed => "changing",
                DeliveryError::Unreadable => "unreadable",
                _ => "unavailable",
            },
        }
    }
}
impl From<SourceOpenError> for RevisionFailure {
    fn from(value: SourceOpenError) -> Self {
        match value.cause {
            Some(std::io::ErrorKind::NotFound) => Self { code: "missing" },
            Some(std::io::ErrorKind::PermissionDenied) => Self { code: "unreadable" },
            _ => value.delivery.into(),
        }
    }
}

pub fn check_revision(
    file: &VerifiedFile,
    mode: RevisionMode,
) -> Result<RevisionCheck, RevisionFailure> {
    check_with_capture(file, mode, |opened| {
        super::capture_opened(opened, super::MAX_FILE_BYTES).map(|(file, _bytes)| file)
    })
}

fn check_with_capture(
    file: &VerifiedFile,
    mode: RevisionMode,
    capture: impl FnOnce(OpenedFile) -> Result<VerifiedFile, DeliveryError>,
) -> Result<RevisionCheck, RevisionFailure> {
    let opened = super::open_source_detailed(
        Path::new(&file.root),
        Path::new(&file.path),
        super::MAX_FILE_BYTES,
        Some(file),
    )?;
    // Reuse the opaque version calculation with the PREVIOUS content digest.
    // Equality observes metadata only; it cannot authorize reading, copying,
    // exporting, or claim unchanged bytes on every filesystem. The UI schedules
    // full checks on reactivation and at a lower bounded fallback frequency.
    let hint_matches = opened.before.size == file.size
        && opened.resolved.file_name().and_then(|name| name.to_str()) == Some(file.name.as_str())
        && super::version(&opened, &file.sha256)? == file.version;
    super::recheck(&opened)?;
    if mode == RevisionMode::Hint && hint_matches {
        return Ok(RevisionCheck::HintUnchanged);
    }
    // Consume the same checked handle, not a second pathname-only open.
    Ok(RevisionCheck::Verified {
        file: capture(opened)?,
    })
}

#[cfg(test)]
#[path = "revision_tests.rs"]
mod tests;
