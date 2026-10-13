//! Complete, version-checked source bytes for explicitly selected local searches.
use super::{DeliveryError, MAX_TEXT_BYTES, OpenedFile, VerifiedFile};
use std::path::Path;

pub(super) fn read(file: &VerifiedFile) -> Result<Vec<u8>, DeliveryError> {
    capture(file, open(file)?)
}

pub(super) fn open(file: &VerifiedFile) -> Result<OpenedFile, DeliveryError> {
    let opened = super::open_source_detailed(
        Path::new(&file.root),
        Path::new(&file.path),
        MAX_TEXT_BYTES,
        Some(file),
    )
    .map_err(|error| match error.delivery {
        DeliveryError::OutsideRoot => DeliveryError::Changed,
        error => error,
    })?;
    // Check the saved location and object stamp before reading its body. The
    // supplied hash is only a stamp input here; capture checks actual bytes next.
    if opened.before.size != file.size
        || opened.resolved.file_name().and_then(|name| name.to_str()) != Some(file.name.as_str())
        || super::version(&opened, &file.sha256)? != file.version
    {
        return Err(DeliveryError::Changed);
    }
    Ok(opened)
}

pub(super) fn capture(
    expected: &VerifiedFile,
    opened: OpenedFile,
) -> Result<Vec<u8>, DeliveryError> {
    let (current, bytes) = super::capture_opened(opened, MAX_TEXT_BYTES)?;
    if current != *expected {
        return Err(DeliveryError::Changed);
    }
    Ok(bytes)
}
