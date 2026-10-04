//! User-facing file verification and delivery. This is not an Agent file tool.
//!
//! Callers may offer only an explicit user choice or a structured local resource
//! associated with the current task, never a path guessed from tool prose.
//! `root` is the task working directory or a directory explicitly selected by
//! the user. It is not an operating-system sandbox for the external Agent.
//!
//! Receipts are transient, revalidated claims, not access tokens or persisted
//! event history. The invoking UI remains responsible for root authorization.

use std::ffi::{CString, OsStr};
use std::fs::{self, File, Metadata};
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct Stamp {
    device: u64,
    inode: u64,
    size: u64,
    modified_seconds: i64,
    modified_nanos: i64,
    changed_seconds: i64,
    changed_nanos: i64,
}

impl From<&Metadata> for Stamp {
    fn from(meta: &Metadata) -> Self {
        Self {
            device: meta.dev(),
            inode: meta.ino(),
            size: meta.len(),
            modified_seconds: meta.mtime(),
            modified_nanos: meta.mtime_nsec(),
            changed_seconds: meta.ctime(),
            changed_nanos: meta.ctime_nsec(),
        }
    }
}

fn absolute(path: &Path) -> Result<(), DeliveryError> {
    if !path.is_absolute() || path.as_os_str().as_bytes().contains(&0) {
        return Err(DeliveryError::InvalidPath);
    }
    Ok(())
}

fn path_text(path: &Path) -> Result<String, DeliveryError> {
    path.to_str()
        .map(str::to_owned)
        .ok_or(DeliveryError::InvalidPath)
}

fn c_name(name: &OsStr) -> Result<CString, DeliveryError> {
    CString::new(name.as_bytes()).map_err(|_| DeliveryError::InvalidPath)
}

/// Every directory component is opened relative to an owned descriptor with
/// O_NOFOLLOW. Canonicalization alone would leave a symlink replacement race.
fn open_directory(path: &Path) -> Result<File, DeliveryError> {
    absolute(path)?;
    let mut directory = File::open("/").map_err(|_| DeliveryError::Unreadable)?;
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => {
                let name = c_name(name)?;
                // SAFETY: descriptor and NUL-terminated name are live; the
                // returned descriptor has one owner after from_raw_fd.
                let fd = unsafe {
                    libc::openat(
                        directory.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if fd < 0 {
                    return Err(DeliveryError::Changed);
                }
                // SAFETY: successful openat returned a new owned descriptor.
                directory = unsafe { File::from_raw_fd(fd) };
            }
            _ => return Err(DeliveryError::InvalidPath),
        }
    }
    Ok(directory)
}

fn same_object(left: &Metadata, right: &Metadata) -> bool {
    left.dev() == right.dev() && left.ino() == right.ino()
}

struct OpenedFile {
    root: PathBuf,
    requested: PathBuf,
    resolved: PathBuf,
    root_handle: File,
    file: File,
    before: Stamp,
}

fn open_source(root: &Path, path: &Path, max: u64) -> Result<OpenedFile, DeliveryError> {
    absolute(root)?;
    let root = root.canonicalize().map_err(|_| DeliveryError::Unreadable)?;
    let root_handle = open_directory(&root)?;
    let requested = if path.is_absolute() {
        path.to_owned()
    } else {
        root.join(path)
    };
    absolute(&requested)?;
    let resolved = requested
        .canonicalize()
        .map_err(|_| DeliveryError::Unreadable)?;
    if !resolved.starts_with(&root) || resolved == root {
        return Err(DeliveryError::OutsideRoot);
    }
    let relative = resolved
        .strip_prefix(&root)
        .map_err(|_| DeliveryError::OutsideRoot)?;
    let mut directory = root_handle
        .try_clone()
        .map_err(|_| DeliveryError::Unreadable)?;
    let mut components = relative.components().peekable();
    let file = loop {
        let Component::Normal(name) = components.next().ok_or(DeliveryError::InvalidPath)? else {
            return Err(DeliveryError::InvalidPath);
        };
        let name = c_name(name)?;
        let last = components.peek().is_none();
        let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        // O_NONBLOCK prevents a FIFO swapped into the last component from
        // blocking before fstat can reject it as not a regular file.
        let flags = flags
            | if last {
                libc::O_NONBLOCK
            } else {
                libc::O_DIRECTORY
            };
        // SAFETY: both borrowed inputs outlive this call; the fresh descriptor
        // is immediately transferred to File on success.
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(DeliveryError::Changed);
        }
        // SAFETY: successful openat returned a new owned descriptor.
        let opened = unsafe { File::from_raw_fd(fd) };
        if last {
            break opened;
        }
        directory = opened;
    };
    let metadata = file.metadata().map_err(|_| DeliveryError::Unreadable)?;
    if !metadata.is_file() {
        return Err(DeliveryError::NotFile);
    }
    if metadata.len() > max {
        return Err(DeliveryError::TooLarge);
    }
    Ok(OpenedFile {
        root,
        requested,
        resolved,
        root_handle,
        file,
        before: Stamp::from(&metadata),
    })
}

