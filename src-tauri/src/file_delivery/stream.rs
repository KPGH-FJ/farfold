//! Bounded ordinary-file reads. Format decoders retain their smaller limits.
use super::*;

pub(super) const BUFFER_BYTES: usize = 64 * 1024;

pub(super) fn verify(
    mut opened: OpenedFile,
    mut consume: impl FnMut(&[u8], u64) -> Result<(), DeliveryError>,
) -> Result<VerifiedFile, DeliveryError> {
    let mut buffer = [0; BUFFER_BYTES];
    let mut total = 0u64;
    let mut hash = Sha256::new();
    loop {
        let length = match opened.file.read(&mut buffer) {
            Ok(0) => break,
            Ok(length) => length,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(DeliveryError::Unreadable),
        };
        total = total
            .checked_add(length as u64)
            .ok_or(DeliveryError::TooLarge)?;
        if total > MAX_VERIFIED_FILE_BYTES {
            return Err(DeliveryError::TooLarge);
        }
        hash.update(&buffer[..length]);
        consume(&buffer[..length], total)?;
    }
    recheck(&opened)?;
    if total != opened.before.size {
        return Err(DeliveryError::Changed);
    }
    let sha256: String = hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(VerifiedFile {
        root: path_text(&opened.root)?,
        path: path_text(&opened.requested)?,
        resolved_path: path_text(&opened.resolved)?,
        name: opened
            .resolved
            .file_name()
            .and_then(OsStr::to_str)
            .ok_or(DeliveryError::InvalidPath)?
            .to_owned(),
        size: total,
        version: version(&opened, &sha256)?,
        sha256,
    })
}

pub(super) fn expected(
    file: &VerifiedFile,
    consume: impl FnMut(&[u8], u64) -> Result<(), DeliveryError>,
) -> Result<(), DeliveryError> {
    let opened = open_source_detailed(
        Path::new(&file.root),
        Path::new(&file.path),
        MAX_VERIFIED_FILE_BYTES,
        Some(file),
    )
    .map_err(|error| error.delivery)?;
    let current = verify(opened, consume)?;
    if current != *file {
        return Err(DeliveryError::Changed);
    }
    Ok(())
}
