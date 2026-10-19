use super::{
    git, inspect, material_scan,
    recovery_pack::{self, Manifest},
    recycle,
    storage::RemoveIntent,
    types::*,
};
use sha2::{Digest, Sha256};
use std::{fs, path::Path, sync::atomic::AtomicBool, time::Duration};
pub(super) fn profile(m: &Manifest) -> Result<String> {
    Ok(material_scan::hex(Sha256::digest(
        serde_json::to_vec(&(&m.configs, &m.attributes)).map_err(|_| error("recoveryInvalid"))?,
    )))
}
pub(super) fn capture(
    material: &super::material_owner::Owner,
    saved: &super::storage::SavedArchive,
    cancel: &AtomicBool,
) -> Result<Manifest> {
    let s = recycle::verify_at(material, saved, true, cancel)?;
    let diff = git::execute(
        Path::new(&s.root),
        &[
            "diff-index",
            "--cached",
            "--quiet",
            "--no-ext-diff",
            "--no-textconv",
            "HEAD",
            "--",
        ],
        cancel,
        Duration::from_secs(15),
    )?;
    if diff.code != Some(0) {
        return Err(error("dirtyTracked"));
    }
    let plan = recovery_pack::capture(&s, cancel)?;
    recycle::verify_at(material, saved, true, cancel)?;
    Ok(plan)
}
pub(super) fn same_plan(i: &RemoveIntent, m: &Manifest) -> Result<()> {
    if m.roots.summary()? != i.roots || m.content != i.content || profile(m)? != i.profile_sha256 {
        return Err(error("recoveryChanged"));
    }
    Ok(())
}
pub(super) fn reserve(i: &RemoveIntent) -> Result<inspect::Stamp> {
    inspect::same(&i.saved.parent, &i.saved.parent_stamp)?;
    if Path::new(&i.recovery_path).parent() != Some(Path::new(&i.saved.parent)) {
        return Err(error("unsafePath"));
    }
    let b = fs::DirBuilder::new();
    #[cfg(unix)]
    let b = {
        let mut b = b;
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
        b
    };
    b.create(&i.recovery_path)
        .map_err(|_| error("targetExists"))?;
    let stamp = inspect::stamp(Path::new(&i.recovery_path))?;
    fs::File::open(&i.saved.parent)
        .and_then(|f| f.sync_all())
        .map_err(|_| error("unavailable"))?;
    Ok(stamp)
}
pub(super) fn verify_deleted(i: &RemoveIntent, cancel: &AtomicBool) -> Result<()> {
    if !i.dispatched {
        return Err(error("unknown"));
    }
    let s = &i.saved;
    let r = i.recovery.as_ref().ok_or(error("recoveryInvalid"))?;
    recovery_pack::verify(r, cancel)?;
    inspect::same(&s.parent, &s.parent_stamp)?;
    inspect::same(
        &s.retained_parent,
        s.retained_parent_stamp.as_ref().ok_or(error("unknown"))?,
    )?;
    inspect::same(
        &s.original.identity.common_dir,
        &s.original.identity.common_stamp,
    )?;
    recycle::absent(&s.archive.original_path)?;
    recycle::absent(&s.archive.retained_path)?;
    recycle::absent(&s.original.identity.git_dir)?;
    let now = inspect::snapshot(Path::new(&s.archive.repository_root))?;
    if now
        .trees
        .iter()
        .any(|v| v.path == s.archive.original_path || v.path == s.archive.retained_path)
    {
        return Err(error("unknown"));
    }
    if let Some(branch) = &s.archive.branch
        && git::text(
            Path::new(&s.archive.repository_root),
            &["rev-parse", "--verify", branch],
        )? != s.archive.head_oid
    {
        return Err(error("changed"));
    }
    inspect::same(&s.parent, &s.parent_stamp)?;
    inspect::same(
        &s.retained_parent,
        s.retained_parent_stamp.as_ref().ok_or(error("unknown"))?,
    )?;
    Ok(())
}
pub(super) fn delete(
    material: &super::material_owner::Owner,
    i: &RemoveIntent,
    cancel: &AtomicBool,
    before_dispatch: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let plan = capture(material, &i.saved, cancel)?;
    same_plan(i, &plan)?;
    let restored =
        recovery_pack::verify(i.recovery.as_ref().ok_or(error("recoveryInvalid"))?, cancel)?;
    if plan != restored {
        return Err(error("recoveryChanged"));
    }
    // Last read after independent recovery: no stale source proof is promoted.
    same_plan(i, &capture(material, &i.saved, cancel)?)?;
    if cancel.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(error("cancelled"));
    }
    before_dispatch()?;
    let result = git::execute(
        Path::new(&i.saved.archive.repository_root),
        &["worktree", "remove", "--", &i.saved.archive.retained_path],
        cancel,
        Duration::from_secs(30),
    )?;
    if result.code != Some(0) {
        return Err(error("unknown"));
    }
    let mut dispatched = i.clone();
    dispatched.dispatched = true;
    verify_deleted(&dispatched, &AtomicBool::new(false))
}
