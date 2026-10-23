use super::{
    git, inspect, material_scan,
    recovery_pack::{self, Capture},
    recycle,
    storage::RemoveIntent,
    types::*,
};
use sha2::{Digest, Sha256};
#[cfg(not(windows))]
use std::{fs, time::Duration};
use std::{path::Path, sync::atomic::AtomicBool};
pub(super) fn supported() -> Result<()> {
    super::recover::supported()
}
pub(super) fn profile(m: &Capture) -> Result<String> {
    profile_values(&m.configs, &m.attributes)
}
pub(super) fn profile_values(configs: &[String], attributes: &[u8]) -> Result<String> {
    Ok(material_scan::hex(Sha256::digest(
        serde_json::to_vec(&(configs, attributes)).map_err(|_| error("recoveryInvalid"))?,
    )))
}
pub(super) fn capture(
    material: &super::material_owner::Owner,
    saved: &super::storage::SavedArchive,
    cancel: &AtomicBool,
) -> Result<Capture> {
    let s = recycle::verify_at(material, saved, true, cancel)?;
    #[cfg(windows)]
    git::source_roots::SourceGraph::capture(&s, cancel)?.require_clean_index(cancel)?;
    #[cfg(not(windows))]
    {
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
    }
    let plan = recovery_pack::capture(material, &s, saved.material.profile.as_ref(), cancel)?;
    recycle::verify_at(material, saved, true, cancel)?;
    Ok(plan)
}
pub(super) fn same_plan(i: &RemoveIntent, m: &Capture) -> Result<()> {
    if m.roots.summary()? != i.roots || m.content != i.content || profile(m)? != i.profile_sha256 {
        return Err(error("recoveryChanged"));
    }
    Ok(())
}
pub(super) struct Reservation {
    pub stamp: inspect::Stamp,
    #[cfg(windows)]
    owner: crate::file_access::PinnedPath,
}
impl Reservation {
    pub fn verify(&self) -> Result<()> {
        #[cfg(windows)]
        {
            self.owner.verify().map_err(|_| error("recoveryChanged"))?;
            if inspect::pinned_stamp(&self.owner)? != self.stamp {
                return Err(error("recoveryChanged"));
            }
        }
        Ok(())
    }
}
#[cfg(windows)]
pub(super) fn reserve(i: &RemoveIntent) -> Result<Reservation> {
    reserve_at(
        Path::new(&i.saved.parent),
        &i.saved.parent_stamp,
        Path::new(&i.recovery_path),
    )
}
#[cfg(windows)]
pub(super) fn reserve_at(
    parent_path: &Path,
    parent_stamp: &inspect::Stamp,
    path: &Path,
) -> Result<Reservation> {
    use crate::file_access::{PinnedPath, WorktreeCheckout};
    let parent = PinnedPath::directory(parent_path).map_err(|_| error("recoveryChanged"))?;
    if inspect::pinned_stamp(&parent)? != *parent_stamp || path.parent() != Some(parent_path) {
        return Err(error("unsafePath"));
    }
    let leaf = path
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or(error("unsafePath"))?;
    let owner = WorktreeCheckout::<'static>::create_under(&parent, leaf)
        .map_err(|_| error("targetExists"))?;
    let stamp = inspect::pinned_stamp(owner.root())?;
    // Keep the original no-DELETE pin throughout the build, but finish the
    // empty reservation's creation writer before material.bin's no-replace
    // rename needs FILE_ADD_FILE on this same destination parent.
    let owner = owner
        .into_reserved_directory(&AtomicBool::new(false))
        .map_err(|_| error("recoveryChanged"))?;
    let result = Reservation { stamp, owner };
    result.verify()?;
    parent.verify().map_err(|_| error("recoveryChanged"))?;
    Ok(result)
}
#[cfg(not(windows))]
pub(super) fn reserve(i: &RemoveIntent) -> Result<Reservation> {
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
    Ok(Reservation { stamp })
}
pub(super) fn verify_deleted(
    material: &super::material_owner::Owner,
    i: &RemoveIntent,
    cancel: &AtomicBool,
) -> Result<()> {
    if !i.dispatched {
        return Err(error("unknown"));
    }
    let s = &i.saved;
    let r = i.recovery.as_ref().ok_or(error("recoveryInvalid"))?;
    recovery_pack::verify(material, r, cancel)?;
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
        && !inspect::refs(&now)?
            .iter()
            .any(|value| value.r#ref == *branch && value.oid == s.archive.head_oid)
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
#[cfg(not(windows))]
pub(super) fn delete(
    material: &super::material_owner::Owner,
    i: &RemoveIntent,
    cancel: &AtomicBool,
    before_dispatch: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let plan = capture(material, &i.saved, cancel)?;
    same_plan(i, &plan)?;
    let restored = recovery_pack::verify(
        material,
        i.recovery.as_ref().ok_or(error("recoveryInvalid"))?,
        cancel,
    )?;
    if !plan.matches(&restored) {
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
    verify_deleted(material, &dispatched, &AtomicBool::new(false))
}

#[cfg(windows)]
#[path = "remove_windows.rs"]
mod windows;
#[cfg(windows)]
pub(super) use windows::delete;
