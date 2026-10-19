//! Same-filesystem retention, not a self-contained repository backup.
use super::{git, inspect, material_scan, recycle_types::*, storage::*, types::*};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path, sync::atomic::AtomicBool, time::Duration};

pub(super) fn index_digest(identity: &Identity) -> Result<Option<String>> {
    let path = Path::new(&identity.git_dir).join("index");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(error("unavailable")),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 32 * 1024 * 1024
    {
        return Err(error("materialLimit"));
    }
    let mut opts = fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = opts.open(path).map_err(|_| error("changed"))?;
    let before = crate::file_access::stamp(&file).map_err(|_| error("changed"))?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(32 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("unavailable"))?;
    if bytes.len() > 32 * 1024 * 1024
        || before != crate::file_access::stamp(&file).map_err(|_| error("changed"))?
    {
        return Err(error("changed"));
    }
    Ok(Some(material_scan::hex(Sha256::digest(&bytes))))
}
pub(super) fn absent(path: &str) -> Result<()> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(_) => Err(error("targetExists")),
        Err(_) => Err(error("unavailable")),
    }
}
fn snapshot(saved: &SavedArchive, path: &str) -> Result<inspect::Snapshot> {
    let i = &saved.original.identity;
    inspect::same(path, &i.root_stamp)?;
    inspect::same(&i.git_dir, &i.git_stamp)?;
    inspect::same(&i.common_dir, &i.common_stamp)?;
    let s = inspect::snapshot(Path::new(path))?;
    if s.root != path
        || s.git_dir != i.git_dir
        || s.common_dir != i.common_dir
        || s.root_stamp != i.root_stamp
        || s.repository_root() != i.repository_root
        || s.head.as_deref() != Some(&saved.archive.head_oid)
        || s.branch != saved.archive.branch
        || s.root == s.repository_root()
        || s.trees
            .iter()
            .filter(|t| t.path == path && t.branch == s.branch && !t.locked)
            .count()
            != 1
    {
        return Err(error("changed"));
    }
    let index = git::read(Path::new(path), &["ls-files", "--stage", "-z"])?;
    if index.split(|b| *b == 0).any(|r| r.starts_with(b"160000 ")) {
        return Err(error("submodules"));
    }
    if let Some(code) = s.blockers.first() {
        return Err(error(match code.as_str() {
            "locked" => "locked",
            "partialClone" => "partialClone",
            "sparseCheckout" => "sparseCheckout",
            _ => "changed",
        }));
    }
    Ok(s)
}
// The existing complete-material consumers explicitly request all security on
// Windows. This facet remains partial; current public Windows gates refuse
// before this path and all Some profiles remain ineligible for Manifest1.
fn archive_material(
    material: &super::material_owner::Owner,
    root: &Path,
    expected: &inspect::Stamp,
    cancel: &AtomicBool,
) -> Result<MaterialSummary> {
    #[cfg(windows)]
    {
        material.capture_security_complete(root, expected, cancel)
    }
    #[cfg(not(windows))]
    {
        let _ = expected;
        material.capture(root, cancel)
    }
}
pub(super) fn verify_at(
    material: &super::material_owner::Owner,
    saved: &SavedArchive,
    retained: bool,
    cancel: &AtomicBool,
) -> Result<inspect::Snapshot> {
    material.available()?;
    inspect::same(&saved.parent, &saved.parent_stamp)?;
    let (path, other) = if retained {
        (&saved.archive.retained_path, &saved.archive.original_path)
    } else {
        (&saved.archive.original_path, &saved.archive.retained_path)
    };
    absent(other)?;
    if retained || saved.retained_parent_stamp.is_some() {
        inspect::same(
            &saved.retained_parent,
            saved
                .retained_parent_stamp
                .as_ref()
                .ok_or(error("archiveParentChanged"))?,
        )?;
    } else {
        absent(&saved.retained_parent)?;
    }
    let s = snapshot(saved, path)?;
    if archive_material(material, Path::new(path), &s.root_stamp, cancel)? != saved.material
        || index_digest(&saved.original.identity)? != saved.index_sha256
    {
        return Err(error("materialChanged"));
    }
    Ok(s)
}
pub(super) fn prepare_record(
    material: &super::material_owner::Owner,
    location: SavedLocation,
    token: &str,
    cancel: &AtomicBool,
) -> Result<SavedArchive> {
    if location.location.ownership != "created" {
        return Err(error("notOwned"));
    }
    location.identity.check()?;
    let s = inspect::snapshot(Path::new(&location.location.path))?;
    if !location.identity.matches(&s)
        || s.head.as_deref() != Some(&location.location.head_oid)
        || s.branch != location.location.branch
    {
        return Err(error("changed"));
    }
    if s.root == s.repository_root() {
        return Err(error("notLinked"));
    }
    let parent = Path::new(&s.root)
        .parent()
        .and_then(Path::to_str)
        .ok_or(error("unsafePath"))?
        .to_owned();
    let retained_parent = format!("{parent}/.farfold-retained-{token}");
    let retained_path = format!("{retained_parent}/worktree");
    absent(&retained_parent)?;
    let record = SavedArchive {
        removal_operation: None,
        archive: Archive {
            id: location.location.id.clone(),
            revision: location.location.revision,
            original_path: s.root.clone(),
            retained_path,
            repository_root: s.repository_root().into(),
            branch: s.branch.clone(),
            head_oid: s.head.clone().ok_or(error("unborn"))?,
            ownership: "created".into(),
            availability: "unknown".into(),
        },
        parent_stamp: inspect::stamp(Path::new(&parent))?,
        parent,
        retained_parent,
        retained_parent_stamp: None,
        material: archive_material(material, Path::new(&s.root), &s.root_stamp, cancel)?,
        index_sha256: index_digest(&location.identity)?,
        original: location,
    };
    verify_at(material, &record, false, cancel)?;
    Ok(record)
}
pub(super) fn reserve_parent(record: &mut SavedArchive) -> Result<()> {
    inspect::same(&record.parent, &record.parent_stamp)?;
    if record.retained_parent_stamp.is_some() {
        return Ok(());
    }
    absent(&record.retained_parent)?;
    let builder = fs::DirBuilder::new();
    #[cfg(unix)]
    let builder = {
        let mut builder = builder;
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
        builder
    };
    builder
        .create(&record.retained_parent)
        .map_err(|_| error("targetExists"))?;
    record.retained_parent_stamp = Some(inspect::stamp(Path::new(&record.retained_parent))?);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if fs::metadata(&record.retained_parent)
            .map_err(|_| error("changed"))?
            .dev()
            != fs::metadata(&record.archive.original_path)
                .map_err(|_| error("changed"))?
                .dev()
        {
            return Err(error("unsafePath"));
        }
    }
    Ok(())
}
pub(super) fn move_tree(
    material: &super::material_owner::Owner,
    intent: &RecycleIntent,
    cancel: &AtomicBool,
) -> Result<inspect::Snapshot> {
    let restore = intent.action == RecycleAction::Restore;
    verify_at(material, &intent.saved, restore, cancel)?;
    let a = &intent.saved.archive;
    let (from, to) = if restore {
        (&a.retained_path, &a.original_path)
    } else {
        (&a.original_path, &a.retained_path)
    };
    let out = git::execute(
        Path::new(from),
        &["worktree", "move", "--", from, to],
        cancel,
        Duration::from_secs(30),
    )?;
    if out.code != Some(0) {
        return Err(error("unknown"));
    }
    // No retry or rollback: even a failed receipt retains both exact paths.
    verify_at(material, &intent.saved, !restore, &AtomicBool::new(false))
}
