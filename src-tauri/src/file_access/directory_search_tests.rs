//! Real macOS filesystem entrypoints, using only owned temporary material.
use super::*;
use crate::file_delivery::{self as delivery, DeliveryError};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
};

struct PermissionGuard {
    path: PathBuf,
    original: fs::Permissions,
}
impl PermissionGuard {
    fn set(path: &Path, mode: u32) -> Self {
        assert_ne!(
            unsafe { libc::geteuid() },
            0,
            "permission fixture requires an unprivileged user"
        );
        let original = fs::metadata(path).unwrap().permissions();
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
        Self {
            path: path.to_owned(),
            original,
        }
    }
}
impl Drop for PermissionGuard {
    fn drop(&mut self) {
        fs::set_permissions(&self.path, self.original.clone()).unwrap();
    }
}
fn fixture() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    (temp, base)
}

#[test]
fn directory_search_capture_and_recheck_read_known_file_without_listing_parent() {
    let (_temp, base) = fixture();
    let nested = base.join("search");
    fs::create_dir(&nested).unwrap();
    let path = nested.join("report.txt");
    fs::write(&path, "known fixture text").unwrap();
    let _permissions = PermissionGuard::set(&nested, 0o100);
    assert_eq!(fs::read(&path).unwrap(), b"known fixture text");
    assert_eq!(
        fs::read_dir(&nested).unwrap_err().kind(),
        io::ErrorKind::PermissionDenied
    );
    // Both the absolute root walk and relative intermediate walk are exercised.
    if directory_flags() & libc::O_SEARCH != libc::O_SEARCH {
        assert!(delivery::inspect(&nested, &path).is_err());
        return; // macOS 11/12 or unknown retains the known directory-read limit.
    }
    let selected = delivery::inspect(&nested, &path).expect("selected parent needs only search");
    let relative = delivery::inspect(&base, Path::new("search/report.txt")).unwrap();
    assert_eq!(
        delivery::read_text(&selected).unwrap().text,
        "known fixture text"
    );
    assert_eq!(
        delivery::read_text(&relative).unwrap().text,
        "known fixture text"
    );
    assert_eq!(
        delivery::revalidate_for_open(&selected).unwrap(),
        path.to_str().unwrap()
    );
    assert_eq!(
        delivery::check_attachment(&base, &path, true)
            .unwrap()
            .as_deref(),
        Some("known fixture text")
    );
    assert_eq!(
        delivery::check_attachment(&base, &path, false).unwrap(),
        None
    );
    assert_eq!(
        delivery::attachment_prefix(&base, &path).unwrap(),
        b"known fixture text"
    );
    assert_eq!(
        delivery::attachment_bytes(&base, &path, 64).unwrap(),
        b"known fixture text"
    );
    assert_eq!(
        delivery::attachment_bytes(&base, &path, 4),
        Err(DeliveryError::TooLarge)
    );
}

