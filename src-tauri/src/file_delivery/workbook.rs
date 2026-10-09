//! Passive spreadsheet capture; only XML parts are returned to its parser.
use super::{VerifiedFile, ooxml_archive};
pub use ooxml_archive::{
    ArchiveCapture as WorkbookCapture, ArchiveError as WorkbookError,
    ArchiveReadFailure as WorkbookReadFailure,
};

pub fn read_workbook(file: &VerifiedFile) -> Result<WorkbookCapture, WorkbookError> {
    ooxml_archive::read_archive(file, |name, _| Ok(xml_part(name)))
}
fn xml_part(name: &str) -> bool {
    name.ends_with(".xml") || name.ends_with(".rels")
}

#[cfg(test)]
use super::DeliveryError;
#[cfg(test)]
use ooxml_archive::MAX_PART;
#[cfg(test)]
use std::io::Cursor;
#[cfg(test)]
fn unpack(bytes: &[u8]) -> Result<ooxml_archive::Unpacked, WorkbookError> {
    ooxml_archive::unpack(bytes, |name, _| Ok(xml_part(name)))
}

#[cfg(test)]
#[path = "workbook_tests.rs"]
mod tests;
