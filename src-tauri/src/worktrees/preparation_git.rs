//! Fixed local Git metadata reads only. No status, index refresh or object checkout.
#[cfg(target_os = "macos")]
use super::{
    git, inspect,
    storage::SavedLocation,
    types::{Result, error, oid},
};
use super::{preparation_types::PreparationGit, types::Tree};
#[cfg(target_os = "macos")]
use std::{path::Path, sync::atomic::AtomicBool, time::Duration};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct GitObservation {
    pub summary: PreparationGit,
    pub trees: Vec<Tree>,
}
#[cfg(target_os = "macos")]
fn read(root: &Path, args: &[&str]) -> Result<git::Output> {
    let mut all = vec!["--no-optional-locks"];
    all.extend_from_slice(args);
    git::execute(root, &all, &AtomicBool::new(false), Duration::from_secs(10))
}
#[cfg(target_os = "macos")]
fn text(root: &Path, args: &[&str]) -> Result<String> {
    let result = read(root, args)?;
    if !result.success {
        return Err(error("unavailable"));
    }
    String::from_utf8(result.bytes)
        .map(|s| s.strip_suffix('\n').unwrap_or(&s).to_owned())
        .map_err(|_| error("unsupportedGit"))
}
#[cfg(target_os = "macos")]
fn directory(root: &Path, args: &[&str]) -> Result<String> {
    let value = text(root, args)?;
    let value = Path::new(&value);
    inspect::canonical(&if value.is_absolute() {
        value.to_owned()
    } else {
        root.join(value)
    })
}
#[cfg(target_os = "macos")]
fn parse_trees(bytes: &[u8]) -> Result<Vec<Tree>> {
    let mut trees = Vec::new();
    let mut current: Option<Tree> = None;
    for field in bytes.split(|b| *b == 0) {
        if field.is_empty() {
            if let Some(tree) = current.take() {
                trees.push(tree);
            }
            continue;
        }
        let value = std::str::from_utf8(field).map_err(|_| error("unsupportedGit"))?;
        if let Some(path) = value.strip_prefix("worktree ") {
            if current.is_some() || path.len() > 4096 || !Path::new(path).is_absolute() {
                return Err(error("unsupportedGit"));
            }
            current = Some(Tree {
                location_id: None,
                path: path.into(),
                branch: None,
                locked: false,
            });
        } else if let Some(tree) = current.as_mut() {
            if let Some(branch) = value.strip_prefix("branch ") {
                tree.branch = Some(branch.into());
            } else if value == "locked" || value.starts_with("locked ") {
                tree.locked = true;
            } else if !(value.starts_with("HEAD ")
                || matches!(value, "detached" | "bare" | "prunable")
                || value.starts_with("prunable "))
            {
                return Err(error("unsupportedGit"));
            }
        } else {
            return Err(error("unsupportedGit"));
        }
    }
    if current.is_some() || trees.is_empty() || trees.len() > 256 {
        return Err(error("unsupportedGit"));
    }
    Ok(trees)
}
#[cfg(target_os = "macos")]
pub(super) fn observe(saved: &SavedLocation) -> Result<GitObservation> {
    saved.identity.check()?;
    let l = &saved.location;
    let root = Path::new(&l.path);
    if text(root, &["rev-parse", "--is-bare-repository"])? != "false"
        || directory(root, &["rev-parse", "--show-toplevel"])? != saved.identity.root
        || directory(root, &["rev-parse", "--absolute-git-dir"])? != saved.identity.git_dir
        || directory(root, &["rev-parse", "--git-common-dir"])? != saved.identity.common_dir
    {
        return Err(error("changed"));
    }
    let head = text(root, &["rev-parse", "--verify", "HEAD"])?;
    if !oid(&head) || head != l.head_oid {
        return Err(error("changed"));
    }
    let branch = read(root, &["symbolic-ref", "-q", "HEAD"])?;
    let branch = match branch.code {
        Some(0) => Some(
            String::from_utf8(branch.bytes)
                .map_err(|_| error("unsupportedGit"))?
                .trim_end_matches('\n')
                .to_owned(),
        ),
        Some(1) if branch.bytes.is_empty() => None,
        _ => return Err(error("unavailable")),
    };
    if branch != l.branch {
        return Err(error("changed"));
    }
    let listing = read(root, &["worktree", "list", "--porcelain", "-z"])?;
    if !listing.success {
        return Err(error("unavailable"));
    }
    let trees = parse_trees(&listing.bytes)?;
    if trees[0].path != l.repository_root
        || l.repository_root != saved.identity.repository_root
        || trees
            .iter()
            .filter(|t| t.path == l.path && t.branch == l.branch)
            .count()
            != 1
    {
        return Err(error("changed"));
    }
    saved.identity.check()?;
    Ok(GitObservation {
        summary: PreparationGit {
            kind: if l.path == l.repository_root {
                "main"
            } else {
                "linked"
            },
            other_worktree_count: trees.len() - 1,
        },
        trees,
    })
}
