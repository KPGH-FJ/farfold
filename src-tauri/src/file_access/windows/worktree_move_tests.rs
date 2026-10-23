use super::*;
use std::fs;

pub(super) struct Observation(std::cell::Cell<&'static str>);
impl Observation {
    pub(super) fn new() -> Self {
        Self(std::cell::Cell::new("entered"))
    }
    pub(super) fn at(&self, phase: &'static str) {
        self.0.set(phase);
    }
}
impl Drop for Observation {
    fn drop(&mut self) {
        eprintln!("FARFOLD_WINDOWS_MOVE_BOUNDARY lastReached={}", self.0.get());
    }
}

#[test]
fn ordinary_move_into_created_parent_requires_writer_retirement_and_keeps_original_pin() {
    let temp = crate::test_support::tempdir().unwrap();
    let parent = PinnedPath::directory(temp.path()).unwrap();
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join(".git"), b"gitdir: original\n").unwrap();
    let root = PinnedPath::directory(&source).unwrap();
    let id = root.identity().clone();
    drop(root);
    // Exactly the public Archive reservation: the original FILE_CREATE
    // writer and its same-object read pin remain alive across the move.
    let retained = WorktreeCheckout::create_under(&parent, "retained").unwrap();
    let target = PathBuf::from(&retained.root().path).join("worktree");
    let mut owner = WorktreeMove::open(
        &source,
        &target,
        id.clone(),
        parent.identity().clone(),
        retained.root().identity().clone(),
    )
    .unwrap();
    // The kernel opens the destination parent for FILE_ADD_SUBDIRECTORY even
    // with a RootDirectory handle. The original writer excludes that access.
    let error = owner.rename().unwrap_err();
    assert_eq!(error.raw_os_error(), Some(32), "{error:?}");
    assert!(!owner.moved);
    assert_eq!(owner.root().unwrap().identity(), &id);
    assert!(source.is_dir());
    assert!(!target.exists());
    let retained_id = retained.root().identity().clone();
    let retained = retained
        .into_reserved_directory(&std::sync::atomic::AtomicBool::new(false))
        .unwrap();
    assert_eq!(retained.identity(), &retained_id);
    assert!(fs::rename(&retained.path, temp.path().join("replacement")).is_err());
    // This explicit retry is a mechanism control after a verified no-move
    // failure. Production performs the handoff first and dispatches only once.
    owner.rename().unwrap();
    let plain = owner.git_path().unwrap();
    assert!(!plain.to_string_lossy().starts_with(r"\\?\"));
    assert_eq!(plain.file_name().unwrap(), "worktree");
    assert_eq!(fs::read(plain.join(".git")).unwrap(), b"gitdir: original\n");
    assert_eq!(owner.root().unwrap().identity(), &id);
    assert!(!source.exists());
    retained.verify().unwrap();
    owner.verify().unwrap();
}

#[test]
fn reserved_parent_handoff_keeps_late_destination_collision_and_source_untouched() {
    let temp = crate::test_support::tempdir().unwrap();
    let parent = PinnedPath::directory(temp.path()).unwrap();
    let source = temp.path().join("source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("original"), b"original bytes").unwrap();
    let id = PinnedPath::directory(&source).unwrap().identity().clone();
    let retained = WorktreeCheckout::create_under(&parent, "retained")
        .unwrap()
        .into_reserved_directory(&std::sync::atomic::AtomicBool::new(false))
        .unwrap();
    let target = PathBuf::from(&retained.path).join("worktree");
    let mut owner = WorktreeMove::open(
        &source,
        &target,
        id.clone(),
        parent.identity().clone(),
        retained.identity().clone(),
    )
    .unwrap();
    fs::create_dir(&target).unwrap();
    fs::write(target.join("foreign"), b"foreign bytes").unwrap();
    assert!(owner.rename().is_err());
    assert!(!owner.moved);
    assert_eq!(owner.root().unwrap().identity(), &id);
    assert_eq!(
        fs::read(source.join("original")).unwrap(),
        b"original bytes"
    );
    assert_eq!(fs::read(target.join("foreign")).unwrap(), b"foreign bytes");
    retained.verify().unwrap();
    owner.verify().unwrap();
}

#[test]
fn ordinary_move_releases_child_pointer_and_reacquires_the_exact_original() {
    let temp = crate::test_support::tempdir().unwrap();
    let parent = PinnedPath::directory(temp.path()).unwrap();
    let source = temp.path().join("source");
    let target = temp.path().join("target");
    fs::create_dir(&source).unwrap();
    fs::write(source.join(".git"), b"gitdir: original\n").unwrap();
    let root = PinnedPath::directory(&source).unwrap();
    let id = root.identity().clone();
    let child = root
        .child(&".git".encode_utf16().collect::<Vec<_>>(), false)
        .unwrap();
    let version = stamp(child.file()).unwrap();
    let bytes = fs::read(source.join(".git")).unwrap();
    drop((child, root));
    let mut owner = WorktreeMove::open(
        &source,
        &target,
        id.clone(),
        parent.identity().clone(),
        parent.identity().clone(),
    )
    .unwrap();
    assert!(!owner.root().unwrap().full_security_purpose());
    let mut pointer =
        WorktreePointer::open(owner.root().unwrap(), ".git", &version, &bytes).unwrap();
    // Real NTFS directory rename while a descendant is open. This must not
    // force or unlink the original directory to work around an active writer.
    assert!(owner.rename().is_err());
    assert!(!owner.moved);
    assert!(source.is_dir());
    assert!(!target.exists());
    pointer.verify().unwrap();
    drop(pointer);
    owner.rename().unwrap();
    assert_eq!(owner.root().unwrap().identity(), &id);
    let mut reacquired =
        WorktreePointer::open(owner.root().unwrap(), ".git", &version, &bytes).unwrap();
    reacquired.verify().unwrap();
    reacquired.replace(b"gitdir: updated\n").unwrap();
    assert_eq!(fs::read(target.join(".git")).unwrap(), b"gitdir: updated\n");
    assert!(!source.exists());
}

#[test]
fn changed_pointer_after_move_is_not_adopted_or_overwritten() {
    let temp = crate::test_support::tempdir().unwrap();
    let parent = PinnedPath::directory(temp.path()).unwrap();
    let source = temp.path().join("source");
    let target = temp.path().join("target");
    fs::create_dir(&source).unwrap();
    fs::write(source.join(".git"), b"gitdir: original\n").unwrap();
    let root = PinnedPath::directory(&source).unwrap();
    let id = root.identity().clone();
    let child = root
        .child(&".git".encode_utf16().collect::<Vec<_>>(), false)
        .unwrap();
    let version = stamp(child.file()).unwrap();
    let bytes = fs::read(source.join(".git")).unwrap();
    drop((child, root));
    let mut owner = WorktreeMove::open(
        &source,
        &target,
        id.clone(),
        parent.identity().clone(),
        parent.identity().clone(),
    )
    .unwrap();
    owner.rename().unwrap();
    fs::write(target.join(".git"), b"gitdir: external\n").unwrap();
    assert!(WorktreePointer::open(owner.root().unwrap(), ".git", &version, &bytes).is_err());
    assert_eq!(
        fs::read(target.join(".git")).unwrap(),
        b"gitdir: external\n"
    );
    assert_eq!(owner.root().unwrap().identity(), &id);
    assert!(!source.exists());
}

#[test]
#[ignore = "manual: actual NTFS and pre-existing FullSecurity root access; no privilege adjustment"]
fn actual_move_refuses_collision_and_preserves_identity_after_post_rename_failure() {
    let temp = crate::test_support::tempdir().unwrap();
    let parent = PinnedPath::directory(temp.path()).unwrap();
    let from = parent.guid_path.join("source");
    let to = parent.guid_path.join("target");
    fs::create_dir(&from).unwrap();
    fs::write(from.join("retained.bin"), [1, 0, 255]).unwrap();
    fs::create_dir(&to).unwrap();
    let id = PinnedPath::git_directory(&from).unwrap().identity().clone();
    // WorktreeMove accepts DOS paths, not a GUID pathname authority substitute.
    let from_dos = PathBuf::from(PinnedPath::git_directory(&from).unwrap().path);
    let to_dos = PathBuf::from(parent.path.clone()).join("target");
    assert!(
        WorktreeMove::open_full_security(
            &from_dos,
            &to_dos,
            id.clone(),
            parent.identity().clone(),
            parent.identity().clone()
        )
        .is_err()
    );
    fs::remove_dir(&to).unwrap();
    let mut owner = WorktreeMove::open_full_security(
        &from_dos,
        &to_dos,
        id.clone(),
        parent.identity().clone(),
        parent.identity().clone(),
    )
    .unwrap();
    owner.rename().unwrap();
    assert!(owner.moved);
    assert_eq!(owner.root().unwrap().identity(), &id);
    assert!(!from.exists());
    assert_eq!(fs::read(to.join("retained.bin")).unwrap(), [1, 0, 255]);
    // A following operation fails; no second rename/rollback is attempted.
    assert!(owner.rename().is_err());
    assert!(!from.exists());
    owner.verify().unwrap();
    assert_eq!(owner.root().unwrap().identity(), &id);
}
