//! Passive document capture; OPC semantics and image decoding belong to the parser.
use super::{VerifiedFile, ooxml_archive};
pub use ooxml_archive::{
    ArchiveCapture as DocxCapture, ArchiveError as DocumentError,
    ArchiveReadFailure as DocxReadFailure,
};

const MAX_IMAGE: usize = 8 * 1024 * 1024;
const MAX_IMAGES: usize = 256;

pub fn read_docx(file: &VerifiedFile) -> Result<DocxCapture, DocumentError> {
    let mut images = 0;
    ooxml_archive::read_archive(file, |name, bytes| {
        if name.ends_with(".xml") || name.ends_with(".rels") {
            return Ok(true);
        }
        // These signatures select inert candidate bytes, not decoded images.
        // MIME/relationships, full container/pixel checks and successful display
        // remain mandatory in the document parser/renderer. No extension guess.
        if bytes.starts_with(b"\x89PNG\r\n\x1a\n") || bytes.starts_with(b"\xff\xd8\xff") {
            images += 1;
            if bytes.len() > MAX_IMAGE || images > MAX_IMAGES {
                return Err(DocumentError::Limit);
            }
            return Ok(true);
        }
        // Still decompressed and CRC-checked by the common reader. The manifest
        // lets the parser reject unsupported or missing referenced resources.
        Ok(false)
    })
}

#[cfg(test)]
#[path = "document_tests.rs"]
mod tests;
