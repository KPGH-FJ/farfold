//! Raw Git/default-byte prerequisite only. Never a checkout-clean or recovery capability.
use super::super::types::oid;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    io::Read,
    sync::atomic::{AtomicBool, Ordering},
};

pub(super) const BLOCK: usize = 65_536;
pub(super) const MAX_BLOB: u64 = 256 * 1024 * 1024;
pub(super) const WORK_LIMIT: u64 = 1024 * 1024 * 1024;
const MAX_TREE_OUTPUT: usize = 4 * 1024 * 1024;
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Error {
    Cancelled,
    Limit,
    Invalid,
    NotSelected,
    Unsupported,
    Changed,
    Io {
        side: &'static str,
        code: Option<i32>,
    },
}
pub(super) type Result<T> = std::result::Result<T, Error>;
pub(super) fn check(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::SeqCst) {
        Err(Error::Cancelled)
    } else {
        Ok(())
    }
}
pub(super) struct Budget {
    remaining: u64,
}
impl Budget {
    pub(super) fn new(limit: u64) -> Self {
        Self { remaining: limit }
    }
    pub(super) fn charge(&mut self, bytes: u64) -> Result<()> {
        self.remaining = self.remaining.checked_sub(bytes).ok_or(Error::Limit)?;
        Ok(())
    }
    fn offer(&self, bytes: usize) -> Result<usize> {
        let offer = bytes.min(self.remaining.min(BLOCK as u64) as usize);
        if offer == 0 {
            Err(Error::Limit)
        } else {
            Ok(offer)
        }
    }
}
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Selection {
    pub(super) path: Vec<u8>,
    pub(super) oid: String,
    pub(super) bytes: u64,
    pub(super) tree_output_bytes: u64,
}
// Caller supplies the SAME SourceGraph's sorted admitted object IDs. Selection
// can never substitute an arbitrary object ID or an index/worktree pathname.
pub(super) fn select(
    raw: &[u8],
    requested: &[u8],
    objects: &[String],
    width: usize,
    cancel: &AtomicBool,
) -> Result<Selection> {
    check(cancel)?;
    if raw.len() > MAX_TREE_OUTPUT {
        return Err(Error::Limit);
    }
    if !matches!(width, 40 | 64)
        || requested.is_empty()
        || (!raw.is_empty() && raw.last() != Some(&0))
    {
        return Err(Error::Invalid);
    }
    if raw.first() == Some(&0)
        || raw.windows(2).any(|w| w == [0, 0])
        || objects.windows(2).any(|pair| pair[0] >= pair[1])
    {
        return Err(Error::Invalid);
    }
    let mut names = BTreeSet::new();
    let mut selected = None;
    let mut bytes = 0u64;
    for record in raw.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        check(cancel)?;
        let tab = record
            .iter()
            .position(|b| *b == b'\t')
            .ok_or(Error::Invalid)?;
        let fields = std::str::from_utf8(&record[..tab])
            .map_err(|_| Error::Invalid)?
            .split_ascii_whitespace()
            .collect::<Vec<_>>();
        if fields.len() != 4
            || fields[1] != "blob"
            || !matches!(fields[0], "100644" | "100755" | "120000")
            || fields[2].len() != width
            || !oid(fields[2])
            || fields[3].is_empty()
            || !fields[3].bytes().all(|b| b.is_ascii_digit())
        {
            return Err(Error::Unsupported);
        }
        if objects
            .binary_search_by(|s| s.as_str().cmp(fields[2]))
            .is_err()
        {
            return Err(Error::Changed);
        }
        let size = fields[3].parse::<u64>().map_err(|_| Error::Invalid)?;
        if size > MAX_BLOB {
            return Err(Error::Limit);
        }
        bytes = bytes
            .checked_add(size)
            .filter(|v| *v <= WORK_LIMIT)
            .ok_or(Error::Limit)?;
        let path = &record[tab + 1..];
        if path.is_empty() || !names.insert(path) {
            return Err(Error::Invalid);
        }
        if names.len() > 100_000 {
            return Err(Error::Limit);
        }
        if path == b".gitmodules" {
            return Err(Error::Unsupported);
        }
        if path == requested {
            if fields[0] == "120000" {
                return Err(Error::Unsupported);
            }
            selected = Some(Selection {
                path: path.to_vec(),
                oid: fields[2].to_owned(),
                bytes: size,
                tree_output_bytes: raw.len() as u64,
            });
        }
    }
    selected.ok_or(Error::NotSelected)
}
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Comparison {
    pub(super) equal: bool,
    pub(super) expected_bytes: u64,
    pub(super) actual_bytes: u64,
    pub(super) expected_sha256: [u8; 32],
    pub(super) actual_sha256: [u8; 32],
}
fn fill(
    reader: &mut impl Read,
    target: &mut [u8],
    side: &'static str,
    work: &mut Budget,
    cancel: &AtomicBool,
) -> Result<()> {
    let mut at = 0;
    while at < target.len() {
        check(cancel)?;
        let offered = work.offer(target.len() - at)?;
        let count = reader
            .read(&mut target[at..at + offered])
            .map_err(|e| Error::Io {
                side,
                code: e.raw_os_error(),
            })?;
        if count > offered {
            return Err(Error::Invalid);
        }
        work.charge(count as u64)?;
        if count == 0 {
            return Err(Error::Changed);
        }
        at += count;
    }
    Ok(())
}
fn eof(
    reader: &mut impl Read,
    side: &'static str,
    work: &mut Budget,
    cancel: &AtomicBool,
) -> Result<()> {
    check(cancel)?;
    work.offer(1)?;
    let mut extra = [0u8; 1];
    let count = reader.read(&mut extra).map_err(|e| Error::Io {
        side,
        code: e.raw_os_error(),
    })?;
    if count > 1 {
        return Err(Error::Invalid);
    }
    work.charge(count as u64)?;
    if count != 0 {
        Err(Error::Changed)
    } else {
        Ok(())
    }
}
pub(super) fn compare(
    expected: &mut impl Read,
    expected_bytes: u64,
    actual: &mut impl Read,
    actual_bytes: u64,
    work: &mut Budget,
    cancel: &AtomicBool,
) -> Result<Comparison> {
    check(cancel)?;
    if expected_bytes > MAX_BLOB || actual_bytes > MAX_BLOB {
        return Err(Error::Limit);
    }
    let mut left = [0u8; BLOCK];
    let mut right = [0u8; BLOCK];
    let mut left_hash = Sha256::new();
    let mut right_hash = Sha256::new();
    let mut equal = expected_bytes == actual_bytes;
    let mut left_remaining = expected_bytes;
    let mut right_remaining = actual_bytes;
    while left_remaining != 0 || right_remaining != 0 {
        let left_count = left_remaining.min(BLOCK as u64) as usize;
        let right_count = right_remaining.min(BLOCK as u64) as usize;
        fill(expected, &mut left[..left_count], "object", work, cancel)?;
        fill(actual, &mut right[..right_count], "material", work, cancel)?;
        left_hash.update(&left[..left_count]);
        right_hash.update(&right[..right_count]);
        equal &= left[..left_count] == right[..right_count];
        left_remaining -= left_count as u64;
        right_remaining -= right_count as u64;
    }
    eof(expected, "object", work, cancel)?;
    eof(actual, "material", work, cancel)?;
    check(cancel)?;
    Ok(Comparison {
        equal,
        expected_bytes,
        actual_bytes,
        expected_sha256: left_hash.finalize().into(),
        actual_sha256: right_hash.finalize().into(),
    })
}
#[cfg(test)]
#[path = "git_content_stream_tests.rs"]
mod tests;
