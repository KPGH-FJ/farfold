//! User-facing file verification and delivery. This is not an Agent file tool.
//!
//! Callers may offer only an explicit user choice or a structured local resource
//! associated with the current task, never a path guessed from tool prose.
//! `root` is the task working directory or a directory explicitly selected by
//! the user. It is not an operating-system sandbox for the external Agent.
//!
//! Receipts are transient, revalidated claims, not access tokens or persisted
//! event history. The invoking UI remains responsible for root authorization.

use crate::file_access::{self, Stamp, TemporaryExport};
use std::ffi::OsStr;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

mod visual;
pub use visual::{VisualPreview, read_visual};
mod document;
mod ooxml_archive;
mod search_source;
pub use document::{DocxCapture, DocxReadFailure, read_docx, read_docx_search};
mod workbook;
pub use workbook::{WorkbookCapture, WorkbookReadFailure, read_workbook, read_workbook_search};
mod pdf_input;
pub use pdf_input::{PdfInputCapture, PdfInputReadFailure, read_pdf_input};
mod audio_input;
pub use audio_input::{AudioCapture, AudioReadFailure, read_audio_input};
pub(crate) use audio_input::{MAX_AUDIO_BYTES, prompt_audio_bytes};
mod revision;
pub use revision::{RevisionCheck, RevisionFailure, RevisionMode, check_revision};
mod text_inspection;
pub use text_inspection::{check_text_revision, inspect_text};
mod stream;
mod text_blocks;
pub use text_blocks::{TextBlock, TextBlockFailure, read_text_block};
mod archive_stream;
mod copy_stream;
pub(crate) use archive_stream::{ArchiveOutcome, stream_archive};
pub(crate) use copy_stream::{CopyOutcome, stream_copy};
mod selected_location;
pub(crate) use selected_location::{document_extension, selected_location};

#[cfg(test)]
#[path = "file_delivery/stream_tests.rs"]
mod stream_tests;
#[cfg(test)]
#[path = "file_delivery/text_blocks_independent_tests.rs"]
mod text_blocks_independent_tests;

pub const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_VERIFIED_FILE_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_TEXT_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryError {
    InvalidPath,
    OutsideRoot,
    NotFile,
    TooLarge,
    Changed,
    Unreadable,
    UnsupportedText,
    UnsupportedVisual,
    UnsupportedOpen,
    AlreadyExists,
    InvalidDestination,
    DestinationChanged,
    WriteFailed,
    Unavailable,
}

