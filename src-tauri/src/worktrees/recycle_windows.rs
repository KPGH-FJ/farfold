//! Archive/restore one same-volume owned root; no broad Git repair command.
use super::*;
use crate::file_access::{PinnedPath, WorktreeMove, WorktreePointer};
use std::io::{Seek, SeekFrom};
use std::sync::atomic::Ordering;

struct PointerBaseline {
    stamp: crate::file_access::Stamp,
    bytes: Vec<u8>,
}
impl PointerBaseline {
    fn capture(pin: &PinnedPath) -> Result<Self> {
        pin.verify().map_err(|_| error("changed"))?;
        let stamp = crate::file_access::stamp(pin.file()).map_err(|_| error("changed"))?;
        if !stamp.regular || stamp.links != 1 || stamp.size == 0 || stamp.size > 4096 {
            return Err(error("unsafePath"));
        }
        let mut file = pin.file().try_clone().map_err(|_| error("changed"))?;
        file.seek(SeekFrom::Start(0))
            .map_err(|_| error("changed"))?;
        let mut bytes = Vec::new();
        file.take(4097)
            .read_to_end(&mut bytes)
            .map_err(|_| error("changed"))?;
        if bytes.len() as u64 != stamp.size
            || crate::file_access::stamp(pin.file()).map_err(|_| error("changed"))? != stamp
        {
            return Err(error("changed"));
        }
        pin.verify().map_err(|_| error("changed"))?;
        Ok(Self { stamp, bytes })
    }
}
struct IndexPin {
    parent: PinnedPath,
    index: Option<PinnedPath>,
    digest: Option<String>,
}
impl IndexPin {
    fn open(saved: &SavedArchive) -> Result<Self> {
        let parent = PinnedPath::directory(Path::new(&saved.original.identity.git_dir))
            .map_err(|_| error("changed"))?;
        if inspect::pinned_stamp(&parent)? != saved.original.identity.git_stamp {
            return Err(error("changed"));
        }
        let path = parent.guid_path.join("index");
        let index = match fs::symlink_metadata(&path) {
            Ok(_) => Some(
                parent
                    .child(&"index".encode_utf16().collect::<Vec<_>>(), false)
                    .map_err(|_| error("changed"))?,
            ),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err(error("changed")),
        };
        let digest = index_digest(&saved.original.identity)?;
        if digest != saved.index_sha256 {
            return Err(error("materialChanged"));
        }
        Ok(Self {
            parent,
            index,
            digest,
        })
    }
    fn verify(&self, saved: &SavedArchive) -> Result<()> {
        self.parent.verify().map_err(|_| error("changed"))?;
        if let Some(pin) = &self.index {
            pin.verify().map_err(|_| error("changed"))?;
        } else {
            absent(
                self.parent
                    .guid_path
                    .join("index")
                    .to_str()
                    .ok_or(error("unsafePath"))?,
            )?;
        }
        if index_digest(&saved.original.identity)? != self.digest {
            return Err(error("materialChanged"));
        }
        Ok(())
    }
}
fn active(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::SeqCst) {
        Err(error("cancelled"))
    } else {
        Ok(())
    }
}
fn pointer_text(prefix: &str, path: &Path) -> Result<Vec<u8>> {
    let text = path.to_str().ok_or(error("unsafePath"))?;
    if !path.is_absolute() || text.contains(['\0', '\r', '\n']) || text.len() + prefix.len() > 4095
    {
        return Err(error("unsafePath"));
    }
    Ok(format!("{prefix}{text}\n").into_bytes())
}
pub(super) fn move_tree(
    material: &super::super::material_owner::Owner,
    intent: &RecycleIntent,
    cancel: &AtomicBool,
) -> Result<inspect::Snapshot> {
    active(cancel)?;
    let saved = &intent.saved;
    let observation = ArchiveObservation::from_profile(saved.material.profile.as_ref())?;
    let restore = intent.action == RecycleAction::Restore;
    let observed = verify_at(material, saved, restore, cancel)?;
    let (from, to, from_parent, to_parent) = if restore {
        (
            &saved.archive.retained_path,
            &saved.archive.original_path,
            saved
                .retained_parent_stamp
                .as_ref()
                .ok_or(error("changed"))?,
            &saved.parent_stamp,
        )
    } else {
        (
            &saved.archive.original_path,
            &saved.archive.retained_path,
            &saved.parent_stamp,
            saved
                .retained_parent_stamp
                .as_ref()
                .ok_or(error("changed"))?,
        )
    };
    let context = super::super::windows_git::ReadContext::open(Path::new(from))?;
    context.scope.matches(&observed)?;
    let root_pointer = context
        .scope
        .root
        .child(&".git".encode_utf16().collect::<Vec<_>>(), false)
        .map_err(|_| error("changed"))?;
    let back_pointer = context
        .scope
        .git
        .child(&"gitdir".encode_utf16().collect::<Vec<_>>(), false)
        .map_err(|_| error("changed"))?;
    let forward = PointerBaseline::capture(&root_pointer)?;
    let backward = PointerBaseline::capture(&back_pointer)?;
    let index = IndexPin::open(saved)?;
    // Keep config, commondir and the exact admitted executable held, releasing
    // only ordinary source-root and these two pointer FileObjects. All native
    // identities/versions/bytes are checked again by the exclusive owners.
    drop((root_pointer, back_pointer));
    let context = context.into_move_context(&forward.stamp.identity, &backward.stamp.identity)?;
    let git_paths = super::super::windows_git::paths::Paths::new(&[&context.metadata.git])?;
    let target_forward = pointer_text("gitdir: ", git_paths.path(&context.metadata.git)?)?;
    active(cancel)?;
    let open = match observation {
        ArchiveObservation::Ordinary => WorktreeMove::open,
        ArchiveObservation::FullSecurity => WorktreeMove::open_full_security,
    };
    let mut owner = open(
        Path::new(from),
        Path::new(to),
        observed
            .root_stamp
            .windows_identity()
            .ok_or(error("changed"))?,
        from_parent.windows_identity().ok_or(error("changed"))?,
        to_parent.windows_identity().ok_or(error("changed"))?,
    )
    .map_err(|_| error("changed"))?;
    let mut forward_owner = WorktreePointer::open(
        owner.root().map_err(|_| error("changed"))?,
        ".git",
        &forward.stamp,
        &forward.bytes,
    )
    .map_err(|_| error("changed"))?;
    let mut backward_owner = WorktreePointer::open(
        &context.metadata.git,
        "gitdir",
        &backward.stamp,
        &backward.bytes,
    )
    .map_err(|_| error("changed"))?;
    let root = owner.take_root().map_err(|_| error("changed"))?;
    let (root, before) = match observation {
        ArchiveObservation::Ordinary => material.capture_archive_pin(root, cancel),
        ArchiveObservation::FullSecurity => material.capture_security_complete_pin(root, cancel),
    }?;
    owner.return_root(root).map_err(|_| error("changed"))?;
    if before != saved.material {
        return Err(error("materialChanged"));
    }
    context.verify()?;
    index.verify(saved)?;
    active(cancel)?;
    forward_owner.verify().map_err(|_| error("changed"))?;
    backward_owner.verify().map_err(|_| error("changed"))?;
    // NtSetInformationFile's directory rename checks open descendants. Keep
    // only the immutable stamp/bytes while moving the same root, then acquire
    // this exact pointer again; no changed object or contents may be adopted.
    // https://learn.microsoft.com/openspecs/windows_protocols/ms-fsa/133840e4-778e-44ca-9b41-da2323615075
    drop(forward_owner);
    owner.rename().map_err(|_| error("unknown"))?;
    let mut forward_owner = WorktreePointer::open(
        owner.root().map_err(|_| error("unknown"))?,
        ".git",
        &forward.stamp,
        &forward.bytes,
    )
    .map_err(|_| error("unknown"))?;
    let moved_path = owner.git_path().map_err(|_| error("unknown"))?;
    let target_backward = pointer_text("", &moved_path.join(".git"))?;
    // A rename and two pointer writes cannot be atomic. Any cancellation or
    // error from here retains UNKNOWN and the two recorded paths, never retries
    // or claims rollback. The forward pointer was reacquired and rechecked
    // after the move; the backward owner stayed held outside the moved tree.
    active(cancel).map_err(|_| error("unknown"))?;
    crate::file_access::replace_worktree_pointers(
        &mut forward_owner,
        &mut backward_owner,
        &target_forward,
        &target_backward,
        cancel,
    )
    .map_err(|_| error("unknown"))?;
    let root = owner.take_root().map_err(|_| error("unknown"))?;
    let (root, after) = match observation {
        ArchiveObservation::Ordinary => material.capture_archive_pin(root, &AtomicBool::new(false)),
        ArchiveObservation::FullSecurity => {
            material.capture_security_complete_pin(root, &AtomicBool::new(false))
        }
    }?;
    owner.return_root(root).map_err(|_| error("unknown"))?;
    if after != saved.material {
        return Err(error("materialChanged"));
    }
    owner.verify().map_err(|_| error("unknown"))?;
    if owner.git_path().map_err(|_| error("unknown"))? != moved_path {
        return Err(error("unknown"));
    }
    git_paths.verify()?;
    index.verify(saved)?;
    context.verify()?;
    active(cancel).map_err(|_| error("unknown"))?;
    // The exclusive DELETE/root and WRITE/pointer handles must retire before
    // ordinary no-DELETE pins can open. This is an explicit observed handoff,
    // not a claim of an atomic or continuously frozen filesystem snapshot.
    drop((forward_owner, backward_owner, owner));
    let reader = super::super::read_context::Reader::from_windows(context.finish(Path::new(to))?);
    let actual = inspect::observe_with_reader(Path::new(to), &reader)?;
    let staged = reader.read(Path::new(to), &["ls-files", "--stage", "-z"])?;
    validate_snapshot(saved, to, actual.clone(), &staged)?;
    absent(from)?;
    if archive_material(
        material,
        Path::new(to),
        &actual.root_stamp,
        saved.material.profile.as_ref(),
        &AtomicBool::new(false),
    )? != saved.material
    {
        return Err(error("materialChanged"));
    }
    reader.matches(&actual)?;
    index.verify(saved)?;
    active(cancel).map_err(|_| error("unknown"))?;
    Ok(actual)
}
