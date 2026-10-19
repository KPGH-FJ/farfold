//! Windows-owned controls for actual fixed-name observation and comparison.
//! Proposed only; no actual NTFS cache refresh or Windows result is fabricated.
use super::*;
use std::{fs, path::PathBuf, time::Duration};
struct Fixture {
    pin: PinnedPath,
    root: PathBuf,
    _temp: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        fs::write(root.join("package.json"), b"owned-body").unwrap();
        let pin = PinnedPath::directory(&root).unwrap();
        Self {
            pin,
            root,
            _temp: temp,
        }
    }
    fn listed(&self) -> DirectoryEntries {
        directory_entries(&self.pin, 100_000, &AtomicBool::new(false)).unwrap()
    }
    fn observe(&self) -> MetadataObservation {
        observe_listed(&self.pin, self.listed()).unwrap()
    }
    fn move_modified_time(&self) {
        let path = self.root.join("package.json");
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        let file = fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_times(fs::FileTimes::new().set_modified(modified + Duration::from_secs(60)))
            .unwrap();
    }
}
#[test]
fn earlier_real_listing_pairs_with_stable_current_fixed_file_and_fresh_cache_observation() {
    let fixture = Fixture::new();
    let listed = fixture.listed();
    let key = "package.json".encode_utf16().collect::<Vec<_>>();
    let original = metadata_child(fixture.pin.file(), OsStr::new("package.json"))
        .unwrap()
        .unwrap();
    // This is a real earlier enumeration retained across an explicit owned
    // update, not a mutation of a fabricated directory record or producer hook.
    fixture.move_modified_time();
    let current = metadata_child(fixture.pin.file(), OsStr::new("package.json"))
        .unwrap()
        .unwrap();
    assert_ne!(current, original);
    assert!(!current.matches_directory_entry(&listed[&key]));
    assert!(current.matches_directory_identity(&listed[&key]));
    let stale_index = observe_listed(&fixture.pin, listed).unwrap();
    let fresh_index = fixture.observe();
    assert_eq!(stale_index, fresh_index);
    assert_eq!(stale_index.entries[0], Node::Present(current));
    assert_eq!(stale_index.facts().len(), 22);
    assert_eq!(stale_index.facts()[0].node_kind, PreparationNodeKind::File);
    assert_eq!(
        fs::read(fixture.root.join("package.json")).unwrap(),
        b"owned-body"
    );
}
#[test]
fn current_same_object_complete_metadata_still_changes_the_fixed_observation() {
    let fixture = Fixture::new();
    let before = fixture.observe();
    fixture.move_modified_time();
    let after = fixture.observe();
    assert_eq!(before.facts(), after.facts());
    assert_eq!(before.directories, after.directories);
    assert_ne!(before.entries, after.entries);
    assert_ne!(before, after);
    assert_eq!(
        fs::read(fixture.root.join("package.json")).unwrap(),
        b"owned-body"
    );
}
#[test]
fn actual_same_object_attribute_change_is_not_hidden_by_namespace_comparison() {
    let fixture = Fixture::new();
    let before = fixture.observe();
    let path = fixture.root.join("package.json");
    let original = fs::metadata(&path).unwrap().permissions();
    assert!(!original.readonly());
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
        permissions: original.clone(),
    };
    let mut changed = original;
    changed.set_readonly(true);
    fs::set_permissions(&path, changed).unwrap();
    let after = fixture.observe();
    fs::set_permissions(&path, restore.permissions.clone()).unwrap();
    drop(restore);
    assert_eq!(before.facts(), after.facts());
    assert_eq!(before.directories, after.directories);
    assert_ne!(before.entries, after.entries);
    assert_ne!(before, after);
    assert_eq!(fs::read(path).unwrap(), b"owned-body");
}
#[test]
fn actual_access_denial_is_unreadable_and_only_fresh_confirmed_absence_is_missing() {
    let fixture = Fixture::new();
    let path = fixture.root.join("package.json");
    let dacl = crate::file_access::security_test_fixture::OwnedDacl::new(&path);
    // Parent enumeration stays allowed. READ_ATTRIBUTES can also be granted
    // through parent LIST_DIRECTORY, so deny the SYNCHRONIZE right REQUIRED by
    // the actual synchronous metadata_child open instead. No product guard changes.
    dacl.set(&format!(
        "D:P(D;;0x{:x};;;WD)(A;;FA;;;WD)",
        windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE
    ));
    let denied = fixture.observe();
    assert!(matches!(&denied.entries[0], Node::Unreadable(_)));
    assert_eq!(denied.facts()[0].node_kind, PreparationNodeKind::Unreadable);
    assert_eq!(denied.facts().len(), 22);
    dacl.restore();
    let restored = fixture.observe();
    assert!(matches!(&restored.entries[0], Node::Present(_)));
    assert_eq!(restored.facts()[0].node_kind, PreparationNodeKind::File);
    assert_ne!(denied, restored);
    let before_remove = fixture.listed();
    fs::remove_file(&path).unwrap();
    assert_eq!(
        observe_listed(&fixture.pin, before_remove)
            .unwrap_err()
            .code,
        "changed"
    );
    let missing = fixture.observe();
    assert!(matches!(&missing.entries[0], Node::Missing));
    assert_eq!(missing.facts()[0].node_kind, PreparationNodeKind::Missing);
}
