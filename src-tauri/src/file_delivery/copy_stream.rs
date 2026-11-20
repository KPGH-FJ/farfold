//! Streaming to an unpublished, exclusively created file; publication has one owner.
use super::*;

pub(crate) enum CopyOutcome {
    Completed(Box<DeliveryReceipt>),
    Cancelled,
    Failed(DeliveryError),
    Unknown(DeliveryError),
    CleanupUnknown,
}

pub(crate) fn stream_copy(
    file: &VerifiedFile,
    destination: &Path,
    cancelled: impl Fn() -> bool,
    claim_publication: impl Fn() -> bool,
    progress: impl Fn(u64),
) -> CopyOutcome {
    let prepare = || -> Result<(TemporaryExport, PathBuf, String), DeliveryError> {
        absolute(destination).map_err(|_| DeliveryError::InvalidDestination)?;
        let requested_parent = destination
            .parent()
            .ok_or(DeliveryError::InvalidDestination)?;
        let parent = requested_parent
            .canonicalize()
            .map_err(|_| DeliveryError::InvalidDestination)?;
        destination
            .file_name()
            .ok_or(DeliveryError::InvalidDestination)?;
        // The receipt acknowledges the user's exact selected location. Its
        // canonical parent and final object are checked before returning it.
        let destination_text = path_text(destination)?;
        let directory = open_directory(&parent).map_err(|_| DeliveryError::InvalidDestination)?;
        let temporary =
            TemporaryExport::create(directory).map_err(|_| DeliveryError::WriteFailed)?;
        Ok((temporary, parent, destination_text))
    };
    if cancelled() {
        return CopyOutcome::Cancelled;
    }
    let (mut temporary, parent, destination_text) = match prepare() {
        Ok(value) => value,
        Err(error) => return CopyOutcome::Failed(error),
    };
    let checked = (|| {
        stream::expected(file, |bytes, total| {
            if cancelled() {
                return Err(DeliveryError::Unavailable);
            }
            if total > file.size {
                return Err(DeliveryError::Changed);
            }
            temporary
                .file
                .write_all(bytes)
                .map_err(|_| DeliveryError::WriteFailed)?;
            progress(total);
            Ok(())
        })?;
        temporary
            .file
            .sync_all()
            .map_err(|_| DeliveryError::WriteFailed)?;
        check_destination_parent(
            destination
                .parent()
                .ok_or(DeliveryError::InvalidDestination)?,
            &parent,
            &temporary.directory,
            false,
        )
        .map_err(|_| DeliveryError::DestinationChanged)
    })();
    if let Err(error) = checked {
        if temporary.discard().is_err() {
            return CopyOutcome::CleanupUnknown;
        }
        return if cancelled() {
            CopyOutcome::Cancelled
        } else {
            CopyOutcome::Failed(error)
        };
    }
    if !claim_publication() {
        return if temporary.discard().is_ok() {
            CopyOutcome::Cancelled
        } else {
            CopyOutcome::CleanupUnknown
        };
    }
    let name = match destination.file_name() {
        Some(name) => name,
        None => return CopyOutcome::Unknown(DeliveryError::InvalidDestination),
    };
    if let Err(error) = temporary.publish(name) {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            return if temporary.discard().is_ok() {
                CopyOutcome::Failed(DeliveryError::AlreadyExists)
            } else {
                CopyOutcome::CleanupUnknown
            };
        }
        // An unsuccessful publication receipt may still have side effects on
        // a remote filesystem. Preserve material and never retry or delete it.
        temporary.retain_unknown();
        return CopyOutcome::Unknown(DeliveryError::WriteFailed);
    }
    match published_receipt(
        &temporary,
        destination,
        &parent,
        DeliveryReceipt {
            kind: DeliveryKind::FileCopy,
            destination: destination_text,
            size: file.size,
            sha256: file.sha256.clone(),
            source_version: Some(file.version.clone()),
            destination_file: None,
        },
    ) {
        Ok(receipt) => CopyOutcome::Completed(Box::new(receipt)),
        Err(error) => CopyOutcome::Unknown(error),
    }
}
