//! Passive OOXML capture. Never extracts to disk or grants a file URL.
use super::{DeliveryError, VerifiedFile, capture_expected};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;
use std::{
    collections::HashSet,
    io::{Cursor, Read},
};

pub const MAX_ARCHIVE: u64 = 16 * 1024 * 1024;
pub(super) const MAX_PART: u64 = 16 * 1024 * 1024;
const MAX_TOTAL: u64 = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 2048;

#[derive(Debug)]
pub enum ArchiveError {
    File(DeliveryError),
    Invalid,
    Limit,
    Encrypted,
    Unsupported,
}
#[derive(Debug, Serialize)]
pub struct ArchiveReadFailure {
    pub code: &'static str,
}
impl From<ArchiveError> for ArchiveReadFailure {
    fn from(error: ArchiveError) -> Self {
        let code = match error {
            ArchiveError::File(DeliveryError::Changed) => "changed",
            ArchiveError::File(DeliveryError::TooLarge) | ArchiveError::Limit => "limit",
            ArchiveError::File(_) => "unreadable",
            ArchiveError::Invalid => "invalid",
            ArchiveError::Encrypted => "encrypted",
            ArchiveError::Unsupported => "unsupported",
        };
        Self { code }
    }
}
impl ArchiveReadFailure {
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
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivePart {
    pub name: String,
    pub data: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveCapture {
    pub file: VerifiedFile,
    pub parts: Vec<ArchivePart>,
    pub entries: Vec<String>,
    pub inflated_bytes: u64,
}

pub(super) fn read_archive(
    file: &VerifiedFile,
    include: impl FnMut(&str, &[u8]) -> Result<bool, ArchiveError>,
) -> Result<ArchiveCapture, ArchiveError> {
    let bytes = capture_expected(file, MAX_ARCHIVE).map_err(ArchiveError::File)?;
    let (parts, entries, inflated_bytes) = unpack(&bytes, include)?;
    Ok(ArchiveCapture {
        file: file.clone(),
        parts,
        entries,
        inflated_bytes,
    })
}

// Inspect directory records before ZipArchive allocates its entry index. ZIP64
// and multi-volume containers are explicitly unsupported by this small reader.
fn u16_at(bytes: &[u8], at: usize) -> Result<u16, ArchiveError> {
    Ok(u16::from_le_bytes(
        bytes
            .get(at..at + 2)
            .ok_or(ArchiveError::Invalid)?
            .try_into()
            .unwrap(),
    ))
}
fn u32_at(bytes: &[u8], at: usize) -> Result<u32, ArchiveError> {
    Ok(u32::from_le_bytes(
        bytes
            .get(at..at + 4)
            .ok_or(ArchiveError::Invalid)?
            .try_into()
            .unwrap(),
    ))
}
fn checked_name(raw: &[u8]) -> Result<String, ArchiveError> {
    let name = std::str::from_utf8(raw).map_err(|_| ArchiveError::Unsupported)?;
    let trimmed = name.strip_suffix('/').unwrap_or(name);
    if name.len() > 1024
        || trimmed.is_empty()
        || name.starts_with('/')
        || name
            .chars()
            .any(|c| c.is_control() || matches!(c, '\\' | ':' | '%'))
        || trimmed
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == "..")
    {
        return Err(ArchiveError::Invalid);
    }
    Ok(name.to_owned())
}
fn directory(bytes: &[u8]) -> Result<Vec<String>, ArchiveError> {
    if bytes.len() as u64 > MAX_ARCHIVE {
        return Err(ArchiveError::Limit);
    }
    let end = (bytes.len().saturating_sub(65557)..bytes.len().saturating_sub(21))
        .rev()
        .find(|&at| {
            bytes.get(at..at + 4) == Some(b"PK\x05\x06")
                && u16_at(bytes, at + 20).is_ok_and(|n| at + 22 + n as usize == bytes.len())
        })
        .ok_or_else(|| {
            if bytes.starts_with(b"PK\x03\x04") {
                ArchiveError::Invalid
            } else {
                ArchiveError::Unsupported
            }
        })?;
    let count = u16_at(bytes, end + 10)? as usize;
    if count == 65535
        || u32_at(bytes, end + 12)? == u32::MAX
        || u32_at(bytes, end + 16)? == u32::MAX
        || u16_at(bytes, end + 4)? != 0
        || u16_at(bytes, end + 6)? != 0
    {
        return Err(ArchiveError::Unsupported);
    }
    if count == 0 || count > MAX_ENTRIES {
        return Err(ArchiveError::Limit);
    }
    if u16_at(bytes, end + 8)? as usize != count {
        return Err(ArchiveError::Invalid);
    }
    let start = u32_at(bytes, end + 16)? as usize;
    if start.checked_add(u32_at(bytes, end + 12)? as usize) != Some(end) {
        return Err(ArchiveError::Invalid);
    }
    let mut at = start;
    let mut names = Vec::with_capacity(count);
    let mut unique = HashSet::new();
    let mut ranges = Vec::new();
    let mut total = 0u64;
    for _ in 0..count {
        if bytes.get(at..at + 4) != Some(b"PK\x01\x02") {
            return Err(ArchiveError::Invalid);
        }
        let flags = u16_at(bytes, at + 8)?;
        let method = u16_at(bytes, at + 10)?;
        if flags & 1 != 0 {
            return Err(ArchiveError::Encrypted);
        }
        if flags & (1 << 6) != 0 || !matches!(method, 0 | 8) {
            return Err(ArchiveError::Unsupported);
        }
        let packed = u32_at(bytes, at + 20)? as usize;
        let size = u32_at(bytes, at + 24)? as u64;
        total = total.checked_add(size).ok_or(ArchiveError::Limit)?;
        if size > MAX_PART || total > MAX_TOTAL {
            return Err(ArchiveError::Limit);
        }
        let n = u16_at(bytes, at + 28)? as usize;
        let extra = u16_at(bytes, at + 30)? as usize;
        let comment = u16_at(bytes, at + 32)? as usize;
        let raw = bytes
            .get(at + 46..at + 46 + n)
            .ok_or(ArchiveError::Invalid)?;
        let name = checked_name(raw)?;
        if !unique.insert(name.trim_end_matches('/').to_owned()) {
            return Err(ArchiveError::Invalid);
        }
        if u16_at(bytes, at + 34)? != 0 {
            return Err(ArchiveError::Unsupported);
        }
        let mode = u32_at(bytes, at + 38)? >> 16;
        if mode & 0o170000 == 0o120000 {
            return Err(ArchiveError::Unsupported);
        }
        let local = u32_at(bytes, at + 42)? as usize;
        if bytes.get(local..local + 4) != Some(b"PK\x03\x04")
            || u16_at(bytes, local + 6)? != flags
            || u16_at(bytes, local + 8)? != method
            || u16_at(bytes, local + 26)? as usize != n
            || bytes.get(local + 30..local + 30 + n) != Some(raw)
        {
            return Err(ArchiveError::Invalid);
        }
        if flags & 8 == 0
            && (u32_at(bytes, local + 14)? != u32_at(bytes, at + 16)?
                || u32_at(bytes, local + 18)? as usize != packed
                || u32_at(bytes, local + 22)? as u64 != size)
        {
            return Err(ArchiveError::Invalid);
        }
        let data = local
            .checked_add(30 + n + u16_at(bytes, local + 28)? as usize)
            .ok_or(ArchiveError::Invalid)?;
        let stop = data.checked_add(packed).ok_or(ArchiveError::Invalid)?;
        if stop > start {
            return Err(ArchiveError::Invalid);
        }
        ranges.push((local, stop));
        names.push(name);
        at = at
            .checked_add(46 + n + extra + comment)
            .ok_or(ArchiveError::Invalid)?;
        if at > end {
            return Err(ArchiveError::Invalid);
        }
    }
    if at != end {
        return Err(ArchiveError::Invalid);
    }
    ranges.sort_unstable();
    if ranges.windows(2).any(|pair| pair[0].1 > pair[1].0) {
        return Err(ArchiveError::Invalid);
    }
    Ok(names)
}

pub(super) type Unpacked = (Vec<ArchivePart>, Vec<String>, u64);
pub(super) fn unpack(
    bytes: &[u8],
    mut include: impl FnMut(&str, &[u8]) -> Result<bool, ArchiveError>,
) -> Result<Unpacked, ArchiveError> {
    let names = directory(bytes)?;
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| ArchiveError::Invalid)?;
    if archive.len() != names.len() {
        return Err(ArchiveError::Invalid);
    }
    let mut parts = Vec::new();
    let mut total = 0u64;
    for (index, expected_name) in names.iter().enumerate() {
        let mut entry = archive.by_index(index).map_err(|_| ArchiveError::Invalid)?;
        let name = checked_name(entry.name_raw())?;
        if &name != expected_name {
            return Err(ArchiveError::Invalid);
        }
        if entry.encrypted() {
            return Err(ArchiveError::Encrypted);
        }
        // Read to EOF to validate the decompressor and CRC, including ignored
        // binary entries. A declared size is never authority for allocation.
        let mut output = Vec::new();
        entry
            .by_ref()
            .take(MAX_PART + 1)
            .read_to_end(&mut output)
            .map_err(|_| ArchiveError::Invalid)?;
        total += output.len() as u64;
        if output.len() as u64 > MAX_PART || total > MAX_TOTAL {
            return Err(ArchiveError::Limit);
        }
        if output.len() as u64 != entry.size() {
            return Err(ArchiveError::Invalid);
        }
        if include(&name, &output)? {
            parts.push(ArchivePart {
                name,
                data: STANDARD.encode(output),
            });
        }
    }
    if !names.iter().any(|n| n == "[Content_Types].xml")
        || !names.iter().any(|n| n == "_rels/.rels")
    {
        return Err(ArchiveError::Unsupported);
    }
    Ok((parts, names, total))
}
