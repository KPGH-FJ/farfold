use super::*;
use std::fs;

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