fn recheck(opened: &OpenedFile) -> Result<(), DeliveryError> {
    let current = opened.file.metadata().map_err(|_| DeliveryError::Changed)?;
    if !current.is_file() || Stamp::from(&current) != opened.before {
        return Err(DeliveryError::Changed);
    }
    let root_now = open_directory(&opened.root).map_err(|_| DeliveryError::Changed)?;
    let root_before = opened
        .root_handle
        .metadata()
        .map_err(|_| DeliveryError::Changed)?;
    if !same_object(
        &root_before,
        &root_now.metadata().map_err(|_| DeliveryError::Changed)?,
    ) {
        return Err(DeliveryError::Changed);
    }
    let resolved = opened
        .requested
        .canonicalize()
        .map_err(|_| DeliveryError::Changed)?;
    if resolved != opened.resolved || !resolved.starts_with(&opened.root) {
        return Err(DeliveryError::Changed);
    }
    let current_path = fs::metadata(&resolved).map_err(|_| DeliveryError::Changed)?;
    if Stamp::from(&current_path) != opened.before {
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
    let root = opened
        .root_handle
        .metadata()
        .map_err(|_| DeliveryError::Unreadable)?;
    let stamp = &opened.before;
    let identity = format!(
        "v1:{}:{}:{}:{}:{}:{}:{}:{}:{}:{}",
        root.dev(),
        root.ino(),
        stamp.device,
        stamp.inode,
        stamp.size,
        stamp.modified_seconds,
        stamp.modified_nanos,
        stamp.changed_seconds,
        stamp.changed_nanos,
        sha256,
    );
    Ok(content_hash(identity.as_bytes()))
}

fn capture(root: &Path, path: &Path, max: u64) -> Result<(VerifiedFile, Vec<u8>), DeliveryError> {
    let mut opened = open_source(root, path, max)?;
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
    capture(root, path, MAX_FILE_BYTES).map(|(file, _)| file)
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
    capture_expected(file, MAX_FILE_BYTES)?;
    Ok(file.resolved_path.clone())
}

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Only removes the exact temporary filename it created, anchored to the same
/// owned destination-directory descriptor even if an ancestor is renamed.
struct TemporaryExport {
    directory: File,
    name: CString,
    file: File,
    published: bool,
}

impl Drop for TemporaryExport {
    fn drop(&mut self) {
        if self.published {
            return;
        }
        // SAFETY: directory/name remain live and this name was created by us.
        unsafe { libc::unlinkat(self.directory.as_raw_fd(), self.name.as_ptr(), 0) };
    }
}

impl TemporaryExport {
    fn create(directory: File) -> Result<Self, DeliveryError> {
        for _ in 0..16 {
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let name = CString::new(format!(
                ".farfold-export-{}-{sequence}.tmp",
                std::process::id()
            ))
            .map_err(|_| DeliveryError::WriteFailed)?;
            // SAFETY: valid directory/name and mode; O_EXCL refuses existing
            // files, directories and symlinks. No user pathname is removed.
            let fd = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o600,
                )
            };
            if fd >= 0 {
                return Ok(Self {
                    directory,
                    name,
                    // SAFETY: openat returned a fresh owned descriptor.
                    file: unsafe { File::from_raw_fd(fd) },
                    published: false,
                });
            }
            if std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) {
                return Err(DeliveryError::WriteFailed);
            }
        }
        Err(DeliveryError::WriteFailed)
    }

    fn publish(&mut self, name: &OsStr) -> Result<(), DeliveryError> {
        let name = c_name(name)?;
        // macOS no-replace rename makes a complete file visible only after
        // write_all and sync_all, without requiring hard-link support. An
        // unsupported filesystem fails safely; there is no replacing fallback.
        // SAFETY: both names and the shared directory descriptor remain valid.
        let result = unsafe {
            libc::renameatx_np(
                self.directory.as_raw_fd(),
                self.name.as_ptr(),
                self.directory.as_raw_fd(),
                name.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        if result == 0 {
            self.published = true;
            Ok(())
        } else if std::io::Error::last_os_error().raw_os_error() == Some(libc::EEXIST) {
            Err(DeliveryError::AlreadyExists)
        } else {
            Err(DeliveryError::WriteFailed)
        }
    }
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
    if !same_object(
        &directory.metadata().map_err(|_| error)?,
        &current.metadata().map_err(|_| error)?,
    ) {
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
    let mut temporary = TemporaryExport::create(directory)?;
    temporary
        .file
        .write_all(bytes)
        .map_err(|_| DeliveryError::WriteFailed)?;
    temporary
        .file
        .sync_all()
        .map_err(|_| DeliveryError::WriteFailed)?;
    check_destination_parent(requested_parent, &parent, &temporary.directory, false)?;
    temporary.publish(name)?;
    // A rename/replaced parent racing publication must not yield a receipt
    // claiming the old location. Publication may have happened: report that
    // distinction explicitly and leave the source and completed copy intact.
    check_destination_parent(requested_parent, &parent, &temporary.directory, true)?;
    let published_file =
        fs::metadata(&resolved_destination).map_err(|_| DeliveryError::DestinationChanged)?;
    if !same_object(
        &temporary
            .file
            .metadata()
            .map_err(|_| DeliveryError::DestinationChanged)?,
        &published_file,
    ) {
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

pub fn copy(file: &VerifiedFile, destination: &Path) -> Result<DeliveryReceipt, DeliveryError> {
    let bytes = capture_expected(file, MAX_FILE_BYTES)?;
    write_new(
        &bytes,
        destination,
        DeliveryKind::FileCopy,
        Some(file.version.clone()),
    )
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
