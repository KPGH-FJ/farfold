use super::*;
use std::{
    fs,
    io::{Seek, SeekFrom},
};

fn source(bytes: &[u8]) -> File {
    let mut file = tempfile::tempfile().unwrap();
    file.write_all(bytes).unwrap();
    file.seek(SeekFrom::Start(0)).unwrap();
    file
}
#[test]
fn owned_range_copy_preserves_bytes_and_refuses_case_alias_overwrite() {
    let temporary = tempfile::tempdir().unwrap();
    let root = PinnedPath::directory(temporary.path()).unwrap();
    let mut owner = WorktreeCheckout::new(&root).unwrap();
    let input = source(b"header\0payload\xfffooter");
    owner
        .copy_range("nested/Original.bin", &input, 7, 8, &AtomicBool::new(false))
        .unwrap();
    assert_eq!(
        fs::read(temporary.path().join("nested/Original.bin")).unwrap(),
        b"payload\xff"
    );
    assert!(
        owner
            .copy_range("nested/original.bin", &input, 0, 1, &AtomicBool::new(false))
            .is_err()
    );
    assert!(
        fs::OpenOptions::new()
            .write(true)
            .open(temporary.path().join("nested/Original.bin"))
            .is_err()
    );
    owner.verify().unwrap();
    assert_eq!(
        fs::read(temporary.path().join("nested/Original.bin")).unwrap(),
        b"payload\xff"
    );
}
#[test]
fn attribute_guards_cover_each_lookup_level_and_deny_mutation() {
    let temporary = tempfile::tempdir().unwrap();
    let root = PinnedPath::directory(temporary.path()).unwrap();
    let mut owner = WorktreeCheckout::new(&root).unwrap();
    owner
        .guard_attributes(
            &["nested/deeper/owned.txt".into(), "other.txt".into()],
            &AtomicBool::new(false),
        )
        .unwrap();
    for name in [
        ".gitattributes",
        "nested/.gitattributes",
        "nested/deeper/.gitattributes",
    ] {
        assert_eq!(fs::read(temporary.path().join(name)).unwrap(), b"");
        assert!(
            fs::OpenOptions::new()
                .write(true)
                .open(temporary.path().join(name))
                .is_err()
        );
        assert!(fs::remove_file(temporary.path().join(name)).is_err());
    }
    owner.verify().unwrap();
}
#[test]
fn fixed_index_publication_is_exclusive_and_never_replaces_existing_index() {
    let temporary = tempfile::tempdir().unwrap();
    let root = PinnedPath::directory(temporary.path()).unwrap();
    let original = source(b"owned index bytes\0\xff");
    let publication =
        WorktreeCheckout::publish_index(&original, &root, &AtomicBool::new(false)).unwrap();
    assert_eq!(
        fs::read(temporary.path().join("index")).unwrap(),
        b"owned index bytes\0\xff"
    );
    assert!(
        fs::OpenOptions::new()
            .write(true)
            .open(temporary.path().join("index"))
            .is_err()
    );
    assert!(
        WorktreeCheckout::publish_index(&source(b"other"), &root, &AtomicBool::new(false)).is_err()
    );
    assert_eq!(
        fs::read(temporary.path().join("index")).unwrap(),
        b"owned index bytes\0\xff"
    );
    drop(publication);
    assert!(
        fs::OpenOptions::new()
            .write(true)
            .open(temporary.path().join("index"))
            .is_ok()
    );
}
#[test]
fn cancellation_and_outside_range_never_create_destination_files() {
    let temporary = tempfile::tempdir().unwrap();
    let root = PinnedPath::directory(temporary.path()).unwrap();
    let mut owner = WorktreeCheckout::new(&root).unwrap();
    let input = source(b"owned");
    assert!(
        owner
            .copy_regular("cancelled", &input, 5, &AtomicBool::new(true))
            .is_err()
    );
    assert!(
        owner
            .copy_range("overshoot", &input, 4, 2, &AtomicBool::new(false))
            .is_err()
    );
    assert!(
        owner
            .copy_regular("../escape", &input, 5, &AtomicBool::new(false))
            .is_err()
    );
    assert!(fs::read_dir(temporary.path()).unwrap().next().is_none());
}
#[test]
fn created_root_handle_blocks_the_old_path_stamp_replacement_window() {
    let temporary = tempfile::tempdir().unwrap();
    let legacy = temporary.path().join("legacy");
    fs::create_dir(&legacy).unwrap();
    let original = {
        let pin = PinnedPath::directory(&legacy).unwrap();
        pin.identity().clone()
    };
    fs::rename(&legacy, temporary.path().join("old-created")).unwrap();
    fs::create_dir(&legacy).unwrap();
    let replacement = PinnedPath::directory(&legacy).unwrap();
    assert_ne!(*replacement.identity(), original);
    let parent = PinnedPath::directory(temporary.path()).unwrap();
    let reserved = WorktreeCheckout::create_under(&parent, "retained-original").unwrap();
    let identity = reserved.root().identity().clone();
    assert!(
        fs::rename(
            temporary.path().join("retained-original"),
            temporary.path().join("must-not-move")
        )
        .is_err()
    );
    assert!(fs::remove_dir(temporary.path().join("retained-original")).is_err());
    assert_eq!(*reserved.root().identity(), identity);
    reserved.verify_namespace(&AtomicBool::new(false)).unwrap();
}
#[test]
fn unexpected_real_directory_entry_is_rejected_without_adoption_or_selected_mutation() {
    let temporary = tempfile::tempdir().unwrap();
    let parent = PinnedPath::directory(temporary.path()).unwrap();
    let mut reserved = WorktreeCheckout::create_under(&parent, "owned").unwrap();
    reserved
        .copy_regular(
            "selected.txt",
            &source(b"selected"),
            8,
            &AtomicBool::new(false),
        )
        .unwrap();
    reserved.verify_namespace(&AtomicBool::new(false)).unwrap();
    let foreign = temporary.path().join("owned/foreign.txt");
    fs::write(&foreign, b"foreign original").unwrap();
    assert!(reserved.verify_namespace(&AtomicBool::new(false)).is_err());
    assert_eq!(fs::read(&foreign).unwrap(), b"foreign original");
    assert_eq!(
        fs::read(temporary.path().join("owned/selected.txt")).unwrap(),
        b"selected"
    );
    fs::remove_file(foreign).unwrap();
    reserved.verify_namespace(&AtomicBool::new(false)).unwrap();
}
