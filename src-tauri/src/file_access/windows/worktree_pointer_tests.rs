use super::*;
use std::{fs, sync::atomic::AtomicBool};

fn original(parent: &PinnedPath, leaf: &str) -> (Stamp, Vec<u8>) {
    let pin = parent
        .child(&leaf.encode_utf16().collect::<Vec<_>>(), false)
        .unwrap();
    let version = stamp(pin.file()).unwrap();
    let bytes = fs::read(parent.guid_path.join(leaf)).unwrap();
    (version, bytes)
}
#[test]
fn actual_pointer_owner_excludes_writers_and_checks_original_identity_and_bytes() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join(".git"), b"gitdir: original\n").unwrap();
    let parent = PinnedPath::directory(temp.path()).unwrap();
    let (version, bytes) = original(&parent, ".git");
    let mut wrong = version.clone();
    wrong.identity.inode ^= 1;
    assert!(WorktreePointer::open(&parent, ".git", &wrong, &bytes).is_err());
    assert!(WorktreePointer::open(&parent, ".git", &version, b"different\n").is_err());
    let mut owner = WorktreePointer::open(&parent, ".git", &version, &bytes).unwrap();
    assert!(fs::write(temp.path().join(".git"), b"foreign").is_err());
    assert!(fs::remove_file(temp.path().join(".git")).is_err());
    owner.replace(b"gitdir: documented-target\n").unwrap();
    owner.verify().unwrap();
    assert_eq!(stamp(&owner.file).unwrap().identity, version.identity);
    assert_eq!(
        fs::read(temp.path().join(".git")).unwrap(),
        b"gitdir: documented-target\n"
    );
    drop(owner);
    fs::write(temp.path().join(".git"), b"released").unwrap();
}
#[test]
fn second_pointer_rejection_preserves_first_write_and_cancelled_pair_writes_neither() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join(".git"), b"gitdir: original\n").unwrap();
    fs::write(temp.path().join("gitdir"), b"original/.git\n").unwrap();
    let parent = PinnedPath::directory(temp.path()).unwrap();
    let (a, av) = original(&parent, ".git");
    let (b, bv) = original(&parent, "gitdir");
    let mut forward = WorktreePointer::open(&parent, ".git", &a, &av).unwrap();
    let mut backward = WorktreePointer::open(&parent, "gitdir", &b, &bv).unwrap();
    assert!(
        replace_pair(
            &mut forward,
            &mut backward,
            b"gitdir: target\n",
            b"target/.git\n",
            &AtomicBool::new(true)
        )
        .is_err()
    );
    assert_eq!(fs::read(temp.path().join(".git")).unwrap(), av);
    assert_eq!(fs::read(temp.path().join("gitdir")).unwrap(), bv);
    // A real second owner's input rejection (not a simulated OS write fault).
    assert!(
        replace_pair(
            &mut forward,
            &mut backward,
            b"gitdir: target\n",
            b"invalid\0pointer",
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert_eq!(
        fs::read(temp.path().join(".git")).unwrap(),
        b"gitdir: target\n"
    );
    assert_eq!(fs::read(temp.path().join("gitdir")).unwrap(), bv);
    forward.verify().unwrap();
    backward.verify().unwrap();
    replace_pair(
        &mut forward,
        &mut backward,
        b"gitdir: target\n",
        b"target/.git\n",
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        fs::read(temp.path().join("gitdir")).unwrap(),
        b"target/.git\n"
    );
}
