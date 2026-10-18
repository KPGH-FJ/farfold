use super::*;
fn run(root: &Path, limits: Limits) -> Result<ProjectFiles, Failure> {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    scan(
        &root,
        "00000000-0000-4000-8000-000000000001".into(),
        &AtomicBool::new(false),
        limits,
    )
}

#[cfg(unix)]
#[test]
fn queued_directory_replaced_with_symlink_must_not_enumerate_external_names() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("queued");
    std::fs::create_dir(&path).unwrap();
    let queued = Directory::capture(&path, 1).unwrap();
    std::fs::rename(&path, path.with_file_name("moved")).unwrap();
    std::fs::write(outside.path().join("OUTSIDE_CANARY"), "x").unwrap();
    std::os::unix::fs::symlink(outside.path(), &path).unwrap();
    let result = queued.open();
    assert!(
        result.is_err(),
        "queued directory changed into an external symlink but was opened"
    );
}
fn files(root: &Path, count: usize) {
    for i in 0..count {
        std::fs::write(root.join(format!("f{i:05}.txt")), "x").unwrap();
    }
}

#[test]
fn unreadable_root_is_not_a_successful_empty_listing() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        run(&dir.path().join("missing"), Limits::default())
            .unwrap_err()
            .code,
        "unreadable"
    );
    let empty = run(dir.path(), Limits::default()).unwrap();
    assert!(empty.files.is_empty());
    assert!(!empty.partial && !empty.truncated);
}
#[cfg(unix)]
#[test]
fn backslash_names_do_not_alias_a_different_real_file() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("a")).unwrap();
    std::fs::write(dir.path().join("a/b"), "one").unwrap();
    std::fs::write(dir.path().join("a\\b"), "other").unwrap();
    let result = run(dir.path(), Limits::default()).unwrap();
    assert_eq!(result.files, vec!["a/b"]);
    assert!(result.partial);
    assert_eq!(result.counts.unsupported_names, 1);
}
#[test]
fn reports_file_limit_without_claiming_complete_index() {
    let dir = tempfile::tempdir().unwrap();
    files(dir.path(), 2005);
    let result = run(dir.path(), Limits::default()).unwrap();
    assert_eq!(result.files.len(), 2000);
    assert!(result.truncated && !result.partial);
    assert_eq!(result.limit_reasons, vec![LimitReason::File]);
    println!(
        "PROJECT_FILES_TRUNCATED_WIRE {}",
        serde_json::to_string(&result).unwrap()
    );
}
#[test]
fn single_directory_entry_budget_is_applied_before_next_read() {
    let dir = tempfile::tempdir().unwrap();
    files(dir.path(), 100);
    let result = run(
        dir.path(),
        Limits {
            entries_per_directory: 8,
            ..Limits::default()
        },
    )
    .unwrap();
    assert_eq!(result.counts.entries, 8);
    assert_eq!(result.files.len(), 8);
    assert_eq!(result.limit_reasons, vec![LimitReason::DirectoryEntry]);
}
#[test]
fn aggregate_entries_and_directory_queue_are_bounded() {
    let dir = tempfile::tempdir().unwrap();
    for i in 0..5 {
        let sub = dir.path().join(format!("dir{i}"));
        std::fs::create_dir(&sub).unwrap();
        files(&sub, 10);
    }
    let result = run(
        dir.path(),
        Limits {
            entries: 12,
            ..Limits::default()
        },
    )
    .unwrap();
    assert_eq!(result.counts.entries, 12);
    assert!(result.limit_reasons.contains(&LimitReason::Entry));
    let result = run(
        dir.path(),
        Limits {
            directories: 2,
            ..Limits::default()
        },
    )
    .unwrap();
    assert_eq!(result.counts.directories, 2);
    assert_eq!(result.files.len(), 10);
    assert!(result.limit_reasons.contains(&LimitReason::Directory));
}
#[test]
fn depth_cap_keeps_other_visible_files_and_reports_omission() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("a/b/c")).unwrap();
    std::fs::write(dir.path().join("a/b/c/hidden.txt"), "x").unwrap();
    std::fs::write(dir.path().join("a/kept.txt"), "x").unwrap();
    let result = run(
        dir.path(),
        Limits {
            depth: 1,
            ..Limits::default()
        },
    )
    .unwrap();
    assert_eq!(result.files, vec!["a/kept.txt"]);
    assert_eq!(result.limit_reasons, vec![LimitReason::Depth]);
}
#[test]
fn path_byte_budget_counts_utf8_bytes_not_characters() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("中文.txt"), "x").unwrap();
    let result = run(
        dir.path(),
        Limits {
            path_bytes: 8,
            ..Limits::default()
        },
    )
    .unwrap();
    assert!(result.files.is_empty());
    assert_eq!(result.limit_reasons, vec![LimitReason::PathBytes]);
}
#[test]
fn elapsed_and_requested_cancel_do_not_claim_os_completion_early() {
    let dir = tempfile::tempdir().unwrap();
    files(dir.path(), 2);
    let result = run(
        dir.path(),
        Limits {
            time_ms: 0,
            ..Limits::default()
        },
    )
    .unwrap();
    assert_eq!(result.counts.directories, 0);
    assert_eq!(result.limit_reasons, vec![LimitReason::Time]);
    let result = scan(
        dir.path(),
        "cancelled".into(),
        &AtomicBool::new(true),
        Limits::default(),
    )
    .unwrap();
    assert!(result.cancelled && !result.truncated);
    assert_eq!(result.counts.entries, 0);
}
#[cfg(unix)]
#[test]
fn excluded_directories_and_symlink_targets_are_not_traversed() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
    std::fs::write(dir.path().join("node_modules/pkg/private"), "x").unwrap();
    std::fs::write(outside.path().join("outside"), "x").unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
    let result = run(dir.path(), Limits::default()).unwrap();
    assert_eq!(result.files, vec!["link"]);
    assert_eq!(result.counts.skipped_directories, 1);
    assert!(!result.partial && !result.truncated);
    assert!(result.excluded_directory_names.contains(&"node_modules"));
}
#[cfg(unix)]
#[test]
fn permission_denied_subtree_is_partial_but_root_failure_is_error() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let denied = dir.path().join("denied");
    std::fs::create_dir(&denied).unwrap();
    std::fs::write(denied.join("secret"), "x").unwrap();
    std::fs::write(dir.path().join("visible"), "x").unwrap();
    struct Restore(std::path::PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o700));
        }
    }
    let _restore = Restore(denied.clone());
    std::fs::set_permissions(&denied, std::fs::Permissions::from_mode(0o0)).unwrap();
    // Actual permissions are required for this fixture. Elevated test runners
    // cannot use chmod(000) as evidence of an unreadable directory.
    assert!(
        std::fs::read_dir(&denied).is_err(),
        "permission fixture requires an unprivileged test process"
    );
    let result = run(dir.path(), Limits::default()).unwrap();
    assert_eq!(result.files, vec!["visible"]);
    assert!(result.partial && !result.truncated);
    assert_eq!(result.counts.unreadable_directories, 1);
    assert_eq!(
        run(&denied, Limits::default()).unwrap_err().code,
        "unreadable"
    );
}
#[test]
fn actual_wire_preserves_coverage_not_just_paths() {
    let dir = tempfile::tempdir().unwrap();
    files(dir.path(), 3);
    let result = run(dir.path(), Limits::default()).unwrap();
    println!(
        "PROJECT_FILES_WIRE {}",
        serde_json::to_string(&result).unwrap()
    );
    let value = serde_json::to_value(result).unwrap();
    assert_eq!(value["truncated"], false);
    assert_eq!(value["partial"], false);
    assert_eq!(value["limits"]["entriesPerDirectory"], 4096);
    assert_eq!(value["counts"]["entries"], 3);
}

#[cfg(unix)]
#[test]
fn directory_replaced_after_open_is_not_current_for_publication() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("queued");
    std::fs::create_dir(&path).unwrap();
    let queued = Directory::capture(&path, 1).unwrap();
    let entries = queued.open().unwrap();
    std::fs::rename(&path, path.with_file_name("moved")).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(!queued.current());
    drop(entries);
}

#[cfg(unix)]
#[test]
fn undecodable_and_control_names_are_not_rewritten() {
    use std::os::unix::ffi::OsStringExt;
    assert!(relative_name(Path::new(&std::ffi::OsString::from_vec(vec![0xff]))).is_none());
    assert!(relative_name(Path::new("line\nbreak")).is_none());
    assert_eq!(
        relative_name(Path::new("\u{fffd}")),
        Some("\u{fffd}".into())
    );
}
