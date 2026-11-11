//! Metadata changes by desktop file pickers must not create a content revision.
use super::*;
use std::{ffi::CString, fs, os::unix::ffi::OsStrExt};

fn add_owned_metadata(path: &Path) {
    let path = CString::new(path.as_os_str().as_bytes()).unwrap();
    let name = CString::new("com.farfold.file-delivery-test").unwrap();
    let value = b"owned fixture";
    // SAFETY: all pointers remain valid for this call, and the byte length is exact.
    assert_eq!(
        unsafe {
            libc::setxattr(
                path.as_ptr(),
                name.as_ptr(),
                value.as_ptr().cast(),
                value.len(),
                0,
                0,
            )
        },
        0,
        "{}",
        std::io::Error::last_os_error()
    );
}

fn metadata_changed() -> (tempfile::TempDir, PathBuf, VerifiedFile) {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source.txt");
    fs::write(&source, b"original text\n").unwrap();
    let file = inspect(root.path(), &source).unwrap();
    let before = file_access::stamp(&File::open(&source).unwrap()).unwrap();
    add_owned_metadata(&source);
    let after = file_access::stamp(&File::open(&source).unwrap()).unwrap();
    assert_eq!(before.identity, after.identity);
    assert_eq!(before.modified, after.modified);
    assert_eq!(before.size, after.size);
    assert_ne!(before.changed, after.changed);
    assert_eq!(content_hash(&fs::read(&source).unwrap()), file.sha256);
    (root, source, file)
}

#[test]
fn metadata_only_change_keeps_content_version_and_can_copy() {
    let (root, source, file) = metadata_changed();
    let refreshed = inspect(root.path(), &source).unwrap();
    assert_eq!(refreshed, file);
    let destination = root.path().join("copy.txt");
    let receipt = copy(&file, &destination).unwrap();
    assert_eq!(receipt.sha256, file.sha256);
    assert_eq!(fs::read(&destination).unwrap(), b"original text\n");
}

#[test]
fn metadata_only_change_does_not_mask_existing_destination() {
    let (root, source, file) = metadata_changed();
    let destination = root.path().join("existing.txt");
    fs::write(&destination, b"keep existing").unwrap();
    assert!(matches!(
        copy(&file, &destination),
        Err(DeliveryError::AlreadyExists)
    ));
    assert_eq!(fs::read(&source).unwrap(), b"original text\n");
    assert_eq!(fs::read(&destination).unwrap(), b"keep existing");
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
}

#[test]
fn metadata_mutation_during_read_is_still_rejected() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source.txt");
    fs::write(&source, b"original text\n").unwrap();
    let file = inspect(root.path(), &source).unwrap();
    let result = stream::expected(&file, |_, _| {
        add_owned_metadata(&source);
        Ok(())
    });
    assert_eq!(result, Err(DeliveryError::Changed));
}
