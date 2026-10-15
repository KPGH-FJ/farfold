//! Passive presentation capture; slide semantics and image decoding stay in the parser.
use super::{VerifiedFile, ooxml_archive};
pub use ooxml_archive::{
    ArchiveCapture as PptxCapture, ArchiveError as PresentationError,
    ArchiveReadFailure as PptxReadFailure,
};

const MAX_IMAGE: usize = 8 * 1024 * 1024;
const MAX_IMAGES: usize = 256;

pub fn read_pptx(file: &VerifiedFile) -> Result<PptxCapture, PresentationError> {
    let mut images = 0;
    ooxml_archive::read_archive(file, move |name, bytes| {
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
    })
}

#[cfg(test)]
#[path = "presentation_tests.rs"]
mod tests;
