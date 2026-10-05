use super::*;
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::symlink;

fn fixture() -> (tempfile::TempDir, PathBuf, VerifiedFile) {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("report.md");
    fs::write(&path, "# Report\nhello\n").unwrap();
    let file = inspect(root.path(), &path).unwrap();
    (root, path, file)
}

#[test]
fn verifies_disk_bytes_and_previews_same_version() {
    let (root, path, file) = fixture();
    assert_eq!(
        file.resolved_path,
        path.canonicalize().unwrap().to_str().unwrap()
    );
    assert_eq!(file.size, 15);
    assert_eq!(file.sha256, content_hash(b"# Report\nhello\n"));
    assert_eq!(read_text(&file).unwrap().text, "# Report\nhello\n");
    assert_eq!(revalidate_for_open(&file).unwrap(), file.resolved_path);
    let relative = inspect(root.path(), Path::new("report.md")).unwrap();
    // macOS /var may canonicalize to /private/var; original requested paths
    // intentionally remain distinct while both receipts identify one version.
    assert_eq!(relative.resolved_path, file.resolved_path);
    assert_eq!(relative.version, file.version);
    assert_eq!(read_text(&relative).unwrap().text, "# Report\nhello\n");
}

#[test]
fn refuses_absolute_and_parent_escape() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let secret = outside.path().join("outside.txt");
    fs::write(&secret, "fixture only").unwrap();
    assert_eq!(
        inspect(root.path(), &secret),
        Err(DeliveryError::OutsideRoot)
    );
    let parent_path = Path::new("..")
        .join(outside.path().file_name().unwrap())
        .join("outside.txt");
    assert_eq!(
        inspect(root.path(), &parent_path),
        Err(DeliveryError::OutsideRoot)
    );
}

#[cfg(unix)]
#[test]
fn symlink_must_resolve_inside_authorized_root() {
    let (root, path, _) = fixture();
    let alias = root.path().join("alias.md");
    symlink(&path, &alias).unwrap();
    assert_eq!(
        read_text(&inspect(root.path(), &alias).unwrap())
            .unwrap()
            .text,
        "# Report\nhello\n"
    );
    let outside = tempfile::tempdir().unwrap();
    let outside_file = outside.path().join("outside.md");
    fs::write(&outside_file, "fixture").unwrap();
    let escape = root.path().join("escape.md");
    symlink(outside_file, &escape).unwrap();
    assert_eq!(
        inspect(root.path(), &escape),
        Err(DeliveryError::OutsideRoot)
    );
}

#[cfg(unix)]
#[test]
fn redirected_symlink_invalidates_receipt() {
    let (root, path, _) = fixture();
    let alias = root.path().join("alias.md");
    symlink(&path, &alias).unwrap();
    let file = inspect(root.path(), &alias).unwrap();
    let other = root.path().join("other.md");
    fs::write(&other, "# Report\nhello\n").unwrap();
    fs::remove_file(&alias).unwrap();
    symlink(other, &alias).unwrap();
    assert!(matches!(read_text(&file), Err(DeliveryError::Changed)));
}

#[test]
fn same_length_edit_rejects_old_read_and_copy() {
    let (_root, path, file) = fixture();
    fs::write(&path, "# Report\nworld\n").unwrap();
    assert!(matches!(read_text(&file), Err(DeliveryError::Changed)));
    assert!(matches!(
        revalidate_for_open(&file),
        Err(DeliveryError::Changed)
    ));
    let output = tempfile::tempdir().unwrap();
    assert!(matches!(
        copy(&file, &output.path().join("copy.md")),
        Err(DeliveryError::Changed)
    ));
    assert_eq!(fs::read_to_string(&path).unwrap(), "# Report\nworld\n");
    assert!(!output.path().join("copy.md").exists());
}

#[test]
fn replacing_file_with_identical_bytes_invalidates_receipt() {
    let (_root, path, file) = fixture();
    let replacement = path.with_extension("replacement");
    fs::write(&replacement, "# Report\nhello\n").unwrap();
    fs::rename(replacement, &path).unwrap();
    assert!(matches!(read_text(&file), Err(DeliveryError::Changed)));
}

#[cfg(unix)]
#[test]
fn directory_and_fifo_are_not_files_and_do_not_block() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("directory");
    fs::create_dir(&directory).unwrap();
    assert_eq!(
        inspect(root.path(), &directory),
        Err(DeliveryError::NotFile)
    );
    let fifo = root.path().join("fifo");
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
    // SAFETY: name is a live NUL-terminated fixture path, mode is valid.
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    assert_eq!(inspect(root.path(), &fifo), Err(DeliveryError::NotFile));
}

#[test]
fn binary_is_copyable_without_claiming_text_preview() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("report.pdf");
    let bytes = b"%PDF-fixture\xff\x00";
    fs::write(&source, bytes).unwrap();
    let file = inspect(root.path(), &source).unwrap();
    assert!(matches!(
        read_text(&file),
        Err(DeliveryError::UnsupportedText)
    ));
    let output = root.path().join("copy.pdf");
    let receipt = copy(&file, &output).unwrap();
    assert_eq!(receipt.kind, DeliveryKind::FileCopy);
    assert_eq!(receipt.source_version, Some(file.version));
    assert_eq!(fs::read(output).unwrap(), bytes);
    assert_eq!(fs::read(source).unwrap(), bytes);
}

