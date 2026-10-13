//! Whole selected PDF bytes for explicit text extraction, never a file URL or
//! a claim that the parser has read the document successfully.
use super::{DeliveryError, MAX_FILE_BYTES, VerifiedFile, capture_expected};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfInputCapture {
    pub file: VerifiedFile,
    pub data: String,
}

#[derive(Debug)]
pub enum PdfInputError {
    File(DeliveryError),
    Invalid,
}

#[derive(Debug, Serialize)]
pub struct PdfInputReadFailure {
    pub code: &'static str,
}

impl From<PdfInputError> for PdfInputReadFailure {
    fn from(error: PdfInputError) -> Self {
        Self {
            code: match error {
                PdfInputError::File(DeliveryError::Changed) => "changed",
                PdfInputError::File(DeliveryError::TooLarge) => "limit",
                PdfInputError::File(_) => "unreadable",
                PdfInputError::Invalid => "invalid",
            },
        }
    }
}

impl PdfInputReadFailure {
    pub fn check(message: &str) -> Self {
        use crate::file_read_check::{FailureKind, classify_error};
        Self {
            code: match classify_error(message) {
                FailureKind::Pending => "readPending",
                FailureKind::Busy => "readBusy",
                FailureKind::Unavailable => "unreadable",
            },
        }
    }
}

pub fn read_pdf_input(file: &VerifiedFile) -> Result<PdfInputCapture, PdfInputError> {
    // Rechecks every identity field and the complete file digest. PDF's 32 MiB
    // cap does not widen the separate DOCX/XLSX archive-reader caps.
    let bytes = capture_expected(file, MAX_FILE_BYTES).map_err(PdfInputError::File)?;
    capture_pdf(file, bytes)
}

pub fn read_pdf_search(file: &VerifiedFile) -> Result<PdfInputCapture, PdfInputError> {
    // Search has a separate 1 MiB source budget, enforced before reading and
    // during capture, with the complete selected version checked again.
    let bytes = super::search_source::read(file).map_err(PdfInputError::File)?;
    capture_pdf(file, bytes)
}

fn capture_pdf(file: &VerifiedFile, bytes: Vec<u8>) -> Result<PdfInputCapture, PdfInputError> {
    if !bytes.starts_with(b"%PDF-") {
        return Err(PdfInputError::Invalid);
    }
    Ok(PdfInputCapture {
        file: file.clone(),
        data: STANDARD.encode(bytes),
    })
}

#[cfg(test)]
#[path = "pdf_input_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "pdf_search_tests.rs"]
mod search_tests;
