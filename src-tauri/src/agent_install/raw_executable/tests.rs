use super::*;
use std::cell::Cell;

const URL: &str = "https://official.invalid/program.exe?download=1#asset";

#[test]
fn raw_executable_writes_exact_declared_path_without_content_or_version_guessing() {
    let root = tempfile::tempdir().unwrap();
    let content = b"synthetic bytes, deliberately not a PE executable";
    write(content, root.path(), URL, ".\\bin\\program.exe", || Ok(())).unwrap();
    assert_eq!(
        std::fs::read(root.path().join("bin/program.exe")).unwrap(),
        content
    );
    assert_eq!(
        std::fs::read_dir(root.path().join("bin")).unwrap().count(),
        1
    );
}

#[test]
fn raw_executable_rejects_escaping_and_windows_special_paths_before_writing() {
    for command in [
        "",
        "/outside.exe",
        "\\outside.exe",
        "../outside.exe",
        "./bin/../outside.exe",
        "C:/outside.exe",
        "C:\\outside.exe",
        "\\\\server\\share\\outside.exe",
        "\\\\?\\C:\\outside.exe",
        "./program.exe:stream",
        "./CON.exe",
        "./CONIN$.exe",
        "./LPT¹.exe",
        "./bin./program.exe",
        "./bin /program.exe",
        "./bin//program.exe",
    ] {
        let root = tempfile::tempdir().unwrap();
        assert!(
            write(b"no", root.path(), URL, command, || Ok(())).is_err(),
            "{command:?}"
        );
        assert_eq!(
            std::fs::read_dir(root.path()).unwrap().count(),
            0,
            "{command:?}"
        );
    }
}

#[test]
fn raw_executable_format_comes_from_the_url_and_never_overwrites_a_candidate() {
    let root = tempfile::tempdir().unwrap();
    assert!(
        write(
            b"MZ",
            root.path(),
            "https://official.invalid/file.zip",
            "file.exe",
            || Ok(())
        )
        .is_err()
    );
    assert!(!root.path().join("file.exe").exists());
    std::fs::write(root.path().join("file.exe"), b"keep selected bytes").unwrap();
    assert!(write(b"replacement", root.path(), URL, "./file.exe", || Ok(())).is_err());
    assert_eq!(
        std::fs::read(root.path().join("file.exe")).unwrap(),
        b"keep selected bytes"
    );
}

#[test]
fn raw_executable_cancel_before_creation_does_not_touch_existing_files() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("existing.exe"), b"keep").unwrap();
    assert!(
        write(b"new", root.path(), URL, "new.exe", || Err(
            "cancelled".into()
        ))
        .is_err()
    );
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    assert_eq!(
        std::fs::read(root.path().join("existing.exe")).unwrap(),
        b"keep"
    );
}

#[test]
fn raw_executable_cancel_between_chunks_stops_unselected_candidate_write() {
    let root = tempfile::tempdir().unwrap();
    let calls = Cell::new(0);
    let bytes = vec![7; 128 * 1024];
    let result = write(&bytes, root.path(), URL, "program.exe", || {
        calls.set(calls.get() + 1);
        if calls.get() == 4 {
            Err("cancelled".into())
        } else {
            Ok(())
        }
    });
    assert_eq!(result.unwrap_err(), "cancelled");
    assert_eq!(
        std::fs::metadata(root.path().join("program.exe"))
            .unwrap()
            .len(),
        64 * 1024
    );
    // The surrounding candidate TempDir owns this partial file; it is not a
    // selected installation and cannot pass the caller's final cancellation check.
}

#[test]
#[cfg(unix)]
fn raw_executable_never_follows_a_preexisting_candidate_directory_symlink() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join("bin")).unwrap();
    assert!(write(b"no", root.path(), URL, "bin/program.exe", || Ok(())).is_err());
    assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
}