impl DeliveryError {
    pub fn message(self) -> &'static str {
        match self {
            Self::InvalidPath => "文件位置无效，请重新选择",
            Self::OutsideRoot => "文件不在当前工作文件夹中",
            Self::NotFile => "此位置不是普通文件",
            Self::TooLarge => "文件超过当前操作的大小限制",
            Self::Changed => "文件或位置已变化，请重新检查",
            Self::Unreadable => "文件已无法读取，请检查位置和访问权限",
            Self::UnsupportedText => "此文件无法作为文字预览，请另存或使用其他应用打开",
            Self::UnsupportedVisual => "此文件无法在这里预览，请另存或使用其他应用打开",
            Self::UnsupportedOpen => "此文件请先定位到文件夹，再选择打开方式",
            Self::AlreadyExists => "目标位置已有同名文件，请使用其他名称",
            Self::InvalidDestination => "保存位置无效，请重新选择",
            Self::DestinationChanged => "保存位置已变化，请先检查目标文件，勿重复保存",
            Self::WriteFailed => "保存未完成，原文件保持不变",
            Self::Unavailable => "无法完成文件操作，请重试",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedFile {
    pub root: String,
    /// Original absolute local path, retained to detect a redirected symlink.
    pub path: String,
    pub resolved_path: String,
    pub name: String,
    pub size: u64,
    pub sha256: String,
    /// Digest of root/file identity, modification state and content hash.
    /// Opaque to JavaScript, so 64-bit filesystem identities are not rounded.
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPreview {
    pub file: VerifiedFile,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryKind {
    FileCopy,
    TextSnapshot,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryReceipt {
    pub kind: DeliveryKind,
    pub destination: String,
    pub size: u64,
    pub sha256: String,
    /// Present only for a byte-for-byte copy of a verified disk file.
    pub source_version: Option<String>,
}

fn absolute(path: &Path) -> Result<(), DeliveryError> {
    file_access::absolute(path).map_err(|_| DeliveryError::InvalidPath)
}
fn path_text(path: &Path) -> Result<String, DeliveryError> {
    path.to_str()
        .map(str::to_owned)
        .ok_or(DeliveryError::InvalidPath)
}
fn open_directory(path: &Path) -> Result<File, DeliveryError> {
    file_access::open_directory(path).map_err(|_| DeliveryError::Changed)
}
struct OpenedFile {
    root: PathBuf,
    requested: PathBuf,
    resolved: PathBuf,
    root_handle: File,
    file: File,
    before: Stamp,
}

/// Preserve the OS error kind only for callers that need a precise read outcome.
/// Existing explicit readers keep their original DeliveryError mapping.
struct SourceOpenError {
    delivery: DeliveryError,
    cause: Option<std::io::ErrorKind>,
}
impl From<DeliveryError> for SourceOpenError {
    fn from(delivery: DeliveryError) -> Self {
        Self {
            delivery,
            cause: None,
        }
    }
}
fn source_open_error(error: std::io::Error, delivery: DeliveryError) -> SourceOpenError {
    SourceOpenError {
        delivery,
        cause: Some(error.kind()),
    }
}

fn open_source(root: &Path, path: &Path, max: u64) -> Result<OpenedFile, DeliveryError> {
    open_source_detailed(root, path, max, None).map_err(|error| error.delivery)
}

fn open_source_detailed(
    root: &Path,
    path: &Path,
    max: u64,
    expected_location: Option<&VerifiedFile>,
) -> Result<OpenedFile, SourceOpenError> {
    absolute(root)?;
    let root = root
        .canonicalize()
        .map_err(|error| source_open_error(error, DeliveryError::Unreadable))?;
    if expected_location.is_some_and(|expected| root != Path::new(&expected.root)) {
        return Err(DeliveryError::OutsideRoot.into());
    }
    let root_handle = file_access::open_directory(&root)
        .map_err(|error| source_open_error(error, DeliveryError::Changed))?;
    let requested = if path.is_absolute() {
        path.to_owned()
    } else {
        root.join(path)
    };
    absolute(&requested)?;
    let resolved = requested
        .canonicalize()
        .map_err(|error| source_open_error(error, DeliveryError::Unreadable))?;
    if !resolved.starts_with(&root) || resolved == root {
        return Err(DeliveryError::OutsideRoot.into());
    }
    if expected_location.is_some_and(|expected| {
        requested != Path::new(&expected.path) || resolved != Path::new(&expected.resolved_path)
    }) {
        return Err(DeliveryError::OutsideRoot.into());
    }
    let relative = resolved
        .strip_prefix(&root)
        .map_err(|_| DeliveryError::OutsideRoot)?;
    let file = file_access::open_relative(&root_handle, relative)
        .map_err(|error| source_open_error(error, DeliveryError::Changed))?;
    let before = file_access::stamp(&file)
        .map_err(|error| source_open_error(error, DeliveryError::Unreadable))?;
    if !before.regular {
        return Err(DeliveryError::NotFile.into());
    }
    if before.size > max {
        return Err(DeliveryError::TooLarge.into());
    }
    Ok(OpenedFile {
        root,
        requested,
        resolved,
        root_handle,
        file,
        before,
    })
}

fn recheck(opened: &OpenedFile) -> Result<(), DeliveryError> {
    let current = file_access::stamp(&opened.file).map_err(|_| DeliveryError::Changed)?;
    if !current.regular || current != opened.before {
        return Err(DeliveryError::Changed);
    }
    let root_now = open_directory(&opened.root).map_err(|_| DeliveryError::Changed)?;
    if !file_access::same_object(&opened.root_handle, &root_now)
        .map_err(|_| DeliveryError::Changed)?
    {
        return Err(DeliveryError::Changed);
    }
    let resolved = opened
        .requested
        .canonicalize()
        .map_err(|_| DeliveryError::Changed)?;
    if resolved != opened.resolved || !resolved.starts_with(&opened.root) {
        return Err(DeliveryError::Changed);
    }
    let relative = resolved
        .strip_prefix(&opened.root)
        .map_err(|_| DeliveryError::Changed)?;
    let current_path =
        file_access::open_relative(&root_now, relative).map_err(|_| DeliveryError::Changed)?;
    if file_access::stamp(&current_path).map_err(|_| DeliveryError::Changed)? != opened.before {
        return Err(DeliveryError::Changed);
    }
    Ok(())
}

fn content_hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn version(opened: &OpenedFile, sha256: &str) -> Result<String, DeliveryError> {
    let root = file_access::stamp(&opened.root_handle).map_err(|_| DeliveryError::Unreadable)?;
    let stamp = &opened.before;
    let identity = format!(
        "v1:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}",
        root.identity.device,
        root.identity.inode,
        stamp.identity.device,
        stamp.identity.inode,
        stamp.size,
        stamp.modified.0,
        stamp.modified.1,
        stamp.changed.0,
        stamp.changed.1,
        sha256,
    );
    Ok(content_hash(identity.as_bytes()))
}

fn capture(root: &Path, path: &Path, max: u64) -> Result<(VerifiedFile, Vec<u8>), DeliveryError> {
    capture_opened(open_source(root, path, max)?, max)
}

fn capture_opened(
    mut opened: OpenedFile,
    max: u64,
) -> Result<(VerifiedFile, Vec<u8>), DeliveryError> {
    let mut bytes = Vec::with_capacity(opened.before.size as usize);
    (&mut opened.file)
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| DeliveryError::Unreadable)?;
    if bytes.len() as u64 > max {
        return Err(DeliveryError::TooLarge);
    }
    recheck(&opened)?;
    if bytes.len() as u64 != opened.before.size {
        return Err(DeliveryError::Changed);
    }
    let sha256 = content_hash(&bytes);
    let receipt = VerifiedFile {
        root: path_text(&opened.root)?,
        path: path_text(&opened.requested)?,
        resolved_path: path_text(&opened.resolved)?,
        name: opened
            .resolved
            .file_name()
            .and_then(OsStr::to_str)
            .ok_or(DeliveryError::InvalidPath)?
            .to_owned(),
        size: bytes.len() as u64,
        version: version(&opened, &sha256)?,
        sha256,
    };
    Ok((receipt, bytes))
}

pub fn inspect(root: &Path, path: &Path) -> Result<VerifiedFile, DeliveryError> {
    stream::verify(open_source(root, path, MAX_VERIFIED_FILE_BYTES)?, |_, _| {
        Ok(())
    })
}

/// Recheck one explicit unsent attachment using the same safe path handling.
/// Links carry no file contents, so retain their existing lack of a content
/// size limit. Embedded text keeps the smaller attachment-specific limit.
pub(crate) fn check_attachment(
    root: &Path,
    path: &Path,
    embed: bool,
) -> Result<Option<String>, DeliveryError> {
    if !embed {
        let opened = open_source(root, path, u64::MAX)?;
        recheck(&opened)?;
        return Ok(None);
    }
    const MAX_ATTACHMENT_TEXT_BYTES: u64 = 256 * 1024;
    let (_, bytes) = capture(root, path, MAX_ATTACHMENT_TEXT_BYTES)?;
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| DeliveryError::UnsupportedText)
}

/// Read only a bounded format prefix of one explicit attachment. Large ordinary
/// file links remain usable without loading their contents into the UI.
pub(crate) fn attachment_prefix(root: &Path, path: &Path) -> Result<Vec<u8>, DeliveryError> {
    let mut opened = open_source(root, path, u64::MAX)?;
    let mut bytes = Vec::new();
    (&mut opened.file)
        .take(32)
        .read_to_end(&mut bytes)
        .map_err(|_| DeliveryError::Unreadable)?;
    recheck(&opened)?;
    Ok(bytes)
}

/// The caller chooses a smaller media limit; all bytes use the same safe path
/// and identity checks as ordinary user-selected file reads.
pub(crate) fn attachment_bytes(
    root: &Path,
    path: &Path,
    max: u64,
) -> Result<Vec<u8>, DeliveryError> {
    capture(root, path, max).map(|(_, bytes)| bytes)
}

fn capture_expected(file: &VerifiedFile, max: u64) -> Result<Vec<u8>, DeliveryError> {
    let (current, bytes) = capture(Path::new(&file.root), Path::new(&file.path), max)?;
    if current != *file {
        return Err(DeliveryError::Changed);
    }
    Ok(bytes)
}

pub fn read_text(file: &VerifiedFile) -> Result<TextPreview, DeliveryError> {
    let bytes = capture_expected(file, MAX_TEXT_BYTES)?;
    let text = String::from_utf8(bytes).map_err(|_| DeliveryError::UnsupportedText)?;
    Ok(TextPreview {
        file: file.clone(),
        text,
    })
}

/// Returns only a freshly verified canonical path for an explicit user action.
/// The caller must invoke the existing platform opener immediately; validation
/// cannot promise that another process will not change a path afterwards.
pub fn revalidate_for_open(file: &VerifiedFile) -> Result<String, DeliveryError> {
    stream::expected(file, |_, _| Ok(()))?;
    Ok(file.resolved_path.clone())
}

fn check_destination_parent(
    requested: &Path,
    resolved: &Path,
    directory: &File,
    committed: bool,
) -> Result<(), DeliveryError> {
    let error = if committed {
        DeliveryError::DestinationChanged
    } else {
        DeliveryError::Changed
    };
    if requested.canonicalize().map_err(|_| error)? != resolved {
        return Err(error);
    }
    let current = open_directory(resolved).map_err(|_| error)?;
    if !file_access::same_object(directory, &current).map_err(|_| error)? {
        return Err(error);
    }
    Ok(())
}

fn write_new(
    bytes: &[u8],
    destination: &Path,
    kind: DeliveryKind,
    source_version: Option<String>,
) -> Result<DeliveryReceipt, DeliveryError> {
    absolute(destination).map_err(|_| DeliveryError::InvalidDestination)?;
    let requested_parent = destination
        .parent()
        .ok_or(DeliveryError::InvalidDestination)?;
    let parent = requested_parent
        .canonicalize()
        .map_err(|_| DeliveryError::InvalidDestination)?;
    let name = destination
        .file_name()
        .ok_or(DeliveryError::InvalidDestination)?;
    let resolved_destination = parent.join(name);
    let destination_text = path_text(&resolved_destination)?;
    let directory = open_directory(&parent).map_err(|_| DeliveryError::InvalidDestination)?;
    let mut temporary =
        TemporaryExport::create(directory).map_err(|_| DeliveryError::WriteFailed)?;
    temporary
        .file
        .write_all(bytes)
        .map_err(|_| DeliveryError::WriteFailed)?;
    temporary
        .file
        .sync_all()
        .map_err(|_| DeliveryError::WriteFailed)?;
    check_destination_parent(requested_parent, &parent, &temporary.directory, false)?;
    temporary.publish(name).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            DeliveryError::AlreadyExists
        } else {
            DeliveryError::WriteFailed
        }
    })?;
    // A rename/replaced parent racing publication must not yield a receipt
    // claiming the old location. Publication may have happened: report that
    // distinction explicitly and leave the source and completed copy intact.
    check_destination_parent(requested_parent, &parent, &temporary.directory, true)?;
    let published_file = file_access::open_relative(&temporary.directory, Path::new(name))
        .map_err(|_| DeliveryError::DestinationChanged)?;
    if !file_access::same_object(&temporary.file, &published_file)
        .map_err(|_| DeliveryError::DestinationChanged)?
    {
        return Err(DeliveryError::DestinationChanged);
    }
    Ok(DeliveryReceipt {
        kind,
        destination: destination_text,
        size: bytes.len() as u64,
        sha256: content_hash(bytes),
        source_version,
    })
}

#[cfg(test)]
pub fn copy(file: &VerifiedFile, destination: &Path) -> Result<DeliveryReceipt, DeliveryError> {
    match stream_copy(file, destination, || false, || true, |_| {}) {
        CopyOutcome::Completed(receipt) => Ok(receipt),
        CopyOutcome::Failed(error) | CopyOutcome::Unknown(error) => Err(error),
        CopyOutcome::Cancelled => Err(DeliveryError::Unavailable),
        CopyOutcome::CleanupUnknown => Err(DeliveryError::DestinationChanged),
    }
}

/// Exports exactly the text the user chose. It neither reads a disk source nor
/// claims the selected text/diff is a complete file on disk.
pub fn export_text(text: &str, destination: &Path) -> Result<DeliveryReceipt, DeliveryError> {
    if text.len() as u64 > MAX_TEXT_BYTES {
        return Err(DeliveryError::TooLarge);
    }
    write_new(
        text.as_bytes(),
        destination,
        DeliveryKind::TextSnapshot,
        None,
    )
}

#[cfg(test)]
#[path = "file_delivery_tests.rs"]
mod tests;
