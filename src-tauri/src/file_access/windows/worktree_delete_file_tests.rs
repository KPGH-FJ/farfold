//! Actual Win32 deletion controls on owned disposable files; no worktree proof claim.
use super::*;
use std::{fs, fs::OpenOptions, io::Read, os::windows::fs::OpenOptionsExt};
use windows_sys::Win32::System::Memory::{
    CreateFileMappingW, FILE_MAP_READ, MapViewOfFile, PAGE_READONLY, SEC_IMAGE, UnmapViewOfFile,
};
fn opened(path: &Path, directory: bool) -> File {
    OpenOptions::new()
        .access_mode(FILE_GENERIC_READ | DELETE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(
            FILE_FLAG_OPEN_REPARSE_POINT
                | if directory {
                    FILE_FLAG_BACKUP_SEMANTICS
                } else {
                    0
                },
        )
        .open(path)
        .unwrap()
}
fn parent(path: &Path) -> PinnedPath {
    PinnedPath::directory(path).unwrap()
}
#[test]
fn original_handle_closes_readonly_file_then_held_parent_proves_absence() {
    let temp = crate::test_support::tempdir().unwrap();
    let path = temp.path().join("readonly.bin");
    fs::write(&path, b"owned original").unwrap();
    let mut permissions = fs::metadata(&path).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&path, permissions).unwrap();
    let parent = parent(temp.path());
    let mut stopped = Vec::new();
    close_deleted(
        opened(&path, false),
        parent.file(),
        &"readonly.bin".encode_utf16().collect::<Vec<_>>(),
        &mut stopped,
    )
    .unwrap();
    assert!(stopped.is_empty());
    assert!(
        metadata_child(parent.file(), OsStr::new("readonly.bin"))
            .unwrap()
            .is_none()
    );
}
#[test]
fn duplicate_file_object_cannot_be_reported_as_absent_before_last_actual_close() {
    let temp = crate::test_support::tempdir().unwrap();
    let path = temp.path().join("held.bin");
    fs::write(&path, b"still held").unwrap();
    let file = opened(&path, false);
    let mut other = file.try_clone().unwrap();
    let parent = parent(temp.path());
    let mut stopped = Vec::new();
    assert!(matches!(
        close_deleted(
            file,
            parent.file(),
            &"held.bin".encode_utf16().collect::<Vec<_>>(),
            &mut stopped
        ),
        Err(Error::CleanupUnknown)
    ));
    let mut body = Vec::new();
    other.read_to_end(&mut body).unwrap();
    assert_eq!(body, b"still held");
    drop(other);
    assert!(
        metadata_child(parent.file(), OsStr::new("held.bin"))
            .unwrap()
            .is_none()
    );
    assert!(stopped.is_empty()); // the attempted CloseHandle itself succeeded
}
#[test]
fn external_nonsharing_reader_prevents_delete_authority_and_preserves_bytes() {
    let temp = crate::test_support::tempdir().unwrap();
    let path = temp.path().join("external.bin");
    fs::write(&path, b"external reader").unwrap();
    let reader = OpenOptions::new()
        .access_mode(FILE_GENERIC_READ)
        .share_mode(FILE_SHARE_READ)
        .open(&path)
        .unwrap();
    assert!(
        OpenOptions::new()
            .access_mode(FILE_GENERIC_READ | DELETE)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&path)
            .is_err()
    );
    drop(reader);
    assert_eq!(fs::read(&path).unwrap(), b"external reader");
}
#[test]
fn late_unknown_directory_child_survives_and_prevents_parent_disposal() {
    let temp = crate::test_support::tempdir().unwrap();
    let path = temp.path().join("owned");
    fs::create_dir(&path).unwrap();
    let directory = opened(&path, true);
    fs::write(path.join("late.bin"), b"never selected for deletion").unwrap();
    let parent = parent(temp.path());
    assert!(
        close_deleted(
            directory,
            parent.file(),
            &"owned".encode_utf16().collect::<Vec<_>>(),
            &mut Vec::new()
        )
        .is_err()
    );
    assert_eq!(
        fs::read(path.join("late.bin")).unwrap(),
        b"never selected for deletion"
    );
}
#[test]
fn force_image_section_check_refuses_live_image_mapping_without_unlink() {
    let temp = crate::test_support::tempdir().unwrap();
    // Bounded real system PE copied only into our disposable fixture. No load,
    // execution, access to a user binary or mutation of the source DLL occurs.
    let system = std::env::var_os("SystemRoot").unwrap();
    let source = Path::new(&system).join("System32/version.dll");
    assert!(fs::metadata(&source).unwrap().len() <= 8 * 1024 * 1024);
    let path = temp.path().join("mapped.dll");
    fs::copy(source, &path).unwrap();
    let file = opened(&path, false);
    let mapping = unsafe {
        CreateFileMappingW(
            handle(&file),
            ptr::null(),
            PAGE_READONLY | SEC_IMAGE,
            0,
            0,
            ptr::null(),
        )
    };
    assert!(
        !mapping.is_null(),
        "owned PE image mapping must actually exist"
    );
    let view = unsafe { MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, 0) };
    assert!(!view.Value.is_null());
    let parent = parent(temp.path());
    let result = close_deleted(
        file,
        parent.file(),
        &"mapped.dll".encode_utf16().collect::<Vec<_>>(),
        &mut Vec::new(),
    );
    let magic = unsafe { std::slice::from_raw_parts(view.Value.cast::<u8>(), 2) }.to_vec();
    assert_ne!(unsafe { UnmapViewOfFile(view) }, 0);
    assert_ne!(unsafe { CloseHandle(mapping) }, 0);
    assert!(result.is_err());
    assert_eq!(magic, b"MZ");
    assert!(
        metadata_child(parent.file(), OsStr::new("mapped.dll"))
            .unwrap()
            .is_some()
    );
}
