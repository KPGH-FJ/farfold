use super::*;
#[test]
fn pinned_local_ancestors_and_pointer_contents_stay_held_until_drop() {
    let directory = tempfile::tempdir().unwrap();
    let parent = directory.path().join("parent");
    let child = parent.join("child");
    std::fs::create_dir_all(&child).unwrap();
    let pin = PinnedPath::directory(&child).unwrap();
    assert!(pin.guid_path.to_string_lossy().starts_with(r"\\?\Volume{"));
    assert!(std::fs::rename(&parent, directory.path().join("renamed")).is_err());
    pin.verify().unwrap();
    drop(pin);
    std::fs::rename(&parent, directory.path().join("renamed")).unwrap();
    let pointer = directory.path().join("pointer");
    std::fs::write(&pointer, "declared target").unwrap();
    let pin = PinnedPath::regular(&pointer).unwrap();
    assert!(std::fs::write(&pointer, "replacement").is_err());
    drop(pin);
    std::fs::write(pointer, "replacement").unwrap();
}
#[test]
fn user_paths_do_not_accept_network_device_or_relative_spellings() {
    for path in [
        r"\\server\share\project",
        r"\\?\UNC\server\share\project",
        r"\\.\C:\project",
        r"C:project",
        r"\project",
        r"C:\project\..\other",
    ] {
        assert!(PinnedPath::directory(Path::new(path)).is_err(), "{path}");
    }
}
