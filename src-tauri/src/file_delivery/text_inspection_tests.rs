use super::*;
use crate::file_delivery::{MAX_TEXT_BYTES, inspect, read_text};
use std::cell::Cell;
use std::fs;

fn fixture(bytes: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("selected.txt");
    fs::write(&path, bytes).unwrap();
    (root, path)
}

#[test]
fn text_inspection_rejects_oversize_before_capture_for_both_entrypoints() {
    let (root, path) = fixture(b"small");
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(MAX_TEXT_BYTES + 1)
        .unwrap();
    let calls = Cell::new(0);
    let result = open_text(root.path(), &path, None).and_then(|opened| {
        calls.set(calls.get() + 1);
        super::super::capture_opened(opened, MAX_TEXT_BYTES)
            .map(|(file, _)| file)
            .map_err(Into::into)
    });
    assert_eq!(result, Err(RevisionFailure { code: "tooLarge" }));
    assert_eq!(
        calls.get(),
        0,
        "oversize must not enter the body reader/hash"
    );
    assert_eq!(
        inspect_text(&path),
        Err(RevisionFailure { code: "tooLarge" })
    );
    // Legacy ordinary-file inspection intentionally retains its larger bound.
    let legacy = inspect(root.path(), &path).unwrap();
    assert_eq!(
        check_text_revision(&legacy),
        Err(RevisionFailure { code: "tooLarge" })
    );
}

#[test]
fn text_inspection_growth_after_open_is_rejected_before_hashing() {
    let (root, path) = fixture(b"small");
    let opened = open_text(root.path(), &path, None).unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(MAX_TEXT_BYTES + 1)
        .unwrap();
    let result = super::super::capture_opened(opened, MAX_TEXT_BYTES);
    assert!(matches!(result, Err(DeliveryError::TooLarge)));
}

#[test]
fn text_inspection_exact_limit_keeps_all_bytes_and_full_revision() {
    let mut bytes = vec![b'x'; MAX_TEXT_BYTES as usize];
    bytes[..8].copy_from_slice(b"\xef\xbb\xbfA\r\n\xc3\xa9");
    let (_root, path) = fixture(&bytes);
    let file = inspect_text(&path).unwrap();
    let preview = read_text(&file).unwrap();
    assert_eq!(preview.file, file);
    assert_eq!(preview.text.as_bytes(), bytes);
    assert_eq!(file.sha256, super::super::content_hash(&bytes));
    assert_eq!(
        check_text_revision(&file),
        Ok(RevisionCheck::Verified { file })
    );
}

#[test]
fn text_inspection_changed_bytes_and_replaced_identity_are_not_old_receipts() {
    let (_root, path) = fixture(b"first");
    let first = inspect_text(&path).unwrap();
    fs::write(&path, b"other").unwrap();
    assert!(matches!(read_text(&first), Err(DeliveryError::Changed)));
    let RevisionCheck::Verified { file: next } = check_text_revision(&first).unwrap() else {
        panic!("full content required");
    };
    assert_ne!(first.sha256, next.sha256);
    assert_ne!(first.version, next.version);
    let replacement = path.with_extension("replacement");
    fs::write(&replacement, b"other").unwrap();
    fs::rename(replacement, &path).unwrap();
    assert!(matches!(read_text(&next), Err(DeliveryError::Changed)));
    let RevisionCheck::Verified { file: replaced } = check_text_revision(&next).unwrap() else {
        panic!("full content required");
    };
    assert_eq!(next.sha256, replaced.sha256);
    assert_ne!(next.version, replaced.version);
}

#[cfg(unix)]
#[test]
fn text_inspection_redirected_symlink_rejects_before_body_capture() {
    let (root, path) = fixture(b"original");
    let alias = root.path().join("alias.txt");
    std::os::unix::fs::symlink(&path, &alias).unwrap();
    let file = inspect_text(&alias).unwrap();
    let other = root.path().join("other.txt");
    fs::write(&other, b"original").unwrap();
    fs::remove_file(&alias).unwrap();
    std::os::unix::fs::symlink(&other, &alias).unwrap();
    assert!(matches!(
        open_text(Path::new(&file.root), &alias, Some(&file)),
        Err(RevisionFailure { code: "redirected" })
    ));
    assert_eq!(
        check_text_revision(&file),
        Err(RevisionFailure { code: "redirected" })
    );
}

#[test]
fn text_inspection_retains_legacy_utf8_nul_and_precise_file_failures() {
    let (_root, path) = fixture(b"\xff");
    assert!(matches!(
        read_text(&inspect_text(&path).unwrap()),
        Err(DeliveryError::UnsupportedText)
    ));
    fs::write(&path, b"a\0b").unwrap();
    assert_eq!(
        read_text(&inspect_text(&path).unwrap())
            .unwrap()
            .text
            .as_bytes(),
        b"a\0b",
        "P32 rejects NUL without changing legacy readText behavior"
    );
    fs::remove_file(&path).unwrap();
    assert_eq!(
        inspect_text(&path),
        Err(RevisionFailure { code: "missing" })
    );
    fs::create_dir(&path).unwrap();
    assert_eq!(
        inspect_text(&path),
        Err(RevisionFailure { code: "notFile" })
    );
}