#[test]
fn existing_destination_is_never_overwritten_and_source_remains() {
    let (root, path, file) = fixture();
    let output = root.path().join("existing.md");
    fs::write(&output, "keep destination").unwrap();
    assert!(matches!(
        copy(&file, &output),
        Err(DeliveryError::AlreadyExists)
    ));
    assert_eq!(fs::read_to_string(output).unwrap(), "keep destination");
    assert_eq!(fs::read_to_string(path).unwrap(), "# Report\nhello\n");
    assert!(!fs::read_dir(root.path()).unwrap().flatten().any(|e| {
        e.file_name()
            .to_string_lossy()
            .starts_with(".farfold-export-")
    }));
}

#[cfg(unix)]
#[test]
fn destination_symlink_is_not_followed_or_replaced() {
    let (root, path, file) = fixture();
    let target = root.path().join("keep.md");
    fs::write(&target, "keep target").unwrap();
    let output = root.path().join("copy.md");
    symlink(&target, &output).unwrap();
    assert!(matches!(
        copy(&file, &output),
        Err(DeliveryError::AlreadyExists)
    ));
    assert!(
        fs::symlink_metadata(&output)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(fs::read_to_string(target).unwrap(), "keep target");
    assert_eq!(fs::read_to_string(path).unwrap(), "# Report\nhello\n");
}

#[test]
fn missing_parent_failure_keeps_source_and_creates_nothing() {
    let (root, path, file) = fixture();
    let output = root.path().join("missing/copy.md");
    assert!(matches!(
        copy(&file, &output),
        Err(DeliveryError::InvalidDestination)
    ));
    assert!(!output.exists());
    assert_eq!(fs::read_to_string(path).unwrap(), "# Report\nhello\n");
}

#[test]
fn file_size_and_text_preview_have_separate_bounds() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("large.txt");
    let file = File::create(&path).unwrap();
    file.set_len(MAX_TEXT_BYTES + 1).unwrap();
    let verified = inspect(root.path(), &path).unwrap();
    assert!(matches!(read_text(&verified), Err(DeliveryError::TooLarge)));
    file.set_len(MAX_FILE_BYTES + 1).unwrap();
    assert_eq!(inspect(root.path(), &path), Err(DeliveryError::TooLarge));
}

#[test]
fn text_snapshot_is_distinct_from_disk_copy_and_never_overwrites() {
    let root = tempfile::tempdir().unwrap();
    let output = root.path().join("reported-fragment.txt");
    let receipt = export_text("selected fragment", &output).unwrap();
    assert_eq!(receipt.kind, DeliveryKind::TextSnapshot);
    assert!(receipt.source_version.is_none());
    assert_eq!(fs::read_to_string(&output).unwrap(), "selected fragment");
    assert_eq!(
        serde_json::to_value(&receipt).unwrap()["kind"],
        "textSnapshot"
    );
    assert!(matches!(
        export_text("replace", &output),
        Err(DeliveryError::AlreadyExists)
    ));
    assert_eq!(fs::read_to_string(output).unwrap(), "selected fragment");
}

#[test]
fn replaced_root_during_read_is_rejected() {
    let outer = tempfile::tempdir().unwrap();
    let root = outer.path().join("root");
    fs::create_dir(&root).unwrap();
    let source = root.join("source.txt");
    fs::write(&source, "original").unwrap();
    let opened = open_source(&root, &source, MAX_FILE_BYTES).unwrap();
    fs::rename(&root, outer.path().join("moved-root")).unwrap();
    fs::create_dir(&root).unwrap();
    fs::write(root.join("source.txt"), "original").unwrap();
    assert_eq!(recheck(&opened), Err(DeliveryError::Changed));
}

#[cfg(unix)]
#[test]
fn destination_parent_replacement_and_alias_redirect_have_distinct_post_commit_error() {
    let outer = tempfile::tempdir().unwrap();
    let original = outer.path().join("original");
    let other = outer.path().join("other");
    fs::create_dir(&original).unwrap();
    fs::create_dir(&other).unwrap();
    let alias = outer.path().join("alias");
    symlink(&original, &alias).unwrap();
    let resolved = original.canonicalize().unwrap();
    let directory = open_directory(&resolved).unwrap();
    assert_eq!(
        check_destination_parent(&alias, &resolved, &directory, false),
        Ok(())
    );
    fs::remove_file(&alias).unwrap();
    symlink(&other, &alias).unwrap();
    assert_eq!(
        check_destination_parent(&alias, &resolved, &directory, false),
        Err(DeliveryError::Changed)
    );
    assert_eq!(
        check_destination_parent(&alias, &resolved, &directory, true),
        Err(DeliveryError::DestinationChanged)
    );
    fs::rename(&original, outer.path().join("moved")).unwrap();
    fs::create_dir(&original).unwrap();
    assert_eq!(
        check_destination_parent(&original, &resolved, &directory, false),
        Err(DeliveryError::Changed)
    );
}
