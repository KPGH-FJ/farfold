//! Windows-owned filesystem controls for the exact production end fence.
//! Proposed only; no claim about the original capture's unobserved branch.
use super::*;
use std::{fs, fs::FileTimes, path::PathBuf, time::Duration};
struct Fixture {
    dir: PinnedPath,
    root: PathBuf,
    _temp: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap().join("selected");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("owned.txt"), b"body").unwrap();
        let dir = PinnedPath::directory(&root).unwrap();
        Self {
            dir,
            root,
            _temp: temp,
        }
    }
    fn listed(&self) -> DirectoryEntries {
        directory_entries(&self.dir, 1, &AtomicBool::new(false)).unwrap()
    }
    fn metadata(&self) -> EntryMetadata {
        metadata_child(self.dir.file(), OsStr::new("owned.txt"))
            .unwrap()
            .unwrap()
    }
    fn change_time_field(&self) {
        let path = self.root.join("owned.txt");
        let previous = fs::metadata(&path).unwrap().modified().unwrap();
        let file = fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_times(FileTimes::new().set_modified(previous + Duration::from_secs(60)))
            .unwrap();
    }
}
#[test]
fn real_enumeration_snapshot_can_precede_a_stable_current_handle_version() {
    let fixture = Fixture::new();
    let listed = fixture.listed();
    let original = fixture.metadata();
    // A genuine earlier directory observation, not a forged metadata record.
    fixture.change_time_field();
    let current = fixture.metadata();
    assert_ne!(original, current);
    assert_ne!(original.version_fields(), current.version_fields());
    let (raw, observed) = listed.first_key_value().unwrap();
    assert!(!current.matches_directory_entry(observed));
    assert!(current.matches_directory_identity(observed));
    let versions = [(raw.as_slice(), current)];
    recheck_children(&fixture.dir, &listed, &versions, 1, &AtomicBool::new(false)).unwrap();
    assert_eq!(fs::read(fixture.root.join("owned.txt")).unwrap(), b"body");
}
#[test]
fn actual_same_identity_metadata_change_after_capture_is_still_rejected() {
    let fixture = Fixture::new();
    let listed = fixture.listed();
    let (raw, observed) = listed.first_key_value().unwrap();
    let original = fixture.metadata();
    fixture.change_time_field();
    let current = fixture.metadata();
    assert!(current.matches_directory_identity(observed));
    assert_ne!(current, original);
    let versions = [(raw.as_slice(), original)];
    assert_eq!(
        recheck_children(&fixture.dir, &listed, &versions, 1, &AtomicBool::new(false))
            .unwrap_err()
            .code,
        "materialChanged"
    );
    assert_eq!(fs::read(fixture.root.join("owned.txt")).unwrap(), b"body");
}
#[test]
fn same_name_and_length_replacement_cannot_pass_the_full_identity_fence() {
    let fixture = Fixture::new();
    let listed = fixture.listed();
    let (raw, observed) = listed.first_key_value().unwrap();
    let original = fixture.metadata();
    // Test-owned rename outside this selected directory, still in the same
    // TempDir. The standard handle keeps the old object alive, not its name.
    let path = fixture.root.join("owned.txt");
    let held_original = fs::File::open(&path).unwrap();
    fs::rename(&path, fixture._temp.path().join("previous.txt")).unwrap();
    fs::write(&path, b"body").unwrap();
    let replacement = fixture.metadata();
    assert!(!replacement.matches_directory_identity(observed));
    let versions = [(raw.as_slice(), original)];
    assert_eq!(
        recheck_children(&fixture.dir, &listed, &versions, 1, &AtomicBool::new(false))
            .unwrap_err()
            .code,
        "materialChanged"
    );
    assert_eq!(fs::read(path).unwrap(), b"body");
    drop(held_original);
}
#[test]
fn already_cancelled_end_fence_cannot_publish_a_stable_version() {
    let fixture = Fixture::new();
    let listed = fixture.listed();
    let (raw, _) = listed.first_key_value().unwrap();
    let versions = [(raw.as_slice(), fixture.metadata())];
    assert_eq!(
        recheck_children(&fixture.dir, &listed, &versions, 1, &AtomicBool::new(true))
            .unwrap_err()
            .code,
        "cancelled"
    );
}

#[test]
fn actual_same_identity_attribute_change_after_capture_is_still_rejected() {
    let fixture = Fixture::new();
    let listed = fixture.listed();
    let (raw, observed) = listed.first_key_value().unwrap();
    let original = fixture.metadata();
    let path = fixture.root.join("owned.txt");
    let permissions = fs::metadata(&path).unwrap().permissions();
    assert!(!permissions.readonly());
    struct Restore {
        path: PathBuf,
        permissions: fs::Permissions,
    }
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.path, self.permissions.clone());
        }
    }
    let restore = Restore {
        path: path.clone(),
        permissions: permissions.clone(),
    };
    let mut changed = permissions;
    changed.set_readonly(true);
    fs::set_permissions(&path, changed).unwrap();
    let current = fixture.metadata();
    let versions = [(raw.as_slice(), original.clone())];
    let result = recheck_children(&fixture.dir, &listed, &versions, 1, &AtomicBool::new(false));
    fs::set_permissions(&path, restore.permissions.clone()).unwrap();
    drop(restore);
    assert!(current.matches_directory_identity(observed));
    assert_ne!(current.attributes(), original.attributes());
    assert_eq!(result.unwrap_err().code, "materialChanged");
    assert_eq!(fs::read(path).unwrap(), b"body");
}
