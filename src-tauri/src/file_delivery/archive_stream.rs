//! Portable ZIP bytes, anchored exclusive publication, no shell or remote fetch.
use super::*;
use crate::file_archive::{input, manifest, types::*};
use base64::engine::general_purpose::STANDARD;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

pub(crate) enum ArchiveOutcome {
    Completed(Receipt),
    Cancelled,
    Failed(&'static str, Option<String>),
    Unknown(&'static str, Option<String>),
}
struct Written {
    size: u64,
    sha256: String,
    manifest_sha256: String,
}
struct HashWriter<'a, W> {
    inner: W,
    cancelled: &'a dyn Fn() -> bool,
    hash: Sha256,
    bytes: u64,
}
impl<W: Write> Write for HashWriter<'_, W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if (self.cancelled)() || self.bytes.saturating_add(bytes.len() as u64) > input::ZIP_BYTES {
            return Err(std::io::Error::other("archive write stopped"));
        }
        let n = self.inner.write(bytes)?;
        self.hash.update(&bytes[..n]);
        self.bytes += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}
fn code(error: DeliveryError) -> &'static str {
    match error {
        DeliveryError::TooLarge => "tooLarge",
        DeliveryError::Changed | DeliveryError::OutsideRoot => "changed",
        DeliveryError::InvalidDestination => "invalidDestination",
        DeliveryError::DestinationChanged => "destinationChanged",
        DeliveryError::AlreadyExists => "alreadyExists",
        DeliveryError::WriteFailed => "writeFailed",
        DeliveryError::Unreadable | DeliveryError::NotFile | DeliveryError::InvalidPath => {
            "unreadable"
        }
        _ => "unavailable",
    }
}
type WriteFailure = (&'static str, Option<String>);
fn write_zip(
    file: &mut File,
    input: &Prepare,
    cancelled: &dyn Fn() -> bool,
    progress: &dyn Fn(u64, usize),
) -> Result<Written, WriteFailure> {
    let writer = HashWriter {
        inner: file,
        cancelled,
        hash: Sha256::new(),
        bytes: 0,
    };
    let mut zip = ZipWriter::new_stream(writer);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .unix_permissions(0o600);
    let failure = || ("writeFailed", None);
    zip.start_file("conversation.md", options)
        .map_err(|_| failure())?;
    zip.write_all(input.markdown.as_bytes())
        .map_err(|_| failure())?;
    let mut hashes = Vec::new();
    let mut processed = 0u64;
    for (index, selected) in input.selected.iter().enumerate() {
        if cancelled() {
            return Err(("unavailable", Some(selected.candidate_id.clone())));
        }
        let candidate = input
            .candidates
            .iter()
            .find(|c| c.candidate_id == selected.candidate_id)
            .ok_or(("invalidRequest", Some(selected.candidate_id.clone())))?;
        let member = manifest::member(index, &selected.source, &candidate.display_name);
        zip.start_file(member, options).map_err(|_| failure())?;
        let mut hash = Sha256::new();
        let expected = selected.source.size();
        let mut seen = 0u64;
        let mut consume = |bytes: &[u8], total: u64| -> Result<(), DeliveryError> {
            if cancelled() {
                return Err(DeliveryError::Unavailable);
            }
            if total > expected {
                return Err(DeliveryError::Changed);
            }
            zip.write_all(bytes)
                .map_err(|_| DeliveryError::WriteFailed)?;
            hash.update(bytes);
            seen = total;
            progress(processed + total, index);
            Ok(())
        };
        let result = match &selected.source {
            Source::Local { file, .. } => stream::expected(&file.into(), &mut consume),
            Source::InlineText { text, .. } => {
                let mut total = 0u64;
                text.as_bytes()
                    .chunks(stream::BUFFER_BYTES)
                    .try_for_each(|chunk| {
                        total += chunk.len() as u64;
                        consume(chunk, total)
                    })
            }
            Source::InlineBinary { base64, .. } => {
                // DecodeReader preserves bounded chunking; strict canonical base64 was
                // validated before ready, and the private input cannot subsequently change.
                let mut reader = base64::read::DecoderReader::new(base64.as_bytes(), &STANDARD);
                let mut buffer = [0u8; stream::BUFFER_BYTES];
                let mut total = 0u64;
                (|| {
                    loop {
                        let n = reader
                            .read(&mut buffer)
                            .map_err(|_| DeliveryError::Unreadable)?;
                        if n == 0 {
                            break;
                        }
                        total += n as u64;
                        consume(&buffer[..n], total)?;
                    }
                    Ok(())
                })()
            }
        };
        if let Err(error) = result {
            return Err((code(error), Some(selected.candidate_id.clone())));
        }
        if seen != expected {
            return Err(("changed", Some(selected.candidate_id.clone())));
        }
        hashes.push(hash.finalize().iter().map(|b| format!("{b:02x}")).collect());
        processed += seen;
        progress(processed, index + 1);
    }
    let manifest = manifest::document(input, &hashes);
    if manifest.len() > input::MANIFEST_BYTES {
        return Err(("tooLarge", None));
    }
    zip.start_file("manifest.json", options)
        .map_err(|_| failure())?;
    zip.write_all(&manifest).map_err(|_| failure())?;
    let mut writer = zip.finish().map_err(|_| failure())?.into_inner();
    writer.flush().map_err(|_| failure())?;
    Ok(Written {
        size: writer.bytes,
        sha256: writer
            .hash
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
        manifest_sha256: input::hash(&manifest),
    })
}
pub(crate) fn stream_archive(
    input: &Prepare,
    cancelled: impl Fn() -> bool,
    claim_publication: impl Fn() -> bool,
    progress: impl Fn(u64, usize),
) -> ArchiveOutcome {
    let destination = Path::new(&input.destination);
    if cancelled() {
        return ArchiveOutcome::Cancelled;
    }
    let setup = (|| -> Result<_, DeliveryError> {
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
        let directory = open_directory(&parent).map_err(|_| DeliveryError::InvalidDestination)?;
        Ok((
            TemporaryExport::create(directory).map_err(|_| DeliveryError::WriteFailed)?,
            parent,
        ))
    })();
    let (mut temporary, parent) = match setup {
        Ok(v) => v,
        Err(e) => return ArchiveOutcome::Failed(code(e), None),
    };
    // Keep the temporary owner outside the unwind boundary so cleanup has a
    // definite result rather than relying on best-effort Drop during a panic.
    let checked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let written = write_zip(&mut temporary.file, input, &cancelled, &progress)?;
        temporary
            .file
            .sync_all()
            .map_err(|_| ("writeFailed", None))?;
        check_destination_parent(
            destination.parent().ok_or(("invalidDestination", None))?,
            &parent,
            &temporary.directory,
            false,
        )
        .map_err(|e| (code(e), None))?;
        Ok::<_, WriteFailure>(written)
    }))
    .unwrap_or(Err(("unavailable", None)));
    let written = match checked {
        Ok(v) => v,
        Err((error, item)) => {
            if temporary.discard().is_err() {
                return ArchiveOutcome::Unknown("cleanupUnknown", item);
            }
            return if cancelled() {
                ArchiveOutcome::Cancelled
            } else {
                ArchiveOutcome::Failed(error, item)
            };
        }
    };
    if !claim_publication() {
        return if temporary.discard().is_ok() {
            ArchiveOutcome::Cancelled
        } else {
            ArchiveOutcome::Unknown("cleanupUnknown", None)
        };
    }
    let name = match destination.file_name() {
        Some(n) => n,
        None => return ArchiveOutcome::Unknown("invalidDestination", None),
    };
    if let Err(error) = temporary.publish(name) {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            return if temporary.discard().is_ok() {
                ArchiveOutcome::Failed("alreadyExists", None)
            } else {
                ArchiveOutcome::Unknown("cleanupUnknown", None)
            };
        }
        temporary.retain_unknown();
        return ArchiveOutcome::Unknown("writeFailed", None);
    }
    let verify = (|| -> Result<(), DeliveryError> {
        check_destination_parent(
            destination
                .parent()
                .ok_or(DeliveryError::InvalidDestination)?,
            &parent,
            &temporary.directory,
            true,
        )?;
        let mut current = file_access::open_relative(&temporary.directory, Path::new(name))
            .map_err(|_| DeliveryError::DestinationChanged)?;
        if !file_access::same_object(&temporary.file, &current)
            .map_err(|_| DeliveryError::DestinationChanged)?
        {
            return Err(DeliveryError::DestinationChanged);
        }
        let before = file_access::stamp(&current).map_err(|_| DeliveryError::DestinationChanged)?;
        if !before.regular || before.size != written.size {
            return Err(DeliveryError::DestinationChanged);
        }
        let mut hash = Sha256::new();
        let mut size = 0u64;
        let mut buffer = [0u8; stream::BUFFER_BYTES];
        loop {
            let n = current
                .read(&mut buffer)
                .map_err(|_| DeliveryError::DestinationChanged)?;
            if n == 0 {
                break;
            }
            size += n as u64;
            if size > written.size {
                return Err(DeliveryError::DestinationChanged);
            }
            hash.update(&buffer[..n]);
        }
        let digest: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
        let reopened = file_access::open_relative(&temporary.directory, Path::new(name))
            .map_err(|_| DeliveryError::DestinationChanged)?;
        if size != written.size
            || digest != written.sha256
            || file_access::stamp(&current).map_err(|_| DeliveryError::DestinationChanged)?
                != before
            || file_access::stamp(&reopened).map_err(|_| DeliveryError::DestinationChanged)?
                != before
        {
            return Err(DeliveryError::DestinationChanged);
        }
        check_destination_parent(
            destination
                .parent()
                .ok_or(DeliveryError::InvalidDestination)?,
            &parent,
            &temporary.directory,
            true,
        )
    })();
    if let Err(e) = verify {
        return ArchiveOutcome::Unknown(code(e), None);
    }
    ArchiveOutcome::Completed(Receipt {
        kind: "conversationArchive",
        destination: input.destination.clone(),
        zip_size: written.size,
        zip_sha256: written.sha256,
        manifest_sha256: written.manifest_sha256,
        included_count: input.selected.len(),
        omitted_count: input.omitted.len(),
        scope: "selectedLoadedSnapshot",
    })
}

#[cfg(test)]
#[path = "archive_write_tests.rs"]
mod tests;
