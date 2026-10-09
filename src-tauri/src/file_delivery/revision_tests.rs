use super::*;
use std::fs;

fn fixture() -> (tempfile::TempDir, std::path::PathBuf, VerifiedFile) {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("selected.txt");
    fs::write(&path, "version one").unwrap();
    let file = crate::file_delivery::inspect(root.path(), &path).unwrap();
    (root, path, file)
}

#[test]
fn unchanged_hint_is_not_a_fresh_content_receipt() {
    let (_root, _path, file) = fixture();
    assert_eq!(
        check_revision(&file, RevisionMode::Hint),
        Ok(RevisionCheck::HintUnchanged)
    );
}

#[test]
fn unchanged_hint_never_enters_the_content_reader() {
    let (_root, _path, file) = fixture();
    assert_eq!(
        check_with_capture(&file, RevisionMode::Hint, |_| {
            panic!("idle metadata check must not read the file body")
        }),
        Ok(RevisionCheck::HintUnchanged)
    );
}

#[test]
fn deleted_selected_file_reports_missing_without_searching_for_its_rename() {
    let (_root, path, file) = fixture();
    fs::rename(&path, path.with_file_name("moved.txt")).unwrap();
    assert_eq!(
        check_revision(&file, RevisionMode::Hint),
        Err(RevisionFailure { code: "missing" })
    );
}

#[cfg(unix)]
#[test]
fn redirected_alias_is_not_adopted_as_a_new_selected_file() {
    let (root, path, _) = fixture();
    let alias = root.path().join("selected-alias.txt");
    std::os::unix::fs::symlink(&path, &alias).unwrap();
    let selected = crate::file_delivery::inspect(root.path(), &alias).unwrap();
    let other = root.path().join("other.txt");
    fs::write(&other, "version one").unwrap();
    fs::remove_file(&alias).unwrap();
    std::os::unix::fs::symlink(&other, &alias).unwrap();
    assert_eq!(
        check_revision(&selected, RevisionMode::Hint),
        Err(RevisionFailure { code: "redirected" })
    );
}

#[test]
fn full_mode_returns_verified_content_even_when_metadata_is_unchanged() {
    let (_root, _path, file) = fixture();
    assert_eq!(
        check_revision(&file, RevisionMode::Content),
        Ok(RevisionCheck::Verified { file })
    );
}

#[test]
fn same_path_atomic_replacement_can_refresh_but_old_explicit_reads_still_fail() {
    let (_root, path, file) = fixture();
    let replacement = path.with_file_name("replacement.txt");
    fs::write(&replacement, "version one").unwrap();
    fs::rename(replacement, &path).unwrap();
    let RevisionCheck::Verified { file: next } = check_revision(&file, RevisionMode::Hint).unwrap()
    else {
        panic!("replacement must be fully verified");
    };
    assert_eq!(file.sha256, next.sha256);
    assert_ne!(file.version, next.version);
    assert_eq!(file.resolved_path, next.resolved_path);
    assert!(matches!(
        crate::file_delivery::read_text(&file),
        Err(DeliveryError::Changed)
    ));
    assert_eq!(
        crate::file_delivery::read_text(&next).unwrap().text,
        "version one"
    );
    let destination = path.with_file_name("must-not-export.txt");
    assert!(matches!(
        crate::file_delivery::copy(&file, &destination),
        Err(DeliveryError::Changed)
    ));
    assert!(!destination.exists());
    assert!(matches!(
        crate::file_delivery::revalidate_for_open(&file),
        Err(DeliveryError::Changed)
    ));
}

#[test]
fn same_length_edit_is_fully_captured_once_before_returning_a_receipt() {
    let (_root, path, file) = fixture();
    fs::write(&path, "version two").unwrap();
    let calls = std::cell::Cell::new(0);
    let result = check_with_capture(&file, RevisionMode::Hint, |opened| {
        calls.set(calls.get() + 1);
        super::super::capture_opened(opened, super::super::MAX_FILE_BYTES).map(|(file, bytes)| {
            assert_eq!(bytes, b"version two");
            file
        })
    })
    .unwrap();
    assert_eq!(calls.get(), 1);
    let RevisionCheck::Verified { file: next } = result else {
        panic!("changed metadata must be fully verified");
    };
    assert_ne!(next.sha256, file.sha256);
    assert_ne!(next.version, file.version);
}

