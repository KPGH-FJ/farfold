//! Passive presentation capture; slide semantics and image decoding stay in the parser.
use super::{VerifiedFile, ooxml_archive, search_source};
pub use ooxml_archive::{
    ArchiveCapture as PptxCapture, ArchiveError as PresentationError,
    ArchiveReadFailure as PptxReadFailure,
};

const MAX_IMAGE: usize = 8 * 1024 * 1024;
const MAX_IMAGES: usize = 256;

pub fn read_pptx(file: &VerifiedFile) -> Result<PptxCapture, PresentationError> {
    ooxml_archive::read_archive(file, include_presentation_parts())
}

fn include_presentation_parts() -> impl FnMut(&str, &[u8]) -> Result<bool, PresentationError> {
    let mut images = 0;
    move |name, bytes| {
        // Signatures select inert candidates, including renamed parts. Neither
        // an extension nor these bytes prove a valid or supported presentation.
        if bytes.starts_with(b"\x89PNG\r\n\x1a\n") || bytes.starts_with(b"\xff\xd8\xff") {
            images += 1;
            if bytes.len() > MAX_IMAGE || images > MAX_IMAGES {
                return Err(PresentationError::Limit);
            }
            return Ok(true);
        }
        // Every entry, including discarded binaries, is bounded, inflated and
        // CRC-checked by the shared reader. The full manifest remains available
        // for OPC, unsupported-resource and missing-image checks in the parser.
        Ok(name.ends_with(".xml") || name.ends_with(".rels"))
    }
}

/// Search captures one complete, version-checked source of at most 1 MiB.
/// Preview retains its larger archive limit. Both paths validate every archive
/// entry, including binary content that is not part of the passive capture.
pub fn read_pptx_search(file: &VerifiedFile) -> Result<PptxCapture, PresentationError> {
    let bytes = search_source::read(file).map_err(PresentationError::File)?;
    let (parts, entries, inflated_bytes) =
        ooxml_archive::unpack(&bytes, include_presentation_parts())?;
    Ok(PptxCapture {
        file: file.clone(),
        parts,
        entries,
        inflated_bytes,
    })
}

#[cfg(test)]
#[path = "presentation_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "presentation_search_tests.rs"]
mod search_tests;
