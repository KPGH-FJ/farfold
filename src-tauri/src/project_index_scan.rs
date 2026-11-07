//! One bounded name walk. Results are candidates, not file identity receipts.
use super::Failure;
use serde::Serialize;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

pub(super) const EXCLUDED: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    ".next",
    ".turbo",
    ".cache",
    "coverage",
    "__pycache__",
    ".venv",
    "venv",
];

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Limits {
    pub files: usize,
    pub depth: usize,
    pub entries: usize,
    pub entries_per_directory: usize,
    pub directories: usize,
    pub path_bytes: usize,
    pub time_ms: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            files: 2000,
            depth: 10,
            entries: 20_000,
            entries_per_directory: 4096,
            directories: 2000,
            path_bytes: 1_048_576,
            time_ms: 5000,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum LimitReason {
    #[serde(rename = "fileLimit")]
    File,
    #[serde(rename = "depthLimit")]
    Depth,
    #[serde(rename = "entryLimit")]
    Entry,
    #[serde(rename = "directoryEntryLimit")]
    DirectoryEntry,
    #[serde(rename = "directoryLimit")]
    Directory,
    #[serde(rename = "pathBytesLimit")]
    PathBytes,
    #[serde(rename = "timeLimit")]
    Time,
}
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Counts {
    pub entries: usize,
    pub directories: usize,
    pub skipped_directories: usize,
    #[serde(skip_serializing_if = "is_zero")]
    pub skipped_nonlocal_directories: usize,
    pub unreadable_directories: usize,
    pub unreadable_entries: usize,
    pub unsupported_names: usize,
}
fn is_zero(count: &usize) -> bool {
    *count == 0
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFiles {
    pub request_id: String,
    pub files: Vec<String>,
    pub truncated: bool,
    pub partial: bool,
    pub cancelled: bool,
    pub(super) limits: Limits,
    pub(super) counts: Counts,
    pub(super) limit_reasons: Vec<LimitReason>,
    pub excluded_directory_names: &'static [&'static str],
}
impl ProjectFiles {
    fn limit(&mut self, reason: LimitReason) {
        self.truncated = true;
        if !self.limit_reasons.contains(&reason) {
            self.limit_reasons.push(reason);
        }
    }
    fn stopped(&mut self, cancel: &AtomicBool, started: Instant) -> bool {
        if cancel.load(Ordering::Acquire) {
            self.cancelled = true;
            return true;
        }
        if started.elapsed().as_millis() >= self.limits.time_ms as u128 {
            self.limit(LimitReason::Time);
            return true;
        }
        false
    }
}
fn relative_name(path: &Path) -> Option<String> {
    // Never lossy-convert an OS filename or turn a literal backslash into a
    // separator. Either would attach a different, similarly named file.
    let mut names = Vec::new();
    for part in path.components() {
        let std::path::Component::Normal(name) = part else {
            return None;
        };
        let name = name.to_str()?;
        if name.contains('\\') || name.chars().any(char::is_control) {
            return None;
        }
        names.push(name);
    }
    Some(names.join("/"))
}
#[derive(Clone)]
struct Directory {
    path: PathBuf,
    depth: usize,
    identity: crate::file_access::Identity,
}
impl Directory {
    fn capture(path: &Path, depth: usize) -> std::io::Result<Self> {
        let file = crate::file_access::open_directory(path)?;
        Ok(Self {
            path: path.into(),
            depth,
            identity: crate::file_access::stamp(&file)?.identity,
        })
    }
    fn current(&self) -> bool {
        crate::file_access::open_directory(&self.path)
            .and_then(|f| crate::file_access::stamp(&f))
            .is_ok_and(|stamp| stamp.identity == self.identity)
    }
    fn open(&self) -> std::io::Result<std::fs::ReadDir> {
        if !self.current() {
            return Err(std::io::Error::from(std::io::ErrorKind::NotFound));
        }
        std::fs::read_dir(&self.path)
    }
}

#[cfg(target_os = "macos")]
fn nested_nonlocal_mounts(root: &Path) -> HashSet<PathBuf> {
    use std::{collections::HashMap, ffi::OsStr, mem::MaybeUninit, os::unix::ffi::OsStrExt};

    // Read the kernel's cached mount table without probing individual volumes.
    // This is a best-effort snapshot. Mounts can change during the scan.
    // SAFETY: A null buffer asks Darwin for the current mount count only.
    let count = unsafe { libc::getfsstat(std::ptr::null_mut(), 0, libc::MNT_NOWAIT) };
    if count <= 0 {
        return HashSet::new();
    }
    let slots = (count as usize + 8).min(1024);
    let mut mounts = vec![MaybeUninit::<libc::statfs>::uninit(); slots];
    let bytes = (slots * std::mem::size_of::<libc::statfs>()) as libc::c_int;
    // SAFETY: The buffer is writable for the supplied byte length, which is
    // bounded by 1024 records and fits c_int.
    let filled = unsafe { libc::getfsstat(mounts.as_mut_ptr().cast(), bytes, libc::MNT_NOWAIT) };
    // A full buffer may hide an overlapping local mount. Do not use that
    // snapshot to decide what is visible at any particular path.
    if filled < 0 || filled as usize >= mounts.len() {
        return HashSet::new();
    }

    let mut known = HashMap::new();
    for mount in &mounts[..filled as usize] {
        // SAFETY: A successful getfsstat initializes its returned prefix.
        let mount = unsafe { mount.assume_init_ref() };
        let name = &mount.f_mntonname;
        let Some(end) = name.iter().position(|&byte| byte == 0) else {
            continue;
        };
        let bytes: Vec<_> = name[..end].iter().map(|&byte| byte as u8).collect();
        let path = Path::new(OsStr::from_bytes(&bytes));
        if !path.is_absolute() || path == root || !path.starts_with(root) {
            continue;
        }
        let nonlocal = mount.f_flags & libc::MNT_LOCAL as u32 == 0;
        // An overlapping local record makes the exact path ambiguous.
        *known.entry(path.to_path_buf()).or_insert(true) &= nonlocal;
    }
    known
        .into_iter()
        .filter_map(|(path, nonlocal)| nonlocal.then_some(path))
        .collect()
}

#[cfg(not(target_os = "macos"))]
fn nested_nonlocal_mounts(_root: &Path) -> HashSet<PathBuf> {
    HashSet::new()
}

pub(super) fn scan(
    root: &Path,
    request_id: String,
    cancel: &AtomicBool,
    limits: Limits,
) -> Result<ProjectFiles, Failure> {
    scan_with_mounts(root, request_id, cancel, limits, || {
        nested_nonlocal_mounts(root)
    })
}

fn scan_with_mounts(
    root: &Path,
    request_id: String,
    cancel: &AtomicBool,
    limits: Limits,
    nested_mounts: impl FnOnce() -> HashSet<PathBuf>,
) -> Result<ProjectFiles, Failure> {
    let started = Instant::now();
    let mut result = ProjectFiles {
        request_id,
        files: Vec::new(),
        truncated: false,
        partial: false,
        cancelled: false,
        limits,
        counts: Counts::default(),
        limit_reasons: Vec::new(),
        excluded_directory_names: EXCLUDED,
    };
    if result.stopped(cancel, started) {
        return Ok(result);
    }
    let nested_mounts = nested_mounts();
    if result.stopped(cancel, started) {
        return Ok(result);
    }
    let root_directory = Directory::capture(root, 0).map_err(|_| Failure::new("unreadable"))?;
    let mut directories = vec![root_directory.clone()];
    let mut discovered_directories = 1;
    let mut path_bytes = 0;
    while let Some(dir) = directories.pop() {
        let depth = dir.depth;
        if result.stopped(cancel, started) {
            break;
        }
        result.counts.directories += 1;
        let entries = match dir.open() {
            Ok(entries) => entries,
            Err(_) if depth == 0 => return Err(Failure::new("unreadable")),
            Err(_) => {
                result.counts.unreadable_directories += 1;
                continue;
            }
        };
        let mut entries = entries;
        let mut in_directory = 0;
        let files_before = result.files.len();
        let queued_before = directories.len();
        let bytes_before = path_bytes;
        let mut halt = false;
        loop {
            if result.stopped(cancel, started) {
                halt = true;
                break;
            }
            // Limits are checked BEFORE next(), not after collecting/sorting
            // a potentially enormous directory. Hitting an exact boundary is
            // conservatively incomplete: no extra OS read is made to peek.
            if result.counts.entries >= limits.entries {
                result.limit(LimitReason::Entry);
                halt = true;
                break;
            }
            if in_directory >= limits.entries_per_directory {
                result.limit(LimitReason::DirectoryEntry);
                break;
            }
            let Some(entry) = entries.next() else {
                break;
            };
            result.counts.entries += 1;
            in_directory += 1;
            if result.stopped(cancel, started) {
                halt = true;
                break;
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    result.counts.unreadable_entries += 1;
                    continue;
                }
            };
            let path = entry.path();
            if nested_mounts.contains(&path) {
                result.counts.skipped_nonlocal_directories += 1;
                continue;
            }
            let Some(relative) = path.strip_prefix(root).ok().and_then(relative_name) else {
                result.counts.unsupported_names += 1;
                continue;
            };
            let metadata = match path.symlink_metadata() {
                Ok(metadata) => metadata,
                Err(_) => {
                    result.counts.unreadable_entries += 1;
                    continue;
                }
            };
            if result.stopped(cancel, started) {
                halt = true;
                break;
            }
            if metadata.is_dir() {
                let name = entry.file_name();
                if name.to_str().is_some_and(|name| EXCLUDED.contains(&name)) {
                    result.counts.skipped_directories += 1;
                    continue;
                }
                if depth >= limits.depth {
                    result.limit(LimitReason::Depth);
                    continue;
                }
                if discovered_directories >= limits.directories {
                    result.limit(LimitReason::Directory);
                    continue;
                }
                discovered_directories += 1;
                match Directory::capture(&path, depth + 1) {
                    Ok(next) => directories.push(next),
                    Err(_) => result.counts.unreadable_directories += 1,
                }
            } else if metadata.is_file() || metadata.file_type().is_symlink() {
                if result.files.len() >= limits.files {
                    result.limit(LimitReason::File);
                    halt = true;
                    break;
                }
                if path_bytes + relative.len() > limits.path_bytes {
                    result.limit(LimitReason::PathBytes);
                    halt = true;
                    break;
                }
                path_bytes += relative.len();
                result.files.push(relative);
            }
        }
        drop(entries);
        // Path-based enumeration is not a snapshot. Reject a stable directory
        // replacement before publishing its names or queued children. Actual
        // file bytes are separately read through no-follow owned handles.
        if !dir.current() {
            result.files.truncate(files_before);
            directories.truncate(queued_before);
            path_bytes = bytes_before;
            if depth == 0 {
                return Err(Failure::new("unreadable"));
            }
            result.counts.unreadable_directories += 1;
        }
        if halt {
            break;
        }
    }
    if !result.cancelled && !root_directory.current() {
        return Err(Failure::new("unreadable"));
    }
    // A cancel arriving with the last OS result still retires the candidate.
    result.cancelled |= cancel.load(Ordering::Acquire);
    result.partial = result.counts.unreadable_directories
        + result.counts.unreadable_entries
        + result.counts.unsupported_names
        + result.counts.skipped_nonlocal_directories
        > 0;
    result.files.sort();
    result.files.dedup();
    Ok(result)
}

#[cfg(test)]
#[path = "project_index_scan_tests.rs"]
mod tests;
