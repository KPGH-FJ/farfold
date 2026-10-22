//! One fixed registration into an already reserved empty worktree leaf.
//! Registration is not checkout or created-location publication.
use super::super::{git, inspect, storage::Intent, types::*, windows_git::ReadContext};
use crate::file_access::PinnedPath;
use std::{
    path::Path,
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

pub(super) fn add(intent: &Intent, cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::SeqCst) {
        return Err(error("cancelled"));
    }
    let snapshot = inspect::snapshot(Path::new(&intent.source.root))?;
    if !intent.source.matches(&snapshot) {
        return Err(error("changed"));
    }
    let source = ReadContext::open(Path::new(&snapshot.root))?;
    source.scope.matches(&snapshot)?;
    let parent = PinnedPath::directory(Path::new(&intent.parent)).map_err(|_| error("changed"))?;
    let target = PinnedPath::directory(Path::new(&intent.target)).map_err(|_| error("changed"))?;
    if inspect::pinned_stamp(&parent)? != intent.parent_stamp
        || Some(&inspect::pinned_stamp(&target)?) != intent.target_stamp.as_ref()
        || target.path != intent.target
        || parent.path != intent.parent
        || !target.has_ancestor(parent.identity())
        || target.guid_path.parent() != Some(parent.guid_path.as_path())
    {
        return Err(error("changed"));
    }
    let paths = super::super::windows_git::paths::Paths::new(&[
        source.selected_program(),
        &source.scope.root,
        &source.scope.git,
        &source.scope.common,
        &parent,
        &target,
    ])?;
    let program = paths.path(source.selected_program())?;
    let mut command = Command::new(program);
    command
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_COMMON_DIR", paths.path(&source.scope.common)?)
        .args(["--no-pager", "--no-replace-objects", "-c"])
        .arg(format!("core.hooksPath={}", program.display()))
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
        .arg(paths.path(&source.scope.git)?)
        .arg("--work-tree")
        .arg(paths.path(&source.scope.root)?)
        .arg("-C")
        .arg(paths.path(&source.scope.root)?)
        .args(["worktree", "add", "--no-checkout"]);
    match &intent.input.branch {
        Branch::New { name, start_oid } => {
            command
                .args(["--no-track", "-b", name, "--"])
                .arg(paths.path(&target)?)
                .arg(start_oid);
        }
        Branch::Existing { .. } => {
            command
                .arg("--")
                .arg(paths.path(&target)?)
                .arg(intent.input.branch.name());
        }
    }
    command
        .current_dir(paths.path(&source.scope.root)?)
        .stdin(Stdio::null());
    // The existing executor retains the exact Child/direct Job and both pipes
    // until actual quiescence, including cancellation and unwind.
    let outcome = git::execute_command(command, cancel, Duration::from_secs(120));
    paths.verify()?;
    source.scope.matches(&snapshot)?;
    source
        .selected_program()
        .verify()
        .map_err(|_| error("changed"))?;
    if !outcome?.success {
        return Err(error("unknown"));
    }
    Ok(())
}
#[cfg(test)]
#[path = "create_windows_tests.rs"]
mod tests;
