//! Worktree-private commit roots only. No index/material/config restore claim.
//! Fixed source commands stay under the one admitted ReadContext and original
//! Child/direct Job executor; the public read_policy is unchanged.
use super::super::{
    inspect::{self, Snapshot},
    material_scan::hex,
    recovery_roots::{MAX_BYTES, MAX_OBJECTS, MAX_ROOTS, RootFile, Roots},
    types::{Result, error, oid},
    windows_git::ReadContext,
};
use crate::file_access::{
    DirectoryEntries, DirectoryFailure, PinnedPath, Stamp, directory_entries, stamp,
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    io::{Read, Seek},
    path::Path,
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
};

const MAX_ENTRIES: u64 = 4096;
const FILE_BYTES: u64 = 4 * 1024 * 1024;
const TOTAL_BYTES: u64 = 16 * 1024 * 1024;
fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::SeqCst) {
        Err(error("cancelled"))
    } else {
        Ok(())
    }
}
fn directory_error(e: DirectoryFailure) -> super::super::types::Failure {
    error(match e {
        DirectoryFailure::Cancelled => "cancelled",
        DirectoryFailure::Limit => "recoveryLimit",
        DirectoryFailure::Changed => "recoveryChanged",
        DirectoryFailure::Io { .. } => "unavailable",
        _ => "unprovenPrivateCommits",
    })
}
fn allowed_directory(path: &str) -> bool {
    matches!(
        path,
        "refs" | "refs/worktree" | "logs" | "logs/refs" | "logs/refs/worktree"
    ) || path.starts_with("refs/worktree/")
        || path.starts_with("logs/refs/worktree/")
}
fn skipped(path: &str) -> bool {
    matches!(path, "index" | "commondir" | "gitdir")
}
fn allowed_file(path: &str) -> bool {
    skipped(path)
        || path.starts_with("refs/worktree/")
        || path == "logs/HEAD"
        || path.starts_with("logs/refs/worktree/")
        || matches!(path, "HEAD" | "ORIG_HEAD" | "FETCH_HEAD" | "COMMIT_EDITMSG")
}
struct Leaf {
    path: String,
    pin: PinnedPath,
    before: Stamp,
    sha256: Option<String>,
}
struct Directory {
    pin: PinnedPath,
    before: DirectoryEntries,
    capacity: u64,
}
struct Inventory {
    first: DirectoryEntries,
    directories: Vec<Directory>,
    leaves: Vec<Leaf>,
    reserved: u64,
    bytes: u64,
}
impl Inventory {
    fn capture(root: &PinnedPath, cancel: &AtomicBool) -> Result<Self> {
        let mut result = Self {
            first: DirectoryEntries::new(),
            directories: Vec::new(),
            leaves: Vec::new(),
            reserved: 1,
            bytes: 0,
        };
        result.first = result.walk(root, "", 0, cancel)?;
        Ok(result)
    }
    fn walk(
        &mut self,
        parent: &PinnedPath,
        prefix: &str,
        depth: usize,
        cancel: &AtomicBool,
    ) -> Result<DirectoryEntries> {
        cancelled(cancel)?;
        if depth > 32 {
            return Err(error("recoveryLimit"));
        }
        let capacity = MAX_ENTRIES
            .checked_sub(self.reserved)
            .ok_or(error("recoveryLimit"))?;
        let listed = directory_entries(parent, capacity, cancel).map_err(directory_error)?;
        if depth == 32 && !listed.is_empty() {
            return Err(error("recoveryLimit"));
        }
        // Reserve the WHOLE retained map before descending. Ancestor first
        // maps together cannot grow to depth*MAX_ENTRIES before being charged.
        self.reserved = self
            .reserved
            .checked_add(listed.len() as u64)
            .filter(|v| *v <= MAX_ENTRIES)
            .ok_or(error("recoveryLimit"))?;
        for (raw, metadata) in &listed {
            cancelled(cancel)?;
            if metadata.attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(error("unprovenPrivateCommits"));
            }
            let name = String::from_utf16(raw).map_err(|_| error("unprovenPrivateCommits"))?;
            let relative = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            let directory = metadata.attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
            if if directory {
                !allowed_directory(&relative)
            } else {
                !allowed_file(&relative)
            } {
                return Err(error("unprovenPrivateCommits"));
            }
            let pin = parent
                .child(raw, directory)
                .map_err(|_| error("recoveryChanged"))?;
            let before = stamp(pin.file()).map_err(|_| error("recoveryChanged"))?;
            if before.identity != metadata.identity
                || before.regular == directory
                || (!directory && before.size != metadata.size as u64)
            {
                return Err(error("recoveryChanged"));
            }
            if directory {
                let child_capacity = MAX_ENTRIES
                    .checked_sub(self.reserved)
                    .ok_or(error("recoveryLimit"))?;
                let before = self.walk(&pin, &relative, depth + 1, cancel)?;
                self.directories.push(Directory {
                    pin,
                    before,
                    capacity: child_capacity,
                });
            } else {
                self.leaves.push(Leaf {
                    path: relative,
                    pin,
                    before,
                    sha256: None,
                });
            }
        }
        Ok(listed)
    }
    fn roots(&mut self, snapshot: &Snapshot, format: String, cancel: &AtomicBool) -> Result<Roots> {
        let width = match format.as_str() {
            "sha1" => 40,
            "sha256" => 64,
            _ => return Err(error("unsupportedGit")),
        };
        let head = snapshot.head.clone().ok_or(error("unborn"))?;
        let mut commits = BTreeSet::new();
        add(&mut commits, &head, width)?;
        if !commits.contains(&head) {
            return Err(error("unprovenPrivateCommits"));
        }
        self.leaves.sort_by(|a, b| a.path.cmp(&b.path));
        let mut files = Vec::new();
        for leaf in &mut self.leaves {
            cancelled(cancel)?;
            if skipped(&leaf.path) {
                continue;
            }
            let raw = read(leaf, cancel)?;
            self.bytes = self
                .bytes
                .checked_add(raw.len() as u64)
                .filter(|n| *n <= TOTAL_BYTES)
                .ok_or(error("recoveryLimit"))?;
            let text = std::str::from_utf8(&raw).map_err(|_| error("unprovenPrivateCommits"))?;
            let path = leaf.path.as_str();
            if path == "COMMIT_EDITMSG" {
                // Fingerprint only; never a commit root, config or stored body.
            } else if path == "logs/HEAD" || path.starts_with("logs/refs/worktree/") {
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
                    let (value, _) = line
                        .split_once('\t')
                        .ok_or(error("unprovenPrivateCommits"))?;
                    add(&mut commits, value, width)?;
                }
            } else if path == "HEAD" && text.starts_with("ref: ") {
                if snapshot.branch.as_deref() != text.trim_end().strip_prefix("ref: ") {
                    return Err(error("changed"));
                }
            } else {
                add(&mut commits, text.trim_end(), width)?;
            }
            let digest = hex(Sha256::digest(&raw));
            leaf.sha256 = Some(digest.clone());
            files.push(RootFile {
                path: leaf.path.clone(),
                sha256: digest,
            });
        }
        Ok(Roots {
            head,
            format,
            commits: commits.into_iter().collect(),
            files,
        })
    }
    fn verify(&self, root: &PinnedPath, cancel: &AtomicBool) -> Result<()> {
        cancelled(cancel)?;
        for leaf in &self.leaves {
            leaf.pin.verify().map_err(|_| error("recoveryChanged"))?;
            if stamp(leaf.pin.file()).map_err(|_| error("recoveryChanged"))? != leaf.before {
                return Err(error("recoveryChanged"));
            }
            if let Some(expected) = &leaf.sha256
                && hex(Sha256::digest(read(leaf, cancel)?)) != *expected
            {
                return Err(error("recoveryChanged"));
            }
        }
        // At most one second map exists in addition to the <=4096-entry set
        // of first maps. This is a logical retained-entry bound, not RSS.
        for directory in &self.directories {
            if directory_entries(&directory.pin, directory.capacity, cancel)
                .map_err(directory_error)?
                != directory.before
            {
                return Err(error("recoveryChanged"));
            }
        }
        if directory_entries(root, MAX_ENTRIES - 1, cancel).map_err(directory_error)? != self.first
        {
            return Err(error("recoveryChanged"));
        }
        cancelled(cancel)
    }
}
fn add(roots: &mut BTreeSet<String>, value: &str, width: usize) -> Result<()> {
    if value.len() != width || !oid(value) {
        return Err(error("unprovenPrivateCommits"));
    }
    if value.bytes().any(|b| b != b'0') {
        roots.insert(value.into());
    }
    if roots.len() > MAX_ROOTS {
        return Err(error("recoveryLimit"));
    }
    Ok(())
}
fn read(leaf: &Leaf, cancel: &AtomicBool) -> Result<Vec<u8>> {
    cancelled(cancel)?;
    if !leaf.before.regular || leaf.before.size > FILE_BYTES {
        return Err(error("recoveryLimit"));
    }
    let mut file = leaf
        .pin
        .file()
        .try_clone()
        .map_err(|_| error("unavailable"))?;
    file.rewind().map_err(|_| error("unavailable"))?;
    let mut raw = Vec::new();
    (&mut file)
        .take(FILE_BYTES + 1)
        .read_to_end(&mut raw)
        .map_err(|_| error("unavailable"))?;
    cancelled(cancel)?;
    if raw.len() as u64 != leaf.before.size
        || stamp(leaf.pin.file()).map_err(|_| error("recoveryChanged"))? != leaf.before
    {
        return Err(error("recoveryChanged"));
    }
    Ok(raw)
}
enum Query<'a> {
    Format,
    CommitType(&'a str),
    Objects(super::Input),
    Sizes(super::Input),
}
fn query(
    source: &ReadContext,
    snapshot: &Snapshot,
    action: Query<'_>,
    cancel: &AtomicBool,
) -> Result<Vec<u8>> {
    cancelled(cancel)?;
    super::environment()?;
    source.scope.matches(snapshot)?;
    source
        .selected_program()
        .verify()
        .map_err(|_| error("changed"))?;
    let (timeout, failure) = match &action {
        Query::Objects(_) | Query::Sizes(_) => {
            (super::super::recovery_pack::COMMAND_TIME, "recoveryInvalid")
        }
        _ => (Duration::from_secs(10), "unprovenPrivateCommits"),
    };
    let mut command = Command::new(&source.selected_program().guid_path);
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_COMMON_DIR", &source.scope.common.guid_path)
        .args(["--no-pager", "--no-replace-objects", "-c"])
        .arg(format!(
            "core.hooksPath={}",
            source.selected_program().guid_path.display()
        ))
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "maintenance.auto=false",
            "-c",
            "gc.auto=0",
            "-c",
            "submodule.recurse=false",
            "-c",
            "worktree.guessRemote=false",
            "-c",
            "credential.helper=",
        ])
        .arg("--git-dir")
        .arg(&source.scope.git.guid_path)
        .arg("--work-tree")
        .arg(&source.scope.root.guid_path)
        .arg("-C")
        .arg(&source.scope.root.guid_path)
        .current_dir(&source.scope.root.guid_path);
    let input = match action {
        Query::Format => {
            command.args(["rev-parse", "--show-object-format"]);
            super::Input::null()
        }
        Query::CommitType(value) => {
            if !oid(value) {
                return Err(error("unprovenPrivateCommits"));
            }
            command.args(["cat-file", "-t", value]);
            super::Input::null()
        }
        Query::Objects(input) => {
            command.args(["rev-list", "--objects", "--no-object-names", "--stdin"]);
            input
        }
        Query::Sizes(input) => {
            command.args([
                "cat-file",
                "--batch-check=%(objectname) %(objecttype) %(objectsize)",
            ]);
            input
        }
    };
    // Windows stdio is rebuilt by the ORIGINAL executor before this typed
    // Null is installed. No new spawn/Job/reaper or arbitrary args API.
    let outcome = super::execute_command_input(command, input, cancel, timeout);
    source.scope.matches(snapshot)?;
    source
        .selected_program()
        .verify()
        .map_err(|_| error("changed"))?;
    let output = outcome?;
    if !output.success {
        return Err(error(failure));
    }
    Ok(output.bytes)
}
struct SourceOwner {
    expected: Snapshot,
    source: ReadContext,
    inventory: Inventory,
    roots: Roots,
}
impl SourceOwner {
    fn observe(snapshot: &Snapshot, cancel: &AtomicBool) -> Result<Self> {
        cancelled(cancel)?;
        let head = snapshot.head.as_deref().ok_or(error("unborn"))?;
        inspect::target_allowed(snapshot, head)?;
        let source = ReadContext::open(Path::new(&snapshot.root))?;
        source.scope.matches(snapshot)?;
        let mut inventory = Inventory::capture(&source.scope.git, cancel)?;
        let format = match query(&source, snapshot, Query::Format, cancel)?.as_slice() {
            b"sha1\n" => "sha1",
            b"sha256\n" => "sha256",
            _ => return Err(error("unsupportedGit")),
        };
        let roots = inventory.roots(snapshot, format.into(), cancel)?;
        for commit in &roots.commits {
            if query(&source, snapshot, Query::CommitType(commit), cancel)? != b"commit\n" {
                return Err(error("unprovenPrivateCommits"));
            }
        }
        let owner = Self {
            expected: snapshot.clone(),
            source,
            inventory,
            roots,
        };
        owner.recheck(cancel)?;
        Ok(owner)
    }
    fn recheck(&self, cancel: &AtomicBool) -> Result<()> {
        self.inventory.verify(&self.source.scope.git, cancel)?;
        self.source.scope.matches(&self.expected)?;
        self.source
            .selected_program()
            .verify()
            .map_err(|_| error("changed"))?;
        cancelled(cancel)
    }
    fn query(&self, action: Query<'_>, cancel: &AtomicBool) -> Result<Vec<u8>> {
        query(&self.source, &self.expected, action, cancel)
    }
}
// Still a transient source observation, not a complete recovery Manifest.
// Raw source/config/index bytes do not enter a new persisted object/table.
pub(in crate::worktrees) struct SourceGraph {
    owner: SourceOwner,
    objects: Vec<String>,
}
impl SourceGraph {
    pub(in crate::worktrees) fn capture(snapshot: &Snapshot, cancel: &AtomicBool) -> Result<Self> {
        let owner = SourceOwner::observe(snapshot, cancel)?;
        let roots = super::Input::from_bytes(&owner.roots.input(), super::OUTPUT_LIMIT, cancel)?;
        let raw = owner.query(Query::Objects(roots), cancel)?;
        let objects = object_ids(&raw, &owner.roots, cancel)?;
        let ids = (objects.join("\n") + "\n").into_bytes();
        let input = super::Input::from_bytes(&ids, super::OUTPUT_LIMIT, cancel)?;
        let sizes = owner.query(Query::Sizes(input), cancel)?;
        validate_sizes(&sizes, &objects, cancel)?;
        let result = Self { owner, objects };
        result.recheck(cancel)?;
        Ok(result)
    }
    pub(in crate::worktrees) fn checkout_profile(
        &self,
        cancel: &AtomicBool,
    ) -> Result<(Vec<String>, Vec<u8>)> {
        self.recheck(cancel)?;
        let result = profile::capture(&self.owner, cancel);
        self.recheck(cancel)?;
        result
    }
    pub(in crate::worktrees) fn roots(&self) -> &Roots {
        &self.owner.roots
    }
    pub(in crate::worktrees) fn objects(&self) -> &[String] {
        &self.objects
    }
    pub(in crate::worktrees) fn recheck(&self, cancel: &AtomicBool) -> Result<()> {
        self.owner.recheck(cancel)
    }
}
fn object_ids(raw: &[u8], roots: &Roots, cancel: &AtomicBool) -> Result<Vec<String>> {
    cancelled(cancel)?;
    let text = std::str::from_utf8(raw).map_err(|_| error("recoveryInvalid"))?;
    let mut set = BTreeSet::new();
    for line in text.lines() {
        cancelled(cancel)?;
        if !oid(line) || line.len() != roots.head.len() || !set.insert(line.to_owned()) {
            return Err(error("recoveryInvalid"));
        }
        if set.len() > MAX_OBJECTS {
            return Err(error("recoveryLimit"));
        }
    }
    if !roots.commits.iter().all(|root| set.contains(root)) {
        return Err(error("recoveryInvalid"));
    }
    Ok(set.into_iter().collect())
}
fn validate_sizes(raw: &[u8], objects: &[String], cancel: &AtomicBool) -> Result<u64> {
    cancelled(cancel)?;
    let text = std::str::from_utf8(raw).map_err(|_| error("recoveryInvalid"))?;
    if text.lines().count() != objects.len() {
        return Err(error("recoveryInvalid"));
    }
    let mut bytes = 0u64;
    for (line, wanted) in text.lines().zip(objects) {
        cancelled(cancel)?;
        let fields = line.split(' ').collect::<Vec<_>>();
        if fields.len() != 3
            || fields[0] != wanted
            || !matches!(fields[1], "commit" | "tree" | "blob" | "tag")
        {
            return Err(error("recoveryInvalid"));
        }
        bytes = bytes
            .checked_add(
                fields[2]
                    .parse::<u64>()
                    .map_err(|_| error("recoveryInvalid"))?,
            )
            .filter(|v| *v <= MAX_BYTES)
            .ok_or(error("recoveryLimit"))?;
    }
    Ok(bytes)
}
#[cfg(test)]
pub(in crate::worktrees) fn capture(snapshot: &Snapshot, cancel: &AtomicBool) -> Result<Roots> {
    let owner = SourceOwner::observe(snapshot, cancel)?;
    Ok(owner.roots)
}

#[cfg(test)]
#[path = "source_roots_windows_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "source_graph_windows_tests.rs"]
mod graph_tests;

#[path = "git_source_checkout_windows.rs"]
mod profile;
