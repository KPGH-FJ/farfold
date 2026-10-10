//! Restoration is a new independent repository, never another linked-tree ownership grant.
use super::{
    inspect::{self, Snapshot},
    recovery_pack,
    storage::{RecoverIntent, Request, SavedOperation},
    types::*,
};
use std::{fs, path::Path, sync::atomic::AtomicBool};
fn overlap(a: &Path, b: &Path) -> bool {
    a.starts_with(b) || b.starts_with(a)
}
pub(super) fn absent(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Err(error("targetExists")),
        Err(_) => Err(error("unavailable")),
    }
}
pub(super) fn prepare(
    input: super::RecoverInput,
    recovery: recovery_pack::SavedRecovery,
) -> Result<RecoverIntent> {
    if !id(&input.recovery_id)
        || input.directory_name.is_empty()
        || input.directory_name.len() > 200
        || input.directory_name.starts_with('.')
        || input.directory_name.contains(['/', '\\', '\0'])
        || input.directory_name.chars().any(char::is_control)
    {
        return Err(error("unsafePath"));
    }
    let parent = inspect::canonical(Path::new(&input.parent_path))?;
    if parent != input.parent_path {
        return Err(error("unsafePath"));
    }
    let target = Path::new(&parent).join(&input.directory_name);
    absent(&target)?;
    let r = &recovery.receipt;
    if [
        &r.original_path,
        &r.retained_path,
        &r.repository_root,
        &r.path,
        &recovery.source.original.identity.common_dir,
    ]
    .iter()
    .any(|p| overlap(&target, Path::new(p)))
    {
        return Err(error("unsafePath"));
    }
    // Do not materialize a nested repository inside another explicitly owned repository/data tree.
    for ancestor in Path::new(&parent).ancestors() {
        if fs::symlink_metadata(ancestor.join(".git")).is_ok()
            || (ancestor.join("HEAD").is_file() && ancestor.join("objects").is_dir())
        {
            return Err(error("unsafePath"));
        }
    }
    recovery_pack::verify(&recovery, &AtomicBool::new(false))?;
    Ok(RecoverIntent {
        input,
        recovery,
        parent_stamp: inspect::stamp(Path::new(&parent))?,
        parent,
        target: target.to_str().ok_or(error("unsafePath"))?.into(),
        target_stamp: None,
        dispatched: false,
    })
}
pub(super) fn revalidate(i: &RecoverIntent) -> Result<()> {
    inspect::same(&i.parent, &i.parent_stamp)?;
    let fresh = prepare(i.input.clone(), i.recovery.clone())?;
    if fresh.target != i.target || fresh.parent_stamp != i.parent_stamp {
        return Err(error("changed"));
    }
    Ok(())
}
pub(super) fn verify(i: &RecoverIntent, cancel: &AtomicBool) -> Result<Snapshot> {
    inspect::same(&i.parent, &i.parent_stamp)?;
    inspect::same(&i.target, i.target_stamp.as_ref().ok_or(error("unknown"))?)?;
    let m = recovery_pack::verify(&i.recovery, cancel)?;
    recovery_pack::verify_restored(Path::new(&i.target), &m, cancel)?;
    let s = inspect::snapshot(Path::new(&i.target))?;
    if s.root != i.target
        || s.repository_root() != i.target
        || s.common_dir != s.git_dir
        || s.git_dir
            != Path::new(&i.target)
                .join(".git")
                .to_str()
                .ok_or(error("unsafePath"))?
        || s.head.as_deref() != Some(&i.recovery.receipt.head_oid)
        || s.branch != Some(recovery_pack::expected_branch(&m)?)
        || s.trees.len() != 1
    {
        return Err(error("changed"));
    }
    inspect::same(&i.parent, &i.parent_stamp)?;
    inspect::same(&i.target, i.target_stamp.as_ref().ok_or(error("unknown"))?)?;
    Ok(s)
}
pub(super) fn valid_operation(o: &SavedOperation) -> bool {
    let Some(i) = &o.recovery else {
        return false;
    };
    let s = &o.status;
    matches!(&o.request, Request::Recover(v) if v == &i.input)
        && super::remove_validation::recovery(&i.recovery)
        && i.input.recovery_id == i.recovery.receipt.id
        && i.input.expected_revision == i.recovery.receipt.revision
        && Path::new(&i.parent).is_absolute()
        && Path::new(&i.target).parent() == Some(Path::new(&i.parent))
        && Path::new(&i.target).file_name().and_then(|v| v.to_str())
            == Some(&i.input.directory_name)
        && i.input.parent_path == i.parent
        && s.target_path.as_ref() == Some(&i.target)
        && s.recovery.as_ref().is_some_and(|r| {
            r.id == i.recovery.receipt.id
                && r.bundle_sha256 == i.recovery.receipt.bundle_sha256
                && r.manifest_sha256 == i.recovery.receipt.manifest_sha256
                && r.revision == i.recovery.receipt.revision
        })
        && !s.maintenance_active
        && o.intent.is_none()
        && o.recycle.is_none()
        && o.removal.is_none()
        && s.archive.is_none()
        && s.original_path.is_none()
        && s.retained_path.is_none()
        && s.removal_phase.is_none()
        && s.delete_dispatched.is_none()
        && s.removed.is_none()
        && (s.state != "ready"
            || s.location.as_ref().is_some_and(|l| {
                l.ownership == "existing"
                    && l.path == i.target
                    && l.repository_root == i.target
                    && l.head_oid == i.recovery.receipt.head_oid
            }))
}