#[test]
fn directory_search_export_to_write_search_parent_never_overwrites_or_leaks_temp() {
    let (_temp, base) = fixture();
    let destination = base.join("destination");
    fs::create_dir(&destination).unwrap();
    let source = base.join("source.txt");
    fs::write(&source, "source").unwrap();
    let source = delivery::inspect(&base, &source).unwrap();
    let existing = destination.join("existing.txt");
    fs::write(&existing, "retain").unwrap();
    let permissions = PermissionGuard::set(&destination, 0o300);
    assert!(fs::read_dir(&destination).is_err());
    if directory_flags() & libc::O_SEARCH != libc::O_SEARCH {
        assert!(delivery::export_text("snapshot", &destination.join("snapshot.txt")).is_err());
        return; // Existing behavior on older/unknown macOS remains unchanged.
    }
    let receipt = delivery::export_text("snapshot", &destination.join("snapshot.txt")).unwrap();
    assert_eq!(receipt.size, 8);
    assert_eq!(
        fs::read(destination.join("snapshot.txt")).unwrap(),
        b"snapshot"
    );
    delivery::copy(&source, &destination.join("copy.txt")).unwrap();
    assert_eq!(fs::read(destination.join("copy.txt")).unwrap(), b"source");
    assert!(matches!(
        delivery::export_text("replace", &existing),
        Err(DeliveryError::AlreadyExists)
    ));
    assert_eq!(fs::read(&existing).unwrap(), b"retain");
    symlink(&existing, destination.join("alias.txt")).unwrap();
    assert!(matches!(
        delivery::copy(&source, &destination.join("alias.txt")),
        Err(DeliveryError::AlreadyExists)
    ));
    assert!(
        fs::symlink_metadata(destination.join("alias.txt"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    drop(permissions);
    assert!(!fs::read_dir(&destination).unwrap().flatten().any(|entry| {
        entry
            .file_name()
            .to_string_lossy()
            .starts_with(".farfold-export-")
    }));
}

#[test]
fn directory_search_missing_search_read_or_write_still_refuses_access() {
    let (_temp, base) = fixture();
    let dir = base.join("restricted");
    fs::create_dir(&dir).unwrap();
    let path = dir.join("file.txt");
    fs::write(&path, "private fixture").unwrap();
    let permission = PermissionGuard::set(&dir, 0o400);
    assert!(delivery::inspect(&dir, &path).is_err());
    if directory_flags() & libc::O_SEARCH == libc::O_SEARCH {
        assert!(open_directory(&dir).is_err());
    }
    drop(permission);
    let permission = PermissionGuard::set(&path, 0o000);
    assert!(delivery::inspect(&dir, &path).is_err());
    drop(permission);
    let _permission = PermissionGuard::set(&dir, 0o100);
    assert!(delivery::export_text("denied", &dir.join("new.txt")).is_err());
    assert!(!dir.join("new.txt").exists());
}

#[test]
fn directory_search_handles_keep_nofollow_cloexec_and_leaf_nonblocking() {
    let (_temp, base) = fixture();
    fs::create_dir(base.join("child")).unwrap();
    fs::write(base.join("child/file.txt"), "data").unwrap();
    symlink(base.join("child"), base.join("alias")).unwrap();
    symlink(base.join("child/file.txt"), base.join("leaf.txt")).unwrap();
    let root = open_directory(&base).unwrap();
    assert!(open_directory(&base.join("alias")).is_err());
    assert!(open_relative(&root, Path::new("alias/file.txt")).is_err());
    assert!(open_relative(&root, Path::new("leaf.txt")).is_err());
    assert!(open_relative(&root, Path::new("../elsewhere")).is_err());
    let file = open_relative(&root, Path::new("child/file.txt")).unwrap();
    let filesystem_root = open_directory(Path::new("/")).unwrap();
    for fd in [
        root.as_raw_fd(),
        file.as_raw_fd(),
        filesystem_root.as_raw_fd(),
    ] {
        assert_ne!(
            unsafe { libc::fcntl(fd, libc::F_GETFD) } & libc::FD_CLOEXEC,
            0
        );
    }
    assert_ne!(
        unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) } & libc::O_NONBLOCK,
        0
    );
    let fifo_path = base.join("pipe.txt");
    let fifo = CString::new(fifo_path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    assert_eq!(
        delivery::inspect(&base, &fifo_path),
        Err(DeliveryError::NotFile)
    );
    assert!(open_directory(&fifo_path).is_err());
}

#[test]
fn directory_search_replacement_and_permission_revocation_invalidate_receipt() {
    let (_temp, base) = fixture();
    let dir = base.join("root");
    fs::create_dir(&dir).unwrap();
    let path = dir.join("file.txt");
    fs::write(&path, "same").unwrap();
    let receipt = delivery::inspect(&dir, &path).unwrap();
    let permissions = PermissionGuard::set(&dir, 0o000);
    assert!(delivery::read_text(&receipt).is_err());
    drop(permissions);
    let replacement = base.join("replacement.txt");
    fs::write(&replacement, "same").unwrap();
    fs::rename(&replacement, &path).unwrap();
    assert!(matches!(
        delivery::read_text(&receipt),
        Err(DeliveryError::Changed)
    ));
    let receipt = delivery::inspect(&dir, &path).unwrap();
    fs::rename(&dir, base.join("old-root")).unwrap();
    fs::create_dir(&dir).unwrap();
    fs::write(&path, "same").unwrap();
    assert!(matches!(
        delivery::read_text(&receipt),
        Err(DeliveryError::Changed)
    ));
}

#[test]
fn directory_search_macos_version_policy_keeps_legacy_and_unknown_access() {
    for version in [
        b"11.0\0".as_slice(),
        b"11.7.10\0",
        b"12.7.6\0",
        b"10.16\0",
        b"\0",
        b"13\0",
        b"13..1\0",
        b"13.0.0.1\0",
        b"13.0",
        b"+13.0\0",
        b"13.0junk\0",
        b"4294967296.0\0",
        b"13.0\0extra\0",
    ] {
        assert_eq!(
            directory_access_for_version(version),
            READ_DIRECTORY,
            "{version:?}"
        );
    }
    for version in [b"13.0\0".as_slice(), b"13.0.1\0", b"15.6\0", b"26.0\0"] {
        assert_eq!(
            directory_access_for_version(version),
            libc::O_SEARCH,
            "{version:?}"
        );
    }
    assert_eq!(
        directory_flags() & (libc::O_NOFOLLOW | libc::O_CLOEXEC),
        libc::O_NOFOLLOW | libc::O_CLOEXEC
    );
}

#[test]
fn directory_search_runtime_flags_apply_to_filesystem_root_and_nested_handles() {
    let version = std::process::Command::new("/usr/sbin/sysctl")
        .args(["-n", "kern.osproductversion"])
        .output()
        .unwrap();
    assert!(version.status.success());
    let version = std::str::from_utf8(&version.stdout).unwrap().trim();
    let major = version.split('.').next().unwrap().parse::<u32>().unwrap();
    let expected_search = major >= 13;
    eprintln!("directory search fixture: macOS {version}, expectedSearch={expected_search}");
    assert_eq!(directory_flags() & libc::O_EXEC != 0, expected_search);
    let (_temp, base) = fixture();
    for path in [Path::new("/"), base.as_path()] {
        let directory = open_directory(path).unwrap();
        let flags = unsafe { libc::fcntl(directory.as_raw_fd(), libc::F_GETFL) };
        assert!(flags >= 0);
        assert_eq!(flags & libc::O_EXEC != 0, expected_search);
        assert_ne!(
            unsafe { libc::fcntl(directory.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
            0
        );
        assert!(directory.metadata().unwrap().is_dir());
    }
    fs::write(base.join("file.txt"), "read only").unwrap();
    let directory = open_directory(&base).unwrap();
    let file = open_relative(&directory, Path::new("file.txt")).unwrap();
    let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) };
    assert_eq!(flags & libc::O_ACCMODE, libc::O_RDONLY);
    assert_eq!(flags & libc::O_EXEC, 0);
    assert_ne!(flags & libc::O_NONBLOCK, 0);
}