#[test]
fn full_fallback_detects_bytes_even_with_an_equivalent_metadata_hint() {
    let (_root, path, mut file) = fixture();
    fs::write(&path, "version two").unwrap();
    // Model a filesystem with colliding/coarse or restored timestamps. This
    // does not claim that the real host filesystem permits restoring ctime.
    // Keep the OLD digest while making its metadata observation match now.
    let opened = super::super::open_source(
        Path::new(&file.root),
        Path::new(&file.path),
        super::super::MAX_FILE_BYTES,
    )
    .unwrap();
    file.version = super::super::version(&opened, &file.sha256).unwrap();
    drop(opened);
    assert_eq!(
        check_revision(&file, RevisionMode::Hint),
        Ok(RevisionCheck::HintUnchanged)
    );
    let RevisionCheck::Verified { file: next } =
        check_revision(&file, RevisionMode::Content).unwrap()
    else {
        panic!("forced full checks must not trust matching metadata");
    };
    assert_ne!(next.sha256, file.sha256);
    assert!(matches!(
        crate::file_delivery::read_text(&file),
        Err(DeliveryError::Changed)
    ));
}

#[test]
fn replacement_after_metadata_observation_cannot_return_wrong_bytes() {
    let (_root, path, file) = fixture();
    let result = check_with_capture(&file, RevisionMode::Content, |opened| {
        let replacement = path.with_file_name("replacement.txt");
        fs::write(&replacement, "version two").unwrap();
        fs::rename(&replacement, &path).unwrap();
        super::super::capture_opened(opened, super::super::MAX_FILE_BYTES).map(|(file, _)| file)
    });
    assert_eq!(result, Err(RevisionFailure { code: "changing" }));
}

#[test]
fn missing_root_and_missing_leaf_are_not_conflated_with_other_io_failures() {
    let (root, path, file) = fixture();
    fs::remove_file(path).unwrap();
    fs::remove_dir(root.path()).unwrap();
    assert_eq!(
        check_revision(&file, RevisionMode::Hint),
        Err(RevisionFailure { code: "missing" })
    );
    for kind in [
        std::io::ErrorKind::PermissionDenied,
        std::io::ErrorKind::Other,
    ] {
        assert_eq!(
            RevisionFailure::from(SourceOpenError {
                delivery: DeliveryError::Unreadable,
                cause: Some(kind),
            }),
            RevisionFailure { code: "unreadable" }
        );
    }
}

#[cfg(unix)]
#[test]
fn directory_and_fifo_replacements_do_not_enter_content_capture() {
    let (_root, path, file) = fixture();
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert_eq!(
        check_revision(&file, RevisionMode::Hint),
        Err(RevisionFailure { code: "notFile" })
    );
    fs::remove_dir(&path).unwrap();
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    // This exact temporary fixture path has no remaining file or directory.
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    assert_eq!(
        check_with_capture(&file, RevisionMode::Hint, |_| panic!(
            "FIFO must not be read"
        )),
        Err(RevisionFailure { code: "notFile" })
    );
}

#[test]
fn oversized_replacement_does_not_enter_content_capture() {
    let (_root, path, file) = fixture();
    let replacement = fs::File::create(&path).unwrap();
    replacement
        .set_len(super::super::MAX_FILE_BYTES + 1)
        .unwrap();
    drop(replacement);
    assert_eq!(
        check_with_capture(&file, RevisionMode::Hint, |_| panic!(
            "oversized content must not be read"
        )),
        Err(RevisionFailure { code: "tooLarge" })
    );
}

