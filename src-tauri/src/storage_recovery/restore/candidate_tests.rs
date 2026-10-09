use super::*;
use std::fs;
fn source() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("candidate.sqlite3");
    fs::write(&path, b"original").unwrap();
    (dir, path)
}
#[test]
fn changed_bytes_or_side_file_set_after_capture_are_rejected() {
    let (_dir, path) = source();
    let paths = vec![path.clone()];
    let before = vec![read_file(&path, None).unwrap()];
    assert!(verify_capture(&path, &paths, &before).is_ok());
    fs::write(&path, b"different").unwrap();
    assert!(verify_capture(&path, &paths, &before).is_err());
    fs::write(&path, b"original").unwrap();
    let wal = PathBuf::from(format!("{}-wal", path.display()));
    fs::write(&wal, b"wal").unwrap();
    assert!(verify_capture(&path, &paths, &before).is_err());
    let paths = vec![path.clone(), wal.clone()];
    let before = paths
        .iter()
        .map(|p| read_file(p, None).unwrap())
        .collect::<Vec<_>>();
    fs::remove_file(wal).unwrap();
    assert!(verify_capture(&path, &paths, &before).is_err());
}
#[cfg(unix)]
#[test]
fn symbolic_link_side_file_and_ancestor_are_rejected() {
    let (dir, path) = source();
    let target = dir.path().join("other");
    fs::write(&target, b"private").unwrap();
    let wal = PathBuf::from(format!("{}-wal", path.display()));
    std::os::unix::fs::symlink(&target, &wal).unwrap();
    let out = tempfile::tempdir().unwrap();
    assert!(capture(&path, out.path()).is_err());
    assert_eq!(fs::read(target).unwrap(), b"private");
    let link = dir.path().join("folder-link");
    std::os::unix::fs::symlink(path.parent().unwrap(), &link).unwrap();
    assert!(read_file(&link.join("candidate.sqlite3"), None).is_err());
}
#[test]
fn oversized_sparse_source_is_refused() {
    let (_dir, path) = source();
    OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(MAX_DATABASE_BYTES + 1)
        .unwrap();
    assert!(read_file(&path, None).is_err());
}
