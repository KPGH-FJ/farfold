//! Discover the exact worktree-private roots, including orphaned reflogs. Never
//! use the shared refs/reflogs as a substitute, and never silently skip a file.
#[cfg(any(not(windows), test))]
use super::{git, inspect::Snapshot};
use super::{material_scan::hex, remove_types::RootsSummary, types::*};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[cfg(not(windows))]
use std::{fs, io::Read};

#[cfg(any(not(windows), test))]
use std::{
    collections::BTreeSet,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

pub(super) const MAX_ROOTS: usize = 4096;
pub(super) const MAX_OBJECTS: usize = 50_000;
pub(super) const MAX_BYTES: u64 = 256 * 1024 * 1024;
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct RootFile {
    pub path: String,
    pub sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Roots {
    pub head: String,
    pub format: String,
    pub commits: Vec<String>,
    pub files: Vec<RootFile>,
}
impl Roots {
    pub fn summary(&self) -> Result<RootsSummary> {
        Ok(RootsSummary {
            count: self.commits.len() as u64,
            object_format: self.format.clone(),
            sha256: hex(Sha256::digest(
                serde_json::to_vec(self).map_err(|_| error("recoveryInvalid"))?,
            )),
        })
    }
    pub fn input(&self) -> Vec<u8> {
        (self.commits.join("\n") + "\n").into_bytes()
    }
}
#[cfg(not(windows))]
pub(super) fn read_file(path: &Path, cap: u64) -> Result<Vec<u8>> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut f = options.open(path).map_err(|_| error("recoveryChanged"))?;
    if !f
        .metadata()
        .map_err(|_| error("recoveryChanged"))?
        .is_file()
    {
        return Err(error("recoveryInvalid"));
    }
    let before = crate::file_access::stamp(&f).map_err(|_| error("recoveryChanged"))?;
    if before.size > cap {
        return Err(error("recoveryLimit"));
    }
    let mut out = Vec::new();
    (&mut f)
        .take(cap + 1)
        .read_to_end(&mut out)
        .map_err(|_| error("unavailable"))?;
    if out.len() as u64 != before.size
        || crate::file_access::stamp(&f).map_err(|_| error("recoveryChanged"))? != before
    {
        return Err(error("recoveryChanged"));
    }
    Ok(out)
}
#[cfg(not(windows))]
fn enumerate(
    root: &Path,
    relative: &str,
    result: &mut Vec<String>,
    depth: usize,
    visited: &mut usize,
) -> Result<()> {
    *visited += 1;
    if depth > 32 || *visited > 4096 {
        return Err(error("recoveryLimit"));
    }
    let path = root.join(relative);
    let meta = fs::symlink_metadata(&path).map_err(|_| error("unprovenPrivateCommits"))?;
    if meta.file_type().is_symlink() {
        return Err(error("unprovenPrivateCommits"));
    }
    if meta.is_file() {
        result.push(relative.into());
        return Ok(());
    }
    if !meta.is_dir() {
        return Err(error("unprovenPrivateCommits"));
    }
    if !relative.is_empty()
        && !matches!(
            relative,
            "refs" | "refs/worktree" | "logs" | "logs/refs" | "logs/refs/worktree"
        )
        && !relative.starts_with("refs/worktree/")
        && !relative.starts_with("logs/refs/worktree/")
    {
        return Err(error("unprovenPrivateCommits"));
    }
    for entry in fs::read_dir(path).map_err(|_| error("unavailable"))? {
        let name = entry
            .map_err(|_| error("unavailable"))?
            .file_name()
            .into_string()
            .map_err(|_| error("unprovenPrivateCommits"))?;
        let next = if relative.is_empty() {
            name
        } else {
            format!("{relative}/{name}")
        };
        enumerate(root, &next, result, depth + 1, visited)?;
    }
    Ok(())
}
#[cfg(not(windows))]
fn add(roots: &mut BTreeSet<String>, raw: &str, width: usize) -> Result<()> {
    if raw.len() != width || !oid(raw) {
        return Err(error("unprovenPrivateCommits"));
    }
    if raw.bytes().any(|b| b != b'0') {
        roots.insert(raw.into());
    }
    if roots.len() > MAX_ROOTS {
        return Err(error("recoveryLimit"));
    }
    Ok(())
}
#[cfg(not(windows))]
pub(super) fn capture(s: &Snapshot, cancel: &AtomicBool) -> Result<Roots> {
    let root = Path::new(&s.root);
    let format = git::text(root, &["rev-parse", "--show-object-format"])?;
    let width = match format.as_str() {
        "sha1" => 40,
        "sha256" => 64,
        _ => return Err(error("unsupportedGit")),
    };
    let head = s.head.clone().ok_or(error("unborn"))?;
    let mut commits = BTreeSet::from([head.clone()]);
    let private = Path::new(&s.git_dir);
    let mut paths = vec![];
    enumerate(private, "", &mut paths, 0, &mut 0)?;
    paths.sort();
    let mut files = vec![];
    let mut bytes = 0usize;
    for path in paths {
        if cancel.load(Ordering::SeqCst) {
            return Err(error("cancelled"));
        }
        if matches!(path.as_str(), "index" | "commondir" | "gitdir") {
            continue;
        }
        let is_ref = path.starts_with("refs/worktree/");
        let is_log = path == "logs/HEAD" || path.starts_with("logs/refs/worktree/");
        if !is_ref
            && !is_log
            && !matches!(
                path.as_str(),
                "HEAD" | "ORIG_HEAD" | "FETCH_HEAD" | "COMMIT_EDITMSG"
            )
        {
            return Err(error("unprovenPrivateCommits"));
        }
        let raw = read_file(&private.join(&path), 4 * 1024 * 1024)?;
        bytes += raw.len();
        if bytes > 16 * 1024 * 1024 {
            return Err(error("recoveryLimit"));
        }
        let text = std::str::from_utf8(&raw).map_err(|_| error("unprovenPrivateCommits"))?;
        if path == "COMMIT_EDITMSG" {
            // Known last-commit message cache, not a commit root or live editor lock.
        } else if is_log {
            for line in text.lines() {
                let mut fields = line.splitn(3, ' ');
                add(&mut commits, fields.next().unwrap_or(""), width)?;
                add(&mut commits, fields.next().unwrap_or(""), width)?;
                if fields.next().is_none() {
                    return Err(error("unprovenPrivateCommits"));
                }
            }
        } else if path == "FETCH_HEAD" {
            for line in text.lines() {
                let (oid, _) = line
                    .split_once('\t')
                    .ok_or(error("unprovenPrivateCommits"))?;
                add(&mut commits, oid, width)?;
            }
        } else if path == "HEAD" && text.starts_with("ref: ") {
            if s.branch.as_deref() != Some(text.trim_end().strip_prefix("ref: ").unwrap_or("")) {
                return Err(error("changed"));
            }
        } else {
            add(&mut commits, text.trim_end(), width)?;
        }
        files.push(RootFile {
            path,
            sha256: hex(Sha256::digest(&raw)),
        });
    }
    verify_commits(root, &commits, cancel)?;
    Ok(Roots {
        head,
        format,
        commits: commits.into_iter().collect(),
        files,
    })
}

#[cfg(any(not(windows), test))]
pub(super) fn verify_commits(
    root: &Path,
    commits: &BTreeSet<String>,
    cancel: &AtomicBool,
) -> Result<()> {
    for commit in commits {
        if cancel.load(Ordering::SeqCst) {
            return Err(error("cancelled"));
        }
        let output = git::execute(
            root,
            &["cat-file", "-t", commit],
            cancel,
            std::time::Duration::from_secs(10),
        )?;
        if !output.success || output.bytes != b"commit\n" {
            return Err(error("unprovenPrivateCommits"));
        }
    }
    Ok(())
}

#[cfg(all(windows, test))]
pub(super) fn capture(s: &Snapshot, cancel: &AtomicBool) -> Result<Roots> {
    if cancel.load(Ordering::SeqCst) {
        return Err(error("cancelled"));
    }
    git::source_roots::capture(s, cancel)
}
