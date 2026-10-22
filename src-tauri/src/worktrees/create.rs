use super::{
    git,
    inspect::{self, Snapshot},
    storage::{Identity, Intent},
    types::*,
};
#[cfg(not(windows))]
use std::time::Duration;
use std::{path::Path, sync::atomic::AtomicBool};
#[cfg(windows)]
#[path = "create_windows.rs"]
mod windows;
pub(super) fn supported() -> Result<()> {
    #[cfg(windows)]
    {
        git::environment()
    }
    #[cfg(not(windows))]
    {
        super::mutation_supported()
    }
}
#[cfg(windows)]
pub(super) fn reserve(intent: &Intent) -> Result<crate::file_access::WorktreeCheckout<'static>> {
    let parent = crate::file_access::PinnedPath::directory(Path::new(&intent.parent))
        .map_err(|_| error("changed"))?;
    if parent.path != intent.parent || inspect::pinned_stamp(&parent)? != intent.parent_stamp {
        return Err(error("changed"));
    }
    let owned =
        crate::file_access::WorktreeCheckout::create_under(&parent, &intent.input.directory_name)
            .map_err(|e| {
            error(if e.kind() == std::io::ErrorKind::AlreadyExists {
                "targetExists"
            } else {
                // FILE_CREATE may already have succeeded before a later
                // identity/namespace handoff failed. Never claim no change.
                "unknown"
            })
        })?;
    if owned.root().path != intent.target {
        return Err(error("unknown"));
    }
    Ok(owned)
}
fn absent(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Err(error("targetExists")),
        Err(_) => Err(error("unavailable")),
    }
}
fn overlap(a: &Path, b: &Path) -> bool {
    a.starts_with(b) || b.starts_with(a)
}
pub(super) fn validate(source: &Snapshot, input: &Create) -> Result<Intent> {
    if !id(&input.inspection_id)
        || input.directory_name.is_empty()
        || input.directory_name.len() > 200
        || input.directory_name.starts_with('.')
        || input.directory_name.contains(['/', '\\', '\0'])
        || input.directory_name.chars().any(char::is_control)
    {
        return Err(error("unsafePath"));
    }
    let parent = inspect::canonical(Path::new(&input.parent_path))?;
    // Reject aliases rather than trusting a different parent than the user reviewed.
    if parent != input.parent_path {
        return Err(error("unsafePath"));
    }
    let target = Path::new(&parent).join(&input.directory_name);
    absent(&target)?;
    let current = inspect::snapshot(Path::new(&source.root))?;
    if !Identity::from(source).matches(&current) {
        return Err(error("changed"));
    }
    if current
        .trees
        .iter()
        .any(|t| overlap(&target, Path::new(&t.path)))
        || overlap(&target, Path::new(&current.common_dir))
    {
        return Err(error("unsafePath"));
    }
    let branch = input.branch.name();
    if branch.is_empty() || branch.len() > 200 || branch.starts_with('-') || branch.contains('\0') {
        return Err(error("invalidRef"));
    }
    let full = format!("refs/heads/{branch}");
    git::read(Path::new(&current.root), &["check-ref-format", &full])
        .map_err(|_| error("invalidRef"))?;
    let refs = inspect::refs(&current)?;
    match &input.branch {
        Branch::New { .. } => {
            if refs.iter().any(|r| r.r#ref == full) {
                return Err(error("branchExists"));
            }
        }
        Branch::Existing {
            r#ref,
            expected_oid,
        } => {
            let r = refs
                .iter()
                .find(|r| r.r#ref == *r#ref)
                .ok_or(error("changed"))?;
            if r.oid != *expected_oid {
                return Err(error("changed"));
            }
            if r.in_use {
                return Err(error("branchInUse"));
            }
        }
    }
    inspect::check_target(&current, input.branch.oid())?;
    Ok(Intent {
        input: input.clone(),
        source: Identity::from(&current),
        parent_stamp: inspect::stamp(Path::new(&parent))?,
        parent,
        target: target.to_str().ok_or(error("unsafePath"))?.into(),
        target_stamp: None,
        dispatched: false,
    })
}
pub(super) fn revalidate(intent: &Intent) -> Result<()> {
    intent.source.check()?;
    inspect::same(&intent.parent, &intent.parent_stamp)?;
    let snap = inspect::snapshot(Path::new(&intent.source.root))?;
    let fresh = validate(&snap, &intent.input)?;
    if fresh.target != intent.target
        || fresh.parent_stamp != intent.parent_stamp
        || !intent.source.matches(&snap)
    {
        return Err(error("changed"));
    }
    Ok(())
}
pub(super) fn add(intent: &Intent, cancel: &AtomicBool) -> Result<()> {
    intent.source.check()?;
    inspect::same(&intent.parent, &intent.parent_stamp)?;
    let stamp = intent.target_stamp.as_ref().ok_or(error("unknown"))?;
    inspect::same(&intent.target, stamp)?;
    #[cfg(windows)]
    return windows::add(intent, cancel);
    #[cfg(not(windows))]
    {
        let mut args = vec!["worktree", "add", "--no-checkout"];
        match &intent.input.branch {
            Branch::New { name, start_oid } => {
                args.extend(["--no-track", "-b", name, "--", &intent.target, start_oid]);
            }
            Branch::Existing { .. } => {
                args.extend(["--", &intent.target, intent.input.branch.name()]);
            }
        }
        let result = git::execute(
            Path::new(&intent.source.root),
            &args,
            cancel,
            Duration::from_secs(120),
        )?;
        if !result.success {
            return Err(error("unknown"));
        }
        Ok(())
    }
}
pub(super) fn verify(intent: &Intent) -> Result<Snapshot> {
    intent.source.check()?;
    inspect::same(&intent.parent, &intent.parent_stamp)?;
    inspect::same(
        &intent.target,
        intent.target_stamp.as_ref().ok_or(error("unknown"))?,
    )?;
    let actual = inspect::snapshot(Path::new(&intent.target))?;
    if actual.root != intent.target
        || actual.common_dir != intent.source.common_dir
        || actual.common_stamp != intent.source.common_stamp
        || actual.head.as_deref() != Some(intent.input.branch.oid())
        || actual.branch.as_deref() != Some(&format!("refs/heads/{}", intent.input.branch.name()))
        || !actual
            .trees
            .iter()
            .any(|t| t.path == actual.root && t.branch == actual.branch)
    {
        return Err(error("changed"));
    }
    Ok(actual)
}
