//! Passive document capture; OPC semantics and image decoding belong to the parser.
use super::{VerifiedFile, ooxml_archive, search_source};
pub use ooxml_archive::{
    ArchiveCapture as DocxCapture, ArchiveError as DocumentError,
    ArchiveReadFailure as DocxReadFailure,
};

const MAX_IMAGE: usize = 8 * 1024 * 1024;
const MAX_IMAGES: usize = 256;

pub fn read_docx(file: &VerifiedFile) -> Result<DocxCapture, DocumentError> {
    ooxml_archive::read_archive(file, include_document_parts())
}

fn include_document_parts() -> impl FnMut(&str, &[u8]) -> Result<bool, DocumentError> {
    let mut images = 0;
    move |name, bytes| {
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
    }
}

/// Search selects one complete source of at most 1 MiB. The ordinary preview
/// keeps its larger archive limit; neither UI preflight nor a supplied size can
/// authorize a larger read here. Inflation/CRC checks retain the common limits.
pub fn read_docx_search(file: &VerifiedFile) -> Result<DocxCapture, DocumentError> {
    let bytes = search_source::read(file).map_err(DocumentError::File)?;
    let (parts, entries, inflated_bytes) = ooxml_archive::unpack(&bytes, include_document_parts())?;
    Ok(DocxCapture {
        file: file.clone(),
        parts,
        entries,
        inflated_bytes,
    })
}

#[cfg(test)]
#[path = "document_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "document_search_tests.rs"]
mod search_tests;