#[test]
fn replacing_the_root_cannot_match_the_old_hint_even_with_the_same_leaf_handle_identity() {
    let container = tempfile::tempdir().unwrap();
    let root = container.path().join("selected-root");
    let replacement_root = container.path().join("replacement-root");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&replacement_root).unwrap();
    let path = root.join("selected.txt");
    fs::write(&path, "version one").unwrap();
    fs::hard_link(&path, replacement_root.join("selected.txt")).unwrap();
    let file = crate::file_delivery::inspect(&root, &path).unwrap();
    let before = crate::file_access::stamp(&fs::File::open(&path).unwrap()).unwrap();
    fs::rename(&root, container.path().join("old-root")).unwrap();
    fs::rename(&replacement_root, &root).unwrap();
    let after = crate::file_access::stamp(&fs::File::open(&path).unwrap()).unwrap();
    assert_eq!(before, after, "fixture must preserve the leaf metadata");
    let RevisionCheck::Verified { file: next } = check_revision(&file, RevisionMode::Hint).unwrap()
    else {
        panic!("root identity replacement must be fully checked");
    };
    assert_eq!(next.root, file.root);
    assert_eq!(next.resolved_path, file.resolved_path);
    assert_eq!(next.sha256, file.sha256);
    assert_ne!(next.version, file.version);
}

#[cfg(unix)]
#[test]
fn root_redirect_is_rejected_before_a_leaf_is_read() {
    let (root, path, file) = fixture();
    let other = tempfile::tempdir().unwrap();
    fs::write(other.path().join("selected.txt"), "version two").unwrap();
    fs::remove_file(path).unwrap();
    fs::remove_dir(root.path()).unwrap();
    std::os::unix::fs::symlink(other.path(), root.path()).unwrap();
    let result = check_with_capture(&file, RevisionMode::Hint, |_| {
        panic!("redirected root must not be read")
    });
    // Remove only the exact controlled link; TempDir still owns its old path.
    fs::remove_file(root.path()).unwrap();
    assert_eq!(result, Err(RevisionFailure { code: "redirected" }));
}

#[test]
fn wire_modes_and_results_preserve_the_hint_content_distinction() {
    assert_eq!(
        serde_json::from_str::<RevisionMode>("\"hint\"").unwrap(),
        RevisionMode::Hint
    );
    assert_eq!(
        serde_json::from_str::<RevisionMode>("\"content\"").unwrap(),
        RevisionMode::Content
    );
    assert!(serde_json::from_str::<RevisionMode>("\"other\"").is_err());
    assert_eq!(
        serde_json::to_value(RevisionCheck::HintUnchanged).unwrap(),
        serde_json::json!({"kind":"hintUnchanged"})
    );
    let (_root, _path, file) = fixture();
    let json = serde_json::to_value(check_revision(&file, RevisionMode::Content).unwrap()).unwrap();
    assert_eq!(json, serde_json::json!({"kind":"verified","file":file}));
}

#[test]
fn read_check_failures_are_exact_code_objects_without_raw_messages() {
    // The read-check module's own deterministic blocking tests prove admission
    // and real timeout behavior; these verify the new IPC-facing serialization.
    let cases = [
        (
            "文件检查尚未返回，后台可能仍在检查。请查看系统访问提示；仍无响应时，保存工作后退出重开。",
            "pending",
        ),
        (
            "已有文件检查尚未结束，本次未开始新检查。请稍后重试；仍无响应时，保存工作后退出重开。",
            "busy",
        ),
        ("controlled raw failure must not reach UI", "unavailable"),
    ];
    for (message, code) in cases {
        let json = serde_json::to_value(RevisionFailure::check(message)).unwrap();
        assert_eq!(json, serde_json::json!({"code":code}));
    }
    for code in [
        "missing",
        "redirected",
        "changing",
        "notFile",
        "tooLarge",
        "unreadable",
    ] {
        assert_eq!(
            serde_json::to_value(RevisionFailure { code }).unwrap(),
            serde_json::json!({"code":code})
        );
    }
}
