use super::{git, types::*};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Stamp {
    dev: u64,
    ino: u64,
}
pub(super) fn stamp(path: &Path) -> Result<Stamp> {
    let m = fs::symlink_metadata(path).map_err(|e| {
        error(if e.kind() == std::io::ErrorKind::NotFound {
            "missing"
        } else {
            "unavailable"
        })
    })?;
    if !m.is_dir() || m.file_type().is_symlink() {
        return Err(error("unsafePath"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(Stamp {
            dev: m.dev(),
            ino: m.ino(),
        })
    }
    #[cfg(not(unix))]
    {
        Err(error("unsupportedGit"))
    }
}
pub(super) fn canonical(path: &Path) -> Result<String> {
    if !path.is_absolute() {
        return Err(error("unsafePath"));
    }
    let p = path.canonicalize().map_err(|e| {
        error(if e.kind() == std::io::ErrorKind::NotFound {
            "missing"
        } else {
            "unavailable"
        })
    })?;
    stamp(&p)?;
    let s = p
        .to_str()
        .filter(|s| s.len() <= 4096)
        .ok_or(error("unsafePath"))?;
    Ok(s.into())
}
pub(super) fn same(path: &str, identity: &Stamp) -> Result<()> {
    if canonical(Path::new(path))? != path || stamp(Path::new(path))? != *identity {
        Err(error("changed"))
    } else {
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Snapshot {
    pub root: String,
    pub git_dir: String,
    pub common_dir: String,
    pub root_stamp: Stamp,
    pub git_stamp: Stamp,
    pub common_stamp: Stamp,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub trees: Vec<Tree>,
    pub blockers: Vec<String>,
}
impl Snapshot {
    pub fn identity(&self) -> Result<()> {
        same(&self.root, &self.root_stamp)?;
        same(&self.git_dir, &self.git_stamp)?;
        same(&self.common_dir, &self.common_stamp)
    }
    pub fn repository_root(&self) -> &str {
        self.trees
            .first()
            .map(|t| t.path.as_str())
            .unwrap_or(&self.root)
    }
}
fn git_path(root: &Path, value: String) -> Result<String> {
    let path = PathBuf::from(value);
    canonical(&if path.is_absolute() {
        path
    } else {
        root.join(path)
    })
}
pub(super) fn trees(root: &Path) -> Result<Vec<Tree>> {
    let bytes = git::read(root, &["worktree", "list", "--porcelain", "-z"])?;
    let mut trees = Vec::new();
    let mut current: Option<Tree> = None;
    for field in bytes.split(|b| *b == 0) {
        if field.is_empty() {
            if let Some(t) = current.take() {
                trees.push(t);
            }
            continue;
        }
        let s = std::str::from_utf8(field).map_err(|_| error("unsupportedGit"))?;
        if let Some(path) = s.strip_prefix("worktree ") {
            if current.is_some() || path.len() > 4096 || !Path::new(path).is_absolute() {
                return Err(error("unsupportedGit"));
            }
            current = Some(Tree {
                location_id: None,
                path: path.into(),
                branch: None,
                locked: false,
            });
        } else if let Some(t) = current.as_mut() {
            if let Some(branch) = s.strip_prefix("branch ") {
                t.branch = Some(branch.into());
            } else if s == "locked" || s.starts_with("locked ") {
                t.locked = true;
            } else if !(s.starts_with("HEAD ")
                || s == "detached"
                || s == "bare"
                || s == "prunable"
                || s.starts_with("prunable "))
            {
                return Err(error("unsupportedGit"));
            }
        } else {
            return Err(error("unsupportedGit"));
        }
    }
    if current.is_some() || trees.is_empty() || trees.len() > 256 {
        return Err(error("tooLarge"));
    }
    Ok(trees)
}
fn configured(root: &Path, pattern: &str) -> Result<bool> {
    let out = git::execute(
        root,
        &["config", "--null", "--get-regexp", pattern],
        &std::sync::atomic::AtomicBool::new(false),
        std::time::Duration::from_secs(10),
    )?;
    // Git returns 1 when no key matched; no values ever leave this module.
    match out.code {
        Some(0) => Ok(!out.bytes.is_empty()),
        Some(1) if out.bytes.is_empty() => Ok(false),
        _ => Err(error("unavailable")),
    }
}
pub(super) fn snapshot(path: &Path) -> Result<Snapshot> {
    let selected = canonical(path)?;
    let selected = Path::new(&selected);
    if git::text(selected, &["rev-parse", "--is-bare-repository"])? == "true" {
        return Err(error("bare"));
    }
    let root = git_path(
        selected,
        git::text(selected, &["rev-parse", "--show-toplevel"])?,
    )?;
    let p = Path::new(&root);
    let root_stamp = stamp(p)?;
    let git_dir = git_path(p, git::text(p, &["rev-parse", "--absolute-git-dir"])?)?;
    let common_dir = git_path(p, git::text(p, &["rev-parse", "--git-common-dir"])?)?;
    let mut blockers = Vec::new();
    if configured(p, r"^(extensions\.partialclone|remote\..*\.promisor)$")? {
        blockers.push("partialClone".into());
    }
    if git::config(p, "core.sparseCheckout", true)?.as_deref() == Some("true") {
        blockers.push("sparseCheckout".into());
    }
    // Only inspect object IDs after partial-clone detection; no object-demand command may fetch.
    let head = git::text(p, &["rev-parse", "--verify", "HEAD"])
        .ok()
        .filter(|s| oid(s));
    let branch = git::text(p, &["symbolic-ref", "-q", "HEAD"]).ok();
    if head.is_none() {
        blockers.push("unborn".into());
    } else if branch.is_none() {
        blockers.push("detached".into());
    }
    let all = trees(p)?;
    if all.iter().any(|t| t.path == root && t.locked) {
        blockers.push("locked".into());
    }
    let s = Snapshot {
        git_stamp: stamp(Path::new(&git_dir))?,
        common_stamp: stamp(Path::new(&common_dir))?,
        root,
        git_dir,
        common_dir,
        root_stamp,
        head,
        branch,
        trees: all,
        blockers,
    };
    s.identity()?;
    Ok(s)
}
pub(super) fn refs(s: &Snapshot) -> Result<Vec<Ref>> {
    s.identity()?;
    let raw = git::read(
        Path::new(&s.root),
        &[
            "for-each-ref",
            "--count=4097",
            "--format=%(refname)%00%(objectname)%00",
            "refs/heads/",
        ],
    )?;
    let mut values = Vec::new();
    for line in raw.split(|b| *b == b'\n').filter(|s| !s.is_empty()) {
        let fields = line.split(|b| *b == 0).collect::<Vec<_>>();
        if fields.len() != 3 || !fields[2].is_empty() {
            return Err(error("unsupportedGit"));
        }
        let name = std::str::from_utf8(fields[0]).map_err(|_| error("unsupportedGit"))?;
        let value = std::str::from_utf8(fields[1]).map_err(|_| error("unsupportedGit"))?;
        if !name.starts_with("refs/heads/") || !oid(value) || name.len() > 4096 {
            return Err(error("unsupportedGit"));
        }
        values.push(Ref {
            r#ref: name.into(),
            oid: value.into(),
            in_use: s.trees.iter().any(|t| t.branch.as_deref() == Some(name)),
        });
    }
    if values.len() > 4096 {
        return Err(error("tooLarge"));
    }
    s.identity()?;
    Ok(values)
}
/// Deliberately refuses custom conversions; never uses the current HEAD/index for a selected OID.
pub(super) fn target_allowed(s: &Snapshot, selected: &str) -> Result<()> {
    if !oid(selected) {
        return Err(error("invalidRef"));
    }
    if let Some(code) = s.blockers.iter().find(|c| {
        matches!(
            c.as_str(),
            "filters" | "partialClone" | "sparseCheckout" | "unborn" | "locked"
        )
    }) {
        return Err(error(match code.as_str() {
            "filters" => "filters",
            "partialClone" => "partialClone",
            "sparseCheckout" => "sparseCheckout",
            "locked" => "locked",
            _ => "unborn",
        }));
    }
    s.identity()
}
pub(super) fn check_target(s: &Snapshot, selected: &str) -> Result<()> {
    super::checkout::Checkout::prepare(s, selected).map(|_| ())
}
pub(super) fn target_objects(
    selected: &str,
    read: impl Fn(&[&str]) -> Result<Vec<u8>>,
) -> Result<Vec<u8>> {
    if read(&["cat-file", "-t", selected])? != b"commit\n" {
        return Err(error("invalidRef"));
    }
    let raw = read(&["ls-tree", "-r", "-l", "-z", selected])?;
    let mut count = 0u64;
    let mut total = 0u64;
    for record in raw.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        count += 1;
        if count > 100_000 {
            return Err(error("tooLarge"));
        }
        let Some(tab) = record.iter().position(|b| *b == b'\t') else {
            return Err(error("unsupportedGit"));
        };
        let header = std::str::from_utf8(&record[..tab]).map_err(|_| error("unsupportedGit"))?;
        let fields: Vec<_> = header.split_ascii_whitespace().collect();
        if fields.len() != 4 {
            return Err(error("unsupportedGit"));
        }
        if fields[0] == "160000" || fields[1] == "commit" {
            return Err(error("submodules"));
        }
        if fields[1] != "blob" || !oid(fields[2]) {
            return Err(error("unsupportedGit"));
        }
        let size = fields[3]
            .parse::<u64>()
            .map_err(|_| error("unsupportedGit"))?;
        total = total.checked_add(size).ok_or(error("tooLarge"))?;
        if total > 1024 * 1024 * 1024 || size > 256 * 1024 * 1024 {
            return Err(error("tooLarge"));
        }
        let path = &record[tab + 1..];
        if path == b".gitmodules" {
            return Err(error("submodules"));
        }
        // All target paths go to Git's own attribute evaluator below.
        if path.is_empty() {
            return Err(error("unsupportedGit"));
        }
    }
    let mut paths = Vec::new();
    for record in raw.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        let tab = record
            .iter()
            .position(|b| *b == b'\t')
            .ok_or(error("unsupportedGit"))?;
        paths.extend_from_slice(&record[tab + 1..]);
        paths.push(0);
    }
    Ok(paths)
}
